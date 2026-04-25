/**
 * Verifies that the global middleware's response post-processor scrubs
 * credential-shaped substrings out of any 4xx/5xx JSON error body before
 * it leaves the server.
 *
 * Background
 * ----------
 * We already redact credential-shaped substrings before WRITING anything to
 * the database (event_logs, change_history, ai_pending_actions). However,
 * when a route's catch block returns
 *   c.json({ error: 'Failed to …', details: error.message }, 500)
 * the raw exception text — which may include the credential echoed back by
 * the upstream SDK (e.g. "Invalid token sk-live-…") — was previously
 * returned to the user-facing API caller and surfaced in client toasts.
 *
 * This test exercises the `redactSecretsInResponse(c)` post-processor to
 * confirm credentials are replaced with REDACTED_SENTINEL on the response
 * boundary symmetric with the storage-side defense.
 *
 * NOTE: a previous revision of this file additionally exercised
 * `redactErrorForRethrow`, a helper that wrapped uncaught route throws so
 * the rewrapped Error.message reaching the "default Hono error renderer"
 * was credential-clean. Task #538 established that the rewrap was dead
 * code in production — Mastra's deployer installs an `app.onError` that
 * intercepts every thrown route handler error inside Hono's per-dispatch
 * try/catch and either renders a static "Internal Server Error" body
 * (non-HTTPException) or a `{ error: err.message }` body that still flows
 * through `redactSecretsInResponse` below. The helper and the dedicated
 * unit-level coverage for it have been removed; the production-realistic
 * end-to-end coverage now lives in
 * tests/safeErrorResponseRedaction.integration.test.ts.
 *
 * Run:  npx tsx tests/safeErrorResponseRedaction.test.ts
 */

import { redactSecretsInResponse } from '../src/mastra/middleware/index';
import { REDACTED_SENTINEL } from '../src/utils/eventLogsDatabase';

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

function makeJsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function makeFakeContext(res: Response): { res: Response } {
  return { res };
}

async function bodyOf(res: Response): Promise<any> {
  const text = await res.clone().text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

(async function main() {
  // 1. sk-live-… in error.details is redacted ----------------------------------
  {
    const ctx = makeFakeContext(
      makeJsonResponse(
        {
          error: 'Failed to call upstream',
          details: 'Invalid token sk-live-1234567890abcdefghij1234567890abcdef supplied',
        },
        500,
      ),
    );
    await redactSecretsInResponse(ctx);
    const body = await bodyOf(ctx.res);
    assert(
      typeof body.details === 'string' && body.details.includes(REDACTED_SENTINEL),
      '500 response with sk-live-… in details has the secret replaced with REDACTED sentinel',
    );
    assert(
      typeof body.details === 'string' && !body.details.includes('sk-live-1234567890'),
      '500 response with sk-live-… does not echo the original secret back',
    );
    assert(body.error === 'Failed to call upstream', 'non-secret error label is preserved verbatim');
    assert(ctx.res.status === 500, 'status code is preserved');
  }

  // 2. ghp_… in 4xx error response is redacted ---------------------------------
  {
    const ctx = makeFakeContext(
      makeJsonResponse(
        {
          error: 'Bad request',
          details: 'GitHub PAT ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 was rejected',
        },
        400,
      ),
    );
    await redactSecretsInResponse(ctx);
    const body = await bodyOf(ctx.res);
    assert(
      typeof body.details === 'string' && body.details.includes(REDACTED_SENTINEL),
      '400 response with ghp_… in details has the secret replaced with REDACTED sentinel',
    );
    assert(
      typeof body.details === 'string' &&
        !body.details.includes('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'),
      '400 response with ghp_… does not echo the original secret back',
    );
  }

  // 3. Bearer header echoed in nested error body is redacted -------------------
  {
    const ctx = makeFakeContext(
      makeJsonResponse(
        {
          error: 'Auth failed',
          details: {
            upstream: {
              status: 401,
              body: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature was rejected',
            },
          },
        },
        500,
      ),
    );
    await redactSecretsInResponse(ctx);
    const body = await bodyOf(ctx.res);
    const inner = body?.details?.upstream?.body;
    assert(
      typeof inner === 'string' && inner.includes(REDACTED_SENTINEL),
      'nested string leaves are walked and redacted (deep)',
    );
    assert(
      typeof inner === 'string' && !inner.includes('Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature'),
      'nested Bearer token is removed from the response body',
    );
  }

  // 4. Successful 2xx responses are NOT walked --------------------------------
  // Real entity payloads with the literal substring "sk-live-…" are extremely
  // rare, but we still must not pay the cost of walking multi-MB success
  // bodies on every request, AND we must not corrupt entity data that
  // happens to contain a string matching the deny-list.
  {
    const ctx = makeFakeContext(
      makeJsonResponse(
        {
          name: 'Token registration record',
          notes: 'sk-live-1234567890abcdefghij1234567890abcdef',
        },
        200,
      ),
    );
    await redactSecretsInResponse(ctx);
    const body = await bodyOf(ctx.res);
    assert(
      body.notes === 'sk-live-1234567890abcdefghij1234567890abcdef',
      '2xx success bodies are passed through untouched',
    );
    assert(ctx.res.status === 200, '2xx status is preserved');
  }

  // 5. Non-JSON error responses (e.g. an HTML 500 page) are not touched -------
  {
    const html = '<html><body>500 error: token sk-live-1234567890abcdefghij1234567890abcdef</body></html>';
    const ctx = makeFakeContext(
      new Response(html, {
        status: 500,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    );
    await redactSecretsInResponse(ctx);
    const text = await ctx.res.clone().text();
    // Non-JSON bodies are skipped — we don't want to corrupt HTML / file
    // streams. The HTML-page concern is a separate defense (the dashboards
    // never render server-side error pages with raw exception messages
    // anyway).
    assert(text === html, 'non-JSON 5xx responses are not modified');
  }

  // 6. Bodies without secret-shaped substrings are returned identical ---------
  // (The post-processor must not change the byte stream when it has no work
  // to do — invariant relied upon by Content-Length and downstream caching.)
  {
    const original = JSON.stringify({ error: 'Validation failed', details: 'name is required' });
    const ctx = makeFakeContext(
      new Response(original, {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const refBefore = ctx.res;
    await redactSecretsInResponse(ctx);
    assert(ctx.res === refBefore, 'no-op when body contains no credential-shaped substrings');
    const text = await ctx.res.clone().text();
    assert(text === original, 'body bytes are byte-for-byte identical when no redaction occurred');
  }

  // 7. Missing/unset response is tolerated ------------------------------------
  {
    const ctx: any = { res: undefined };
    await redactSecretsInResponse(ctx);
    assert(ctx.res === undefined, 'undefined response is tolerated (no throw)');
  }

  // ---------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
