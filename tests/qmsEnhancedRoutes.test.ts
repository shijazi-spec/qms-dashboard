/**
 * Integration tests for src/mastra/routes/qmsEnhancedRoutes.ts
 *
 * Coverage matrix:
 *   - structural      → every route exposes path/method/createHandler.
 *   - 401 unauth      → every /api/* evidence/CAPA/export endpoint requires
 *                       an authenticated session (or X-Admin-Key); without
 *                       one, returns 401 with body.error === "Authentication
 *                       required".
 *
 * The unauthenticated tests exercise the per-handler `gateApiRoute` wrapper
 * added to lock down the QMS-enhanced APIs. Inner role checks (e.g. the
 * admin-only XLSX exports) still apply for authenticated callers — but the
 * outer gate ensures unauthenticated traffic is rejected before any business
 * logic or DB access runs.
 *
 * Run:  npx tsx tests/qmsEnhancedRoutes.test.ts
 */

import { qmsEnhancedRoutes } from "../src/mastra/routes/qmsEnhancedRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("qmsEnhancedRoutes");
const ADMIN_KEY = "integration-test-qms-enh-2026";

console.log("\n=== qmsEnhancedRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of qmsEnhancedRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(qmsEnhancedRoutes.length >= 10, "at least 10 routes registered");
});

const apiRoutes = qmsEnhancedRoutes.filter((r) => r.path.startsWith("/api/"));

for (const route of apiRoutes) {
  const path = route.path;
  const method = route.method as string;
  await suite.test(`${method} ${path} — 401 without an authenticated session`, async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(qmsEnhancedRoutes, path, method, { mastra: null });
      const res = await handler(makeContext({
        method,
        url: `http://localhost${path.replace(/:\w+/g, "1")}`,
        params: { id: "1", entityType: "policy", entityId: "1" },
        body: ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? {} : undefined,
      }));
      suite.expectEqual(res.status, 401, `status for ${method} ${path}`);
      suite.expectEqual(res.body?.error, "Authentication required", "body.error");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });
}

suite.finishOrExit();
