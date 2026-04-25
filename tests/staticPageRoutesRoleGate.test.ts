/**
 * Route-level role-gate tests for the dashboard pages locked down by
 * Task #461 in `src/mastra/routes/staticPageRoutes.ts`:
 *
 *   /sandbox, /crm, /audits, /compliance, /policies, /reviews, /risks,
 *   /grc, /pdpl, /feedback, /logs, /ai-approvals, /intake,
 *   /external-audits, /vendors, /tablef, /infographic, /executive.html,
 *   /grc.html, /consultant.html
 *
 * Why this file exists
 * ────────────────────
 * Task #255 added `tests/staticPageRoutesAuthGate.test.ts` for the three
 * admin-only page shells (/admin, /users, /qms). Task #461 extends the
 * same defence to every other dashboard page that previously fell through
 * to the loose `serveDashboardPageWithSetupCheck` helper, which admitted
 * ANY signed session — and even "no session, ADMIN_API_KEY configured" —
 * regardless of whether the caller's role could actually read the
 * underlying APIs. The backing APIs do enforce per-role RBAC, but a
 * non-admin browser would still see admin-style chrome before each API
 * call 403'd.
 *
 * Without an automated check, a future refactor of `staticPageRoutes.ts`
 * (or of `hasValidAdminApiKey` in `rbacMiddleware.ts`) could silently
 * regress any of the four cases below on any single one of these routes,
 * re-introducing the soft information-disclosure surface this task
 * removed. This file prevents that regression.
 *
 * What it asserts (per route)
 * ───────────────────────────
 *   case A: no Cookie + no X-Admin-Key       → "Setup Required" HTML
 *   case B: signed session, role NOT in
 *           the route's allowed-roles set     → "Setup Required" HTML
 *   case C: valid X-Admin-Key header          → real dashboard HTML
 *   case D: signed session, role IS in
 *           the route's allowed-roles set     → real dashboard HTML
 *
 * The role allowlists themselves are defined in `staticPageRoutes.ts` and
 * mirror the GET role rule on each route's backing `/api/*` endpoint in
 * `ROUTE_PERMISSION_MAP` (see the comment block in `staticPageRoutes.ts`
 * for the rationale per route). This test file consumes them via the
 * exported `ROLE_GATED_DASHBOARD_ROUTES` matrix so the matrix and the
 * runtime gate cannot drift apart.
 *
 * Test infrastructure
 * ───────────────────
 * The handlers under test only consult two inputs from the request — the
 * `Cookie` header (parsed via `getSessionFromCookie` → HMAC-verified
 * against `SESSION_SECRET`) and the `X-Admin-Key` header (compared
 * against `ADMIN_API_KEY`). Neither calls the database, so we do not need
 * to stub `pg.Pool`. We do, however, mint a real signed session cookie
 * using the same HMAC scheme as `signSession()` in `authRoutes.ts` so
 * that `getSessionFromCookie` will accept it as authentic.
 *
 * Run:  npx tsx tests/staticPageRoutesRoleGate.test.ts
 */

import crypto from "node:crypto";

const TEST_ADMIN_KEY = "test-admin-key-static-page-role-gate";
const TEST_SESSION_SECRET = "test-session-secret-static-page-role-gate";

process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
process.env.SESSION_SECRET = TEST_SESSION_SECRET;
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

const { staticPageRoutes, ROLE_GATED_DASHBOARD_ROUTES } = await import(
  "../src/mastra/routes/staticPageRoutes"
);
const { TestSuite } = await import("./_helpers/runner");
const { buildHandler, makeContext } = await import("./_helpers/fakeContext");

type UserRoleLike = string;

const SESSION_COOKIE_NAME = "walaplus_session";

// Mirror src/mastra/routes/authRoutes.ts → signSession() so we can mint a
// cryptographically valid `walaplus_session` cookie without exporting it
// from the production module (which would widen its API surface).
function signSession(payload: Record<string, unknown>): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", process.env.SESSION_SECRET!)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

function sessionCookieFor(role: string): string {
  const token = signSession({
    userId: 7,
    email: `${role}@example.com`,
    name: `${role} user`,
    role,
    exp: Date.now() + 60_000,
  });
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
}

interface CaseInput {
  cookie?: string;
  adminKey?: string;
}

async function callRoute(path: string, input: CaseInput) {
  const handler = await buildHandler(staticPageRoutes, path, "GET");
  const headers: Record<string, string> = {};
  if (input.cookie) headers["Cookie"] = input.cookie;
  if (input.adminKey !== undefined) headers["X-Admin-Key"] = input.adminKey;
  const ctx = makeContext({ method: "GET", headers });
  return handler(ctx);
}

// Universe of well-known roles used to (a) pick a representative "denied"
// role for each route, and (b) pick a representative "admitted" role
// without re-using 'admin' for every test case (admins should always pass
// — but the gate exists primarily to stop *non-admin* signed sessions, so
// for routes that admit non-admin roles we should test one of those too).
const ALL_KNOWN_ROLES: readonly UserRoleLike[] = [
  'admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager',
  'quality_specialist', 'team_lead', 'department_viewer', 'auditor',
  'ai_specialist', 'bu_owner', 'executive', 'custom',
];

function pickDeniedRole(allowed: readonly UserRoleLike[]): UserRoleLike {
  // Prefer 'department_viewer' when not allowed (the canonical low-priv
  // browser session); otherwise fall back to any role outside the set;
  // finally fall back to 'custom' which is intentionally never in any
  // allowlist.
  if (!allowed.includes('department_viewer')) return 'department_viewer';
  for (const r of ALL_KNOWN_ROLES) {
    if (!allowed.includes(r)) return r;
  }
  return 'custom';
}

function pickAdmittedRole(allowed: readonly UserRoleLike[]): UserRoleLike {
  // Prefer a non-admin role when possible so the test exercises the
  // "session.role in allowedRoles" branch rather than collapsing into the
  // admin-bypass behaviour we already cover via /qms,/admin,/users.
  for (const r of allowed) {
    if (r !== 'admin') return r;
  }
  return 'admin';
}

const suite = new TestSuite("staticPageRoutesRoleGate");

console.log("\n=== staticPageRoutes role-gate tests (Task #461) ===\n");

// Sanity: every entry in ROLE_GATED_DASHBOARD_ROUTES corresponds to a
// real registered GET route. If a route is renamed or removed without
// updating the matrix, every case-A/B/C/D assertion would silently pass
// against a 404 fallback — which is exactly the kind of regression we
// want to surface loudly.
await suite.test("every gated route is registered as GET in staticPageRoutes", () => {
  for (const { path } of ROLE_GATED_DASHBOARD_ROUTES) {
    const route = staticPageRoutes.find(
      (r) => r.path === path && r.method === "GET",
    );
    suite.expect(route !== undefined, `expected GET ${path} to be registered`);
  }
});

// Sanity: the matrix is non-empty and contains at least the routes named
// in Task #461. If someone trims an entry by accident, we want to know.
await suite.test("matrix includes every route named by Task #461", () => {
  const required = [
    "/sandbox", "/crm", "/audits", "/compliance", "/policies", "/reviews",
    "/risks", "/grc", "/pdpl", "/feedback", "/logs", "/ai-approvals",
    "/intake", "/external-audits", "/vendors", "/tablef", "/infographic",
    "/executive.html", "/grc.html", "/consultant.html",
  ];
  const present = new Set(ROLE_GATED_DASHBOARD_ROUTES.map((r) => r.path));
  for (const p of required) {
    suite.expect(present.has(p), `expected ${p} in ROLE_GATED_DASHBOARD_ROUTES`);
  }
});

// Sanity: every allowlist must include 'admin'. This is invariant: the
// admin role is the operational super-user for the platform and must be
// able to load every dashboard shell. A future refactor that drops admin
// from any allowlist (e.g. by typo) would be caught here before it caused
// production support-rotation pain.
await suite.test("every allowlist includes 'admin'", () => {
  for (const { path, allowedRoles } of ROLE_GATED_DASHBOARD_ROUTES) {
    suite.expect(
      allowedRoles.includes('admin'),
      `${path} allowlist must include 'admin' but was [${allowedRoles.join(', ')}]`,
    );
  }
});

// Sanity: 'custom' must NEVER appear in any allowlist. Custom roles
// derive permissions dynamically from a per-user ACL and cannot be
// statically validated by a page-shell gate; they're handled at the API
// layer via `enforceRoutePermission`. Allowing 'custom' here would defeat
// the whole point of the role gate (since the cookie payload role is
// trusted at this layer — see the comment in `staticPageRoutes.ts`).
await suite.test("no allowlist includes 'custom'", () => {
  for (const { path, allowedRoles } of ROLE_GATED_DASHBOARD_ROUTES) {
    suite.expect(
      !allowedRoles.includes('custom'),
      `${path} allowlist must NOT include 'custom' but was [${allowedRoles.join(', ')}]`,
    );
  }
});

// Case A: no session, no API key → Setup Required.
//
// This is the fresh-install / logged-out-browser path. Before Task #461,
// these routes would render the dashboard shell as long as
// ADMIN_API_KEY was *configured* on the server (regardless of whether
// the caller presented it). The new gate must refuse the page shell
// because the *caller* has presented no credentials of any kind.
for (const { path } of ROLE_GATED_DASHBOARD_ROUTES) {
  await suite.test(`GET ${path} — no session and no API key returns Setup Required`, async () => {
    const res = await callRoute(path, {});
    suite.expectEqual(res.status, 200, `${path} status`);
    suite.expect(
      typeof res.body === "string" && res.body.includes("Setup Required"),
      `${path} body should contain "Setup Required" but was: ${String(res.body).slice(0, 120)}`,
    );
  });
}

// Case B: signed session whose role is NOT in the route's allowlist →
// Setup Required.
//
// This is the silent-permission-failure case the gate exists to prevent.
// A caller with a *valid* (HMAC-signed, unexpired) session cookie whose
// payload role is outside the allowlist must be denied the page shell —
// anything less and a non-permitted browser session would see admin-style
// chrome before its API calls 403.
for (const { path, allowedRoles } of ROLE_GATED_DASHBOARD_ROUTES) {
  const denied = pickDeniedRole(allowedRoles);
  await suite.test(
    `GET ${path} — session role='${denied}' (not in allowlist) returns Setup Required`,
    async () => {
      const res = await callRoute(path, { cookie: sessionCookieFor(denied) });
      suite.expectEqual(res.status, 200, `${path} status`);
      suite.expect(
        typeof res.body === "string" && res.body.includes("Setup Required"),
        `${path} body should contain "Setup Required" but was: ${String(res.body).slice(0, 120)}`,
      );
    },
  );
}

// Case C: valid X-Admin-Key header → gate admits the request.
//
// This is the service / automation path (curl, scripted exporters,
// monitoring probes) where the caller cannot ride a browser session and
// must instead present the deployment's `ADMIN_API_KEY`. Every gated
// route must accept it as a full admin credential regardless of its own
// allowlist.
//
// We assert "the gate let the request through" — meaning the response is
// NOT the Setup Required HTML — rather than insisting on a 200 with a
// real dashboard body. Some dashboard files (e.g. `sandbox.html`) are
// not always present on disk in this environment; in that case the
// post-gate code path returns a 404 with "not found", which is still a
// pass for *this* test because the gate did not block. A regression in
// the gate would surface as a 200 "Setup Required" page (caught here)
// rather than as a missing-file 404.
for (const { path } of ROLE_GATED_DASHBOARD_ROUTES) {
  await suite.test(`GET ${path} — valid ADMIN_API_KEY header is admitted by the gate`, async () => {
    const res = await callRoute(path, { adminKey: TEST_ADMIN_KEY });
    suite.expect(
      typeof res.body === "string" && !res.body.includes("Setup Required"),
      `${path} body should NOT contain "Setup Required" but was: ${String(res.body).slice(0, 120)}`,
    );
    if (res.status === 200) {
      suite.expect(
        typeof res.body === "string" && /^<!doctype html>/i.test(res.body.trimStart()),
        `${path} 200 body should look like a real dashboard page (<!doctype html>...)`,
      );
    } else {
      suite.expectEqual(res.status, 404, `${path} expected 200 (file present) or 404 (file missing) post-gate`);
      suite.expect(
        typeof res.body === "string" && /not found/i.test(res.body),
        `${path} 404 body should explain the missing file but was: ${String(res.body).slice(0, 120)}`,
      );
    }
  });
}

// Case D: signed session whose role IS in the route's allowlist →
// gate admits the request.
//
// This is the normal browser-navigation path for a permitted user. The
// gate must accept a session cookie as a full credential without
// requiring the caller to also present `X-Admin-Key`. Where possible we
// pick a *non-admin* role (e.g. 'executive' for /audits) so the test
// exercises the "session.role in allowedRoles" branch and not just the
// admin bypass.
//
// Same 200-or-404 tolerance as case C: we assert the gate let the
// request through (no Setup Required), and accept either a real
// dashboard body (file present on disk) or a "not found" 404
// (post-gate, file missing in this environment).
for (const { path, allowedRoles } of ROLE_GATED_DASHBOARD_ROUTES) {
  const admitted = pickAdmittedRole(allowedRoles);
  await suite.test(
    `GET ${path} — permitted session role='${admitted}' is admitted by the gate`,
    async () => {
      const res = await callRoute(path, { cookie: sessionCookieFor(admitted) });
      suite.expect(
        typeof res.body === "string" && !res.body.includes("Setup Required"),
        `${path} body should NOT contain "Setup Required" but was: ${String(res.body).slice(0, 120)}`,
      );
      if (res.status === 200) {
        suite.expect(
          typeof res.body === "string" && /^<!doctype html>/i.test(res.body.trimStart()),
          `${path} 200 body should look like a real dashboard page (<!doctype html>...)`,
        );
      } else {
        suite.expectEqual(res.status, 404, `${path} expected 200 (file present) or 404 (file missing) post-gate`);
        suite.expect(
          typeof res.body === "string" && /not found/i.test(res.body),
          `${path} 404 body should explain the missing file but was: ${String(res.body).slice(0, 120)}`,
        );
      }
    },
  );
}

suite.finishOrExit();
