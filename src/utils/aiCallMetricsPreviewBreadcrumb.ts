/**
 * Shared decision rule for the `ai_call_metrics.previews_redacted_at`
 * historical-sweep breadcrumb (Task #575).
 *
 * Two separate sweeps clean preview columns on `ai_call_metrics`:
 *
 *   - `redactAiCallMetrics()` in `src/utils/redactHistoricalLogs.ts`
 *     (Task #467) — the preview-only sweep run by the daily redaction job.
 *   - `backfillAiCallMetricsRedaction()` in
 *     `src/scripts/backfillAiCallMetricsRedaction.ts` (Task #557) — the
 *     broader sweep that also scrubs `error_message` and the JSONB
 *     `metadata` column.
 *
 * Both must agree on exactly one rule: stamp `previews_redacted_at = NOW()`
 * if-and-only-if the sweep actually rewrote one of the three *preview*
 * columns. The AI Operations call-detail modal (`openCallDetailModal` in
 * `dashboard/ai-ops.html`) renders a "Preview redacted by historical
 * sweep on YYYY-MM-DD" badge keyed off this column, so any drift between
 * the two sweeps would re-introduce the operator confusion that Task #557
 * fixed (a row whose preview was scrubbed by one sweep would silently
 * miss the badge, while another row scrubbed by the other sweep would
 * show it).
 *
 * Centralising the rule here means a future change (e.g. adding a fourth
 * preview column) requires updating one helper, and the unit test in
 * `tests/aiCallMetricsPreviewBreadcrumb.test.ts` fails fast in one place
 * if the rule shifts.
 */

/**
 * Canonical list of `ai_call_metrics` columns whose changes the AI
 * Operations call-detail badge surfaces as "preview" provenance. Exposed
 * so any future caller adding another preview column has one place to
 * update.
 */
export const AI_CALL_METRICS_PREVIEW_COLUMNS = [
  "prompt_preview",
  "tool_input_preview",
  "tool_output_preview",
] as const;

export type AiCallMetricsPreviewColumn =
  (typeof AI_CALL_METRICS_PREVIEW_COLUMNS)[number];

/**
 * Per-column dirty flags a sweep accumulates while scanning a single row.
 * Only the three preview columns participate in the breadcrumb decision —
 * `error_message`, `metadata`, and any other future non-preview column
 * are deliberately excluded so the badge cannot misrepresent provenance.
 */
export interface PreviewDirtyFlags {
  readonly promptPreview?: boolean;
  readonly toolInputPreview?: boolean;
  readonly toolOutputPreview?: boolean;
}

/**
 * Returns `true` when the breadcrumb (`previews_redacted_at = NOW()`)
 * should be written alongside the row's UPDATE. Returns `false` when the
 * sweep rewrote only non-preview columns (`error_message`, `metadata`),
 * in which case the badge would be misleading and must stay hidden.
 *
 * Both `redactAiCallMetrics()` and `backfillAiCallMetricsRedaction()`
 * call this; the unit test exercises it directly so any future change
 * to the rule fails fast in one place rather than silently drifting
 * between the two sweeps.
 */
export function shouldStampPreviewBreadcrumb(
  dirty: PreviewDirtyFlags,
): boolean {
  return Boolean(
    dirty.promptPreview || dirty.toolInputPreview || dirty.toolOutputPreview,
  );
}

/**
 * SQL fragment to splice into an `UPDATE ai_call_metrics SET …` clause:
 * either `, previews_redacted_at = NOW()` (when at least one preview
 * column changed) or the empty string (when only non-preview columns
 * changed). Encapsulating the literal here keeps the exact wire shape —
 * the comma, the `NOW()` server-side timestamp, the column name — out of
 * call sites so the two sweeps cannot drift on whitespace or wording
 * either.
 */
export function previewBreadcrumbSetFragment(
  dirty: PreviewDirtyFlags,
): string {
  return shouldStampPreviewBreadcrumb(dirty)
    ? `, previews_redacted_at = NOW()`
    : ``;
}
