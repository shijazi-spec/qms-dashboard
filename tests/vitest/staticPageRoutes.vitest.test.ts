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
// Import the module under test **after** the vi.mock() call so it picks up
// the mocked `fs`.
// ---------------------------------------------------------------------------
import { staticPageRoutes } from "../../src/mastra/routes/staticPageRoutes";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ADMIN_KEY = "vitest-static-page-admin-key-2026";
const SESSION_SECRET = "vitest-static-page-session-secret";

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

/** Build a `walaplus_session` cookie string for the given role. */
function sessionCookie(role: string): string {
  const token = signSession({
    userId: 1,
    email: "tester@example.com",
    name: "Test User",
    role,
  });
  return `walaplus_session=${encodeURIComponent(token)}`;
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
  return route.createHandler(undefined) as Promise<
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
