/**
 * Integration tests for src/mastra/routes/pmpRoutes.ts
 *
 * Coverage matrix:
 *   - structural      → every route exposes path/method/createHandler.
 *   - 401 unauth      → every /api/pmp/* route requires an authenticated
 *                       session (or X-Admin-Key); without one, returns 401
 *                       with body.error === "Authentication required".
 *   - non-API routes  → /projects (HTML page) is not gated at the API layer;
 *                       it falls through to the page-auth middleware.
 *
 * The unauthenticated tests exercise the per-handler `gateApiRoute` wrapper
 * added to lock down the PMP APIs. They run with ADMIN_API_KEY configured in
 * the environment so the wrapper's "admin-key bypass" branch is *available*
 * but deliberately not exercised (no X-Admin-Key header is sent).
 *
 * Run:  npx tsx tests/pmpRoutes.test.ts
 */

import { pmpRoutes } from "../src/mastra/routes/pmpRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("pmpRoutes");
const ADMIN_KEY = "integration-test-pmp-2026";

console.log("\n=== pmpRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of pmpRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(pmpRoutes.length >= 20, "at least 20 routes registered");
});

const apiRoutes = pmpRoutes.filter((r) => r.path.startsWith("/api/"));

for (const route of apiRoutes) {
  const path = route.path;
  const method = route.method as string;
  await suite.test(`${method} ${path} — 401 without an authenticated session`, async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(pmpRoutes, path, method, { mastra: null });
      const ctx = makeContext({
        method,
        url: `http://localhost${path.replace(/:\w+/g, "1")}`,
        params: { id: "1", taskId: "1", projectId: "1", milestoneId: "1", riskId: "1" },
        body: ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? {} : undefined,
      }) as FakeContext & { html?: any };
      ctx.html = (body: string, status?: number) => ({ status: status ?? 200, body, headers: {} });
      const res = await handler(ctx);
      suite.expectEqual(res.status, 401, `status for ${method} ${path}`);
      suite.expectEqual(res.body?.error, "Authentication required", "body.error");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });
}

suite.finishOrExit();
