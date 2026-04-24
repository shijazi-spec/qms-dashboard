/**
 * Integration tests for src/mastra/routes/riskRoutes.ts
 *
 * Coverage matrix:
 *   - 401/403         → mutating endpoints (POST/PUT) require an authenticated
 *                       risk role; without one, returns 401/403.
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Note: Read-only GET endpoints (list/heatmap/summary/etc.) are public so the
 * dashboard can render before auth completes; that's covered by the structural
 * assertion only.
 *
 * Run:  npx tsx tests/riskRoutes.test.ts
 */

import { riskRoutes } from "../src/mastra/routes/riskRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("riskRoutes");

console.log("\n=== riskRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of riskRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(riskRoutes.length >= 5, "at least 5 routes registered");
});

const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

for (const route of riskRoutes) {
  const path = route.path;
  const method = route.method as string;
  if (!mutatingMethods.has(method)) continue;
  await suite.test(`${method} ${path} — 401/403 without an authenticated risk role`, async () => {
    const handler = await buildHandler(riskRoutes, path, method, { mastra: null });
    const ctx = makeContext({
      method,
      params: { id: "1", actionId: "1" },
      body: {},
    }) as FakeContext & { html?: any };
    ctx.html = (body: string, status?: number) => ({ status: status ?? 200, body, headers: {} });
    const res = await handler(ctx);
    suite.expect(res.status === 401 || res.status === 403, `status 401/403, got ${res.status}`);
    suite.expect(typeof res.body?.error === "string", "body.error is string");
  });
}

suite.finishOrExit();
