/**
 * documentMasterList — the "map once, read across" view of Document Mapping.
 *
 * WHY THIS EXISTS
 * The Document Mapping page grew into six independent panels (coverage tiles,
 * open gaps, gap recommendations, mapping console, AI-judged findings,
 * auto-mapped queue), each with its own notion of scope. Nothing linked them,
 * so the concept was unreadable: 474 open gaps and 811 findings with no
 * organising layer, and no way to answer "what does THIS document cover?".
 *
 * The Master List inverts it, the way mature GRC tooling presents a control
 * set: ONE ROW PER DOCUMENT, one column per framework. Coverage is read across
 * a row instead of reconstructed per framework.
 *
 * Two exports:
 *   getMasterList()     — the grid (documents × frameworks), one SQL round trip
 *   getMappingSummary() — the four numbers driving the workflow strip
 *
 * IMPORTANT — the placeholder distinction. The 154 seeded WP-* register entries
 * have no uploaded file; their projection carries only the register's own blurb
 * and is marked extraction_status='placeholder' by policyMappingBridge. They are
 * INCLUDED here on purpose (step 1 of the strip is precisely "how many are still
 * awaiting their file"), but flagged so the UI never reports coverage computed
 * from empty documents as if it were real.
 */

import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";

export interface MasterListFramework {
  id: number;
  regulation_code: string;
  name: string;
  total_clauses: number;
}

export interface MasterListCoverageCell {
  confirmed: number;
  pending: number;
}

export interface MasterListRow {
  document_id: number;
  policy_id: number | null;
  code: string | null;
  title: string;
  owner: string | null;
  doc_status: string | null;
  version: string | null;
  /** false when the document is still awaiting its approved file upload. */
  has_content: boolean;
  /** regulation_code -> counts. Frameworks with no link are absent. */
  coverage: Record<string, MasterListCoverageCell>;
}

export interface MappingSummary {
  documents_total: number;
  documents_with_content: number;
  documents_placeholder: number;
  clauses_total: number;
  clauses_with_evidence: number;
  links_awaiting_review: number;
  clauses_without_evidence: number;
  /** True while most documents are placeholders — the UI gates steps 2-4 on this. */
  awaiting_documents: boolean;
}

/** Frameworks that can actually be mapped: active AND holding a clause catalogue. */
export async function getMappableFrameworks(): Promise<MasterListFramework[]> {
  const r = await pool.query(
    `SELECT reg.id, reg.regulation_code, reg.name,
            COUNT(o.id)::int AS total_clauses
       FROM regulations reg
       JOIN obligations o
         ON o.regulation_id = reg.id AND o.status = 'applicable'
      WHERE reg.status = 'active'
   GROUP BY reg.id, reg.regulation_code, reg.name
     HAVING COUNT(o.id) > 0
   ORDER BY reg.regulation_code`,
  );
  return r.rows as MasterListFramework[];
}

/**
 * The grid. One query for every document × framework pair, pivoted in memory —
 * ~300 documents × 8 frameworks is a few thousand rows, far cheaper than a
 * per-document round trip.
 *
 * `regulationId` scopes to a single framework (the page-level selector);
 * omitted, every framework is returned.
 */
export async function getMasterList(opts?: {
  regulationId?: number;
  limit?: number;
}): Promise<{ frameworks: MasterListFramework[]; documents: MasterListRow[] }> {
  const frameworks = await getMappableFrameworks();
  const limit = Math.min(2000, Math.max(1, opts?.limit ?? 1000));

  const params: any[] = [limit];
  let regFilter = "";
  if (opts?.regulationId) {
    params.push(opts.regulationId);
    regFilter = ` AND o.regulation_id = $${params.length}`;
  }

  // LEFT JOINs throughout: a document with no mapping at all must still appear
  // (that is the finding). The obligations join carries the 'applicable' filter
  // so the denominator matches getFrameworkCoverage exactly — if these two ever
  // disagree the tracker and the compliance dashboard show different numbers
  // for the same documents and neither is trusted.
  const sql = `
    WITH docs AS (
      SELECT d.id, d.title, d.extraction_status, d.source_policy_id, d.uploaded_at
        FROM qms_uploaded_documents d
       ORDER BY d.id
       LIMIT $1
    )
    SELECT docs.id                AS document_id,
           docs.title             AS document_title,
           docs.extraction_status AS extraction_status,
           docs.source_policy_id  AS policy_id,
           p.policy_number        AS code,
           p.owner_name           AS owner,
           p.status               AS doc_status,
           p.version              AS version,
           reg.regulation_code    AS regulation_code,
           COUNT(od.id) FILTER (WHERE od.awaiting_review IS NOT TRUE)::int AS confirmed,
           COUNT(od.id) FILTER (WHERE od.awaiting_review IS TRUE)::int     AS pending
      FROM docs
      LEFT JOIN policies p              ON p.id = docs.source_policy_id
      LEFT JOIN obligation_documents od ON od.document_id = docs.id
      LEFT JOIN obligations o           ON o.id = od.obligation_id
                                       AND o.status = 'applicable'${regFilter}
      LEFT JOIN regulations reg         ON reg.id = o.regulation_id
                                       AND reg.status = 'active'
  GROUP BY docs.id, docs.title, docs.extraction_status, docs.source_policy_id,
           docs.uploaded_at, p.policy_number, p.owner_name, p.status, p.version,
           reg.regulation_code
  ORDER BY p.policy_number NULLS LAST, docs.title`;

  const res = await pool.query(sql, params);

  const byDoc = new Map<number, MasterListRow>();
  for (const row of res.rows) {
    let doc = byDoc.get(row.document_id);
    if (!doc) {
      doc = {
        document_id: row.document_id,
        policy_id: row.policy_id ?? null,
        code: row.code ?? null,
        title: row.document_title,
        owner: row.owner ?? null,
        doc_status: row.doc_status ?? null,
        version: row.version ?? null,
        has_content: row.extraction_status !== "placeholder",
        coverage: {},
      };
      byDoc.set(row.document_id, doc);
    }
    // regulation_code is NULL on the no-mapping LEFT JOIN row — skip it, the
    // absence of a key is what the UI renders as "not mapped".
    if (row.regulation_code && (row.confirmed > 0 || row.pending > 0)) {
      doc.coverage[row.regulation_code] = {
        confirmed: row.confirmed,
        pending: row.pending,
      };
    }
  }

  return { frameworks, documents: Array.from(byDoc.values()) };
}

/**
 * The four workflow numbers. Deliberately separate from the grid so the strip
 * can refresh without re-pivoting every document.
 */
export async function getMappingSummary(opts?: {
  regulationId?: number;
}): Promise<MappingSummary> {
  const params: any[] = [];
  let regFilter = "";
  if (opts?.regulationId) {
    params.push(opts.regulationId);
    regFilter = ` AND o.regulation_id = $${params.length}`;
  }

  const docs = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE COALESCE(extraction_status,'') <> 'placeholder')::int AS with_content
       FROM qms_uploaded_documents`,
  );

  const clauses = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE has_doc)::int AS with_evidence
       FROM (
         SELECT o.id, EXISTS (
                  SELECT 1 FROM obligation_documents od WHERE od.obligation_id = o.id
                ) AS has_doc
           FROM obligations o
           JOIN regulations reg ON reg.id = o.regulation_id AND reg.status = 'active'
          WHERE o.status = 'applicable'${regFilter}
       ) sub`,
    params,
  );

  const pending = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM obligation_documents od
       JOIN obligations o  ON o.id = od.obligation_id AND o.status = 'applicable'
       JOIN regulations reg ON reg.id = o.regulation_id AND reg.status = 'active'
      WHERE od.awaiting_review IS TRUE${regFilter}`,
    params,
  );

  const documents_total = docs.rows[0]?.total || 0;
  const documents_with_content = docs.rows[0]?.with_content || 0;
  const clauses_total = clauses.rows[0]?.total || 0;
  const clauses_with_evidence = clauses.rows[0]?.with_evidence || 0;

  return {
    documents_total,
    documents_with_content,
    documents_placeholder: documents_total - documents_with_content,
    clauses_total,
    clauses_with_evidence,
    links_awaiting_review: pending.rows[0]?.n || 0,
    clauses_without_evidence: Math.max(0, clauses_total - clauses_with_evidence),
    // Coverage computed while most documents are still placeholders is not
    // meaningful. The page shows "waiting on documents" for steps 2-4 rather
    // than percentages derived from empty files.
    awaiting_documents:
      documents_total > 0 && documents_with_content * 2 < documents_total,
  };
}

/** Convenience for the page: grid + summary in one call. */
export async function getMasterListWithSummary(opts?: {
  regulationId?: number;
  limit?: number;
}) {
  try {
    const [grid, summary] = await Promise.all([
      getMasterList(opts),
      getMappingSummary(opts),
    ]);
    return { ...grid, summary };
  } catch (err) {
    logger.error("[documentMasterList] failed:", err);
    throw err;
  }
}
