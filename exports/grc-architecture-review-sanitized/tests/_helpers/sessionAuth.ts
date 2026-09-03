/**
 * Shared session-cookie auth helper for route-handler integration tests.
 *
 * Background:
 *   Security hardening (Task #855/#831) scoped the X-Admin-Key header to
 *   /api/admin/* and /api/inngest* routes only, and `requireRole()` in
 *   src/utils/rbacMiddleware.ts now ALWAYS performs a live
 *   `getPlatformUser()` lookup against the `platform_users` table. As a
 *   result, route-handler tests that authenticated by attaching
 *   `{ "X-Admin-Key": ADMIN_API_KEY }` now receive 401/403.
 *
 * This helper reproduces the canonical working pattern from
 * tests/qmsEnhancedRoutes.test.ts + tests/requireRoleSessionPath.test.ts:
 *
 *   1. Signs a `ExampleOrg_session` cookie with SESSION_SECRET — the same
 *      secret `authRoutes.signSession()/verifySession()` read — so that
 *      `getSessionUser()` accepts the caller.
 *   2. Registers an *active* `platform_users` row for the cookie's email and
 *      intercepts the
 *        `SELECT status, role FROM platform_users WHERE email = $1`
 *      query (issued by `getPlatformUser()` inside rbacMiddleware) at the
 *      `pg.Pool.prototype` level so the live role check passes — without
 *      writing to (or even connecting to) the real platform_users table.
 *      Every OTHER query falls through to the real pool, so DB-gated
 *      happy-path assertions still run against live data.
 *
 * Usage:
 *   import { makeCookieForRole } from "./_helpers/sessionAuth";
 *   const cookie = makeCookieForRole("admin");
 *   await handler(makeContext({ method: "GET", headers: { Cookie: cookie } }));
 */

import crypto from "crypto";
import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";

export const SESSION_COOKIE_NAME = "ExampleOrg_session";

/**
 * Secret used to sign test session cookies. Reuse an externally-provided
 * SESSION_SECRET when present so the cookie verifies against the same value
 * the application code reads; otherwise fall back to a fixed test secret.
 */
export const <REDACTED_SECRET> =
  process.env.SESSION_SECRET || "<REDACTED_SECRET>";

// Ensure authRoutes.signSession()/verifySession() use the same secret we sign
// with. verifySession() reads process.env.SESSION_SECRET at call time, so
// setting it here (before any request is dispatched) is sufficient.
process.env.SESSION_SECRET = <REDACTED_SECRET>;

const platformUsers = new Map<string, { status: string; role: string }>();

let patched = false;
function ensurePlatformUsersPatch(): void {
  if (patched) return;
  patched = true;
  const origQuery = pg.Pool.prototype.query;
  pg.Pool.prototype.query = function (this: pg.Pool, ...args: any[]): any {
    const first = args[0] as { text?: string } | string | undefined;
    const sql = String(
      (typeof first === "string" ? first : first?.text) ?? "",
    );
    if (
      /SELECT status, role FROM platform_users WHERE email\s*=\s*\$1/i.test(sql)
    ) {
      const params = args[1] as ReadonlyArray<unknown> | undefined;
      const email = String(params?.[0] ?? "");
      const row = platformUsers.get(email);
      return Promise.resolve({
        command: "SELECT",
        rowCount: row ? 1 : 0,
        oid: 0,
        fields: [],
        rows: row ? [row] : [],
      } as QueryResult<QueryResultRow>);
    }
    return (origQuery as any).apply(this, args);
  };
}

/**
 * Register an active (by default) platform_users row so the live
 * getPlatformUser() lookup performed by requireRole() succeeds for `email`.
 */
export function registerPlatformUser(
  email: string,
  role: string,
  status = "active",
): void {
  ensurePlatformUsersPatch();
  platformUsers.set(email, { status, role });
}

function signFakeSession(
  payload: Record<string, unknown>,
  secret: <REDACTED_SECRET>
): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

/** Deterministic test email for a given role. */
export function emailForRole(role: string): string {
  return `<REDACTED_EMAIL>`;
}

/**
 * Build a signed `ExampleOrg_session` cookie string for `role` AND register an
 * active platform_users row so requireRole()'s live lookup succeeds. Returns
 * the full `ExampleOrg_session=<token>` value for use as a `Cookie` header.
 */
export function makeCookieForRole(
  role: string,
  email = emailForRole(role),
): string {
  registerPlatformUser(email, role);
  const token = signFakeSession(
    {
      userId: 99,
      email,
      name: "Test User",
      role,
      exp: Date.now() + 3_600_000,
    },
    <REDACTED_SECRET>,
  );
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
}
