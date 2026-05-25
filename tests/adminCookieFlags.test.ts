/**
 * admin_key cookie security-flag guardrail
 *
 * The admin_key cookie was silently missing SameSite=Strict for a period of
 * time, caught only by manual review. This test wraps
 * `scripts/check-admin-cookie-flags.sh` so every CI run on every PR fails
 * the moment any future Set-Cookie header on /api/admin/auth (login) or on
 * the logout routes that clear admin_key drops one of:
 *
 *   * HttpOnly        — blocks JavaScript access (defends against XSS).
 *   * Secure          — forces HTTPS-only transmission.
 *   * SameSite=Strict — blocks cross-site request forgery (CSRF).
 *
 * The shell script is the source of truth for the rule and the resolution
 * logic for `${...Flags}` template-literal interpolations; this file just
 * makes sure the integration-test runner (`tests/runIntegrationTests.ts`)
 * picks it up automatically via the `*.test.ts` discovery pattern.
 *
 * Pairs with the deeper integration assertions in
 * `tests/adminApiRoutes.test.ts` and `tests/authRoutes.test.ts`, which
 * exercise the live handlers and assert all three flags appear on the
 * actual `Set-Cookie` response header — so a regression is caught both
 * statically (this test) and at runtime (those tests).
 *
 * Run:  npx tsx tests/adminCookieFlags.test.ts
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "scripts",
  "check-admin-cookie-flags.sh",
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
  "\n▶ admin_key cookie security-flag guardrail (scripts/check-admin-cookie-flags.sh)\n",
);

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
  } else if (stdout.trim()) {
    console.log(`  ${stdout.trim()}`);
  }
  assert(
    result.status === 0,
    "every admin_key Set-Cookie header in src/mastra/routes/ carries HttpOnly, Secure, SameSite=Strict",
  );
}

console.log(`\n  Result: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
