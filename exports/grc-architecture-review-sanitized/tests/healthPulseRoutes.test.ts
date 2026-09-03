/**
 * Integration tests for src/mastra/routes/healthPulseRoutes.ts
 *
 * Coverage matrix:
 *   - 403 forbidden   → every endpoint without admin key or admin role.
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/healthPulseRoutes.test.ts
 */

import { healthPulseRoutes } from "../src/mastra/routes/healthPulseRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("healthPulseRoutes");

console.log("\n=== healthPulseRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of healthPulseRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(healthPulseRoutes.length >= 3, "at least 3 routes registered");
});

const ROUTES: Array<[string, string]> = [
  ["/api/health/pulse", "GET"],
  ["/api/health/pulse/latest", "GET"],
  ["/api/health/pulse/run", "POST"],
];

for (const [p, m] of ROUTES) {
  await suite.test(`${m} ${p} — 403 without admin key or admin role`, async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = "integration-test-health-pulse-2026";
    try {
      const handler = await buildHandler(healthPulseRoutes, p, m);
      const res = await handler(makeContext({ method: m }));
      suite.expectEqual(res.status, 403, "status");
      suite.expectEqual(res.body?.error, "Unauthorized", "body.error");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });
}

suite.finishOrExit();
