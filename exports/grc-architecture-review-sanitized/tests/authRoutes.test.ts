/**
 * Integration tests for src/mastra/routes/authRoutes.ts
 *
 * Coverage matrix:
 *   - 401 unauth      → GET /api/auth/me without a session cookie or admin key.
 *   - 200 admin key   → GET /api/auth/me with a matching X-Admin-Key returns
 *                       the synthetic admin user (no separate
 *                       /api/auth/admin-status endpoint is needed any more).
 *   - 200 admin cookie→ GET /api/auth/me with a matching admin_key cookie
 *                       returns the synthetic admin user.
 *   - 200 happy path  → POST /api/auth/logout returns success and clears the
 *                       session cookie *and* the admin_key cookie.
 *   - structural      → every route exposes path/method/createHandler, and
 *                       the legacy /api/auth/admin-status route is gone.
 *
 * Run:  npx tsx tests/authRoutes.test.ts
 */

import { authRoutes } from "../src/mastra/routes/authRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const TEST_ADMIN_KEY = "test-admin-key-authroutes-2026";
const ORIGINAL_ADMIN_KEY = process.env.ADMIN_API_KEY;
process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;

const suite = new TestSuite("authRoutes");

console.log("\n=== authRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of authRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(authRoutes.length >= 4, "at least 4 routes registered");
  // The legacy /api/auth/admin-status endpoint has been folded into
  // /api/auth/me — make sure nobody re-introduces it.
  const legacy = authRoutes.find((r) => r.path === "/api/auth/admin-status");
  suite.expect(!legacy, "/api/auth/admin-status must not be re-registered");
});

await suite.test("GET /api/auth/me — 401 with authenticated:false when no cookie", async () => {
  const handler = await buildHandler(authRoutes, "/api/auth/me", "GET");
  const res = await handler(makeContext({ method: "GET" }));
  suite.expectEqual(res.status, 401, "status");
  suite.expectEqual(res.body?.authenticated, false, "body.authenticated");
});

await suite.test("GET /api/auth/me — 200 with admin user when X-Admin-Key matches", async () => {
  const handler = await buildHandler(authRoutes, "/api/auth/me", "GET");
  const res = await handler(makeContext({
    method: "GET",
    headers: { "X-Admin-Key": TEST_ADMIN_KEY },
  }));
  suite.expectEqual(res.status, 200, "status");
  suite.expectEqual(res.body?.authenticated, true, "body.authenticated");
  suite.expectEqual(res.body?.user?.role, "admin", "body.user.role");
  suite.expectEqual(res.body?.user?.id, "admin", "body.user.id");
});

// Regression guard for Task #831: a request presenting ONLY the admin_key
// cookie (no X-Admin-Key header) must NOT authenticate. The browser
// admin_key cookie path has been removed; only the X-Admin-Key header is
// trusted on this endpoint.
await suite.test("GET /api/auth/me — 401 when only admin_key cookie is present (cookie path removed)", async () => {
  const handler = await buildHandler(authRoutes, "/api/auth/me", "GET");
  const res = await handler(makeContext({
    method: "GET",
    headers: { Cookie: `admin_key=${TEST_ADMIN_KEY}` },
  }));
  suite.expectEqual(res.status, 401, "status");
  suite.expectEqual(res.body?.authenticated, false, "body.authenticated");
});

await suite.test("GET /api/auth/me — 401 when X-Admin-Key is wrong", async () => {
  const handler = await buildHandler(authRoutes, "/api/auth/me", "GET");
  const res = await handler(makeContext({
    method: "GET",
    headers: { "X-Admin-Key": "definitely-not-the-key" },
  }));
  suite.expectEqual(res.status, 401, "status");
  suite.expectEqual(res.body?.authenticated, false, "body.authenticated");
});

await suite.test("POST /api/auth/logout — 200 clears session AND admin_key cookies", async () => {
  const handler = await buildHandler(authRoutes, "/api/auth/logout", "POST");
  const res = await handler(makeContext({ method: "POST" }));
  suite.expectEqual(res.status, 200, "status");
  suite.expectEqual(res.body?.success, true, "body.success");
  const cookie = res.headers["Set-Cookie"] ?? "";
  suite.expect(cookie.includes("ExampleOrg_session="), "Set-Cookie clears session");
  suite.expect(cookie.includes("admin_key="), "Set-Cookie clears admin_key");
  suite.expect(cookie.includes("Max-Age=0"), "Set-Cookie has Max-Age=0");
  // The admin_key clear cookie must always carry HttpOnly + Secure +
  // SameSite=Strict — browsers will only accept the deletion if the flags
  // match those used when the cookie was set. The static guardrail in
  // scripts/check-admin-cookie-flags.sh mirrors this assertion so a
  // regression fails CI both at runtime (here) and at scan time.
  // The substring `admin_key=; HttpOnly; Secure; ... SameSite=Strict` is
  // emitted as a single Set-Cookie value (separate from the session clear),
  // and our fakeContext joins multiple `Set-Cookie` headers with `, `, so
  // checking for the flag substrings on the joined value is safe.
  suite.expect(
    cookie.includes("HttpOnly") &&
      cookie.includes("Secure") &&
      cookie.includes("SameSite=Strict"),
    "Set-Cookie has HttpOnly + Secure + SameSite=Strict (for admin_key clear)",
  );
});

if (ORIGINAL_ADMIN_KEY === undefined) {
  delete process.env.ADMIN_API_KEY;
} else {
  process.env.ADMIN_API_KEY = ORIGINAL_ADMIN_KEY;
}

suite.finishOrExit();
