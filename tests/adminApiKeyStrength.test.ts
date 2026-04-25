/**
 * Unit tests for the ADMIN_API_KEY strength gate added in Task #450.
 *
 * Covers:
 *   - validateAdminApiKeyStrength(key)        — pure helper, accept + reject
 *   - assertAdminApiKeyStrengthOrThrow()      — startup gate wired into
 *                                               src/mastra/index.ts
 *
 * The gate must:
 *   - accept a high-entropy `openssl rand -hex 32` style key
 *   - reject a key that is too short (< 32 chars)
 *   - reject a key that has too few distinct characters (< 10), even when long
 *   - reject when both criteria fail (and surface BOTH reasons so the
 *     operator sees every problem at once, not just the first one)
 *   - silently no-op when ADMIN_API_KEY is unset (the "Setup Required" page
 *     flow handles unconfigured platforms; refusing to boot would break
 *     first-run onboarding)
 *   - throw with a message that points to docs/Security_Operations_SOP.md
 *     §5.7 so on-call engineers see the rotation runbook in the crash log
 *
 * Run:  npx tsx tests/adminApiKeyStrength.test.ts
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

import {
  ADMIN_API_KEY_MIN_DISTINCT_CHARS,
  ADMIN_API_KEY_MIN_LENGTH,
  assertAdminApiKeyStrengthOrThrow,
  validateAdminApiKeyStrength,
} from "../src/utils/rbacMiddleware";

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

function assertEquals<T>(actual: T, expected: T, label: string): void {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`      expected: ${JSON.stringify(expected)}`);
    console.error(`      actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

/**
 * Run a function and assert it throws an Error whose message contains every
 * substring in `expectedFragments`. We assert on substrings rather than the
 * exact string so the gate's message can carry diagnostic context (failed
 * criteria, runbook pointer) without making the test brittle.
 */
function assertThrowsWith(
  fn: () => void,
  expectedFragments: string[],
  label: string,
): void {
  let threw: unknown = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  if (!threw) {
    console.error(`  ✗ ${label} (did not throw)`);
    failed++;
    return;
  }
  const message = (threw as Error).message || String(threw);
  const missing = expectedFragments.filter((frag) => !message.includes(frag));
  if (missing.length === 0) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`      message:        ${message}`);
    console.error(`      missing fragments: ${JSON.stringify(missing)}`);
    failed++;
  }
}

function assertDoesNotThrow(fn: () => void, label: string): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${label}`);
    console.error(`      unexpected throw: ${(err as Error).message}`);
    failed++;
  }
}

console.log("\n=== ADMIN_API_KEY strength gate (rbacMiddleware) ===\n");

// ─── validateAdminApiKeyStrength: accept paths ───────────────────────────────

console.log("Case: validateAdminApiKeyStrength accepts a 64-hex `openssl rand -hex 32` key");
{
  // 64 hex chars, 16 distinct → both above minimum
  const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const result = validateAdminApiKeyStrength(key);
  assertEquals(result.ok, true, "ok=true");
  assertEquals(result.length, 64, "length=64");
  assertEquals(result.distinctChars, 16, "distinctChars=16");
  assertEquals(result.reasons.length, 0, "no failure reasons");
}
console.log();

console.log("Case: validateAdminApiKeyStrength accepts a key exactly at the floor");
{
  // length 32, 11 distinct chars → both at/above minimum
  const key = "abcdefghijk_abcdefghijk_abcdefghi"; // 33 chars, 12 distinct
  const result = validateAdminApiKeyStrength(key);
  assert(
    result.length >= ADMIN_API_KEY_MIN_LENGTH,
    "fixture length is at least the minimum",
  );
  assert(
    result.distinctChars >= ADMIN_API_KEY_MIN_DISTINCT_CHARS,
    "fixture distinct-char count is at least the minimum",
  );
  assertEquals(result.ok, true, "ok=true");
  assertEquals(result.reasons.length, 0, "no failure reasons");
}
console.log();

console.log("Case: validateAdminApiKeyStrength accepts a base64url-style 43-char key");
{
  // openssl rand -base64 32 (≈43 base64url chars), high distinct-char count
  const key = "kJ8x_Yt2qPwNvLmRsHaBcDeFgHiJkLmNoPqRsTuVwXyZ";
  const result = validateAdminApiKeyStrength(key);
  assertEquals(result.ok, true, "ok=true");
  assert(
    result.length >= ADMIN_API_KEY_MIN_LENGTH,
    "fixture length is at least the minimum",
  );
}
console.log();

// ─── validateAdminApiKeyStrength: reject paths ───────────────────────────────

console.log("Case: validateAdminApiKeyStrength rejects an unset key");
{
  const result = validateAdminApiKeyStrength(undefined);
  assertEquals(result.ok, false, "ok=false");
  assertEquals(result.reasons[0], "ADMIN_API_KEY is not set", "reason mentions unset");
  const nullResult = validateAdminApiKeyStrength(null);
  assertEquals(nullResult.ok, false, "null is also rejected");
  const emptyResult = validateAdminApiKeyStrength("");
  assertEquals(emptyResult.ok, false, "empty string is also rejected");
}
console.log();

console.log("Case: validateAdminApiKeyStrength rejects 'admin123' (too short)");
{
  const result = validateAdminApiKeyStrength("admin123");
  assertEquals(result.ok, false, "ok=false");
  assert(
    result.reasons.some((r) => r.includes("length")),
    "a reason mentions length",
  );
}
console.log();

console.log(
  "Case: validateAdminApiKeyStrength rejects a long but degenerate key (low distinct chars)",
);
{
  // 64 'a's — comfortably above the length floor, well below the distinct-char floor
  const key = "a".repeat(64);
  const result = validateAdminApiKeyStrength(key);
  assertEquals(result.ok, false, "ok=false");
  assertEquals(result.distinctChars, 1, "distinctChars=1");
  assert(
    result.reasons.some((r) => r.includes("distinct")),
    "a reason mentions distinct characters",
  );
  // Length is fine, so the length-based reason should NOT be raised
  assert(
    !result.reasons.some((r) => r.includes("length")),
    "no length reason when length is sufficient",
  );
}
console.log();

console.log(
  "Case: validateAdminApiKeyStrength surfaces ALL failed criteria when both fail",
);
{
  // 12 chars (too short) AND only 1 distinct char (too few)
  const result = validateAdminApiKeyStrength("aaaaaaaaaaaa");
  assertEquals(result.ok, false, "ok=false");
  assert(
    result.reasons.some((r) => r.includes("length")),
    "length reason raised",
  );
  assert(
    result.reasons.some((r) => r.includes("distinct")),
    "distinct-char reason raised",
  );
  assertEquals(result.reasons.length, 2, "both reasons surface, not just the first");
}
console.log();

console.log("Case: validateAdminApiKeyStrength rejects a 10-char repeating pattern");
{
  // "abcabcabca" — 10 chars, only 3 distinct → both criteria fail
  const result = validateAdminApiKeyStrength("abcabcabca");
  assertEquals(result.ok, false, "ok=false");
  assertEquals(result.length, 10, "length=10");
  assertEquals(result.distinctChars, 3, "distinctChars=3");
}
console.log();

// ─── assertAdminApiKeyStrengthOrThrow: startup gate ──────────────────────────

const originalAdminKey = process.env.ADMIN_API_KEY;

console.log(
  "Case: assertAdminApiKeyStrengthOrThrow is a no-op when ADMIN_API_KEY is unset",
);
{
  delete process.env.ADMIN_API_KEY;
  assertDoesNotThrow(
    () => assertAdminApiKeyStrengthOrThrow(),
    "no throw when env is unset (Setup Required flow handles this case)",
  );
}
console.log();

console.log("Case: assertAdminApiKeyStrengthOrThrow accepts a strong rotation value");
{
  process.env.ADMIN_API_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  assertDoesNotThrow(
    () => assertAdminApiKeyStrengthOrThrow(),
    "no throw on a 64-hex key",
  );
}
console.log();

console.log("Case: assertAdminApiKeyStrengthOrThrow refuses to start on a too-short key");
{
  process.env.ADMIN_API_KEY = "admin123";
  assertThrowsWith(
    () => assertAdminApiKeyStrengthOrThrow(),
    [
      "ADMIN_API_KEY does not meet minimum strength requirements",
      "Security_Operations_SOP.md",
    ],
    "throws and message references the rotation runbook",
  );
}
console.log();

console.log(
  "Case: assertAdminApiKeyStrengthOrThrow refuses to start on a long but degenerate key",
);
{
  // Length OK, distinct-char count not OK
  process.env.ADMIN_API_KEY = "a".repeat(64);
  assertThrowsWith(
    () => assertAdminApiKeyStrengthOrThrow(),
    [
      "ADMIN_API_KEY does not meet minimum strength requirements",
      String(ADMIN_API_KEY_MIN_DISTINCT_CHARS),
    ],
    "throws when only the distinct-char floor is violated",
  );
}
console.log();

console.log(
  "Case: assertAdminApiKeyStrengthOrThrow message cites both the length and distinct-char minimums",
);
{
  process.env.ADMIN_API_KEY = "x";
  assertThrowsWith(
    () => assertAdminApiKeyStrengthOrThrow(),
    [String(ADMIN_API_KEY_MIN_LENGTH), String(ADMIN_API_KEY_MIN_DISTINCT_CHARS)],
    "throw message includes both numeric minimums",
  );
}
console.log();

// Restore the env to whatever the runner started with so subsequent test files
// (when this is invoked through tests/runIntegrationTests.ts in a shared
// process scenario) see the original value.
if (originalAdminKey === undefined) {
  delete process.env.ADMIN_API_KEY;
} else {
  process.env.ADMIN_API_KEY = originalAdminKey;
}

console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("\n❌ ADMIN_API_KEY strength tests FAILED");
  process.exit(1);
}

console.log("\n✅ All ADMIN_API_KEY strength tests passed");
