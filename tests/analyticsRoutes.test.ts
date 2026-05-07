/**
 * Integration tests for src/mastra/routes/analyticsRoutes.ts
 *
 * Coverage matrix:
 *   - 403 forbidden   → every analytics endpoint without an authenticated role
 *                       (analytics is gated to admin/quality_manager/grc_manager/
 *                       head_of_operations_quality/executive).
 *   - structural      → every route exposes path/method/createHandler.
 *
 * All assertions are deterministic — auth is checked before any DB call.
 *
 * Run:  npx tsx tests/analyticsRoutes.test.ts
 */

import { analyticsRoutes } from "../src/mastra/routes/analyticsRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("analyticsRoutes");

console.log("\n=== analyticsRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of analyticsRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(analyticsRoutes.length >= 6, "at least 6 routes registered");
});

const GETS = [
  "/api/analytics/cycle-times",
  "/api/analytics/agent-compliance",
  "/api/analytics/capa-recurrence",
  "/api/analytics/trends",
  "/api/analytics/executive-digest",
  "/api/analytics/executive-digest/health",
  "/api/analytics/executive-digest/runs",
];

for (const p of GETS) {
  await suite.test(`GET ${p} — 403 without an authenticated role`, async () => {
    const handler = await buildHandler(analyticsRoutes, p, "GET");
    const res = await handler(makeContext({ method: "GET" }));
    suite.expectEqual(res.status, 403, "status");
    suite.expect(typeof res.body?.error === "string", "body.error is string");
  });
}

await suite.test("POST /api/analytics/executive-digest/send — 403 without role", async () => {
  const handler = await buildHandler(analyticsRoutes, "/api/analytics/executive-digest/send", "POST");
  const res = await handler(makeContext({ method: "POST", body: {} }));
  suite.expectEqual(res.status, 403, "status");
  suite.expect(typeof res.body?.error === "string", "body.error is string");
});

suite.finishOrExit();
