/**
 * Auth cookie security-flag guardrail (walaplus_session + oauth_data)
 *
 * Sibling to `tests/adminCookieFlags.test.ts`. The admin wrapper enforces the
 * strict admin_key policy (HttpOnly + Secure + SameSite=Strict, all
 * unconditional). This wrapper enforces the documented policy for the two
 * OIDC-flow auth cookies — walaplus_session and oauth_data — that are
 * allowed to omit the literal `Secure` token only via the documented
 * `${secure ? "; Secure" : ""}` ternary derived from `isSecureDomain()`.
 *
 * The cookie-by-cookie invariants live in `docs/Security_Operations_SOP.md`
 * § 5.7 ("Auth Cookie Inventory") and the matching shell script
 * `scripts/check-auth-cookie-flags.sh`. This file only wires the script into
 * `tests/runIntegrationTests.ts` so every PR runs it.
 *
 * Run:  npx tsx tests/authCookieFlags.test.ts
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

const SCRIPT = path.resolve(
  new URL(".", import.meta.url).pathname,
  "..",
  "scripts",
  "check-auth-cookie-flags.sh",
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
  "\n▶ auth cookie security-flag guardrail (scripts/check-auth-cookie-flags.sh)\n",
);

const result = spawnSync("bash", [SCRIPT], {
  stdio: "pipe",
  encoding: "utf8",
});

if (result.error) {
  console.error(
    `  ✗ Failed to execute guardrail script: ${result.error.message}`,
  );
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
    "every walaplus_session and oauth_data Set-Cookie header in src/mastra/routes/ carries HttpOnly, Secure, SameSite=Lax, Path=/",
  );
}

console.log(`\n  Result: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
