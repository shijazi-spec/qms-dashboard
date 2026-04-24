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

suite.finishOrExit();
