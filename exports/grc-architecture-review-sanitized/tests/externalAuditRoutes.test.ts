/**
 * Integration tests for src/mastra/routes/externalAuditRoutes.ts
 *
 * Coverage matrix:
 *   - 401 unauth      → every endpoint without an authenticated session.
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/externalAuditRoutes.test.ts
 */

import { externalAuditRoutes } from "../src/mastra/routes/externalAuditRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("externalAuditRoutes");

console.log("\n=== externalAuditRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of externalAuditRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(externalAuditRoutes.length >= 4, "at least 4 routes registered");
});

for (const route of externalAuditRoutes) {
  const path = route.path;
  const method = route.method as string;
  await suite.test(`${method} ${path} — 401 without an authenticated session`, async () => {
    const handler = await buildHandler(externalAuditRoutes, path, method);
    const res = await handler(makeContext({
      method,
      params: { id: "1", itemId: "1" },
      body: ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined,
    }));
    suite.expectEqual(res.status, 401, "status");
    suite.expect(typeof res.body?.error === "string", "body.error is string");
  });
}

suite.finishOrExit();
