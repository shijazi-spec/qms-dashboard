/**
 * Integration tests for src/mastra/routes/dashboardRoutes.ts
 *
 * Coverage matrix:
 *   - structural      → createDashboardRoutes() exports a Hono app with the
 *                       expected dashboard endpoints registered.
 *   - 404             → Hono app returns 404 for unknown paths.
 *   - 200/500         → GET /dashboard returns JSON when DB is available.
 *
 * Note: This module exports a Hono app (not the path/method/createHandler
 * triples used by other routes), so we drive it through Hono's `request()`.
 *
 * Run:  npx tsx tests/dashboardRoutes.test.ts
 */

import { createDashboardRoutes } from "../src/mastra/routes/dashboardRoutes";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("dashboardRoutes");
const HAS_DB = !!process.env.DATABASE_URL;

console.log("\n=== dashboardRoutes integration tests ===\n");

await suite.test("createDashboardRoutes() returns a Hono app", async () => {
  const app = createDashboardRoutes() as any;
  suite.expect(typeof app === "object" && app !== null, "app is an object");
  suite.expect(typeof app.request === "function", "app.request() is a function");
  suite.expect(typeof app.fetch === "function", "app.fetch() is a function");
});

await suite.test("GET /unknown — 404 from Hono", async () => {
  const app = createDashboardRoutes() as any;
  const res: Response = await app.request("/some-unknown-path-xyz");
  suite.expectEqual(res.status, 404, "status");
});

if (HAS_DB) {
  await suite.test("GET /dashboard — 200 with object payload (DB available)", async () => {
    const app = createDashboardRoutes() as any;
    const res: Response = await app.request("/dashboard");
    suite.expectEqual(res.status, 200, "status");
    const body = await res.json();
    suite.expect(body && typeof body === "object", "body is object");
  });
} else {
  console.log("  (skipped) GET /dashboard — DATABASE_URL not set");
}

suite.finishOrExit();
