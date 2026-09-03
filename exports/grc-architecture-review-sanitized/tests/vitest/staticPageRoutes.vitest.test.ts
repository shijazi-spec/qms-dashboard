/**
 * Vitest tests for the /admin and /users access gates in
 * src/mastra/routes/staticPageRoutes.ts.
 *
 * Covers the three access scenarios documented in the route comments:
 *  1. Valid admin-role session cookie (no X-Admin-Key) → 200 + page HTML
 *  2. Valid X-Admin-Key header (no session) → 200 + page HTML
 *  3. Valid session cookie whose role is NOT 'admin' → "Admin Setup Required"
 *     fallback page (not the page HTML)
 *
 * Run via:  npx vitest run tests/vitest/staticPageRoutes.vitest.test.ts
 * Or as part of:  npm test  (see tests/runIntegrationTests.ts)
 */

import crypto from "crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CapturedResponse, FakeContext } from "../_helpers/fakeContext";
import { makeContext } from "../_helpers/fakeContext";

// ---------------------------------------------------------------------------
// Mock the `fs` module so tests never need real HTML files on disk.
// `existsSync` signals that both page files are present; `readFileSync`
// returns recognisable sentinel strings so assertions can confirm the
// correct file was served.
// ---------------------------------------------------------------------------
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  return {
    ...real,
    existsSync: vi.fn((p: string) =>
      /admin\.html|users\.html/.test(p) ? true : real.existsSync(p),
    ),
    readFileSync: vi.fn((p: string, enc?: BufferEncoding) => {
      if (/admin\.html/.test(p)) return "<html>ADMIN_DASHBOARD</html>";
      if (/users\.html/.test(p)) return "<html>USERS_DASHBOARD</html>";
      return real.readFileSync(p, enc);
    }),
  };
});

// ---------------------------------------------------------------------------
// Seed the admin precondition that `isAdminAuthorizedLive()` enforces.
//
// The /admin and /users page gates call the *live* variant
// `isAdminAuthorizedLive(c)`, which — for a session-cookie caller — does NOT
// trust the role baked into the (still HMAC-signed) cookie. It re-reads the
// caller's role from the `platform_users` table via `getPlatformUser(email)`.
// Vitest workers run without a live Postgres, so that lookup returns null and
// the gate falls through to the "Admin Setup Required" page even for a valid
// admin-role cookie.
//
// To exercise the intended admin-session path WITHOUT weakening the security
// assertion, we re-implement ONLY `isAdminAuthorizedLive` with the exact same
// decision logic as production (valid X-Admin-Key OR an *active* `admin`
// platform_user), but resolve the platform_user from a hermetic map keyed by
// the session email instead of hitting the DB. The role is derived from the
// session email prefix (see `sessionCookie` below), so:
//   • <REDACTED_EMAIL>               → active admin   → gate admits (200)
//   • <REDACTED_EMAIL>   → active viewer  → gate refuses (setup)
//   • <REDACTED_EMAIL>     → active QM      → gate refuses (setup)
// The X-Admin-Key path, the admin_key-cookie-only path, and the
// no-credentials path all keep flowing through the real helpers unchanged.
//
// A per-file `vi.mock` takes precedence over the global rbacAuthShim setup
// file, and we re-export every other binding (`...real`) so the rest of
// staticPageRoutes' imports behave exactly as in production.
vi.mock("../../src/utils/rbacMiddleware", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/utils/rbacMiddleware")>();

  /** Hermetic stand-in for `platform_users` lookups in the vitest worker. */
  const fakePlatformUser = (
    email: string,
  ): { status: string; role: string } | null => {
    const m = /^([a-z_]+)@example\.com$/.exec(email);
    if (!m) return null;
    return { status: "active", role: m[1] };
  };

  return {
    ...real,
    isAdminAuthorizedLive: async (c: any): Promise<boolean> => {
      if (real.hasValidAdminApiKey(c)) return true;
      const user = real.getSessionUser(c);
      if (!user) return false;
      const platformUser = fakePlatformUser(user.email);
      if (!platformUser || platformUser.status !== "active") return false;
      return platformUser.role === "admin";
    },
  };
});

// ---------------------------------------------------------------------------
// Import the module under test **after** the vi.mock() call so it picks up
// the mocked `fs`.
// ---------------------------------------------------------------------------
import { staticPageRoutes } from "../../src/mastra/routes/staticPageRoutes";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ADMIN_KEY = "<REDACTED_SECRET>";
const SESSION_SECRET = "<REDACTED_SECRET>";

// ---------------------------------------------------------------------------
// Extend FakeContext with the `html()` response helper that static page
// handlers use. The return type intentionally mirrors CapturedResponse so
// the callers can be typed end-to-end without any casts.
// ---------------------------------------------------------------------------
interface FakeContextWithHtml extends FakeContext {
  html: (body: string, status?: number) => CapturedResponse;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Replicate the private `signSession` logic from authRoutes.ts so tests can
 * create cryptographically valid session tokens without importing the private
 * function.
 */
function signSession(payload: Record<string, unknown>): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

/**
 * Build a `ExampleOrg_session` cookie string for the given role.
 *
 * The email encodes the role (`<role>@<REDACTED_HOST>`) so the hermetic
 * `isAdminAuthorizedLive` mock above can resolve the caller's *platform_users*
 * role without a DB lookup — mirroring production, which trusts the live DB
 * role rather than the role baked into the signed cookie.
 */
function sessionCookie(role: string): string {
  const token = signSession({
    userId: 1,
    email: `${role}@<REDACTED_HOST>`,
    name: "Test User",
    role,
  });
  return `ExampleOrg_session=${encodeURIComponent(token)}`;
}

/**
 * Extend the plain FakeContext returned by makeContext() with a typed `html()`
 * method. Static page handlers call `c.html(body)` for both the success and
 * the "setup required" fallback responses.
 */
function makeCtxWithHtml(
  init: Parameters<typeof makeContext>[0] = {},
): FakeContextWithHtml {
  const ctx = makeContext(init) as FakeContextWithHtml;
  ctx.html = (body: string, status = 200): CapturedResponse => ({
    status,
    body,
    headers: { ...ctx.responseHeaders },
  });
  return ctx;
}

/**
 * Locate a route in staticPageRoutes by path and method, instantiate its
 * handler (static page handlers take no deps), and return the inner async
 * handler ready to be called with a FakeContextWithHtml.
 */
async function buildStaticHandler(
  path: string,
  method = "GET",
): Promise<(c: FakeContextWithHtml) => Promise<CapturedResponse>> {
  const route = staticPageRoutes.find(
    (r) => r.path === path && r.method === method,
  );
  if (!route) throw new Error(`Route not found: ${method} ${path}`);
  return route.createHandler() as Promise<
    (c: FakeContextWithHtml) => Promise<CapturedResponse>
  >;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  process.env.SESSION_SECRET = SESSION_SECRET;
});

afterEach(() => {
  delete process.env.ADMIN_API_KEY;
  delete process.env.SESSION_SECRET;
  vi.clearAllMocks();
});

// ===========================================================================
// GET /admin
// ===========================================================================

describe("GET /admin — admin-role session cookie (no X-Admin-Key header)", () => {
  test("returns 200 with admin HTML when session role is 'admin'", async () => {
    const handler = await buildStaticHandler("/admin");
    const ctx = makeCtxWithHtml({
      method: "GET",
      headers: { Cookie: sessionCookie("admin") },
    });

    const res = await handler(ctx);

    expect(res.status).toBe(200);
    expect(res.body).toContain("ADMIN_DASHBOARD");
  });
});

describe("GET /admin — valid X-Admin-Key header (no session cookie)", () => {
  test("returns 200 with admin HTML when X-Admin-Key matches ADMIN_API_KEY", async () => {
    const handler = await buildStaticHandler("/admin");
    const ctx = makeCtxWithHtml({
      method: "GET",
      headers: { "X-Admin-Key": ADMIN_KEY },
    });

    const res = await handler(ctx);

    expect(res.status).toBe(200);
    expect(res.body).toContain("ADMIN_DASHBOARD");
  });
});

describe("GET /admin — admin_key cookie alone (Task #831 regression guard)", () => {
  test("does NOT serve admin HTML when only admin_key cookie is present (cookie path removed in Task #831; X-Admin-Key header is now required)", async () => {
    const handler = await buildStaticHandler("/admin");
    const ctx = makeCtxWithHtml({
      method: "GET",
      headers: { Cookie: `admin_key=${ADMIN_KEY}` },
    });

    const res = await handler(ctx);

    expect(res.status).toBe(200);
    expect(res.body).toContain("Admin Setup Required");
    expect(res.body).not.toContain("ADMIN_DASHBOARD");
  });
});

describe("GET /admin — non-admin session (no X-Admin-Key header)", () => {
  test("returns the 'Admin Setup Required' page (not admin.html) when session role is not 'admin'", async () => {
    const handler = await buildStaticHandler("/admin");
    const ctx = makeCtxWithHtml({
      method: "GET",
      headers: { Cookie: sessionCookie("department_viewer") },
    });

    const res = await handler(ctx);

    expect(res.status).toBe(200);
    expect(res.body).toContain("Admin Setup Required");
    expect(res.body).not.toContain("ADMIN_DASHBOARD");
  });
});

describe("GET /admin — no credentials at all (no session cookie, no X-Admin-Key header)", () => {
  test("returns the 'Admin Setup Required' page (not admin.html) when the request is fully unauthenticated", async () => {
    const handler = await buildStaticHandler("/admin");
    const ctx = makeCtxWithHtml({
      method: "GET",
      headers: {},
    });

    const res = await handler(ctx);

    expect(res.status).toBe(200);
    expect(res.body).toContain("Admin Setup Required");
    expect(res.body).not.toContain("ADMIN_DASHBOARD");
  });
});

// ===========================================================================
// GET /users
// ===========================================================================

describe("GET /users — admin-role session cookie (no X-Admin-Key header)", () => {
  test("returns 200 with users HTML when session role is 'admin'", async () => {
    const handler = await buildStaticHandler("/users");
    const ctx = makeCtxWithHtml({
      method: "GET",
      headers: { Cookie: sessionCookie("admin") },
    });

    const res = await handler(ctx);

    expect(res.status).toBe(200);
    expect(res.body).toContain("USERS_DASHBOARD");
  });
});

describe("GET /users — valid X-Admin-Key header (no session cookie)", () => {
  test("returns 200 with users HTML when X-Admin-Key matches ADMIN_API_KEY", async () => {
    const handler = await buildStaticHandler("/users");
    const ctx = makeCtxWithHtml({
      method: "GET",
      headers: { "X-Admin-Key": ADMIN_KEY },
    });

    const res = await handler(ctx);

    expect(res.status).toBe(200);
    expect(res.body).toContain("USERS_DASHBOARD");
  });
});

describe("GET /users — admin_key cookie alone (Task #831 regression guard)", () => {
  test("does NOT serve users HTML when only admin_key cookie is present (cookie path removed in Task #831; X-Admin-Key header is now required)", async () => {
    const handler = await buildStaticHandler("/users");
    const ctx = makeCtxWithHtml({
      method: "GET",
      headers: { Cookie: `admin_key=${ADMIN_KEY}` },
    });

    const res = await handler(ctx);

    expect(res.status).toBe(200);
    expect(res.body).toContain("Admin Setup Required");
    expect(res.body).not.toContain("USERS_DASHBOARD");
  });
});

describe("GET /users — non-admin session (no X-Admin-Key header)", () => {
  test("returns the 'Admin Setup Required' page (not users.html) when session role is not 'admin'", async () => {
    const handler = await buildStaticHandler("/users");
    const ctx = makeCtxWithHtml({
      method: "GET",
      headers: { Cookie: sessionCookie("quality_manager") },
    });

    const res = await handler(ctx);

    expect(res.status).toBe(200);
    expect(res.body).toContain("Admin Setup Required");
    expect(res.body).not.toContain("USERS_DASHBOARD");
  });
});

describe("GET /users — no credentials at all (no session cookie, no X-Admin-Key header)", () => {
  test("returns the 'Admin Setup Required' page (not users.html) when the request is fully unauthenticated", async () => {
    const handler = await buildStaticHandler("/users");
    const ctx = makeCtxWithHtml({
      method: "GET",
      headers: {},
    });

    const res = await handler(ctx);

    expect(res.status).toBe(200);
    expect(res.body).toContain("Admin Setup Required");
    expect(res.body).not.toContain("USERS_DASHBOARD");
  });
});
