/**
 * Integration tests for src/mastra/routes/knowledgeRoutes.ts
 *
 * Coverage matrix:
 *   - 403 forbidden   → every /api/knowledge/* endpoint without an authenticated
 *                       role (read/write/delete each have their own role lists).
 *   - 400 bad input   → DELETE /api/knowledge/documents/:id with non-numeric id
 *                       (note: this requires a delete-permitted role to reach
 *                       the validation layer; we only assert the 403 boundary).
 *                       GET /api/checklists/:id with non-numeric id (no auth).
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Note: /api/checklists/* routes have no auth gate by design (they're intended
 * for internal/automation use); only their input-validation paths are asserted.
 *
 * Run:  npx tsx tests/knowledgeRoutes.test.ts
 */

import { knowledgeRoutes } from "../src/mastra/routes/knowledgeRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";
import { makeCookieForRole } from "./_helpers/sessionAuth";

const suite = new TestSuite("knowledgeRoutes");
// Signed ExampleOrg_session cookie for an active admin platform user. The
// checklist routes call requireRole() (live getPlatformUser() lookup) BEFORE
// validating the :id param, so reaching the id->400 branch requires a valid
// authenticated session. The shared helper also registers an active
// platform_users row for this session's email.
const ADMIN_COOKIE = makeCookieForRole("admin");

console.log("\n=== knowledgeRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of knowledgeRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(knowledgeRoutes.length >= 4, "at least 4 routes registered");
});

const AUTH_GATED: Array<[string, string]> = [
  ["/api/knowledge/documents", "GET"],
  ["/api/knowledge/upload", "POST"],
  ["/api/knowledge/search", "GET"],
  ["/api/knowledge/documents/:id", "DELETE"],
];

for (const [p, m] of AUTH_GATED) {
  await suite.test(`${m} ${p} — 403 without an authenticated role`, async () => {
    const handler = await buildHandler(knowledgeRoutes, p, m);
    const res = await handler(makeContext({
      method: m,
      params: { id: "1" },
      body: m === "POST" ? {} : undefined,
    }));
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  });
}

// /api/checklists/:id now runs requireRole() BEFORE the isNaN(id)->400 check,
// so the auth gate precedes id-validation: an unauthenticated caller gets 403
// (never reaching the id check), and only an authenticated caller with a bad id
// reaches the 400 branch.
await suite.test("GET /api/checklists/:id — 403 without an authenticated role (auth gate precedes id check)", async () => {
  const handler = await buildHandler(knowledgeRoutes, "/api/checklists/:id", "GET");
  const res = await handler(makeContext({ method: "GET", params: { id: "abc" } }));
  suite.expectEqual(res.status, 403, "status");
  suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
});

await suite.test("GET /api/checklists/:id — 400 with non-numeric id when authenticated", async () => {
  const handler = await buildHandler(knowledgeRoutes, "/api/checklists/:id", "GET");
  const res = await handler(makeContext({
    method: "GET",
    headers: { Cookie: ADMIN_COOKIE },
    params: { id: "abc" },
  }));
  suite.expectEqual(res.status, 400, "status");
  suite.expectEqual(res.body?.error, "Invalid ID", "body.error");
});

await suite.test("POST /api/checklists/:id/run — 403 without an authenticated role (auth gate precedes id check)", async () => {
  const handler = await buildHandler(knowledgeRoutes, "/api/checklists/:id/run", "POST");
  const res = await handler(makeContext({ method: "POST", params: { id: "abc" } }));
  suite.expectEqual(res.status, 403, "status");
  suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
});

await suite.test("POST /api/checklists/:id/run — 400 with non-numeric id when authenticated", async () => {
  const handler = await buildHandler(knowledgeRoutes, "/api/checklists/:id/run", "POST");
  const res = await handler(makeContext({
    method: "POST",
    headers: { Cookie: ADMIN_COOKIE },
    params: { id: "abc" },
  }));
  suite.expectEqual(res.status, 400, "status");
  suite.expectEqual(res.body?.error, "Invalid ID", "body.error");
});

suite.finishOrExit();
