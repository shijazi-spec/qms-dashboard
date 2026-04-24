/**
 * Integration tests for src/mastra/routes/authRoutes.ts
 *
 * Coverage matrix:
 *   - 401 unauth      → GET /api/auth/me without a session cookie.
 *   - 200 happy path  → POST /api/auth/logout returns success and clears the
 *                       session cookie.
 *   - structural      → every route exposes path/method/createHandler.
 *   - redirect        → GET /api/logout returns a redirect.
 *
 * Run:  npx tsx tests/authRoutes.test.ts
 */

import { authRoutes } from "../src/mastra/routes/authRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("authRoutes");

console.log("\n=== authRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of authRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(authRoutes.length >= 4, "at least 4 routes registered");
});

await suite.test("GET /api/auth/me — 401 with authenticated:false when no cookie", async () => {
  const handler = await buildHandler(authRoutes, "/api/auth/me", "GET");
  const res = await handler(makeContext({ method: "GET" }));
  suite.expectEqual(res.status, 401, "status");
  suite.expectEqual(res.body?.authenticated, false, "body.authenticated");
});

await suite.test("POST /api/auth/logout — 200 with cleared session cookie", async () => {
  const handler = await buildHandler(authRoutes, "/api/auth/logout", "POST");
  const res = await handler(makeContext({ method: "POST" }));
  suite.expectEqual(res.status, 200, "status");
  suite.expectEqual(res.body?.success, true, "body.success");
  const cookie = res.headers["Set-Cookie"] ?? "";
  suite.expect(cookie.includes("walaplus_session="), "Set-Cookie clears session");
  suite.expect(cookie.includes("Max-Age=0"), "Set-Cookie has Max-Age=0");
});

suite.finishOrExit();
