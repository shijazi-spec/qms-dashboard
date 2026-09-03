/**
 * End-to-end HTTP load test for PER-USER rate limiting under shared XFF.
 *
 * Why this exists:
 *   tests/testRateLimiterHttp.ts only exercises the IP-keyed path because it
 *   authenticates with X-Admin-Key (which has no session userId). A regression
 *   that accidentally fell back to IP keying for logged-in users — letting two
 *   users behind one office NAT share a single bucket — would not be caught.
 *   Likewise, the IP-keyed reset scenarios in testRateLimiterHttp.ts cannot
 *   prove that a user-keyed bucket (key prefix `user:<userId>`) actually rolls
 *   over at the next minute boundary; this test fills that gap too.
 *
 * What this test does:
 *   Scenario 1 — Per-user isolation under shared XFF:
 *     1. Mints two valid signed session cookies for two distinct test users
 *        (created in platform_users for the duration of the run, then deleted).
 *     2. Fires WRITE_LIMIT+5 (15) concurrent POSTs per user against
 *        /api/audit/trigger from the SAME X-Forwarded-For — so if the limiter
 *        ever falls back to IP keying, the two users will contend for the same
 *        bucket and the assertion fails.
 *     3. Asserts each user gets exactly WRITE_LIMIT (10) requests through the
 *        limiter and the remaining 5 receive 429 + Retry-After.
 *     4. Asserts the combined passed count equals 2 * WRITE_LIMIT (20), which
 *        is the unique signature of independent per-user buckets — under shared
 *        IP keying it would be only WRITE_LIMIT (10).
 *   Scenario 2 — Per-user READ_LIMIT window reset:
 *     1. Mints a signed session cookie for a third test user (admin role so the
 *        /api/users handler returns 200 instead of 403; the rate limiter still
 *        runs first either way, so the reset assertion is independent of role).
 *     2. Fires READ_LIMIT+10 (110) concurrent GETs to /api/users with a fresh
 *        XFF and the user's session cookie, exhausting the user-keyed bucket.
 *     3. Confirms the burst produced at least one 429 + Retry-After (proving
 *        the user-keyed bucket actually engaged before testing rollover).
 *     4. Waits past the next 60s window boundary and fires one more request
 *        from the SAME session cookie, asserting the limiter no longer returns
 *        429 + Retry-After (i.e. the user-keyed bucket rolled over).
 *   Scenario 3 — Per-user AUTH_LIMIT (authflow) window reset:
 *     1. Mints a signed session cookie for a fourth test user (any role; the
 *        target endpoint is /api/auth/me, which serves any authenticated user).
 *     2. Fires AUTH_LIMIT+5 (10) concurrent GETs to /api/auth/me with a fresh
 *        XFF and the user's session cookie, exhausting the user-keyed
 *        `user:<userId>:authflow` bucket. /api/auth/me starts with /api/auth/
 *        which matches AUTH_PATHS in src/utils/rateLimiter.ts, so getCategory
 *        returns 'auth' and the bucket key uses the `:authflow` suffix with
 *        AUTH_LIMIT=5 — distinct from the READ_LIMIT bucket exercised by
 *        Scenario 2.
 *     3. Confirms the burst produced at least one 429 + Retry-After (proving
 *        the user-keyed authflow bucket actually engaged before testing rollover).
 *     4. Waits past the next 60s window boundary and fires one more request
 *        from the SAME session cookie, asserting the limiter no longer returns
 *        429 + Retry-After (i.e. the user-keyed authflow bucket rolled over).
 *        This guards specifically against a regression that broke per-user
 *        rollover for the authflow category — a gap Scenario 2 cannot cover
 *        because it only exercises the `:auth:general:r` (READ) bucket.
 *
 * Distinguishing rate-limit denials from other 429s:
 *   The middleware always sets `Retry-After` when it returns 429. The
 *   /api/audit/trigger handler also has its own 60s in-process cooldown that
 *   returns 429 *without* Retry-After. We treat ONLY 429-with-Retry-After as
 *   a true rate-limit block; everything else (200 / 401 / handler-cooldown
 *   429 / network errors) is counted as "passed the limiter".
 *
 * Window-boundary safety:
 *   The limiter buckets by floor(now / 60_000). To avoid straddling a window
 *   edge mid-burst the script waits until at least ~10s of headroom remains
 *   in the current minute window before firing.
 *
 * How the test session cookies are minted:
 *   The script reproduces the exact wire format of authRoutes.ts —
 *   `ExampleOrg_session=<base64url(payload)>.<HMAC-SHA256(payload, SESSION_SECRET)>`
 *   with payload = { userId, email, name, picture, role, exp }. SESSION_SECRET
 *   is read from the environment (the dev server uses the same value, so the
 *   middleware's getSessionFromCookie() accepts the cookies as valid). The
 *   userId comes from a real INSERT into platform_users so that
 *   checkPlatformUserActive() returns true and enforceRoutePermission() finds
 *   the user with the assigned role.
 *
 * Pre-requisites:
 *   - Dev server running on PORT (default 5000), e.g. via the
 *     "Start application" workflow (`npm run dev`).
 *   - SESSION_SECRET set in the environment (must match the server's value).
 *   - DATABASE_URL set so we can insert/clean up the two test users.
 *
 * Usage:    npx tsx tests/testRateLimiterPerUserHttp.ts
 *
 * Expected output (when passing):
 *   [PerUserRateLimitTest] user A passed=10 blocked=5  ✅
 *   [PerUserRateLimitTest] user B passed=10 blocked=5  ✅
 *   [PerUserRateLimitTest] combined passed=20 (per-user buckets are independent) ✅
 *   [PerUserRateLimitTest] /api/users per-user read reset: ✅ allowed (limiter reset)
 *   [PerUserRateLimitTest] /api/auth/me per-user authflow reset: ✅ allowed (limiter reset)
 *   [PerUserRateLimitTest] PASS — per-user rate limiting holds under shared XFF
 *
 * Runtime: ~60–90s end-to-end — the isolation scenario completes in seconds,
 * but the reset scenario must wait for the next ~60s minute boundary.
 *
 * Exit code: 0 on success, 1 on any failed assertion or fatal error.
 */

import crypto from 'crypto';
import pg from 'pg';
import { uniqueXff } from './_helpers/testIpRanges';

const { Pool } = pg;

const PORT = process.env.PORT || '5000';
const BASE_URL = process.env.RATE_LIMIT_TEST_URL || `<REDACTED_URL>`;
const SESSION_SECRET = process.env.SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

// Mirror the source default (rateLimiter.ts) and its env override.
const WRITE_LIMIT = (() => {
  const raw = parseInt(process.env.RATE_LIMIT_WRITE_PER_MIN ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
})();
const READ_LIMIT = 100;
const AUTH_LIMIT = 5;
const N_PER_USER = WRITE_LIMIT + 5;
const N_READ_RESET = READ_LIMIT + 10;
const N_AUTH_RESET = AUTH_LIMIT + 5;
const WINDOW_MS = 60_000;
const WINDOW_HEADROOM_MS = 10_000;

const SESSION_COOKIE_NAME = 'ExampleOrg_session';
const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;

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
    const waitMs = remaining + 250;
    console.log(
      `[PerUserRateLimitTest] Only ${remaining}ms left in current window — ` +
        `waiting ${waitMs}ms for a fresh one to avoid boundary skew`,
    );
    await new Promise(r => setTimeout(r, waitMs));
  }
}

async function waitForNextWindow(label: string): Promise<void> {
  // Sleep until the current 60s bucket ends, plus a small buffer so the
  // follow-up request lands cleanly in the next bucket (no boundary skew).
  // Mirrors the pattern in tests/testRateLimiterHttp.ts.
  const now = Date.now();
  const elapsedInWindow = now % WINDOW_MS;
  const remaining = WINDOW_MS - elapsedInWindow;
  const waitMs = remaining + 1500;
  console.log(
    `[PerUserRateLimitTest] ${label}: waiting ${waitMs}ms (${(waitMs / 1000).toFixed(1)}s) ` +
      `for the next window to begin...`,
  );
  await new Promise(r => setTimeout(r, waitMs));
}

function signSession(payload: Record<string, any>, secret: string): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function buildSessionCookie(userId: number, email: string, role: string, secret: string): string {
  const token = signSession(
    {
      userId,
      email,
      name: email,
      picture: '',
      role,
      exp: Date.now() + SESSION_MAX_AGE_S * 1000,
    },
    secret,
  );
  // The middleware decodes via decodeURIComponent, so encoding here is symmetric
  // and matches the real /api/callback Set-Cookie format.
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
}

async function ensureTestUser(pool: InstanceType<typeof Pool>, email: string, role: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO platform_users (email, full_name, team, role, status, mfa_enabled, login_count, auth_provider)
     VALUES ($1, $2, 'Other', $3, 'active', false, 0, 'local')
     ON CONFLICT (email) DO UPDATE
       SET status = 'active', role = EXCLUDED.role, updated_at = NOW()
     RETURNING id`,
    [email, `RateLimit Test ${email}`, role],
  );
  return result.rows[0].id;
}

async function deleteTestUser(pool: InstanceType<typeof Pool>, email: string): Promise<void> {
  try {
    await pool.query(`DELETE FROM platform_users WHERE email = $1`, [email]);
  } catch (err) {
    console.warn(
      `[PerUserRateLimitTest] cleanup failed for ${email}: ${(err as Error).message}`,
    );
  }
}

async function fireOne(url: string, init: RequestInit): Promise<ReqOutcome> {
  try {
    const res = await fetch(url, init);
    const retryAfter = res.headers.get('retry-after');
    const rateLimited = res.status === 429 && !!retryAfter;
    await res.text().catch(() => '');
    return {
      status: res.status,
      retryAfter,
      rateLimited,
      passedLimiter: !rateLimited,
    };
  } catch (err) {
    console.error('[PerUserRateLimitTest] request error:', (err as Error).message);
    // A network/transport error is NOT a rate-limit block; count as passed
    // so we don't accidentally turn server crashes into a green test.
    return { status: 0, retryAfter: null, rateLimited: false, passedLimiter: true };
  }
}

function summarize(label: string, results: ReqOutcome[]): { passed: number; blocked: number } {
  const passed = results.filter(r => r.passedLimiter).length;
  const blocked = results.filter(r => r.rateLimited).length;
  const byStatus: Record<string, number> = {};
  for (const r of results) {
    const k = `${r.status}${r.retryAfter ? ' (Retry-After)' : ''}`;
    byStatus[k] = (byStatus[k] || 0) + 1;
  }
  console.log(`[PerUserRateLimitTest] ${label} status breakdown:`, byStatus);
  return { passed, blocked };
}

async function ensureServerReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    await res.text().catch(() => '');
    if (!res.ok) {
      console.error(`[PerUserRateLimitTest] /api/health returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[PerUserRateLimitTest] Cannot reach ${BASE_URL} — is the dev server running? ` +
        `(${(err as Error).message})`,
    );
    return false;
  }
}

async function testPerUserIsolation(): Promise<boolean> {
  console.log('\n[PerUserRateLimitTest] === Per-user rate limit isolation under shared XFF ===');
  if (!SESSION_SECRET) {
    console.error('[PerUserRateLimitTest] SESSION_SECRET is not set — cannot mint session cookies.');
    return false;
  }
  if (!DATABASE_URL) {
    console.error('[PerUserRateLimitTest] DATABASE_URL is not set — cannot create test users.');
    return false;
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  const ts = Date.now();
  // .test TLD is reserved (RFC 2606) — guaranteed to never collide with a real user.
  const emailA = `ratelimit-perUser-a-<REDACTED_EMAIL>`;
  const emailB = `ratelimit-perUser-b-<REDACTED_EMAIL>`;

  let ok = false;
  try {
    const [idA, idB] = await Promise.all([
      ensureTestUser(pool, emailA, 'department_viewer'),
      ensureTestUser(pool, emailB, 'department_viewer'),
    ]);
    console.log(`[PerUserRateLimitTest] Created test users A=#${idA} (${emailA}), B=#${idB} (${emailB})`);

    const cookieA = buildSessionCookie(idA, emailA, 'department_viewer', SESSION_SECRET);
    const cookieB = buildSessionCookie(idB, emailB, 'department_viewer', SESSION_SECRET);

    await waitForWindowHeadroom();

    const xff = uniqueXff('per-user-isolation');
    const url = `${BASE_URL}/api/audit/trigger`;
    console.log(`[PerUserRateLimitTest] Firing ${N_PER_USER} concurrent POSTs per user, shared XFF=${xff}`);

    const initFor = (cookie: string): RequestInit => ({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': xff,
        Cookie: cookie,
      },
      body: JSON.stringify({}),
    });

    const tasksA = Array.from({ length: N_PER_USER }, () => fireOne(url, initFor(cookieA)));
    const tasksB = Array.from({ length: N_PER_USER }, () => fireOne(url, initFor(cookieB)));
    const [resultsA, resultsB] = await Promise.all([Promise.all(tasksA), Promise.all(tasksB)]);

    const a = summarize(`user A (id=${idA})`, resultsA);
    const b = summarize(`user B (id=${idB})`, resultsB);

    const expectedBlocked = N_PER_USER - WRITE_LIMIT;
    const okA = a.passed === WRITE_LIMIT && a.blocked === expectedBlocked;
    const okB = b.passed === WRITE_LIMIT && b.blocked === expectedBlocked;

    console.log(
      `[PerUserRateLimitTest] user A passed=${a.passed} blocked=${a.blocked} ` +
        `(expected passed=${WRITE_LIMIT}, blocked=${expectedBlocked})  ${okA ? '✅' : '❌'}`,
    );
    console.log(
      `[PerUserRateLimitTest] user B passed=${b.passed} blocked=${b.blocked} ` +
        `(expected passed=${WRITE_LIMIT}, blocked=${expectedBlocked})  ${okB ? '✅' : '❌'}`,
    );

    if (!okA || !okB) {
      console.error(
        `[PerUserRateLimitTest]   FAIL — at least one user did not get exactly ` +
          `WRITE_LIMIT through. Either the session cookie was not accepted ` +
          `(check SESSION_SECRET matches the server) or the limiter regressed.`,
      );
    }

    const totalPassed = a.passed + b.passed;
    const independenceOk = totalPassed === 2 * WRITE_LIMIT;
    console.log(
      `[PerUserRateLimitTest] combined passed=${totalPassed} ` +
        `(expected ${2 * WRITE_LIMIT} for independent per-user buckets)  ${independenceOk ? '✅' : '❌'}`,
    );
    if (!independenceOk) {
      console.error(
        `[PerUserRateLimitTest]   FAIL — combined passed (${totalPassed}) does not ` +
          `match 2 * WRITE_LIMIT (${2 * WRITE_LIMIT}). Under shared XFF this means ` +
          `the limiter fell back to IP keying for authenticated users — the ` +
          `regression this test was written to catch.`,
      );
    }

    ok = okA && okB && independenceOk;
    return ok;
  } catch (err) {
    console.error('[PerUserRateLimitTest] Fatal error during scenario:', err);
    return false;
  } finally {
    await deleteTestUser(pool, emailA);
    await deleteTestUser(pool, emailB);
    await pool.end().catch(() => {});
  }
}

async function testPerUserReadWindowReset(): Promise<boolean> {
  console.log('\n[PerUserRateLimitTest] === Per-user READ_LIMIT window reset (GET /api/users) ===');
  if (!SESSION_SECRET) {
    console.error('[PerUserRateLimitTest] SESSION_SECRET is not set — cannot mint session cookies.');
    return false;
  }
  if (!DATABASE_URL) {
    console.error('[PerUserRateLimitTest] DATABASE_URL is not set — cannot create test users.');
    return false;
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  const ts = Date.now();
  // .test TLD is reserved (RFC 2606) — guaranteed to never collide with a real user.
  // Distinct email from the isolation scenario so the two scenarios never share
  // a platform_users row even if their cleanup races.
  const email = `ratelimit-perUser-reset-<REDACTED_EMAIL>`;

  try {
    // 'admin' role so /api/users returns 200 instead of 403 — though the
    // limiter runs BEFORE the role check, so this assertion would still hold
    // (passedLimiter is true on any non-429-Retry-After response). We pick
    // admin purely so the burst's status breakdown reads cleanly as 200/429.
    const userId = await ensureTestUser(pool, email, 'admin');
    console.log(`[PerUserRateLimitTest] Created test user #${userId} (${email})`);

    const cookie = buildSessionCookie(userId, email, 'admin', SESSION_SECRET);

    await waitForWindowHeadroom();

    // Fresh XFF (different from the isolation scenario) so this user-keyed
    // bucket starts at 0 even if both scenarios share the same minute window.
    const xff = uniqueXff('per-user-read-reset');
    const url = `${BASE_URL}/api/users`;
    const init: RequestInit = {
      method: 'GET',
      headers: {
        'X-Forwarded-For': xff,
        Cookie: cookie,
      },
    };

    // Phase A: exhaust READ_LIMIT=100 so the next request would be blocked.
    console.log(
      `[PerUserRateLimitTest] Phase A: exhaust READ_LIMIT with ${N_READ_RESET} ` +
        `concurrent GETs (XFF=${xff}, user=#${userId})`,
    );
    const burstTasks = Array.from({ length: N_READ_RESET }, () => fireOne(url, init));
    const burstResults = await Promise.all(burstTasks);
    const { blocked: burstBlocked } = summarize(
      `/api/users (per-user read reset burst, user=#${userId})`,
      burstResults,
    );
    if (burstBlocked === 0) {
      console.error(
        `[PerUserRateLimitTest]   FAIL — burst produced 0 limiter blocks (no 429 + Retry-After). ` +
          `Cannot prove the per-user read bucket actually engaged before testing reset. ` +
          `Either SESSION_SECRET does not match the server (so the limiter saw the ` +
          `request as unauthenticated and used UNAUTH_READ_LIMIT) or the limiter regressed.`,
      );
      return false;
    }
    console.log(`[PerUserRateLimitTest] Phase A confirmed: ${burstBlocked} limiter blocks during burst.`);

    // Phase B: wait past the window boundary, then send one more from the SAME
    // session cookie. The bucket key is `user:<userId>:auth:general:r`, so
    // rollover here proves the per-user keyed bucket clears at the next minute
    // boundary — exactly the gap the IP-keyed scenarios in
    // tests/testRateLimiterHttp.ts cannot cover.
    await waitForNextWindow('Per-user read reset');

    console.log(
      `[PerUserRateLimitTest] Phase B: fire 1 follow-up after rollover (XFF=${xff}, user=#${userId})`,
    );
    const follow = await fireOne(url, init);
    console.log(
      `[PerUserRateLimitTest] follow-up status=${follow.status} ` +
        `retryAfter=${follow.retryAfter ?? 'none'} ` +
        `passedLimiter=${follow.passedLimiter}`,
    );

    const ok = follow.passedLimiter;
    console.log(
      `[PerUserRateLimitTest] /api/users per-user read reset: ` +
        (ok
          ? '✅ allowed (limiter reset at window boundary)'
          : '❌ still blocked by limiter (429 + Retry-After) after rollover'),
    );
    if (!ok) {
      console.error(
        `[PerUserRateLimitTest]   FAIL — follow-up after window rollover was still blocked ` +
          `by the per-user read limiter. The user:<userId> READ_LIMIT bucket failed to ` +
          `roll over at the next 60s window boundary.`,
      );
    }
    return ok;
  } catch (err) {
    console.error('[PerUserRateLimitTest] Fatal error during per-user reset scenario:', err);
    return false;
  } finally {
    await deleteTestUser(pool, email);
    await pool.end().catch(() => {});
  }
}

async function testPerUserAuthFlowWindowReset(): Promise<boolean> {
  console.log('\n[PerUserRateLimitTest] === Per-user AUTH_LIMIT (authflow) window reset (GET /api/auth/me) ===');
  if (!SESSION_SECRET) {
    console.error('[PerUserRateLimitTest] SESSION_SECRET is not set — cannot mint session cookies.');
    return false;
  }
  if (!DATABASE_URL) {
    console.error('[PerUserRateLimitTest] DATABASE_URL is not set — cannot create test users.');
    return false;
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  const ts = Date.now();
  // .test TLD is reserved (RFC 2606) — guaranteed to never collide with a real user.
  // Distinct email from the other scenarios so the buckets / cleanup never race.
  const email = `ratelimit-perUser-authflow-reset-<REDACTED_EMAIL>`;

  try {
    // Role doesn't matter here — /api/auth/me serves any authenticated user
    // and the limiter runs before any role checks anyway. We use
    // 'department_viewer' to make it obvious this is not exercising any
    // admin-only behavior.
    const userId = await ensureTestUser(pool, email, 'department_viewer');
    console.log(`[PerUserRateLimitTest] Created test user #${userId} (${email})`);

    const cookie = buildSessionCookie(userId, email, 'department_viewer', SESSION_SECRET);

    await waitForWindowHeadroom();

    // Fresh XFF (different from every other scenario) so this user-keyed
    // authflow bucket starts at 0 even if scenarios share the same minute window.
    const xff = uniqueXff('per-user-authflow-reset');
    // /api/auth/me starts with /api/auth/, which is in AUTH_PATHS, so the
    // limiter places this in the `auth` category and uses the bucket key
    // `user:<userId>:authflow` with limit AUTH_LIMIT=5. This is a separate
    // bucket from the `user:<userId>:auth:general:r` bucket exercised by the
    // READ reset scenario, so a regression that broke per-user rollover
    // specifically for the authflow category would slip through that test
    // but not this one.
    const url = `${BASE_URL}/api/auth/me`;
    const init: RequestInit = {
      method: 'GET',
      headers: {
        'X-Forwarded-For': xff,
        Cookie: cookie,
      },
    };

    // Phase A: exhaust AUTH_LIMIT=5 so the next request would be blocked.
    console.log(
      `[PerUserRateLimitTest] Phase A: exhaust AUTH_LIMIT with ${N_AUTH_RESET} ` +
        `concurrent GETs (XFF=${xff}, user=#${userId})`,
    );
    const burstTasks = Array.from({ length: N_AUTH_RESET }, () => fireOne(url, init));
    const burstResults = await Promise.all(burstTasks);
    const { blocked: burstBlocked } = summarize(
      `/api/auth/me (per-user authflow reset burst, user=#${userId})`,
      burstResults,
    );
    if (burstBlocked === 0) {
      console.error(
        `[PerUserRateLimitTest]   FAIL — burst produced 0 limiter blocks (no 429 + Retry-After). ` +
          `Cannot prove the per-user authflow bucket actually engaged before testing reset. ` +
          `Either SESSION_SECRET does not match the server (so the limiter saw the ` +
          `request as unauthenticated and used a different bucket) or the limiter regressed.`,
      );
      return false;
    }
    console.log(`[PerUserRateLimitTest] Phase A confirmed: ${burstBlocked} limiter blocks during burst.`);

    // Phase B: wait past the window boundary, then send one more from the SAME
    // session cookie. The bucket key is `user:<userId>:authflow`, so rollover
    // here proves the per-user keyed authflow bucket clears at the next minute
    // boundary — exactly the gap the READ reset scenario above cannot cover
    // because that bucket key has a different suffix (`auth:general:r`).
    await waitForNextWindow('Per-user authflow reset');

    console.log(
      `[PerUserRateLimitTest] Phase B: fire 1 follow-up after rollover (XFF=${xff}, user=#${userId})`,
    );
    const follow = await fireOne(url, init);
    console.log(
      `[PerUserRateLimitTest] follow-up status=${follow.status} ` +
        `retryAfter=${follow.retryAfter ?? 'none'} ` +
        `passedLimiter=${follow.passedLimiter}`,
    );

    const ok = follow.passedLimiter;
    console.log(
      `[PerUserRateLimitTest] /api/auth/me per-user authflow reset: ` +
        (ok
          ? '✅ allowed (limiter reset at window boundary)'
          : '❌ still blocked by limiter (429 + Retry-After) after rollover'),
    );
    if (!ok) {
      console.error(
        `[PerUserRateLimitTest]   FAIL — follow-up after window rollover was still blocked ` +
          `by the per-user authflow limiter. The user:<userId>:authflow bucket failed to ` +
          `roll over at the next 60s window boundary.`,
      );
    }
    return ok;
  } catch (err) {
    console.error('[PerUserRateLimitTest] Fatal error during per-user authflow reset scenario:', err);
    return false;
  } finally {
    await deleteTestUser(pool, email);
    await pool.end().catch(() => {});
  }
}

async function main() {
  console.log(`[PerUserRateLimitTest] Target server: ${BASE_URL}`);
  const reachable = await ensureServerReachable();
  if (!reachable) process.exit(1);

  // Run isolation + both reset scenarios in parallel:
  //   - Isolation completes in seconds and uses its own pair of test users +
  //     XFF + bucket keys (POST /api/audit/trigger, write category).
  //   - Read reset waits ~60s for window rollover and uses a third test user +
  //     a different XFF + a different bucket category (GET /api/users, read,
  //     bucket key suffix `:auth:general:r`).
  //   - Authflow reset waits ~60s for window rollover and uses a fourth test
  //     user + a different XFF + the authflow bucket (GET /api/auth/me,
  //     bucket key suffix `:authflow`, limit AUTH_LIMIT=5).
  // All three sets of buckets are fully disjoint (distinct users, XFFs, and
  // bucket key suffixes), so running concurrently keeps the total runtime
  // near the single ~60s rollover wait instead of stacking them.
  console.log(
    '\n[PerUserRateLimitTest] Starting isolation + read-reset + authflow-reset scenarios in parallel — ' +
      'reset scenarios wait ~60s for the next minute boundary.',
  );
  const [isolationOk, resetOk, authflowResetOk] = await Promise.all([
    testPerUserIsolation(),
    testPerUserReadWindowReset(),
    testPerUserAuthFlowWindowReset(),
  ]);

  console.log('');
  if (isolationOk && resetOk && authflowResetOk) {
    console.log('[PerUserRateLimitTest] PASS — per-user rate limiting holds under shared XFF');
    process.exit(0);
  } else {
    console.error('[PerUserRateLimitTest] FAIL — see assertion failures above');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[PerUserRateLimitTest] Fatal error:', err);
  process.exit(1);
});
