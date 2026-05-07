/**
 * Compliance v2 — regulation_imports CRUD helpers.
 *
 * A "regulation import" tracks the lifecycle of an "Ingest Standard
 * from Document" run end-to-end:
 *
 *   extracting       The Inngest job is reading the source PDF/DOCX
 *                    and asking the LLM to draft a list of clauses.
 *   awaiting_review  Draft is ready; a human edits and approves rows.
 *   applied          The draft has been bulk-inserted into obligations.
 *   rejected         The user discarded the draft (no rows written).
 *   failed           The extraction or LLM call errored; `error` set.
 *
 * The draft itself lives in `draft_clauses` JSONB so the review UI
 * can edit it freely (including reordering, splitting, merging) without
 * needing a separate edit table — once the user clicks Apply we
 * INSERT INTO obligations.
 */

import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";

export type RegulationImportStatus =
  | "extracting"
  | "awaiting_review"
  | "applied"
  | "rejected"
  | "failed";

export interface DraftClause {
  obligation_code: string;
  article_reference?: string | null;
  clause_number?: string | null;
  title: string;
  description: string;
  section_domain?: string | null;
  priority?: "critical" | "high" | "medium" | "low";
  accepted?: boolean; // user toggles in the review UI; default true
}

export interface RegulationImport {
  id: number;
  regulation_id: number | null;
  document_id: number | null;
  status: RegulationImportStatus;
  draft_clauses: DraftClause[];
  error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
  applied_count: number;
}

export async function createImportRun(input: {
  regulation_id?: number | null;
  document_id?: number | null;
  created_by?: string | null;
}): Promise<RegulationImport> {
  const result = await pool.query(
    `INSERT INTO regulation_imports (regulation_id, document_id, status, created_by)
     VALUES ($1, $2, 'extracting', $3)
     RETURNING *`,
    [input.regulation_id ?? null, input.document_id ?? null, input.created_by ?? null],
  );
  return rowToImport(result.rows[0]);
}

export async function getImportRun(id: number): Promise<RegulationImport | null> {
  const result = await pool.query(
    `SELECT * FROM regulation_imports WHERE id = $1`,
    [id],
  );
  if (result.rows.length === 0) return null;
  return rowToImport(result.rows[0]);
}

export async function listImportRuns(filters?: {
  regulation_id?: number;
  status?: RegulationImportStatus;
  limit?: number;
}): Promise<RegulationImport[]> {
  const where: string[] = ["1=1"];
  const values: any[] = [];
  let p = 1;
  if (filters?.regulation_id) {
    where.push(`regulation_id = $${p++}`);
    values.push(filters.regulation_id);
  }
  if (filters?.status) {
    where.push(`status = $${p++}`);
    values.push(filters.status);
  }
  const limit = filters?.limit ?? 100;
  const result = await pool.query(
    `SELECT * FROM regulation_imports WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
    values,
  );
  return result.rows.map(rowToImport);
}

export async function setImportDraft(
  id: number,
  draft_clauses: DraftClause[],
  status: RegulationImportStatus = "awaiting_review",
): Promise<void> {
  await pool.query(
    `UPDATE regulation_imports
        SET draft_clauses = $2,
            status        = $3,
            updated_at    = CURRENT_TIMESTAMP,
            error         = NULL
      WHERE id = $1`,
    [id, JSON.stringify(draft_clauses), status],
  );
}

export async function setImportError(id: number, error: string): Promise<void> {
  await pool.query(
    `UPDATE regulation_imports
        SET status     = 'failed',
            error      = $2,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [id, error.slice(0, 2000)],
  );
}

export async function setImportStatus(
  id: number,
  status: RegulationImportStatus,
  appliedCount?: number,
): Promise<void> {
  if (status === "applied") {
    await pool.query(
      `UPDATE regulation_imports
          SET status        = 'applied',
              applied_at    = CURRENT_TIMESTAMP,
              applied_count = $2,
              updated_at    = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [id, appliedCount ?? 0],
    );
  } else {
    await pool.query(
      `UPDATE regulation_imports
          SET status     = $2,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [id, status],
    );
  }
}

/**
 * Apply the (possibly user-edited) draft into the obligations table.
 * Returns the count of rows inserted. Rows where `accepted === false`
 * are skipped. Codes that already exist for the regulation are skipped
 * (UNIQUE on obligation_code).
 *
 * Marks the regulation row with `clause_source='ai_extracted'` and
 * `source_document_id` for audit traceability.
 */
export async function applyImportRun(
  id: number,
  options: { regulationId: number; sourceDocumentId: number | null },
): Promise<{ inserted: number; skipped: number }> {
  const run = await getImportRun(id);
  if (!run) throw new Error(`Import run ${id} not found`);
  let inserted = 0;
  let skipped = 0;
  for (const c of run.draft_clauses) {
    if (c.accepted === false) {
      skipped++;
      continue;
    }
    const code = (c.obligation_code || "").trim();
    if (!code || !c.title || !c.description) {
      skipped++;
      continue;
    }
    try {
      const r = await pool.query(
        `INSERT INTO obligations
           (obligation_code, regulation_id, article_reference, clause_number,
            title, description, section_domain, priority, status,
            requirement_type, control_type, compliance_frequency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'medium'), 'applicable',
                 'mandatory', 'preventive', 'annual')
         ON CONFLICT (obligation_code) DO NOTHING
         RETURNING id`,
        [
          code,
          options.regulationId,
          c.article_reference ?? null,
          c.clause_number ?? null,
          c.title,
          c.description,
          c.section_domain ?? null,
          c.priority ?? "medium",
        ],
      );
      if (r.rowCount && r.rowCount > 0) inserted++;
      else skipped++;
    } catch (err) {
      logger.warn(
        `[regulationImports] insert failed for ${code}: ${(err as Error).message}`,
      );
      skipped++;
    }
  }
  await pool.query(
    `UPDATE regulations
        SET source_document_id = COALESCE($2, source_document_id),
            clause_source      = 'ai_extracted',
            updated_at         = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [options.regulationId, options.sourceDocumentId],
  );
  await setImportStatus(id, "applied", inserted);
  return { inserted, skipped };
}

function rowToImport(r: any): RegulationImport {
  let draft: DraftClause[] = [];
  if (r.draft_clauses) {
    if (Array.isArray(r.draft_clauses)) draft = r.draft_clauses as DraftClause[];
    else if (typeof r.draft_clauses === "string") {
      try {
        const parsed = JSON.parse(r.draft_clauses);
        if (Array.isArray(parsed)) draft = parsed;
      } catch {
        draft = [];
      }
    }
  }
  return {
    id: Number(r.id),
    regulation_id: r.regulation_id == null ? null : Number(r.regulation_id),
    document_id: r.document_id == null ? null : Number(r.document_id),
    status: r.status as RegulationImportStatus,
    draft_clauses: draft,
    error: r.error || null,
    created_by: r.created_by || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    applied_at: r.applied_at,
    applied_count: Number(r.applied_count) || 0,
  };
}
