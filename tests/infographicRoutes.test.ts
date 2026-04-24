/**
 * Integration tests for src/mastra/routes/infographicRoutes.ts
 *
 * Coverage matrix:
 *   - structural      → every route exposes path/method/createHandler.
 *   - 200/4xx         → handlers return a numeric status.
 *
 * Run:  npx tsx tests/infographicRoutes.test.ts
 */

import { infographicRoutes } from "../src/mastra/routes/infographicRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("infographicRoutes");

console.log("\n=== infographicRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of infographicRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(infographicRoutes.length >= 1, "at least 1 route registered");
});

for (const route of infographicRoutes) {
  const path = route.path;
  const method = route.method as string;
  await suite.test(`${method} ${path} — handler returns numeric status`, async () => {
    const handler = await buildHandler(infographicRoutes, path, method, { mastra: null });
    const ctx = makeContext({
      method,
      params: { id: "1", filename: "missing.png" },
      body: ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined,
    }) as FakeContext & { html?: any; text?: any };
    ctx.html = (body: string, status?: number) => ({ status: status ?? 200, body, headers: {} });
    ctx.text = (body: string, status?: number) => ({ status: status ?? 200, body, headers: {} });
    const res = await handler(ctx);
    suite.expect(typeof res.status === "number", "status is a number");
    suite.expect(res.status >= 200 && res.status < 600, `status in 2xx-5xx, got ${res.status}`);
  });
}

suite.finishOrExit();
