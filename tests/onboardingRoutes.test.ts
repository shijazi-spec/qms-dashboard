/**
 * Integration tests for src/mastra/routes/onboardingRoutes.ts
 *
 * Coverage matrix:
 *   - 401 unauth      → status endpoints require an authenticated session.
 *   - 403 forbidden   → admin/grc_manager-only endpoints (stats, demo-link CRUD).
 *   - public/structural → tour-steps and tooltips are public; we just confirm
 *                       structural integrity for them.
 *
 * Run:  npx tsx tests/onboardingRoutes.test.ts
 */

import { onboardingRoutes } from "../src/mastra/routes/onboardingRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("onboardingRoutes");

console.log("\n=== onboardingRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of onboardingRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(onboardingRoutes.length >= 8, "at least 8 routes registered");
});

const SESSION_PATHS = [
  ["/api/onboarding/status", "GET"],
  ["/api/onboarding/status", "POST"],
] as const;

const ADMIN_PATHS = [
  ["/api/onboarding/stats", "GET"],
  ["/api/onboarding/demo-link", "POST"],
  ["/api/onboarding/demo-links", "GET"],
  ["/api/onboarding/demo-link/:linkCode/deactivate", "POST"],
] as const;

for (const [path, method] of SESSION_PATHS) {
  await suite.test(`${method} ${path} — 401 without an authenticated session`, async () => {
    const handler = await buildHandler(onboardingRoutes, path, method, { mastra: null });
    const res = await handler(makeContext({
      method,
      body: method === "POST" ? {} : undefined,
    }));
    suite.expectEqual(res.status, 401, "status");
    suite.expectEqual(res.body?.error, "Authentication required", "body.error");
  });
}

for (const [path, method] of ADMIN_PATHS) {
  await suite.test(`${method} ${path} — 403 without an admin role`, async () => {
    const handler = await buildHandler(onboardingRoutes, path, method, { mastra: null });
    const res = await handler(makeContext({
      method,
      params: { linkCode: "abc" },
      body: method === "POST" ? {} : undefined,
    }));
    suite.expectEqual(res.status, 403, "status");
    suite.expect(typeof res.body?.error === "string", "body.error is string");
  });
}

suite.finishOrExit();
