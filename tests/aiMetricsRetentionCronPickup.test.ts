/**
 * Tests for the daily `ai-cost-summary` Inngest cron picking up the
 * dashboard-set AI metrics retention value on its next pass
 * (Task #565 — "Verify the daily AI metrics prune cron picks up
 * dashboard retention changes on its next pass").
 *
 * Background
 * ----------
 * Task #504 surfaced the `ai_call_metrics` retention window on the AI
 * Operations dashboard via a single-row override table
 * (`ai_metrics_retention_config`) and a precedence-ladder resolver
 * (`resolveEffectiveAiMetricsRetentionDays()`) that the cron is supposed
 * to consult on every tick. Task #551's Playwright spec exercises the
 * dashboard end-to-end (form save → audit row → resolver returns the new
 * value on the next call), but it does NOT actually invoke the cron's
 * prune step and confirm that `pruneOldAiMetrics()` honours the
 * dashboard-set value when it next runs.
 *
 * That gap matters because a future regression in
 * `src/mastra/inngest/index.ts` — e.g. dropping the `await` on the
 * effective resolver, caching the env value across runs, or accidentally
 * reverting to the env-only sync resolver — would slip through both the
 * unit suite and the existing e2e spec. This file closes that gap by
 * invoking the extracted `runAiMetricsPruneCronStep()` helper (which the
 * cron now also calls) directly.
 *
 * Coverage
 * --------
 *   1. **Tighten — 30-day override deletes a 200-day-old row.** With no
 *      env var set (env baseline = default 90), seed a single
 *      `ai_call_metrics` row aged 200 days, save a 30-day override
 *      through `setAiMetricsRetentionConfig()`, run the helper, assert
 *      `retentionDays === 30` and the row was deleted (rowsDeleted = 1).
 *      Proves the override flows through the resolver into the prune
 *      DELETE parameter.
 *
 *   2. **Widen — 365-day override preserves a 200-day-old row.** With
 *      the env var still unset (env baseline = default 90, which would
 *      otherwise delete the row), save a 365-day override, re-seed the
 *      row, run the helper, assert `retentionDays === 365` and the row
 *      was NOT deleted (rowsDeleted = 0). Proves the cron is reading
 *      the dashboard value rather than the hardcoded 90-day default —
 *      i.e. the regression scenario the task brief calls out.
 *
 *   3. **No override — env baseline still wins.** Clear the override
 *      back to NULL, set `AI_METRICS_RETENTION_DAYS=45`, re-seed the
 *      200-day-old row, run the helper, assert `retentionDays === 45`
 *      and the row was deleted (rowsDeleted = 1). Proves the override
 *      precedence collapses cleanly back to the env baseline once the
 *      dashboard value is cleared.
 *
 *   4. **Lock engaged — env value wins even when override is set.**
 *      With `AI_METRICS_RETENTION_DAYS=120` and
 *      `AI_METRICS_RETENTION_DAYS_LOCK=1`, save a 30-day dashboard
 *      override, re-seed the 200-day-old row, run the helper, assert
 *      `retentionDays === 120` and the row was deleted (200 > 120).
 *      Proves the env-side hard lock continues to short-circuit the
 *      override on the cron path.
 *
 * Strategy
 * --------
 * The test stubs `pg.Pool.prototype.query` and `pg.Pool.prototype.connect`
 * with an in-memory model of:
 *   • the single-row `ai_metrics_retention_config` override
 *   • a single seeded `ai_call_metrics` row (Date-typed `started_at`)
 *
 * `setAiMetricsRetentionConfig()` writes to the in-memory model through
 * the BEGIN/SELECT FOR UPDATE/UPSERT/audit/COMMIT path it uses in
 * production. The DELETE issued by `pruneOldAiMetrics()` is interpreted:
 * the in-memory row is dropped iff `now - started_at > retentionDays`
 * (matching the cron's `started_at < NOW() - MAKE_INTERVAL(days => $1)`
 * predicate). This way the test exercises the real production code path
 * end-to-end without requiring a live `DATABASE_URL`, so it is
 * auto-discovered by `tests/runIntegrationTests.ts` and runs as part of
 * the normal `npm test` suite.
 *
 * Run:  npx tsx tests/aiMetricsRetentionCronPickup.test.ts
 */

import pg from 'pg';
import { TestSuite } from './_helpers/runner';

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

const captured: CapturedQuery[] = [];

interface SeededMetricsRow {
  started_at: Date;
}

interface DbState {
  /** Single-row override; null means "no override set". */
  retentionDays: number | null;
  updatedBy: string | null;
  updatedAt: Date | null;
  /** In-memory `ai_call_metrics` rows used by the prune simulation. */
  metricsRows: SeededMetricsRow[];
}

const db: DbState = {
  retentionDays: null,
  updatedBy: null,
  updatedAt: null,
  metricsRows: [],
};

function seedMetricsRowAgedDays(ageDays: number): void {
  db.metricsRows = [
    { started_at: new Date(Date.now() - ageDays * 86_400_000) },
  ];
}

function clearOverride(): void {
  db.retentionDays = null;
  db.updatedBy = null;
  db.updatedAt = null;
}

const originalQuery = pg.Pool.prototype.query;
const originalConnect = pg.Pool.prototype.connect;

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

  // Schema bootstrap — accept everything as a no-op.
  if (
    /^\s*CREATE TABLE/i.test(sql) ||
    /^\s*ALTER TABLE/i.test(sql) ||
    /^\s*CREATE INDEX/i.test(sql)
  ) {
    return empty;
  }

  // Read the dashboard override row used by resolveEffectiveAiMetricsRetentionDays().
  if (/SELECT[\s\S]+FROM ai_metrics_retention_config/i.test(sql)) {
    if (db.retentionDays == null) return { ...empty, rows: [] };
    return {
      ...empty,
      rows: [
        {
          retention_days: db.retentionDays,
          updated_by: db.updatedBy,
          updated_at: db.updatedAt,
        },
      ],
    };
  }

  // Cron's prune DELETE: simulate the `started_at < NOW() - MAKE_INTERVAL(days => $1)`
  // predicate by walking the in-memory `metricsRows` and dropping any row
  // older than the retention window.
  if (/^\s*DELETE FROM ai_call_metrics/i.test(sql)) {
    const days = Number((params ?? [])[0]);
    if (!Number.isFinite(days) || days <= 0) {
      // Defensive: pruneOldAiMetrics clamps to >= 1, so this branch is
      // unreachable in production, but a future regression that lets a
      // bad value through should not silently wipe the in-memory state.
      return { ...empty, command: 'DELETE', rowCount: 0 };
    }
    const cutoffMs = Date.now() - days * 86_400_000;
    const before = db.metricsRows.length;
    db.metricsRows = db.metricsRows.filter(
      (r) => r.started_at.getTime() >= cutoffMs,
    );
    const deleted = before - db.metricsRows.length;
    return { ...empty, command: 'DELETE', rowCount: deleted };
  }

  // Prune-runs history insert (recordPruneRun) — accept silently.
  if (/INSERT INTO ai_metrics_prune_runs/i.test(sql)) {
    return { ...empty, command: 'INSERT', rowCount: 1 };
  }

  // Audit-list reads (not used by the cron path but defensive).
  if (/SELECT[\s\S]+FROM ai_metrics_retention_audit/i.test(sql)) {
    return { ...empty, rows: [] };
  }

  return empty;
} as typeof pg.Pool.prototype.query;

// connect()/client.query/release() are needed by setAiMetricsRetentionConfig's
// BEGIN/SELECT FOR UPDATE/UPSERT/audit/COMMIT transaction.
(pg.Pool.prototype as unknown as { connect: unknown }).connect = async function stubConnect(
  this: pg.Pool,
): Promise<any> {
  const client = {
    query: async (sql: unknown, params?: ReadonlyArray<unknown>) => {
      if (typeof sql !== 'string') {
        return (originalQuery as unknown as (...a: unknown[]) => unknown).apply(this, [
          sql,
          params,
        ]);
      }
      captured.push({ sql, params: params ?? [] });
      const empty = { command: '', rowCount: 0, oid: 0, fields: [], rows: [] as unknown[] };

      if (/^\s*BEGIN|^\s*COMMIT|^\s*ROLLBACK/i.test(sql)) return empty;

      if (/SELECT retention_days FROM ai_metrics_retention_config/i.test(sql)) {
        return db.retentionDays == null
          ? { ...empty, rows: [] }
          : { ...empty, rows: [{ retention_days: db.retentionDays }] };
      }

      if (/INSERT INTO ai_metrics_retention_config/i.test(sql)) {
        // Apply the upsert to in-memory state so the next read sees it.
        const v = (params ?? [])[0];
        db.retentionDays = v == null ? null : Number(v);
        db.updatedBy = (params ?? [])[1] != null ? String((params ?? [])[1]) : null;
        db.updatedAt = new Date();
        return empty;
      }

      if (/INSERT INTO ai_metrics_retention_audit/i.test(sql)) {
        return { ...empty, rows: [{ id: 1 }] };
      }

      return empty;
    },
    release: () => {},
  };
  return client;
} as typeof pg.Pool.prototype.connect;

const {
  runAiMetricsPruneCronStep,
  DEFAULT_AI_METRICS_RETENTION_DAYS,
} = await import('../src/utils/aiTelemetry');
const {
  setAiMetricsRetentionConfig,
  __resetInitPromiseForTests,
} = await import('../src/utils/aiMetricsRetentionConfig');

const suite = new TestSuite('aiMetricsRetentionCronPickup');
const originalEnvDays = process.env.AI_METRICS_RETENTION_DAYS;
const originalEnvLock = process.env.AI_METRICS_RETENTION_DAYS_LOCK;

function resetWorld(): void {
  delete process.env.AI_METRICS_RETENTION_DAYS;
  delete process.env.AI_METRICS_RETENTION_DAYS_LOCK;
  clearOverride();
  db.metricsRows = [];
  captured.length = 0;
  __resetInitPromiseForTests();
}

console.log('\n=== Cron prune step picks up dashboard retention changes ===\n');

await suite.test(
  '30-day dashboard override deletes a 200-day-old row on the next cron pass',
  async () => {
    resetWorld();
    seedMetricsRowAgedDays(200);

    // Save the override exactly the way the AI Operations dashboard does.
    const saveResult = await setAiMetricsRetentionConfig({
      retentionDays: 30,
      changedBy: 'test-operator',
      note: 'Tighten window for retention regression test',
    });
    suite.expectEqual(saveResult.after, 30, 'override row records after=30');
    suite.expectEqual(db.retentionDays, 30, 'in-memory override is 30');

    const result = await runAiMetricsPruneCronStep();

    suite.expectEqual(
      result.retentionDays,
      30,
      'cron resolved retentionDays from the dashboard override (30), not env baseline (90)',
    );
    suite.expectEqual(
      result.rowsDeleted,
      1,
      'the 200-day-old row was pruned by the 30-day window',
    );
    suite.expectEqual(
      db.metricsRows.length,
      0,
      'in-memory ai_call_metrics row was actually removed',
    );

    // The DELETE param must match the resolved dashboard value — proves
    // resolveEffectiveAiMetricsRetentionDays() flowed all the way into
    // pruneOldAiMetrics()'s SQL parameter.
    const deleteCall = [...captured]
      .reverse()
      .find((q) => /^\s*DELETE FROM ai_call_metrics/i.test(q.sql));
    suite.expect(deleteCall != null, 'cron issued a DELETE against ai_call_metrics');
    if (deleteCall) {
      suite.expectEqual(
        deleteCall.params[0],
        30,
        'DELETE param is the dashboard-set value (30)',
      );
      suite.expect(
        /MAKE_INTERVAL\(days => \$1\)/i.test(deleteCall.sql),
        'DELETE uses the parameterized MAKE_INTERVAL form (no drift between log and SQL)',
      );
    }
  },
);

await suite.test(
  '365-day dashboard override preserves a 200-day-old row (proves no hardcoded 90-day default)',
  async () => {
    resetWorld();
    seedMetricsRowAgedDays(200);

    const saveResult = await setAiMetricsRetentionConfig({
      retentionDays: 365,
      changedBy: 'test-operator',
      note: 'Widen window for trend analysis',
    });
    suite.expectEqual(saveResult.after, 365, 'override row records after=365');

    const result = await runAiMetricsPruneCronStep();

    suite.expectEqual(
      result.retentionDays,
      365,
      'cron resolved retentionDays from the dashboard override (365)',
    );
    // This is the exact regression the task brief calls out:
    // a hardcoded 90-day default would delete the 200-day-old row
    // even though the dashboard override is 365.
    suite.expectEqual(
      result.rowsDeleted,
      0,
      'the 200-day-old row survives — cron honoured the 365-day override, not the hardcoded 90-day default',
    );
    suite.expectEqual(
      db.metricsRows.length,
      1,
      'in-memory ai_call_metrics row was preserved',
    );

    const deleteCall = [...captured]
      .reverse()
      .find((q) => /^\s*DELETE FROM ai_call_metrics/i.test(q.sql));
    suite.expect(deleteCall != null, 'cron still issued a DELETE (just with a wider window)');
    if (deleteCall) {
      suite.expectEqual(
        deleteCall.params[0],
        365,
        'DELETE param is 365, NOT the compile-time default (90)',
      );
      suite.expect(
        deleteCall.params[0] !== DEFAULT_AI_METRICS_RETENTION_DAYS,
        `DELETE param must not be the compile-time default (${DEFAULT_AI_METRICS_RETENTION_DAYS})`,
      );
    }
  },
);

await suite.test(
  'override cleared back to NULL falls through to env baseline on the next pass',
  async () => {
    resetWorld();
    process.env.AI_METRICS_RETENTION_DAYS = '45';
    seedMetricsRowAgedDays(200);

    // Operator-driven clear: pass null. The audit log still records the change.
    await setAiMetricsRetentionConfig({
      retentionDays: null,
      changedBy: 'test-operator',
      note: 'Revert to env baseline',
    });
    suite.expectEqual(db.retentionDays, null, 'override is cleared');

    const result = await runAiMetricsPruneCronStep();

    suite.expectEqual(
      result.retentionDays,
      45,
      'cron falls through to AI_METRICS_RETENTION_DAYS=45 once override is cleared',
    );
    suite.expectEqual(
      result.rowsDeleted,
      1,
      '200-day-old row is pruned by the 45-day env window',
    );
  },
);

await suite.test(
  'env-side hard lock forces env value to win even when a dashboard override is saved',
  async () => {
    resetWorld();
    process.env.AI_METRICS_RETENTION_DAYS = '120';
    process.env.AI_METRICS_RETENTION_DAYS_LOCK = '1';
    seedMetricsRowAgedDays(200);

    // Operator tries to tighten to 30 — the lock should ignore this.
    await setAiMetricsRetentionConfig({
      retentionDays: 30,
      changedBy: 'test-operator',
      note: 'Should be ignored by the env-side lock',
    });
    suite.expectEqual(db.retentionDays, 30, 'override row was still written (audit trail)');

    const result = await runAiMetricsPruneCronStep();

    suite.expectEqual(
      result.retentionDays,
      120,
      'lock=1 forces env value (120) to win over dashboard override (30)',
    );
    // 200 > 120 → the row IS pruned, but by the env value, not the override.
    suite.expectEqual(
      result.rowsDeleted,
      1,
      '200-day-old row is pruned by the 120-day env window (the lock-enforced value)',
    );

    const deleteCall = [...captured]
      .reverse()
      .find((q) => /^\s*DELETE FROM ai_call_metrics/i.test(q.sql));
    suite.expect(deleteCall != null, 'cron issued a DELETE');
    if (deleteCall) {
      suite.expectEqual(
        deleteCall.params[0],
        120,
        'DELETE param is the env value (120), not the dashboard override (30)',
      );
    }
  },
);

// Restore env so other tests in the suite are not affected.
if (originalEnvDays === undefined) delete process.env.AI_METRICS_RETENTION_DAYS;
else process.env.AI_METRICS_RETENTION_DAYS = originalEnvDays;
if (originalEnvLock === undefined) delete process.env.AI_METRICS_RETENTION_DAYS_LOCK;
else process.env.AI_METRICS_RETENTION_DAYS_LOCK = originalEnvLock;

// Restore the real pg methods so a subsequent file in the same process
// (unlikely under the per-file subprocess runner, but safe) is unaffected.
(pg.Pool.prototype as unknown as { query: unknown }).query = originalQuery;
(pg.Pool.prototype as unknown as { connect: unknown }).connect = originalConnect;

suite.finishOrExit();
