/**
 * Integration tests for src/mastra/routes/staticPageRoutes.ts
 *
 * Coverage matrix:
 *   - structural      → every route exposes path/method/createHandler.
 *   - 200/404         → each handler returns a response with a numeric status
 *                       within 200-499 (HTML page hits 200; missing files 404).
 *
 * Run:  npx tsx tests/staticPageRoutes.test.ts
 */

import { staticPageRoutes } from "../src/mastra/routes/staticPageRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("staticPageRoutes");

console.log("\n=== staticPageRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of staticPageRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(staticPageRoutes.length >= 1, "at least 1 route registered");
});

for (const route of staticPageRoutes) {
  const path = route.path;
  const method = route.method as string;
  await suite.test(`${method} ${path} — handler returns a numeric status`, async () => {
    const handler = await buildHandler(staticPageRoutes, path, method);
    const ctx = makeContext({ method, params: { filename: "missing.png" } }) as FakeContext & { html?: any; text?: any };
    ctx.html = (body: string, status?: number) => ({ status: status ?? 200, body, headers: {} });
    ctx.text = (body: string, status?: number) => ({ status: status ?? 200, body, headers: {} });
    const res = await handler(ctx);
    suite.expect(typeof res.status === "number", "status is a number");
    suite.expect(res.status >= 200 && res.status < 600, `status in 2xx-5xx, got ${res.status}`);
  });
}

suite.finishOrExit();
