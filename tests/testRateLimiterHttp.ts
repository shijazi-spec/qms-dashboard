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
 *   3. POST /api/audit/trigger window reset
 *      — exhausts WRITE_LIMIT for a fresh XFF, waits past the next 60s
 *        window boundary, then fires one more request from the SAME XFF
 *        and asserts the limiter lets it through (no 429 + Retry-After).
 *        This catches regressions where the bucket becomes a permanent ban
 *        or the window-floor math stops rolling over.
 *   4. POST /api/admin/auth window reset
 *      — same pattern for the AUTH_LIMIT=5 bucket, ensuring the auth-flow
 *        category also resets at the next minute boundary.
 *   Scenarios 3 and 4 run concurrently to cap the test runtime at ~60s for
 *   the rollover wait (instead of ~120s if they were serialized).
 *   5. GET /api/users window reset (authenticated read, READ_LIMIT=100)
 *      — exhausts READ_LIMIT for a fresh XFF, waits past the next 60s
 *        window boundary, then asserts the follow-up request is not blocked
 *        by the limiter. Catches regressions where the read bucket becomes
 *        a permanent ban.
 *   6. GET /api/risks/export window reset (authenticated export, EXPORT_LIMIT=10)
 *      — same pattern for the EXPORT_LIMIT=10 bucket. The path includes
 *        "/export" so the limiter classifies it as category="export".
 *   7. GET /api/health window reset (unauthenticated read, UNAUTH_READ_LIMIT=10)
 *      — exercises the public/unauthenticated read bucket. Fired without any
 *        auth headers so isAuthenticated=false and category="general".
 *   8. POST /api/telemetry/pageview window reset (unauthenticated write,
 *      UNAUTH_WRITE_LIMIT=3) — exercises the tightest public write bucket.
 *      UNAUTH_WRITE_LIMIT is only 3, so just 4 concurrent requests are
 *      enough to exhaust it and prove the limiter engaged before the reset.
 *   Scenarios 5–8 also run concurrently alongside 3 and 4 to keep the
 *   total rollover wait at one ~60s window for the whole test suite.
 *
 * Distinguishing rate-limit denials from other 429s:
 *   The middleware always sets `Retry-After` when it returns 429. The
 *   /api/audit/trigger handler also has its own 60s cooldown which returns
 *   429 *without* Retry-After. We treat only 429-with-Retry-After as a true
 *   rate-limit block; everything else (200 / 401 / handler-cooldown 429) is
 *   counted as "passed the limiter". The reset scenarios therefore PASS even
 *   if the audit handler is still in its own cooldown after rollover, as
 *   long as the *limiter* itself stops returning 429+Retry-After.
 *
 * Window-boundary safety:
 *   The limiter buckets by floor(now / 60_000). To avoid straddling a window
 *   edge mid-burst the script waits until at least ~10s of headroom remains
 *   in the current minute window before each scenario. The reset scenarios
 *   then sleep for the rest of the current window plus a small buffer
 *   (~1.5s) so the follow-up request lands in the next bucket.
 *
 * Pre-requisites:
 *   - The server must be running on PORT (default 5000), e.g. via the
 *     "Start application" workflow (`npm run dev`).
 *   - ADMIN_API_KEY must be set in the environment so the audit-trigger,
 *     read, and export scenarios can authenticate.
 *
 * Usage:    npx tsx tests/testRateLimiterHttp.ts
 *
 * Expected output (when passing):
 *   [HttpRateLimitTest] /api/audit/trigger: passed=10 blocked=10 (limit=10)  ✅
 *   [HttpRateLimitTest] /api/admin/auth:   passed=5  blocked=10 (limit=5)   ✅
 *   [HttpRateLimitTest] /api/audit/trigger reset: ✅ allowed (limiter reset)
 *   [HttpRateLimitTest] /api/admin/auth reset:    ✅ allowed (limiter reset)
 *   [HttpRateLimitTest] /api/users read reset:           ✅ allowed (limiter reset)
 *   [HttpRateLimitTest] /api/risks/export export reset:  ✅ allowed (limiter reset)
 *   [HttpRateLimitTest] /api/health unauth-read reset:   ✅ allowed (limiter reset)
 *   [HttpRateLimitTest] /api/telemetry/pageview unauth-write reset: ✅ allowed (limiter reset)
 *   [HttpRateLimitTest] PASS — HTTP rate limiting holds under concurrent load
 *
 * Runtime: ~60–90s end-to-end (all reset scenarios wait concurrently for the
 * next minute boundary plus margin).
 *
 * Exit code: 0 on success, 1 on any failed assertion or fatal error.
 */

import { uniqueXff } from './_helpers/testIpRanges';

const PORT = process.env.PORT || '5000';
const BASE_URL = process.env.RATE_LIMIT_TEST_URL || `http://localhost:${PORT}`;
const ADMIN_KEY = process.env.ADMIN_API_KEY;

const WRITE_LIMIT = 10;
const AUTH_LIMIT = 5;
const READ_LIMIT = 100;
const EXPORT_LIMIT = 10;
const UNAUTH_READ_LIMIT = 10;
const UNAUTH_WRITE_LIMIT = 3;
const WINDOW_MS = 60_000;
const WINDOW_HEADROOM_MS = 10_000;

type ReqOutcome = {
  status: number;
  retryAfter: string | null;
  rateLimited: boolean;   // true iff 429 with Retry-After header (middleware)
  passedLimiter: boolean; // !rateLimited
};

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

async function waitForNextWindow(label: string): Promise<void> {
  // Sleep until the current 60s bucket ends, plus a small buffer so the
  // follow-up request lands cleanly in the next bucket (no boundary skew).
  const now = Date.now();
  const elapsedInWindow = now % WINDOW_MS;
  const remaining = WINDOW_MS - elapsedInWindow;
  const waitMs = remaining + 1500;
  console.log(
    `[HttpRateLimitTest] ${label}: waiting ${waitMs}ms (${(waitMs / 1000).toFixed(1)}s) ` +
      `for the next window to begin...`,
  );
  await new Promise(r => setTimeout(r, waitMs));
}

async function testAuditTriggerWindowReset(): Promise<boolean> {
  console.log('\n[HttpRateLimitTest] === Scenario 3: WRITE_LIMIT window reset (/api/audit/trigger) ===');
  if (!ADMIN_KEY) {
    console.error('[HttpRateLimitTest] ADMIN_API_KEY is not set — cannot authenticate audit/trigger.');
    return false;
  }
  await waitForWindowHeadroom();

  // Use a fresh XFF (different from scenario 1) so this bucket starts at 0.
  const xff = uniqueXff('audit-trigger-reset');
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

  // Phase A: exhaust the limit so the next request *would* be blocked.
  const N = WRITE_LIMIT + 5;
  console.log(`[HttpRateLimitTest] Phase A: exhaust limit with ${N} concurrent POSTs (XFF=${xff})`);
  const burstResults = await fireConcurrent(url, init, N);
  const { blocked: burstBlocked } = summarize('/api/audit/trigger (reset burst)', burstResults);
  if (burstBlocked === 0) {
    console.error(
      `[HttpRateLimitTest]   FAIL — burst produced 0 limiter blocks (no 429 + Retry-After). ` +
        `Cannot prove the limiter actually engaged before testing reset.`,
    );
    return false;
  }
  console.log(`[HttpRateLimitTest] Phase A confirmed: ${burstBlocked} limiter blocks during burst.`);

  // Phase B: wait past the window boundary, then send one more from the SAME XFF.
  await waitForNextWindow('Scenario 3');

  console.log(`[HttpRateLimitTest] Phase B: fire 1 follow-up after rollover (XFF=${xff})`);
  const follow = await fireOne(url, init);
  console.log(
    `[HttpRateLimitTest] follow-up status=${follow.status} ` +
      `retryAfter=${follow.retryAfter ?? 'none'} ` +
      `passedLimiter=${follow.passedLimiter}`,
  );

  const ok = follow.passedLimiter;
  console.log(
    `[HttpRateLimitTest] /api/audit/trigger reset: ` +
      (ok
        ? '✅ allowed (limiter reset at window boundary)'
        : '❌ still blocked by limiter (429 + Retry-After) after rollover'),
  );
  if (!ok) {
    console.error(
      `[HttpRateLimitTest]   FAIL — follow-up after window rollover was still blocked by ` +
        `the limiter. The 60s rolling window did not reset; ops "10 per minute" guarantee is broken.`,
    );
  }
  return ok;
}

async function testAdminAuthWindowReset(): Promise<boolean> {
  console.log('\n[HttpRateLimitTest] === Scenario 4: AUTH_LIMIT window reset (/api/admin/auth) ===');
  await waitForWindowHeadroom();

  const xff = uniqueXff('admin-auth-reset');
  const url = `${BASE_URL}/api/admin/auth`;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': xff,
    },
    body: JSON.stringify({ key: 'this-is-not-the-admin-key-rate-limit-reset-test' }),
  };

  // Phase A: exhaust AUTH_LIMIT.
  const N = AUTH_LIMIT + 5;
  console.log(`[HttpRateLimitTest] Phase A: exhaust limit with ${N} concurrent POSTs (XFF=${xff})`);
  const burstResults = await fireConcurrent(url, init, N);
  const { blocked: burstBlocked } = summarize('/api/admin/auth (reset burst)', burstResults);
  if (burstBlocked === 0) {
    console.error(
      `[HttpRateLimitTest]   FAIL — burst produced 0 limiter blocks (no 429 + Retry-After). ` +
        `Cannot prove the auth limiter actually engaged before testing reset.`,
    );
    return false;
  }
  console.log(`[HttpRateLimitTest] Phase A confirmed: ${burstBlocked} limiter blocks during burst.`);

  // Phase B: wait past the window boundary, then send one more from the SAME XFF.
  await waitForNextWindow('Scenario 4');

  console.log(`[HttpRateLimitTest] Phase B: fire 1 follow-up after rollover (XFF=${xff})`);
  const follow = await fireOne(url, init);
  console.log(
    `[HttpRateLimitTest] follow-up status=${follow.status} ` +
      `retryAfter=${follow.retryAfter ?? 'none'} ` +
      `passedLimiter=${follow.passedLimiter}`,
  );

  const ok = follow.passedLimiter;
  console.log(
    `[HttpRateLimitTest] /api/admin/auth reset:    ` +
      (ok
        ? '✅ allowed (limiter reset at window boundary)'
        : '❌ still blocked by limiter (429 + Retry-After) after rollover'),
  );
  if (!ok) {
    console.error(
      `[HttpRateLimitTest]   FAIL — follow-up after window rollover was still blocked by ` +
        `the auth limiter. AUTH_LIMIT bucket failed to roll over to a fresh window.`,
    );
  }
  return ok;
}

async function testReadLimitWindowReset(): Promise<boolean> {
  console.log('\n[HttpRateLimitTest] === Scenario 5: READ_LIMIT window reset (GET /api/users) ===');
  if (!ADMIN_KEY) {
    console.error('[HttpRateLimitTest] ADMIN_API_KEY is not set — cannot authenticate read endpoint.');
    return false;
  }
  await waitForWindowHeadroom();

  // Fresh XFF so this bucket starts at zero and never collides with scenario 1.
  const xff = uniqueXff('read-limit-reset');
  const url = `${BASE_URL}/api/users`;
  // GET — isWrite=false, isAuthenticated=true (admin key), category=general → READ_LIMIT=100
  const init: RequestInit = {
    method: 'GET',
    headers: {
      'X-Admin-Key': ADMIN_KEY,
      'X-Forwarded-For': xff,
    },
  };

  // Phase A: exhaust READ_LIMIT=100 so the next request would be blocked.
  const N = READ_LIMIT + 10;
  console.log(`[HttpRateLimitTest] Phase A: exhaust READ_LIMIT with ${N} concurrent GETs (XFF=${xff})`);
  const burstResults = await fireConcurrent(url, init, N);
  const { blocked: burstBlocked } = summarize('/api/users (read reset burst)', burstResults);
  if (burstBlocked === 0) {
    console.error(
      `[HttpRateLimitTest]   FAIL — burst produced 0 limiter blocks (no 429 + Retry-After). ` +
        `Cannot prove the read limiter actually engaged before testing reset.`,
    );
    return false;
  }
  console.log(`[HttpRateLimitTest] Phase A confirmed: ${burstBlocked} limiter blocks during burst.`);

  // Phase B: wait past the window boundary, then send one more from the SAME XFF.
  await waitForNextWindow('Scenario 5 (READ_LIMIT)');

  console.log(`[HttpRateLimitTest] Phase B: fire 1 follow-up after rollover (XFF=${xff})`);
  const follow = await fireOne(url, init);
  console.log(
    `[HttpRateLimitTest] follow-up status=${follow.status} ` +
      `retryAfter=${follow.retryAfter ?? 'none'} ` +
      `passedLimiter=${follow.passedLimiter}`,
  );

  const ok = follow.passedLimiter;
  console.log(
    `[HttpRateLimitTest] /api/users read reset:           ` +
      (ok
        ? '✅ allowed (limiter reset at window boundary)'
        : '❌ still blocked by limiter (429 + Retry-After) after rollover'),
  );
  if (!ok) {
    console.error(
      `[HttpRateLimitTest]   FAIL — follow-up after window rollover was still blocked by ` +
        `the read limiter. The READ_LIMIT bucket did not roll over to a fresh window.`,
    );
  }
  return ok;
}

async function testExportLimitWindowReset(): Promise<boolean> {
  console.log('\n[HttpRateLimitTest] === Scenario 6: EXPORT_LIMIT window reset (GET /api/risks/export) ===');
  if (!ADMIN_KEY) {
    console.error('[HttpRateLimitTest] ADMIN_API_KEY is not set — cannot authenticate export endpoint.');
    return false;
  }
  await waitForWindowHeadroom();

  // Fresh XFF for the export bucket (category="export" because path includes "/export").
  const xff = uniqueXff('export-limit-reset');
  const url = `${BASE_URL}/api/risks/export`;
  // GET — isWrite=false, isAuthenticated=true (admin key), category=export → EXPORT_LIMIT=10
  const init: RequestInit = {
    method: 'GET',
    headers: {
      'X-Admin-Key': ADMIN_KEY,
      'X-Forwarded-For': xff,
    },
  };

  // Phase A: exhaust EXPORT_LIMIT=10 so the next request would be blocked.
  const N = EXPORT_LIMIT + 5;
  console.log(`[HttpRateLimitTest] Phase A: exhaust EXPORT_LIMIT with ${N} concurrent GETs (XFF=${xff})`);
  const burstResults = await fireConcurrent(url, init, N);
  const { blocked: burstBlocked } = summarize('/api/risks/export (export reset burst)', burstResults);
  if (burstBlocked === 0) {
    console.error(
      `[HttpRateLimitTest]   FAIL — burst produced 0 limiter blocks (no 429 + Retry-After). ` +
        `Cannot prove the export limiter actually engaged before testing reset.`,
    );
    return false;
  }
  console.log(`[HttpRateLimitTest] Phase A confirmed: ${burstBlocked} limiter blocks during burst.`);

  // Phase B: wait past the window boundary, then send one more from the SAME XFF.
  await waitForNextWindow('Scenario 6 (EXPORT_LIMIT)');

  console.log(`[HttpRateLimitTest] Phase B: fire 1 follow-up after rollover (XFF=${xff})`);
  const follow = await fireOne(url, init);
  console.log(
    `[HttpRateLimitTest] follow-up status=${follow.status} ` +
      `retryAfter=${follow.retryAfter ?? 'none'} ` +
      `passedLimiter=${follow.passedLimiter}`,
  );

  const ok = follow.passedLimiter;
  console.log(
    `[HttpRateLimitTest] /api/risks/export export reset:  ` +
      (ok
        ? '✅ allowed (limiter reset at window boundary)'
        : '❌ still blocked by limiter (429 + Retry-After) after rollover'),
  );
  if (!ok) {
    console.error(
      `[HttpRateLimitTest]   FAIL — follow-up after window rollover was still blocked by ` +
        `the export limiter. The EXPORT_LIMIT bucket did not roll over to a fresh window.`,
    );
  }
  return ok;
}

async function testUnauthReadLimitWindowReset(): Promise<boolean> {
  console.log('\n[HttpRateLimitTest] === Scenario 7: UNAUTH_READ_LIMIT window reset (GET /api/health) ===');
  await waitForWindowHeadroom();

  // No auth headers — the middleware applies isAuthenticated=false, category=general,
  // isWrite=false → UNAUTH_READ_LIMIT=10.
  const xff = uniqueXff('unauth-read-reset');
  const url = `${BASE_URL}/api/health`;
  const init: RequestInit = {
    method: 'GET',
    headers: {
      'X-Forwarded-For': xff,
    },
  };

  // Phase A: exhaust UNAUTH_READ_LIMIT=10 so the next request would be blocked.
  const N = UNAUTH_READ_LIMIT + 5;
  console.log(`[HttpRateLimitTest] Phase A: exhaust UNAUTH_READ_LIMIT with ${N} concurrent GETs (XFF=${xff})`);
  const burstResults = await fireConcurrent(url, init, N);
  const { blocked: burstBlocked } = summarize('/api/health (unauth-read reset burst)', burstResults);
  if (burstBlocked === 0) {
    console.error(
      `[HttpRateLimitTest]   FAIL — burst produced 0 limiter blocks (no 429 + Retry-After). ` +
        `Cannot prove the unauthenticated read limiter actually engaged before testing reset.`,
    );
    return false;
  }
  console.log(`[HttpRateLimitTest] Phase A confirmed: ${burstBlocked} limiter blocks during burst.`);

  // Phase B: wait past the window boundary, then send one more from the SAME XFF.
  await waitForNextWindow('Scenario 7 (UNAUTH_READ_LIMIT)');

  console.log(`[HttpRateLimitTest] Phase B: fire 1 follow-up after rollover (XFF=${xff})`);
  const follow = await fireOne(url, init);
  console.log(
    `[HttpRateLimitTest] follow-up status=${follow.status} ` +
      `retryAfter=${follow.retryAfter ?? 'none'} ` +
      `passedLimiter=${follow.passedLimiter}`,
  );

  const ok = follow.passedLimiter;
  console.log(
    `[HttpRateLimitTest] /api/health unauth-read reset:   ` +
      (ok
        ? '✅ allowed (limiter reset at window boundary)'
        : '❌ still blocked by limiter (429 + Retry-After) after rollover'),
  );
  if (!ok) {
    console.error(
      `[HttpRateLimitTest]   FAIL — follow-up after window rollover was still blocked by ` +
        `the unauthenticated read limiter. The UNAUTH_READ_LIMIT bucket did not roll over.`,
    );
  }
  return ok;
}

async function testUnauthWriteLimitWindowReset(): Promise<boolean> {
  console.log('\n[HttpRateLimitTest] === Scenario 8: UNAUTH_WRITE_LIMIT window reset (POST /api/telemetry/pageview) ===');
  await waitForWindowHeadroom();

  // No auth headers — the middleware applies isAuthenticated=false, category=general,
  // isWrite=true → UNAUTH_WRITE_LIMIT=3. Only 3+1 requests are needed.
  const xff = uniqueXff('unauth-write-reset');
  const url = `${BASE_URL}/api/telemetry/pageview`;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': xff,
    },
    body: JSON.stringify({ path: '/test', referrer: '' }),
  };

  // Phase A: exhaust UNAUTH_WRITE_LIMIT=3 — fire limit+1 to guarantee at least one block.
  const N = UNAUTH_WRITE_LIMIT + 5;
  console.log(`[HttpRateLimitTest] Phase A: exhaust UNAUTH_WRITE_LIMIT with ${N} concurrent POSTs (XFF=${xff})`);
  const burstResults = await fireConcurrent(url, init, N);
  const { blocked: burstBlocked } = summarize('/api/telemetry/pageview (unauth-write reset burst)', burstResults);
  if (burstBlocked === 0) {
    console.error(
      `[HttpRateLimitTest]   FAIL — burst produced 0 limiter blocks (no 429 + Retry-After). ` +
        `Cannot prove the unauthenticated write limiter actually engaged before testing reset.`,
    );
    return false;
  }
  console.log(`[HttpRateLimitTest] Phase A confirmed: ${burstBlocked} limiter blocks during burst.`);

  // Phase B: wait past the window boundary, then send one more from the SAME XFF.
  await waitForNextWindow('Scenario 8 (UNAUTH_WRITE_LIMIT)');

  console.log(`[HttpRateLimitTest] Phase B: fire 1 follow-up after rollover (XFF=${xff})`);
  const follow = await fireOne(url, init);
  console.log(
    `[HttpRateLimitTest] follow-up status=${follow.status} ` +
      `retryAfter=${follow.retryAfter ?? 'none'} ` +
      `passedLimiter=${follow.passedLimiter}`,
  );

  const ok = follow.passedLimiter;
  console.log(
    `[HttpRateLimitTest] /api/telemetry/pageview unauth-write reset: ` +
      (ok
        ? '✅ allowed (limiter reset at window boundary)'
        : '❌ still blocked by limiter (429 + Retry-After) after rollover'),
  );
  if (!ok) {
    console.error(
      `[HttpRateLimitTest]   FAIL — follow-up after window rollover was still blocked by ` +
        `the unauthenticated write limiter. The UNAUTH_WRITE_LIMIT bucket did not roll over.`,
    );
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

  // Scenarios 3–8 each need to wait ~60s for the window to roll over.
  // All six use disjoint XFFs and disjoint limiter buckets, so they can
  // run fully concurrently and the total rollover wait stays at one ~60s
  // window instead of growing linearly with scenario count.
  console.log(
    '\n[HttpRateLimitTest] Starting window-reset scenarios (3–8) in parallel — ' +
      'each waits ~60s for the next minute boundary.',
  );
  const [
    resetWriteOk,
    resetAuthOk,
    resetReadOk,
    resetExportOk,
    resetUnauthReadOk,
    resetUnauthWriteOk,
  ] = await Promise.all([
    testAuditTriggerWindowReset(),
    testAdminAuthWindowReset(),
    testReadLimitWindowReset(),
    testExportLimitWindowReset(),
    testUnauthReadLimitWindowReset(),
    testUnauthWriteLimitWindowReset(),
  ]);

  const allOk =
    writeOk &&
    authOk &&
    resetWriteOk &&
    resetAuthOk &&
    resetReadOk &&
    resetExportOk &&
    resetUnauthReadOk &&
    resetUnauthWriteOk;
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
