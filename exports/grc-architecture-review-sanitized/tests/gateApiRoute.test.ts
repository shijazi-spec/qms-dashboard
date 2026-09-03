/**
 * Unit tests for `gateApiRoute` in src/utils/rbacMiddleware.ts.
 *
 * `gateApiRoute` wraps every route definition whose path starts with `/api/`
 * with a per-handler `requireAuthOrKey` gate. It is the *last line of defence*
 * that ensures a handler never runs for an unauthenticated caller — even when
 * the global middleware in src/mastra/middleware/index.ts is bypassed (for
 * example, when an integration test invokes a handler directly through
 * tests/_helpers/fakeContext.ts).
 *
 * Branches covered:
 *   1. Non-/api/ path is returned untouched (static page handlers fall through
 *      to the page-auth middleware which redirects to /login).
 *   2. /api/ path called with a valid X-Admin-Key → the inner handler runs and
 *      its response is returned.
 *   3. /api/ path called with no key and no session → a 401 JSON response is
 *      returned and the inner handler is NEVER invoked.
 *
 * Additional coverage:
 *   - createHandler dependency object is forwarded to the original creator.
 *   - Async createHandler implementations are awaited.
 *   - The wrapped object preserves all other route fields (method, etc.).
 *   - A signed admin session cookie also satisfies the gate (no key required).
 *
 * No live DB or real Hono server is required — the context is mocked with the
 * same minimal `req.header(name)` / `c.json(body, status)` surface used by
 * tests/_helpers/fakeContext.ts.
 *
 * Run:  npx tsx tests/gateApiRoute.test.ts
 */

const TEST_ADMIN_KEY = "test-admin-key-gate-xyz";
const TEST_SESSION_SECRET = "test-session-secret-gate-789";

process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
process.env.SESSION_SECRET = TEST_SESSION_SECRET;
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import crypto from "crypto";
import { gateApiRoute } from "../src/utils/rbacMiddleware";

const SESSION_COOKIE_NAME = "ExampleOrg_session";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function assertEquals<T>(actual: T, expected: T, label: string): void {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`      expected: ${JSON.stringify(expected)}`);
    console.error(`      actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

/**
 * Mirrors signSession() in src/mastra/routes/authRoutes.ts so tests can mint
 * a valid session cookie without going through OIDC.
 */
function signSession(payload: Record<string, any>): string {
  const secret = process.env.SESSION_SECRET!;
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

interface MockContextOptions {
  adminKeyHeader?: string;
  cookies?: Record<string, string>;
}

/**
 * Minimal Hono-like context: `req.header(name)` and a `json(body, status?)`
 * that captures the response so we can assert on status / payload.
 */
function makeContext(opts: MockContextOptions = {}): any {
  const headers: Record<string, string> = {};
  if (opts.adminKeyHeader !== undefined) {
    headers["X-Admin-Key"] = opts.adminKeyHeader;
  }
  if (opts.cookies && Object.keys(opts.cookies).length > 0) {
    headers["Cookie"] = Object.entries(opts.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  return {
    req: {
      header: (name: string): string | undefined => headers[name],
    },
    json: (body: any, status: number = 200) => ({ status, body }),
  };
}

function adminSessionCookie(role: string = "admin"): string {
  const token = signSession({
    userId: 1,
    email: "user@example.invalid",
    name: "Test Admin",
    role,
    exp: Date.now() + 60_000,
  });
  return encodeURIComponent(token);
}

console.log("\n=== gateApiRoute unit tests (rbacMiddleware) ===\n");

// ─── Branch 1: non-/api/ path → returned untouched ──────────────────────────
console.log("Branch: non-/api/ path is returned untouched (no auth gate added)");
{
  let innerCalled = 0;
  const route = {
    path: "/projects",
    method: "GET",
    createHandler: (_deps: any) => {
      return (c: any) => {
        innerCalled++;
        return c.json({ ok: true, page: "projects" });
      };
    },
  };

  const wrapped = gateApiRoute(route);

  // The exact same object reference must come back — no wrapping happened.
  assert(wrapped === route, "wrapped route object is the original reference");
  assertEquals(wrapped.path, "/projects", "path is preserved");
  assertEquals((wrapped as any).method, "GET", "method is preserved");
  assertEquals(
    wrapped.createHandler,
    route.createHandler,
    "createHandler is the original function (no wrapping)"
  );

  // Even when called with no auth at all, the inner handler must still run —
  // that is the whole point of the static-page passthrough.
  const handler = (wrapped.createHandler as any)({});
  const res = handler(makeContext());
  assertEquals(innerCalled, 1, "inner handler runs even with no auth");
  assertEquals(
    res.body.page,
    "projects",
    "response body comes from the inner handler"
  );
}
console.log();

// ─── Branch 1b: nested non-/api/ paths still pass through ───────────────────
console.log("Branch: deeper non-/api/ path (e.g. /onboarding/welcome) also passes through");
{
  const route = {
    path: "/onboarding/welcome",
    createHandler: (_deps: any) => (c: any) => c.json({ ok: true }),
  };
  const wrapped = gateApiRoute(route);
  assert(wrapped === route, "deeper static page route is also untouched");
}
console.log();

// ─── Branch 1c: '/api' (no trailing slash) is still treated as non-/api/ ────
console.log("Branch: '/api' without trailing slash is NOT gated (only /api/ prefix is)");
{
  const route = {
    path: "/api",
    createHandler: (_deps: any) => (c: any) => c.json({ ok: true }),
  };
  const wrapped = gateApiRoute(route);
  assert(
    wrapped === route,
    "'/api' (no trailing slash) is returned untouched — gate keys off '/api/' prefix"
  );
}
console.log();

// ─── Branch 2: /api/ + valid admin key only → 401 (key is not a session) ────
// The X-Admin-Key is scoped to /api/admin/* routes.  gateApiRoute wraps
// application /api/* routes which require a real OIDC session.  An admin key
// without a session must NOT bypass the gate; routes that legitimately need
// server-to-server admin-key access call requireAdminOrKey() themselves AND
// are reached through the global middleware's /api/admin/* fast-path.
console.log("Branch: /api/ path with valid X-Admin-Key but no session → 401 (key is not a session)");
await (async () => {
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  let innerCalled = 0;
  let receivedDeps: any = null;
  const sentinelDeps = { db: { tag: "fake-db" }, logger: () => {} };

  const route = {
    path: "/api/widgets",
    method: "GET",
    createHandler: (deps: any) => {
      receivedDeps = deps;
      return (c: any) => {
        innerCalled++;
        return c.json({ ok: true, widgets: [1, 2, 3] });
      };
    },
  };

  const wrapped = gateApiRoute(route);
  assert(wrapped !== route, "/api/ route returns a new wrapper object");
  assertEquals(wrapped.path, "/api/widgets", "path is preserved on the wrapper");
  assertEquals(
    (wrapped as any).method,
    "GET",
    "method is preserved on the wrapper"
  );

  const handler = await (wrapped.createHandler as any)(sentinelDeps);
  assert(
    receivedDeps === sentinelDeps,
    "deps object is forwarded to the original createHandler"
  );

  const c = makeContext({ adminKeyHeader: TEST_ADMIN_KEY });
  const res = await handler(c);

  assertEquals(innerCalled, 0, "inner handler is NOT invoked for key-only callers");
  assertEquals(res.status, 401, "response status is 401 (key is not a session identity)");
})();
console.log();

// ─── Branch 2b: /api/ + valid signed session cookie → inner handler runs ────
console.log("Branch: /api/ path with valid session cookie (no key) → inner handler runs");
await (async () => {
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  let innerCalled = 0;
  const route = {
    path: "/api/widgets",
    createHandler: (_deps: any) => (c: any) => {
      innerCalled++;
      return c.json({ ok: true, source: "session" });
    },
  };

  const wrapped = gateApiRoute(route);
  const handler = await (wrapped.createHandler as any)({});
  const c = makeContext({
    cookies: { [SESSION_COOKIE_NAME]: adminSessionCookie("quality_manager") },
  });
  const res = await handler(c);

  assertEquals(innerCalled, 1, "inner handler runs for an authenticated session user");
  assertEquals(res.status, 200, "response status is 200");
  assertEquals(res.body.source, "session", "inner handler's response body is returned");
})();
console.log();

// ─── Branch 3: /api/ + no key + no session → 401, inner NEVER runs ──────────
console.log("Branch: /api/ path with no key and no session → 401, inner handler never runs");
await (async () => {
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  let innerCalled = 0;
  const route = {
    path: "/api/widgets",
    createHandler: (_deps: any) => (c: any) => {
      innerCalled++;
      return c.json({ ok: true });
    },
  };

  const wrapped = gateApiRoute(route);
  const handler = await (wrapped.createHandler as any)({});

  const c = makeContext();
  const res = await handler(c);

  assertEquals(innerCalled, 0, "inner handler is NOT invoked for unauthenticated calls");
  assertEquals(res.status, 401, "response status is 401");
  assertEquals(
    res.body.error,
    "Authentication required",
    "response body is the standard unauthorizedResponse payload"
  );
})();
console.log();

// ─── Branch 3b: /api/ + wrong admin key → 401, inner NEVER runs ─────────────
console.log("Branch: /api/ path with WRONG admin key → 401, inner handler never runs");
await (async () => {
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  let innerCalled = 0;
  const route = {
    path: "/api/widgets",
    createHandler: (_deps: any) => (c: any) => {
      innerCalled++;
      return c.json({ ok: true });
    },
  };

  const wrapped = gateApiRoute(route);
  const handler = await (wrapped.createHandler as any)({});

  const c = makeContext({ adminKeyHeader: "definitely-not-the-key" });
  const res = await handler(c);

  assertEquals(innerCalled, 0, "inner handler is NOT invoked when key mismatches");
  assertEquals(res.status, 401, "response status is 401");
})();
console.log();

// ─── Branch 3c: /api/ + tampered session cookie → 401, inner NEVER runs ─────
console.log("Branch: /api/ path with tampered session cookie → 401, inner handler never runs");
await (async () => {
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  let innerCalled = 0;
  const route = {
    path: "/api/widgets",
    createHandler: (_deps: any) => (c: any) => {
      innerCalled++;
      return c.json({ ok: true });
    },
  };

  const wrapped = gateApiRoute(route);
  const handler = await (wrapped.createHandler as any)({});

  const goodToken = signSession({
    userId: 1,
    email: "x@y.z",
    name: "x",
    role: "admin",
    exp: Date.now() + 60_000,
  });
  const [data] = goodToken.split(".");
  const forged = `${data}.deadbeefnotavalidsignature`;

  const c = makeContext({
    cookies: { [SESSION_COOKIE_NAME]: encodeURIComponent(forged) },
  });
  const res = await handler(c);

  assertEquals(innerCalled, 0, "inner handler is NOT invoked when session is tampered");
  assertEquals(res.status, 401, "response status is 401");
})();
console.log();

// ─── Branch 4: ADMIN_API_KEY env unset + matching header → still 401 ────────
console.log("Branch: ADMIN_API_KEY env unset → matching header is rejected (defence-in-depth)");
await (async () => {
  delete process.env.ADMIN_API_KEY;

  let innerCalled = 0;
  const route = {
    path: "/api/widgets",
    createHandler: (_deps: any) => (c: any) => {
      innerCalled++;
      return c.json({ ok: true });
    },
  };

  const wrapped = gateApiRoute(route);
  const handler = await (wrapped.createHandler as any)({});

  // Even with a non-empty header, no env value means no key auth path exists.
  const c = makeContext({ adminKeyHeader: TEST_ADMIN_KEY });
  const res = await handler(c);

  assertEquals(
    innerCalled,
    0,
    "inner handler is NOT invoked when ADMIN_API_KEY env is unset"
  );
  assertEquals(res.status, 401, "response status is 401");

  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
})();
console.log();

// ─── Branch 5: async createHandler is awaited, not double-wrapped ───────────
console.log("Branch: async createHandler — promise is awaited before request handling");
await (async () => {
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;

  let innerCalled = 0;
  const route = {
    path: "/api/async-widgets",
    // Returns a promise that resolves to the inner handler — exercises the
    // `await originalCreate(deps)` line in gateApiRoute.
    createHandler: async (_deps: any) => {
      await new Promise((r) => setTimeout(r, 1));
      return (c: any) => {
        innerCalled++;
        return c.json({ ok: true, async: true });
      };
    },
  };

  const wrapped = gateApiRoute(route);
  const handler = await (wrapped.createHandler as any)({});

  // Authenticated via session → inner runs.
  const cAuth = makeContext({
    cookies: { [SESSION_COOKIE_NAME]: adminSessionCookie("quality_manager") },
  });
  const okRes = await handler(cAuth);
  assertEquals(innerCalled, 1, "async inner handler runs for authenticated caller");
  assertEquals(okRes.status, 200, "async inner handler response is 200");
  assertEquals(okRes.body.async, true, "async inner handler body is returned");

  // Unauthenticated → 401, inner does NOT run.
  const cAnon = makeContext();
  const denyRes = await handler(cAnon);
  assertEquals(innerCalled, 1, "async inner handler is NOT invoked for unauth caller");
  assertEquals(denyRes.status, 401, "unauthenticated async call is 401");
})();
console.log();

console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("\n❌ gateApiRoute unit tests FAILED");
  process.exit(1);
}

console.log("\n✅ All gateApiRoute unit tests passed");
