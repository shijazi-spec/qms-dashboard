/**
 * Integration tests for src/mastra/routes/kpiRoutes.ts
 *
 * Coverage matrix:
 *   - 403 forbidden   → every /api/kpis|/api/executive/* endpoint without an
 *                       authenticated KPI-read or KPI-write role.
 *   - structural      → every route exposes path/method/createHandler.
 *   - html            → /kpis serves dashboard html when present, 404 otherwise.
 *
 * Run:  npx tsx tests/kpiRoutes.test.ts
 */

import { existsSync } from "fs";
import { join } from "path";
import { kpiRoutes } from "../src/mastra/routes/kpiRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("kpiRoutes");

console.log("\n=== kpiRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of kpiRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(kpiRoutes.length >= 5, "at least 5 routes registered");
});

await suite.test("GET /kpis — html serve (200) when present, 404 otherwise", async () => {
  const handler = await buildHandler(kpiRoutes, "/kpis", "GET");
  const ctx = makeContext({ method: "GET" }) as FakeContext & { html?: any };
  let html: { body: string; status: number } | null = null;
  ctx.html = (body: string, status?: number) => {
    html = { body, status: status ?? 200 };
    return html;
  };
  const res = await handler(ctx);
  const present = existsSync(join(process.cwd(), "dashboard", "kpis.html"));
  if (present) {
    suite.expect(html !== null, "html() called");
  } else {
    suite.expectEqual(res.status, 404, "404 fallback");
  }
});

// HTML-serving and SOW/screenshots routes call c.html / c.get("mastra")
// which are dashboard-page concerns, not data-API auth boundaries — skip
// them here; their structural test already runs above.
const SKIP_PATHS = new Set(["/kpis", "/executive", "/mohammed-sow", "/docs/screenshots/:filename"]);

for (const route of kpiRoutes) {
  const path = route.path;
  const method = route.method as string;
  if (SKIP_PATHS.has(path)) continue;
  await suite.test(`${method} ${path} — 403 without a KPI role`, async () => {
    const handler = await buildHandler(kpiRoutes, path, method);
    const ctx = makeContext({
      method,
      params: { id: "1" },
      body: ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined,
    });
    const res = await handler(ctx);
    suite.expectEqual(res.status, 403, "status");
    suite.expect(typeof res.body?.error === "string", "body.error is string");
  });
}

suite.finishOrExit();
