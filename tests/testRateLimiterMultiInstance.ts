/**
 * Multi-instance simulation test for the distributed rate limiter.
 *
 * Tests:
 *   1. Multi-instance simulation — 3 concurrent "instances" share a Postgres
 *      bucket and the combined allowed count must not exceed the configured limit.
 *   2. parseClientIp spoofing resistance — verifies that right-to-left trust-proxy
 *      parsing prevents clients from forging XFF to rotate their rate-limit key.
 *
 * Run: npx tsx tests/testRateLimiterMultiInstance.ts
 */

import pg from 'pg';
import { checkRateLimit, parseClientIp } from '../src/utils/rateLimiter';

const { Pool } = pg;

const LIMIT = 10;
const INSTANCES = 3;
const REQUESTS_PER_INSTANCE = 6;
const SHARED_IP = `test-sim-${Date.now()}`;
const SHARED_PATH = '/api/test-endpoint';
const AUTH_LIMIT = 5;

async function runInstance(instanceId: number): Promise<{ allowed: number; denied: number }> {
  let allowed = 0;
  let denied = 0;

  for (let i = 0; i < REQUESTS_PER_INSTANCE; i++) {
    const result = await checkRateLimit(SHARED_IP, true, SHARED_PATH, true);
    if (result.allowed) {
      allowed++;
    } else {
      denied++;
    }
  }

  return { allowed, denied };
}

function testParseClientIp(): boolean {
  console.log('\n[RateLimiterTest] === parseClientIp spoofing-resistance tests ===\n');

  let allPassed = true;

  function assert(label: string, actual: string, expected: string) {
    const ok = actual === expected;
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) {
      console.log(`       expected: ${expected}`);
      console.log(`       got:      ${actual}`);
      allPassed = false;
    }
  }

  const HOPS = parseInt(process.env.TRUST_PROXY_HOPS ?? '0', 10);
  console.log(`  TRUST_PROXY_HOPS=${HOPS} (default 0 = no declared intermediate proxies)\n`);
  console.log(`  Formula: ips[max(0, len - HOPS - 1)] → rightmost when HOPS=0\n`);

  if (HOPS === 0) {
    assert(
      'Simple XFF — single entry, HOPS=0: rightmost (only) entry is the client',
      parseClientIp('1.2.3.4', undefined),
      '1.2.3.4',
    );
    assert(
      'HOPS=0: X-Real-IP is NOT trusted; XFF entry is used instead',
      parseClientIp('5.5.5.5', '9.9.9.9'),
      '5.5.5.5',
    );
    assert(
      'Multi-entry XFF — attacker prepends fakes, rightmost (verified by direct proxy) wins',
      parseClientIp('evil.fake, another.fake, 10.0.0.1', undefined),
      '10.0.0.1',
    );
    assert(
      'Spoofing: extra prepended valid IPs — rightmost remains the real client',
      parseClientIp('10.0.0.1, 10.0.0.2, 203.0.113.99', undefined),
      '203.0.113.99',
    );
    assert(
      'Returns unknown when both headers absent',
      parseClientIp(undefined, undefined),
      'unknown',
    );
    assert(
      'Rejects syntactically invalid token in XFF (hyphens)',
      parseClientIp('not-an-ip!', undefined),
      'unknown',
    );
    assert(
      'Rejects bare hex string without colons (not valid IPv6)',
      parseClientIp('deadbeef', undefined),
      'unknown',
    );
    assert(
      'IPv4-mapped IPv6 in XFF is normalized to IPv4',
      parseClientIp('::ffff:10.0.0.1', undefined),
      '10.0.0.1',
    );
  } else if (HOPS === 1) {
    assert(
      'HOPS=1: second-from-right XFF entry (real client before intermediate proxy)',
      parseClientIp('1.2.3.4, 10.0.0.1', undefined),
      '1.2.3.4',
    );
    assert(
      'HOPS=1: X-Real-IP IS trusted when TRUST_PROXY_HOPS > 0',
      parseClientIp(undefined, '::ffff:203.0.113.10'),
      '203.0.113.10',
    );
    assert(
      'HOPS=1: single XFF entry falls back to idx=max(0,0)=0 — same rightmost entry',
      parseClientIp('1.2.3.4', undefined),
      '1.2.3.4',
    );
  } else if (HOPS === 2) {
    assert(
      'HOPS=2: idx=max(0,3-2-1)=0 — original client before two intermediate proxies',
      parseClientIp('1.2.3.4, 10.0.0.1, 10.0.0.2', undefined),
      '1.2.3.4',
    );
  } else {
    console.log(`  Skipping specific XFF assertions for HOPS=${HOPS}; manual review required.`);
  }

  return allPassed;
}

/**
 * Boundary-spanning sliding-window tests.
 *
 * Three scenarios, each provably exercising AUTH_LIMIT (5/min):
 *
 *   1. "30s-old quota": fill the quota, backdate every sub-bucket 30s, then
 *      fire one more request. With the old fixed-minute bucket those rows
 *      would have rolled into a stale window and the new request would be
 *      allowed — i.e. ≥ 6 in 30s. The sliding window must deny it.
 *
 *   2. "Oldest-sub-bucket edge case (~59s)": pre-seed AUTH_LIMIT prior
 *      requests in a sub-bucket whose start is ~59s ago (i.e. the requests
 *      themselves are 59.x seconds old, still inside the 60s window). A
 *      naive predicate of `window_start > NOW() - 60s` would drop this
 *      bucket because its START is older than 60s, even though the requests
 *      it represents are not. Our conservative `> NOW() - 61s` predicate
 *      must include it — so the next request must be denied.
 *
 *   3. "Fully-aged 61s-old quota": pre-seed AUTH_LIMIT prior requests in a
 *      sub-bucket whose start is 62s ago. Those rows are guaranteed to be
 *      out of the trailing 60s window. The next request must be allowed.
 */
async function testBoundarySpan(): Promise<boolean> {
  console.log('\n[RateLimiterTest] === Boundary-spanning sliding window tests ===\n');

  const path = '/api/auth/login';
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let allPassed = true;

  try {
    // -------- Scenario 1: backdate by 30s --------
    {
      const ip = `boundary-30s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const key = `ip:${ip}:authflow`;
      console.log(`  [1] 30s-backdated quota — key=${key}`);

      for (let i = 0; i < AUTH_LIMIT; i++) {
        const r = await checkRateLimit(ip, false, path, false);
        if (!r.allowed) {
          console.error(`      ❌ Request ${i + 1}/${AUTH_LIMIT} unexpectedly denied`);
          allPassed = false;
        }
      }
      const shifted = await pool.query(
        `UPDATE rate_limit_buckets
         SET window_start = window_start - INTERVAL '30 seconds'
         WHERE key = $1`,
        [key],
      );
      console.log(`      Backdated ${shifted.rowCount} sub-bucket row(s) by 30s`);

      const next = await checkRateLimit(ip, false, path, false);
      if (next.allowed) {
        console.error('      ❌ Request after 30s-shift was ALLOWED — sliding window broken');
        allPassed = false;
      } else {
        console.log(`      ✅ Denied (retryAfter=${next.retryAfter}s)`);
      }
    }

    // -------- Scenario 2: oldest-sub-bucket edge case (~59s) --------
    // This is the case the code reviewer specifically called out: a request
    // 59.x seconds old whose sub-bucket-start has just crossed the 60s mark.
    {
      const ip = `boundary-59s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const key = `ip:${ip}:authflow`;
      console.log(`\n  [2] Oldest-bucket edge (~59s) — key=${key}`);

      // Seed AUTH_LIMIT prior requests in one sub-bucket aged exactly 59s.
      // The requests they represent are at most ~59s old (well within window).
      await pool.query(
        `INSERT INTO rate_limit_buckets (key, window_start, count)
         VALUES ($1, date_trunc('second', NOW() - INTERVAL '59 seconds'), $2)
         ON CONFLICT (key, window_start)
         DO UPDATE SET count = rate_limit_buckets.count + EXCLUDED.count`,
        [key, AUTH_LIMIT],
      );
      console.log(`      Seeded ${AUTH_LIMIT} prior requests at -59s`);

      const next = await checkRateLimit(ip, false, path, false);
      if (next.allowed) {
        console.error('      ❌ Request was ALLOWED — bucket-start truncation undercounted in-window requests');
        allPassed = false;
      } else {
        console.log(`      ✅ Denied (retryAfter=${next.retryAfter}s) — strict sliding bound holds at the edge`);
      }
    }

    // -------- Scenario 3: fully-aged-out (~62s) — must be allowed --------
    {
      const ip = `boundary-62s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const key = `ip:${ip}:authflow`;
      console.log(`\n  [3] Fully-aged quota (~62s) — key=${key}`);

      await pool.query(
        `INSERT INTO rate_limit_buckets (key, window_start, count)
         VALUES ($1, date_trunc('second', NOW() - INTERVAL '62 seconds'), $2)
         ON CONFLICT (key, window_start)
         DO UPDATE SET count = rate_limit_buckets.count + EXCLUDED.count`,
        [key, AUTH_LIMIT],
      );
      console.log(`      Seeded ${AUTH_LIMIT} prior requests at -62s (outside window)`);

      const next = await checkRateLimit(ip, false, path, false);
      if (!next.allowed) {
        console.error('      ❌ Request was DENIED — sliding window is over-counting aged-out requests');
        allPassed = false;
      } else {
        console.log('      ✅ Allowed — aged-out bucket correctly excluded');
      }
    }
  } finally {
    await pool.end();
  }

  return allPassed;
}

// Runs in one process; validates Postgres counter under concurrent access.
// True cross-process validation: run this script in 2+ separate processes
// with the same SHARED_IP env var and assert combined allowed <= WRITE_LIMIT.
async function main() {
  const ipTestsPassed = testParseClientIp();
  const boundaryPassed = await testBoundarySpan();

  console.log('\n[RateLimiterTest] === Multi-instance distributed limit simulation ===\n');
  console.log(`  Instances: ${INSTANCES}`);
  console.log(`  Requests per instance: ${REQUESTS_PER_INSTANCE}`);
  console.log(`  Total requests: ${INSTANCES * REQUESTS_PER_INSTANCE}`);
  console.log(`  Configured WRITE_LIMIT: ${LIMIT} per minute`);
  console.log(`  Key (shared): ip:${SHARED_IP}:auth:general:w`);
  console.log('');

  const tasks = Array.from({ length: INSTANCES }, (_, i) => runInstance(i + 1));
  const results = await Promise.all(tasks);

  let totalAllowed = 0;
  let totalDenied = 0;

  results.forEach((r, i) => {
    console.log(`  Instance ${i + 1}: allowed=${r.allowed}, denied=${r.denied}`);
    totalAllowed += r.allowed;
    totalDenied += r.denied;
  });

  console.log('');
  console.log(`[RateLimiterTest] Total allowed: ${totalAllowed}`);
  console.log(`[RateLimiterTest] Total denied:  ${totalDenied}`);
  console.log(`[RateLimiterTest] Total requests: ${totalAllowed + totalDenied}`);

  const simPassed = totalAllowed <= LIMIT;
  if (simPassed) {
    console.log(`\n✅ PASS — combined allowed (${totalAllowed}) does not exceed limit (${LIMIT})`);
    console.log('   Distributed rate limiting is working correctly across simulated instances.');
  } else {
    console.error(`\n❌ FAIL — combined allowed (${totalAllowed}) EXCEEDS limit (${LIMIT})`);
    console.error('   This indicates rate limit state is NOT shared (in-memory leak).');
  }

  const overallPassed = ipTestsPassed && boundaryPassed && simPassed;
  if (!overallPassed) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[RateLimiterTest] Fatal error:', err);
  process.exit(1);
});
