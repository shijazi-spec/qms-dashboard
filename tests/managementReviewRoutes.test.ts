/**
 * Integration tests for src/mastra/routes/managementReviewRoutes.ts
 *
 * Coverage matrix:
 *   - 401 unauthenticated → all handlers reject requests with no session cookie.
 *                           Auth check runs before ID-validation, so even a
 *                           non-numeric id yields 401, not 400, for unauthenticated callers.
 *   - structural          → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/managementReviewRoutes.test.ts
 */

import { managementReviewRoutes } from "../src/mastra/routes/managementReviewRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("managementReviewRoutes");

console.log("\n=== managementReviewRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of managementReviewRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(managementReviewRoutes.length >= 6, "at least 6 routes registered");
});

await suite.test("GET /api/management-reviews/:id — 401 without session (auth-first design)", async () => {
  const handler = await buildHandler(managementReviewRoutes, "/api/management-reviews/:id", "GET");
  const res = await handler(makeContext({ method: "GET", params: { id: "abc" } }));
  suite.expectEqual(res.status, 401, "unauthenticated request must return 401 before reaching ID validation");
});

await suite.test("PUT /api/management-reviews/:id — 401 without session (auth-first design)", async () => {
  const handler = await buildHandler(managementReviewRoutes, "/api/management-reviews/:id", "PUT");
  const res = await handler(makeContext({ method: "PUT", params: { id: "xyz" }, body: {} }));
  suite.expectEqual(res.status, 401, "unauthenticated request must return 401 before reaching ID validation");
});

await suite.test("POST /api/management-reviews/:id/actions — 401 without session (auth-first design)", async () => {
  const handler = await buildHandler(managementReviewRoutes, "/api/management-reviews/:id/actions", "POST");
  const res = await handler(makeContext({ method: "POST", params: { id: "abc" }, body: {} }));
  suite.expectEqual(res.status, 401, "unauthenticated request must return 401 before reaching ID validation");
});

await suite.test("GET /api/management-reviews — 401 without session", async () => {
  const handler = await buildHandler(managementReviewRoutes, "/api/management-reviews", "GET");
  const res = await handler(makeContext({ method: "GET" }));
  suite.expectEqual(res.status, 401, "unauthenticated list request must return 401");
});

suite.finishOrExit();
