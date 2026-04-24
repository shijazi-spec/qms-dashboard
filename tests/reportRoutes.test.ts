/**
 * Integration tests for src/mastra/routes/reportRoutes.ts
 *
 * Coverage matrix:
 *   - 401/403         → API endpoints require an authenticated reporting role.
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/reportRoutes.test.ts
 */

import { reportRoutes } from "../src/mastra/routes/reportRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("reportRoutes");

console.log("\n=== reportRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of reportRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(reportRoutes.length >= 1, "at least 1 route registered");
});

const apiRoutes = reportRoutes.filter((r) => r.path.startsWith("/api/"));

for (const route of apiRoutes) {
  const path = route.path;
  const method = route.method as string;
  await suite.test(`${method} ${path} — 401/403 without an authenticated reporting role`, async () => {
    const handler = await buildHandler(reportRoutes, path, method, { mastra: null });
    const ctx = makeContext({
      method,
      params: { id: "1" },
      body: ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined,
    }) as FakeContext & { html?: any };
    ctx.html = (body: string, status?: number) => ({ status: status ?? 200, body, headers: {} });
    const res = await handler(ctx);
    suite.expect(res.status === 401 || res.status === 403, `status 401/403, got ${res.status}`);
    suite.expect(typeof res.body?.error === "string", "body.error is string");
  });
}

suite.finishOrExit();
