/**
 * End-to-end HTTP load test for PER-USER rate limiting under shared XFF.
 *
 * Why this exists:
 *   tests/testRateLimiterHttp.ts only exercises the IP-keyed path because it
 *   authenticates with X-Admin-Key (which has no session userId). A regression
 *   that accidentally fell back to IP keying for logged-in users — letting two
 *   users behind one office NAT share a single bucket — would not be caught.
 *
 * What this test does:
 *   1. Mints two valid signed session cookies for two distinct test users
 *      (created in platform_users for the duration of the run, then deleted).
 *   2. Fires WRITE_LIMIT+5 (15) concurrent POSTs per user against
 *      /api/audit/trigger from the SAME X-Forwarded-For — so if the limiter
 *      ever falls back to IP keying, the two users will contend for the same
 *      bucket and the assertion fails.
 *   3. Asserts each user gets exactly WRITE_LIMIT (10) requests through the
 *      limiter and the remaining 5 receive 429 + Retry-After.
 *   4. Asserts the combined passed count equals 2 * WRITE_LIMIT (20), which
 *      is the unique signature of independent per-user buckets — under shared
 *      IP keying it would be only WRITE_LIMIT (10).
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
 *   `walaplus_session=<base64url(payload)>.<HMAC-SHA256(payload, SESSION_SECRET)>`
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
 *   [PerUserRateLimitTest] PASS — per-user rate limiting holds under shared XFF
 *
 * Exit code: 0 on success, 1 on any failed assertion or fatal error.
 */

import crypto from 'crypto';
import pg from 'pg';

const { Pool } = pg;

const PORT = process.env.PORT || '5000';
const BASE_URL = process.env.RATE_LIMIT_TEST_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

const WRITE_LIMIT = 10;
const N_PER_USER = WRITE_LIMIT + 5;
const WINDOW_MS = 60_000;
const WINDOW_HEADROOM_MS = 10_000;

const SESSION_COOKIE_NAME = 'walaplus_session';
const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;

type ReqOutcome = {
  status: number;
  retryAfter: string | null;
  rateLimited: boolean;   // true iff 429 with Retry-After header (middleware)
  passedLimiter: boolean; // !rateLimited
};

function uniqueXff(scenario: string): string {
  // Use TEST-NET-3 (203.0.113.0/24, RFC 5737) so we never collide with real
  // production traffic. With TRUST_PROXY_HOPS=0 (default), parseClientIp uses
  // the RIGHTMOST entry — that is the one we must keep unique and syntactically
  // valid (octets 0-255). Both users in this test deliberately share the SAME
  // XFF so that any IP-keyed regression would collapse their buckets.
  const seed = (Date.now() ^ (scenario.length * 7919)) >>> 0;
  const left = (seed % 254) + 1;
  const right = ((seed >>> 8) % 254) + 1;
  return `198.51.100.${left},203.0.113.${right}`;
}

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
  const emailA = `ratelimit-perUser-a-${ts}@walaplus.test`;
  const emailB = `ratelimit-perUser-b-${ts}@walaplus.test`;

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

async function main() {
  console.log(`[PerUserRateLimitTest] Target server: ${BASE_URL}`);
  const reachable = await ensureServerReachable();
  if (!reachable) process.exit(1);

  const passed = await testPerUserIsolation();

  console.log('');
  if (passed) {
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
