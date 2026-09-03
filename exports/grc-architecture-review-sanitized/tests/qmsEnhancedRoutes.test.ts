/**
 * Integration tests for src/mastra/routes/qmsEnhancedRoutes.ts
 *
 * Coverage matrix:
 *   - structural      → every route exposes path/method/createHandler.
 *   - 401 unauth      → every /api/* endpoint rejects unauthenticated callers.
 *   - 403 non-QMS     → QMS-gated routes (evidence write, bulk-update, history,
 *                       approve-closure, effectiveness) return 403 for an
 *                       authenticated session whose role is NOT in QMS_ROLES
 *                       (e.g. department_viewer or bu_owner).
 *
 * The 401 tests exercise the per-handler `gateApiRoute` outer auth gate.
 * The 403 tests exercise the per-route role guard added to restrict QMS write
 * and sensitive-read endpoints to admin / quality_manager /
 * head_of_operations_quality / grc_manager.
 *
 * Run:  npx tsx tests/qmsEnhancedRoutes.test.ts
 */

import crypto from "crypto";
import { qmsEnhancedRoutes } from "../src/mastra/routes/qmsEnhancedRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("qmsEnhancedRoutes");
const ADMIN_KEY = "<REDACTED_SECRET>";
const <REDACTED_SECRET> = "<REDACTED_SECRET>";
const SESSION_COOKIE_NAME = "ExampleOrg_session";

console.log("\n=== qmsEnhancedRoutes integration tests ===\n");

function signFakeSession(payload: Record<string, unknown>, secret: string): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function makeCookieForRole(role: string): string {
  const token = signFakeSession(
    { userId: 99, email: `<REDACTED_EMAIL>`, name: "Test User", role, exp: Date.now() + 3_600_000 },
    <REDACTED_SECRET>,
  );
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
}

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of qmsEnhancedRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(qmsEnhancedRoutes.length >= 10, "at least 10 routes registered");
});

const apiRoutes = qmsEnhancedRoutes.filter((r) => r.path.startsWith("/api/"));

for (const route of apiRoutes) {
  const path = route.path;
  const method = route.method as string;
  await suite.test(`${method} ${path} — 401 without an authenticated session`, async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(qmsEnhancedRoutes, path, method, { mastra: null });
      const res = await handler(makeContext({
        method,
        url: `<REDACTED_URL> "1")}`,
        params: { id: "1", entityType: "policy", entityId: "1" },
        body: ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? {} : undefined,
      }));
      suite.expectEqual(res.status, 401, `status for ${method} ${path}`);
      suite.expectEqual(res.body?.error, "Authentication required", "body.error");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });
}

const qmsGatedRoutes = (qmsEnhancedRoutes as Array<{ path: string; method: string; roles?: string[]; createHandler: (deps: any) => any }>)
  .filter((r) => r.path.startsWith("/api/") && Array.isArray(r.roles) && r.roles.length > 0);

for (const route of qmsGatedRoutes) {
  const path = route.path;
  const method = route.method as string;
  await suite.test(`${method} ${path} — 403 for non-QMS authenticated session (department_viewer)`, async () => {
    const origKey = process.env.ADMIN_API_KEY;
    const origSecret = process.env.SESSION_SECRET;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.SESSION_SECRET = <REDACTED_SECRET>;
    try {
      const handler = await buildHandler(qmsEnhancedRoutes, path, method, { mastra: null });
      const res = await handler(makeContext({
        method,
        url: `<REDACTED_URL> "1")}`,
        params: { id: "1", entityType: "policy", entityId: "1" },
        headers: { Cookie: makeCookieForRole("department_viewer") },
        body: ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? {} : undefined,
      }));
      suite.expectEqual(res.status, 403, `expected 403 for department_viewer on ${method} ${path}`);
      suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
    } finally {
      if (origKey === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = origKey;
      if (origSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = origSecret;
    }
  });

  await suite.test(`${method} ${path} — 403 for non-QMS authenticated session (bu_owner)`, async () => {
    const origKey = process.env.ADMIN_API_KEY;
    const origSecret = process.env.SESSION_SECRET;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.SESSION_SECRET = <REDACTED_SECRET>;
    try {
      const handler = await buildHandler(qmsEnhancedRoutes, path, method, { mastra: null });
      const res = await handler(makeContext({
        method,
        url: `<REDACTED_URL> "1")}`,
        params: { id: "1", entityType: "policy", entityId: "1" },
        headers: { Cookie: makeCookieForRole("bu_owner") },
        body: ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? {} : undefined,
      }));
      suite.expectEqual(res.status, 403, `expected 403 for bu_owner on ${method} ${path}`);
      suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
    } finally {
      if (origKey === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = origKey;
      if (origSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = origSecret;
    }
  });
}

suite.finishOrExit();
