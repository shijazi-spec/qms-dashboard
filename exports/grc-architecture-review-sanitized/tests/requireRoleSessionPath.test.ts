/**
 * Unit tests for the *session-path* of `requireRole` in
 * src/utils/rbacMiddleware.ts.
 *
 * Task #96 already covered the admin-key short-circuit branches of
 * `requireAdminOrKey`, `requireRoleOrKey`, and `requireAuthOrKey` in
 * adminAuthHelpers.test.ts. This file fills the remaining gap: when the
 * caller has *no* admin key and is authenticated by a session cookie,
 * `requireRole` consults `getPlatformUser(email)` to:
 *
 *   1. confirm the platform record is `status = 'active'`, AND
 *   2. re-read the live role from the DB (the cookie role is *not*
 *      trusted — a role demotion in the DB must take effect on the next
 *      request).
 *
 * A regression here would let inactive users or role-demoted users still
 * reach restricted routes via a stale-but-cryptographically-valid session
 * cookie. That's a silent-permission failure mode, exactly the kind this
 * test exists to prevent.
 *
 * The four branches covered:
 *
 *   A. active user whose live DB role is in `allowedRoles`            → user
 *   B. user whose live DB status is NOT 'active'                      → null
 *   C. active user whose live DB role is NOT in `allowedRoles`        → null
 *   D. `getPlatformUser` returns null (no platform record at all)     → null
 *
 * The test runs **without a live DB**: `pg.Pool` is monkey-patched
 * before `rbacMiddleware` is loaded so the module-level
 * `new Pool({ connectionString: ... })` constructs a stub whose
 * `query()` returns whatever this test sets via `setPlatformRow()`.
 *
 * Run:  npx tsx tests/requireRoleSessionPath.test.ts
 */

const TEST_ADMIN_KEY = "test-admin-key-rrole";
const TEST_SESSION_SECRET = "test-session-secret-rrole";

process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
process.env.SESSION_SECRET = TEST_SESSION_SECRET;
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

// ---------------------------------------------------------------------------
// 1. Patch pg.Pool BEFORE importing rbacMiddleware so the module-level
//    `new Pool(...)` constructs our stub instead of opening a real socket.
// ---------------------------------------------------------------------------
import pg from "pg";
import crypto from "crypto";

type StubRow = { status: string; role: string };

interface StubBehavior {
  // The next query() call resolves with these rows. Reset after every test.
  rows: StubRow[];
  // If true, the next query() rejects with an error (used for the catch-path).
  shouldThrow: boolean;
  // Tracks how many times query() has been invoked since the last reset.
  callCount: number;
  // Captures the [sql, params] of every query() call for assertions.
  lastCall: { sql: string; params: unknown[] } | null;
}

const stub: StubBehavior = {
  rows: [],
  shouldThrow: false,
  callCount: 0,
  lastCall: null,
};

class StubPool {
  // Match the pg.Pool surface we actually use (just `query`).
  async query(sql: string, params: unknown[] = []): Promise<{ rows: StubRow[] }> {
    stub.callCount++;
    stub.lastCall = { sql, params };
    if (stub.shouldThrow) {
      throw new Error("stub pool: simulated DB failure");
    }
    return { rows: stub.rows };
  }
  async end(): Promise<void> {}
  on(): this {
    return this;
  }
  // Required by `wrapPoolForRedaction` which binds `pool.connect` even when
  // the test never actually checks out a transactional client.
  async connect(): Promise<{
    query: (sql: string, params?: unknown[]) => Promise<{ rows: StubRow[] }>;
    release: () => void;
  }> {
    return {
      query: (sql, params) => this.query(sql, (params ?? []) as unknown[]),
      release: () => undefined,
    };
  }
}

(pg as any).Pool = StubPool;
if ((pg as any).default) {
  (pg as any).default.Pool = StubPool;
}

// ---------------------------------------------------------------------------
// 2. Now load rbacMiddleware. Its `new Pool(...)` will instantiate StubPool.
// ---------------------------------------------------------------------------
const {
  requireRole,
  invalidatePlatformUserCache,
  getPlatformUser,
} = await import("../src/utils/rbacMiddleware");

const SESSION_COOKIE_NAME = "walaplus_session";

// ---------------------------------------------------------------------------
// Tiny test harness (mirrors the style in adminAuthHelpers.test.ts so the
// CI gate output stays consistent across the rbacMiddleware test suite).
// ---------------------------------------------------------------------------
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

// Mirrors signSession() in src/mastra/routes/authRoutes.ts.
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

function sessionCookieFor(email: string, role: string): string {
  const token = signSession({
    userId: 42,
    email,
    name: "Test User",
    role,
    exp: Date.now() + 60_000,
  });
  return encodeURIComponent(token);
}

/**
 * Configure what the next `getPlatformUser(email)` DB read returns and clear
 * the module-private platform-status cache so the stub is *actually* hit.
 */
function setPlatformRow(email: string, row: StubRow | null): void {
  invalidatePlatformUserCache(email);
  stub.rows = row ? [row] : [];
  stub.shouldThrow = false;
  stub.callCount = 0;
  stub.lastCall = null;
}

console.log(
  "\n=== requireRole session-path unit tests (rbacMiddleware) ===\n"
);

// Sanity: the stub must actually be in front of the platform pool. If
// `getPlatformUser` doesn't hit our stub, every subsequent assertion is
// meaningless (we'd be silently exercising a real DB or the cache).
console.log("Sanity: stub Pool is wired into getPlatformUser");
{
  setPlatformRow("user@example.invalid", { status: "active", role: "admin" });
  const result = await getPlatformUser("user@example.invalid");
  assert(result !== null, "getPlatformUser returned a row from the stub");
  assertEquals(result?.status, "active", "stub status flowed through");
  assertEquals(result?.role, "admin", "stub role flowed through");
  assertEquals(stub.callCount, 1, "stub Pool.query was invoked exactly once");
  assert(
    !!stub.lastCall && /platform_users/i.test(stub.lastCall.sql),
    "query targeted platform_users"
  );
}
console.log();

// ─── Branch A: active user, role allowed → user is returned ───
console.log(
  "Case: active platform user with role in allowedRoles → user returned"
);
{
  const email = "user@example.invalid";
  // Cookie role is intentionally a *different* allowed role to prove that
  // the live DB role overwrites the cookie role on the returned object.
  setPlatformRow(email, { status: "active", role: "quality_manager" });
  const c = makeContext({
    cookies: { [SESSION_COOKIE_NAME]: sessionCookieFor(email, "grc_manager") },
  });
  const user = await requireRole(c, ["quality_manager", "grc_manager"]);
  assert(user !== null, "requireRole returned a non-null user");
  assertEquals(user?.email, email, "email matches the session payload");
  assertEquals(
    user?.role,
    "quality_manager",
    "role on returned user is the live DB role, not the cookie role"
  );
}
console.log();

// ─── Branch B: status !== 'active' → null ───
console.log(
  "Case: platform record exists but status != 'active' → null (silent inactive-user block)"
);
{
  const email = "user@example.invalid";
  // Even though the cookie says 'admin' and the DB role would be allowed,
  // an inactive status MUST short-circuit to null.
  setPlatformRow(email, { status: "disabled", role: "admin" });
  const c = makeContext({
    cookies: { [SESSION_COOKIE_NAME]: sessionCookieFor(email, "admin") },
  });
  const user = await requireRole(c, ["admin"]);
  assertEquals(user, null, "requireRole returned null for inactive user");
}
console.log();

// Also cover other non-'active' status strings to lock in the strict equality.
console.log(
  "Case: platform record with status 'pending' is also rejected (strict equality on 'active')"
);
{
  const email = "user@example.invalid";
  setPlatformRow(email, { status: "pending", role: "admin" });
  const c = makeContext({
    cookies: { [SESSION_COOKIE_NAME]: sessionCookieFor(email, "admin") },
  });
  const user = await requireRole(c, ["admin"]);
  assertEquals(user, null, "requireRole returned null for pending user");
}
console.log();

// ─── Branch C: active user but role not in allowedRoles → null ───
console.log(
  "Case: active platform user but live DB role NOT in allowedRoles → null (role-demotion guard)"
);
{
  const email = "user@example.invalid";
  // Cookie role is 'admin' (would pass cookie-only check), but DB has
  // demoted them to 'department_viewer'. The live role must win.
  setPlatformRow(email, { status: "active", role: "department_viewer" });
  const c = makeContext({
    cookies: { [SESSION_COOKIE_NAME]: sessionCookieFor(email, "admin") },
  });
  const user = await requireRole(c, ["admin", "quality_manager"]);
  assertEquals(
    user,
    null,
    "requireRole returned null because live role is not in allowedRoles"
  );
}
console.log();

// ─── Branch D: getPlatformUser returns null (no record) → null ───
console.log(
  "Case: no platform record for the session user → null (orphaned-session guard)"
);
{
  const email = "user@example.invalid";
  setPlatformRow(email, null); // stub returns rows: []
  const c = makeContext({
    cookies: { [SESSION_COOKIE_NAME]: sessionCookieFor(email, "admin") },
  });
  const user = await requireRole(c, ["admin"]);
  assertEquals(
    user,
    null,
    "requireRole returned null when getPlatformUser had no row"
  );
}
console.log();

// ─── Branch D': DB throws → getPlatformUser returns null → requireRole null ───
console.log(
  "Case: getPlatformUser DB query throws → treated as no-record → null"
);
{
  const email = "user@example.invalid";
  setPlatformRow(email, null);
  stub.shouldThrow = true;
  const c = makeContext({
    cookies: { [SESSION_COOKIE_NAME]: sessionCookieFor(email, "admin") },
  });
  const user = await requireRole(c, ["admin"]);
  assertEquals(
    user,
    null,
    "requireRole returned null when the platform-user DB query failed"
  );
  stub.shouldThrow = false;
}
console.log();

// ─── Defence-in-depth: no session at all → null without any DB hit ───
console.log(
  "Case: no session cookie and no admin key → null (no DB lookup attempted)"
);
{
  setPlatformRow("user@example.invalid", { status: "active", role: "admin" });
  // Reset call count after the warm-up read above.
  stub.callCount = 0;
  const c = makeContext();
  const user = await requireRole(c, ["admin"]);
  assertEquals(user, null, "requireRole returned null with no session");
  assertEquals(
    stub.callCount,
    0,
    "no platform_users query was issued (cheap reject before DB)"
  );
}
console.log();

// ─── Admin-key path: key-only callers are rejected by requireRole ───
// The X-Admin-Key header is scoped to /api/admin/* routes and handlers that
// explicitly call requireAdminOrKey(). requireRole() delegates to
// getSessionUser(), which no longer synthesises a session from the key, so
// key-only callers receive null without any DB lookup.
console.log(
  "Case: X-Admin-Key alone → requireRole returns null (no session, no DB query)"
);
{
  setPlatformRow("user@example.invalid", { status: "active", role: "admin" });
  stub.callCount = 0;
  const c = makeContext({ adminKeyHeader: TEST_ADMIN_KEY });
  const user = await requireRole(c, ["admin"]);
  assertEquals(user, null, "requireRole returns null for key-only callers");
  assertEquals(
    stub.callCount,
    0,
    "platform_users was not queried (cheap reject via getSessionUser() returning null)"
  );
}
console.log();

console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("\n❌ requireRole session-path tests FAILED");
  process.exit(1);
}

console.log("\n✅ All requireRole session-path tests passed");
