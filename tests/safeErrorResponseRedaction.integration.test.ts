/**
 * Integration test — proves that on a live Hono request flowing through
 * `globalMiddleware`, the response post-processor `redactSecretsInResponse`
 * actually scrubs credential-shaped substrings out of 4xx/5xx JSON bodies.
 *
 * Why this companion test exists
 * ------------------------------
 * tests/safeErrorResponseRedaction.test.ts unit-tests the helper
 * `redactSecretsInResponse(c)` directly. That proves the helper behaves
 * correctly but does NOT prove the middleware actually invokes it on a real
 * request. Removing `await redactSecretsInResponse(c)` from
 * `globalMiddleware` would silently regress the leak that task #454 was
 * added to prevent — the unit suite alone would still pass.
 *
 * Production parity
 * -----------------
 * Mastra's deployer (`node_modules/@mastra/deployer/dist/server/index.js`,
 * line 12240) installs `app.onError((err, c) => errorHandler(err, c, isDev))`
 * on the Hono app it builds for the server. `errorHandler` renders:
 *   - non-HTTPException → `c.json({ error: "Internal Server Error" }, 500)`
 *     (a STATIC body — `error.message` never reaches the wire), and
 *   - HTTPException     → `c.json({ error: err.message }, status)` — whose
 *     body still flows through this middleware's `redactSecretsInResponse(c)`
 *     post-processor because Hono's per-dispatch try/catch (see
 *     node_modules/hono/dist/compose.js) converts the throw into a Response
 *     INSIDE compose and the surrounding `await next()` resolves normally.
 * We mirror that exact `app.onError` here so the test exercises the real
 * production response-rendering path. Task #538 confirmed that the previous
 * `redactErrorForRethrow` rewrap branch in `globalMiddleware` was dead code
 * — Mastra's onError captures the throw before the middleware's outer catch
 * can ever observe it.
 *
 * Routes exercised:
 *   1. `/api/health/json-secret`   — `c.json({ details }, 500)` with a
 *      `sk-live-…` credential in `details`. Direct exercise of the
 *      post-processor on a route-rendered error body.
 *   2. `/api/health/throw-secret`  — throws `Error("...sk-live-...")`.
 *      Mastra's onError converts this to a STATIC `"Internal Server Error"`
 *      body — the secret cannot reach the wire even without any rewrap.
 *   3. `/api/health/throw-http-secret` — throws
 *      `new HTTPException(502, { message: "...sk-live-..." })`. Mastra's
 *      onError renders `{ error: err.message }` → the credential WOULD be
 *      echoed if the post-processor weren't wired. Asserts the post-
 *      processor scrubbed it out.
 *   4. `/api/health/ok-with-secret-shape` — happy-path control. 2xx bodies
 *      MUST NOT be walked.
 *   5. `/api/health/throw-mastra-secret` — throws a `MastraError` with id
 *      `AGENT_MEMORY_MISSING_RESOURCE_ID` (the exact id the previously-
 *      removed catch ladder special-cased). Mastra's onError treats it
 *      as a non-HTTPException → static `"Internal Server Error"` body.
 *      This pins down task #576's claim that the deleted
 *      `if (error instanceof MastraError) { throw new NonRetriableError(...) }`
 *      branch was dead code: the throw never reaches `globalMiddleware`'s
 *      outer catch, so wrapping in `NonRetriableError` never had an
 *      observable effect on the wire response.
 *   6. `/api/health/throw-zod-secret` — throws a `z.ZodError` whose
 *      message contains a credential. Mastra's onError renders the same
 *      static `"Internal Server Error"` body. Pins down the second half
 *      of task #576: the deleted
 *      `else if (error instanceof z.ZodError) { throw new NonRetriableError(...) }`
 *      branch was equally dead.
 *
 * Regression guarantees:
 *   - Remove `await redactSecretsInResponse(c)` from `globalMiddleware`
 *     → tests #1 and #3 fail (the credential reappears in the body).
 *   - Tests #2, #5 and #6 will keep passing without the post-processor;
 *     that's intentional — they document that Mastra's static `"Internal
 *     Server Error"` is itself the production defense for non-HTTPException
 *     throws (whatever their concrete subclass), not the (deleted)
 *     catch-block rewrap.
 *   - If a future contributor re-introduces the
 *     `if (error instanceof MastraError) { throw new NonRetriableError(...) }`
 *     ladder inside `globalMiddleware`'s catch, tests #5 and #6 still
 *     pass — that's by design: the rewrap is harmless because the
 *     catch never runs in production. The real regression signal in that
 *     case is the dead-code comment block above the catch becoming
 *     stale, which is enforced by reviewers.
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
import { HTTPException } from "hono/http-exception";
import { MastraError } from "@mastra/core/error";
import { z } from "zod";
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

function buildApp(): Hono {
  const app = new Hono();

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

  // Route #2 — uncaught throw with secret in `.message`. In production the
  // Mastra-installed `app.onError` (mirrored below) converts this to a
  // static "Internal Server Error" body — the secret never reaches the wire.
  app.get("/api/health/throw-secret", () => {
    throw new Error(`Stripe rejected token ${SECRET}`);
  });

  // Route #3 — uncaught HTTPException with secret in `.message`. Mastra's
  // onError DOES echo the message into the body (`{ error: err.message }`),
  // so this is the path where `redactSecretsInResponse` is the actual
  // production defense.
  app.get("/api/health/throw-http-secret", () => {
    throw new HTTPException(502, {
      message: `Bad gateway: token ${SECRET} was rejected upstream`,
    });
  });

  // Route #4 — happy-path control: a 2xx body containing a credential-
  // shaped substring. The post-processor MUST NOT walk this.
  app.get("/api/health/ok-with-secret-shape", (c) => {
    return c.json({ note: SECRET }, 200);
  });

  // Route #5 — uncaught MastraError with the same `id`
  // (`AGENT_MEMORY_MISSING_RESOURCE_ID`) the previously-removed catch
  // ladder special-cased. Mastra's onError treats every non-HTTPException
  // identically — static `"Internal Server Error"` body — so the throw
  // never reaches `globalMiddleware`'s catch and the deleted
  // `throw new NonRetriableError(...)` rewrap could not have had any
  // observable effect on the wire response. See task #576.
  app.get("/api/health/throw-mastra-secret", () => {
    throw new MastraError({
      id: "AGENT_MEMORY_MISSING_RESOURCE_ID",
      domain: "AGENT",
      category: "USER",
      text: `Memory bootstrap failed; upstream said token ${SECRET} was rejected`,
      details: { agentName: "test-agent", threadId: "", resourceId: "" },
    });
  });

  // Route #6 — uncaught z.ZodError whose message contains a credential.
  // Same outcome as #5: rendered as the static `"Internal Server Error"`
  // body. Pins down the second half of task #576.
  app.get("/api/health/throw-zod-secret", () => {
    const schema = z.object({
      token: z.string().refine(() => false, {
        message: `Bearer ${SECRET} rejected by upstream validator`,
      }),
    });
    schema.parse({ token: "anything" });
  });

  // Mirror the production `app.onError` from
  // `node_modules/@mastra/deployer/dist/server/index.js` (function
  // `errorHandler`). Hono's per-dispatch try/catch in `compose()` routes
  // every uncaught throw to this handler BEFORE the surrounding middleware's
  // outer catch can observe it (see file header for why this matters).
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    return c.json({ error: "Internal Server Error" }, 500);
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

  // 2. Uncaught plain throw — proves Mastra's production onError is the
  // defense for this path (renders a static "Internal Server Error" body),
  // NOT the (removed) catch-block rewrap. The credential cannot leak even
  // if `redactSecretsInResponse` is removed, because `error.message` never
  // reaches the wire to begin with.
  {
    const app = buildApp();
    const res = await app.request("/api/health/throw-secret", {
      method: "GET",
      headers: { "X-Admin-Key": ADMIN_KEY },
    });
    const body = (await res.json()) as { error?: string };

    assert(
      res.status === 500,
      "throw-secret request renders a 500 HTTP response (Mastra onError caught the throw)",
    );
    assert(
      body.error === "Internal Server Error",
      "throw-secret response body is the static Mastra fallback (no error.message echo)",
    );
    assert(
      JSON.stringify(body).indexOf(SECRET) === -1,
      "throw-secret HTTP response body does NOT carry the raw sk-live-… credential",
    );
  }

  // 3. Uncaught HTTPException — Mastra's onError DOES echo `err.message`
  // into the response body (`{ error: err.message }`), so this is the path
  // where `redactSecretsInResponse` is the production defense. Removing
  // `await redactSecretsInResponse(c)` from globalMiddleware regresses
  // this test.
  {
    const app = buildApp();
    const res = await app.request("/api/health/throw-http-secret", {
      method: "GET",
      headers: { "X-Admin-Key": ADMIN_KEY },
    });
    const body = (await res.json()) as { error?: string };

    assert(
      res.status === 502,
      "throw-http-secret request renders the HTTPException status code (502)",
    );
    assert(
      typeof body.error === "string" &&
        body.error.includes(REDACTED_SENTINEL),
      "throw-http-secret response error has REDACTED sentinel (post-processor scrubbed err.message)",
    );
    assert(
      typeof body.error === "string" && !body.error.includes(SECRET),
      "throw-http-secret response does NOT carry the raw sk-live-… credential from HTTPException.message",
    );
  }

  // 4. 2xx success — regression guard against over-broad scrubbing.
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

  // 5. Uncaught MastraError — proves Mastra's onError treats it as a
  // generic non-HTTPException and renders the static fallback. The
  // credential carried in `error.message` cannot reach the wire because
  // `error.message` itself never reaches the wire. This pins down the
  // claim from task #576 that the deleted
  //   if (error instanceof MastraError && error.id === "AGENT_MEMORY_MISSING_RESOURCE_ID") {
  //     throw new NonRetriableError(redactSecretLikeStrings(error.message), { cause: error });
  //   }
  // branch was dead code in production: this throw never reaches
  // `globalMiddleware`'s outer catch in the first place.
  {
    const app = buildApp();
    const res = await app.request("/api/health/throw-mastra-secret", {
      method: "GET",
      headers: { "X-Admin-Key": ADMIN_KEY },
    });
    const body = (await res.json()) as { error?: string };

    assert(
      res.status === 500,
      "throw-mastra-secret request renders a 500 HTTP response (Mastra onError caught the throw)",
    );
    assert(
      body.error === "Internal Server Error",
      "throw-mastra-secret response body is the static Mastra fallback (no error.message echo)",
    );
    assert(
      JSON.stringify(body).indexOf(SECRET) === -1,
      "throw-mastra-secret HTTP response body does NOT carry the raw sk-live-… credential",
    );
  }

  // 6. Uncaught z.ZodError — same proof for the second deleted branch.
  // Mastra's onError treats it as a non-HTTPException and renders the
  // static fallback; the credential embedded in the Zod issue message
  // never reaches the wire, so the deleted
  //   else if (error instanceof z.ZodError) {
  //     throw new NonRetriableError(redactSecretLikeStrings(error.message), { cause: error });
  //   }
  // branch was likewise dead code.
  {
    const app = buildApp();
    const res = await app.request("/api/health/throw-zod-secret", {
      method: "GET",
      headers: { "X-Admin-Key": ADMIN_KEY },
    });
    const body = (await res.json()) as { error?: string };

    assert(
      res.status === 500,
      "throw-zod-secret request renders a 500 HTTP response (Mastra onError caught the throw)",
    );
    assert(
      body.error === "Internal Server Error",
      "throw-zod-secret response body is the static Mastra fallback (no ZodError message echo)",
    );
    assert(
      JSON.stringify(body).indexOf(SECRET) === -1,
      "throw-zod-secret HTTP response body does NOT carry the raw sk-live-… credential",
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
