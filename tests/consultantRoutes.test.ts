/**
 * Integration tests for src/mastra/routes/consultantRoutes.ts
 *
 * Coverage matrix:
 *   - 403 forbidden   → API endpoints guarded by CONSULTANT_ROLES require an
 *                       authenticated admin/ai_specialist/grc_manager/HoOQ.
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/consultantRoutes.test.ts
 */

import { consultantRoutes } from "../src/mastra/routes/consultantRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("consultantRoutes");

console.log("\n=== consultantRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of consultantRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(consultantRoutes.length >= 3, "at least 3 routes registered");
});

const apiRoutes = consultantRoutes.filter((r) => r.path.startsWith("/api/"));
suite.expect(apiRoutes.length > 0, "filter yields at least one API route");

for (const route of apiRoutes) {
  const path = route.path;
  const method = route.method as string;
  await suite.test(`${method} ${path} — 403 without consultant role`, async () => {
    const handler = await buildHandler(consultantRoutes, path, method);
    const ctx = makeContext({
      method,
      params: { id: "1", alertId: "1" },
      body: ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined,
    }) as FakeContext & { html?: any };
    ctx.html = (body: string, status?: number) => ({ status: status ?? 200, body, headers: {} });
    const res = await handler(ctx);
    suite.expectEqual(res.status, 403, "status");
    suite.expect(typeof res.body?.error === "string", "body.error is string");
  });
}

suite.finishOrExit();
