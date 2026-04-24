/**
 * Integration tests for src/mastra/routes/sandboxApiRoutes.ts
 *
 * Coverage matrix:
 *   - structural      → every route exposes path/method/createHandler.
 *   - 200 happy path  → GET /api/sandbox/mode returns the current data mode
 *                       without contacting any external CRM/calendar APIs.
 *
 * Note: The other sandbox endpoints fan out to Zoho CRM and Google Calendar
 * which we deliberately avoid here — they're exercised by the dedicated CRM
 * and calendar integration tests.
 *
 * Run:  npx tsx tests/sandboxApiRoutes.test.ts
 */

import { sandboxApiRoutes } from "../src/mastra/routes/sandboxApiRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("sandboxApiRoutes");

console.log("\n=== sandboxApiRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of sandboxApiRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(sandboxApiRoutes.length >= 1, "at least 1 route registered");
});

await suite.test("GET /api/sandbox/mode — 200 with mode + description", async () => {
  const handler = await buildHandler(sandboxApiRoutes, "/api/sandbox/mode", "GET", { mastra: null });
  const res = await handler(makeContext({ method: "GET" }));
  suite.expectEqual(res.status, 200, "status");
  suite.expect(typeof res.body?.mode === "string", "body.mode is string");
  suite.expect(typeof res.body?.description === "string", "body.description is string");
});

suite.finishOrExit();
