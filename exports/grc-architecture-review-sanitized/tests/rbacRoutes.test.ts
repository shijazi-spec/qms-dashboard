/**
 * Integration tests for src/mastra/routes/rbacRoutes.ts
 *
 * Coverage matrix:
 *   - 401 unauth      → every endpoint requires admin (key or role); without
 *                       either, returns 401 'Authentication required'.
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/rbacRoutes.test.ts
 */

import { rbacRoutes } from "../src/mastra/routes/rbacRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("rbacRoutes");

console.log("\n=== rbacRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of rbacRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(rbacRoutes.length >= 3, "at least 3 routes registered");
});

for (const route of rbacRoutes) {
  const path = route.path;
  const method = route.method as string;
  await suite.test(`${method} ${path} — 401 without admin key or admin role`, async () => {
    const handler = await buildHandler(rbacRoutes, path, method, { mastra: null });
    const res = await handler(makeContext({
      method,
      params: { email: "user@example.invalid", id: "1" },
      url: `<REDACTED_URL>":email", "x%<REDACTED_HOST>").replace(":id", "1")}`,
      body: ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined,
    }));
    suite.expectEqual(res.status, 401, "status");
    suite.expectEqual(res.body?.error, "Authentication required", "body.error");
  });
}

suite.finishOrExit();
