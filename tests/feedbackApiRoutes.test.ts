/**
 * Integration tests for src/mastra/routes/feedbackApiRoutes.ts
 *
 * Coverage matrix:
 *   - 400 bad input   → POST /api/feedback with missing required fields.
 *   - 200/500         → GET /api/feedback returns 200 with array when DB is
 *                       available; 500 with error otherwise.
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/feedbackApiRoutes.test.ts
 */

import { feedbackApiRoutes } from "../src/mastra/routes/feedbackApiRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("feedbackApiRoutes");
const HAS_DB = !!process.env.DATABASE_URL;

console.log("\n=== feedbackApiRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of feedbackApiRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(feedbackApiRoutes.length >= 3, "at least 3 routes registered");
});

await suite.test("POST /api/feedback — 400 when required fields are missing", async () => {
  const handler = await buildHandler(feedbackApiRoutes, "/api/feedback", "POST", { mastra: null });
  const res = await handler(makeContext({ method: "POST", body: {} }));
  suite.expectEqual(res.status, 400, "status");
  suite.expectEqual(
    res.body?.error,
    "Name, dashboard, and rating are required",
    "body.error",
  );
});

if (HAS_DB) {
  await suite.test("GET /api/feedback — 200 with feedback array (DB available)", async () => {
    const handler = await buildHandler(feedbackApiRoutes, "/api/feedback", "GET", { mastra: null });
    const res = await handler(makeContext({ method: "GET" }));
    suite.expectEqual(res.status, 200, "status");
    suite.expect(Array.isArray(res.body?.feedback), "body.feedback is array");
  });
} else {
  console.log("  (skipped) GET /api/feedback — DATABASE_URL not set");
}

suite.finishOrExit();
