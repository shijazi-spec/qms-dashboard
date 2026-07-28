/**
 * docTrackerDatabase — schema for the Documentation Live Tracker.
 *
 * A collector on the file server scans the controlled documentation library
 * (Coded & Controlled/{Documents,Policies,SOPs,Forms,Security Controls}),
 * hashes each file, validates its WP-* code, extracts document→document
 * cross-references, and POSTs a full snapshot. These tables hold that state
 * plus the human review judgement layered on top of it.
 *
 * THE OWNERSHIP SPLIT — the rule that keeps this honest:
 *
 *   Collector owns (overwritten on every ingest):
 *     base_code, lang, doc_family, file_name, folder, size_kb, modified_at,
 *     content_hash, code_ok, issues, refs
 *   Platform owns (NEVER touched by ingest):
 *     review_state, assignee_email, note, reviewed_at, reviewed_by,
 *     hash_at_review
 *
 * A scan that overwrites human review state is the classic way trackers like
 * this rot, so the ingest merge writes collector columns by name rather than
 * upserting whole rows.
 *
 * Every column is declared in the canonical CREATE TABLE (no runtime-only
 * ALTERs) so scripts/check-schema-parity.mjs --strict stays clean and Replit's
 * publish-time schema diff never proposes a DROP.
 */

import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";

/** Where a document sits in the review workflow. Platform-owned. */
export type DocReviewState =
  | "unreviewed"
  | "in_review"
  | "mapped"
  | "commented"
  | "approved"
  | "blocked";

export const DOC_REVIEW_STATES: DocReviewState[] = [
  "unreviewed",
  "in_review",
  "mapped",
  "commented",
  "approved",
  "blocked",
];

/** Review states that represent a settled judgement — these are what can go stale. */
export const TERMINAL_REVIEW_STATES: DocReviewState[] = [
  "mapped",
  "commented",
  "approved",
];

/** Outcome recorded for each ingest attempt. */
export type SnapshotStatus = "applied" | "duplicate" | "partial" | "rejected";

/** Collector liveness. `silent` = no heartbeat; `stale` = no snapshot in 26h. */
export type CollectorHealth = "ok" | "silent" | "stale" | "disabled";

let ready = false;

export async function initDocTrackerTables(): Promise<void> {
  if (ready) return;

  // One row per register_code (WP-POL-001 / WP-POL-001-AR). Soft-delete only:
  // a document vanishing from the library is a finding, not a reason to drop
  // its review history.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS doc_tracker_documents (
      id                   SERIAL PRIMARY KEY,
      register_code        VARCHAR(80)  NOT NULL UNIQUE,
      base_code            VARCHAR(80),
      lang                 VARCHAR(4)   NOT NULL DEFAULT 'EN',
      doc_family           VARCHAR(16),
      title                VARCHAR(512),
      file_name            VARCHAR(512),
      folder               VARCHAR(512),
      size_kb              NUMERIC(12,2),
      modified_at          TIMESTAMP,
      content_hash         VARCHAR(80),
      code_ok              BOOLEAN      NOT NULL DEFAULT TRUE,
      issues               JSONB        NOT NULL DEFAULT '[]'::jsonb,
      ref_count            INTEGER      NOT NULL DEFAULT 0,
      dangling_count       INTEGER      NOT NULL DEFAULT 0,
      policy_id            INTEGER,
      projected_document_id INTEGER,
      promoted_from_orphan BOOLEAN      NOT NULL DEFAULT FALSE,
      promoted_at          TIMESTAMP,
      promoted_by          VARCHAR(255),
      review_state         VARCHAR(20)  NOT NULL DEFAULT 'unreviewed',
      assignee_email       VARCHAR(255),
      note                 TEXT,
      reviewed_at          TIMESTAMP,
      reviewed_by          VARCHAR(255),
      hash_at_review       VARCHAR(80),
      collector_id         VARCHAR(120),
      deleted              BOOLEAN      NOT NULL DEFAULT FALSE,
      deleted_at           TIMESTAMP,
      first_seen_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_doc_tracker_documents_active
       ON doc_tracker_documents (deleted, review_state)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_doc_tracker_documents_base
       ON doc_tracker_documents (base_code)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_doc_tracker_documents_policy
       ON doc_tracker_documents (policy_id)`,
  );

  // Document→document cross-references. Nothing in the platform stored these
  // before; the collector extracts them from document text. `resolved` is FALSE
  // when the target code is not in the library — a dangling reference.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS doc_tracker_refs (
      id           SERIAL PRIMARY KEY,
      from_code    VARCHAR(80) NOT NULL,
      to_code      VARCHAR(80) NOT NULL,
      resolved     BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (from_code, to_code)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_doc_tracker_refs_to
       ON doc_tracker_refs (to_code)`,
  );

  // Ingest history. `snapshot_hash` is recomputed server-side over the document
  // facts ONLY (never timestamps) so replaying an unchanged scan is detected as
  // a duplicate and writes nothing.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS doc_tracker_snapshots (
      id             SERIAL PRIMARY KEY,
      collector_id   VARCHAR(120),
      snapshot_hash  VARCHAR(80),
      mode           VARCHAR(20),
      status         VARCHAR(20) NOT NULL DEFAULT 'applied',
      reject_reason  VARCHAR(80),
      documents_in   INTEGER     NOT NULL DEFAULT 0,
      inserted       INTEGER     NOT NULL DEFAULT 0,
      updated        INTEGER     NOT NULL DEFAULT 0,
      soft_deleted   INTEGER     NOT NULL DEFAULT 0,
      orphans        INTEGER     NOT NULL DEFAULT 0,
      stats          JSONB       NOT NULL DEFAULT '{}'::jsonb,
      created_at     TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_doc_tracker_snapshots_recent
       ON doc_tracker_snapshots (collector_id, created_at DESC)`,
  );

  // Collector liveness. Must survive restarts, so no in-memory state: a tracker
  // that has quietly stopped updating is worse than no tracker, because it is
  // trusted. `last_alert_at` is the per-row anti-spam stamp.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS doc_tracker_collectors (
      collector_id      VARCHAR(120) PRIMARY KEY,
      collector_version VARCHAR(40),
      library_root      VARCHAR(512),
      health_state      VARCHAR(20) NOT NULL DEFAULT 'ok',
      last_heartbeat_at TIMESTAMP,
      last_snapshot_at  TIMESTAMP,
      last_error        TEXT,
      stale_since       TIMESTAMP,
      last_alert_at     TIMESTAMP,
      enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  ready = true;
  logger.info("✅ [DocTracker] tracker tables ready");
}

/** Count of non-deleted tracker rows — the denominator for the mass-deletion guard. */
export async function countActiveDocuments(collectorId?: string): Promise<number> {
  await initDocTrackerTables();
  const r = collectorId
    ? await pool.query(
        `SELECT COUNT(*)::int AS n FROM doc_tracker_documents
          WHERE deleted = FALSE AND collector_id = $1`,
        [collectorId],
      )
    : await pool.query(
        `SELECT COUNT(*)::int AS n FROM doc_tracker_documents WHERE deleted = FALSE`,
      );
  return r.rows[0]?.n || 0;
}

/** Record the outcome of an ingest attempt. */
export async function recordSnapshot(input: {
  collector_id: string | null;
  snapshot_hash: string | null;
  mode: string | null;
  status: SnapshotStatus;
  reject_reason?: string | null;
  documents_in: number;
  inserted?: number;
  updated?: number;
  soft_deleted?: number;
  orphans?: number;
  stats?: Record<string, unknown>;
}): Promise<number> {
  await initDocTrackerTables();
  const r = await pool.query(
    `INSERT INTO doc_tracker_snapshots
       (collector_id, snapshot_hash, mode, status, reject_reason,
        documents_in, inserted, updated, soft_deleted, orphans, stats)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      input.collector_id,
      input.snapshot_hash,
      input.mode,
      input.status,
      input.reject_reason ?? null,
      input.documents_in,
      input.inserted ?? 0,
      input.updated ?? 0,
      input.soft_deleted ?? 0,
      input.orphans ?? 0,
      JSON.stringify(input.stats ?? {}),
    ],
  );
  return r.rows[0].id;
}

/** The most recent ACCEPTED snapshot hash for a collector (duplicate detection). */
export async function lastAcceptedSnapshotHash(
  collectorId: string,
): Promise<string | null> {
  await initDocTrackerTables();
  const r = await pool.query(
    `SELECT snapshot_hash FROM doc_tracker_snapshots
      WHERE collector_id = $1 AND status IN ('applied','partial')
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [collectorId],
  );
  return r.rows[0]?.snapshot_hash ?? null;
}

/** Upsert collector liveness. Called by both /ingest and /heartbeat. */
export async function touchCollector(input: {
  collector_id: string;
  collector_version?: string | null;
  library_root?: string | null;
  snapshot?: boolean;
  last_error?: string | null;
}): Promise<void> {
  await initDocTrackerTables();
  await pool.query(
    `INSERT INTO doc_tracker_collectors
       (collector_id, collector_version, library_root, last_heartbeat_at,
        last_snapshot_at, last_error, health_state, updated_at)
     VALUES ($1,$2,$3, CURRENT_TIMESTAMP,
             CASE WHEN $4 THEN CURRENT_TIMESTAMP ELSE NULL END, $5, 'ok', CURRENT_TIMESTAMP)
     ON CONFLICT (collector_id) DO UPDATE
       SET collector_version = COALESCE(EXCLUDED.collector_version, doc_tracker_collectors.collector_version),
           library_root      = COALESCE(EXCLUDED.library_root, doc_tracker_collectors.library_root),
           last_heartbeat_at = CURRENT_TIMESTAMP,
           last_snapshot_at  = CASE WHEN $4 THEN CURRENT_TIMESTAMP
                                    ELSE doc_tracker_collectors.last_snapshot_at END,
           last_error        = EXCLUDED.last_error,
           health_state      = 'ok',
           stale_since       = NULL,
           last_alert_at     = NULL,
           updated_at        = CURRENT_TIMESTAMP`,
    [
      input.collector_id,
      input.collector_version ?? null,
      input.library_root ?? null,
      input.snapshot === true,
      input.last_error ?? null,
    ],
  );
}
