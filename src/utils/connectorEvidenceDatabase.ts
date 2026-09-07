/**
 * connectorEvidenceDatabase — storage for automated, API-derived audit evidence.
 *
 * WHY NOT evidence_records
 * ------------------------
 * `evidence_records` models an UPLOADED FILE: filename, original_filename,
 * file_type, file_size, uploaded_by. A connector observation is none of those —
 * "branch protection is enabled on main" has no file and no uploader. Writing it
 * there would mean a synthetic filename and file_size 0, i.e. a row whose label
 * does not describe its contents. That is the exact fault this platform has been
 * bitten by repeatedly (extraction_status='extracted' on rows holding a 170-char
 * seed blurb), so it gets its own table instead.
 *
 * APPEND-ONLY, DELIBERATELY
 * -------------------------
 * An auditor does not ask "is branch protection on today". They ask "show me it
 * was on throughout the audit period". A table that stores only the latest
 * observation cannot answer that, and the answer cannot be reconstructed later —
 * so every collection run INSERTs, and "current state" is a query over the
 * newest row per (source, check_key, subject). Storage is trivial: a handful of
 * checks a day is a few thousand rows a year.
 *
 * Nothing here writes to GitHub, and nothing stores a credential. The observed
 * payload is whatever the check chose to record, and checks are responsible for
 * recording facts rather than secrets.
 */

import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";

/** Outcome of one check against one subject. */
export type ConnectorEvidenceStatus =
  | "pass"
  | "fail"
  | "not_applicable"
  | "error";

export interface ConnectorObservation {
  /** Connector that produced it — 'github' today. */
  source: string;
  /** Stable identifier for the check, e.g. 'branch_protection'. */
  check_key: string;
  /** What was examined, e.g. 'shijazi-spec/qms-dashboard:main'. */
  subject: string;
  status: ConnectorEvidenceStatus;
  /** One line a human (or an auditor) can read without opening the JSON. */
  summary: string;
  /** The facts behind the verdict. Never credentials. */
  observed?: Record<string, any> | null;
}

let initialized = false;

export async function initConnectorEvidenceTable(): Promise<void> {
  if (initialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS connector_evidence (
      id           SERIAL PRIMARY KEY,
      source       VARCHAR(32)  NOT NULL,
      check_key    VARCHAR(128) NOT NULL,
      subject      VARCHAR(512) NOT NULL,
      status       VARCHAR(16)  NOT NULL,
      summary      TEXT         NOT NULL,
      observed     JSONB        NOT NULL DEFAULT '{}'::jsonb,
      observed_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Serves both reads: the newest row per check/subject, and the history of one
  // check over an audit period.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_connector_evidence_latest
       ON connector_evidence (source, check_key, subject, observed_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_connector_evidence_observed_at
       ON connector_evidence (observed_at DESC)`,
  );
  initialized = true;
  logger.info("✅ [ConnectorEvidence] connector_evidence table ready");
}

/**
 * Record observations from one collection run.
 *
 * Always INSERTs, never updates: an unchanged result is still evidence that the
 * control held at that moment, which is the whole point of an audit trail. The
 * cost of that choice is duplicate-looking rows, which is cheaper than being
 * unable to prove continuity.
 */
export async function recordObservations(
  rows: ConnectorObservation[],
): Promise<number> {
  if (rows.length === 0) return 0;
  await initConnectorEvidenceTable();
  let written = 0;
  for (const r of rows) {
    await pool.query(
      `INSERT INTO connector_evidence
         (source, check_key, subject, status, summary, observed)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        r.source,
        r.check_key,
        r.subject,
        r.status,
        r.summary,
        JSON.stringify(r.observed ?? {}),
      ],
    );
    written++;
  }
  logger.info(
    `[ConnectorEvidence] recorded ${written} observation(s) from ${rows[0].source}`,
  );
  return written;
}

/** Current state: the newest observation per (source, check_key, subject). */
export async function latestObservations(source?: string): Promise<any[]> {
  await initConnectorEvidenceTable();
  const params: any[] = [];
  let where = "";
  if (source) {
    params.push(source);
    where = `WHERE source = $1`;
  }
  const res = await pool.query(
    `SELECT DISTINCT ON (source, check_key, subject)
            id, source, check_key, subject, status, summary, observed, observed_at
       FROM connector_evidence
       ${where}
      ORDER BY source, check_key, subject, observed_at DESC`,
    params,
  );
  return res.rows;
}

/**
 * History of one check, for "show me this held across the period".
 * Ordered oldest-first because that is how an auditor reads a timeline.
 */
export async function observationHistory(
  source: string,
  check_key: string,
  opts: { subject?: string; since?: string; limit?: number } = {},
): Promise<any[]> {
  await initConnectorEvidenceTable();
  const params: any[] = [source, check_key];
  let sql = `SELECT id, source, check_key, subject, status, summary, observed, observed_at
               FROM connector_evidence
              WHERE source = $1 AND check_key = $2`;
  if (opts.subject) {
    params.push(opts.subject);
    sql += ` AND subject = $${params.length}`;
  }
  if (opts.since) {
    params.push(opts.since);
    sql += ` AND observed_at >= $${params.length}`;
  }
  params.push(Math.min(Math.max(opts.limit ?? 500, 1), 5000));
  sql += ` ORDER BY observed_at ASC LIMIT $${params.length}`;
  const res = await pool.query(sql, params);
  return res.rows;
}
