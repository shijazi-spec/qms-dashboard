/**
 * Integration tests for src/mastra/routes/userAccessRoutes.ts
 *
 * Coverage matrix:
 *   - 401/403         → API endpoints require an admin role.
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Run:  npx tsx tests/userAccessRoutes.test.ts
 */

import { userAccessRoutes } from "../src/mastra/routes/userAccessRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("userAccessRoutes");

console.log("\n=== userAccessRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of userAccessRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(userAccessRoutes.length >= 1, "at least 1 route registered");
});

// /api/invitations/validate/:token and /api/invitations/accept are public
// (the invitee hits them before they have a session). Skip those.
const PUBLIC_PATHS = new Set([
  "/api/invitations/validate/:token",
  "/api/invitations/accept",
]);
const apiRoutes = userAccessRoutes.filter(
  (r) => r.path.startsWith("/api/") && !PUBLIC_PATHS.has(r.path),
);

for (const route of apiRoutes) {
  const path = route.path;
  const method = route.method as string;
  await suite.test(`${method} ${path} — 401/403 without an admin role`, async () => {
    const handler = await buildHandler(userAccessRoutes, path, method, { mastra: null });
    const ctx = makeContext({
      method,
      params: { id: "1", email: "<REDACTED_EMAIL>" },
      body: ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined,
    }) as FakeContext & { html?: any };
    ctx.html = (body: string, status?: number) => ({ status: status ?? 200, body, headers: {} });
    const res = await handler(ctx);
    suite.expect(res.status === 401 || res.status === 403, `status 401/403, got ${res.status}`);
    suite.expect(typeof res.body?.error === "string", "body.error is string");
  });
}

suite.finishOrExit();
