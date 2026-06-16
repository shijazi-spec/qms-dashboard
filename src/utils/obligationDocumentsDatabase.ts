import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";

const pool = createRedactedPool({ connectionString: process.env.DATABASE_URL });

export interface ObligationDocumentLink {
  id: number;
  obligation_id: number;
  document_id: number;
  linked_by: string;
  linked_at: string;
}

export interface ObligationDocumentRow {
  id: number;
  obligation_id: number;
  document_id: number;
  linked_by: string;
  linked_at: string;
  title: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  category: string;
  notes: string | null;
}

let initialized = false;

export async function initObligationDocumentsTable(): Promise<void> {
  if (initialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS obligation_documents (
      id              SERIAL PRIMARY KEY,
      obligation_id   INTEGER       NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
      document_id     INTEGER       NOT NULL REFERENCES qms_uploaded_documents(id) ON DELETE CASCADE,
      linked_by       VARCHAR(255)  NOT NULL,
      linked_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      link_method     VARCHAR(20)   DEFAULT 'manual',
      awaiting_review BOOLEAN       DEFAULT FALSE,
      UNIQUE(obligation_id, document_id)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_obligation_documents_obligation
      ON obligation_documents (obligation_id);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_obligation_documents_document
      ON obligation_documents (document_id);
  `);
  // Compliance v2 — link provenance + review queue. `link_method`
  // distinguishes manual vs. AI-suggested vs. citation-driven links;
  // `awaiting_review` is true when the citation extractor created the
  // link automatically and a human should confirm it.
  await pool.query(
    `ALTER TABLE obligation_documents ADD COLUMN IF NOT EXISTS link_method VARCHAR(20) DEFAULT 'manual'`,
  );
  await pool.query(
    `ALTER TABLE obligation_documents ADD COLUMN IF NOT EXISTS awaiting_review BOOLEAN DEFAULT FALSE`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_obligation_documents_awaiting
       ON obligation_documents (awaiting_review) WHERE awaiting_review = TRUE`,
  );
  initialized = true;
  logger.info("✅ [ObligationDocsDB] obligation_documents table ready");
}

export async function listDocumentsForObligation(
  obligationId: number,
): Promise<ObligationDocumentRow[]> {
  await initObligationDocumentsTable();
  const result = await pool.query(
    `SELECT od.id, od.obligation_id, od.document_id, od.linked_by, od.linked_at,
            d.title, d.file_name, d.file_size, d.mime_type, d.category, d.notes
       FROM obligation_documents od
       JOIN qms_uploaded_documents d ON d.id = od.document_id
      WHERE od.obligation_id = $1
      ORDER BY od.linked_at DESC`,
    [obligationId],
  );
  return result.rows as ObligationDocumentRow[];
}

export async function countDocumentsByObligation(
  regulationId?: number,
): Promise<Record<number, number>> {
  await initObligationDocumentsTable();
  const result = regulationId
    ? await pool.query(
        `SELECT od.obligation_id, COUNT(*)::int AS n
           FROM obligation_documents od
           JOIN obligations o ON o.id = od.obligation_id
          WHERE o.regulation_id = $1
          GROUP BY od.obligation_id`,
        [regulationId],
      )
    : await pool.query(
        `SELECT obligation_id, COUNT(*)::int AS n
           FROM obligation_documents
           GROUP BY obligation_id`,
      );
  const out: Record<number, number> = {};
  for (const row of result.rows) {
    out[Number(row.obligation_id)] = Number(row.n) || 0;
  }
  return out;
}

export async function linkDocumentToObligation(input: {
  obligation_id: number;
  document_id: number;
  linked_by: string;
}): Promise<ObligationDocumentLink | null> {
  await initObligationDocumentsTable();
  const result = await pool.query(
    `INSERT INTO obligation_documents (obligation_id, document_id, linked_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (obligation_id, document_id) DO NOTHING
     RETURNING *`,
    [input.obligation_id, input.document_id, input.linked_by],
  );
  return (result.rows[0] as ObligationDocumentLink) || null;
}

export async function unlinkDocumentFromObligation(
  obligationId: number,
  documentId: number,
): Promise<boolean> {
  await initObligationDocumentsTable();
  const result = await pool.query(
    `DELETE FROM obligation_documents
      WHERE obligation_id = $1 AND document_id = $2`,
    [obligationId, documentId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ──────────────────────────────────────────────────────────────────────
// Phase 1.2 — Framework coverage helpers
//
// These power the "X of Y clauses have evidence — Z%" headline tile on
// the compliance dashboard plus the per-framework "Missing Evidence"
// drill-down. Pure SQL aggregations; no LLM calls.
// ──────────────────────────────────────────────────────────────────────

export interface UnmappedObligationRow {
  id: number;
  obligation_code: string;
  title: string;
  section_domain: string | null;
  priority: string;
}

export interface FrameworkCoverage {
  regulation_id: number;
  regulation_code: string;
  regulation_name: string;
  total_obligations: number;
  with_evidence: number;
  coverage_pct: number;
}

export interface FrameworkCoverageDetail extends FrameworkCoverage {
  unmapped: UnmappedObligationRow[];
}

/**
 * Coverage % for a single framework. Returns the coverage object plus
 * the list of unmapped clauses (clauses with zero linked documents) so
 * the dashboard can render the headline number AND the gap drill-down
 * from one round-trip.
 *
 * Pure aggregation — no document content reading, safe to call on
 * every page-load.
 */
export async function getFrameworkCoverage(
  regulationId: number,
): Promise<FrameworkCoverageDetail> {
  await initObligationDocumentsTable();
  const reg = await pool.query(
    "SELECT id, regulation_code, name FROM regulations WHERE id = $1",
    [regulationId],
  );
  if (reg.rows.length === 0) {
    throw new Error(`Regulation ${regulationId} not found`);
  }

  const counts = await pool.query(
    `SELECT
        COUNT(*)::int                                         AS total,
        COUNT(*) FILTER (WHERE od_count > 0)::int             AS with_evidence
       FROM (
         SELECT o.id, COUNT(od.id)::int AS od_count
           FROM obligations o
      LEFT JOIN obligation_documents od ON od.obligation_id = o.id
          WHERE o.regulation_id = $1
            AND o.status = 'applicable'
       GROUP BY o.id
       ) sub`,
    [regulationId],
  );

  const total = Number(counts.rows[0]?.total ?? 0);
  const withEvidence = Number(counts.rows[0]?.with_evidence ?? 0);

  const unmappedRows = await pool.query(
    `SELECT o.id, o.obligation_code, o.title, o.section_domain, o.priority
       FROM obligations o
  LEFT JOIN obligation_documents od ON od.obligation_id = o.id
      WHERE o.regulation_id = $1
        AND o.status = 'applicable'
        AND od.id IS NULL
   ORDER BY COALESCE(o.section_order, 0), o.obligation_code`,
    [regulationId],
  );

  return {
    regulation_id: reg.rows[0].id,
    regulation_code: reg.rows[0].regulation_code,
    regulation_name: reg.rows[0].name,
    total_obligations: total,
    with_evidence: withEvidence,
    coverage_pct: total > 0 ? Math.round((withEvidence / total) * 100) : 0,
    unmapped: unmappedRows.rows as UnmappedObligationRow[],
  };
}

/**
 * Coverage summary for every active regulation, suitable for the
 * dashboard tile grid. Single round-trip.
 */
export async function getAllFrameworkCoverage(): Promise<FrameworkCoverage[]> {
  await initObligationDocumentsTable();
  const rows = await pool.query(
    `SELECT
        r.id                                                  AS regulation_id,
        r.regulation_code,
        r.name                                                AS regulation_name,
        COUNT(o.id)::int                                       AS total_obligations,
        COALESCE(SUM(CASE WHEN od_count > 0 THEN 1 ELSE 0 END), 0)::int
                                                              AS with_evidence
       FROM regulations r
  LEFT JOIN (
         SELECT o2.id, o2.regulation_id, COUNT(od2.id)::int AS od_count
           FROM obligations o2
      LEFT JOIN obligation_documents od2 ON od2.obligation_id = o2.id
          WHERE o2.status = 'applicable'
       GROUP BY o2.id, o2.regulation_id
       ) o ON o.regulation_id = r.id
      WHERE r.status = 'active'
   GROUP BY r.id, r.regulation_code, r.name
   ORDER BY r.regulation_code`,
  );

  return rows.rows.map((r: any) => {
    const total = Number(r.total_obligations) || 0;
    const we = Number(r.with_evidence) || 0;
    return {
      regulation_id: Number(r.regulation_id),
      regulation_code: r.regulation_code,
      regulation_name: r.regulation_name,
      total_obligations: total,
      with_evidence: we,
      coverage_pct: total > 0 ? Math.round((we / total) * 100) : 0,
    };
  });
}

/**
 * Pure-function variant of the coverage % calculation used by both
 * helpers above. Exposed for unit testing without a database.
 */
export function calculateCoveragePct(
  total: number,
  withEvidence: number,
): number {
  if (total <= 0) return 0;
  if (withEvidence < 0) return 0;
  if (withEvidence >= total) return 100;
  return Math.round((withEvidence / total) * 100);
}
