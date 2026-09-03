/**
 * Route-level auth-gate tests for the three admin-only static pages
 * served by `src/mastra/routes/staticPageRoutes.ts`:
 *
 *   - GET /qms
 *   - GET /admin
 *   - GET /users
 *
 * Why this file exists
 * ────────────────────
 * Task #138 aligned the `/qms` page-shell auth gate with the `/admin` and
 * `/users` page-shell gates so that all three routes consistently:
 *
 *   - reject unauthenticated callers with the "Setup Required" page,
 *   - reject sessions whose role is *not* `admin` with the same page,
 *   - admit a caller carrying a valid `ADMIN_API_KEY` request header,
 *   - admit a caller carrying a signed session cookie whose role is `admin`.
 *
 * Without an automated check, a future refactor of `staticPageRoutes.ts`
 * (or of `isAdminAuthorized` in `rbacMiddleware.ts`) could silently regress
 * any single one of those four cases on any single one of those three
 * routes — turning the page shell into a soft information-disclosure
 * surface for whatever a non-admin browser happens to render before the
 * underlying API calls 403.  This file prevents that regression.
 *
 * What it asserts (4 cases × 3 routes = 12 expectations)
 * ──────────────────────────────────────────────────────
 *   case A: no Cookie + no X-Admin-Key   → "Setup Required" HTML
 *   case B: signed session, role='user'  → "Setup Required" HTML
 *   case C: valid X-Admin-Key header     → admin/qms/users dashboard HTML
 *   case D: signed session, role='admin' → admin/qms/users dashboard HTML
 *
 * Test infrastructure
 * ───────────────────
 * The handlers we exercise (`/qms`, `/admin`, `/users`) only consult two
 * inputs from the request — the `Cookie` header (parsed via
 * `getSessionFromCookie` → HMAC-verified against `SESSION_SECRET`) and the
 * `X-Admin-Key` header (compared against `ADMIN_API_KEY`).  Neither calls
 * the database, so we do not need to stub `pg.Pool`.  We do, however, mint
 * a real signed session cookie using the same HMAC scheme as
 * `signSession()` in `authRoutes.ts` so that `getSessionFromCookie` will
 * accept it as authentic.
 *
 * Run:  npx tsx tests/staticPageRoutesAuthGate.test.ts
 */

import crypto from "node:crypto";

const TEST_ADMIN_KEY = "test-admin-key-static-page-gate";
const TEST_SESSION_SECRET = "test-session-secret-static-page-gate";

process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
process.env.SESSION_SECRET = TEST_SESSION_SECRET;
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

// Register an active admin platform_users row BEFORE importing staticPageRoutes
// so the live getPlatformUser() lookup inside isAdminAuthorizedLive()
// (rbacMiddleware) resolves the admin session cookie used by case D. Security
// hardening (Task #855/#831) made requireRole()/admin gates ALWAYS perform a
// live platform_users lookup rather than trusting the cookie's role claim, so
// the session-cookie admin path now requires this seeded row. The helper
// intercepts only the `SELECT status, role FROM platform_users WHERE email=$1`
// query at the pg.Pool level — the non-admin (case B) email is left
// unregistered so it still correctly renders "Setup Required".
const { registerPlatformUser } = await import("./_helpers/sessionAuth");
registerPlatformUser("user@example.invalid", "admin");

const { staticPageRoutes } = await import("../src/mastra/routes/staticPageRoutes");
const { TestSuite } = await import("./_helpers/runner");
const { buildHandler, makeContext } = await import("./_helpers/fakeContext");

const SESSION_COOKIE_NAME = "ExampleOrg_session";

// Mirror src/mastra/routes/authRoutes.ts → signSession() so we can mint a
// cryptographically valid `ExampleOrg_session` cookie without exporting it
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
    email: `${role}@<REDACTED_HOST>`,
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

const ADMIN_PAGE_ROUTES = ["/qms", "/admin", "/users"] as const;

const suite = new TestSuite("staticPageRoutesAuthGate");

console.log("\n=== staticPageRoutes admin-gate tests ===\n");

// Sanity: each route under test is actually registered. If a route is
// renamed or removed, every subsequent assertion below would silently pass
// against a 404 fallback handler — which is exactly the kind of regression
// we want to surface loudly.
await suite.test("/qms, /admin, /users are all registered as GET routes", () => {
  for (const path of ADMIN_PAGE_ROUTES) {
    const route = staticPageRoutes.find((r) => r.path === path && r.method === "GET");
    suite.expect(route !== undefined, `expected GET ${path} to be registered`);
  }
});

// Case A: no session, no API key → Setup Required.
//
// This is the fresh-install / logged-out-browser path. The page must NOT
// render the dashboard shell — even with `ADMIN_API_KEY` configured on the
// server — because the *caller* has presented no credentials of any kind.
for (const path of ADMIN_PAGE_ROUTES) {
  await suite.test(`GET ${path} — no session and no API key returns Setup Required`, async () => {
    const res = await callRoute(path, {});
    suite.expectEqual(res.status, 200, `${path} status`);
    suite.expect(
      typeof res.body === "string" && res.body.includes("Setup Required"),
      `${path} body should contain "Setup Required" but was: ${String(res.body).slice(0, 120)}`,
    );
  });
}

// Case B: signed session whose role is NOT admin → Setup Required.
//
// This is the silent-permission-failure case the gate exists to prevent.
// A caller with a *valid* (HMAC-signed, unexpired) session cookie whose
// payload role is e.g. 'user' or 'department_viewer' must still be denied
// the page shell — anything less and a non-admin browser session would
// see admin-only chrome before its API calls 403.
for (const path of ADMIN_PAGE_ROUTES) {
  await suite.test(`GET ${path} — non-admin session returns Setup Required`, async () => {
    const res = await callRoute(path, { cookie: sessionCookieFor("user") });
    suite.expectEqual(res.status, 200, `${path} status`);
    suite.expect(
      typeof res.body === "string" && res.body.includes("Setup Required"),
      `${path} body should contain "Setup Required" but was: ${String(res.body).slice(0, 120)}`,
    );
  });
}

// Case C: valid X-Admin-Key header → dashboard shell served.
//
// This is the service / automation path (curl, scripted exporters, etc.)
// where the caller cannot ride a browser session and must instead present
// the deployment's `ADMIN_API_KEY`. All three routes must accept it as a
// full admin credential.
for (const path of ADMIN_PAGE_ROUTES) {
  await suite.test(`GET ${path} — valid ADMIN_API_KEY header serves the dashboard`, async () => {
    const res = await callRoute(path, { adminKey: TEST_ADMIN_KEY });
    suite.expectEqual(res.status, 200, `${path} status`);
    suite.expect(
      typeof res.body === "string" && !res.body.includes("Setup Required"),
      `${path} body should NOT contain "Setup Required" but was: ${String(res.body).slice(0, 120)}`,
    );
    suite.expect(
      typeof res.body === "string" && /^<!doctype html>/i.test(res.body.trimStart()),
      `${path} body should look like a real dashboard page (<!doctype html>...)`,
    );
  });
}

// Case D: signed session whose role IS admin → dashboard shell served.
//
// This is the normal browser-navigation path for a signed-in admin. The
// gate must accept a session cookie as a full admin credential without
// requiring the caller to also present `X-Admin-Key`.
for (const path of ADMIN_PAGE_ROUTES) {
  await suite.test(`GET ${path} — admin session serves the dashboard`, async () => {
    const res = await callRoute(path, { cookie: sessionCookieFor("admin") });
    suite.expectEqual(res.status, 200, `${path} status`);
    suite.expect(
      typeof res.body === "string" && !res.body.includes("Setup Required"),
      `${path} body should NOT contain "Setup Required" but was: ${String(res.body).slice(0, 120)}`,
    );
    suite.expect(
      typeof res.body === "string" && /^<!doctype html>/i.test(res.body.trimStart()),
      `${path} body should look like a real dashboard page (<!doctype html>...)`,
    );
  });
}

suite.finishOrExit();
