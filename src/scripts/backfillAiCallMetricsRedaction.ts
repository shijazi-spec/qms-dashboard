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
 * free-form text columns through `redactSecretLikeStrings()`, plus the
 * JSONB `metadata` column through `deepRedactSecretLikeStrings()`:
 *
 *   - error_message        (TEXT)  — error from a failed tool / LLM call
 *   - prompt_preview       (TEXT)  — first ~300 chars of the user prompt
 *   - tool_input_preview   (TEXT)  — sanitized JSON-stringified tool input
 *   - tool_output_preview  (TEXT)  — sanitized JSON-stringified tool output
 *   - metadata             (JSONB) — caller-supplied free-form context
 *
 * `metadata` is walked recursively so credential-shaped substrings stuffed
 * under innocuously-named leaf keys (e.g. `metadata.note`) get sentinelised
 * the same way the four TEXT columns do — Task #475 mirrors the JSONB
 * defense `redactAiPendingActions` (Task #289) already applies to
 * `ai_pending_actions.execution_result`.
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
  deepRedactSecretLikeStrings,
  REDACTED_SENTINEL,
  logEvent,
} from "../utils/eventLogsDatabase";
import { previewBreadcrumbSetFragment } from "../utils/aiCallMetricsPreviewBreadcrumb";

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
  metadata_changed: number;
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
  let metadataChanged = 0;
  let rowsUpdated = 0;
  let cursor = 0;

  while (true) {
    const page = await client.query(
      `SELECT id, error_message, prompt_preview, tool_input_preview,
              tool_output_preview, metadata
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
      // node-postgres parses JSONB columns into native JS values, so
      // `row.metadata` is already a plain object (or null). Some tests /
      // historical rows may still hand us a raw JSON string, so tolerate
      // both shapes defensively.
      let metadata: unknown = row.metadata ?? null;
      if (typeof metadata === "string" && metadata.length > 0) {
        try {
          metadata = JSON.parse(metadata);
        } catch {
          // Leave the malformed string alone — the deep-walk path below
          // will still scrub it as a string leaf.
        }
      }

      let errorDirty = false;
      let promptDirty = false;
      let toolInputDirty = false;
      let toolOutputDirty = false;
      let metadataDirty = false;

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

      if (metadata !== null && metadata !== undefined) {
        const scrubbed = deepRedactSecretLikeStrings(metadata);
        // Compare via JSON.stringify because deep equality on arbitrary
        // JSONB shapes is otherwise non-trivial; the structures here are
        // small and JSON-serialisable by definition (they came out of
        // JSONB), so this is cheap and correct.
        if (JSON.stringify(scrubbed) !== JSON.stringify(metadata)) {
          metadata = scrubbed;
          metadataDirty = true;
        }
      }

      if (errorDirty) errorMessageChanged++;
      if (promptDirty) promptPreviewChanged++;
      if (toolInputDirty) toolInputPreviewChanged++;
      if (toolOutputDirty) toolOutputPreviewChanged++;
      if (metadataDirty) metadataChanged++;

      if (
        errorDirty ||
        promptDirty ||
        toolInputDirty ||
        toolOutputDirty ||
        metadataDirty
      ) {
        // Task #557: stamp `previews_redacted_at = NOW()` alongside the
        // scrubbed columns whenever any of the three preview columns
        // actually changed, mirroring the Task #467 breadcrumb the
        // primary `redactAiCallMetrics()` sweep already writes. The AI
        // Operations call-detail panel reads this timestamp to render
        // the "Preview redacted by historical sweep on YYYY-MM-DD" badge,
        // so operators get consistent provenance signalling regardless
        // of which historical sweep cleaned the row. We deliberately do
        // NOT stamp when only `error_message` or `metadata` changed —
        // those columns are not surfaced as previews and the badge would
        // be misleading. Idempotency is preserved because we only enter
        // this branch when at least one column actually changed.
        //
        // Task #575: the breadcrumb decision (and the exact SQL fragment
        // that splices `, previews_redacted_at = NOW()` into the SET
        // clause) is delegated to the shared helper so this sweep and
        // `redactAiCallMetrics()` cannot drift on the rule. Any future
        // change to the preview-column list lives in one place and the
        // helper's unit test fails fast.
        const previewBreadcrumbAssignment = previewBreadcrumbSetFragment({
          promptPreview: promptDirty,
          toolInputPreview: toolInputDirty,
          toolOutputPreview: toolOutputDirty,
        });
        await client.query(
          `UPDATE ai_call_metrics
              SET error_message       = $1,
                  prompt_preview      = $2,
                  tool_input_preview  = $3,
                  tool_output_preview = $4,
                  metadata            = $5::jsonb${previewBreadcrumbAssignment}
            WHERE id = $6`,
          [
            errorMessage,
            promptPreview,
            toolInputPreview,
            toolOutputPreview,
            metadata !== null && metadata !== undefined
              ? JSON.stringify(metadata)
              : null,
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
    metadata_changed: metadataChanged,
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
      `tool_output_preview=${result.tool_output_preview_changed} ` +
      `metadata=${result.metadata_changed}`,
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
          `TEXT columns and deepRedactSecretLikeStrings across the metadata ` +
          `JSONB column. scanned=${result.scanned}, rows_updated=${result.rows_updated}, ` +
          `error_message=${result.error_message_changed}, ` +
          `prompt_preview=${result.prompt_preview_changed}, ` +
          `tool_input_preview=${result.tool_input_preview_changed}, ` +
          `tool_output_preview=${result.tool_output_preview_changed}, ` +
          `metadata=${result.metadata_changed}.`,
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
