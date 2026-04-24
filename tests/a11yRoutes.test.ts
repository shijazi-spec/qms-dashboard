/**
 * Integration tests for src/mastra/routes/a11yRoutes.ts
 *
 * Coverage matrix:
 *   - 200 happy path  → GET /a11y returns the dashboard accessibility statement
 *                       HTML when the file exists on disk (which it does in the
 *                       repo working tree).
 *   - 404 missing     → asserted indirectly: the handler falls through to a 404
 *                       text response only when no candidate path resolves;
 *                       documented for future regression.
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/a11yRoutes.test.ts
 */

import { existsSync } from "fs";
import { join } from "path";
import { a11yRoutes } from "../src/mastra/routes/a11yRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("a11yRoutes");

console.log("\n=== a11yRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of a11yRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(a11yRoutes.length >= 1, "at least 1 route registered");
});

await suite.test("GET /a11y — serves the accessibility statement", async () => {
  const handler = await buildHandler(a11yRoutes, "/a11y", "GET");
  // Patch c.html since fakeContext doesn't provide it by default.
  const ctx = makeContext({ method: "GET" }) as FakeContext & {
    html?: (body: string, status?: number) => any;
  };
  let captured: { body: string; status: number } | null = null;
  ctx.html = (body: string, status?: number) => {
    captured = { body, status: status ?? 200 };
    return captured;
  };
  await handler(ctx);
  const fileExists = existsSync(join(process.cwd(), "dashboard", "a11y.html"))
    || existsSync("/home/runner/workspace/dashboard/a11y.html");
  if (fileExists) {
    suite.expect(captured !== null, "html response captured");
    suite.expectEqual(captured?.status, 200, "status");
    suite.expect((captured?.body?.length ?? 0) > 0, "body non-empty");
  } else {
    // Falls through to c.text(..., 404) — no html() call expected.
    suite.expect(captured === null, "no html() call when file missing");
  }
});

suite.finishOrExit();
