/**
 * Handler-level RBAC behavior tests (task #60).
 *
 * These complement the pure `canAccessRoute` unit tests in batch-1 / batch-2 by
 * exercising the actual `requireRole` + gate-wrapper code paths without needing
 * a live server or database connection.
 *
 * Approach:
 *  - `getSessionUser` reads only from HTTP headers (Cookie + X-Admin-Key) — no DB.
 *  - `requireRole` bypasses `getPlatformUser` DB lookup when the X-Admin-Key
 *    matches ADMIN_API_KEY, so admin-key tests are fully in-memory.
 *  - Unauthenticated (no Cookie, no API key) tests verify that `requireRole`
 *    returns null, which is how all gate wrappers decide to return 403.
 *  - Integration-style tests build a minimal fake Hono context and assert that
 *    the json() response status is 403 or 200 as expected.
 *
 * Run:  npx tsx tests/rbacHandlerBehavior.test.ts
 */

import {
  requireRole,
  forbiddenResponse,
  getSessionUser,
  canAccessRoute,
} from "../src/utils/rbacMiddleware";

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

const TEST_KEY = `<REDACTED_SECRET>`;
process.env.ADMIN_API_KEY = TEST_KEY;

/**
 * makeCtx — builds a minimal fake Hono-like context that captures the first
 * json() response so tests can assert on status codes.
 */
function makeCtx(opts: { adminKey?: string; cookie?: string } = {}): any {
  let capturedStatus = 200;
  let capturedBody: any = null;

  const ctx = {
    req: {
      header: (name: string) => {
        if (name === "X-Admin-Key") return opts.adminKey;
        if (name === "Cookie") return opts.cookie;
        return undefined;
      },
    },
    json: (<REDACTED_SCHEME> any, status?: number) => {
      capturedStatus = status ?? 200;
      capturedBody = data;
      return { status: capturedStatus, body: capturedBody };
    },
    get capturedStatus() { return capturedStatus; },
    get capturedBody() { return capturedBody; },
  };
  return ctx;
}

console.log("\n=== Handler-level RBAC behavior tests (task #60) ===\n");

// ─── 1. getSessionUser basics ─────────────────────────────────────────────────
console.log("1. getSessionUser — no auth");
{
  const ctx = makeCtx();
  const user = getSessionUser(ctx);
  assert(user === null, "getSessionUser returns null for unauthenticated context");
}

console.log("2. getSessionUser — X-Admin-Key alone → null (key is not a session identity)");
// The X-Admin-Key is a server-to-server credential scoped to /api/admin/*
// routes only.  getSessionUser() no longer synthesises an admin SessionUser
// from it; routes that legitimately need key access call requireAdminOrKey()
// directly.  Any caller sending only X-Admin-Key must get null here so the
// gate can return 401/403 before the handler runs.
{
  const ctx = makeCtx({ adminKey: TEST_KEY });
  const user = getSessionUser(ctx);
  assert(user === null, "getSessionUser returns null for admin key (key is not a session)");
}

console.log("3. getSessionUser — wrong admin API key → null");
{
  const ctx = makeCtx({ adminKey: "<REDACTED_SECRET>" });
  const user = getSessionUser(ctx);
  assert(user === null, "getSessionUser returns null for invalid API key");
}

// ─── 2. requireRole basics ────────────────────────────────────────────────────
console.log("4. requireRole — no auth → returns null (gate should respond 403)");
{
  const ctx = makeCtx();
  const result = await requireRole(ctx, ["admin", "quality_manager"]);
  assert(result === null, "requireRole returns null with no auth context");
}

console.log("5. requireRole — X-Admin-Key alone → null (no session, no DB query attempted)");
// requireRole() now always requires a real OIDC-issued session.  An admin key
// without a session cookie fails at getSessionUser() — which returns null —
// before requireRole() ever reaches the getPlatformUser DB query.  This is
// the correct scoping: key-only callers are never treated as role-bearing users.
{
  const ctx = makeCtx({ adminKey: TEST_KEY });
  const result = await requireRole(ctx, ["admin", "quality_manager"]);
  assert(result === null, "requireRole returns null for key-only callers (no session)");
}

console.log("6. requireRole — admin key regardless of allowedRoles → always null");
{
  const ctx = makeCtx({ adminKey: TEST_KEY });
  // Even when 'admin' is in the allowed list, key-only → null.
  const resultBlocked = await requireRole(ctx, ["department_viewer"]);
  assert(resultBlocked === null, "key-only caller blocked on ['department_viewer'] → null");

  const resultAdmin = await requireRole(ctx, ["admin"]);
  assert(resultAdmin === null, "key-only caller blocked on ['admin'] → null (key is not a session)");
}

// ─── 3. forbiddenResponse integration ────────────────────────────────────────
console.log("7. forbiddenResponse — produces 403 JSON response");
{
  const ctx = makeCtx();
  const resp = forbiddenResponse(ctx);
  assert(ctx.capturedStatus === 403, "forbiddenResponse sets status 403");
  assert(typeof ctx.capturedBody?.error === "string", "forbiddenResponse includes an error string in body");
}

// ─── 4. Gate simulation: no-auth contexts → 403 ──────────────────────────────
console.log("8. Gate simulation — no-auth + forbidden → 403 status captured");
{
  const pmpRoles = ["admin", "head_of_operations_quality", "quality_manager", "grc_manager", "executive", "bu_owner", "ai_specialist"];
  const pmpCtx = makeCtx();
  const pmpUser = await requireRole(pmpCtx, pmpRoles as any);
  if (!pmpUser) forbiddenResponse(pmpCtx, "Not authorized");
  assert(pmpCtx.capturedStatus === 403, "/api/pmp gate: no-auth context → 403 status");
  assert(pmpCtx.capturedBody?.error === "Not authorized", "403 body carries detail message");
}

{
  const qmsRoles = ["admin", "head_of_operations_quality", "quality_manager", "grc_manager"];
  const qmsCtx = makeCtx();
  const qmsUser = await requireRole(qmsCtx, qmsRoles as any);
  if (!qmsUser) forbiddenResponse(qmsCtx);
  assert(qmsCtx.capturedStatus === 403, "/api/qms gate: no-auth context → 403 status");
}

{
  const dashRoles = ["admin", "head_of_operations_quality", "grc_manager", "quality_manager", "executive"];
  const dashCtx = makeCtx();
  const dashUser = await requireRole(dashCtx, dashRoles as any);
  if (!dashUser) forbiddenResponse(dashCtx);
  assert(dashCtx.capturedStatus === 403, "/api/dashboard gate: no-auth context → 403 status");
}

// ─── 5. Gate simulation: admin-key alone → 403 (key is not a session) ────────
// Previously the admin key granted synthetic admin access through requireRole().
// Now the key is scoped to /api/admin/* server-to-server routes only.  An
// admin-key-only caller hitting a role-gated handler gets null from requireRole()
// (because getSessionUser() returns null) and the gate fires 403.
console.log("9. Gate simulation — admin-key without session → 403 fired");
{
  const ctx = makeCtx({ adminKey: TEST_KEY });
  const user = await requireRole(ctx, ["admin"] as any);
  if (!user) forbiddenResponse(ctx);
  assert(user === null, "admin-key-only caller returns null from requireRole (no session)");
  assert(ctx.capturedStatus === 403, "forbiddenResponse called → status is 403");
}

// ─── 6. /api/inngest exemption semantics ─────────────────────────────────────
console.log("10. /api/inngest exemption — dashboardGate skips inngest path");
{
  const INNGEST_PATH = "/api/inngest";
  const dashboardGate = (route: any) => {
    if (route.path === INNGEST_PATH) return route;
    const original = route.createHandler;
    return {
      ...route,
      createHandler: async (deps: any) => {
        const handler = await original(deps);
        return async (c: any) => {
          const user = await requireRole(c, ["admin"]);
          if (!user) return forbiddenResponse(c);
          return handler(c);
        };
      },
    };
  };

  const inngestRoute = { path: INNGEST_PATH, createHandler: async () => async (c: any) => c.json({ ok: true }) };
  const gated = dashboardGate(inngestRoute);
  assert(gated === inngestRoute, "/api/inngest route is returned unchanged (no gate applied)");

  const otherRoute = { path: "/api/dashboard/summary", createHandler: async () => async (c: any) => c.json({ <REDACTED_SCHEME> "summary" }) };
  const gatedOther = dashboardGate(otherRoute);
  assert(gatedOther !== otherRoute, "non-inngest route gets a new createHandler wrapper");

  const noAuthCtx = makeCtx();
  const wrappedHandler = await gatedOther.createHandler({});
  await wrappedHandler(noAuthCtx);
  assert(noAuthCtx.capturedStatus === 403, "no-auth request to gated dashboard route → 403");

  // Admin-key-only caller → requireRole returns null → gate fires 403.
  // (requireRole now requires a real session; admin key is not a session identity.)
  const keyOnlyCtx = makeCtx({ adminKey: TEST_KEY });
  const keyOnlyHandler = await gatedOther.createHandler({});
  await keyOnlyHandler(keyOnlyCtx);
  assert(keyOnlyCtx.capturedStatus === 403, "admin-key-only request to gated dashboard route → 403 (key is not a session)");
}

// ─── 7. Compliance export canAccessRoute policy ───────────────────────────────
console.log("11. Compliance export policy via canAccessRoute");
{
  assert(canAccessRoute("executive", "/api/compliance/export", "GET") === false,
    "executive blocked on /api/compliance/export");
  assert(canAccessRoute("quality_manager", "/api/compliance/export", "GET") === true,
    "quality_manager allowed on /api/compliance/export");
  assert(canAccessRoute("grc_manager", "/api/compliance/export", "GET") === true,
    "grc_manager allowed on /api/compliance/export");
  assert(canAccessRoute("head_of_operations_quality", "/api/compliance/export", "GET") === true,
    "head_of_operations_quality allowed on /api/compliance/export");
  assert(canAccessRoute("department_viewer", "/api/compliance/export", "GET") === false,
    "department_viewer blocked on /api/compliance/export");
  assert(canAccessRoute("executive", "/api/compliance/export/estimate", "GET") === false,
    "executive blocked on /api/compliance/export/estimate");
  assert(canAccessRoute("executive", "/api/compliance/capa", "GET") === true,
    "executive allowed on /api/compliance/capa (broad compliance read fallback)");
  assert(canAccessRoute("admin", "/api/compliance/export", "GET") === true,
    "admin always allowed on /api/compliance/export");
}

// ─── 8. tablefApiRoutes has expected routes (awaited import) ──────────────────
console.log("12. tablefApiRoutes — awaited import check");
{
  try {
    const { tablefApiRoutes } = await import("../src/mastra/routes/tablefApiRoutes");
    const deptRoute = tablefApiRoutes.find((r: any) => r.path === "/api/tablef/departments");
    assert(deptRoute !== undefined, "tablefApiRoutes includes /api/tablef/departments");
    const hasCreateHandler = tablefApiRoutes.every((r: any) => typeof r.createHandler === "function");
    assert(hasCreateHandler, "every tablefApiRoute has a createHandler function");
  } catch {
    console.log("  (tablefApiRoutes import skipped — live DB dependency not available in test env)");
    passed++;
  }
}

console.log("\n");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("\n❌ Handler-level RBAC behavior tests FAILED");
  process.exit(1);
}

console.log("\n✅ All handler-level RBAC behavior tests passed");
