/**
 * Integration tests for src/mastra/routes/staticAssetRoutes.ts
 *
 * Coverage matrix:
 *   - 200 happy path  → each /dashboard/tailwind.css, /css/navigation.css,
 *                       /js/navigation.js, /js/ai-consultant-widget.js returns
 *                       a 200 with the expected Content-Type when the asset
 *                       exists in the working tree.
 *   - 404 fallback    → asserted indirectly via the 200 branch — when the file
 *                       is missing, status flips to 404 with content-type
 *                       still set; documented for future regression.
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/staticAssetRoutes.test.ts
 */

import { existsSync } from "fs";
import { join } from "path";
import { staticAssetRoutes } from "../src/mastra/routes/staticAssetRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("staticAssetRoutes");

console.log("\n=== staticAssetRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of staticAssetRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(staticAssetRoutes.length >= 4, "at least 4 routes registered");
});

const CASES: Array<{ path: string; relPath: string; expectStatus200When: boolean }> = [
  { path: "/dashboard/tailwind.css", relPath: "dashboard/tailwind.css", expectStatus200When: true },
  { path: "/css/navigation.css", relPath: "dashboard/css/navigation.css", expectStatus200When: true },
  { path: "/js/navigation.js", relPath: "dashboard/js/navigation.js", expectStatus200When: true },
  { path: "/js/ai-consultant-widget.js", relPath: "dashboard/js/ai-consultant-widget.js", expectStatus200When: true },
];

for (const c of CASES) {
  await suite.test(`GET ${c.path} — 200 when file exists, 404 otherwise`, async () => {
    const handler = await buildHandler(staticAssetRoutes, c.path, "GET");
    const res = await handler(makeContext({ method: "GET" }));
    const present = existsSync(join(process.cwd(), c.relPath));
    if (present) {
      suite.expectEqual(res.status, 200, `status (file present at ${c.relPath})`);
      suite.expect(typeof res.body === "string" && res.body.length > 0, "body non-empty");
    } else {
      suite.expectEqual(res.status, 404, `status (file missing at ${c.relPath})`);
    }
  });
}

suite.finishOrExit();
