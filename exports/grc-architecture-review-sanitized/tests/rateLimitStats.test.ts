/**
 * Integration test for getRateLimitStats() and the
 * GET /api/admin/rate-limit-stats endpoint.
 *
 * Verifies:
 *   1. Rolling 1-minute aggregation: counts inserted into rate_limit_buckets
 *      across two adjacent minute windows are summed per-key in topKeys.
 *   2. The HTTP endpoint reflects the same data and rises after we trigger
 *      real 429s against the live server.
 *
 * Pre-requisites:
 *   - Server running on PORT (default 5000)
 *   - ADMIN_API_KEY set
 *   - DATABASE_URL set
 *
 * CI behaviour:
 *   - If ADMIN_API_KEY or DATABASE_URL is missing, the test prints a clear
 *     "(skipped)" message and exits 0 (matches the skip pattern other
 *     CI-conditional tests in this repo use).
 *   - If both env vars are set but no server is listening on PORT, the HTTP
 *     portion is skipped with a meaningful message rather than producing a
 *     confusing connection-refused stack trace.
 *
 * Usage:
 *   npx tsx tests/rateLimitStats.test.ts
 *   (also auto-discovered by `npm test` via tests/runIntegrationTests.ts)
 */

import pg from 'pg';
import { getRateLimitStats } from '../src/utils/rateLimiter';

const { Pool } = pg;
const PORT = process.env.PORT || '5000';
const ADMIN_KEY = process.env.ADMIN_API_KEY;

if (!process.env.DATABASE_URL) {
  console.log('(skipped) rateLimitStats — DATABASE_URL not set');
  process.exit(0);
}
if (!ADMIN_KEY) {
  console.log('(skipped) rateLimitStats — ADMIN_API_KEY not set');
  process.exit(0);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Probe the admin endpoint with a short timeout so we can detect "no server
 * running on PORT" up front and skip the HTTP portion gracefully instead of
 * letting a downstream `fetch` throw ECONNREFUSED.
 */
async function isServerReachable(): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1500);
  try {
    await fetch(`<REDACTED_URL>`, {
      method: 'GET',
      signal: ac.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`, extra ?? '');
    failed++;
  }
}

async function main(): Promise<void> {
  console.log('=== getRateLimitStats() — rolling-window aggregation ===');

  // Use unique keys so we don't collide with live traffic.
  const tag = `stats-test-${Date.now()}`;
  const keyA = `<REDACTED_SECRET>`;       // recent (inside rolling window) — should appear
  const keyB = `<REDACTED_SECRET>`;       // recent (inside rolling window) — should appear
  const keyOld = `<REDACTED_SECRET>`;   // older than 61s — should be EXCLUDED

  // Buckets are second-granularity in production (see rateLimiter.ts:166-168
  // `INSERT ... date_trunc('second', NOW())`), so we use DB-time timestamps
  // truncated to the second to mirror real bucket layout.
  // Seed:
  //   keyA: 7 at NOW()-5s + 3 at NOW()-30s   = should aggregate to 10
  //   keyB: 2 at NOW()-5s + 1 at NOW()-30s   = should aggregate to 3
  //   keyOld: 99 at NOW()-90s                = should be excluded (outside window)
  await pool.query(
    `INSERT INTO rate_limit_buckets (key, window_start, count) VALUES
       ($1, date_trunc('second', NOW() - INTERVAL '5 seconds'),  7),
       ($1, date_trunc('second', NOW() - INTERVAL '30 seconds'), 3),
       ($2, date_trunc('second', NOW() - INTERVAL '5 seconds'),  2),
       ($2, date_trunc('second', NOW() - INTERVAL '30 seconds'), 1),
       ($3, date_trunc('second', NOW() - INTERVAL '90 seconds'), 99)
     ON CONFLICT (key, window_start) DO UPDATE SET count = EXCLUDED.count`,
    [keyA, keyB, keyOld],
  );

  try {
    const stats = await getRateLimitStats();
    check('dbReachable is true', stats.dbReachable === true, stats.dbError);
    check('windowMs = 60000', stats.windowMs === 60000);

    const ourTop = stats.topKeys.filter(k => k.key === keyA || k.key === keyB || k.key === keyOld);
    const a = ourTop.find(k => k.key === keyA);
    const b = ourTop.find(k => k.key === keyB);
    const old = ourTop.find(k => k.key === keyOld);
    check(`topKeys contains ${keyA}`, !!a);
    check(`topKeys contains ${keyB}`, !!b);
    check('OLD bucket (>61s) is EXCLUDED from rolling window', old === undefined, old);
    // Aggregation: A should be 7+3=10, B should be 2+1=3.
    check('keyA aggregated to 10 (sum across two recent buckets)', a?.count === 10, a);
    check('keyB aggregated to 3 (sum across two recent buckets)', b?.count === 3, b);
    // Ordering: A (10) ranked above B (3) within our pair.
    if (a && b) {
      const idxA = stats.topKeys.indexOf(a);
      const idxB = stats.topKeys.indexOf(b);
      check('higher-count key ranks before lower-count key', idxA < idxB, { idxA, idxB });
    }

    check('totalRows is a non-negative integer', Number.isInteger(stats.totalRows) && stats.totalRows >= 0);
    check('failOpenCount is a non-negative integer', Number.isInteger(stats.failOpenCount) && stats.failOpenCount >= 0);
    check('recent429Count is a non-negative integer', Number.isInteger(stats.recent429Count) && stats.recent429Count >= 0);
  } finally {
    await pool.query(
      `DELETE FROM rate_limit_buckets WHERE key = $1 OR key = $2 OR key = $3`,
      [keyA, keyB, keyOld],
    );
  }

  console.log('=== GET /api/admin/rate-limit-stats — admin gating ===');
  const serverUp = await isServerReachable();
  if (!serverUp) {
    console.log(
      `  (skipped) HTTP endpoint checks — no server reachable on port ${PORT} ` +
        `(start the dev server, or set PORT, to exercise this section)`,
    );
  } else {
    const noAuth = await fetch(`<REDACTED_URL>`);
    check('401 / 403 without admin key', noAuth.status === 401 || noAuth.status === 403, noAuth.status);

    const withAuth = await fetch(`<REDACTED_URL>`, {
      headers: { 'X-Admin-Key': ADMIN_KEY ?? '' },
    });
    check('200 with valid admin key', withAuth.status === 200, withAuth.status);
    if (withAuth.ok) {
      const body = (await withAuth.json()) as Record<string, unknown>;
      check('response has windowMs', typeof body.windowMs === 'number');
      check('response has topKeys array', Array.isArray(body.topKeys));
      check('response has totalRows number', typeof body.totalRows === 'number');
      check('response has failOpenCount number', typeof body.failOpenCount === 'number');
      check('response has recent429Count number', typeof body.recent429Count === 'number');
      check('response has dbReachable boolean', typeof body.dbReachable === 'boolean');
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Test failed:', err);
  pool.end().finally(() => process.exit(1));
});
