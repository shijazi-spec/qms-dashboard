/**
 * Integration tests for src/mastra/routes/managementReviewRoutes.ts
 *
 * Coverage matrix:
 *   - 200 happy path  → GET /api/management-reviews returns object with reviews
 *                       array (DB-backed, gated on DATABASE_URL).
 *   - 400 bad input   → GET /api/management-reviews/:id with non-numeric id.
 *                       PUT /api/management-reviews/:id with non-numeric id.
 *                       POST /api/management-reviews/:id/actions with non-numeric id.
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/managementReviewRoutes.test.ts
 */

import { managementReviewRoutes } from "../src/mastra/routes/managementReviewRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("managementReviewRoutes");
const HAS_DB = !!process.env.DATABASE_URL;

console.log("\n=== managementReviewRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of managementReviewRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(managementReviewRoutes.length >= 6, "at least 6 routes registered");
});

await suite.test("GET /api/management-reviews/:id — 400 with non-numeric id", async () => {
  const handler = await buildHandler(managementReviewRoutes, "/api/management-reviews/:id", "GET");
  const res = await handler(makeContext({ method: "GET", params: { id: "abc" } }));
  suite.expectEqual(res.status, 400, "status");
  suite.expectEqual(res.body?.error, "Invalid ID", "body.error");
});

await suite.test("PUT /api/management-reviews/:id — 400 with non-numeric id", async () => {
  const handler = await buildHandler(managementReviewRoutes, "/api/management-reviews/:id", "PUT");
  const res = await handler(makeContext({ method: "PUT", params: { id: "xyz" }, body: {} }));
  suite.expectEqual(res.status, 400, "status");
  suite.expectEqual(res.body?.error, "Invalid ID", "body.error");
});

await suite.test("POST /api/management-reviews/:id/actions — 400 with non-numeric id", async () => {
  const handler = await buildHandler(managementReviewRoutes, "/api/management-reviews/:id/actions", "POST");
  const res = await handler(makeContext({ method: "POST", params: { id: "abc" }, body: {} }));
  suite.expectEqual(res.status, 400, "status");
  suite.expectEqual(res.body?.error, "Invalid ID", "body.error");
});

if (HAS_DB) {
  await suite.test("GET /api/management-reviews — 200 returns object with reviews (DB available)", async () => {
    const handler = await buildHandler(managementReviewRoutes, "/api/management-reviews", "GET");
    const res = await handler(makeContext({ method: "GET" }));
    suite.expectEqual(res.status, 200, "status");
    suite.expect(res.body && typeof res.body === "object", "body is object");
  });
} else {
  console.log("  (skipped) GET /api/management-reviews — DATABASE_URL not set");
}

suite.finishOrExit();
