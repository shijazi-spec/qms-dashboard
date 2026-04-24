/**
 * Integration tests for src/mastra/routes/vendorRoutes.ts
 *
 * Coverage matrix:
 *   - 200/500         → GET /api/vendors and GET /api/vendors/summary return
 *                       200 with the expected shape when DB is available
 *                       (gated on DATABASE_URL).
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/vendorRoutes.test.ts
 */

import { vendorRoutes } from "../src/mastra/routes/vendorRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("vendorRoutes");
const HAS_DB = !!process.env.DATABASE_URL;

console.log("\n=== vendorRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of vendorRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(vendorRoutes.length >= 2, "at least 2 routes registered");
});

if (HAS_DB) {
  await suite.test("GET /api/vendors — 200 with object shape (DB available)", async () => {
    const handler = await buildHandler(vendorRoutes, "/api/vendors", "GET", { mastra: null });
    const res = await handler(makeContext({ method: "GET", url: "http://localhost/api/vendors" }));
    suite.expectEqual(res.status, 200, "status");
    suite.expect(res.body && typeof res.body === "object", "body is object");
  });

  await suite.test("GET /api/vendors/summary — 200 with object shape (DB available)", async () => {
    const handler = await buildHandler(vendorRoutes, "/api/vendors/summary", "GET", { mastra: null });
    const res = await handler(makeContext({ method: "GET", url: "http://localhost/api/vendors/summary" }));
    suite.expectEqual(res.status, 200, "status");
    suite.expect(res.body && typeof res.body === "object", "body is object");
  });
} else {
  console.log("  (skipped) GET /api/vendors — DATABASE_URL not set");
  console.log("  (skipped) GET /api/vendors/summary — DATABASE_URL not set");
}

suite.finishOrExit();
