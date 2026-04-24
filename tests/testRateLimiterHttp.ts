/**
 * End-to-end HTTP load test for the distributed rate limiter.
 *
 * Unlike tests/testRateLimiterMultiInstance.ts (which calls checkRateLimit()
 * in-process), this test fires concurrent real HTTP requests against the live
 * server. It exercises the full middleware chain: header parsing
 * (X-Forwarded-For → parseClientIp), session/admin-key extraction, the auth
 * branch in src/mastra/middleware/index.ts, and the 429 + Retry-After
 * response shape. A regression in any of those layers would not be caught by
 * the in-process test but will be caught here.
 *
 * What it covers:
 *   1. POST /api/audit/trigger (authenticated write, WRITE_LIMIT=10)
 *      — fires 20 concurrent requests with X-Admin-Key + unique XFF and
 *        verifies at most 10 pass the rate limiter in a single 60s window.
 *   2. POST /api/admin/auth (unauthenticated auth flow, AUTH_LIMIT=5)
 *      — fires 15 concurrent requests with a deliberately-wrong key body
 *        and unique XFF and verifies at most 5 pass the rate limiter.
 *
 * Distinguishing rate-limit denials from other 429s:
 *   The middleware always sets `Retry-After` when it returns 429. The
 *   /api/audit/trigger handler also has its own 60s cooldown which returns
 *   429 *without* Retry-After. We treat only 429-with-Retry-After as a true
 *   rate-limit block; everything else (200 / 401 / handler-cooldown 429) is
 *   counted as "passed the limiter".
 *
 * Window-boundary safety:
 *   The limiter buckets by floor(now / 60_000). To avoid straddling a window
 *   edge mid-burst the script waits until at least ~10s of headroom remains
 *   in the current minute window before each scenario.
 *
 * Pre-requisites:
 *   - The server must be running on PORT (default 5000), e.g. via the
 *     "Start application" workflow (`npm run dev`).
 *   - ADMIN_API_KEY must be set in the environment so the audit-trigger
 *     scenario can authenticate.
 *
 * Usage:    npx tsx tests/testRateLimiterHttp.ts
 *
 * Expected output (when passing):
 *   [HttpRateLimitTest] /api/audit/trigger: passed=10 blocked=10 (limit=10)  ✅
 *   [HttpRateLimitTest] /api/admin/auth:   passed=5  blocked=10 (limit=5)   ✅
 *   [HttpRateLimitTest] PASS — HTTP rate limiting holds under concurrent load
 *
 * Exit code: 0 on success, 1 on any failed assertion or fatal error.
 */

const PORT = process.env.PORT || '5000';
const BASE_URL = process.env.RATE_LIMIT_TEST_URL || `http://localhost:${PORT}`;
const ADMIN_KEY = process.env.ADMIN_API_KEY;

const WRITE_LIMIT = 10;
const AUTH_LIMIT = 5;
const WINDOW_MS = 60_000;
const WINDOW_HEADROOM_MS = 10_000;

type ReqOutcome = {
  status: number;
  retryAfter: string | null;
  rateLimited: boolean;   // true iff 429 with Retry-After header (middleware)
  passedLimiter: boolean; // !rateLimited
};

function uniqueXff(scenario: string): string {
  // Use TEST-NET-3 (203.0.113.0/24, RFC 5737) so we never collide with real
  // production traffic that might be hitting the limiter at the same time.
  // Embed Date.now() so re-runs of this script never reuse the same bucket.
  // With TRUST_PROXY_HOPS=0, parseClientIp uses the RIGHTMOST entry — that is
  // the one we must keep unique and syntactically valid (octets 0-255).
  const seed = (Date.now() ^ (scenario.length * 7919)) >>> 0;
  const left = (seed % 254) + 1;        // 1..254
  const right = ((seed >>> 8) % 254) + 1; // 1..254
  return `198.51.100.${left},203.0.113.${right}`;
}

async function waitForWindowHeadroom(): Promise<void> {
  const now = Date.now();
  const elapsedInWindow = now % WINDOW_MS;
  const remaining = WINDOW_MS - elapsedInWindow;
  if (remaining < WINDOW_HEADROOM_MS) {
    const waitMs = remaining + 250; // cross into the next window
    console.log(
      `[HttpRateLimitTest] Only ${remaining}ms left in current window — ` +
        `waiting ${waitMs}ms for a fresh one to avoid boundary skew`,
    );
    await new Promise(r => setTimeout(r, waitMs));
  }
}

async function fireOne(
  url: string,
  init: RequestInit,
): Promise<ReqOutcome> {
  try {
    const res = await fetch(url, init);
    const retryAfter = res.headers.get('retry-after');
    const rateLimited = res.status === 429 && !!retryAfter;
    // Drain body so the connection can be released back to the agent pool.
    await res.text().catch(() => '');
    return {
      status: res.status,
      retryAfter,
      rateLimited,
      passedLimiter: !rateLimited,
    };
  } catch (err) {
    console.error('[HttpRateLimitTest] request error:', (err as Error).message);
    // A network/transport error is NOT a rate-limit block; count as passed
    // so we don't accidentally turn server crashes into a green test.
    return { status: 0, retryAfter: null, rateLimited: false, passedLimiter: true };
  }
}

async function fireConcurrent(
  url: string,
  init: RequestInit,
  count: number,
): Promise<ReqOutcome[]> {
  const tasks = Array.from({ length: count }, () => fireOne(url, init));
  return Promise.all(tasks);
}

function summarize(label: string, results: ReqOutcome[]): {
  passed: number;
  blocked: number;
} {
  const passed = results.filter(r => r.passedLimiter).length;
  const blocked = results.filter(r => r.rateLimited).length;
  const byStatus: Record<string, number> = {};
  for (const r of results) {
    const k = `${r.status}${r.retryAfter ? ' (Retry-After)' : ''}`;
    byStatus[k] = (byStatus[k] || 0) + 1;
  }
  console.log(`[HttpRateLimitTest] ${label} status breakdown:`, byStatus);
  return { passed, blocked };
}

async function testAuditTriggerWriteLimit(): Promise<boolean> {
  console.log('\n[HttpRateLimitTest] === Scenario 1: POST /api/audit/trigger (WRITE_LIMIT=10) ===');
  if (!ADMIN_KEY) {
    console.error('[HttpRateLimitTest] ADMIN_API_KEY is not set — cannot authenticate audit/trigger.');
    return false;
  }
  await waitForWindowHeadroom();

  const xff = uniqueXff('audit-trigger');
  const url = `${BASE_URL}/api/audit/trigger`;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': ADMIN_KEY,
      'X-Forwarded-For': xff,
    },
    body: JSON.stringify({}),
  };

  const N = 20;
  console.log(`[HttpRateLimitTest] Firing ${N} concurrent POSTs with XFF=${xff}`);
  const results = await fireConcurrent(url, init, N);
  const { passed, blocked } = summarize('/api/audit/trigger', results);

  const ok = passed <= WRITE_LIMIT;
  console.log(
    `[HttpRateLimitTest] /api/audit/trigger: passed=${passed} blocked=${blocked} ` +
      `(limit=${WRITE_LIMIT})  ${ok ? '✅' : '❌'}`,
  );
  if (!ok) {
    console.error(
      `[HttpRateLimitTest]   FAIL — ${passed} requests passed the limiter but ` +
        `WRITE_LIMIT is ${WRITE_LIMIT}. Middleware/limiter regression.`,
    );
  }
  if (blocked === 0) {
    console.error(
      `[HttpRateLimitTest]   FAIL — 0 requests were blocked (no 429 + Retry-After). ` +
        `The limiter middleware is not returning the expected 429/Retry-After shape.`,
    );
    return false;
  }
  return ok;
}

async function testAdminAuthAuthLimit(): Promise<boolean> {
  console.log('\n[HttpRateLimitTest] === Scenario 2: POST /api/admin/auth (AUTH_LIMIT=5) ===');
  await waitForWindowHeadroom();

  const xff = uniqueXff('admin-auth');
  const url = `${BASE_URL}/api/admin/auth`;
  // Deliberately-wrong key — we want 401 from the handler so we can verify
  // the limiter (which runs BEFORE the handler) is the only thing producing
  // 429 + Retry-After responses.
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': xff,
    },
    body: JSON.stringify({ key: 'this-is-not-the-admin-key-rate-limit-test' }),
  };

  const N = 15;
  console.log(`[HttpRateLimitTest] Firing ${N} concurrent POSTs with XFF=${xff}`);
  const results = await fireConcurrent(url, init, N);
  const { passed, blocked } = summarize('/api/admin/auth', results);

  const ok = passed <= AUTH_LIMIT;
  console.log(
    `[HttpRateLimitTest] /api/admin/auth:   passed=${passed} blocked=${blocked} ` +
      `(limit=${AUTH_LIMIT})  ${ok ? '✅' : '❌'}`,
  );
  if (!ok) {
    console.error(
      `[HttpRateLimitTest]   FAIL — ${passed} requests passed the limiter but ` +
        `AUTH_LIMIT is ${AUTH_LIMIT}. Auth-flow rate limiting regressed.`,
    );
  }
  if (blocked === 0) {
    console.error(
      `[HttpRateLimitTest]   FAIL — 0 requests were blocked (no 429 + Retry-After). ` +
        `The limiter middleware is not returning the expected 429/Retry-After shape ` +
        `for the public auth path.`,
    );
    return false;
  }
  return ok;
}

async function ensureServerReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    await res.text().catch(() => '');
    if (!res.ok) {
      console.error(`[HttpRateLimitTest] /api/health returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[HttpRateLimitTest] Cannot reach ${BASE_URL} — is the dev server running? ` +
        `(${(err as Error).message})`,
    );
    return false;
  }
}

async function main() {
  console.log(`[HttpRateLimitTest] Target server: ${BASE_URL}`);
  const reachable = await ensureServerReachable();
  if (!reachable) process.exit(1);

  const writeOk = await testAuditTriggerWriteLimit();
  const authOk = await testAdminAuthAuthLimit();

  const allOk = writeOk && authOk;
  console.log('');
  if (allOk) {
    console.log('[HttpRateLimitTest] PASS — HTTP rate limiting holds under concurrent load');
    process.exit(0);
  } else {
    console.error('[HttpRateLimitTest] FAIL — see assertion failures above');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[HttpRateLimitTest] Fatal error:', err);
  process.exit(1);
});
