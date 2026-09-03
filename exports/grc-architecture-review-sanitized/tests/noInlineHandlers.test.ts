/**
 * CSP guardrail — blocks new inline event-handler attributes (onclick=,
 * onsubmit=, onload=, onerror=, etc.) from re-entering `dashboard/` or
 * `src/mastra/`.
 *
 * The platform CSP (see docs/Security_Operations_SOP.md §5.5 and the
 * `cspMiddleware` block in src/mastra/middleware/index.ts) sets:
 *
 *     script-src 'self' 'nonce-${cspNonce}' <REDACTED_URL>
 *                <REDACTED_URL>
 *
 * Browsers block every inline event-handler attribute under this policy
 * because attribute-level handlers cannot carry a nonce. Without a guardrail,
 * an unrelated edit can silently re-introduce one and break interactivity the
 * next time a user loads the dashboard.
 *
 * This test wraps `scripts/check-no-inline-handlers.sh` so it runs on every
 * `npm test` invocation (which is in turn the CI test command). The shell
 * script is the source of truth for the rule + allowlist; this file just
 * makes sure the integration-test runner picks it up.
 *
 * Run:  npx tsx tests/noInlineHandlers.test.ts
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "scripts",
  "check-no-inline-handlers.sh",
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

console.log("\n▶ Inline event-handler CSP guardrail (scripts/check-no-inline-handlers.sh)\n");

const result = spawnSync("bash", [SCRIPT], {
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
    "no forbidden inline event-handler attributes in dashboard/ or src/mastra/",
  );
}

console.log(`\n  Result: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
