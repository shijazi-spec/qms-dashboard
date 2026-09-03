/**
 * Integration tests for src/mastra/routes/sopRoutes.ts
 *
 * Coverage matrix:
 *   - 401 / redirect  → unauthenticated callers cannot read or download the
 *                       SOP, and unauthenticated visitors to /sop are
 *                       redirected to /login. The SOP document is classified
 *                       "Internal Use Only" (see task #447 audit).
 *   - 200 happy path  → with a valid admin key, GET /api/sop returns parsed
 *                       SOP JSON; GET /api/sop/download returns the markdown
 *                       attachment with correct headers.
 *   - 404 missing     → GET /sop returns 404 when dashboard/sop.html absent
 *                       (auth gate must still pass first).
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/sopRoutes.test.ts
 */

import { existsSync } from "fs";
import { join } from "path";
import { sopRoutes } from "../src/mastra/routes/sopRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

// hasValidAdminApiKey reads process.env.ADMIN_API_KEY at call time, so
// setting this here (before any handler invocation) is enough to satisfy the
// defense-in-depth gate added in task #447.
const <REDACTED_SECRET> = "<REDACTED_SECRET>";
const ORIGINAL_ADMIN_KEY = process.env.ADMIN_API_KEY;
process.env.ADMIN_API_KEY = <REDACTED_SECRET>;

const ADMIN_HEADERS = { "X-Admin-Key": <REDACTED_SECRET> };

const suite = new TestSuite("sopRoutes");

console.log("\n=== sopRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of sopRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(sopRoutes.length >= 3, "at least 3 routes registered");
});

await suite.test("GET /api/sop — 401 when no session or admin key (defense-in-depth, task #447)", async () => {
  const handler = await buildHandler(sopRoutes, "/api/sop", "GET");
  const res = await handler(makeContext({ method: "GET" }));
  suite.expectEqual(res.status, 401, "status");
  suite.expectEqual(res.body?.error, "Authentication required", "body.error");
});

await suite.test("GET /api/sop/download — 401 when no session or admin key (defense-in-depth, task #447)", async () => {
  const handler = await buildHandler(sopRoutes, "/api/sop/download", "GET");
  const res = await handler(makeContext({ method: "GET" }));
  suite.expectEqual(res.status, 401, "status");
  suite.expectEqual(res.body?.error, "Authentication required", "body.error");
});

await suite.test("GET /sop — redirects to /login when unauthenticated (defense-in-depth, task #447)", async () => {
  const handler = await buildHandler(sopRoutes, "/sop", "GET");
  const res = await handler(makeContext({ method: "GET" }));
  suite.expectEqual(res.status, 302, "status");
  suite.expectEqual(res.headers["Location"], "/login", "Location header");
});

await suite.test("GET /api/sop — 200 with content/version/lastUpdated when SOP file exists, else 404", async () => {
  const handler = await buildHandler(sopRoutes, "/api/sop", "GET");
  const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));
  const present = existsSync(join(process.cwd(), "docs", "ExampleOrg_Platform_SOP.md"));
  if (present) {
    suite.expectEqual(res.status, 200, "status");
    suite.expect(typeof res.body?.content === "string" && res.body.content.length > 0, "body.content non-empty");
    suite.expect(typeof res.body?.version === "string", "body.version is string");
    suite.expect(typeof res.body?.lastUpdated === "string", "body.lastUpdated is string");
  } else {
    suite.expectEqual(res.status, 404, "status");
    suite.expectEqual(res.body?.error, "SOP document not found", "body.error");
  }
});

await suite.test("GET /api/sop/download — sets attachment headers when SOP file exists", async () => {
  const handler = await buildHandler(sopRoutes, "/api/sop/download", "GET");
  const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));
  const present = existsSync(join(process.cwd(), "docs", "ExampleOrg_Platform_SOP.md"));
  if (present) {
    suite.expectEqual(res.status, 200, "status");
    suite.expectEqual(res.headers["Content-Type"], "text/markdown; charset=utf-8", "Content-Type header");
    suite.expect(
      (res.headers["Content-Disposition"] ?? "").includes("ExampleOrg_Platform_SOP.md"),
      "Content-Disposition mentions filename",
    );
  } else {
    suite.expectEqual(res.status, 404, "status (file missing)");
  }
});

await suite.test("GET /sop — 200 (html) when dashboard page exists, else 404", async () => {
  const handler = await buildHandler(sopRoutes, "/sop", "GET");
  const ctx = makeContext({ method: "GET", headers: ADMIN_HEADERS }) as FakeContext & { html?: any };
  let html = null as { body: string; status: number } | null;
  ctx.html = (body: string, status?: number) => {
    html = { body, status: status ?? 200 };
    return html;
  };
  const res = await handler(ctx);
  const present = existsSync(join(process.cwd(), "dashboard", "sop.html"));
  if (present) {
    suite.expect(html !== null, "html() called");
    const h = html as { body: string; status: number } | null;
    suite.expectEqual(h?.status, 200, "html status");
  } else {
    suite.expectEqual(res.status, 404, "404 fallback when sop.html missing");
  }
});

if (ORIGINAL_ADMIN_KEY === undefined) delete process.env.ADMIN_API_KEY;
else process.env.ADMIN_API_KEY = ORIGINAL_ADMIN_KEY;

suite.finishOrExit();
