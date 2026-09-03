/**
 * Persisted dashboard override for the `ai_call_metrics` retention window
 * exposed at `AI_METRICS_RETENTION_DAYS` (Task #236).
 *
 * Why a DB row?
 *   Operators can already tune the retention window via env, but changing
 *   it requires a redeploy. This single-row table backs the new "AI usage
 *   history retention" control on the AI Operations dashboard so an admin
 *   can try a tighter window (e.g. for a quick perf experiment) or a wider
 *   one (for trend analysis) without bothering DevOps. The daily prune
 *   cron (`ai-cost-summary`) reloads this row every pass, so a save takes
 *   effect on the next tick — no restart needed.
 *
 * Schema
 *   ai_metrics_retention_config — single row pinned to id = 1.
 *     • retention_days  INTEGER NULLABLE  — NULL means "no override; use
 *       the env baseline / compile-time default".
 *     • updated_by      VARCHAR(255)      — operator name/email/userId.
 *     • updated_at      TIMESTAMP         — last write time.
 *   ai_metrics_retention_audit — append-only history of changes. Every
 *     successful write records the before/after value, the operator, and
 *     an optional free-form note. Surfaced on the dashboard so future-you
 *     knows why the window was tightened during last week's incident.
 *
 * Precedence (computed by `resolveEffectiveAiMetricsRetentionDays()` in
 * `aiTelemetry.ts`):
 *   1. DB override (this row), if a positive integer
 *   2. `AI_METRICS_RETENTION_DAYS` env var, if a positive integer
 *   3. {@link DEFAULT_AI_METRICS_RETENTION_DAYS}
 *
 * The env var continues to work as a fallback when the DB override is
 * unset, AND as a hard lock when `AI_METRICS_RETENTION_DAYS_LOCK` is set
 * to a truthy value (`1`, `true`, `yes`, `on`) — in lock mode the env
 * value wins over any dashboard override, and the UI surfaces a banner
 * explaining that saves will not take effect.
 */

import { sharedPool as pool } from "./sharedPool";

import { logger } from "./logger";
/**
 * Bounds applied to dashboard input. Picked to cover every legitimate
 * tuning operators have asked for (a one-day prune window for a perf
 * experiment, a ten-year window for trend analysis) while still rejecting
 * obviously broken inputs (zero, negative, or absurdly large values that
 * would effectively disable the prune).
 */
export const AI_METRICS_RETENTION_BOUNDS = { min: 1, max: 3650 } as const;

export interface AiMetricsRetentionConfigRow {
  /** Override value in days, or `null` if no override is set. */
  retention_days: number | null;
  updated_by: string | null;
  updated_at: Date | null;
}

export interface AiMetricsRetentionAuditEntry {
  id: number;
  changed_at: Date;
  changed_by: string;
  before_days: number | null;
  after_days: number | null;
  note: string | null;
}

let initPromise: Promise<void> | null = null;

export async function initAiMetricsRetentionConfigTable(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_metrics_retention_config (
        id             INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        retention_days INTEGER,
        updated_by     VARCHAR(255),
        updated_at     TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_metrics_retention_audit (
        id          SERIAL PRIMARY KEY,
        changed_at  TIMESTAMP DEFAULT NOW(),
        changed_by  VARCHAR(255) NOT NULL,
        before_days INTEGER,
        after_days  INTEGER,
        note        TEXT
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_metrics_retention_audit_changed_at
        ON ai_metrics_retention_audit(changed_at DESC)
    `);
  })().catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

/**
 * @internal Test-only — drops the cached init promise so a subsequent call
 * to {@link initAiMetricsRetentionConfigTable} re-runs the schema bootstrap.
 */
export function __resetInitPromiseForTests(): void {
  initPromise = null;
}

function rowToConfig(row: any | undefined | null): AiMetricsRetentionConfigRow {
  if (!row) return { retention_days: null, updated_by: null, updated_at: null };
  const raw = row.retention_days;
  let retention_days: number | null = null;
  if (raw != null) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) retention_days = Math.floor(n);
  }
  return {
    retention_days,
    updated_by: row.updated_by ?? null,
    updated_at: row.updated_at ?? null,
  };
}

/**
 * Read the current dashboard override row. Returns
 * `{ retention_days: null, updated_by: null, updated_at: null }` when no
 * override has ever been set, when the row's value has been cleared back
 * to NULL, or when the table read fails — so a transient DB hiccup never
 * causes the cron to silently switch retention windows.
 */
export async function getAiMetricsRetentionConfig(): Promise<AiMetricsRetentionConfigRow> {
  try {
    await initAiMetricsRetentionConfigTable();
    const result = await pool.query(
      `SELECT retention_days, updated_by, updated_at
         FROM ai_metrics_retention_config
        WHERE id = 1`,
    );
    return rowToConfig(result.rows?.[0]);
  } catch (err) {
    logger.error("[aiMetricsRetentionConfig] read failed:", err);
    return { retention_days: null, updated_by: null, updated_at: null };
  }
}

export interface SetAiMetricsRetentionParams {
  /**
   * The new override value in days, or `null` to clear the override and
   * fall back to the env / default. Validated against
   * {@link AI_METRICS_RETENTION_BOUNDS} by the caller.
   */
  retentionDays: number | null;
  /** Operator name/email/userId for the audit row. */
  changedBy: string;
  /** Optional free-form note (truncated to 500 chars by the caller). */
  note?: string | null;
}

export interface SetAiMetricsRetentionResult {
  before: number | null;
  after: number | null;
  audit_id: number | null;
}

/**
 * Upsert the override row and append an audit entry in a single
 * transaction so a partial write can never leave the audit log out of
 * sync with the live config.
 */
export async function setAiMetricsRetentionConfig(
  params: SetAiMetricsRetentionParams,
): Promise<SetAiMetricsRetentionResult> {
  await initAiMetricsRetentionConfigTable();
  const { retentionDays, changedBy } = params;
  const note =
    params.note != null && params.note !== ""
      ? String(params.note).slice(0, 500)
      : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const beforeRes = await client.query(
      `SELECT retention_days FROM ai_metrics_retention_config WHERE id = 1 FOR UPDATE`,
    );
    const before = beforeRes.rows?.[0]?.retention_days ?? null;
    const beforeNum: number | null =
      before != null && Number.isFinite(Number(before))
        ? Math.floor(Number(before))
        : null;

    await client.query(
      `INSERT INTO ai_metrics_retention_config (id, retention_days, updated_by, updated_at)
       VALUES (1, $1, $2, NOW())
       ON CONFLICT (id) DO UPDATE
         SET retention_days = EXCLUDED.retention_days,
             updated_by     = EXCLUDED.updated_by,
             updated_at     = NOW()`,
      [retentionDays, changedBy],
    );

    const auditRes = await client.query(
      `INSERT INTO ai_metrics_retention_audit (changed_by, before_days, after_days, note)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [changedBy, beforeNum, retentionDays, note],
    );

    await client.query("COMMIT");
    return {
      before: beforeNum,
      after: retentionDays,
      audit_id: auditRes.rows?.[0]?.id ?? null,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback errors */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Hard server-side ceiling on how many audit rows a single request may
 * fetch. Picked to keep the response small enough to render in one shot
 * (the dashboard is a static table, not a virtualised list) while still
 * letting an operator pull a meaningful chunk per page during a deep
 * audit. Mirrored in the route's `limit` validator.
 */
export const AI_METRICS_RETENTION_AUDIT_MAX_LIMIT = 100;

export interface GetAiMetricsRetentionAuditOptions {
  /**
   * Page size (1..{@link AI_METRICS_RETENTION_AUDIT_MAX_LIMIT}). Defaults
   * to 25 so the existing dashboard call site keeps its prior behaviour
   * when no options are provided.
   */
  limit?: number;
  /** Number of rows to skip from the newest end. Defaults to 0. */
  offset?: number;
  /**
   * Optional inclusive lower bound on `changed_at` (i.e. only rows on or
   * after this instant are returned). Accepts a `Date`, an ISO-8601
   * string, or `null`/`undefined` for "no lower bound".
   */
  from?: Date | string | null;
  /**
   * Optional inclusive upper bound on `changed_at`. Accepts the same
   * shapes as `from`.
   */
  to?: Date | string | null;
}

export interface AiMetricsRetentionAuditPage {
  rows: AiMetricsRetentionAuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

function coerceBoundary(value: Date | string | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Return the most recent N audit entries, newest first. Used by the AI
 * Ops dashboard to surface "who tightened the window during last week's
 * incident". Defaults to 25 to match the threshold-tuning audit panel.
 *
 * Kept for backward compatibility — call sites that need paging or the
 * total count should use {@link getAiMetricsRetentionAuditPage} instead.
 */
export async function getAiMetricsRetentionAudit(
  limit = 25,
): Promise<AiMetricsRetentionAuditEntry[]> {
  const page = await getAiMetricsRetentionAuditPage({ limit });
  return page.rows;
}

/**
 * Paged + optional date-range read of the retention audit log
 * (Task #566). Surfaces both the requested slice AND the matching total
 * so the dashboard can render "Showing 26–50 of 137" and disable Newer /
 * Older buttons at the boundaries.
 *
 * The function defends itself against bogus inputs (NaN, negatives,
 * over-ceiling limits, malformed dates) by clamping rather than
 * throwing — the route layer is responsible for surfacing 400s on
 * unparseable user input; this layer just guarantees it never issues a
 * runaway query if a programmatic caller passes garbage.
 *
 * On a DB read failure we return `{ rows: [], total: 0 }` so a transient
 * hiccup never blanks the AI-Ops dashboard with a stack trace; the
 * caller has already seen the failure logged here.
 */
export async function getAiMetricsRetentionAuditPage(
  opts: GetAiMetricsRetentionAuditOptions = {},
): Promise<AiMetricsRetentionAuditPage> {
  const safeLimit = Math.max(
    1,
    Math.min(
      AI_METRICS_RETENTION_AUDIT_MAX_LIMIT,
      Math.floor(Number(opts.limit) || 25),
    ),
  );
  const safeOffset = Math.max(
    0,
    Math.floor(Number(opts.offset) || 0),
  );
  const from = coerceBoundary(opts.from);
  const to = coerceBoundary(opts.to);

  try {
    await initAiMetricsRetentionConfigTable();

    const whereParts: string[] = [];
    const whereParams: unknown[] = [];
    if (from) {
      whereParams.push(from);
      whereParts.push(`changed_at >= $${whereParams.length}`);
    }
    if (to) {
      whereParams.push(to);
      whereParts.push(`changed_at <= $${whereParams.length}`);
    }
    const whereClause = whereParts.length
      ? `WHERE ${whereParts.join(" AND ")}`
      : "";

    const countSql = `SELECT COUNT(*)::bigint AS n FROM ai_metrics_retention_audit ${whereClause}`;
    const pageSql =
      `SELECT id, changed_at, changed_by, before_days, after_days, note
         FROM ai_metrics_retention_audit
         ${whereClause}
        ORDER BY changed_at DESC, id DESC
        LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}`;

    const [countRes, pageRes] = await Promise.all([
      pool.query(countSql, whereParams),
      pool.query(pageSql, [...whereParams, safeLimit, safeOffset]),
    ]);

    const totalRaw = countRes.rows?.[0]?.n;
    const total = Number(totalRaw ?? 0);
    const rows = (pageRes.rows ?? []).map((r: any) => ({
      id: Number(r.id),
      changed_at: r.changed_at,
      changed_by: r.changed_by,
      before_days: r.before_days == null ? null : Number(r.before_days),
      after_days: r.after_days == null ? null : Number(r.after_days),
      note: r.note ?? null,
    }));

    return {
      rows,
      total: Number.isFinite(total) ? total : 0,
      limit: safeLimit,
      offset: safeOffset,
    };
  } catch (err) {
    logger.error("[aiMetricsRetentionConfig] audit read failed:", err);
    return { rows: [], total: 0, limit: safeLimit, offset: safeOffset };
  }
}

/**
 * Server-side batch size used when streaming the full audit history out as
 * CSV (Task #652). Picked so each fetch round-trips a meaningful chunk of
 * rows without holding all of them in memory at once — admins occasionally
 * pull a multi-year retention audit during compliance reviews and the
 * paged GET would silently cap that at {@link AI_METRICS_RETENTION_AUDIT_MAX_LIMIT}.
 *
 * The export endpoint streams batches of this size in newest-first order
 * until the underlying SELECT runs out of matching rows. Increasing the
 * batch trades fewer round-trips for a larger working set per chunk.
 */
export const AI_METRICS_RETENTION_AUDIT_EXPORT_BATCH_SIZE = 500;

/**
 * Streaming, ceiling-bypassing read of the retention audit log used by
 * the CSV export endpoint (Task #652). Yields entries newest-first in
 * chunks of {@link AI_METRICS_RETENTION_AUDIT_EXPORT_BATCH_SIZE}, stopping
 * when the underlying query returns fewer rows than the batch size.
 *
 * Honours the same `from` / `to` date-range filter as
 * {@link getAiMetricsRetentionAuditPage} so the exported file matches the
 * window the operator is currently looking at on the dashboard. Does NOT
 * accept a `limit` — the whole point of this helper is to bypass the
 * 100-row paging ceiling when an admin asks for "everything from last
 * quarter as a spreadsheet".
 *
 * Fails CLOSED on DB read failure — both the init call and any batch
 * query rethrow so the caller (the CSV export route) can surface a 500
 * instead of streaming a silently-truncated file. A partial audit export
 * during an incident review is materially worse than no export: it would
 * mislead compliance into thinking they had the full timeline.
 */
export async function* streamAiMetricsRetentionAudit(
  opts: { from?: Date | string | null; to?: Date | string | null } = {},
): AsyncGenerator<AiMetricsRetentionAuditEntry, void, void> {
  const from = coerceBoundary(opts.from);
  const to = coerceBoundary(opts.to);

  await initAiMetricsRetentionConfigTable();

  const whereParts: string[] = [];
  const whereParams: unknown[] = [];
  if (from) {
    whereParams.push(from);
    whereParts.push(`changed_at >= $${whereParams.length}`);
  }
  if (to) {
    whereParams.push(to);
    whereParts.push(`changed_at <= $${whereParams.length}`);
  }
  const whereClause = whereParts.length
    ? `WHERE ${whereParts.join(" AND ")}`
    : "";

  const batchSize = AI_METRICS_RETENTION_AUDIT_EXPORT_BATCH_SIZE;
  let offset = 0;
  // Hard safety ceiling to defend against a runaway loop on a misbehaving
  // driver that returns a full batch forever. 10M rows is multiple orders
  // of magnitude past any plausible audit history (the table only grows
  // on operator clicks + daily prune runs).
  const SAFETY_CAP = 10_000_000;

  while (offset < SAFETY_CAP) {
    const pageSql =
      `SELECT id, changed_at, changed_by, before_days, after_days, note
         FROM ai_metrics_retention_audit
         ${whereClause}
        ORDER BY changed_at DESC, id DESC
        LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}`;
    const res = await pool.query(pageSql, [...whereParams, batchSize, offset]);
    const rows: any[] = res.rows ?? [];

    for (const r of rows) {
      yield {
        id: Number(r.id),
        changed_at: r.changed_at,
        changed_by: r.changed_by,
        before_days: r.before_days == null ? null : Number(r.before_days),
        after_days: r.after_days == null ? null : Number(r.after_days),
        note: r.note ?? null,
      };
    }

    if (rows.length < batchSize) return;
    offset += batchSize;
  }
}

/**
 * Marker prefix used in `ai_metrics_retention_audit.note` for rows that
 * record a manual "Prune now" run (Task #558) rather than a config
 * change. The dashboard's audit renderer detects this prefix to label
 * the row distinctly and to surface the previewed-vs-actual deletion
 * counts inline. The marker stays in the note (not a separate column)
 * so manual prunes share the same audit ladder as config changes —
 * operators only have one place to look when reconstructing what
 * happened during an incident.
 */
export const AI_METRICS_RETENTION_PRUNE_NOW_NOTE_PREFIX = '[prune-now]' as const;

export interface RecordAiMetricsRetentionPruneAuditParams {
  /** Operator who clicked "Prune now" (display name / email / "user:<id>"). */
  changedBy: string;
  /** Effective retention window the prune actually used (days). */
  retentionDays: number;
  /** Row count returned by the dry-run preview that ran immediately before the prune. */
  previewedRows: number;
  /** Row count actually returned by `pruneOldAiMetrics()`. */
  deletedRows: number;
  /** Optional free-form note from the operator (truncated to 500 chars by the caller). */
  note?: string | null;
}

export interface RecordAiMetricsRetentionPruneAuditResult {
  audit_id: number | null;
}

/**
 * Append an audit row recording a manual "Prune now" execution
 * (Task #558).
 *
 * Re-uses the same `ai_metrics_retention_audit` table as config changes
 * so admins only have one timeline to scan when reconstructing what
 * happened to the retention window during an incident. To keep the
 * existing schema unchanged, prune-now rows set `before_days` and
 * `after_days` to the retention window the prune actually used (i.e.
 * before === after — no config change) and prefix the note with
 * {@link AI_METRICS_RETENTION_PRUNE_NOW_NOTE_PREFIX} together with the
 * structured `previewed=N deleted=M retention=Xd` triple. The dashboard
 * audit renderer detects the prefix and shows the previewed-vs-actual
 * drift inline so any divergence is visible at a glance.
 */
export async function recordAiMetricsRetentionPruneAudit(
  params: RecordAiMetricsRetentionPruneAuditParams,
): Promise<RecordAiMetricsRetentionPruneAuditResult> {
  await initAiMetricsRetentionConfigTable();
  const retention = Math.max(1, Math.floor(Number(params.retentionDays) || 0));
  const previewed = Math.max(0, Math.floor(Number(params.previewedRows) || 0));
  const deleted = Math.max(0, Math.floor(Number(params.deletedRows) || 0));
  const operatorNote = params.note != null && params.note !== ''
    ? String(params.note).slice(0, 400) // leave room for the structured prefix
    : null;
  const structured =
    `${AI_METRICS_RETENTION_PRUNE_NOW_NOTE_PREFIX} previewed=${previewed} deleted=${deleted} retention=${retention}d`;
  const note = operatorNote ? `${structured} — ${operatorNote}` : structured;

  try {
    const result = await pool.query(
      `INSERT INTO ai_metrics_retention_audit (changed_by, before_days, after_days, note)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [params.changedBy, retention, retention, note],
    );
    return { audit_id: result.rows?.[0]?.id ?? null };
  } catch (err) {
    logger.error('[aiMetricsRetentionConfig] prune-now audit write failed', err as Error);
    return { audit_id: null };
  }
}

/**
 * Default thresholds for the Save-button inline confirm step (Task #561).
 *
 * The dashboard requires an explicit "yes I want to delete this" click
 * before tightening the retention window when EITHER the row count OR
 * the day-span of telemetry being pruned crosses the matching threshold.
 *
 * Defaults to 1 / 1 — i.e. any tightening that would actually delete
 * something requires confirmation. Operators who want a quieter UX in
 * low-volume environments can raise the row threshold via
 * `AI_METRICS_RETENTION_CONFIRM_ROW_THRESHOLD` and / or
 * `AI_METRICS_RETENTION_CONFIRM_DAY_THRESHOLD`. Setting either to `0`
 * disables that arm of the check; setting both to `0` disables the
 * inline confirm entirely (useful in CI / test fixtures).
 */
export const AI_METRICS_RETENTION_CONFIRM_THRESHOLD_DEFAULTS = {
  rows: 1,
  days: 1,
} as const;

export interface AiMetricsRetentionConfirmThreshold {
  /** Minimum rows-to-delete that triggers the confirm step. `0` disables this arm. */
  rows: number;
  /** Minimum days-to-delete that triggers the confirm step. `0` disables this arm. */
  days: number;
}

function parseNonNegativeInt(raw: unknown, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * Read the configurable confirm-step threshold from env vars
 * (Task #561). Returned values are non-negative integers and are safe to
 * surface to the dashboard verbatim.
 *
 * Either arm being met (`rows >= rows-threshold` OR `days >= days-threshold`)
 * with a non-zero threshold value triggers the inline confirm step on
 * Save. The thresholds are reported on the GET retention endpoint so the
 * client can apply them without a second round-trip.
 */
export function getAiMetricsRetentionConfirmThreshold(): AiMetricsRetentionConfirmThreshold {
  return {
    rows: parseNonNegativeInt(
      process.env.AI_METRICS_RETENTION_CONFIRM_ROW_THRESHOLD,
      AI_METRICS_RETENTION_CONFIRM_THRESHOLD_DEFAULTS.rows,
    ),
    days: parseNonNegativeInt(
      process.env.AI_METRICS_RETENTION_CONFIRM_DAY_THRESHOLD,
      AI_METRICS_RETENTION_CONFIRM_THRESHOLD_DEFAULTS.days,
    ),
  };
}

/**
 * True when an env-var lock is engaged via
 * `AI_METRICS_RETENTION_DAYS_LOCK`. Lock mode forces the env value to
 * win over any dashboard override; the UI surfaces a banner so admins
 * know saves will be ignored until the lock is lifted.
 */
export function isAiMetricsRetentionLocked(): boolean {
  const raw = process.env.AI_METRICS_RETENTION_DAYS_LOCK;
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
