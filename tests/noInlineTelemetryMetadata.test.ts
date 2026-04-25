/**
 * AI-telemetry metadata guardrail (Task #511).
 *
 * Wraps `scripts/check-no-inline-telemetry-metadata.cjs` so it runs on every
 * `npm test` invocation (which is in turn the CI test command). The brand
 * type `BuiltAiCallTelemetryMetadata` (see src/utils/aiTelemetry.ts) makes
 * inline `metadata: { ... }` literals fail TypeScript at the three telemetry
 * entry points already; this defence-in-depth scanner catches the case where
 * a caller bypasses the type system via `as any` / `as unknown as ...` or via
 * an untyped JS shim — exactly the leak path the task brief calls out for the
 * streaming code-path that has not yet been wired up.
 *
 * Run:  npx tsx tests/noInlineTelemetryMetadata.test.ts
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

const SCRIPT = path.resolve(
  new URL(".", import.meta.url).pathname,
  "..",
  "scripts",
  "check-no-inline-telemetry-metadata.cjs",
);

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

console.log(
  "\n▶ AI-telemetry metadata guardrail (scripts/check-no-inline-telemetry-metadata.cjs)\n",
);

const result = spawnSync("node", [SCRIPT], {
  stdio: "pipe",
  encoding: "utf8",
});

if (result.error) {
  console.error(`  ✗ Failed to execute guardrail script: ${result.error.message}`);
  failed++;
} else {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    if (stdout.trim()) console.log(stdout.trimEnd());
    if (stderr.trim()) console.error(stderr.trimEnd());
  }
  assert(
    result.status === 0,
    "no inline `metadata: { ... }` literals at withAiTelemetry / startTelemetrySpan / recordStreamTelemetry call sites",
  );
}

console.log(`\n  Result: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
