/**
 * One-shot historical backfill: scrub credential-shaped substrings from
 * existing `ai_call_metrics` free-form TEXT columns.
 *
 * Task #469 ─────────────────────────────────────────────────────────────────
 * Task #452 closed every WRITE path that persists `ai_call_metrics.error_message`
 * (insertAiCallMetric, finalizeAiCallMetric, wrapToolWithTelemetry) so future
 * tool / LLM failures can no longer leak credential-shaped substrings (sk-…,
 * ghp_…, JWTs, bcrypt hashes, AWS keys) into the metrics table. However, any
 * rows already written before the fix landed may still contain those secrets
 * in plaintext — analogous to the historical leak in
 * `ai_pending_actions.execution_result.error` that Task #256 cleaned up via
 * the `aiApprovalSweepBackfill`.
 *
 * This sweep walks every existing `ai_call_metrics` row and runs the four
 * free-form text columns through `redactSecretLikeStrings()`:
 *
 *   - error_message        (TEXT) — error from a failed tool / LLM call
 *   - prompt_preview       (TEXT) — first ~300 chars of the user prompt
 *   - tool_input_preview   (TEXT) — sanitized JSON-stringified tool input
 *   - tool_output_preview  (TEXT) — sanitized JSON-stringified tool output
 *
 * Only rows whose redacted form differs from the stored value are UPDATEd, so
 * a second pass reports 0 rows updated (the script is idempotent). The
 * function emits per-column change counters that the audit-log entry written
 * by main() / the daily ai-cost-summary cron consume.
 *
 * Memory safety: walks the table in keyset-paginated batches
 * (`WHERE id > $cursor ORDER BY id ASC LIMIT N`) — same pattern as
 * `redactAiPendingActions` (Task #289) — so the sweep stays bounded
 * regardless of how large the metrics table has grown.
 *
 * Run with:
 *   npx tsx src/scripts/backfillAiCallMetricsRedaction.ts
 */

import { Pool } from "pg";
import {
  redactSecretLikeStrings,
  REDACTED_SENTINEL,
  logEvent,
} from "../utils/eventLogsDatabase";

/**
 * Default keyset-pagination batch size. 500 keeps each round trip under a
 * few MB of TEXT on realistic rows while still amortising network latency.
 * Mirrors `DEFAULT_SWEEP_BATCH_SIZE` in `src/utils/redactHistoricalLogs.ts`.
 */
export const DEFAULT_AI_METRICS_BACKFILL_BATCH_SIZE = 500;

/**
 * Result counters reported by the sweep. Snake_case is intentional so the
 * audit-log entry / last-sweep summary can serialise this object directly.
 */
export interface AiCallMetricsBackfillResult {
  scanned: number;
  error_message_changed: number;
  prompt_preview_changed: number;
  tool_input_preview_changed: number;
  tool_output_preview_changed: number;
  rows_updated: number;
}

/**
 * Re-runs `redactSecretLikeStrings()` over each free-form TEXT column on
 * every `ai_call_metrics` row and rewrites only the rows whose value changed.
 *
 * Idempotent. A second pass against the now-clean table reports 0 rows
 * updated.
 *
 * `client` only needs `.query(sql, params)` — both a `pg.Pool` and a
 * `pg.PoolClient` satisfy it, which keeps the unit test (which stubs the
 * client) free of the real Pool dependency.
 */
export async function backfillAiCallMetricsRedaction(
  client: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<any> },
  batchSize: number = DEFAULT_AI_METRICS_BACKFILL_BATCH_SIZE,
): Promise<AiCallMetricsBackfillResult> {
  let scanned = 0;
  let errorMessageChanged = 0;
  let promptPreviewChanged = 0;
  let toolInputPreviewChanged = 0;
  let toolOutputPreviewChanged = 0;
  let rowsUpdated = 0;
  let cursor = 0;

  while (true) {
    const page = await client.query(
      `SELECT id, error_message, prompt_preview, tool_input_preview, tool_output_preview
         FROM ai_call_metrics
        WHERE id > $1
        ORDER BY id ASC
        LIMIT $2`,
      [cursor, batchSize],
    );

    if (!page.rows || page.rows.length === 0) break;

    for (const row of page.rows) {
      scanned++;

      let errorMessage: string | null = row.error_message ?? null;
      let promptPreview: string | null = row.prompt_preview ?? null;
      let toolInputPreview: string | null = row.tool_input_preview ?? null;
      let toolOutputPreview: string | null = row.tool_output_preview ?? null;

      let errorDirty = false;
      let promptDirty = false;
      let toolInputDirty = false;
      let toolOutputDirty = false;

      if (typeof errorMessage === "string" && errorMessage.length > 0) {
        const scrubbed = redactSecretLikeStrings(errorMessage) as string;
        if (scrubbed !== errorMessage) {
          errorMessage = scrubbed;
          errorDirty = true;
        }
      }

      if (typeof promptPreview === "string" && promptPreview.length > 0) {
        const scrubbed = redactSecretLikeStrings(promptPreview) as string;
        if (scrubbed !== promptPreview) {
          promptPreview = scrubbed;
          promptDirty = true;
        }
      }

      if (typeof toolInputPreview === "string" && toolInputPreview.length > 0) {
        const scrubbed = redactSecretLikeStrings(toolInputPreview) as string;
        if (scrubbed !== toolInputPreview) {
          toolInputPreview = scrubbed;
          toolInputDirty = true;
        }
      }

      if (typeof toolOutputPreview === "string" && toolOutputPreview.length > 0) {
        const scrubbed = redactSecretLikeStrings(toolOutputPreview) as string;
        if (scrubbed !== toolOutputPreview) {
          toolOutputPreview = scrubbed;
          toolOutputDirty = true;
        }
      }

      if (errorDirty) errorMessageChanged++;
      if (promptDirty) promptPreviewChanged++;
      if (toolInputDirty) toolInputPreviewChanged++;
      if (toolOutputDirty) toolOutputPreviewChanged++;

      if (errorDirty || promptDirty || toolInputDirty || toolOutputDirty) {
        await client.query(
          `UPDATE ai_call_metrics
              SET error_message       = $1,
                  prompt_preview      = $2,
                  tool_input_preview  = $3,
                  tool_output_preview = $4
            WHERE id = $5`,
          [
            errorMessage,
            promptPreview,
            toolInputPreview,
            toolOutputPreview,
            row.id,
          ],
        );
        rowsUpdated++;
      }
    }

    cursor = page.rows[page.rows.length - 1].id;
    if (page.rows.length < batchSize) break;
  }

  return {
    scanned,
    error_message_changed: errorMessageChanged,
    prompt_preview_changed: promptPreviewChanged,
    tool_input_preview_changed: toolInputPreviewChanged,
    tool_output_preview_changed: toolOutputPreviewChanged,
    rows_updated: rowsUpdated,
  };
}

/**
 * Runs the sweep against the supplied client and emits an immutable
 * audit-log entry recording the per-column counters. Used by both the CLI
 * `main()` entry point and by the daily `ai-cost-summary` cron in
 * `src/mastra/inngest/index.ts` so the same code path is exercised in
 * production. Audit-log emission failures are logged but never mask the
 * sweep result (the redaction already succeeded).
 */
export async function runAiCallMetricsBackfill(
  client: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<any> },
): Promise<AiCallMetricsBackfillResult> {
  const result = await backfillAiCallMetricsRedaction(client);

  console.log(
    `[AiMetricsBackfill] scanned=${result.scanned} ` +
      `rows_updated=${result.rows_updated} ` +
      `error_message=${result.error_message_changed} ` +
      `prompt_preview=${result.prompt_preview_changed} ` +
      `tool_input_preview=${result.tool_input_preview_changed} ` +
      `tool_output_preview=${result.tool_output_preview_changed}`,
  );

  if (result.rows_updated > 0) {
    try {
      await logEvent({
        actionType: "UPDATE",
        entityType: "SYSTEM",
        entityId: "ai_call_metrics",
        entityName: "Historical AI metric secret-redaction sweep",
        description:
          `Backfilled redactSecretLikeStrings across ai_call_metrics free-form ` +
          `TEXT columns. scanned=${result.scanned}, rows_updated=${result.rows_updated}, ` +
          `error_message=${result.error_message_changed}, ` +
          `prompt_preview=${result.prompt_preview_changed}, ` +
          `tool_input_preview=${result.tool_input_preview_changed}, ` +
          `tool_output_preview=${result.tool_output_preview_changed}.`,
        newValue: result,
        aiInvolved: false,
        severity: "INFO",
        module: "security/redaction-sweep",
      });
    } catch (auditErr) {
      console.error(
        "[AiMetricsBackfill] Failed to emit audit-log entry:",
        auditErr,
      );
    }
  }

  return result;
}

/**
 * CLI entry point. Connects to Postgres via DATABASE_URL, runs the sweep
 * with audit logging, and tears the pool down. Safe to invoke ad hoc as
 * an ops procedure even after the daily cron has already run — the sweep
 * is idempotent.
 */
async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    console.log("[AiMetricsBackfill] Starting historical sweep...");
    const result = await runAiCallMetricsBackfill(pool);
    console.log(
      `[AiMetricsBackfill] Done. Sentinel = ${REDACTED_SENTINEL}. ` +
        `${result.rows_updated} rows rewritten.`,
    );
  } finally {
    await pool.end();
  }
}

// Only run when invoked directly via tsx / node — never on import (so the
// unit test does not auto-execute against a real database).
const isDirectInvocation = (() => {
  try {
    const entry = process.argv[1] || "";
    return /backfillAiCallMetricsRedaction(\.ts|\.js)?$/.test(entry);
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().catch((err) => {
    console.error("[AiMetricsBackfill] Fatal error:", err);
    process.exit(1);
  });
}
