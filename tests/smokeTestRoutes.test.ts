/**
 * Integration tests for src/mastra/routes/smokeTestRoutes.ts
 *
 * Coverage matrix:
 *   - 200 happy path  → GET /api/health (always 200, no DB required, returns
 *                       status/timestamp/uptime/version).
 *   - 200 with checks → GET /api/smoke (returns 200 with checks payload; the
 *                       overall health bit is data-dependent so we only assert
 *                       the response shape, not the value).
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/smokeTestRoutes.test.ts
 */

import { smokeTestRoutes } from "../src/mastra/routes/smokeTestRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("smokeTestRoutes");

console.log("\n=== smokeTestRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of smokeTestRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(smokeTestRoutes.length >= 2, "at least 2 routes registered");
});

await suite.test("GET /api/health — 200 always (no DB, no auth)", async () => {
  const handler = await buildHandler(smokeTestRoutes, "/api/health", "GET");
  const res = await handler(makeContext({ method: "GET" }));
  suite.expectEqual(res.status, 200, "status");
  suite.expectEqual(res.body?.status, "ok", "body.status");
  suite.expect(typeof res.body?.timestamp === "string", "body.timestamp is string");
  suite.expect(typeof res.body?.uptime === "number", "body.uptime is number");
  suite.expect(typeof res.body?.version === "string", "body.version is string");
});

await suite.test("GET /api/smoke — 200 with checks object (shape only)", async () => {
  const handler = await buildHandler(smokeTestRoutes, "/api/smoke", "GET");
  const res = await handler(makeContext({ method: "GET" }));
  suite.expectEqual(res.status, 200, "status");
  suite.expect(typeof res.body?.status === "string", "body.status is string");
  suite.expect(res.body?.checks && typeof res.body.checks === "object", "body.checks is object");
  suite.expect(typeof res.body?.checks?.database?.status === "string", "checks.database.status present");
  suite.expect(typeof res.body?.checks?.environment?.status === "string", "checks.environment.status present");
  suite.expect(typeof res.body?.checks?.zoho?.status === "string", "checks.zoho.status present");
  suite.expect(typeof res.body?.timestamp === "string", "body.timestamp is string");
});

suite.finishOrExit();
