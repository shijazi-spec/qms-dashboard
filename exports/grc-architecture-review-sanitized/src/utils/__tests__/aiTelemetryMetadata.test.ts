/**
 * CI gate: prevents new agent / workflow code from feeding free-form
 * dynamic strings (typically from `catch (err)` / raw HTTP headers / tool
 * output) into `ai_call_metrics.metadata`. Pairs with Task #479's WRITE-path
 * scrubber `redactMetadataForStorage()` — the scrubber catches the leak one
 * layer too late (AFTER the secret has been constructed in memory and
 * typically logged via console.error / Pino), this typed helper prevents
 * the pattern at the source.
 *
 * Run:    npx tsx src/utils/__tests__/aiTelemetryMetadata.test.ts
 *
 * Verifies:
 *   (a) buildAiCallTelemetryMetadata maps every camelCase allow-list input
 *       to its snake_case output (the shape persisted in the JSONB column
 *       and queried via `metadata->>'prompt_version'`)
 *   (b) Omitted inputs do not appear in the output (no `undefined` leaves
 *       that would surface as `null` rows in the JSONB column)
 *   (c) The closed `AiCallTelemetryMetadataInput` interface rejects
 *       free-form keys at compile time — verified by the `// @ts-expect-error`
 *       directive which the npm `check` (tsc) gate enforces in CI
 *   (d) Defense-in-depth: even if a caller bypasses the type system via
 *       `as any`, unexpected keys are dropped AND a `console.warn` with
 *       an actionable message is emitted
 *   (e) The WRITE-path scrubber `redactMetadataForStorage()` still scrubs
 *       credential-shaped substrings from typed values (so a future allowed
 *       field can never persist a leaked secret in plaintext either)
 *   (f) Task #511 — the BuiltAiCallTelemetryMetadata brand on the three
 *       telemetry entry points (withAiTelemetry / startTelemetrySpan /
 *       recordStreamTelemetry) makes inline `metadata: { ... }` literals
 *       fail TypeScript so the streaming path inherits the same
 *       source-side enforcement the non-streaming callers got in #484.
 *       Verified via `// @ts-expect-error` directives that the npm `check`
 *       (tsc) gate enforces in CI.
 */

import { strict as assert } from "node:assert";
import {
  buildAiCallTelemetryMetadata,
  redactMetadataForStorage,
  type WithAiTelemetryParams,
  type RecordStreamTelemetryParams,
  type BuiltAiCallTelemetryMetadata,
} from "../aiTelemetry";

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
  const result = buildAiCallTelemetryMetadata({
    promptVersion: "<REDACTED_EMAIL>",
    featureFlag: "new-prompt-A",
    experimentArm: "control",
    agentTemperature: 0.7,
    workflow: "qualityAuditWorkflow",
    step: "sdr-audit",
    scanType: "platform_scan",
    clientSurface: "ChatProvider",
  });
  assert.deepStrictEqual(result, {
    prompt_version: "<REDACTED_EMAIL>",
    feature_flag: "new-prompt-A",
    experiment_arm: "control",
    agent_temperature: 0.7,
    workflow: "qualityAuditWorkflow",
    step: "sdr-audit",
    scan_type: "platform_scan",
    client_surface: "ChatProvider",
  });
  check(true, "(a) all allow-list keys round-trip camelCase → snake_case");
}

// (b) omitted inputs do not appear in the output
{
  const result = buildAiCallTelemetryMetadata({
    promptVersion: "<REDACTED_EMAIL>",
  });
  assert.deepStrictEqual(result, { prompt_version: "<REDACTED_EMAIL>" });
  check(
    !("feature_flag" in result) && !("workflow" in result),
    "(b) omitted inputs are absent (no undefined leaves)",
  );
}

// (b.1) explicit `undefined` is treated as omitted (not written as `null`)
{
  const result = buildAiCallTelemetryMetadata({
    promptVersion: "<REDACTED_EMAIL>",
    workflow: undefined,
    step: undefined,
  });
  assert.deepStrictEqual(result, { prompt_version: "<REDACTED_EMAIL>" });
  check(true, "(b.1) explicit `undefined` inputs are skipped");
}

// (c) closed interface — `note` triggers a TypeScript compile error
{
  buildAiCallTelemetryMetadata({
    promptVersion: "<REDACTED_EMAIL>",
    // @ts-expect-error — `note` is NOT in the AiCallTelemetryMetadataInput
    // allow-list. The npm `check` (tsc) gate enforces this at CI time so a
    // developer cannot land `{ note: caughtError.message, debug: rawHeaders }`
    // pulled from a `catch` block — which would land plaintext credentials
    // in ai_call_metrics.metadata BEFORE the WRITE-path scrubber runs.
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
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const result = buildAiCallTelemetryMetadata({
      promptVersion: "<REDACTED_EMAIL>",
      // Simulate a caller that bypassed the type-system the way an `as any`
      // cast or an untyped JS shim would.
      ...({
        note: "<REDACTED_TOKEN>",
        debug: "raw-headers",
      } as Record<string, string>),
    } as Parameters<typeof buildAiCallTelemetryMetadata>[0]);

    assert.deepStrictEqual(result, { prompt_version: "<REDACTED_EMAIL>" });
    check(
      warnings.some((w) => w.includes('unexpected key "note"')),
      '(d) unexpected key "note" emits actionable console.warn',
    );
    check(
      warnings.some((w) => w.includes('unexpected key "debug"')),
      '(d) unexpected key "debug" emits actionable console.warn',
    );
    check(
      !("note" in result) && !("debug" in result),
      "(d) unexpected keys are dropped from the output",
    );
  } finally {
    console.warn = originalWarn;
  }
}

// (e) WRITE-path scrubber still masks credential-shaped substrings —
// belt-and-braces in case a future allowed field carries a leaked value.
{
  const scrubbed = redactMetadataForStorage(
    buildAiCallTelemetryMetadata({
      // Stuff a <REDACTED_TOKEN> token into `feature_flag` — the helper allows
      // it (the field is a free-form string), but the WRITE-path scrubber
      // must still mask it before the row is INSERT-ed.
      featureFlag: "<REDACTED_TOKEN>",
      promptVersion: "<REDACTED_EMAIL>",
    }),
  );
  const serialized = JSON.stringify(scrubbed);
  check(
    !serialized.includes("<REDACTED_TOKEN>"),
    "(e) redactMetadataForStorage still scrubs sk-live tokens (defense-in-depth)",
  );
  check(
    serialized.includes("<REDACTED_EMAIL>"),
    "(e) non-secret values pass through untouched",
  );
}

// (f) brand contract — the three telemetry entry points only accept
// `BuiltAiCallTelemetryMetadata`. An inline literal stops type-checking,
// even when its keys all happen to be inside the allow-list — closing the
// streaming-callers gap Task #511 was filed for. We don't import
// startTelemetrySpan / recordStreamTelemetry directly (they would open a
// pg.Pool() at module-load time); WithAiTelemetryParams is the shared
// shape behind withAiTelemetry() and startTelemetrySpan(), and
// RecordStreamTelemetryParams is the named export for the streaming
// caller — Task #582 added it specifically so this test could lock the
// streaming brand contract DIRECTLY rather than only by inheritance.
{
  const built: BuiltAiCallTelemetryMetadata = buildAiCallTelemetryMetadata({
    promptVersion: "<REDACTED_EMAIL>",
  });
  // Branded value passes — the recommended call shape.
  const okParams: WithAiTelemetryParams = {
    agentName: "qms",
    model: "gpt-4o",
    metadata: built,
  };
  check(
    okParams.metadata === built,
    "(f) buildAiCallTelemetryMetadata() output is accepted at telemetry entry points",
  );

  // Inline literal — even one whose keys are ALL inside the allow-list —
  // is rejected. This is the line a future streaming caller would have
  // written without the brand: `metadata: { prompt_version: ver, ...debugDump }`.
  const _rejectedInlineLiteral: WithAiTelemetryParams = {
    agentName: "qms",
    model: "gpt-4o",
    // @ts-expect-error — the BuiltAiCallTelemetryMetadata brand requires
    // the value to come from buildAiCallTelemetryMetadata(). An inline
    // `{ ... }` literal is missing the phantom brand field, so this stops
    // type-checking entirely. The npm `check` (tsc) gate enforces this
    // in CI for every PR.
    metadata: { prompt_version: "<REDACTED_EMAIL>" },
  };
  void _rejectedInlineLiteral;
  check(
    true,
    "(f) inline `metadata: { prompt_version: ... }` literal triggers a TypeScript compile error (// @ts-expect-error)",
  );

  // The leak-shaped pattern the brand is specifically designed to block —
  // spreading a `catch (err)` payload into the metadata literal so the
  // free-form keys passed alongside `prompt_version` would land plaintext
  // credentials in the JSONB column.
  const _leakShapedSpread: WithAiTelemetryParams = {
    agentName: "qms",
    model: "gpt-4o",
    // @ts-expect-error — the brand also blocks the spread-from-catch
    // pattern even though `prompt_version` itself is allow-listed; an
    // inline literal cannot satisfy the brand regardless of its keys.
    metadata: { prompt_version: "<REDACTED_EMAIL>", note: "<REDACTED_TOKEN>" },
  };
  void _leakShapedSpread;
  check(
    true,
    "(f) spread-from-catch literal `{ prompt_version, ...debugDump }` is rejected at compile time",
  );

  // Streaming entry point — Task #582 closes the last verification gap.
  // Before this block, the brand on `recordStreamTelemetry` was only
  // proven INDIRECTLY (its inline params shape used the same brand, so
  // the WithAiTelemetryParams test "covered" it by inheritance). If a
  // future refactor accidentally widened the streaming `metadata` field
  // back to `AiCallTelemetryMetadata` — or replaced the brand with the
  // bare allow-list — the WithAiTelemetryParams checks above would still
  // pass. Holding the named `RecordStreamTelemetryParams` shape to its
  // own `// @ts-expect-error` directive locks the streaming contract
  // directly so tsc fails the npm `check` gate on any such regression.
  const okStreamingParams: RecordStreamTelemetryParams = {
    agentName: "qms",
    model: "gpt-4o",
    startedAt: Date.now(),
    stream: null,
    success: true,
    metadata: built,
  };
  check(
    okStreamingParams.metadata === built,
    "(f) buildAiCallTelemetryMetadata() output is accepted at the streaming entry point",
  );

  const _rejectedStreamingInlineLiteral: RecordStreamTelemetryParams = {
    agentName: "qms",
    model: "gpt-4o",
    startedAt: Date.now(),
    stream: null,
    success: true,
    // @ts-expect-error — the BuiltAiCallTelemetryMetadata brand requires
    // the value to come from buildAiCallTelemetryMetadata(). An inline
    // `{ ... }` literal at the streaming entry point is missing the
    // phantom brand field, so this stops type-checking entirely. The
    // npm `check` (tsc) gate enforces this in CI for every PR.
    metadata: { prompt_version: "<REDACTED_EMAIL>" },
  };
  void _rejectedStreamingInlineLiteral;
  check(
    true,
    "(f) inline `metadata` literal at the streaming entry point triggers a TypeScript compile error (// @ts-expect-error)",
  );

  const _streamingLeakShapedSpread: RecordStreamTelemetryParams = {
    agentName: "qms",
    model: "gpt-4o",
    startedAt: Date.now(),
    stream: null,
    success: true,
    // @ts-expect-error — the brand also blocks the spread-from-catch
    // pattern at the streaming entry point even though `prompt_version`
    // itself is allow-listed; an inline literal cannot satisfy the
    // brand regardless of its keys. This is the line a future streaming
    // caller would have written without the brand:
    // `metadata: { prompt_version: ver, ...debugDump }`.
    metadata: { prompt_version: "<REDACTED_EMAIL>", note: "<REDACTED_TOKEN>" },
  };
  void _streamingLeakShapedSpread;
  check(
    true,
    "(f) streaming spread-from-catch literal `{ prompt_version, ...debugDump }` is rejected at compile time",
  );
}

console.log(`\n  Passed: ${passed}   Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
