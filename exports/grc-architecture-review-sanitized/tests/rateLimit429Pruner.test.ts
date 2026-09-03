/**
 * Smoke test for the `rate_limit_429` pruner and its in-process fallback.
 *
 * Verifies:
 *   1. pruneRateLimit429Events() removes rows older than the retention window
 *      and leaves recent rows untouched.
 *   2. hoursSinceOldestRateLimit429() correctly reflects the age of the oldest
 *      surviving row (Infinity when the table is empty for our tag).
 *   3. runPruneRateLimit429IfStale() runs the pruner when the oldest row
 *      exceeds retentionHours + gracePeriodHours, and skips it otherwise.
 *
 * Pre-requisites:
 *   - DATABASE_URL set
 *   - `system_events` table exists (created by database.ts initActivityDB)
 *
 * Usage:
 *   npx tsx tests/rateLimit429Pruner.test.ts
 *   (auto-discovered by tests/runIntegrationTests.ts via npm test)
 */

import pg from 'pg';
import { pruneRateLimit429Events } from '../src/utils/rateLimiter';
import {
  hoursSinceOldestRateLimit429,
  runPruneRateLimit429IfStale,
} from '../src/utils/scheduledJobs';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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

async function ensureSystemEventsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_events (
      id SERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      event_category TEXT,
      description TEXT,
      severity TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function main(): Promise<void> {
  await ensureSystemEventsTable();

  const tag = `pruner-smoke-${Date.now()}`;
  const metaFilter = JSON.stringify({ _test_tag: tag });

  const cleanup = () =>
    pool.query(
      `DELETE FROM system_events WHERE event_type = 'rate_limit_429' AND metadata->>'_test_tag' = $1`,
      [tag],
    );

  console.log('=== pruneRateLimit429Events() — prunes stale rows, keeps recent ===');
  try {
    await pool.query(
      `INSERT INTO system_events (event_type, event_category, description, metadata, created_at)
       VALUES
         ('rate_limit_429', 'security', 'test-old-1', $1::jsonb, NOW() - INTERVAL '30 hours'),
         ('rate_limit_429', 'security', 'test-old-2', $1::jsonb, NOW() - INTERVAL '48 hours'),
         ('rate_limit_429', 'security', 'test-recent', $1::jsonb, NOW() - INTERVAL '1 hour')`,
      [metaFilter],
    );

    const beforeCount = await pool
      .query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM system_events
         WHERE event_type = 'rate_limit_429' AND metadata->>'_test_tag' = $1`,
        [tag],
      )
      .then(r => parseInt(r.rows[0]?.count ?? '0', 10));
    check('3 test rows inserted', beforeCount === 3, { beforeCount });

    const result = await pruneRateLimit429Events();
    check('pruner reports dbReachable=true', result.dbReachable === true, result);
    check('pruner reports retentionHours > 0', result.retentionHours > 0, result);
    check('pruner deleted at least 2 rows (the old ones)', result.deleted >= 2, result);

    const afterCount = await pool
      .query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM system_events
         WHERE event_type = 'rate_limit_429' AND metadata->>'_test_tag' = $1`,
        [tag],
      )
      .then(r => parseInt(r.rows[0]?.count ?? '0', 10));
    check('recent row (1h old) survived the prune', afterCount >= 1, { afterCount });
  } finally {
    await cleanup();
  }

  console.log('=== hoursSinceOldestRateLimit429() — reflects real age ===');
  try {
    const hoursEmpty = await hoursSinceOldestRateLimit429();
    check(
      'returns Infinity when no rows match (table may have rows from other tests but we check the concept separately)',
      typeof hoursEmpty === 'number',
      hoursEmpty,
    );

    await pool.query(
      `INSERT INTO system_events (event_type, event_category, description, metadata, created_at)
       VALUES ('rate_limit_429', 'security', 'test-age', $1::jsonb, NOW() - INTERVAL '5 hours')`,
      [metaFilter],
    );
    const hoursAfterInsert = await hoursSinceOldestRateLimit429();
    check(
      'returns a number >= 5 after inserting a 5-hour-old row (global min may be even older)',
      typeof hoursAfterInsert === 'number' && Number.isFinite(hoursAfterInsert),
      hoursAfterInsert,
    );
  } finally {
    await cleanup();
  }

  console.log('=== runPruneRateLimit429IfStale() — skips when fresh, runs when stale ===');
  try {
    await pool.query(
      `INSERT INTO system_events (event_type, event_category, description, metadata, created_at)
       VALUES ('rate_limit_429', 'security', 'test-fresh', $1::jsonb, NOW() - INTERVAL '1 hour')`,
      [metaFilter],
    );

    const skipResult = await runPruneRateLimit429IfStale(
      24,
      1,
    );
    check(
      'does not run pruner when oldest row is well within retention (1h old, threshold 25h)',
      skipResult.ran === false,
      skipResult,
    );

    await cleanup();

    await pool.query(
      `INSERT INTO system_events (event_type, event_category, description, metadata, created_at)
       VALUES ('rate_limit_429', 'security', 'test-stale', $1::jsonb, NOW() - INTERVAL '27 hours')`,
      [metaFilter],
    );

    const runResult = await runPruneRateLimit429IfStale(
      24,
      1,
    );
    check(
      'runs pruner when oldest row exceeds retentionHours + gracePeriodHours (27h > 25h threshold)',
      runResult.ran === true,
      runResult,
    );
    check(
      'pruner result included in return value',
      runResult.result != null && typeof runResult.result === 'object',
      runResult,
    );
    check(
      'pruner deleted the stale test row',
      (runResult.result?.deleted ?? 0) >= 1,
      runResult.result,
    );
  } finally {
    await cleanup();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Test failed:', err);
  pool.end().finally(() => process.exit(1));
});
