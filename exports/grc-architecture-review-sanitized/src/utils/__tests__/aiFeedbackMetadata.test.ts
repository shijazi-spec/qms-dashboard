/**
 * CI gate: prevents new code that writes to `ai_response_feedback` from
 * feeding free-form dynamic strings (typically from `catch (err)` / raw
 * HTTP headers / tool output) into the `metadata` JSONB column. Mirrors
 * the protection added for `ai_call_metrics.metadata` by Task #484
 * (`buildAiCallTelemetryMetadata` in `aiTelemetry.ts`).
 *
 * Pairs with the WRITE-path scrubber `redactFeedbackMetadataForStorage()`
 * — the scrubber catches the leak one layer too late (AFTER the secret
 * has been constructed in memory and typically logged via the structured
 * logger), this typed helper prevents the pattern at the source.
 *
 * Run:    npx tsx src/utils/__tests__/aiFeedbackMetadata.test.ts
 *
 * Verifies:
 *   (a) buildAiCallFeedbackMetadata maps every camelCase allow-list input
 *       to its snake_case output (the shape persisted in the JSONB column)
 *   (b) Omitted inputs do not appear in the output (no `undefined` leaves
 *       that would surface as `null` rows in the JSONB column)
 *   (c) The closed `AiCallFeedbackMetadataInput` interface rejects
 *       free-form keys at compile time — verified by the
 *       `// @ts-expect-error` directive which the npm `check` (tsc) gate
 *       enforces in CI
 *   (d) Defense-in-depth: even if a caller bypasses the type system via
 *       `as any`, unexpected keys are dropped AND a `logger.warn` with
 *       an actionable message is emitted
 *   (e) The WRITE-path scrubber `redactFeedbackMetadataForStorage()`
 *       still scrubs credential-shaped substrings from typed values (so
 *       a future allowed field can never persist a leaked secret in
 *       plaintext either)
 */

import { strict as assert } from "node:assert";
import {
  buildAiCallFeedbackMetadata,
  redactFeedbackMetadataForStorage,
} from "../aiFeedbackDatabase";
import { logger } from "../logger";

let passed = 0;
let failed = 0;

function check(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// (a) every allow-list key round-trips camelCase → snake_case
{
  const result = buildAiCallFeedbackMetadata({
    promptVersion: "qms@deadbeef",
    featureFlag: "new-prompt-A",
    experimentArm: "control",
    workflow: "qualityAuditWorkflow",
    step: "sdr-audit",
    ratingSource: "inline_thumbs",
    clientSurface: "web",
  });
  assert.deepStrictEqual(result, {
    prompt_version: "qms@deadbeef",
    feature_flag: "new-prompt-A",
    experiment_arm: "control",
    workflow: "qualityAuditWorkflow",
    step: "sdr-audit",
    rating_source: "inline_thumbs",
    client_surface: "web",
  });
  check(true, "(a) all allow-list keys round-trip camelCase → snake_case");
}

// (b) omitted inputs do not appear in the output
{
  const result = buildAiCallFeedbackMetadata({
    promptVersion: "qms@abc12345",
  });
  assert.deepStrictEqual(result, { prompt_version: "qms@abc12345" });
  check(
    !("feature_flag" in result) && !("workflow" in result),
    "(b) omitted inputs are absent (no undefined leaves)",
  );
}

// (b.1) explicit `undefined` is treated as omitted (not written as `null`)
{
  const result = buildAiCallFeedbackMetadata({
    promptVersion: "qms@deadbeef",
    workflow: undefined,
    step: undefined,
  });
  assert.deepStrictEqual(result, { prompt_version: "qms@deadbeef" });
  check(true, "(b.1) explicit `undefined` inputs are skipped");
}

// (c) closed interface — `note` triggers a TypeScript compile error
{
  buildAiCallFeedbackMetadata({
    promptVersion: "qms@deadbeef",
    // @ts-expect-error — `note` is NOT in the AiCallFeedbackMetadataInput
    // allow-list. The npm `check` (tsc) gate enforces this at CI time so a
    // developer cannot land `{ note: caughtError.message, debug: rawHeaders }`
    // pulled from a `catch` block — which would land plaintext credentials
    // in ai_response_feedback.metadata BEFORE the WRITE-path scrubber runs.
    note: "<REDACTED_TOKEN>",
  });
  check(
    true,
    "(c) `note` triggers a TypeScript compile error (// @ts-expect-error)",
  );
}

// (d) defense-in-depth — bypassing the type system via `as any` is caught at runtime
{
  const warnings: string[] = [];
  const originalWarn = logger.warn;
  logger.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    const result = buildAiCallFeedbackMetadata({
      promptVersion: "qms@deadbeef",
      // Simulate a caller that bypassed the type-system the way an `as any`
      // cast or an untyped JS shim would.
      ...({
        note: "<REDACTED_TOKEN>",
        debug: "raw-headers",
      } as Record<string, string>),
    } as Parameters<typeof buildAiCallFeedbackMetadata>[0]);

    assert.deepStrictEqual(result, { prompt_version: "qms@deadbeef" });
    check(
      warnings.some((w) => w.includes('unexpected key "note"')),
      '(d) unexpected key "note" emits actionable logger.warn',
    );
    check(
      warnings.some((w) => w.includes('unexpected key "debug"')),
      '(d) unexpected key "debug" emits actionable logger.warn',
    );
    check(
      !("note" in result) && !("debug" in result),
      "(d) unexpected keys are dropped from the output",
    );
  } finally {
    logger.warn = originalWarn;
  }
}

// (e) WRITE-path scrubber still masks credential-shaped substrings —
// belt-and-braces in case a future allowed field carries a leaked value.
{
  const scrubbed = redactFeedbackMetadataForStorage(
    buildAiCallFeedbackMetadata({
      // Stuff a sk-live-style token into `feature_flag` — the helper allows
      // it (the field is a free-form string), but the WRITE-path scrubber
      // must still mask it before the row is INSERT-ed.
      featureFlag: "<REDACTED_TOKEN>",
      promptVersion: "qms@deadbeef",
    }),
  );
  const serialized = JSON.stringify(scrubbed);
  check(
    !serialized.includes("<REDACTED_TOKEN>"),
    "(e) redactFeedbackMetadataForStorage still scrubs sk-live tokens (defense-in-depth)",
  );
  check(
    serialized.includes("qms@deadbeef"),
    "(e) non-secret values pass through untouched",
  );
}

// (e.1) scrubber tolerates null / undefined and returns a plain object
{
  assert.deepStrictEqual(redactFeedbackMetadataForStorage(null), {});
  assert.deepStrictEqual(redactFeedbackMetadataForStorage(undefined), {});
  check(
    true,
    "(e.1) redactFeedbackMetadataForStorage returns {} for null/undefined",
  );
}

// (f) Upsert preservation contract: when a caller omits `metadata`,
// `saveFeedback` must NOT erase the existing JSONB on the row. We can't
// run real SQL here, but we can lock down the helper-level invariant
// that the SQL relies on: `metadata` is computed to `null` exactly when
// the input is `undefined`, and to a JSON string otherwise. The DB-side
// `COALESCE($7::jsonb, metadata)` then preserves prior metadata for the
// `null` case and overwrites for the JSON-string case.
{
  // Mirror the exact expression used inside saveFeedback().
  const computeMetadataJson = (metadata: unknown): string | null =>
    metadata !== undefined
      ? JSON.stringify(redactFeedbackMetadataForStorage(metadata as never))
      : null;

  check(
    computeMetadataJson(undefined) === null,
    "(f) omitted metadata serializes to null (DB COALESCE preserves existing)",
  );

  const provided = computeMetadataJson(
    buildAiCallFeedbackMetadata({ promptVersion: "qms@deadbeef" }),
  );
  check(
    typeof provided === "string" &&
      provided !== null &&
      provided.includes("qms@deadbeef"),
    "(f) provided metadata serializes to a JSON string (DB COALESCE overwrites)",
  );

  const empty = computeMetadataJson(buildAiCallFeedbackMetadata({}));
  check(
    empty === "{}",
    "(f) empty-but-present metadata serializes to '{}' (caller intent: clear)",
  );
}

console.log(`\n  Passed: ${passed}   Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
