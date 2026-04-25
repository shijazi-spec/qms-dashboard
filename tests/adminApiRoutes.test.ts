/**
 * Integration tests for src/mastra/routes/adminApiRoutes.ts
 *
 * Coverage matrix:
 *   - 200 happy path  → POST /api/admin/auth (correct ADMIN_API_KEY)
 *                       POST /api/admin/auth/logout
 *   - 401 unauth      → POST /api/admin/auth (wrong key)
 *                       POST /api/admin/auth (no key field)
 *   - 403 forbidden   → PUT  /api/admin/scorecard/weights, GET /api/admin/activities,
 *                       POST /api/admin/seed-defaults,
 *                       GET  /api/admin/rate-limit-stats — all without auth
 *   - 500 bad input   → POST /api/admin/auth with empty/missing body (handler
 *                       catches the JSON parse failure and always returns 500)
 *   - structural      → every route exposes path/method/createHandler
 *
 * Every assertion is deterministic — no DB connection required for any test
 * in this file; results don't vary based on environment.
 *
 * Run:  npx tsx tests/adminApiRoutes.test.ts
 */

import { adminApiRoutes } from "../src/mastra/routes/adminApiRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("adminApiRoutes");

console.log("\n=== adminApiRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of adminApiRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expectEqual(adminApiRoutes.length >= 20, true, "at least 20 routes registered");
});

await suite.test("POST /api/admin/auth — 200 with correct ADMIN_API_KEY (sets cookie)", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "integration-test-secret-2026";
  try {
    const handler = await buildHandler(adminApiRoutes, "/api/admin/auth", "POST");
    const res = await handler(
      makeContext({ method: "POST", body: { key: "integration-test-secret-2026" } }),
    );
    suite.expectEqual(res.status, 200, "status");
    suite.expectEqual(res.body?.success, true, "body.success");
    const cookie = res.headers["Set-Cookie"];
    suite.expect(typeof cookie === "string", "Set-Cookie header is a string");
    suite.expect(
      cookie?.startsWith("admin_key=integration-test-secret-2026") ?? false,
      `Set-Cookie carries admin_key (got: ${cookie})`,
    );
    suite.expect(
      cookie?.includes("HttpOnly") && cookie?.includes("SameSite=Lax") && cookie?.includes("Max-Age=28800"),
      "Set-Cookie has HttpOnly + SameSite=Lax + Max-Age=28800",
    );
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("POST /api/admin/auth — 401 with wrong key", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "integration-test-secret-2026";
  try {
    const handler = await buildHandler(adminApiRoutes, "/api/admin/auth", "POST");
    const res = await handler(makeContext({ method: "POST", body: { key: "WRONG" } }));
    suite.expectEqual(res.status, 401, "status");
    suite.expectEqual(res.body?.error, "Authentication required", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("POST /api/admin/auth — 401 with no key field in body", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "integration-test-secret-2026";
  try {
    const handler = await buildHandler(adminApiRoutes, "/api/admin/auth", "POST");
    const res = await handler(makeContext({ method: "POST", body: {} }));
    suite.expectEqual(res.status, 401, "status");
    suite.expectEqual(res.body?.error, "Authentication required", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("POST /api/admin/auth — 500 with malformed (missing) body", async () => {
  // makeContext.req.json() throws when body is undefined; the handler's outer
  // try/catch surfaces this as 500 ("Authentication failed"). Asserted exactly
  // (deterministic — no env or DB dependency).
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "integration-test-secret-2026";
  try {
    const handler = await buildHandler(adminApiRoutes, "/api/admin/auth", "POST");
    const res = await handler(makeContext({ method: "POST" /* body omitted */ }));
    suite.expectEqual(res.status, 500, "status");
    suite.expectEqual(res.body?.error, "Authentication failed", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("POST /api/admin/auth/logout — 200 with cookie cleared", async () => {
  const handler = await buildHandler(adminApiRoutes, "/api/admin/auth/logout", "POST");
  const res = await handler(makeContext({ method: "POST" }));
  suite.expectEqual(res.status, 200, "status");
  suite.expectEqual(res.body?.success, true, "body.success");
  const cookie = res.headers["Set-Cookie"] ?? "";
  suite.expect(cookie.includes("admin_key="), "Set-Cookie clears admin_key");
  suite.expect(cookie.includes("Max-Age=0"), "Set-Cookie has Max-Age=0");
  suite.expect(cookie.includes("HttpOnly") && cookie.includes("SameSite=Lax"), "Set-Cookie has HttpOnly + SameSite=Lax");
});

await suite.test("PUT /api/admin/scorecard/weights — 403 without auth", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "integration-test-secret-2026";
  try {
    const handler = await buildHandler(adminApiRoutes, "/api/admin/scorecard/weights", "PUT");
    const res = await handler(
      makeContext({ method: "PUT", body: { people: 33, process: 33, governance: 34 } }),
    );
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("GET /api/admin/activities — 403 without auth", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "integration-test-secret-2026";
  try {
    const handler = await buildHandler(adminApiRoutes, "/api/admin/activities", "GET");
    const res = await handler(makeContext({ method: "GET" }));
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("POST /api/admin/seed-defaults — 403 without auth", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "integration-test-secret-2026";
  try {
    const handler = await buildHandler(adminApiRoutes, "/api/admin/seed-defaults", "POST");
    const res = await handler(makeContext({ method: "POST", body: {} }));
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("GET /api/admin/rate-limit-stats — 403 without auth", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "integration-test-secret-2026";
  try {
    const handler = await buildHandler(adminApiRoutes, "/api/admin/rate-limit-stats", "GET");
    const res = await handler(makeContext({ method: "GET" }));
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("GET /api/admin/documents — 401 (not 403) when no admin key and no session", async () => {
  // This handler uses inline auth (not isAdminAuthorized) and returns 401
  // specifically when both checks fail. Important to assert the distinct code.
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "integration-test-secret-2026";
  try {
    const handler = await buildHandler(adminApiRoutes, "/api/admin/documents", "GET");
    const res = await handler(makeContext({ method: "GET" }));
    suite.expectEqual(res.status, 401, "status");
    suite.expectEqual(res.body?.error, "Authentication required", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

suite.finishOrExit();
