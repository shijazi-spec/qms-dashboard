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
  // Task #559: rolling prune-run history rows the stub returns when the
  // SUT runs `SELECT ... FROM ai_metrics_prune_runs ... ORDER BY ran_at
  // DESC LIMIT $1`. When set, takes precedence over `lastPruneRow` for
  // queries that include `LIMIT $1`.
  pruneHistoryRows: Record<string, unknown>[] | null;
  failDelete?: boolean;
}

const fixture: StubFixture = {
  rowCount: 0,
  oldestStartedAt: null,
  oldestAgeDays: null,
  lastPruneRow: null,
  pruneHistoryRows: null,
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
    // Task #559: getAiMetricsPruneRunHistory issues a `LIMIT $1` query —
    // serve it from the dedicated `pruneHistoryRows` fixture so the
    // history test can assert ordering / mapping independently of the
    // single-row `lastPruneRow` used by getAiMetricsTableStats().
    if (/LIMIT\s+\$1/i.test(sql)) {
      return {
        ...empty,
        command: 'SELECT',
        rows: fixture.pruneHistoryRows ?? [],
      };
    }
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
  getAiMetricsPruneRunHistory,
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

// ───────────────────────────────────────────────────────────────────
// Task #559: rolling prune-run history for the AI Ops dashboard
// ───────────────────────────────────────────────────────────────────

await suite.test(
  'getAiMetricsPruneRunHistory() defaults to limit=30 when no argument is supplied',
  async () => {
    fixture.pruneHistoryRows = [];
    clearCaptured();
    await getAiMetricsPruneRunHistory();
    const selectQ = captured.find(q =>
      /FROM ai_metrics_prune_runs/i.test(q.sql) && /LIMIT\s+\$1/i.test(q.sql),
    );
    suite.expect(selectQ != null, 'history SELECT was issued');
    if (selectQ) {
      suite.expectEqual(selectQ.params[0], 30, 'defaults limit param to 30');
    }
  },
);

await suite.test(
  'getAiMetricsPruneRunHistory() clamps non-positive / non-finite / >365 limits',
  async () => {
    fixture.pruneHistoryRows = [];
    const cases: Array<[number | undefined, number]> = [
      [0, 30],          // non-positive -> default
      [-5, 30],         // negative -> default
      [Number.NaN, 30], // NaN -> default
      [Infinity, 30],   // non-finite -> default
      [1000, 365],      // above max -> clamp to 365
      [7, 7],           // valid -> passthrough
      [50.7, 50],       // floored
    ];
    for (const [input, expected] of cases) {
      clearCaptured();
      await getAiMetricsPruneRunHistory(input as number);
      const q = captured.find(c =>
        /FROM ai_metrics_prune_runs/i.test(c.sql) && /LIMIT\s+\$1/i.test(c.sql),
      );
      suite.expect(q != null, `query issued for input=${String(input)}`);
      if (q) {
        suite.expectEqual(q.params[0], expected, `limit ${String(input)} -> ${expected}`);
      }
    }
  },
);

await suite.test(
  'getAiMetricsPruneRunHistory() maps DB rows to camelCase entries with ISO timestamps',
  async () => {
    fixture.pruneHistoryRows = [
      {
        id: 42,
        ran_at: new Date('2026-04-25T06:00:00Z'),
        retention_days: 90,
        rows_deleted: 12_345,
        duration_ms: 156,
        success: true,
        error_message: null,
      },
      {
        id: 41,
        ran_at: new Date('2026-04-24T06:00:00Z'),
        retention_days: 90,
        rows_deleted: 0,
        duration_ms: 22,
        success: false,
        error_message: 'connection reset',
      },
    ];
    const entries = await getAiMetricsPruneRunHistory(2);
    suite.expectEqual(entries.length, 2, 'returns the two stub rows');

    const first = entries[0];
    suite.expectEqual(first.id, 42, 'first.id mapped');
    suite.expectEqual(first.retentionDays, 90, 'first.retentionDays mapped');
    suite.expectEqual(first.rowsDeleted, 12345, 'first.rowsDeleted mapped');
    suite.expectEqual(first.durationMs, 156, 'first.durationMs mapped');
    suite.expectEqual(first.success, true, 'first.success mapped');
    suite.expectEqual(first.errorMessage, null, 'first.errorMessage mapped');
    suite.expectEqual(first.ranAt, '2026-04-25T06:00:00.000Z', 'ranAt is ISO8601');

    const second = entries[1];
    suite.expectEqual(second.success, false, 'second.success=false on a failed run');
    suite.expectEqual(
      second.errorMessage,
      'connection reset',
      'second.errorMessage carries the failure reason',
    );
    suite.expectEqual(second.rowsDeleted, 0, 'failed run reports rowsDeleted=0');
  },
);

await suite.test(
  'getAiMetricsPruneRunHistory() returns an empty array when no runs are recorded',
  async () => {
    fixture.pruneHistoryRows = [];
    const entries = await getAiMetricsPruneRunHistory(30);
    suite.expectEqual(entries.length, 0, 'no rows -> empty array (not null)');
  },
);

await suite.test(
  'getAiMetricsPruneRunHistory() issues a SELECT against ai_metrics_prune_runs',
  async () => {
    // ensurePruneRunsTable() memoizes its bootstrap promise, so the
    // CREATE TABLE only fires on the first invocation in the process.
    // The SUT contract this test cares about is "the SELECT happens
    // after the table is guaranteed to exist" — assert the SELECT is
    // issued and ordered DESC; the bootstrap is covered by the
    // pruneOldAiMetrics() suite above.
    fixture.pruneHistoryRows = [];
    clearCaptured();
    await getAiMetricsPruneRunHistory(5);
    const selectQ = captured.find(q =>
      /FROM ai_metrics_prune_runs/i.test(q.sql) && /LIMIT\s+\$1/i.test(q.sql),
    );
    suite.expect(selectQ != null, 'history SELECT issued');
    if (selectQ) {
      suite.expect(
        /ORDER BY ran_at DESC/i.test(selectQ.sql),
        'history SELECT ordered by ran_at DESC',
      );
      suite.expectEqual(selectQ.params[0], 5, 'forwards the requested limit');
    }
  },
);

if (originalEnv === undefined) delete process.env.AI_METRICS_RETENTION_DAYS;
else process.env.AI_METRICS_RETENTION_DAYS = originalEnv;

suite.finishOrExit();
