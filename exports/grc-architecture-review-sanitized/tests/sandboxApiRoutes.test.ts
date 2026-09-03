/**
 * Integration tests for src/mastra/routes/sandboxApiRoutes.ts
 *
 * Coverage matrix:
 *   - structural      → every route exposes path/method/createHandler.
 *   - 401 unauth      → every /api/sandbox/* route requires an authenticated
 *                       session (or X-Admin-Key); without one, returns 401
 *                       with body.error === "Authentication required".
 *
 * The unauthenticated tests exercise the per-handler auth gate added to lock
 * down the sandbox APIs. They run with ADMIN_API_KEY configured in the
 * environment so the gate's "admin-key bypass" branch is *available* but
 * deliberately not exercised (no X-Admin-Key header is sent).
 *
 * Run:  npx tsx tests/sandboxApiRoutes.test.ts
 */

import { sandboxApiRoutes } from "../src/mastra/routes/sandboxApiRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("sandboxApiRoutes");
const ADMIN_KEY = "<REDACTED_SECRET>";

console.log("\n=== sandboxApiRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of sandboxApiRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(sandboxApiRoutes.length >= 1, "at least 1 route registered");
});

for (const route of sandboxApiRoutes) {
  const path = route.path;
  const method = route.method as string;
  await suite.test(`${method} ${path} — 401 without an authenticated session`, async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(sandboxApiRoutes, path, method, { mastra: null });
      const res = await handler(makeContext({
        method,
        body: ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined,
      }));
      suite.expectEqual(res.status, 401, `status for ${method} ${path}`);
      suite.expectEqual(res.body?.error, "Authentication required", "body.error");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });
}

suite.finishOrExit();
