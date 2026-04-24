/**
 * Integration tests for src/mastra/routes/tablefRoutes.ts
 *
 * Coverage matrix:
 *   - structural      → createTableFRoutes() returns a Hono app.
 *   - 404             → Hono app returns 404 for unknown paths.
 *   - 200 happy path  → GET /api/tablef/departments returns JSON when DB is
 *                       available.
 *
 * Note: This module exports a Hono app (not the path/method/createHandler
 * triples used by other routes), so we drive it through Hono's `request()`.
 *
 * Run:  npx tsx tests/tablefRoutes.test.ts
 */

import { createTableFRoutes } from "../src/mastra/routes/tablefRoutes";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("tablefRoutes");
const HAS_DB = !!process.env.DATABASE_URL;

console.log("\n=== tablefRoutes integration tests ===\n");

await suite.test("createTableFRoutes() returns a Hono app", async () => {
  const app = createTableFRoutes() as any;
  suite.expect(typeof app === "object" && app !== null, "app is an object");
  suite.expect(typeof app.request === "function", "app.request() is a function");
  suite.expect(typeof app.fetch === "function", "app.fetch() is a function");
});

await suite.test("GET /some-unknown-path — 404 from Hono", async () => {
  const app = createTableFRoutes() as any;
  const res: Response = await app.request("/some-unknown-path-xyz");
  suite.expectEqual(res.status, 404, "status");
});

if (HAS_DB) {
  await suite.test("GET /departments — 200 with array payload (DB available)", async () => {
    const app = createTableFRoutes() as any;
    const res: Response = await app.request("/departments");
    suite.expectEqual(res.status, 200, "status");
    const body = await res.json();
    suite.expect(body && Array.isArray(body.departments), "body.departments is array");
  });
} else {
  console.log("  (skipped) GET /departments — DATABASE_URL not set");
}

suite.finishOrExit();
