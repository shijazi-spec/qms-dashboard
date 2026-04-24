/**
 * Integration tests for src/mastra/routes/riskRoutes.ts
 *
 * Coverage matrix:
 *   - structural      → every route exposes path/method/createHandler.
 *   - 401/403 reads   → every read GET (list/heatmap/summary/trends/overdue/
 *                       categories/:id/export/export-xlsx) requires a
 *                       governance role; without one, returns 401 (no session)
 *                       or 403 (wrong role).
 *   - 401/403 writes  → mutating endpoints (POST/PUT) require an authenticated
 *                       risk role; without one, returns 401/403.
 *
 * Run:  npx tsx tests/riskRoutes.test.ts
 */

import { riskRoutes } from "../src/mastra/routes/riskRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("riskRoutes");
const ADMIN_KEY = "integration-test-risk-2026";

console.log("\n=== riskRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of riskRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(riskRoutes.length >= 5, "at least 5 routes registered");
});

const apiRoutes = riskRoutes.filter((r) => r.path.startsWith("/api/"));

for (const route of apiRoutes) {
  const path = route.path;
  const method = route.method as string;
  await suite.test(`${method} ${path} — 401/403 without an authenticated risk role`, async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(riskRoutes, path, method, { mastra: null });
      const ctx = makeContext({
        method,
        url: `http://localhost${path.replace(/:\w+/g, "1")}`,
        params: { id: "1", actionId: "1" },
        body: ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? {} : undefined,
      }) as FakeContext & { html?: any };
      ctx.html = (body: string, status?: number) => ({ status: status ?? 200, body, headers: {} });
      const res = await handler(ctx);
      suite.expect(res.status === 401 || res.status === 403, `status 401/403, got ${res.status}`);
      suite.expect(typeof res.body?.error === "string", "body.error is string");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });
}

suite.finishOrExit();
