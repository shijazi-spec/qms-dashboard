/**
 * Unit tests for the shared `previews_redacted_at` breadcrumb helper
 * (Task #575).
 *
 * Two separate sweeps clean preview columns on `ai_call_metrics`
 * (`redactAiCallMetrics()` in `src/utils/redactHistoricalLogs.ts` and
 * `backfillAiCallMetricsRedaction()` in
 * `src/scripts/backfillAiCallMetricsRedaction.ts`). Both must agree on
 * one rule: stamp `previews_redacted_at = NOW()` if-and-only-if at least
 * one of the three preview columns actually changed. The shared helper
 * lives in `src/utils/aiCallMetricsPreviewBreadcrumb.ts` so a future
 * change to the rule cannot silently fall out of sync between the two
 * sweeps. This test exercises the helper directly so any drift fails
 * fast in one place rather than re-introducing the operator confusion
 * Task #557 fixed.
 *
 * Run:  npx tsx tests/aiCallMetricsPreviewBreadcrumb.test.ts
 */

import {
  AI_CALL_METRICS_PREVIEW_COLUMNS,
  previewBreadcrumbSetFragment,
  shouldStampPreviewBreadcrumb,
} from "../src/utils/aiCallMetricsPreviewBreadcrumb";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  \u2713 ${label}`);
    passed++;
  } else {
    console.error(`  \u2717 ${label}`);
    failed++;
  }
}

async function run(): Promise<void> {
  console.log(
    "\n[aiCallMetricsPreviewBreadcrumb] shared historical-sweep breadcrumb rule",
  );

  // -----------------------------------------------------------------------
  // Canonical preview-column list — both sweeps must reference the same
  // three columns. Any future addition (e.g. a fourth preview surface)
  // must update this constant in one place.
  // -----------------------------------------------------------------------
  assert(
    AI_CALL_METRICS_PREVIEW_COLUMNS.length === 3,
    `preview-column list has exactly 3 entries (got ${AI_CALL_METRICS_PREVIEW_COLUMNS.length})`,
  );
  assert(
    AI_CALL_METRICS_PREVIEW_COLUMNS.includes("prompt_preview"),
    "preview-column list includes prompt_preview",
  );
  assert(
    AI_CALL_METRICS_PREVIEW_COLUMNS.includes("tool_input_preview"),
    "preview-column list includes tool_input_preview",
  );
  assert(
    AI_CALL_METRICS_PREVIEW_COLUMNS.includes("tool_output_preview"),
    "preview-column list includes tool_output_preview",
  );

  // -----------------------------------------------------------------------
  // shouldStampPreviewBreadcrumb — the boolean decision rule. Returns
  // true if-and-only-if at least one preview column changed.
  // -----------------------------------------------------------------------
  assert(
    shouldStampPreviewBreadcrumb({}) === false,
    "no flags supplied → no stamp (default-false guard)",
  );
  assert(
    shouldStampPreviewBreadcrumb({
      promptPreview: false,
      toolInputPreview: false,
      toolOutputPreview: false,
    }) === false,
    "all preview flags false → no stamp",
  );
  assert(
    shouldStampPreviewBreadcrumb({ promptPreview: true }) === true,
    "promptPreview dirty alone → stamp",
  );
  assert(
    shouldStampPreviewBreadcrumb({ toolInputPreview: true }) === true,
    "toolInputPreview dirty alone → stamp",
  );
  assert(
    shouldStampPreviewBreadcrumb({ toolOutputPreview: true }) === true,
    "toolOutputPreview dirty alone → stamp",
  );
  assert(
    shouldStampPreviewBreadcrumb({
      promptPreview: true,
      toolInputPreview: true,
      toolOutputPreview: true,
    }) === true,
    "every preview column dirty → stamp",
  );

  // -----------------------------------------------------------------------
  // Critical contract: the backfill sweep also rewrites `error_message`
  // and `metadata`, neither of which should trigger the preview badge.
  // The helper signature deliberately exposes only the three preview
  // flags so non-preview dirtiness cannot accidentally stamp the row.
  // We simulate that by verifying the explicit "all preview flags false"
  // case still returns false even though a real call site would have
  // entered the UPDATE branch for a non-preview reason.
  // -----------------------------------------------------------------------
  assert(
    shouldStampPreviewBreadcrumb({
      promptPreview: false,
      toolInputPreview: false,
      toolOutputPreview: false,
    }) === false,
    "non-preview-only rewrites (error_message / metadata) → no stamp",
  );

  // -----------------------------------------------------------------------
  // previewBreadcrumbSetFragment — the SQL fragment spliced into the
  // UPDATE SET clause. Must produce the canonical wire shape so both
  // sweeps issue byte-identical breadcrumb assignments.
  // -----------------------------------------------------------------------
  const stampedFragment = previewBreadcrumbSetFragment({
    promptPreview: true,
  });
  assert(
    stampedFragment === ", previews_redacted_at = NOW()",
    `stamped fragment is exactly ", previews_redacted_at = NOW()" (got ${JSON.stringify(stampedFragment)})`,
  );
  assert(
    previewBreadcrumbSetFragment({}) === "",
    "no preview flags → empty fragment (no SQL splice)",
  );
  assert(
    previewBreadcrumbSetFragment({
      promptPreview: false,
      toolInputPreview: false,
      toolOutputPreview: false,
    }) === "",
    "all preview flags false → empty fragment",
  );
  assert(
    previewBreadcrumbSetFragment({
      promptPreview: true,
      toolInputPreview: true,
      toolOutputPreview: true,
    }) === ", previews_redacted_at = NOW()",
    "all preview flags true → single canonical fragment (no duplication)",
  );

  // The fragment must start with `, ` so it can be appended to an
  // existing SET clause without a syntax error, and must reference NOW()
  // server-side (no JS-bound parameter) so both sweeps stamp the same
  // wall-clock the dashboard badge formats.
  for (const flags of [
    { promptPreview: true },
    { toolInputPreview: true },
    { toolOutputPreview: true },
    { promptPreview: true, toolInputPreview: true, toolOutputPreview: true },
  ]) {
    const f = previewBreadcrumbSetFragment(flags);
    assert(
      f.startsWith(", "),
      `fragment for ${JSON.stringify(flags)} starts with ", " so it splices safely after another SET column`,
    );
    assert(
      /previews_redacted_at\s*=\s*NOW\(\)/.test(f),
      `fragment for ${JSON.stringify(flags)} stamps previews_redacted_at = NOW() server-side`,
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
