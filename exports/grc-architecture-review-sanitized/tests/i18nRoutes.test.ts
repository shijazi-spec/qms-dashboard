/**
 * Integration tests for src/mastra/routes/i18nRoutes.ts
 *
 * Coverage matrix:
 *   - 200 happy path  → GET  /api/user/language-preference (no session → lang:null)
 *                       POST /api/user/language-preference (no session, valid lang
 *                       → returns success without persistence)
 *   - 400 bad input   → POST /api/user/language-preference with unsupported lang
 *                       (e.g. "fr"), and with missing body
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/i18nRoutes.test.ts
 */

import { i18nRoutes } from "../src/mastra/routes/i18nRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("i18nRoutes");

console.log("\n=== i18nRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of i18nRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(i18nRoutes.length >= 2, "at least 2 routes registered");
});

await suite.test("GET /api/user/language-preference — 200 with lang:null when no session cookie", async () => {
  const handler = await buildHandler(i18nRoutes, "/api/user/language-preference", "GET");
  const res = await handler(makeContext({ method: "GET" }));
  suite.expectEqual(res.status, 200, "status");
  suite.expectEqual(res.body?.lang, null, "body.lang is null without session");
});

await suite.test("POST /api/user/language-preference — 200 success (no session) with valid lang 'ar'", async () => {
  const handler = await buildHandler(i18nRoutes, "/api/user/language-preference", "POST");
  const res = await handler(makeContext({ method: "POST", body: { lang: "ar" } }));
  suite.expectEqual(res.status, 200, "status");
  suite.expectEqual(res.body?.success, true, "body.success");
  suite.expectEqual(res.body?.lang, "ar", "body.lang");
});

await suite.test("POST /api/user/language-preference — 400 on unsupported lang", async () => {
  const handler = await buildHandler(i18nRoutes, "/api/user/language-preference", "POST");
  const res = await handler(makeContext({ method: "POST", body: { lang: "fr" } }));
  suite.expectEqual(res.status, 400, "status");
  suite.expectEqual(res.body?.error, "Unsupported language", "body.error");
});

await suite.test("POST /api/user/language-preference — 400 when body is missing (catch-empty)", async () => {
  const handler = await buildHandler(i18nRoutes, "/api/user/language-preference", "POST");
  // body omitted → makeContext.req.json throws SyntaxError → handler swallows
  // it (try/catch around req.json) and treats body as {}, lang as undefined,
  // then returns 400 'Unsupported language'.
  const res = await handler(makeContext({ method: "POST" }));
  suite.expectEqual(res.status, 400, "status");
  suite.expectEqual(res.body?.error, "Unsupported language", "body.error");
});

suite.finishOrExit();
