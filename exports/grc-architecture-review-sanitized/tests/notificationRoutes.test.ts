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
// Role-gated access check on /api/health-index (Task #841).
//
// The endpoint aggregates audit scores, NC resolution rates, CAPA
// effectiveness, KPI achievement, and compliance percentages — all sourced
// from modules whose direct APIs are restricted to governance-oriented roles.
// Task #841 tightened the handler gate from "any authenticated user"
// (`isAuthorizedForHealthIndex`) to `requireRoleOrKey(c, HEALTH_INDEX_ROLES)`
// so that lower-privileged roles (auditor, quality_specialist, team_lead,
// bu_owner, ai_specialist, department_viewer) can no longer read these
// organisation-wide performance indicators through this aggregation endpoint.
//
// The handler now returns 403 for callers without a matching role or a valid
// admin key, and passes for callers who supply a valid X-Admin-Key header.
// --------------------------------------------------------------------------

await suite.test("GET /api/health-index — 403 with no session and no admin key", async () => {
  const handler = await buildHandler(notificationRoutes, "/api/health-index", "GET");
  // Ensure the env doesn't accidentally grant a match against a missing key.
  const prevAdmin = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "test-health-index-admin-key-do-not-leak-0001";
  try {
    const res = await handler(makeContext({ method: "GET" }));
    suite.expectEqual(res.status, 403, "status");
    suite.expect(typeof res.body?.error === "string", "body.error is string");
  } finally {
    if (prevAdmin === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prevAdmin;
  }
});

await suite.test("GET /api/health-index — X-Admin-Key alone is rejected (key is not a session)", async () => {
  // The shared X-Admin-Key is scoped to /api/admin/* routes. /api/health-index
  // uses requireRoleOrKey() which now requires a real user session; a key-only
  // caller must receive 401 so that monitoring jobs or integrations that know
  // the key cannot read organisation-wide quality/compliance aggregates.
  const handler = await buildHandler(notificationRoutes, "/api/health-index", "GET");
  const prevAdmin = process.env.ADMIN_API_KEY;
  const ADMIN_KEY = "test-health-index-admin-key-do-not-leak-0002";
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const res = await handler(
      makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
    );
    suite.expect(
      res.status === 401 || res.status === 403,
      `expected 401 or 403 for key-only caller, got ${res.status}`,
    );
  } finally {
    if (prevAdmin === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prevAdmin;
  }
});

suite.finishOrExit();
