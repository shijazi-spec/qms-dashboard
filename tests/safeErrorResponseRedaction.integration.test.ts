/**
 * Integration test — the global middleware actually invokes the
 * secret-redaction post-processor AND the catch-block error rewrap on a
 * real request flowing through Hono.
 *
 * Companion to tests/safeErrorResponseRedaction.test.ts: the unit suite
 * calls `redactSecretsInResponse` and `redactErrorForRethrow` directly,
 * which proves the helpers behave correctly but does NOT prove the
 * middleware actually calls them on a live request. Removing either call
 * from `globalMiddleware` would silently regress the leak that task #454
 * was added to prevent — the unit suite would still go green.
 *
 * This file mounts `globalMiddleware` on a tiny Hono app (the same way
 * `src/mastra/index.ts` does for the real server), drives three routes
 * over Hono's `app.request()` API, and asserts on the live HTTP responses:
 *
 *   1. `/api/health/json-secret` — `c.json({ details }, 500)` with a
 *      `sk-live-…` credential in `details`. Exercises the post-processor.
 *   2. `/api/health/throw-secret` — throws `Error("...sk-live-...")`.
 *      An outer wrapper middleware (registered before `globalMiddleware`
 *      so its try/catch sits outside Hono's per-dispatch try/catch) catches
 *      the rewrapped error escaping `globalMiddleware` and renders it as
 *      a 500 JSON body — standing in for production renderers (Mastra
 *      workflow execution, Inngest function failure handlers, structured
 *      logger metadata path) that surface re-raised exceptions to clients.
 *   3. `/api/health/ok-with-secret-shape` — happy-path control. 2xx bodies
 *      MUST NOT be walked.
 *
 * Regression guarantees:
 *   - Remove `await redactSecretsInResponse(c)` → test #1 assertions fail.
 *   - Remove `throw redactErrorForRethrow(error)` → test #2 assertions fail.
 *   The two regressions are detectable independently of each other.
 *
 * Why `app.onError` re-throws: Hono's `compose()` wraps every dispatch
 * level in its own try/catch and shunts errors to `onError` BEFORE the
 * middleware's outer catch can see them (see node_modules/hono/dist/
 * compose.js). Re-throwing from `onError` lets the throw bubble through
 * `await next()` in `globalMiddleware`, exercising the rewrap.
 *
 * Run:  npx tsx tests/safeErrorResponseRedaction.integration.test.ts
 */

// Env vars MUST be set before the middleware module is loaded — it reads
// `RATE_LIMIT_429_LOG_MAX_PER_MIN` at module init and `RATE_LIMIT_DISABLED`
// per call. `ADMIN_API_KEY` lets `checkApiAuth` accept the X-Admin-Key
// header without DB-backed session lookup.
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "a".repeat(64);
process.env.RATE_LIMIT_DISABLED = "true";
process.env.REPLIT_DOMAINS = process.env.REPLIT_DOMAINS || "localhost:5000";

import { Hono, type MiddlewareHandler } from "hono";
import { globalMiddleware } from "../src/mastra/middleware/index";
import { REDACTED_SENTINEL } from "../src/utils/eventLogsDatabase";

// 40-char hex-shaped credential matching the `sk-live-` deny-list pattern
// in `redactSecretLikeStrings`.
const SECRET = "sk-live-1234567890abcdefghij1234567890abcdef";
const ADMIN_KEY = process.env.ADMIN_API_KEY!;

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

interface BuildAppOptions {
  /** Invoked with the rewrapped error escaping `globalMiddleware` so
   *  the test can additionally inspect the `cause` chain. */
  onCaughtError?: (err: unknown) => void;
}

function buildApp(opts: BuildAppOptions = {}): Hono {
  const app = new Hono();

  // Outer wrapper — registered BEFORE `globalMiddleware` so its try/catch
  // sits outside Hono's per-dispatch try/catch around the middleware. It
  // captures the rewrapped error and renders it into a real HTTP response
  // body for the test to assert on.
  app.use("*", async (c, next) => {
    try {
      await next();
    } catch (rewrappedErr) {
      opts.onCaughtError?.(rewrappedErr);
      const message =
        rewrappedErr instanceof Error
          ? rewrappedErr.message
          : String(rewrappedErr);
      return c.json({ error: "Internal", details: message }, 500);
    }
  });

  // Mount the production middleware exactly the way `src/mastra/index.ts`
  // does. `globalMiddleware` types its handlers as `(c: any, next: any)`
  // for cross-version Hono compatibility; we narrow to the concrete
  // `MiddlewareHandler` here without resorting to `as any`.
  app.use("*", ...(globalMiddleware as MiddlewareHandler[]));

  // Route #1 — `c.json(..., 500)` body with secret in `details`. Exercises
  // the response post-processor. `/api/health/...` is treated as an API
  // route by the middleware; the X-Admin-Key header satisfies auth.
  app.get("/api/health/json-secret", (c) => {
    return c.json(
      {
        error: "Failed to call upstream",
        details: `Invalid token ${SECRET} supplied`,
      },
      500,
    );
  });

  // Route #2 — uncaught throw with secret in `.message`. Exercises the
  // catch-block rewrap (or, if removed, leaks the raw secret into the
  // outer wrapper's rendered body).
  app.get("/api/health/throw-secret", () => {
    throw new Error(`Stripe rejected token ${SECRET}`);
  });

  // Route #3 — happy-path control: a 2xx body containing a credential-
  // shaped substring. The post-processor MUST NOT walk this.
  app.get("/api/health/ok-with-secret-shape", (c) => {
    return c.json({ note: SECRET }, 200);
  });

  // Re-throw from onError so the throw escapes Hono's per-dispatch
  // try/catch and bubbles through `await next()` in globalMiddleware,
  // exercising the catch-block rewrap (see file header).
  app.onError((err) => {
    throw err;
  });

  return app;
}

(async function main() {
  console.log("\n=== safeErrorResponseRedaction integration tests ===\n");

  // 1. c.json error body — proves the post-processor is wired.
  {
    const app = buildApp();
    const res = await app.request("/api/health/json-secret", {
      method: "GET",
      headers: { "X-Admin-Key": ADMIN_KEY },
    });
    const body = (await res.json()) as { error?: string; details?: string };
    assert(res.status === 500, "json-secret route returns 500");
    assert(
      typeof body.details === "string" &&
        body.details.includes(REDACTED_SENTINEL),
      "json-secret response details has REDACTED sentinel (post-processor ran)",
    );
    assert(
      typeof body.details === "string" && !body.details.includes(SECRET),
      "json-secret response does NOT echo the raw sk-live-… credential",
    );
    assert(
      body.error === "Failed to call upstream",
      "json-secret response preserves the safe outer label",
    );
  }

  // 2. Uncaught throw — proves the catch-block rewrap is wired. Asserts on
  // the real HTTP response body rendered by the outer wrapper, plus the
  // `cause` chain on the rewrapped Error captured via `onCaughtError`.
  {
    let captured: unknown;
    const app = buildApp({ onCaughtError: (e) => (captured = e) });
    const res = await app.request("/api/health/throw-secret", {
      method: "GET",
      headers: { "X-Admin-Key": ADMIN_KEY },
    });
    const body = (await res.json()) as { error?: string; details?: string };

    assert(
      res.status === 500,
      "throw-secret request renders a 500 HTTP response (rewrap escaped middleware)",
    );
    assert(
      typeof body.details === "string" &&
        body.details.includes(REDACTED_SENTINEL),
      "throw-secret HTTP response body has REDACTED sentinel (rewrap fired in middleware catch block)",
    );
    assert(
      typeof body.details === "string" && !body.details.includes(SECRET),
      "throw-secret HTTP response body does NOT carry the raw sk-live-… credential",
    );
    assert(
      captured instanceof Error,
      "outer wrapper saw the rewrapped Error escape globalMiddleware",
    );
    if (captured instanceof Error) {
      const cause = (captured as Error & { cause?: unknown }).cause;
      assert(
        cause instanceof Error && cause.message.includes(SECRET),
        "rewrapped Error preserves the original exception as `cause` (debuggability is not lost)",
      );
    }
  }

  // 3. 2xx success — regression guard against over-broad scrubbing.
  {
    const app = buildApp();
    const res = await app.request("/api/health/ok-with-secret-shape", {
      method: "GET",
      headers: { "X-Admin-Key": ADMIN_KEY },
    });
    const body = (await res.json()) as { note?: string };
    assert(res.status === 200, "200 happy-path response preserves its status");
    assert(
      body.note === SECRET,
      "2xx success bodies are passed through untouched (no over-broad scrub)",
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
