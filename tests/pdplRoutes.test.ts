/**
 * Integration tests for src/mastra/routes/pdplRoutes.ts
 *
 * Coverage matrix:
 *   - 403 forbidden   → API endpoints require a PDPL/admin role; without one,
 *                       returns 403.
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/pdplRoutes.test.ts
 */

import { pdplRoutes } from "../src/mastra/routes/pdplRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("pdplRoutes");

console.log("\n=== pdplRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of pdplRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(pdplRoutes.length >= 1, "at least 1 route registered");
});

const apiRoutes = pdplRoutes.filter((r) => r.path.startsWith("/api/"));

for (const route of apiRoutes) {
  const path = route.path;
  const method = route.method as string;
  await suite.test(`${method} ${path} — 403 without a PDPL/admin role`, async () => {
    const handler = await buildHandler(pdplRoutes, path, method, { mastra: null });
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
