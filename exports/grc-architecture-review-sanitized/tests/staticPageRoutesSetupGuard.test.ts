/**
 * Setup-required guard tests for the `/dashboard/:name` handler in
 * `src/mastra/routes/staticPageRoutes.ts`.
 *
 * Why this file exists (Task #252)
 * ────────────────────────────────
 * The role-gated dashboard pages (/sandbox, /audits, /qms, …) already have
 * extensive coverage in `staticPageRoutesAuthGate.test.ts` and
 * `staticPageRoutesRoleGate.test.ts`. Those suites, however, always run
 * with `process.env.ADMIN_API_KEY` configured and exercise the role gate
 * via `hasValidAdminApiKey`/`isAdminAuthorized`.
 *
 * The `/dashboard/:name` route uses a *different* guard:
 *
 *     if (!isAdminKeyConfigured() && !session) {
 *       return c.html(renderSetupRequiredPage(...));
 *     }
 *
 * That branch — fresh-install, `ADMIN_API_KEY` not yet set, no session
 * cookie — was the regression that broke every dashboard sub-page until
 * the setup-required guard was added. With no automated test exercising
 * the env-unset path, a future change to either `isAdminKeyConfigured`
 * (in `src/utils/rbacMiddleware.ts`) or `getSessionFromCookie` (in
 * `src/mastra/routes/authRoutes.ts`) could silently bring the broken
 * page back without anyone noticing until a fresh deployment hit it.
 *
 * What it asserts
 * ───────────────
 * Per representative dashboard sub-page (`audits`, `qms`, `infographic`):
 *
 *   case A — `ADMIN_API_KEY` UNSET, no session cookie
 *            → 200 + the "Setup Required" HTML page is returned
 *
 *   case B — `ADMIN_API_KEY` SET, no session cookie
 *            → 200 + the real dashboard HTML is returned
 *              (no Setup Required HTML, body starts with `<!doctype html>`)
 *
 *   case C — `ADMIN_API_KEY` UNSET, but a valid signed session cookie
 *            → 200 + the real dashboard HTML is returned
 *              (proves the second OR-branch — `!session` — also works)
 *
 * Test infrastructure
 * ───────────────────
 * The handler under test only consults two inputs from the request: the
 * `Cookie` header (parsed via `getSessionFromCookie` → HMAC-verified
 * against `SESSION_SECRET`) and `process.env.ADMIN_API_KEY` (read at call
 * time inside `isAdminKeyConfigured`). Neither calls the database, so we
 * do not need to stub `pg.Pool`. We do mint a real signed session cookie
 * using the same HMAC scheme as `signSession()` in `authRoutes.ts` so
 * `getSessionFromCookie` will accept it as authentic.
 *
 * `ADMIN_API_KEY` is mutated between cases via `process.env` because
 * `isAdminKeyConfigured()` reads `process.env.ADMIN_API_KEY` on every
 * call; this test file runs in its own subprocess via
 * `tests/runIntegrationTests.ts`, so env mutation cannot bleed into
 * other test files.
 *
 * Run:  npx tsx tests/staticPageRoutesSetupGuard.test.ts
 */

import crypto from "node:crypto";

const TEST_ADMIN_KEY = "test-admin-key-static-page-setup-guard";
const TEST_SESSION_SECRET = "test-session-secret-static-page-setup-guard";

// SESSION_SECRET is required at module load time by `verifySession` in
// authRoutes.ts (used via `getSessionFromCookie`). Set it before any
// dynamic imports so the route module sees a stable secret.
process.env.SESSION_SECRET = TEST_SESSION_SECRET;
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

// Start with ADMIN_API_KEY explicitly UNSET so case A is exercised
// against a clean baseline. Subsequent cases set/unset it as needed.
delete process.env.ADMIN_API_KEY;

const { staticPageRoutes } =
  await import("../src/mastra/routes/staticPageRoutes");
const { TestSuite } = await import("./_helpers/runner");
const { buildHandler, makeContext } = await import("./_helpers/fakeContext");

const SESSION_COOKIE_NAME = "walaplus_session";

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
    userId: 11,
    email: `${role}@<REDACTED_HOST>`,
    name: `${role} user`,
    role,
    exp: Date.now() + 60_000,
  });
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
}

interface CaseInput {
  cookie?: string;
}

async function callDashboardName(name: string, input: CaseInput) {
  const handler = await buildHandler(
    staticPageRoutes,
    "/dashboard/:name",
    "GET",
  );
  const headers: Record<string, string> = {};
  if (input.cookie) headers["Cookie"] = input.cookie;
  const ctx = makeContext({ method: "GET", headers, params: { name } });
  return handler(ctx);
}

// Representative dashboard sub-pages whose underlying HTML files exist
// on disk in this repo. Picked to mirror the routes named in the task
// description (`/audits`, `/qms`) plus one more (`infographic`) so the
// guard is exercised for more than two filenames.
const SUBPAGES = ["audits", "qms", "infographic"] as const;

const suite = new TestSuite("staticPageRoutesSetupGuard");

console.log(
  "\n=== /dashboard/:name setup-required guard tests (Task #252) ===\n",
);

// Sanity: the route under test is actually registered. If it is renamed
// or removed, every subsequent assertion would silently pass against a
// "Route not found" throw — surface that loudly here instead.
await suite.test("/dashboard/:name is registered as a GET route", () => {
  const route = staticPageRoutes.find(
    (r) => r.path === "/dashboard/:name" && r.method === "GET",
  );
  suite.expect(
    route !== undefined,
    "expected GET /dashboard/:name to be registered",
  );
});

// Case A — ADMIN_API_KEY UNSET + no session cookie → Setup Required.
//
// This is the fresh-install regression the guard exists to prevent.
// Before the guard was added, the server would attempt to render the
// dashboard shell with no platform configuration, leaving the page
// broken (no API key configured ⇒ every backing API call 401s).
for (const name of SUBPAGES) {
  await suite.test(
    `GET /dashboard/${name} — ADMIN_API_KEY UNSET + no session returns Setup Required HTML`,
    async () => {
      delete process.env.ADMIN_API_KEY;
      const res = await callDashboardName(name, {});
      suite.expectEqual(res.status, 200, `${name} status`);
      suite.expect(
        typeof res.body === "string" && res.body.includes("Setup Required"),
        `${name} body should contain "Setup Required" but was: ${String(res.body).slice(0, 160)}`,
      );
      suite.expect(
        typeof res.body === "string" && res.body.includes("ADMIN_API_KEY"),
        `${name} body should mention ADMIN_API_KEY in the setup instructions`,
      );
    },
  );
}

// Case B — ADMIN_API_KEY SET (env-only, caller presents nothing) →
// real dashboard HTML.
//
// Once the platform has been configured, the `/dashboard/:name` guard
// short-circuits *before* reading the cookie, so the dashboard shell is
// served. Per-API RBAC remains the actual authorisation boundary for
// the data those pages consume; this test just pins the env-presence
// branch of `isAdminKeyConfigured()`.
for (const name of SUBPAGES) {
  await suite.test(
    `GET /dashboard/${name} — ADMIN_API_KEY SET serves the real dashboard HTML`,
    async () => {
      process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
      const res = await callDashboardName(name, {});
      suite.expectEqual(res.status, 200, `${name} status`);
      suite.expect(
        typeof res.body === "string" && !res.body.includes("Setup Required"),
        `${name} body should NOT contain "Setup Required" but was: ${String(res.body).slice(0, 160)}`,
      );
      suite.expect(
        typeof res.body === "string" &&
          /^<!doctype html>/i.test(res.body.trimStart()),
        `${name} body should look like a real dashboard page (<!doctype html>...)`,
      );
    },
  );
}

// Case C — ADMIN_API_KEY UNSET, but a valid signed session cookie →
// real dashboard HTML.
//
// Pins the second branch of the OR-guard: an authenticated browser
// session is sufficient to serve the dashboard shell even before the
// platform-level admin key has been configured. Without this, a regression
// in `getSessionFromCookie` (e.g. silently returning `null` for a valid
// cookie) would re-introduce the broken-page experience for every signed-in
// user during the brief window before `ADMIN_API_KEY` is set.
for (const name of SUBPAGES) {
  await suite.test(
    `GET /dashboard/${name} — ADMIN_API_KEY UNSET + valid session serves the real dashboard HTML`,
    async () => {
      delete process.env.ADMIN_API_KEY;
      const res = await callDashboardName(name, {
        cookie: sessionCookieFor("admin"),
      });
      suite.expectEqual(res.status, 200, `${name} status`);
      suite.expect(
        typeof res.body === "string" && !res.body.includes("Setup Required"),
        `${name} body should NOT contain "Setup Required" but was: ${String(res.body).slice(0, 160)}`,
      );
      suite.expect(
        typeof res.body === "string" &&
          /^<!doctype html>/i.test(res.body.trimStart()),
        `${name} body should look like a real dashboard page (<!doctype html>...)`,
      );
    },
  );
}

suite.finishOrExit();
