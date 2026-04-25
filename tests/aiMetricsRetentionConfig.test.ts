/**
 * Tests for the dashboard-driven retention override
 * (Task #504 — "Let admins change how long AI usage history is kept from
 * the dashboard").
 *
 * The daily prune cron used to read `AI_METRICS_RETENTION_DAYS` directly,
 * which meant changing the window required a redeploy. Task #504 surfaces
 * the same control on the AI Operations panel by writing to a single-row
 * `ai_metrics_retention_config` table; the cron now consults
 * `resolveEffectiveAiMetricsRetentionDays()` which layers:
 *
 *   1. AI_METRICS_RETENTION_DAYS_LOCK env flag (truthy ⇒ env wins)
 *   2. DB override row, if a positive integer
 *   3. AI_METRICS_RETENTION_DAYS env var (existing behavior)
 *   4. compile-time default
 *
 * This file stubs `pg.Pool.prototype.query` (no live DATABASE_URL needed)
 * to:
 *   • verify each layer of the precedence ladder is honored,
 *   • verify that DB read failures fall back silently to the env-only
 *     resolver (so a transient hiccup never silently switches windows),
 *   • verify that fractional / non-integer / zero / negative override
 *     values are clamped or rejected the same way env-var values are,
 *   • verify the lock flag short-circuits even when a DB override is set.
 *
 * Run:  npx tsx tests/aiMetricsRetentionConfig.test.ts
 */

import pg from 'pg';

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

const captured: CapturedQuery[] = [];

let stubbedRetentionDays: number | null = null;
let stubReadShouldThrow = false;

interface StubAuditRow {
  id: number;
  changed_at: Date;
  changed_by: string;
  before_days: number | null;
  after_days: number | null;
  note: string | null;
}
let stubbedAuditRows: StubAuditRow[] = [];
let stubAuditReadShouldThrow = false;

function filterAuditRows(params: ReadonlyArray<unknown>): StubAuditRow[] {
  // The audit query passes [from?, to?, limit, offset] in that order;
  // the count query passes [from?, to?]. We pull bounds off the head of
  // the params list — both Date instances if present.
  const bounds: Date[] = [];
  for (const p of params) {
    if (p instanceof Date) bounds.push(p);
    else break;
  }
  const from = bounds[0];
  const to = bounds[1];
  return stubbedAuditRows.filter((r) => {
    if (from && r.changed_at.getTime() < from.getTime()) return false;
    if (to && r.changed_at.getTime() > to.getTime()) return false;
    return true;
  });
}

const originalQuery = pg.Pool.prototype.query;
const originalConnect = pg.Pool.prototype.connect;

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
  if (/SELECT[\s\S]+FROM ai_metrics_retention_config/i.test(sql)) {
    if (stubReadShouldThrow) throw new Error('simulated DB read failure');
    if (stubbedRetentionDays == null) return { ...empty, rows: [] };
    return {
      ...empty,
      rows: [
        {
          retention_days: stubbedRetentionDays,
          updated_by: 'tester',
          updated_at: new Date('2026-04-25T00:00:00Z'),
        },
      ],
    };
  }
  if (/SELECT[\s\S]+FROM ai_metrics_retention_audit/i.test(sql)) {
    if (stubAuditReadShouldThrow) throw new Error('simulated audit read failure');
    if (/COUNT\(\*\)/i.test(sql)) {
      const filtered = filterAuditRows(params ?? []);
      return { ...empty, rows: [{ n: filtered.length }] };
    }
    const all = filterAuditRows(params ?? []);
    const tail = (params ?? []) as unknown[];
    const limit = Number(tail[tail.length - 2] ?? 25);
    const offset = Number(tail[tail.length - 1] ?? 0);
    return { ...empty, rows: all.slice(offset, offset + limit) };
  }
  if (/INSERT INTO ai_metrics_retention_audit/i.test(sql)) {
    // Mirrors the client.query stub below so direct pool.query inserts
    // (used by recordAiMetricsRetentionPruneAudit, Task #558) also see
    // the same RETURNING id contract.
    return { ...empty, rows: [{ id: 42 }] };
  }
  return empty;
} as typeof pg.Pool.prototype.query;

// connect() / client.query / release() are needed by setAiMetricsRetentionConfig.
(pg.Pool.prototype as unknown as { connect: unknown }).connect = async function stubConnect(
  this: pg.Pool,
): Promise<any> {
  const client = {
    query: async (sql: unknown, params?: ReadonlyArray<unknown>) => {
      if (typeof sql !== 'string') {
        return (originalQuery as unknown as (...args: unknown[]) => unknown).apply(this, [
          sql,
          params,
        ]);
      }
      captured.push({ sql, params: params ?? [] });
      const empty = { command: '', rowCount: 0, oid: 0, fields: [], rows: [] as unknown[] };
      if (/^\s*BEGIN|COMMIT|ROLLBACK/i.test(sql)) return empty;
      if (/SELECT retention_days FROM ai_metrics_retention_config/i.test(sql)) {
        return stubbedRetentionDays == null
          ? { ...empty, rows: [] }
          : { ...empty, rows: [{ retention_days: stubbedRetentionDays }] };
      }
      if (/INSERT INTO ai_metrics_retention_config/i.test(sql)) {
        // Apply the upsert to the in-memory stub so the next read sees it.
        const v = (params ?? [])[0];
        stubbedRetentionDays = v == null ? null : Number(v);
        return empty;
      }
      if (/INSERT INTO ai_metrics_retention_audit/i.test(sql)) {
        return { ...empty, rows: [{ id: 42 }] };
      }
      return empty;
    },
    release: () => {},
  };
  return client;
} as typeof pg.Pool.prototype.connect;

const {
  resolveAiMetricsRetentionDays,
  resolveEffectiveAiMetricsRetentionDays,
  DEFAULT_AI_METRICS_RETENTION_DAYS,
} = await import('../src/utils/aiTelemetry');
const {
  AI_METRICS_RETENTION_BOUNDS,
  AI_METRICS_RETENTION_AUDIT_MAX_LIMIT,
  AI_METRICS_RETENTION_CONFIRM_THRESHOLD_DEFAULTS,
  AI_METRICS_RETENTION_PRUNE_NOW_NOTE_PREFIX,
  getAiMetricsRetentionConfirmThreshold,
  getAiMetricsRetentionAudit,
  getAiMetricsRetentionAuditPage,
  isAiMetricsRetentionLocked,
  recordAiMetricsRetentionPruneAudit,
  setAiMetricsRetentionConfig,
  __resetInitPromiseForTests,
} = await import('../src/utils/aiMetricsRetentionConfig');

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

const originalEnvDays = process.env.AI_METRICS_RETENTION_DAYS;
const originalEnvLock = process.env.AI_METRICS_RETENTION_DAYS_LOCK;

function clearAll(): void {
  delete process.env.AI_METRICS_RETENTION_DAYS;
  delete process.env.AI_METRICS_RETENTION_DAYS_LOCK;
  stubbedRetentionDays = null;
  stubReadShouldThrow = false;
  stubbedAuditRows = [];
  stubAuditReadShouldThrow = false;
  captured.length = 0;
}

async function main(): Promise<void> {
  console.log('=== AI_METRICS_RETENTION_BOUNDS — sane bounds ===');
  check('min is 1 day (no zero / negative)', AI_METRICS_RETENTION_BOUNDS.min === 1, {
    bounds: AI_METRICS_RETENTION_BOUNDS,
  });
  check('max is bounded (≤ 10 years)', AI_METRICS_RETENTION_BOUNDS.max >= 90 && AI_METRICS_RETENTION_BOUNDS.max <= 3650, {
    bounds: AI_METRICS_RETENTION_BOUNDS,
  });

  console.log('=== isAiMetricsRetentionLocked() — env flag parsing ===');
  clearAll();
  check('returns false when lock env var is unset', isAiMetricsRetentionLocked() === false);
  for (const truthy of ['1', 'true', 'TRUE', 'yes', 'on']) {
    process.env.AI_METRICS_RETENTION_DAYS_LOCK = truthy;
    check(`recognizes "${truthy}" as locked`, isAiMetricsRetentionLocked() === true, {
      raw: truthy,
    });
  }
  for (const falsy of ['0', 'false', 'no', 'off', 'maybe']) {
    process.env.AI_METRICS_RETENTION_DAYS_LOCK = falsy;
    check(`treats "${falsy}" as unlocked`, isAiMetricsRetentionLocked() === false, {
      raw: falsy,
    });
  }

  console.log('=== resolveEffectiveAiMetricsRetentionDays() — precedence ladder ===');

  // Layer 3: env var (no DB override, no lock) → env value.
  clearAll();
  process.env.AI_METRICS_RETENTION_DAYS = '45';
  __resetInitPromiseForTests();
  let effective = await resolveEffectiveAiMetricsRetentionDays();
  check('env var wins when no DB override is set', effective === 45, { effective });

  // Layer 4: env unset, no DB override → default.
  clearAll();
  __resetInitPromiseForTests();
  effective = await resolveEffectiveAiMetricsRetentionDays();
  check(
    'falls back to compile-time default when nothing is configured',
    effective === DEFAULT_AI_METRICS_RETENTION_DAYS,
    { effective },
  );

  // Layer 2: DB override > env var.
  clearAll();
  process.env.AI_METRICS_RETENTION_DAYS = '90';
  stubbedRetentionDays = 30;
  __resetInitPromiseForTests();
  effective = await resolveEffectiveAiMetricsRetentionDays();
  check('DB override (30) wins over env baseline (90)', effective === 30, { effective });

  // Layer 2: DB override > default when env unset.
  clearAll();
  stubbedRetentionDays = 14;
  __resetInitPromiseForTests();
  effective = await resolveEffectiveAiMetricsRetentionDays();
  check('DB override (14) wins over default when env unset', effective === 14, {
    effective,
  });

  // Layer 1: env lock forces env value to win even when DB override is set.
  clearAll();
  process.env.AI_METRICS_RETENTION_DAYS = '90';
  process.env.AI_METRICS_RETENTION_DAYS_LOCK = '1';
  stubbedRetentionDays = 7;
  __resetInitPromiseForTests();
  effective = await resolveEffectiveAiMetricsRetentionDays();
  check(
    'lock=1 forces env baseline (90) to win over DB override (7)',
    effective === 90,
    { effective },
  );

  // Layer 1 + no env: lock with no env returns the default, not the override.
  clearAll();
  process.env.AI_METRICS_RETENTION_DAYS_LOCK = 'true';
  stubbedRetentionDays = 7;
  __resetInitPromiseForTests();
  effective = await resolveEffectiveAiMetricsRetentionDays();
  check(
    'lock=true with env unset returns the compile-time default, not the override',
    effective === DEFAULT_AI_METRICS_RETENTION_DAYS,
    { effective },
  );

  // Resilience: DB read failure falls back to env-only resolver.
  clearAll();
  process.env.AI_METRICS_RETENTION_DAYS = '60';
  stubReadShouldThrow = true;
  __resetInitPromiseForTests();
  // Suppress the expected console.error noise so the test output stays
  // readable.
  const realError = console.error;
  console.error = () => {};
  try {
    effective = await resolveEffectiveAiMetricsRetentionDays();
  } finally {
    console.error = realError;
  }
  check(
    'DB read failure silently falls back to env baseline (60), never wipes the cron config',
    effective === 60,
    { effective },
  );

  // Sanitization: bogus DB values (negative, zero, NaN) fall back to env.
  for (const bogus of [0, -10, NaN, Number.POSITIVE_INFINITY]) {
    clearAll();
    process.env.AI_METRICS_RETENTION_DAYS = '60';
    stubbedRetentionDays = bogus as number;
    __resetInitPromiseForTests();
    effective = await resolveEffectiveAiMetricsRetentionDays();
    check(
      `bogus DB override (${String(bogus)}) is rejected and falls back to env (60)`,
      effective === 60,
      { effective, bogus },
    );
  }

  // Fractional DB override is floored.
  clearAll();
  stubbedRetentionDays = 14.7;
  __resetInitPromiseForTests();
  effective = await resolveEffectiveAiMetricsRetentionDays();
  check('fractional DB override (14.7) is floored to 14', effective === 14, {
    effective,
  });

  console.log('=== setAiMetricsRetentionConfig() — write path ===');
  clearAll();
  __resetInitPromiseForTests();
  let writeResult = await setAiMetricsRetentionConfig({
    retentionDays: 30,
    changedBy: 'admin@example.com',
    note: 'Tightening for perf experiment',
  });
  check('write returns before=null on first save', writeResult.before === null, {
    writeResult,
  });
  check('write returns after=30', writeResult.after === 30, { writeResult });
  check('write returns audit_id', writeResult.audit_id === 42, { writeResult });
  check(
    'write inserts the config row with the right value',
    captured.some(
      (q) =>
        /INSERT INTO ai_metrics_retention_config/i.test(q.sql) && q.params[0] === 30,
    ),
    { sqls: captured.map((c) => c.sql) },
  );
  check(
    'write inserts an audit row with before=null, after=30, and the operator name',
    captured.some(
      (q) =>
        /INSERT INTO ai_metrics_retention_audit/i.test(q.sql) &&
        q.params[0] === 'admin@example.com' &&
        q.params[1] === null &&
        q.params[2] === 30 &&
        q.params[3] === 'Tightening for perf experiment',
    ),
    { sqls: captured.map((c) => c.sql) },
  );

  // Second save: before should reflect the prior value (30 from the previous test).
  captured.length = 0;
  writeResult = await setAiMetricsRetentionConfig({
    retentionDays: null,
    changedBy: 'admin@example.com',
  });
  check('second save returns before=30 from the prior write', writeResult.before === 30, {
    writeResult,
  });
  check('clearing override produces after=null', writeResult.after === null, {
    writeResult,
  });
  check(
    'clearing inserts NULL into retention_days',
    captured.some(
      (q) =>
        /INSERT INTO ai_metrics_retention_config/i.test(q.sql) && q.params[0] === null,
    ),
    { sqls: captured.map((c) => c.sql) },
  );

  // Note truncation
  captured.length = 0;
  const longNote = 'x'.repeat(800);
  await setAiMetricsRetentionConfig({
    retentionDays: 60,
    changedBy: 'admin',
    note: longNote,
  });
  const auditInsert = captured.find((q) =>
    /INSERT INTO ai_metrics_retention_audit/i.test(q.sql),
  );
  check(
    'note longer than 500 chars is truncated to 500',
    auditInsert != null && typeof auditInsert.params[3] === 'string' && (auditInsert.params[3] as string).length === 500,
    { len: auditInsert ? (auditInsert.params[3] as string)?.length : null },
  );

  console.log('=== recordAiMetricsRetentionPruneAudit() — manual prune audit (Task #558) ===');
  clearAll();
  __resetInitPromiseForTests();

  // Happy path with a free-form note: writes one audit row, before === after,
  // structured prefix is present, operator note is appended after " — ".
  captured.length = 0;
  let pruneAudit = await recordAiMetricsRetentionPruneAudit({
    changedBy: 'admin@example.com',
    retentionDays: 30,
    previewedRows: 7,
    deletedRows: 7,
    note: 'incident-1234 cleanup',
  });
  check('prune-now audit returns the inserted id from RETURNING', pruneAudit.audit_id === 42, {
    pruneAudit,
  });
  let pruneInsert = captured.find((q) =>
    /INSERT INTO ai_metrics_retention_audit/i.test(q.sql),
  );
  check('prune-now audit writes exactly one row', pruneInsert != null, {
    sqls: captured.map((c) => c.sql),
  });
  check(
    'prune-now audit row uses operator name from changedBy',
    pruneInsert?.params[0] === 'admin@example.com',
    { params: pruneInsert?.params },
  );
  check(
    'prune-now audit sets before_days === after_days === retentionDays (no config change)',
    pruneInsert?.params[1] === 30 && pruneInsert?.params[2] === 30,
    { params: pruneInsert?.params },
  );
  const noteValue = pruneInsert?.params[3] as string | undefined;
  check(
    'prune-now audit note starts with the [prune-now] prefix marker',
    typeof noteValue === 'string' && noteValue.startsWith(AI_METRICS_RETENTION_PRUNE_NOW_NOTE_PREFIX),
    { noteValue },
  );
  check(
    'prune-now audit note carries previewed/deleted/retention triple',
    typeof noteValue === 'string'
      && noteValue.includes('previewed=7')
      && noteValue.includes('deleted=7')
      && noteValue.includes('retention=30d'),
    { noteValue },
  );
  check(
    'prune-now audit note appends operator free-form note after " — "',
    typeof noteValue === 'string' && noteValue.includes(' — incident-1234 cleanup'),
    { noteValue },
  );

  // Drift path: previewed != deleted is preserved verbatim so the dashboard
  // can render the divergence; no operator note → no trailing " — ".
  captured.length = 0;
  pruneAudit = await recordAiMetricsRetentionPruneAudit({
    changedBy: 'ops-admin',
    retentionDays: 14,
    previewedRows: 100,
    deletedRows: 95,
  });
  pruneInsert = captured.find((q) =>
    /INSERT INTO ai_metrics_retention_audit/i.test(q.sql),
  );
  const driftNote = pruneInsert?.params[3] as string | undefined;
  check(
    'prune-now audit preserves preview/actual drift in the structured note',
    typeof driftNote === 'string'
      && driftNote.includes('previewed=100')
      && driftNote.includes('deleted=95')
      && driftNote.includes('retention=14d'),
    { driftNote },
  );
  check(
    'prune-now audit with no operator note omits the trailing " — "',
    typeof driftNote === 'string' && !driftNote.includes(' — '),
    { driftNote },
  );

  // Sanitization: negative / NaN / fractional row counts and retention are coerced.
  captured.length = 0;
  await recordAiMetricsRetentionPruneAudit({
    changedBy: 'admin',
    retentionDays: 7.9,
    previewedRows: -3,
    deletedRows: Number.NaN as unknown as number,
  });
  pruneInsert = captured.find((q) =>
    /INSERT INTO ai_metrics_retention_audit/i.test(q.sql),
  );
  const sanitizedNote = pruneInsert?.params[3] as string | undefined;
  check(
    'prune-now audit floors fractional retention (7.9 → 7) and clamps negative/NaN counts to 0',
    typeof sanitizedNote === 'string'
      && sanitizedNote.includes('retention=7d')
      && sanitizedNote.includes('previewed=0')
      && sanitizedNote.includes('deleted=0')
      && pruneInsert?.params[1] === 7
      && pruneInsert?.params[2] === 7,
    { sanitizedNote, params: pruneInsert?.params },
  );

  // Operator note truncated to 400 chars (leaves room for the structured prefix
  // inside the 500-char DB column budget shared with config-change rows).
  captured.length = 0;
  const longOperatorNote = 'y'.repeat(800);
  await recordAiMetricsRetentionPruneAudit({
    changedBy: 'admin',
    retentionDays: 30,
    previewedRows: 1,
    deletedRows: 1,
    note: longOperatorNote,
  });
  pruneInsert = captured.find((q) =>
    /INSERT INTO ai_metrics_retention_audit/i.test(q.sql),
  );
  const truncNote = pruneInsert?.params[3] as string | undefined;
  check(
    'operator note longer than 400 chars is truncated before being appended',
    typeof truncNote === 'string'
      && truncNote.includes(' — ')
      && truncNote.split(' — ')[1].length === 400,
    { len: truncNote ? truncNote.split(' — ')[1]?.length : null },
  );

  console.log('=== getAiMetricsRetentionConfirmThreshold() — env parsing (Task #561) ===');
  const originalRowEnv = process.env.AI_METRICS_RETENTION_CONFIRM_ROW_THRESHOLD;
  const originalDayEnv = process.env.AI_METRICS_RETENTION_CONFIRM_DAY_THRESHOLD;
  delete process.env.AI_METRICS_RETENTION_CONFIRM_ROW_THRESHOLD;
  delete process.env.AI_METRICS_RETENTION_CONFIRM_DAY_THRESHOLD;
  let threshold = getAiMetricsRetentionConfirmThreshold();
  check(
    'defaults: rows=1 days=1 — any tightening that deletes ≥1 row or spans ≥1 day prompts confirm',
    threshold.rows === AI_METRICS_RETENTION_CONFIRM_THRESHOLD_DEFAULTS.rows
      && threshold.days === AI_METRICS_RETENTION_CONFIRM_THRESHOLD_DEFAULTS.days
      && threshold.rows === 1
      && threshold.days === 1,
    { threshold },
  );

  process.env.AI_METRICS_RETENTION_CONFIRM_ROW_THRESHOLD = '5000';
  process.env.AI_METRICS_RETENTION_CONFIRM_DAY_THRESHOLD = '14';
  threshold = getAiMetricsRetentionConfirmThreshold();
  check(
    'reads custom row threshold (5000) and day threshold (14) from env',
    threshold.rows === 5000 && threshold.days === 14,
    { threshold },
  );

  process.env.AI_METRICS_RETENTION_CONFIRM_ROW_THRESHOLD = '0';
  process.env.AI_METRICS_RETENTION_CONFIRM_DAY_THRESHOLD = '0';
  threshold = getAiMetricsRetentionConfirmThreshold();
  check(
    '0 disables that arm of the check (returned verbatim)',
    threshold.rows === 0 && threshold.days === 0,
    { threshold },
  );

  process.env.AI_METRICS_RETENTION_CONFIRM_ROW_THRESHOLD = 'banana';
  process.env.AI_METRICS_RETENTION_CONFIRM_DAY_THRESHOLD = '-50';
  threshold = getAiMetricsRetentionConfirmThreshold();
  check(
    'non-numeric / negative env values fall back to defaults',
    threshold.rows === AI_METRICS_RETENTION_CONFIRM_THRESHOLD_DEFAULTS.rows
      && threshold.days === AI_METRICS_RETENTION_CONFIRM_THRESHOLD_DEFAULTS.days,
    { threshold },
  );

  process.env.AI_METRICS_RETENTION_CONFIRM_ROW_THRESHOLD = '12.7';
  process.env.AI_METRICS_RETENTION_CONFIRM_DAY_THRESHOLD = '3.9';
  threshold = getAiMetricsRetentionConfirmThreshold();
  check(
    'fractional env values are floored to whole numbers',
    threshold.rows === 12 && threshold.days === 3,
    { threshold },
  );

  if (originalRowEnv === undefined) delete process.env.AI_METRICS_RETENTION_CONFIRM_ROW_THRESHOLD;
  else process.env.AI_METRICS_RETENTION_CONFIRM_ROW_THRESHOLD = originalRowEnv;
  if (originalDayEnv === undefined) delete process.env.AI_METRICS_RETENTION_CONFIRM_DAY_THRESHOLD;
  else process.env.AI_METRICS_RETENTION_CONFIRM_DAY_THRESHOLD = originalDayEnv;

  console.log('=== getAiMetricsRetentionAuditPage() — paging + filter (Task #566) ===');

  // Seed 60 audit rows spanning two months. Newer rows have larger ids
  // and later `changed_at` so the natural "newest first" sort is well
  // defined. We use March (31 days) + April (30 days) so all 30 dom
  // values land inside the chosen month — otherwise Feb-29 would
  // silently roll into March and skew the date-range counts.
  clearAll();
  __resetInitPromiseForTests();
  const SEED_TOTAL = 60;
  stubbedAuditRows = Array.from({ length: SEED_TOTAL }, (_, i) => {
    const idx = i + 1;
    const month = idx <= 30 ? 2 /* March */ : 3 /* April */;
    const dom = idx <= 30 ? idx : idx - 30;
    const changed_at = new Date(Date.UTC(2026, month, dom, 12, 0, 0));
    return {
      id: idx,
      changed_at,
      changed_by: i % 2 === 0 ? 'alice' : 'bob',
      before_days: i === 0 ? null : i,
      after_days: i + 1,
      note: i % 5 === 0 ? `note-${i}` : null,
    };
  });
  // Reverse so the newest row (id=60) comes first — mirrors the SQL
  // `ORDER BY changed_at DESC, id DESC` clause the function uses.
  stubbedAuditRows.sort((a, b) => b.changed_at.getTime() - a.changed_at.getTime());

  check(
    'AI_METRICS_RETENTION_AUDIT_MAX_LIMIT is a sensible ceiling (≤ 100)',
    AI_METRICS_RETENTION_AUDIT_MAX_LIMIT === 100,
    { ceiling: AI_METRICS_RETENTION_AUDIT_MAX_LIMIT },
  );

  let page = await getAiMetricsRetentionAuditPage();
  check('default limit is 25', page.limit === 25, { page });
  check('default offset is 0', page.offset === 0, { page });
  check('returns 25 rows by default', page.rows.length === 25, { count: page.rows.length });
  check('reports the full total irrespective of page size', page.total === SEED_TOTAL, {
    total: page.total,
  });
  check(
    'first page newest-first: row 0 is the newest seeded entry (id=60)',
    page.rows[0]?.id === SEED_TOTAL,
    { firstId: page.rows[0]?.id },
  );

  // Older page — offset by one default page.
  page = await getAiMetricsRetentionAuditPage({ limit: 25, offset: 25 });
  check('paged offset returns the next slice', page.rows.length === 25, {
    count: page.rows.length,
  });
  check(
    'second page starts where the first left off (id=35 since 60-25=35)',
    page.rows[0]?.id === SEED_TOTAL - 25,
    { firstId: page.rows[0]?.id },
  );

  // Trailing page is short — only 10 rows left after offset 50.
  page = await getAiMetricsRetentionAuditPage({ limit: 25, offset: 50 });
  check('trailing page returns the leftovers (10 rows)', page.rows.length === 10, {
    count: page.rows.length,
  });
  check('trailing page total still reflects everything', page.total === SEED_TOTAL, {
    total: page.total,
  });

  // Date filter — `from = April 1` keeps only the April half (id 31..60
  // in the seed = 30 rows).
  page = await getAiMetricsRetentionAuditPage({
    limit: 100,
    offset: 0,
    from: new Date(Date.UTC(2026, 3, 1, 0, 0, 0)),
  });
  check(
    'from filter narrows the matching total (April-only = 30 rows)',
    page.total === 30,
    { total: page.total },
  );
  check('from filter narrows the returned rows too', page.rows.length === 30, {
    count: page.rows.length,
  });

  // `to = March 31` keeps only the March half (id 1..30 in the seed).
  page = await getAiMetricsRetentionAuditPage({
    limit: 100,
    offset: 0,
    to: new Date(Date.UTC(2026, 2, 31, 23, 59, 59)),
  });
  check(
    'to filter narrows the matching total (March-only = 30 rows)',
    page.total === 30,
    { total: page.total },
  );

  // Both bounds at once: a 10-day window inside April returns 10 rows.
  page = await getAiMetricsRetentionAuditPage({
    limit: 100,
    offset: 0,
    from: new Date(Date.UTC(2026, 3, 1, 0, 0, 0)),
    to: new Date(Date.UTC(2026, 3, 10, 23, 59, 59)),
  });
  check(
    'from+to combined narrow to a 10-row mid-month slice',
    page.total === 10,
    { total: page.total },
  );

  // Bogus inputs are clamped, never thrown.
  page = await getAiMetricsRetentionAuditPage({ limit: 9_999_999 });
  check(
    'limit above the ceiling is clamped (returns ≤ ceiling rows)',
    page.limit === AI_METRICS_RETENTION_AUDIT_MAX_LIMIT,
    { limit: page.limit },
  );
  page = await getAiMetricsRetentionAuditPage({ limit: -5 });
  check('negative / zero limit is clamped to 1', page.limit === 1, { limit: page.limit });
  page = await getAiMetricsRetentionAuditPage({ offset: -7 });
  check('negative offset is clamped to 0', page.offset === 0, { offset: page.offset });
  page = await getAiMetricsRetentionAuditPage({ from: 'not-a-date', to: '' });
  check(
    'malformed `from` is treated as "no bound" (still returns all rows)',
    page.total === SEED_TOTAL,
    { total: page.total },
  );

  // Backward-compat: the original signature still works and returns the
  // same row shape it always has.
  const rows = await getAiMetricsRetentionAudit();
  check('legacy getAiMetricsRetentionAudit() still returns an array', Array.isArray(rows));
  check('legacy default returns 25 rows when ≥25 exist', rows.length === 25, {
    count: rows.length,
  });

  // Resilience: a DB read failure on the audit must NOT throw — the
  // dashboard tile would otherwise blank. We swallow the expected
  // console.error so the test output stays readable.
  stubAuditReadShouldThrow = true;
  const realErrorAudit = console.error;
  console.error = () => {};
  let resilientPage;
  try {
    resilientPage = await getAiMetricsRetentionAuditPage({ limit: 25 });
  } finally {
    console.error = realErrorAudit;
  }
  check(
    'audit read failure returns an empty page rather than throwing',
    resilientPage != null && resilientPage.rows.length === 0 && resilientPage.total === 0,
    { resilientPage },
  );
  stubAuditReadShouldThrow = false;

  // Restore env vars.
  if (originalEnvDays === undefined) delete process.env.AI_METRICS_RETENTION_DAYS;
  else process.env.AI_METRICS_RETENTION_DAYS = originalEnvDays;
  if (originalEnvLock === undefined) delete process.env.AI_METRICS_RETENTION_DAYS_LOCK;
  else process.env.AI_METRICS_RETENTION_DAYS_LOCK = originalEnvLock;

  // Restore prototype patches.
  (pg.Pool.prototype as unknown as { query: unknown }).query = originalQuery;
  (pg.Pool.prototype as unknown as { connect: unknown }).connect = originalConnect;

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
