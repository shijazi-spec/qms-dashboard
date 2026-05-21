/**
 * Integration tests for src/mastra/routes/dashboardApiRoutes.ts
 *
 * Coverage matrix:
 *   - 200 happy path  → GET  /api/integrations/status (no DB, full body shape)
 *   - 400 bad input   → GET  /api/crm/data (Zoho not configured)
 *                       GET  /api/agents/performance (malformed createdStart)
 *                       GET  /api/agents/performance (createdStart > createdEnd)
 *                       GET  /api/agents/performance (modifiedStart > modifiedEnd)
 *   - structural      → every route exposes path/method/createHandler
 *
 * Note: a 200 happy-path on /api/agents/performance is intentionally NOT
 * included — it requires a live Zoho CRM connection and would be flaky in CI.
 * The four 400 validation tests above exercise that handler deterministically.
 *
 * Run:  npx tsx tests/dashboardApiRoutes.test.ts
 */

import { dashboardApiRoutes } from "../src/mastra/routes/dashboardApiRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";
import pg from "pg";

const suite = new TestSuite("dashboardApiRoutes");
const HAS_DB = !!process.env.DATABASE_URL;

// Task #60 / Task #197 — every dashboard API route is now wrapped by
// `gateApiRoute()` which rejects unauthenticated callers with `401
// Authentication required`. These tests are exercising the *business
// logic* of each handler (200 happy paths, 400 validation errors), not
// the auth layer (which has its own dedicated test in
// tests/gateApiRoute.test.ts).
//
// Bypass the gate by providing a real signed session cookie.  gateApiRoute
// uses requireAuthOrKey() → getSessionUser() which reads only the signed
// cookie (no DB lookup), so a syntactically-valid session is sufficient.
// The X-Admin-Key header is intentionally NOT used here: it is scoped to
// /api/admin/* routes and must NOT bypass gateApiRoute on application routes.
import crypto from "crypto";
const SESSION_SECRET = process.env.SESSION_SECRET ?? "dashboard-test-secret-2026";
if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = SESSION_SECRET;

function dashboardSignSession(payload: Record<string, any>): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

const SESSION_TOKEN = dashboardSignSession({
  userId: 1,
  email: "test-admin@dashboard-test.internal",
  name: "Test Admin",
  role: "admin",
  exp: Date.now() + 3_600_000,
});
// Cookie header value: walaplus_session=<url-encoded-token>
const ADMIN_HEADERS = { Cookie: `walaplus_session=${encodeURIComponent(SESSION_TOKEN)}` };

// The dashboardGate inside these routes calls requireRole() which does a DB
// lookup in platform_users. Seed a test user so the gate allows the request.
const DASHBOARD_TEST_EMAIL = "test-admin@dashboard-test.internal";
let dashboardPool: pg.Pool | null = null;

if (HAS_DB) {
  dashboardPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // Ensure the test user exists with role=admin, status=active.
  await dashboardPool.query(
    `INSERT INTO platform_users (email, full_name, role, status)
     VALUES ($1, 'Test Admin', 'admin', 'active')
     ON CONFLICT (email) DO UPDATE SET role = 'admin', status = 'active'`,
    [DASHBOARD_TEST_EMAIL],
  );
  // Clear any in-process cache so the fresh DB row is picked up.
  try {
    const { invalidatePlatformUserCache } = await import("../src/utils/rbacMiddleware");
    invalidatePlatformUserCache(DASHBOARD_TEST_EMAIL);
  } catch {}
}

console.log("\n=== dashboardApiRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of dashboardApiRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expectEqual(dashboardApiRoutes.length >= 10, true, "at least 10 routes registered");
});

await suite.test("GET /api/integrations/status — 200 with full body shape (no DB)", async () => {
  const handler = await buildHandler(dashboardApiRoutes, "/api/integrations/status", "GET");
  const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));
  suite.expectEqual(res.status, 200, "status");
  suite.expect(res.body && typeof res.body === "object", "body is object");
  for (const key of ["zoho", "googleCalendar", "email"] as const) {
    const entry = (res.body as any)[key];
    suite.expect(entry && typeof entry === "object", `body.${key} is object`);
    suite.expect(typeof entry?.connected === "boolean", `body.${key}.connected is boolean`);
    suite.expect(typeof entry?.message === "string", `body.${key}.message is string`);
  }
});

await suite.test("GET /api/crm/data — 400 with structured error when Zoho not configured", async () => {
  const snapshot = {
    ZOHO_CLIENT_ID: process.env.ZOHO_CLIENT_ID,
    ZOHO_CLIENT_SECRET: process.env.ZOHO_CLIENT_SECRET,
    ZOHO_REFRESH_TOKEN: process.env.ZOHO_REFRESH_TOKEN,
    ZOHO_ACCESS_TOKEN: process.env.ZOHO_ACCESS_TOKEN,
  };
  delete process.env.ZOHO_CLIENT_ID;
  delete process.env.ZOHO_CLIENT_SECRET;
  delete process.env.ZOHO_REFRESH_TOKEN;
  delete process.env.ZOHO_ACCESS_TOKEN;
  try {
    const handler = await buildHandler(dashboardApiRoutes, "/api/crm/data", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS, query: { module: "Leads" } }));
    suite.expectEqual(res.status, 400, "status");
    suite.expectEqual(res.body?.success, false, "body.success");
    suite.expectEqual(res.body?.error, "Zoho CRM not configured", "body.error");
  } finally {
    if (snapshot.ZOHO_CLIENT_ID !== undefined) process.env.ZOHO_CLIENT_ID = snapshot.ZOHO_CLIENT_ID;
    if (snapshot.ZOHO_CLIENT_SECRET !== undefined) process.env.ZOHO_CLIENT_SECRET = snapshot.ZOHO_CLIENT_SECRET;
    if (snapshot.ZOHO_REFRESH_TOKEN !== undefined) process.env.ZOHO_REFRESH_TOKEN = snapshot.ZOHO_REFRESH_TOKEN;
    if (snapshot.ZOHO_ACCESS_TOKEN !== undefined) process.env.ZOHO_ACCESS_TOKEN = snapshot.ZOHO_ACCESS_TOKEN;
  }
});

await suite.test("GET /api/agents/performance — 400 on malformed createdStart date", async () => {
  const handler = await buildHandler(dashboardApiRoutes, "/api/agents/performance", "GET");
  const res = await handler(
    makeContext({ method: "GET", headers: ADMIN_HEADERS, query: { createdStart: "not-a-date", createdEnd: "2025-01-31" } }),
  );
  suite.expectEqual(res.status, 400, "status");
  suite.expectEqual(res.body?.success, false, "body.success");
  suite.expect(
    typeof res.body?.error === "string" && res.body.error.includes("Invalid date format"),
    `body.error mentions Invalid date format (got: ${JSON.stringify(res.body?.error)})`,
  );
});

await suite.test("GET /api/agents/performance — 400 when createdStart is after createdEnd", async () => {
  const handler = await buildHandler(dashboardApiRoutes, "/api/agents/performance", "GET");
  const res = await handler(
    makeContext({ method: "GET", headers: ADMIN_HEADERS, query: { createdStart: "2025-02-01", createdEnd: "2025-01-01" } }),
  );
  suite.expectEqual(res.status, 400, "status");
  suite.expectEqual(res.body?.success, false, "body.success");
  suite.expectEqual(
    res.body?.error,
    "Created start date must be before or equal to created end date.",
    "body.error",
  );
});

await suite.test("GET /api/agents/performance — 400 when modifiedStart is after modifiedEnd", async () => {
  const handler = await buildHandler(dashboardApiRoutes, "/api/agents/performance", "GET");
  const res = await handler(
    makeContext({ method: "GET", headers: ADMIN_HEADERS, query: { modifiedStart: "2025-02-01", modifiedEnd: "2025-01-01" } }),
  );
  suite.expectEqual(res.status, 400, "status");
  suite.expectEqual(res.body?.success, false, "body.success");
  suite.expectEqual(
    res.body?.error,
    "Modified start date must be before or equal to modified end date.",
    "body.error",
  );
});

// Note: GET /api/agents/performance happy-path (200) is intentionally NOT
// covered here. That handler depends on a live Zoho CRM connection (network
// + valid OAuth tokens) which can't be guaranteed in CI; running it would
// produce flaky failures (e.g. 500 from Zoho rate-limiting). The four 400
// validation tests above already exercise the route's input-validation paths
// deterministically without any external dependency.

// Cleanup: remove the seeded platform_users row and close the pool.
if (dashboardPool) {
  await suite.test("cleanup: remove seeded platform_users row", async () => {
    try {
      await dashboardPool!.query(
        `DELETE FROM platform_users WHERE email = $1`,
        [DASHBOARD_TEST_EMAIL],
      );
    } catch (err) {
      console.warn("[dashboardApiRoutes test] cleanup failed:", err);
    } finally {
      await dashboardPool!.end().catch(() => {});
    }
  });
}

suite.finishOrExit();
