/**
 * Integration test — proves that the page-shell sign-in gate on the two
 * dashboard routes added by Task #444 (`/guide`, `/migration`) is wired
 * end-to-end through `globalMiddleware`.
 *
 * Why this file exists
 * ────────────────────
 * Task #444 promoted `/guide` and `/migration` from publicly reachable
 * static pages to authenticated dashboard pages, including REMOVING
 * `/guide` from the `PUBLIC_PATHS` allowlist in
 * `src/mastra/middleware/index.ts`. The actual redirect-to-/login
 * behaviour happens in the global middleware's `checkPageAuth(c)` step,
 * NOT inside the route handler — so `staticPageRoutesRoleGate.test.ts`
 * (which exercises the handler in isolation) cannot observe the redirect
 * behaviour. A future edit that:
 *
 *   - re-adds `/guide` (or `/migration`) to `PUBLIC_PATHS`, or
 *   - drops `checkPageAuth` from the `!publicPath && !isApi` branch of
 *     `globalMiddleware`, or
 *   - changes the route paths so the middleware classifies them as
 *     something other than HTML pages,
 *
 * would silently turn the gate off. This file mounts the production
 * `globalMiddleware` on a Hono app, registers the real `/guide` and
 * `/migration` route handlers from `staticPageRoutes`, and asserts that:
 *
 *   1. An unauthenticated GET /guide       → 302 with Location: /login
 *   2. An unauthenticated GET /migration   → 302 with Location: /login
 *   3. An authenticated (admin session) GET /guide
 *      → 200 with the dashboard HTML body
 *   4. An authenticated (admin session) GET /migration
 *      → 200 with the dashboard HTML body
 *
 * Test infrastructure
 * ───────────────────
 * The page-auth path of `globalMiddleware` reads two inputs from the
 * request — the `Cookie` header (parsed via `getSessionFromCookie` →
 * HMAC-verified against `SESSION_SECRET`) and the `X-Admin-Key` header
 * (compared against `ADMIN_API_KEY`). Neither calls the database, so we
 * do not need to stand up `pg.Pool`. We mint a real signed
 * `walaplus_session` cookie using the same HMAC scheme as
 * `signSession()` in `authRoutes.ts` so that `getSessionFromCookie` will
 * accept it as authentic.
 *
 * `RATE_LIMIT_DISABLED=true` is set so the middleware's `checkApiAuth`
 * branch (not actually exercised by these HTML routes, but loaded
 * transitively) cannot reach the rate-limit DB lookup.
 *
 * Run:  npx tsx tests/staticPageRoutesSignInGate.integration.test.ts
 */

// Env vars MUST be set before the middleware module is loaded — it reads
// `RATE_LIMIT_429_LOG_MAX_PER_MIN` at module init, and the route handlers
// read `SESSION_SECRET` / `ADMIN_API_KEY` per request.
const TEST_ADMIN_KEY = "test-admin-key-static-page-signin-gate";
const TEST_SESSION_SECRET = "test-session-secret-static-page-signin-gate";

process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
process.env.SESSION_SECRET = TEST_SESSION_SECRET;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.REPLIT_DOMAINS = process.env.REPLIT_DOMAINS || "localhost:5000";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import crypto from "node:crypto";
import { Hono, type Handler, type MiddlewareHandler } from "hono";
import { globalMiddleware } from "../src/mastra/middleware/index";
import { staticPageRoutes } from "../src/mastra/routes/staticPageRoutes";

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

function adminSessionCookie(): string {
  const token = signSession({
    userId: 7,
    email: "admin@example.com",
    name: "admin user",
    role: "admin",
    exp: Date.now() + 60_000,
  });
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
}

async function buildApp(): Promise<Hono> {
  const app = new Hono();
  // Mount the production middleware exactly the way `src/mastra/index.ts`
  // does. `globalMiddleware` types its handlers as `(c: any, next: any)`
  // for cross-version Hono compatibility; we narrow to the concrete
  // `MiddlewareHandler` here without resorting to `as any` at the call site.
  app.use("*", ...(globalMiddleware as MiddlewareHandler[]));

  // Register the REAL `/guide` and `/migration` handlers from
  // staticPageRoutes — not stubs — so the dashboard HTML body that
  // case 3 / case 4 assert on is whatever the production handler would
  // serve in the same environment.
  for (const path of ["/guide", "/migration"] as const) {
    const route = staticPageRoutes.find(
      (r) => r.path === path && r.method === "GET",
    );
    if (!route) {
      throw new Error(`Expected GET ${path} to be registered in staticPageRoutes`);
    }
    // Route handlers in `staticPageRoutes` are typed as `(c: any) => any`
    // (the project mirrors Hono's permissive context typing across its
    // route modules). We narrow to Hono's concrete `Handler` here so the
    // registration call is fully typed without resorting to `as any`.
    const handler = (await route.createHandler({ mastra: null })) as Handler;
    app.get(path, handler);
  }

  return app;
}

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  \u2713 ${label}`);
    passed++;
  } else {
    console.error(`  \u2717 ${label}`);
    failed++;
  }
}

(async function main() {
  console.log("\n=== staticPageRoutes /guide + /migration sign-in gate ===\n");

  const app = await buildApp();

  // Case 1: unauthenticated GET /guide → 302 redirect to /login.
  // This proves `/guide` was REMOVED from `PUBLIC_PATHS` (Task #444). If a
  // future edit re-adds it, this assertion fails (the request would fall
  // through to the role-gate handler and respond 200 with "Setup Required"
  // HTML instead of redirecting).
  {
    const res = await app.request("/guide", { method: "GET" });
    assert(res.status === 302, "GET /guide unauthenticated returns 302");
    assert(
      res.headers.get("Location") === "/login",
      `GET /guide unauthenticated redirects to /login (got Location=${res.headers.get("Location")})`,
    );
  }

  // Case 2: unauthenticated GET /migration → 302 redirect to /login.
  // Same regression guard for the second route Task #444 locked down.
  {
    const res = await app.request("/migration", { method: "GET" });
    assert(res.status === 302, "GET /migration unauthenticated returns 302");
    assert(
      res.headers.get("Location") === "/login",
      `GET /migration unauthenticated redirects to /login (got Location=${res.headers.get("Location")})`,
    );
  }

  // Case 3: GET /guide with a valid admin session cookie → 200 with the
  // real dashboard HTML body. Proves the gate ADMITS authenticated
  // browsers (not just blocks unauthenticated ones) and serves
  // `dashboard/guide.html` on the post-gate path.
  {
    const res = await app.request("/guide", {
      method: "GET",
      headers: { Cookie: adminSessionCookie() },
    });
    assert(res.status === 200, `GET /guide with admin session returns 200 (got ${res.status})`);
    const body = await res.text();
    assert(
      /^<!doctype html>/i.test(body.trimStart()),
      "GET /guide with admin session serves a real <!DOCTYPE html> dashboard page",
    );
    assert(
      !body.includes("Setup Required"),
      "GET /guide with admin session does NOT serve the Setup Required placeholder",
    );
  }

  // Case 4: GET /migration with a valid admin session cookie → 200 with
  // the real dashboard HTML body. `/migration` is admin-only, so an
  // admin session is the right credential to assert the happy path with.
  {
    const res = await app.request("/migration", {
      method: "GET",
      headers: { Cookie: adminSessionCookie() },
    });
    assert(res.status === 200, `GET /migration with admin session returns 200 (got ${res.status})`);
    const body = await res.text();
    assert(
      /^<!doctype html>/i.test(body.trimStart()),
      "GET /migration with admin session serves a real <!DOCTYPE html> dashboard page",
    );
    assert(
      !body.includes("Setup Required"),
      "GET /migration with admin session does NOT serve the Setup Required placeholder",
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
