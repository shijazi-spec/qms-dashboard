/**
 * i18n guardrail (Task #125)
 * ----------------------------------------------------------------------------
 * Wraps `scripts/check-i18n.cjs` so it runs on every `npm test` invocation
 * (and therefore on every merge through `scripts/post-merge.sh`). The script
 * itself is the source of truth for the rules + allowlist; this file just
 * makes sure the integration-test runner picks it up.
 *
 * The guardrail blocks three classes of regression:
 *
 *   1. A new `dashboard/*.html` page that forgets to load `/js/i18n.js` or
 *      forgets to call `WalaPlusI18n.init().then(applyToDOM)`. Without that
 *      wiring, every `data-i18n` attribute on the page is silently ignored
 *      at runtime and the Arabic experience falls back to English.
 *
 *   2. A new `data-i18n="ns.key"` reference whose key is missing from
 *      `dashboard/i18n/en.json` or `dashboard/i18n/ar.json`. The runtime
 *      fallback prints the last segment of the key, which looks broken in
 *      Arabic and English alike.
 *
 *   3. A drift between `en.json` and `ar.json` key trees (orphans on either
 *      side, or a leaf turning into a sub-object on one side only).
 *
 * Run:  npx tsx tests/i18nCoverage.test.ts
 *       node scripts/check-i18n.cjs              # equivalent
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

const SCRIPT = path.resolve(
  new URL(".", import.meta.url).pathname,
  "..",
  "scripts",
  "check-i18n.cjs",
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

console.log("\n▶ i18n guardrail (scripts/check-i18n.cjs)\n");

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
    // Surface the script's diagnostics so the failure is actionable in CI logs.
    if (stdout.trim()) console.log(stdout.trimEnd());
    if (stderr.trim()) console.error(stderr.trimEnd());
  }
  assert(
    result.status === 0,
    "every dashboard/*.html page wires i18n, every data-i18n key resolves in en.json + ar.json, and the two trees are identical",
  );
}

console.log(`\n  Result: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
