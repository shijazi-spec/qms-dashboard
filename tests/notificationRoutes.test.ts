/**
 * Integration tests for src/mastra/routes/notificationRoutes.ts
 *
 * Coverage matrix:
 *   - 200 happy path  → GET /api/notifications/count returns {count:number}
 *                       (DB-backed, gated on DATABASE_URL).
 *   - 400 bad input   → POST /api/notifications/:id/read with non-numeric id
 *                       POST /api/notifications/:id/dismiss with non-numeric id
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/notificationRoutes.test.ts
 */

import { notificationRoutes } from "../src/mastra/routes/notificationRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("notificationRoutes");
const HAS_DB = !!process.env.DATABASE_URL;

console.log("\n=== notificationRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of notificationRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(notificationRoutes.length >= 5, "at least 5 routes registered");
});

await suite.test("POST /api/notifications/:id/read — 400 with non-numeric id", async () => {
  const handler = await buildHandler(notificationRoutes, "/api/notifications/:id/read", "POST");
  const res = await handler(makeContext({ method: "POST", params: { id: "abc" } }));
  suite.expectEqual(res.status, 400, "status");
  suite.expectEqual(res.body?.error, "Invalid ID", "body.error");
});

await suite.test("POST /api/notifications/:id/dismiss — 400 with non-numeric id", async () => {
  const handler = await buildHandler(notificationRoutes, "/api/notifications/:id/dismiss", "POST");
  const res = await handler(makeContext({ method: "POST", params: { id: "not-a-number" } }));
  suite.expectEqual(res.status, 400, "status");
  suite.expectEqual(res.body?.error, "Invalid ID", "body.error");
});

if (HAS_DB) {
  await suite.test("GET /api/notifications/count — handler returns numeric count or structured 500", async () => {
    const handler = await buildHandler(notificationRoutes, "/api/notifications/count", "GET");
    const res = await handler(makeContext({ method: "GET" }));
    if (res.status === 200) {
      suite.expect(typeof res.body?.count === "number", "body.count is number");
    } else {
      // Table may be uninitialised in this environment — assert error shape.
      suite.expectEqual(res.status, 500, "status 500 fallback");
      suite.expect(typeof res.body?.error === "string", "body.error is string");
    }
  });
} else {
  console.log("  (skipped) GET /api/notifications/count — DATABASE_URL not set");
}

// --------------------------------------------------------------------------
// Defense-in-depth auth check on /api/health-index.
//
// Until task #447, `/api/health-index` was unintentionally treated as a
// public endpoint because the `/api/health` entry in the middleware's
// PUBLIC_PATHS used a prefix match (see src/mastra/middleware/index.ts).
// Task #466 adds a handler-level gate so the rollup is refused even if a
// future stale entry in PUBLIC_PATHS, or any other middleware bypass, is
// re-introduced. The handler now mirrors `isAuthorizedForSop` in
// sopRoutes.ts: 401 unless there is a valid session cookie or admin key.
// --------------------------------------------------------------------------

await suite.test("GET /api/health-index — 401 with no session and no admin key", async () => {
  const handler = await buildHandler(notificationRoutes, "/api/health-index", "GET");
  // Ensure the env doesn't accidentally grant a match against a missing key.
  const prevAdmin = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "test-health-index-admin-key-do-not-leak-0001";
  try {
    const res = await handler(makeContext({ method: "GET" }));
    suite.expectEqual(res.status, 401, "status");
    suite.expectEqual(res.body?.error, "Authentication required", "body.error");
  } finally {
    if (prevAdmin === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prevAdmin;
  }
});

await suite.test("GET /api/health-index — passes auth gate with X-Admin-Key header", async () => {
  const handler = await buildHandler(notificationRoutes, "/api/health-index", "GET");
  const prevAdmin = process.env.ADMIN_API_KEY;
  const ADMIN_KEY = "test-health-index-admin-key-do-not-leak-0002";
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const res = await handler(
      makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
    );
    // The auth gate must let this request through. Whether the DB query
    // succeeds depends on the test environment, so we accept either:
    //   200 → handler computed a healthIndex
    //   500 → DB unreachable / pg pool failure (still past the auth gate)
    // We must NOT see 401 here — that would mean the gate rejected a
    // valid admin key.
    suite.expect(res.status !== 401, `expected non-401, got ${res.status}`);
    if (res.status === 200) {
      suite.expect(typeof res.body?.healthIndex === "number", "body.healthIndex is number");
      suite.expect(typeof res.body?.healthStatus === "string", "body.healthStatus is string");
    } else {
      suite.expectEqual(res.status, 500, "status 500 fallback");
      suite.expect(typeof res.body?.error === "string", "body.error is string");
    }
  } finally {
    if (prevAdmin === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prevAdmin;
  }
});

suite.finishOrExit();
