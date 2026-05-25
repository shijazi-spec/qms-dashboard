/**
 * CSP guardrail — blocks new inline `style="..."` attributes from re-entering
 * `dashboard/` or `src/mastra/`.
 *
 * The platform CSP (see docs/Security_Operations_SOP.md §5.5 and the
 * `cspMiddleware` block in src/mastra/middleware/index.ts) sets:
 *
 *     style-src 'self' 'nonce-${cspNonce}' https://cdn.tailwindcss.com
 *               https://fonts.googleapis.com
 *
 * Browsers reject every `style="..."` attribute under this policy because
 * inline-attribute styles cannot carry a nonce. Without a guardrail, an
 * unrelated edit can silently re-introduce one and break a dashboard page
 * the next time a user loads it.
 *
 * This test wraps `scripts/check-no-inline-styles.sh` so it runs on every
 * `npm test` invocation (which is in turn the CI test command). The shell
 * script is the source of truth for the rule + allowlist; this file just
 * makes sure the integration-test runner picks it up.
 *
 * Run:  npx tsx tests/noInlineStyles.test.ts
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "scripts",
  "check-no-inline-styles.sh",
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

console.log("\n▶ Inline-style CSP guardrail (scripts/check-no-inline-styles.sh)\n");

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
    // Surface the script's diagnostics so the failure is actionable in CI logs.
    if (stdout.trim()) console.log(stdout.trimEnd());
    if (stderr.trim()) console.error(stderr.trimEnd());
  }
  assert(
    result.status === 0,
    "no forbidden inline `style=\"...\"` attributes in dashboard/ or src/mastra/",
  );
}

console.log(`\n  Result: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
