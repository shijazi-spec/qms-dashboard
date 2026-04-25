/**
 * Tests for the configurable `ai_call_metrics` retention window
 * (Task #236 — "Automatically retire old AI metrics so the table stays
 * fast long-term").
 *
 * Without a bounded retention window the `ai_call_metrics` table grows
 * forever, eventually slowing every query — even the indexed ones — on
 * high-volume agent workloads. The daily `ai-cost-summary` Inngest cron
 * already calls `pruneOldAiMetrics()` once per day; this test verifies:
 *
 *   1. The retention window is read from `AI_METRICS_RETENTION_DAYS`
 *      with a default of 90 days when unset.
 *   2. Misconfigured values (non-numeric, NaN, zero, negative, empty
 *      string) all fall back to the default rather than wiping the
 *      table or no-op-ing the prune.
 *   3. An explicit numeric argument to `pruneOldAiMetrics(N)` overrides
 *      the env var — useful for tests and one-off sweeps.
 *   4. Whatever value is finally chosen is the value passed to the
 *      `MAKE_INTERVAL(days => $1)` SQL parameter, so the cron's log line
 *      and the actual delete window cannot drift.
 *
 * The test stubs `pg.Pool.prototype.query` so it captures the SQL
 * parameters that would be sent to Postgres without requiring a live
 * DATABASE_URL.
 *
 * Run:  npx tsx tests/aiCallMetricsRetention.test.ts
 */

import pg from 'pg';

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

const captured: CapturedQuery[] = [];

const originalQuery = pg.Pool.prototype.query;
(pg.Pool.prototype as unknown as { query: unknown }).query = async function stubQuery(
  this: pg.Pool,
  sql: unknown,
  params?: ReadonlyArray<unknown>,
): Promise<unknown> {
  if (typeof sql !== 'string') {
    return (originalQuery as unknown as (...args: unknown[]) => unknown).apply(this, [
      sql,
      params,
    ]);
  }
  captured.push({ sql, params: params ?? [] });
  const empty = { command: '', rowCount: 0, oid: 0, fields: [], rows: [] as unknown[] };
  if (
    /^\s*CREATE TABLE/i.test(sql) ||
    /^\s*ALTER TABLE/i.test(sql) ||
    /^\s*CREATE INDEX/i.test(sql)
  ) {
    return empty;
  }
  if (/^\s*DELETE FROM ai_call_metrics/i.test(sql)) {
    return { ...empty, command: 'DELETE', rowCount: 7 };
  }
  return empty;
} as typeof pg.Pool.prototype.query;

const {
  pruneOldAiMetrics,
  resolveAiMetricsRetentionDays,
  DEFAULT_AI_METRICS_RETENTION_DAYS,
} = await import('../src/utils/aiTelemetry');

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`, extra ?? '');
    failed++;
  }
}

function lastDeleteParams(): ReadonlyArray<unknown> | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (/^\s*DELETE FROM ai_call_metrics/i.test(captured[i].sql)) {
      return captured[i].params;
    }
  }
  return null;
}

function clearCaptured(): void {
  captured.length = 0;
}

const originalEnv = process.env.AI_METRICS_RETENTION_DAYS;

async function main(): Promise<void> {
  console.log('=== resolveAiMetricsRetentionDays() — env-var parsing ===');

  delete process.env.AI_METRICS_RETENTION_DAYS;
  check(
    'returns DEFAULT (90) when env var is unset',
    resolveAiMetricsRetentionDays() === DEFAULT_AI_METRICS_RETENTION_DAYS,
    {
      got: resolveAiMetricsRetentionDays(),
      DEFAULT_AI_METRICS_RETENTION_DAYS,
    },
  );

  process.env.AI_METRICS_RETENTION_DAYS = '';
  check(
    'returns DEFAULT when env var is empty string',
    resolveAiMetricsRetentionDays() === DEFAULT_AI_METRICS_RETENTION_DAYS,
    { got: resolveAiMetricsRetentionDays() },
  );

  process.env.AI_METRICS_RETENTION_DAYS = 'abc';
  check(
    'returns DEFAULT when env var is non-numeric',
    resolveAiMetricsRetentionDays() === DEFAULT_AI_METRICS_RETENTION_DAYS,
    { got: resolveAiMetricsRetentionDays() },
  );

  process.env.AI_METRICS_RETENTION_DAYS = '0';
  check(
    'returns DEFAULT when env var is 0 (clamps to safe default rather than disabling prune)',
    resolveAiMetricsRetentionDays() === DEFAULT_AI_METRICS_RETENTION_DAYS,
    { got: resolveAiMetricsRetentionDays() },
  );

  process.env.AI_METRICS_RETENTION_DAYS = '-5';
  check(
    'returns DEFAULT when env var is negative',
    resolveAiMetricsRetentionDays() === DEFAULT_AI_METRICS_RETENTION_DAYS,
    { got: resolveAiMetricsRetentionDays() },
  );

  process.env.AI_METRICS_RETENTION_DAYS = '30';
  check(
    'returns 30 when env var is "30"',
    resolveAiMetricsRetentionDays() === 30,
    { got: resolveAiMetricsRetentionDays() },
  );

  process.env.AI_METRICS_RETENTION_DAYS = '14.7';
  check(
    'floors fractional values (14.7 -> 14)',
    resolveAiMetricsRetentionDays() === 14,
    { got: resolveAiMetricsRetentionDays() },
  );

  process.env.AI_METRICS_RETENTION_DAYS = '365';
  check(
    'accepts large windows (365)',
    resolveAiMetricsRetentionDays() === 365,
    { got: resolveAiMetricsRetentionDays() },
  );

  console.log('=== pruneOldAiMetrics() — SQL parameter wiring ===');

  delete process.env.AI_METRICS_RETENTION_DAYS;
  clearCaptured();
  let deleted = await pruneOldAiMetrics();
  let params = lastDeleteParams();
  check('issues a DELETE when called with no args', params != null, { captured });
  check(
    'DELETE uses MAKE_INTERVAL(days => $1) parameter form',
    captured.some(q => /MAKE_INTERVAL\(days => \$1\)/i.test(q.sql)),
    { sqls: captured.map(c => c.sql) },
  );
  check(
    'DELETE param is the resolved default (90) when env var unset',
    params != null && params[0] === DEFAULT_AI_METRICS_RETENTION_DAYS,
    { params },
  );
  check('returns the rowCount from the DELETE (7)', deleted === 7, { deleted });

  process.env.AI_METRICS_RETENTION_DAYS = '45';
  clearCaptured();
  await pruneOldAiMetrics();
  params = lastDeleteParams();
  check(
    'DELETE param reflects env var (45) when called with no args',
    params != null && params[0] === 45,
    { params },
  );

  process.env.AI_METRICS_RETENTION_DAYS = '45';
  clearCaptured();
  await pruneOldAiMetrics(7);
  params = lastDeleteParams();
  check(
    'explicit argument (7) overrides env var (45)',
    params != null && params[0] === 7,
    { params },
  );

  clearCaptured();
  await pruneOldAiMetrics(3.9);
  params = lastDeleteParams();
  check(
    'explicit fractional argument (3.9) is floored to 3',
    params != null && params[0] === 3,
    { params },
  );

  process.env.AI_METRICS_RETENTION_DAYS = '45';
  clearCaptured();
  await pruneOldAiMetrics(0);
  params = lastDeleteParams();
  check(
    'explicit 0 falls back to env var (45) — never wipes the table',
    params != null && params[0] === 45,
    { params },
  );

  clearCaptured();
  await pruneOldAiMetrics(-10);
  params = lastDeleteParams();
  check(
    'explicit negative arg falls back to env var (45)',
    params != null && params[0] === 45,
    { params },
  );

  clearCaptured();
  await pruneOldAiMetrics(NaN);
  params = lastDeleteParams();
  check(
    'explicit NaN arg falls back to env var (45)',
    params != null && params[0] === 45,
    { params },
  );

  if (originalEnv === undefined) {
    delete process.env.AI_METRICS_RETENTION_DAYS;
  } else {
    process.env.AI_METRICS_RETENTION_DAYS = originalEnv;
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
