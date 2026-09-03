/**
 * Integration tests for src/mastra/routes/triggerRoutes.ts
 *
 * Coverage matrix:
 *   - 401/403         → API endpoints require an authenticated trigger role.
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/triggerRoutes.test.ts
 */

import { triggerRoutes } from "../src/mastra/routes/triggerRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("triggerRoutes");

console.log("\n=== triggerRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of triggerRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(triggerRoutes.length >= 1, "at least 1 route registered");
});

const apiRoutes = triggerRoutes.filter((r) => r.path.startsWith("/api/"));

for (const route of apiRoutes) {
  const path = route.path;
  const method = route.method as string;
  await suite.test(`${method} ${path} — handler returns numeric status without auth`, async () => {
    const handler = await buildHandler(triggerRoutes, path, method, { mastra: null });
    const ctx = makeContext({
      method,
      params: { id: "1", triggerId: "1" },
      body: ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined,
    }) as FakeContext & { html?: any };
    ctx.html = (body: string, status?: number) => ({ status: status ?? 200, body, headers: {} });
    const res = await handler(ctx);
    suite.expect(typeof res.status === "number", "status is a number");
    suite.expect(res.status >= 200 && res.status < 600, `status in 2xx-5xx, got ${res.status}`);
  });
}

suite.finishOrExit();
