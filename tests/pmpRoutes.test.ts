/**
 * Integration tests for src/mastra/routes/pmpRoutes.ts
 *
 * Coverage matrix:
 *   - structural      → every route exposes path/method/createHandler.
 *   - 200 happy path  → GET /api/pmp/projects and /api/pmp/portfolio/analytics
 *                       return JSON when DB is available.
 *
 * Note: PMP routes are intentionally not gated by an auth role (the workspace
 * is open to all authenticated users in this prototype). When that policy
 * tightens, swap the smoke tests below for 401/403 assertions.
 *
 * Run:  npx tsx tests/pmpRoutes.test.ts
 */

import { pmpRoutes } from "../src/mastra/routes/pmpRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("pmpRoutes");
const HAS_DB = !!process.env.DATABASE_URL;

console.log("\n=== pmpRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of pmpRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(pmpRoutes.length >= 20, "at least 20 routes registered");
});

if (HAS_DB) {
  await suite.test("GET /api/pmp/projects — 200 with object payload (DB available)", async () => {
    const handler = await buildHandler(pmpRoutes, "/api/pmp/projects", "GET", { mastra: null });
    const res = await handler(makeContext({ method: "GET", url: "http://localhost/api/pmp/projects" }));
    suite.expectEqual(res.status, 200, "status");
    suite.expect(res.body && typeof res.body === "object", "body is object");
  });

  await suite.test("GET /api/pmp/portfolio/analytics — 200 with object payload (DB available)", async () => {
    const handler = await buildHandler(pmpRoutes, "/api/pmp/portfolio/analytics", "GET", { mastra: null });
    const res = await handler(makeContext({ method: "GET", url: "http://localhost/api/pmp/portfolio/analytics" }));
    suite.expectEqual(res.status, 200, "status");
    suite.expect(res.body && typeof res.body === "object", "body is object");
  });
} else {
  console.log("  (skipped) GET /api/pmp/projects — DATABASE_URL not set");
  console.log("  (skipped) GET /api/pmp/portfolio/analytics — DATABASE_URL not set");
}

suite.finishOrExit();
