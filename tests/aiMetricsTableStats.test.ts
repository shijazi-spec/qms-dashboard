/**
 * Tests for getAiMetricsTableStats() and the storage-health side-effects of
 * pruneOldAiMetrics() (Task #505 — "Show how big the AI usage table has
 * grown so admins know if pruning is keeping up").
 *
 * Verifies:
 *   1. pruneOldAiMetrics() ensures the prune-runs history table exists and
 *      records each successful run (retention_days, rows_deleted, success).
 *   2. pruneOldAiMetrics() records a failed run when the DELETE throws,
 *      and the recorded retention_days is still the resolved value (so
 *      operators can see what window the failed run was attempting).
 *   3. getAiMetricsTableStats() returns the row count, oldest age, and
 *      most-recent prune run; flips `exceedsRetention` when the oldest
 *      row is older than the configured retention window.
 *   4. Empty table → rowCount=0, oldestStartedAt=null, exceedsRetention=false.
 *
 * pg.Pool.prototype.query is stubbed so tests do not require DATABASE_URL.
 *
 * Run:  npx tsx tests/aiMetricsTableStats.test.ts
 */

import pg from 'pg';
import { TestSuite } from './_helpers/runner';

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

const captured: CapturedQuery[] = [];

interface StubFixture {
  rowCount: number;
  oldestStartedAt: Date | null;
  oldestAgeDays: number | null;
  lastPruneRow: Record<string, unknown> | null;
  failDelete?: boolean;
}

const fixture: StubFixture = {
  rowCount: 0,
  oldestStartedAt: null,
  oldestAgeDays: null,
  lastPruneRow: null,
};

const originalQuery = pg.Pool.prototype.query;
(pg.Pool.prototype as unknown as { query: unknown }).query = async function stubQuery(
  this: pg.Pool,
  sql: unknown,
  params?: ReadonlyArray<unknown>,
): Promise<unknown> {
  if (typeof sql !== 'string') {
    return (originalQuery as unknown as (...a: unknown[]) => unknown).apply(this, [sql, params]);
  }
  captured.push({ sql, params: params ?? [] });

  const empty = { command: '', rowCount: 0, oid: 0, fields: [], rows: [] as unknown[] };
  if (/^\s*CREATE TABLE/i.test(sql) || /^\s*ALTER TABLE/i.test(sql) || /^\s*CREATE INDEX/i.test(sql)) {
    return empty;
  }
  if (/^\s*DELETE FROM ai_call_metrics/i.test(sql)) {
    if (fixture.failDelete) throw new Error('synthetic delete failure');
    return { ...empty, command: 'DELETE', rowCount: 9 };
  }
  if (/INSERT INTO ai_metrics_prune_runs/i.test(sql)) {
    return { ...empty, command: 'INSERT', rowCount: 1 };
  }
  if (/SELECT[\s\S]*FROM ai_call_metrics/i.test(sql) && /COUNT\(\*\)/i.test(sql)) {
    return {
      ...empty,
      command: 'SELECT',
      rows: [{
        row_count: fixture.rowCount,
        oldest_started_at: fixture.oldestStartedAt,
        oldest_age_days: fixture.oldestAgeDays,
      }],
    };
  }
  if (/FROM ai_metrics_prune_runs/i.test(sql)) {
    return {
      ...empty,
      command: 'SELECT',
      rows: fixture.lastPruneRow ? [fixture.lastPruneRow] : [],
    };
  }
  return empty;
} as typeof pg.Pool.prototype.query;

const {
  pruneOldAiMetrics,
  getAiMetricsTableStats,
  DEFAULT_AI_METRICS_RETENTION_DAYS,
} = await import('../src/utils/aiTelemetry');

const suite = new TestSuite('aiMetricsTableStats');
const originalEnv = process.env.AI_METRICS_RETENTION_DAYS;

function clearCaptured(): void {
  captured.length = 0;
}

console.log('\n=== getAiMetricsTableStats / pruneOldAiMetrics history ===\n');

await suite.test(
  'pruneOldAiMetrics() ensures the prune-runs table exists and records the run',
  async () => {
    delete process.env.AI_METRICS_RETENTION_DAYS;
    fixture.failDelete = false;
    clearCaptured();

    const deleted = await pruneOldAiMetrics(45);
    suite.expectEqual(deleted, 9, 'returns the rowCount from the DELETE');

    const createdPruneTable = captured.some(q =>
      /CREATE TABLE IF NOT EXISTS ai_metrics_prune_runs/i.test(q.sql),
    );
    suite.expect(createdPruneTable, 'CREATE TABLE IF NOT EXISTS ai_metrics_prune_runs was issued');

    const insertRow = captured.find(q =>
      /INSERT INTO ai_metrics_prune_runs/i.test(q.sql),
    );
    suite.expect(insertRow != null, 'INSERT INTO ai_metrics_prune_runs was issued');
    if (insertRow) {
      // Param order: retention_days, rows_deleted, duration_ms, success, error_message.
      suite.expectEqual(insertRow.params[0], 45, 'recorded retention_days');
      suite.expectEqual(insertRow.params[1], 9, 'recorded rows_deleted');
      suite.expectEqual(insertRow.params[3], true, 'recorded success=true');
      suite.expectEqual(insertRow.params[4], null, 'recorded error_message=null');
    }
  },
);

await suite.test(
  'pruneOldAiMetrics() records a failed run when the DELETE throws',
  async () => {
    fixture.failDelete = true;
    clearCaptured();

    const deleted = await pruneOldAiMetrics(60);
    suite.expectEqual(deleted, 0, 'returns 0 on failure');

    const insertRow = captured.find(q =>
      /INSERT INTO ai_metrics_prune_runs/i.test(q.sql),
    );
    suite.expect(insertRow != null, 'records a row even when DELETE fails');
    if (insertRow) {
      suite.expectEqual(insertRow.params[0], 60, 'recorded the attempted retention_days');
      suite.expectEqual(insertRow.params[1], 0, 'recorded rows_deleted=0');
      suite.expectEqual(insertRow.params[3], false, 'recorded success=false');
      suite.expect(
        typeof insertRow.params[4] === 'string' &&
          (insertRow.params[4] as string).includes('synthetic delete failure'),
        'recorded the failure error_message',
      );
    }
    fixture.failDelete = false;
  },
);

await suite.test(
  'getAiMetricsTableStats() returns row count, oldest age, and last prune',
  async () => {
    process.env.AI_METRICS_RETENTION_DAYS = '30';
    fixture.rowCount = 1234;
    fixture.oldestStartedAt = new Date(Date.now() - 5 * 86400_000);
    fixture.oldestAgeDays = 5;
    fixture.lastPruneRow = {
      ran_at: new Date('2026-04-24T06:00:00Z'),
      retention_days: 30,
      rows_deleted: 12,
      duration_ms: 87,
      success: true,
      error_message: null,
    };
    clearCaptured();

    const stats = await getAiMetricsTableStats();
    suite.expectEqual(stats.rowCount, 1234, 'rowCount');
    suite.expectEqual(stats.retentionDays, 30, 'retentionDays from env');
    suite.expectEqual(stats.oldestAgeDays, 5, 'oldestAgeDays');
    suite.expectEqual(stats.exceedsRetention, false, 'exceedsRetention=false when within window');
    suite.expect(stats.oldestStartedAt != null, 'oldestStartedAt is set');
    suite.expect(stats.lastPrune != null, 'lastPrune is populated');
    if (stats.lastPrune) {
      suite.expectEqual(stats.lastPrune.retentionDays, 30, 'lastPrune.retentionDays');
      suite.expectEqual(stats.lastPrune.rowsDeleted, 12, 'lastPrune.rowsDeleted');
      suite.expectEqual(stats.lastPrune.durationMs, 87, 'lastPrune.durationMs');
      suite.expectEqual(stats.lastPrune.success, true, 'lastPrune.success');
      suite.expectEqual(stats.lastPrune.errorMessage, null, 'lastPrune.errorMessage');
    }
  },
);

await suite.test(
  'getAiMetricsTableStats() flips exceedsRetention when oldest > retention window',
  async () => {
    process.env.AI_METRICS_RETENTION_DAYS = '30';
    fixture.rowCount = 5000;
    fixture.oldestStartedAt = new Date(Date.now() - 45 * 86400_000);
    fixture.oldestAgeDays = 45.2;
    fixture.lastPruneRow = null;

    const stats = await getAiMetricsTableStats();
    suite.expectEqual(stats.exceedsRetention, true, 'exceedsRetention=true');
    suite.expectEqual(stats.lastPrune, null, 'lastPrune is null when no run recorded');
  },
);

await suite.test(
  'getAiMetricsTableStats() handles an empty table (rowCount=0, oldest=null)',
  async () => {
    delete process.env.AI_METRICS_RETENTION_DAYS;
    fixture.rowCount = 0;
    fixture.oldestStartedAt = null;
    fixture.oldestAgeDays = null;
    fixture.lastPruneRow = null;

    const stats = await getAiMetricsTableStats();
    suite.expectEqual(stats.rowCount, 0, 'rowCount=0');
    suite.expectEqual(stats.oldestStartedAt, null, 'oldestStartedAt=null');
    suite.expectEqual(stats.oldestAgeDays, null, 'oldestAgeDays=null');
    suite.expectEqual(stats.exceedsRetention, false, 'exceedsRetention=false when table is empty');
    suite.expectEqual(
      stats.retentionDays,
      DEFAULT_AI_METRICS_RETENTION_DAYS,
      'retentionDays falls back to default',
    );
  },
);

if (originalEnv === undefined) delete process.env.AI_METRICS_RETENTION_DAYS;
else process.env.AI_METRICS_RETENTION_DAYS = originalEnv;

suite.finishOrExit();
