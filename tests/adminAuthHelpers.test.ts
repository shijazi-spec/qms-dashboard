/**
 * Unit tests for the shared admin-auth helpers in src/utils/rbacMiddleware.ts:
 *
 *   - getAdminKey(c)          — extracts the admin key from X-Admin-Key header
 *                               or admin_key cookie
 *   - hasValidAdminApiKey(c)  — true iff the extracted key matches
 *                               process.env.ADMIN_API_KEY
 *   - isAdminAuthorized(c)    — true iff the request has a valid admin key
 *                               OR a signed session cookie with role=admin
 *
 * These helpers back every admin-key authorization site across the codebase
 * (admin/qms/dashboard/static/health-pulse routes plus the global middleware),
 * so a regression here would silently weaken every admin endpoint at once.
 *
 * No live DB is required — `c` is mocked and `getSessionFromCookie` is exercised
 * via a locally-signed cookie using the same HMAC scheme as authRoutes.ts.
 *
 * Run:  npx tsx tests/adminAuthHelpers.test.ts
 */

const TEST_ADMIN_KEY = "test-admin-key-abc123";
const TEST_SESSION_SECRET = "test-session-secret-xyz789";

process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
process.env.SESSION_SECRET = TEST_SESSION_SECRET;
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import crypto from "crypto";
import {
  getAdminKey,
  hasValidAdminApiKey,
  isAdminAuthorized,
  requireAdminOrKey,
  requireRoleOrKey,
  requireAuthOrKey,
  getSessionUser,
} from "../src/utils/rbacMiddleware";

const SESSION_COOKIE_NAME = "walaplus_session";

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
 * Mirrors signSession() in src/mastra/routes/authRoutes.ts so the test can
 * mint a valid session cookie without going through OIDC.
 */
function signSession(payload: Record<string, any>): string {
  const secret = process.env.SESSION_SECRET!;
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

interface MockContextOptions {
  adminKeyHeader?: string;
  cookies?: Record<string, string>;
}

/**
 * Build a minimal Hono-like context object with just the `req.header(name)`
 * surface that the helpers under test consume.
 */
function makeContext(opts: MockContextOptions = {}): any {
  const headers: Record<string, string> = {};
  if (opts.adminKeyHeader !== undefined) {
    headers["X-Admin-Key"] = opts.adminKeyHeader;
  }
  if (opts.cookies && Object.keys(opts.cookies).length > 0) {
    headers["Cookie"] = Object.entries(opts.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  return {
    req: {
      header: (name: string): string | undefined => headers[name],
    },
  };
}

function adminSessionCookie(role: string = "admin"): string {
  const token = signSession({
    userId: 1,
    email: "admin@example.com",
    name: "Test Admin",
    role,
    exp: Date.now() + 60_000,
  });
  return encodeURIComponent(token);
}

console.log(
  "\n=== Admin-auth helper unit tests (rbacMiddleware) ===\n"
);

// ─── Case 1: header-only X-Admin-Key match ───
console.log("Case: X-Admin-Key header matches ADMIN_API_KEY");
{
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  const c = makeContext({ adminKeyHeader: TEST_ADMIN_KEY });
  assertEquals(getAdminKey(c), TEST_ADMIN_KEY, "getAdminKey returns the header value");
  assertEquals(hasValidAdminApiKey(c), true, "hasValidAdminApiKey is true");
  assertEquals(isAdminAuthorized(c), true, "isAdminAuthorized is true");
}
console.log();

// ─── Case 2: cookie-only admin_key match ───
console.log("Case: admin_key cookie matches ADMIN_API_KEY (no header)");
{
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  const c = makeContext({ cookies: { admin_key: TEST_ADMIN_KEY } });
  assertEquals(getAdminKey(c), TEST_ADMIN_KEY, "getAdminKey returns the cookie value");
  assertEquals(hasValidAdminApiKey(c), true, "hasValidAdminApiKey is true");
  assertEquals(isAdminAuthorized(c), true, "isAdminAuthorized is true");
}
console.log();

// ─── Case 2b: cookie alongside other cookies ───
console.log("Case: admin_key cookie surrounded by other cookies");
{
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  const c = makeContext({
    cookies: {
      foo: "bar",
      admin_key: TEST_ADMIN_KEY,
      baz: "qux",
    },
  });
  assertEquals(
    getAdminKey(c),
    TEST_ADMIN_KEY,
    "getAdminKey isolates admin_key from sibling cookies"
  );
  assertEquals(hasValidAdminApiKey(c), true, "hasValidAdminApiKey is true");
}
console.log();

// ─── Case 3: mismatched key → false ───
console.log("Case: header value present but does NOT match ADMIN_API_KEY");
{
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  const c = makeContext({ adminKeyHeader: "wrong-key" });
  assertEquals(getAdminKey(c), "wrong-key", "getAdminKey returns the (wrong) value");
  assertEquals(hasValidAdminApiKey(c), false, "hasValidAdminApiKey is false");
  assertEquals(
    isAdminAuthorized(c),
    false,
    "isAdminAuthorized is false (no session, bad key)"
  );
}
console.log();

console.log("Case: cookie value present but does NOT match ADMIN_API_KEY");
{
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  const c = makeContext({ cookies: { admin_key: "also-wrong" } });
  assertEquals(getAdminKey(c), "also-wrong", "getAdminKey returns the (wrong) cookie value");
  assertEquals(hasValidAdminApiKey(c), false, "hasValidAdminApiKey is false");
}
console.log();

// ─── Case 4: missing ADMIN_API_KEY env → always false ───
console.log("Case: ADMIN_API_KEY env is unset — every request is rejected");
{
  delete process.env.ADMIN_API_KEY;

  const cWithMatchingHeader = makeContext({ adminKeyHeader: TEST_ADMIN_KEY });
  assertEquals(
    hasValidAdminApiKey(cWithMatchingHeader),
    false,
    "hasValidAdminApiKey is false even when header carries a non-empty value"
  );

  const cWithMatchingCookie = makeContext({
    cookies: { admin_key: TEST_ADMIN_KEY },
  });
  assertEquals(
    hasValidAdminApiKey(cWithMatchingCookie),
    false,
    "hasValidAdminApiKey is false even when cookie carries a non-empty value"
  );

  const cEmpty = makeContext();
  assertEquals(hasValidAdminApiKey(cEmpty), false, "hasValidAdminApiKey is false on empty request");
  assertEquals(isAdminAuthorized(cEmpty), false, "isAdminAuthorized is false on empty request");

  // restore for subsequent cases
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
}
console.log();

// ─── Case 4b: empty-string ADMIN_API_KEY env → always false ───
console.log("Case: ADMIN_API_KEY env is empty string — every request is rejected");
{
  process.env.ADMIN_API_KEY = "";
  const c = makeContext({ adminKeyHeader: "" });
  assertEquals(
    hasValidAdminApiKey(c),
    false,
    "hasValidAdminApiKey is false (empty env must never auth, even matching empty header)"
  );
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
}
console.log();

// ─── Case 5: session-only admin (no key) ───
console.log("Case: signed admin session cookie, no admin key");
{
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  const c = makeContext({
    cookies: { [SESSION_COOKIE_NAME]: adminSessionCookie("admin") },
  });
  assertEquals(getAdminKey(c), null, "getAdminKey returns null (no key header/cookie)");
  assertEquals(
    hasValidAdminApiKey(c),
    false,
    "hasValidAdminApiKey is false (session is not an API key)"
  );
  assertEquals(
    isAdminAuthorized(c),
    true,
    "isAdminAuthorized is true (admin role from signed session)"
  );
}
console.log();

// ─── Case 6: non-admin session + no key → both false ───
console.log("Case: signed non-admin session cookie, no admin key");
{
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  const c = makeContext({
    cookies: {
      [SESSION_COOKIE_NAME]: adminSessionCookie("quality_manager"),
    },
  });
  assertEquals(getAdminKey(c), null, "getAdminKey returns null");
  assertEquals(hasValidAdminApiKey(c), false, "hasValidAdminApiKey is false");
  assertEquals(
    isAdminAuthorized(c),
    false,
    "isAdminAuthorized is false (session role is not admin)"
  );
}
console.log();

// ─── Case 6b: no session, no key → both false ───
console.log("Case: no session, no admin key");
{
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  const c = makeContext();
  assertEquals(getAdminKey(c), null, "getAdminKey returns null");
  assertEquals(hasValidAdminApiKey(c), false, "hasValidAdminApiKey is false");
  assertEquals(isAdminAuthorized(c), false, "isAdminAuthorized is false");
}
console.log();

// ─── Case 7: forged session cookie (bad signature) is ignored ───
console.log("Case: tampered session cookie with admin role is rejected");
{
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  const goodToken = signSession({
    userId: 1,
    email: "x@y.z",
    name: "x",
    role: "admin",
    exp: Date.now() + 60_000,
  });
  // Flip the signature: keep the data half, append a junk signature.
  const [data] = goodToken.split(".");
  const forged = `${data}.deadbeefnotavalidsignature`;
  const c = makeContext({
    cookies: { [SESSION_COOKIE_NAME]: encodeURIComponent(forged) },
  });
  assertEquals(
    isAdminAuthorized(c),
    false,
    "isAdminAuthorized is false on tampered session"
  );
}
console.log();

// ─── Case 8: admin key containing '=' characters in the cookie ───
console.log("Case: admin_key cookie value contains embedded '=' (base64-padded / token-style key)");
{
  const KEY_WITH_EQUALS = "abc=def=ghi";
  process.env.ADMIN_API_KEY = KEY_WITH_EQUALS;
  const c = makeContext({ cookies: { admin_key: KEY_WITH_EQUALS } });
  assertEquals(
    getAdminKey(c),
    KEY_WITH_EQUALS,
    "getAdminKey returns the full value including embedded '=' characters"
  );
  assertEquals(
    hasValidAdminApiKey(c),
    true,
    "hasValidAdminApiKey is true for a key with embedded '=' read from cookie"
  );
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
}
console.log();

// ─── Case 8b: admin key containing '=' characters alongside other cookies ───
console.log("Case: admin_key with '=' surrounded by sibling cookies");
{
  const KEY_WITH_EQUALS = "tok==padded==";
  process.env.ADMIN_API_KEY = KEY_WITH_EQUALS;
  const c = makeContext({
    cookies: {
      session: "somesessionvalue",
      admin_key: KEY_WITH_EQUALS,
      other: "value",
    },
  });
  assertEquals(
    getAdminKey(c),
    KEY_WITH_EQUALS,
    "getAdminKey isolates admin_key and preserves all '=' in the value"
  );
  assertEquals(
    hasValidAdminApiKey(c),
    true,
    "hasValidAdminApiKey is true despite multiple '=' in the cookie value"
  );
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
}
console.log();

// ─── Case 8c: percent-encoded admin_key cookie from strict HTTP clients ───
console.log("Case: admin_key cookie value is percent-encoded (strict HTTP client)");
{
  const KEY_WITH_EQUALS = "abc=def";
  process.env.ADMIN_API_KEY = KEY_WITH_EQUALS;
  // Some clients/browsers percent-encode reserved chars in cookie values.
  // 'abc%3Ddef' must round-trip to 'abc=def' so the key still matches.
  const c = makeContext({ cookies: { admin_key: "abc%3Ddef" } });
  assertEquals(
    getAdminKey(c),
    KEY_WITH_EQUALS,
    "getAdminKey decodes percent-encoded cookie values"
  );
  assertEquals(
    hasValidAdminApiKey(c),
    true,
    "hasValidAdminApiKey is true for a percent-encoded cookie that matches the stored key"
  );
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
}
console.log();

// ─── Case 8d: malformed percent sequence falls back to raw value ───
console.log("Case: admin_key cookie with malformed percent escape falls back to raw value");
{
  // '%E0%A4%A' is an incomplete UTF-8 sequence and will throw inside
  // decodeURIComponent. The helper should swallow the error and return
  // the raw cookie text rather than crashing the auth check.
  const RAW = "broken-%E0%A4%A";
  process.env.ADMIN_API_KEY = RAW;
  const c = makeContext({ cookies: { admin_key: RAW } });
  assertEquals(
    getAdminKey(c),
    RAW,
    "getAdminKey returns the raw value when decoding throws"
  );
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
}
console.log();

// ─── Case 9: header takes precedence over cookie when both present ───
console.log("Case: header wins over cookie when both supply an admin key");
{
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  const c = makeContext({
    adminKeyHeader: TEST_ADMIN_KEY,
    cookies: { admin_key: "ignored-cookie-value" },
  });
  assertEquals(
    getAdminKey(c),
    TEST_ADMIN_KEY,
    "getAdminKey prefers the X-Admin-Key header"
  );
  assertEquals(hasValidAdminApiKey(c), true, "hasValidAdminApiKey is true");
}
console.log();

// ─── getSessionUser: admin-key fallback ───────────────────────────────────────

console.log("Case: getSessionUser — X-Admin-Key present, no session → synthetic admin");
{
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  const c = makeContext({ adminKeyHeader: TEST_ADMIN_KEY });
  const user = getSessionUser(c);
  assert(user !== null, "getSessionUser returns a non-null user");
  assertEquals(user?.userId, 0, "synthetic user has userId 0");
  assertEquals(user?.role, "admin", "synthetic user has role admin");
  assertEquals(user?.email, "admin-key@system", "synthetic user has admin-key email");
}
console.log();

console.log("Case: getSessionUser — valid session cookie, no key → session user");
{
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  const c = makeContext({
    cookies: { [SESSION_COOKIE_NAME]: adminSessionCookie("quality_manager") },
  });
  const user = getSessionUser(c);
  assert(user !== null, "getSessionUser returns a non-null user");
  assertEquals(user?.role, "quality_manager", "role matches the session payload");
  assertEquals(user?.email, "admin@example.com", "email matches the session payload");
}
console.log();

console.log("Case: getSessionUser — no key, no session → null");
{
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  const c = makeContext();
  assertEquals(getSessionUser(c), null, "getSessionUser returns null");
}
console.log();

console.log("Case: getSessionUser — wrong key, no session → null");
{
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  const c = makeContext({ adminKeyHeader: "not-the-right-key" });
  assertEquals(getSessionUser(c), null, "getSessionUser returns null on key mismatch");
}
console.log();

// ─── requireAuthOrKey ─────────────────────────────────────────────────────────

console.log("Case: requireAuthOrKey — valid key → synthetic admin");
{
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  const c = makeContext({ adminKeyHeader: TEST_ADMIN_KEY });
  const user = requireAuthOrKey(c);
  assert(user !== null, "requireAuthOrKey returns a non-null user");
  assertEquals(user?.userId, 0, "synthetic user has userId 0");
  assertEquals(user?.role, "admin", "synthetic user has role admin");
}
console.log();

console.log("Case: requireAuthOrKey — no key, valid session → session user");
{
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  const c = makeContext({
    cookies: { [SESSION_COOKIE_NAME]: adminSessionCookie("grc_manager") },
  });
  const user = requireAuthOrKey(c);
  assert(user !== null, "requireAuthOrKey returns a non-null user");
  assertEquals(user?.role, "grc_manager", "role matches session payload");
}
console.log();

console.log("Case: requireAuthOrKey — no key, no session → null");
{
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  const c = makeContext();
  assertEquals(requireAuthOrKey(c), null, "requireAuthOrKey returns null");
}
console.log();

// ─── requireAdminOrKey and requireRoleOrKey (async, key-only short-circuit) ───

await (async () => {
  console.log("Case: requireAdminOrKey — valid key → synthetic admin");
  {
    process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
    const c = makeContext({ adminKeyHeader: TEST_ADMIN_KEY });
    const user = await requireAdminOrKey(c);
    assert(user !== null, "requireAdminOrKey returns a non-null user");
    assertEquals(user?.userId, 0, "synthetic user has userId 0");
    assertEquals(user?.role, "admin", "synthetic user has role admin");
    assertEquals(user?.email, "api-key@system", "synthetic user has api-key email");
  }
  console.log();

  console.log("Case: requireAdminOrKey — no key, no session → null (no DB hit)");
  {
    process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
    const c = makeContext();
    const user = await requireAdminOrKey(c);
    assertEquals(user, null, "requireAdminOrKey returns null");
  }
  console.log();

  console.log("Case: requireRoleOrKey — valid key → synthetic admin, ignores allowedRoles");
  {
    process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
    const c = makeContext({ adminKeyHeader: TEST_ADMIN_KEY });
    const user = await requireRoleOrKey(c, ["quality_manager"]);
    assert(user !== null, "requireRoleOrKey returns a non-null user");
    assertEquals(user?.role, "admin", "synthetic user has role admin");
    assertEquals(user?.userId, 0, "synthetic user has userId 0");
  }
  console.log();

  console.log("Case: requireRoleOrKey — valid key wins even when role not in allowedRoles list");
  {
    process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
    const c = makeContext({ adminKeyHeader: TEST_ADMIN_KEY });
    const user = await requireRoleOrKey(c, ["department_viewer"]);
    assert(user !== null, "requireRoleOrKey returns a non-null user with empty-ish roles list");
    assertEquals(user?.role, "admin", "synthetic user still has admin role");
  }
  console.log();

  console.log("Case: requireRoleOrKey — no key, no session → null (no DB hit)");
  {
    process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
    const c = makeContext();
    const user = await requireRoleOrKey(c, ["admin"]);
    assertEquals(user, null, "requireRoleOrKey returns null");
  }
  console.log();
})();

console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("\n❌ Admin-auth helper tests FAILED");
  process.exit(1);
}

console.log("\n✅ All admin-auth helper tests passed");
