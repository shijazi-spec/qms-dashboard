/**
 * Phase 3.1 — obligation_evidence_quality storage.
 *
 * For every (obligation, document) link we store an LLM-derived quality
 * verdict: does the document actually satisfy the clause? Used by the
 * compliance dashboard's "Non-Compliance Findings" table and by the
 * audit-readiness PDF report.
 *
 * The table is intentionally append-friendly (UNIQUE on
 * (obligation_id, document_id) + UPSERT) so re-judging on the daily
 * cron is cheap.
 */

import { Pool } from "pg";
import { logger } from "./logger";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export type EvidenceQualityStatus =
  | "satisfied"
  | "partial"
  | "missing_topic"
  | "needs_review";

export interface EvidenceQualityRow {
  id: number;
  obligation_id: number;
  document_id: number;
  status: EvidenceQualityStatus;
  rationale: string | null;
  missing_aspects: string[] | null;
  judged_at: string;
  judged_by: string | null;
  llm_model: string | null;
  tokens_used: number | null;
}

let initialized = false;

export async function initEvidenceQualityTable(): Promise<void> {
  if (initialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS obligation_evidence_quality (
      id              SERIAL PRIMARY KEY,
      obligation_id   INTEGER NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
      document_id     INTEGER NOT NULL REFERENCES qms_uploaded_documents(id) ON DELETE CASCADE,
      status          VARCHAR(20) NOT NULL,
      rationale       TEXT,
      missing_aspects TEXT[],
      judged_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      judged_by       VARCHAR(100),
      llm_model       VARCHAR(100),
      tokens_used     INTEGER,
      UNIQUE (obligation_id, document_id)
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_oeq_status
       ON obligation_evidence_quality (status)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_oeq_obligation
       ON obligation_evidence_quality (obligation_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_oeq_judged_at
       ON obligation_evidence_quality (judged_at)`,
  );

  // Cost-monitoring side table (Phase 3 cross-cutting LLM guardrail).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS llm_call_log (
      id           SERIAL PRIMARY KEY,
      called_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      caller       VARCHAR(100) NOT NULL,
      model        VARCHAR(100),
      tokens_used  INTEGER,
      latency_ms   INTEGER,
      success      BOOLEAN NOT NULL DEFAULT true,
      error        TEXT
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_llm_call_log_caller_called_at
       ON llm_call_log (caller, called_at DESC)`,
  );

  initialized = true;
  logger.info("✅ [ComplianceQualityDB] obligation_evidence_quality + llm_call_log ready");
}

export async function upsertEvidenceQuality(input: {
  obligation_id: number;
  document_id: number;
  status: EvidenceQualityStatus;
  rationale: string | null;
  missing_aspects: string[] | null;
  judged_by: string | null;
  llm_model: string | null;
  tokens_used: number | null;
}): Promise<EvidenceQualityRow> {
  await initEvidenceQualityTable();
  const result = await pool.query(
    `INSERT INTO obligation_evidence_quality (
        obligation_id, document_id, status, rationale, missing_aspects,
        judged_at, judged_by, llm_model, tokens_used
      ) VALUES ($1,$2,$3,$4,$5, CURRENT_TIMESTAMP, $6, $7, $8)
      ON CONFLICT (obligation_id, document_id)
      DO UPDATE SET
        status          = EXCLUDED.status,
        rationale       = EXCLUDED.rationale,
        missing_aspects = EXCLUDED.missing_aspects,
        judged_at       = CURRENT_TIMESTAMP,
        judged_by       = EXCLUDED.judged_by,
        llm_model       = EXCLUDED.llm_model,
        tokens_used     = EXCLUDED.tokens_used
      RETURNING *`,
    [
      input.obligation_id,
      input.document_id,
      input.status,
      input.rationale,
      input.missing_aspects,
      input.judged_by,
      input.llm_model,
      input.tokens_used,
    ],
  );
  return result.rows[0] as EvidenceQualityRow;
}

export async function getEvidenceQualityForLink(
  obligationId: number,
  documentId: number,
): Promise<EvidenceQualityRow | null> {
  await initEvidenceQualityTable();
  const result = await pool.query(
    `SELECT * FROM obligation_evidence_quality
      WHERE obligation_id = $1 AND document_id = $2 LIMIT 1`,
    [obligationId, documentId],
  );
  return (result.rows[0] as EvidenceQualityRow) || null;
}

/**
 * Findings list — every link with status `partial` or `missing_topic`
 * (these are the "non-compliance findings" surfaced on the dashboard).
 */
export async function listNonComplianceFindings(opts?: {
  regulationId?: number;
  limit?: number;
}): Promise<any[]> {
  await initEvidenceQualityTable();
  const limit = Math.min(500, Math.max(1, opts?.limit ?? 200));
  const params: any[] = [limit];
  let where = "WHERE oeq.status IN ('partial','missing_topic','needs_review')";
  if (opts?.regulationId) {
    params.push(opts.regulationId);
    where += ` AND o.regulation_id = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT
        oeq.id, oeq.obligation_id, oeq.document_id, oeq.status,
        oeq.rationale, oeq.missing_aspects, oeq.judged_at, oeq.llm_model,
        o.obligation_code, o.title AS obligation_title, o.priority,
        r.id AS regulation_id, r.regulation_code, r.name AS regulation_name,
        d.title AS document_title
       FROM obligation_evidence_quality oeq
       JOIN obligations o ON oeq.obligation_id = o.id
       JOIN regulations r ON o.regulation_id = r.id
       JOIN qms_uploaded_documents d ON oeq.document_id = d.id
       ${where}
   ORDER BY r.regulation_code,
            CASE o.priority
              WHEN 'critical' THEN 0
              WHEN 'high' THEN 1
              WHEN 'medium' THEN 2
              WHEN 'low' THEN 3
              ELSE 4
            END,
            oeq.judged_at DESC
       LIMIT $1`,
    params,
  );
  return result.rows;
}

/**
 * Phase 3.2 — list links that are due for re-judgement (older than the
 * configured staleness window OR never judged). Used by the daily cron.
 */
export async function listLinksPendingJudgement(opts?: {
  limit?: number;
  staleAfterDays?: number;
}): Promise<{ obligation_id: number; document_id: number }[]> {
  await initEvidenceQualityTable();
  const limit = Math.min(500, Math.max(1, opts?.limit ?? 50));
  const staleDays = Math.max(1, opts?.staleAfterDays ?? 30);
  const result = await pool.query(
    `SELECT od.obligation_id, od.document_id
       FROM obligation_documents od
  LEFT JOIN obligation_evidence_quality q
         ON q.obligation_id = od.obligation_id
        AND q.document_id   = od.document_id
      WHERE q.id IS NULL
         OR q.judged_at < NOW() - INTERVAL '${staleDays} days'
   ORDER BY COALESCE(q.judged_at, '1970-01-01'::timestamp) ASC
      LIMIT $1`,
    [limit],
  );
  return result.rows as { obligation_id: number; document_id: number }[];
}

/**
 * List existing non-compliance findings (partial / missing_topic /
 * needs_review) that should be RE-judged — e.g. after the judge prompt was
 * improved to produce more actionable rationales. Bounded by a `before`
 * cutoff so a UI loop terminates: each re-judge stamps judged_at = NOW()
 * (> before), so the row drops out of the next batch.
 */
export async function listFindingsToRejudge(opts: {
  before: string;
  limit?: number;
}): Promise<{ obligation_id: number; document_id: number }[]> {
  await initEvidenceQualityTable();
  const limit = Math.min(40, Math.max(1, opts.limit ?? 8));
  const result = await pool.query(
    `SELECT obligation_id, document_id
       FROM obligation_evidence_quality
      WHERE status IN ('partial','missing_topic','needs_review')
        AND judged_at < $1
   ORDER BY judged_at ASC
      LIMIT $2`,
    [opts.before, limit],
  );
  return result.rows as { obligation_id: number; document_id: number }[];
}

export async function countFindingsToRejudge(before: string): Promise<number> {
  await initEvidenceQualityTable();
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM obligation_evidence_quality
      WHERE status IN ('partial','missing_topic','needs_review')
        AND judged_at < $1`,
    [before],
  );
  return r.rows[0]?.n || 0;
}

export async function logLlmCall(input: {
  caller: string;
  model?: string | null;
  tokens_used?: number | null;
  latency_ms?: number | null;
  success?: boolean;
  error?: string | null;
}): Promise<void> {
  await initEvidenceQualityTable();
  try {
    await pool.query(
      `INSERT INTO llm_call_log (caller, model, tokens_used, latency_ms, success, error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.caller,
        input.model ?? null,
        input.tokens_used ?? null,
        input.latency_ms ?? null,
        input.success ?? true,
        input.error ?? null,
      ],
    );
  } catch {
    // never block the caller on telemetry failure
  }
}
