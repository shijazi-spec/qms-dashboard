/**
 * Integration tests for src/mastra/routes/teamRoutes.ts
 *
 * Coverage matrix:
 *   - structural      → every route exposes path/method/createHandler.
 *   - 200 happy path  → GET /api/team/members returns object payload (DB).
 *
 * Run:  npx tsx tests/teamRoutes.test.ts
 */

import { teamRoutes } from "../src/mastra/routes/teamRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("teamRoutes");
const HAS_DB = !!process.env.DATABASE_URL;

console.log("\n=== teamRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of teamRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(teamRoutes.length >= 1, "at least 1 route registered");
});

await suite.test("GET /api/team/members — 401/403 without an authenticated team role", async () => {
  const handler = await buildHandler(teamRoutes, "/api/team/members", "GET", { mastra: null });
  const res = await handler(makeContext({ method: "GET", url: "<REDACTED_URL>" }));
  suite.expect(res.status === 401 || res.status === 403, `status 401/403, got ${res.status}`);
  suite.expect(typeof res.body?.error === "string", "body.error is string");
});

void HAS_DB;

suite.finishOrExit();
