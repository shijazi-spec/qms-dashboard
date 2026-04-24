/**
 * Integration tests for src/mastra/routes/qmsEnhancedRoutes.ts
 *
 * Coverage matrix:
 *   - structural      → every route exposes path/method/createHandler.
 *   - validation 400  → POST /api/evidence rejects an empty body.
 *   - validation 400  → POST /api/qms/nc/bulk-update rejects an empty body.
 *
 * Note: This module exposes evidence/CAPA/export endpoints that are
 * intentionally not gated by auth in this prototype (auth is enforced one
 * layer up in production). Tighten these to 401/403 assertions once those
 * gates land — see the route-lockdown follow-up task.
 *
 * Run:  npx tsx tests/qmsEnhancedRoutes.test.ts
 */

import { qmsEnhancedRoutes } from "../src/mastra/routes/qmsEnhancedRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("qmsEnhancedRoutes");

console.log("\n=== qmsEnhancedRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of qmsEnhancedRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(qmsEnhancedRoutes.length >= 10, "at least 10 routes registered");
});

await suite.test("POST /api/evidence — 400 with empty body (validation)", async () => {
  const handler = await buildHandler(qmsEnhancedRoutes, "/api/evidence", "POST", { mastra: null });
  const res = await handler(makeContext({ method: "POST", body: {} }));
  suite.expectEqual(res.status, 400, "status");
  suite.expect(typeof res.body?.error === "string", "body.error is string");
});

await suite.test("POST /api/qms/nc/bulk-update — 400 with empty body (validation)", async () => {
  const handler = await buildHandler(qmsEnhancedRoutes, "/api/qms/nc/bulk-update", "POST", { mastra: null });
  const res = await handler(makeContext({ method: "POST", body: {} }));
  suite.expectEqual(res.status, 400, "status");
  suite.expect(typeof res.body?.error === "string", "body.error is string");
});

suite.finishOrExit();
