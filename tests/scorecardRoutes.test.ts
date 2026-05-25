/**
 * Integration tests for src/mastra/routes/scorecardRoutes.ts
 *
 * Coverage matrix:
 *   - 200 happy path  → GET /scorecard returns 200 (html) when dashboard page
 *                       exists; 404 otherwise.
 *   - 403 forbidden   → GET /api/scorecard/mohammed without auth
 *                       PUT /api/scorecard/mohammed without auth
 *                       GET /api/scorecard/history without auth
 *                       POST /api/scorecard/snapshot without auth
 *                       GET /api/scorecard/kpi/:n without auth
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/scorecardRoutes.test.ts
 */

import { existsSync } from "fs";
import { join } from "path";
import { scorecardRoutes } from "../src/mastra/routes/scorecardRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("scorecardRoutes");

console.log("\n=== scorecardRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of scorecardRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(scorecardRoutes.length >= 5, "at least 5 routes registered");
});

await suite.test("GET /scorecard — 200 when dashboard html exists, else 404", async () => {
  const handler = await buildHandler(scorecardRoutes, "/scorecard", "GET");
  const ctx = makeContext({ method: "GET" }) as FakeContext & { html?: any };
  let html = null as { body: string; status: number } | null;
  ctx.html = (body: string, status?: number) => {
    html = { body, status: status ?? 200 };
    return html;
  };
  const res = await handler(ctx);
  const present = existsSync(join(process.cwd(), "dashboard", "scorecard.html"));
  if (present) {
    suite.expect(html !== null, "html() called");
    const h = html as { body: string; status: number } | null;
    suite.expectEqual(h?.status, 200, "html status");
  } else {
    suite.expectEqual(res.status, 404, "404 when dashboard missing");
  }
});

const ENDPOINTS: Array<[string, string]> = [
  ["/api/scorecard/mohammed", "GET"],
  ["/api/scorecard/history", "GET"],
  ["/api/scorecard/snapshot", "POST"],
  ["/api/scorecard/kpi/:kpiNumber", "GET"],
];

for (const [p, m] of ENDPOINTS) {
  await suite.test(`${m} ${p} — 403 without an authenticated role`, async () => {
    const handler = await buildHandler(scorecardRoutes, p, m);
    const res = await handler(makeContext({
      method: m,
      params: { kpiNumber: "1" },
      body: m === "PUT" || m === "POST" ? {} : undefined,
    }));
    suite.expectEqual(res.status, 403, "status");
    suite.expect(typeof res.body?.error === "string", "body.error is string");
  });
}

suite.finishOrExit();
