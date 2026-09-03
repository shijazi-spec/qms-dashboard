/**
 * One-shot historical backfill: stamp `metadata.prompt_version` onto
 * existing `ai_response_feedback` rows whose `metadata` JSONB blob is
 * missing it but whose linked `ai_call_metrics` row already carries one.
 *
 * Task #750 ─────────────────────────────────────────────────────────────────
 * Task #589 fixed the WRITE path so call-id ratings stamp the active
 * prompt_version + client_surface onto the matching `ai_call_metrics`
 * row (via `setCallPromptVersionIfMissing` in `aiTelemetry.ts`). However,
 * every `ai_response_feedback` row written BEFORE that fix landed still
 * lacks `metadata.prompt_version` — so the AI Operations dashboard's
 * per-prompt-version comparison view (`getFeedbackRateByPromptVersion`)
 * silently bucketises those legacy rows under the literal `unknown`
 * grouping and under-counts ratings on the active prompt.
 *
 * This sweep walks every `ai_response_feedback` row whose `metadata`
 * lacks `prompt_version` AND that can be linked to an `ai_call_metrics`
 * row (via the `call_id` column, when present, or the legacy
 * `metadata->>'call_id'` fallback for rows written by older surfaces
 * that stored the linkage inside the JSONB blob). For each match it
 * copies `prompt_version` from `ai_call_metrics.metadata` into the
 * feedback row's `metadata`. Rows with no resolvable linkage — or
 * whose linked metric row has no prompt_version either — are left
 * untouched (per spec: "or leaves it null if none is found").
 *
 * `client_surface` is intentionally NOT backfilled. Per Task #589 it was
 * never persisted onto `ai_call_metrics` before the fix landed, so there
 * is no source value to copy from for historical rows.
 *
 * Idempotent. A second pass against the now-backfilled table reports 0
 * rows updated because the WHERE clause re-checks `prompt_version` is
 * still missing on every iteration.
 *
 * Memory safety: walks the source table in keyset-paginated batches
 * (`WHERE id > $cursor ORDER BY id ASC LIMIT N`) — same pattern as
 * `backfillAiCallMetricsRedaction` (Task #469) — so the sweep stays
 * bounded regardless of how large the feedback table has grown.
 *
 * Dry-run support: pass `--dry-run` on the CLI (or `{ dryRun: true }`
 * to the function) to scan + count + log without issuing any UPDATE.
 * Operators use this to preview how many rows the sweep would touch
 * before committing — same UX as the historical-redaction sweep
 * (Task #744 added the equivalent flag there).
 *
 * Run with:
 *   npx tsx src/scripts/backfillAiResponseFeedbackPromptVersion.ts
 *   npx tsx src/scripts/backfillAiResponseFeedbackPromptVersion.ts --dry-run
 */

import { Pool } from "pg";
import { logger } from "../utils/logger";
import { logEvent } from "../utils/eventLogsDatabase";

/**
 * Default keyset-pagination batch size. 500 keeps each round trip
 * bounded (a few MB of JSONB on realistic rows) while still amortising
 * network latency. Mirrors `DEFAULT_AI_METRICS_BACKFILL_BATCH_SIZE` in
 * `backfillAiCallMetricsRedaction.ts`.
 */
export const DEFAULT_FEEDBACK_PROMPT_VERSION_BATCH_SIZE = 500;

/**
 * Per-row outcome counters reported by the sweep. Snake_case is
 * intentional so the audit-log entry / last-sweep summary can
 * serialise this object directly.
 *
 *   - `scanned`             — total rows visited (regardless of outcome).
 *   - `eligible`            — subset of `scanned` whose `metadata`
 *                             lacked `prompt_version` AND that resolved
 *                             to a linkable `ai_call_metrics` row. These
 *                             are the candidates for an UPDATE.
 *   - `rows_updated`        — distinct rows the sweep actually rewrote
 *                             (or would have, in `dryRun` mode). Equals
 *                             the number of eligible rows whose linked
 *                             metric row carried a non-empty
 *                             `prompt_version`.
 *   - `missing_source`      — eligible rows whose linked metric row
 *                             also had no `prompt_version` (left null
 *                             per spec).
 *   - `unlinked`            — rows missing `prompt_version` but with
 *                             no resolvable `call_id` linkage. These
 *                             are unrecoverable from this sweep.
 *   - `dry_run`             — echoes the `dryRun` flag so the audit-log
 *                             entry can record whether any UPDATE
 *                             actually fired.
 */
export interface FeedbackPromptVersionBackfillResult {
  scanned: number;
  eligible: number;
  rows_updated: number;
  missing_source: number;
  unlinked: number;
  dry_run: boolean;
}

/**
 * Probe the live schema for a `call_id` column on `ai_response_feedback`
 * so the sweep keeps working both in environments where the column has
 * been added (the post-Task-#589 schema) AND in environments where the
 * linkage still lives in `metadata->>'call_id'` (legacy surfaces). The
 * probe is best-effort: any unexpected error from `information_schema`
 * is logged and treated as "column not present" so the sweep falls back
 * to the metadata path rather than crashing the boot path / cron run.
 */
export async function hasCallIdColumn(client: {
  query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<any>;
}): Promise<boolean> {
  try {
    const res = await client.query(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_name = 'ai_response_feedback'
          AND column_name = 'call_id'
        LIMIT 1`,
    );
    return Array.isArray(res?.rows) && res.rows.length > 0;
  } catch (probeErr) {
    logger.warn(
      "[FeedbackPromptVersionBackfill] call_id column probe failed; falling back to metadata->>'call_id':",
      probeErr,
    );
    return false;
  }
}

/**
 * Resolve a candidate `call_id` for a feedback row from either:
 *   1. the `call_id` column (if present in this environment), OR
 *   2. the legacy `metadata->>'call_id'` field (parsed as a positive
 *      integer; non-numeric / non-positive values are rejected so a
 *      malformed legacy blob cannot point the sweep at the wrong row).
 *
 * Returns `null` when neither source yields a usable id.
 */
export function resolveCallId(row: {
  call_id?: unknown;
  metadata?: unknown;
}): number | null {
  const direct = row.call_id;
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) {
    return direct;
  }
  if (typeof direct === "string" && direct.trim() !== "") {
    const n = Number.parseInt(direct, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  let meta: unknown = row.metadata ?? null;
  if (typeof meta === "string" && meta.length > 0) {
    try {
      meta = JSON.parse(meta);
    } catch {
      return null;
    }
  }
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const raw = (meta as Record<string, unknown>).call_id;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return raw;
    }
    if (typeof raw === "string" && raw.trim() !== "") {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/**
 * Walks `ai_response_feedback` in keyset-paginated batches, joining each
 * candidate to `ai_call_metrics` via the resolved `call_id`, and writes
 * `metadata.prompt_version` from the metric row when the feedback row
 * is missing one. Idempotent — the SELECT predicate filters out rows
 * that already carry a non-empty `prompt_version`, so a second pass
 * reports 0 rows updated.
 *
 * `client` only needs `.query(sql, params)` — both a `pg.Pool` and a
 * `pg.PoolClient` satisfy it, which keeps the unit test (which stubs
 * the client) free of the real Pool dependency.
 */
export async function backfillFeedbackPromptVersion(
  client: {
    query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<any>;
  },
  options: {
    dryRun?: boolean;
    batchSize?: number;
  } = {},
): Promise<FeedbackPromptVersionBackfillResult> {
  const dryRun = options.dryRun === true;
  const batchSize =
    options.batchSize ?? DEFAULT_FEEDBACK_PROMPT_VERSION_BATCH_SIZE;

  const callIdColumnExists = await hasCallIdColumn(client);
  // Project either the real column or NULL so the row shape stays
  // identical regardless of which schema variant we are running against
  // — the per-row resolver treats both inputs uniformly.
  const callIdSelectExpr = callIdColumnExists ? "call_id" : "NULL::bigint AS call_id";

  let scanned = 0;
  let eligible = 0;
  let rowsUpdated = 0;
  let missingSource = 0;
  let unlinked = 0;
  let cursor = 0;

  while (true) {
    const page = await client.query(
      `SELECT id, ${callIdSelectExpr}, metadata
         FROM ai_response_feedback
        WHERE id > $1
          AND COALESCE(NULLIF(TRIM(metadata->>'prompt_version'), ''), '') = ''
        ORDER BY id ASC
        LIMIT $2`,
      [cursor, batchSize],
    );

    if (!page.rows || page.rows.length === 0) break;

    for (const row of page.rows) {
      scanned++;

      const callId = resolveCallId(row);
      if (callId === null) {
        unlinked++;
        continue;
      }

      eligible++;

      const lookup = await client.query(
        `SELECT NULLIF(TRIM(metadata->>'prompt_version'), '') AS prompt_version
           FROM ai_call_metrics
          WHERE id = $1
          LIMIT 1`,
        [callId],
      );
      const sourceVersion: string | null =
        lookup?.rows?.[0]?.prompt_version ?? null;

      if (!sourceVersion) {
        missingSource++;
        continue;
      }

      rowsUpdated++;

      if (!dryRun) {
        // Merge into existing metadata so we preserve any other
        // allow-list keys (feature_flag, experiment_arm, rating_source,
        // workflow, step) the original write may have set. The
        // `jsonb_build_object` clause stamps prompt_version without
        // touching siblings.
        await client.query(
          `UPDATE ai_response_feedback
              SET metadata = COALESCE(metadata, '{}'::jsonb)
                             || jsonb_build_object('prompt_version', $2::text)
            WHERE id = $1
              AND COALESCE(NULLIF(TRIM(metadata->>'prompt_version'), ''), '') = ''`,
          [row.id, sourceVersion],
        );
      }
    }

    cursor = page.rows[page.rows.length - 1].id;
    if (page.rows.length < batchSize) break;
  }

  return {
    scanned,
    eligible,
    rows_updated: rowsUpdated,
    missing_source: missingSource,
    unlinked,
    dry_run: dryRun,
  };
}

/**
 * Runs the sweep and emits an immutable audit-log entry recording the
 * per-outcome counters. Used by both the CLI `main()` entry point and
 * by any future cron wiring (mirrors `runAiCallMetricsBackfill` in
 * `backfillAiCallMetricsRedaction.ts`). Audit-log emission failures are
 * logged but never mask the sweep result — the backfill already
 * succeeded, the audit trail is the nice-to-have layered on top.
 *
 * In `dryRun` mode the audit-log entry is still emitted so operators
 * can prove they ran a preview before committing — the entry's
 * `description` clearly tags the run as a dry-run and the structured
 * `newValue` payload echoes `dry_run: true`.
 */
export async function runFeedbackPromptVersionBackfill(
  client: {
    query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<any>;
  },
  options: { dryRun?: boolean } = {},
): Promise<FeedbackPromptVersionBackfillResult> {
  const result = await backfillFeedbackPromptVersion(client, options);
  const tag = result.dry_run ? "[DRY-RUN] " : "";

  logger.info(
    `[FeedbackPromptVersionBackfill] ${tag}scanned=${result.scanned} ` +
      `eligible=${result.eligible} rows_updated=${result.rows_updated} ` +
      `missing_source=${result.missing_source} unlinked=${result.unlinked}`,
  );

  if (result.scanned > 0) {
    try {
      await logEvent({
        actionType: "UPDATE",
        entityType: "SYSTEM",
        entityId: "ai_response_feedback",
        entityName:
          "Historical AI feedback prompt-version backfill" +
          (result.dry_run ? " (dry-run)" : ""),
        description:
          `${tag}Backfilled ai_response_feedback.metadata.prompt_version from the ` +
          `linked ai_call_metrics row. scanned=${result.scanned}, ` +
          `eligible=${result.eligible}, rows_updated=${result.rows_updated}, ` +
          `missing_source=${result.missing_source}, unlinked=${result.unlinked}.`,
        newValue: result,
        aiInvolved: false,
        severity: "INFO",
        module: "analytics/feedback-backfill",
      });
    } catch (auditErr) {
      logger.error(
        "[FeedbackPromptVersionBackfill] Failed to emit audit-log entry:",
        auditErr,
      );
    }
  }

  return result;
}

/**
 * CLI entry point. Connects to Postgres via DATABASE_URL, parses
 * `--dry-run`, runs the sweep with audit logging, and tears the pool
 * down. Safe to invoke ad hoc as an ops procedure — the sweep is
 * idempotent.
 */
async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    logger.info(
      `[FeedbackPromptVersionBackfill] Starting historical sweep ${dryRun ? "(dry-run)" : ""}...`,
    );
    const result = await runFeedbackPromptVersionBackfill(pool, { dryRun });
    logger.info(
      `[FeedbackPromptVersionBackfill] Done. ${
        dryRun ? "Would update" : "Updated"
      } ${result.rows_updated} of ${result.scanned} scanned rows.`,
    );
  } finally {
    await pool.end();
  }
}

const isDirectInvocation = (() => {
  try {
    const entry = process.argv[1] || "";
    return /backfillAiResponseFeedbackPromptVersion(\.ts|\.js)?$/.test(entry);
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().catch((err) => {
    logger.error("[FeedbackPromptVersionBackfill] Fatal error:", err);
    process.exit(1);
  });
}
