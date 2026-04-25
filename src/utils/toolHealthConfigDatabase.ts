/**
 * Persisted overrides for the per-tool health alert thresholds defined in
 * `src/mastra/workflows/toolHealthAlertsCron.ts`.
 *
 * Why a DB row?
 *   The breach floors and severity cutoffs that drive tool-health alerts
 *   used to live exclusively in env vars, which meant tuning them during
 *   an incident required editing secrets and restarting workers. This
 *   table backs a small admin UI in the AI Operations panel so operators
 *   can drop the error-rate floor (etc.) in real time without a redeploy.
 *
 * Schema
 *   tool_health_config_overrides — single row pinned to id = 1. Every
 *     tunable column is NULLable; NULL means "fall back to the env-derived
 *     baseline in toolHealthAlertsCron.ts". `updated_by` and `updated_at`
 *     record the last operator who touched the row. `expires_at` (Task #191)
 *     is an optional timestamp at which the row should be auto-cleared by
 *     the reaper (see {@link reapExpiredToolHealthOverrides}); it lets an
 *     admin set a time-boxed override during an incident without having to
 *     remember to undo it once the storm passes.
 *   tool_health_config_audit — append-only history of changes. Every
 *     successful PUT writes a row capturing the before/after JSON blobs,
 *     the operator, and an optional free-form note. Used by the AI Ops
 *     panel to surface "who changed what, when".
 *
 * The persistence layer is intentionally decoupled from the cron itself:
 *   • runToolHealthCheck() loads the merged config via getToolHealthConfigOverrides()
 *     on every pass, so operators see the new floors take effect at the next cron tick.
 *   • The same cron pass invokes {@link reapExpiredToolHealthOverrides} so a
 *     row whose `expires_at` has passed is cleared and audited as
 *     "system: override expired" before the merge is computed.
 *   • Defense in depth: getToolHealthConfigOverrides() also returns `{}`
 *     when the row is past its expiry, so an effective-config read can
 *     never see expired tunables even if the reaper hasn't run yet (e.g.
 *     between a manual /api/.../tool-health-config GET and the next cron
 *     tick).
 *   • Tests can stub the loader through ToolHealthDeps.loadOverrides without standing
 *     up Postgres.
 */

import { sharedPool as pool } from "./sharedPool";

/**
 * The full set of tunables exposed in the AI Operations panel. Every key is
 * a positive integer; the API layer enforces sane bounds before this module
 * sees the value.
 */
export interface ToolHealthConfigValues {
  windowMinutes: number;
  minCalls: number;
  errorRatePct: number;
  errorRateHighPct: number;
  errorRateCriticalPct: number;
  p95LatencyMs: number;
  latencyHighMs: number;
  latencyCriticalMs: number;
}

export type ToolHealthConfigOverrides = Partial<ToolHealthConfigValues>;

export interface ToolHealthConfigRow {
  overrides: ToolHealthConfigOverrides;
  updated_by: string | null;
  updated_at: Date | null;
  /**
   * When the override row should auto-revert. `null` means "no expiry —
   * keep the override in place until manually cleared". Past timestamps
   * mean the row is awaiting the reaper; the dashboard surfaces this as
   * "expired" and {@link getToolHealthConfigOverrides} treats it as `{}`.
   */
  expires_at: Date | null;
}

export interface ToolHealthConfigAuditEntry {
  id: number;
  changed_at: Date;
  changed_by: string;
  before_values: ToolHealthConfigOverrides;
  after_values: ToolHealthConfigOverrides;
  note: string | null;
}

/**
 * Column ↔ field mapping for the override row. Kept in one place so the
 * read path, write path, and audit blobs can never disagree.
 */
const FIELD_TO_COLUMN: Record<keyof ToolHealthConfigValues, string> = {
  windowMinutes: "window_minutes",
  minCalls: "min_calls",
  errorRatePct: "error_rate_pct",
  errorRateHighPct: "error_rate_high_pct",
  errorRateCriticalPct: "error_rate_critical_pct",
  p95LatencyMs: "p95_latency_ms",
  latencyHighMs: "latency_high_ms",
  latencyCriticalMs: "latency_critical_ms",
};

export const TOOL_HEALTH_CONFIG_FIELDS = Object.keys(FIELD_TO_COLUMN) as Array<
  keyof ToolHealthConfigValues
>;

let initPromise: Promise<void> | null = null;

export async function initToolHealthConfigTables(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tool_health_config_overrides (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        window_minutes          INTEGER,
        min_calls               INTEGER,
        error_rate_pct          INTEGER,
        error_rate_high_pct     INTEGER,
        error_rate_critical_pct INTEGER,
        p95_latency_ms          INTEGER,
        latency_high_ms         INTEGER,
        latency_critical_ms     INTEGER,
        updated_by              VARCHAR(255),
        updated_at              TIMESTAMP DEFAULT NOW()
      )
    `);

    // Idempotent migration: add expires_at to existing installs (Task #191).
    // ADD COLUMN IF NOT EXISTS is safe to re-run on every boot.
    await pool.query(`
      ALTER TABLE tool_health_config_overrides
        ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tool_health_config_audit (
        id            SERIAL PRIMARY KEY,
        changed_at    TIMESTAMP DEFAULT NOW(),
        changed_by    VARCHAR(255) NOT NULL,
        before_values JSONB NOT NULL,
        after_values  JSONB NOT NULL,
        note          TEXT
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_tool_health_config_audit_changed_at
        ON tool_health_config_audit(changed_at DESC)
    `);
  })().catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

/**
 * @internal Test-only — drops the cached init promise so a subsequent call
 * to {@link initToolHealthConfigTables} re-runs the schema bootstrap. Used
 * by integration tests that wipe the table between runs.
 */
export function __resetInitPromiseForTests(): void {
  initPromise = null;
}

function rowToOverrides(row: any | undefined | null): ToolHealthConfigOverrides {
  if (!row) return {};
  const out: ToolHealthConfigOverrides = {};
  for (const field of TOOL_HEALTH_CONFIG_FIELDS) {
    const v = row[FIELD_TO_COLUMN[field]];
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out[field] = n;
  }
  return out;
}

/**
 * True when the row has an `expires_at` set and that timestamp is at or
 * before `now`. Used by the read path to ignore expired overrides even if
 * the reaper has not yet swept them, and by the reaper itself to decide
 * whether to clear.
 */
function isOverrideRowExpired(
  row: any | undefined | null,
  now: Date = new Date(),
): boolean {
  if (!row || row.expires_at == null) return false;
  const expiresAt =
    row.expires_at instanceof Date
      ? row.expires_at
      : new Date(row.expires_at);
  if (Number.isNaN(expiresAt.getTime())) return false;
  return expiresAt.getTime() <= now.getTime();
}

/**
 * True when at least one override field is non-null. Helps the reaper
 * decide whether there is anything to clear (an expired row that already
 * holds only NULLs needs no audit churn).
 */
function rowHasAnyOverrideValue(row: any | undefined | null): boolean {
  if (!row) return false;
  for (const field of TOOL_HEALTH_CONFIG_FIELDS) {
    if (row[FIELD_TO_COLUMN[field]] != null) return true;
  }
  return false;
}

/**
 * Loads the persisted overrides row. Returns an empty object when no row
 * exists yet (i.e. nothing has been tuned through the UI), which signals to
 * the caller that the env baseline should be used as-is.
 *
 * Expired rows (`expires_at` ≤ NOW()) also resolve to `{}` so the cron's
 * effective config drops the override values immediately, even if the
 * reaper hasn't swept them yet — see {@link reapExpiredToolHealthOverrides}
 * for the bookkeeping pass that actually mutates the row + audit log.
 *
 * Failures (no DB, schema not yet migrated, transient error) log and
 * resolve to `{}` so a broken admin UI never blocks the cron from running
 * with the env baseline.
 */
export async function getToolHealthConfigOverrides(): Promise<ToolHealthConfigOverrides> {
  try {
    await initToolHealthConfigTables();
    const result = await pool.query(
      `SELECT * FROM tool_health_config_overrides WHERE id = 1`,
    );
    const row = result.rows[0];
    if (isOverrideRowExpired(row)) return {};
    return rowToOverrides(row);
  } catch (err) {
    console.error("[ToolHealthConfig] Failed to load overrides:", err);
    return {};
  }
}

/**
 * Loads the persisted overrides row plus the bookkeeping fields the AI Ops
 * panel needs to render "last changed by X at T". Distinct from the
 * lightweight {@link getToolHealthConfigOverrides} used by the cron, which
 * only cares about the merged values themselves.
 *
 * Returns the raw `expires_at` regardless of whether it has passed, so the
 * dashboard can label the row as "expires in 23m" / "awaiting reaper" /
 * "no expiry" without a second round-trip.
 */
export async function getToolHealthConfigRow(): Promise<ToolHealthConfigRow> {
  await initToolHealthConfigTables();
  const result = await pool.query(
    `SELECT * FROM tool_health_config_overrides WHERE id = 1`,
  );
  const row = result.rows[0];
  return {
    overrides: rowToOverrides(row),
    updated_by: row?.updated_by ?? null,
    updated_at: row?.updated_at ?? null,
    expires_at: row?.expires_at ?? null,
  };
}

/**
 * Persists a new set of overrides and writes an audit row capturing what
 * changed. Pass `null` for any field to clear the override and let the env
 * baseline apply again. Returns the previous and new override snapshots
 * (useful for surfacing a diff in the response).
 *
 * `expiresAt` follows the same tri-state convention as the override fields:
 *   • omitted (`undefined`)  → leave the existing expires_at untouched.
 *   • `null`                 → clear the expires_at (override is permanent
 *                              until manually revisited).
 *   • `Date`                 → row should auto-revert at this timestamp;
 *                              the cron's reaper will clear it on the next
 *                              pass after the timestamp passes.
 *
 * The update + audit insert run inside a single transaction so the audit
 * trail can never disagree with the live row. The audit blob includes
 * `expires_at` under the synthetic `_expires_at` key so the change history
 * surfaces "X set a 1h auto-revert" without needing a parallel table.
 */
export async function setToolHealthConfigOverrides(input: {
  overrides: { [K in keyof ToolHealthConfigValues]?: number | null };
  changedBy: string;
  note?: string | null;
  expiresAt?: Date | null;
}): Promise<{
  before: ToolHealthConfigOverrides;
  after: ToolHealthConfigOverrides;
  before_expires_at: Date | null;
  after_expires_at: Date | null;
  audit_id: number;
}> {
  await initToolHealthConfigTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const beforeResult = await client.query(
      `SELECT * FROM tool_health_config_overrides WHERE id = 1 FOR UPDATE`,
    );
    const beforeRow = beforeResult.rows[0];
    const before = rowToOverrides(beforeRow);
    const beforeExpiresAt: Date | null = beforeRow?.expires_at ?? null;

    // Build the full row by merging the requested patch onto the existing
    // values. `null` in the patch means "clear this override"; missing keys
    // mean "leave as-is".
    const merged: { [K in keyof ToolHealthConfigValues]: number | null } = {
      windowMinutes: before.windowMinutes ?? null,
      minCalls: before.minCalls ?? null,
      errorRatePct: before.errorRatePct ?? null,
      errorRateHighPct: before.errorRateHighPct ?? null,
      errorRateCriticalPct: before.errorRateCriticalPct ?? null,
      p95LatencyMs: before.p95LatencyMs ?? null,
      latencyHighMs: before.latencyHighMs ?? null,
      latencyCriticalMs: before.latencyCriticalMs ?? null,
    };
    for (const field of TOOL_HEALTH_CONFIG_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(input.overrides, field)) {
        const v = input.overrides[field];
        merged[field] = v == null ? null : Number(v);
      }
    }

    // Resolve the new expires_at: undefined keeps the prior value, null
    // clears it, a Date sets it. We also force-clear when every override
    // ends up null — leaving an orphan expiry on an empty row would just
    // give the reaper an empty audit row to write later.
    let nextExpiresAt: Date | null = beforeExpiresAt;
    if (Object.prototype.hasOwnProperty.call(input, "expiresAt")) {
      nextExpiresAt = input.expiresAt ?? null;
    }
    const allCleared = TOOL_HEALTH_CONFIG_FIELDS.every((f) => merged[f] == null);
    if (allCleared) nextExpiresAt = null;

    const cols = TOOL_HEALTH_CONFIG_FIELDS.map((f) => FIELD_TO_COLUMN[f]);
    const placeholders = TOOL_HEALTH_CONFIG_FIELDS.map((_, i) => `$${i + 1}`);
    const updates = TOOL_HEALTH_CONFIG_FIELDS.map(
      (f, i) => `${FIELD_TO_COLUMN[f]} = EXCLUDED.${FIELD_TO_COLUMN[f]}`,
    );
    const params: any[] = TOOL_HEALTH_CONFIG_FIELDS.map((f) => merged[f]);
    params.push(input.changedBy);
    params.push(nextExpiresAt);

    await client.query(
      `INSERT INTO tool_health_config_overrides
         (id, ${cols.join(", ")}, updated_by, updated_at, expires_at)
       VALUES (1, ${placeholders.join(", ")}, $${params.length - 1}, NOW(), $${params.length})
       ON CONFLICT (id) DO UPDATE SET
         ${updates.join(", ")},
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW(),
         expires_at = EXCLUDED.expires_at`,
      params,
    );

    const afterResult = await client.query(
      `SELECT * FROM tool_health_config_overrides WHERE id = 1`,
    );
    const afterRow = afterResult.rows[0];
    const after = rowToOverrides(afterRow);
    const afterExpiresAt: Date | null = afterRow?.expires_at ?? null;

    // Stash expires_at into the audit JSON under a reserved key prefixed
    // with '_' so it can never collide with a real ToolHealthConfigValues
    // field name (those are all camelCase letters, never starting with an
    // underscore). Existing audit consumers tolerate extra keys.
    const beforeBlob: Record<string, unknown> = { ...before };
    if (beforeExpiresAt) beforeBlob._expires_at = beforeExpiresAt;
    const afterBlob: Record<string, unknown> = { ...after };
    if (afterExpiresAt) afterBlob._expires_at = afterExpiresAt;

    const auditResult = await client.query(
      `INSERT INTO tool_health_config_audit
         (changed_by, before_values, after_values, note)
       VALUES ($1, $2::jsonb, $3::jsonb, $4)
       RETURNING id`,
      [
        input.changedBy,
        JSON.stringify(beforeBlob),
        JSON.stringify(afterBlob),
        input.note ?? null,
      ],
    );

    await client.query("COMMIT");
    return {
      before,
      after,
      before_expires_at: beforeExpiresAt,
      after_expires_at: afterExpiresAt,
      audit_id: auditResult.rows[0].id,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Result of a single reaper pass — see {@link reapExpiredToolHealthOverrides}.
 */
export interface ReapExpiredToolHealthOverridesResult {
  /** True when the row was clear-and-audited; false on a no-op. */
  reaped: boolean;
  /** Snapshot of the override values that were just cleared. */
  cleared_overrides: ToolHealthConfigOverrides;
  /** The expires_at that triggered the reap (so callers can log it). */
  expired_at: Date | null;
  /** The audit row id when reaped, otherwise null. */
  audit_id: number | null;
  /**
   * The `updated_by` value that was on the override row immediately
   * before the reaper cleared it — i.e. the operator (or system actor)
   * who originally scheduled the time-boxed override. Surfaced so the
   * Slack auto-revert notification (Task #213) can attribute the change
   * back to the human who set it. `null` when the row didn't exist or
   * had no updated_by recorded.
   */
  previous_updated_by: string | null;
}

/**
 * Auto-revert pass for time-boxed overrides (Task #191).
 *
 * Looks at the singleton row and, if `expires_at` is set and has passed,
 * clears every override field + `expires_at` itself and writes an audit
 * row attributing the change to the system. Idempotent: a row with no
 * expires_at, an expires_at in the future, or one that's already been
 * cleared (no override values present) returns `{ reaped: false }`.
 *
 * The clear + audit happen inside a single transaction holding a row-lock
 * (`FOR UPDATE`) so it is safe to call from concurrent cron passes — at
 * most one will observe the not-yet-reaped row and write the audit.
 *
 * Failures bubble up so the cron caller can decide whether to log-and-skip
 * (the common case) or treat them as fatal. Callers should always wrap in
 * try/catch — a transient DB error during the reaper must not abort the
 * surrounding cron pass.
 */
export async function reapExpiredToolHealthOverrides(): Promise<ReapExpiredToolHealthOverridesResult> {
  await initToolHealthConfigTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const beforeResult = await client.query(
      `SELECT * FROM tool_health_config_overrides WHERE id = 1 FOR UPDATE`,
    );
    const row = beforeResult.rows[0];

    if (!row || !isOverrideRowExpired(row) || !rowHasAnyOverrideValue(row)) {
      // Nothing to do — but still clear an orphan expires_at on a row whose
      // override values are all NULL, so the dashboard doesn't keep showing
      // a stale "expires in -2h" forever.
      if (row && row.expires_at != null && !rowHasAnyOverrideValue(row)) {
        await client.query(
          `UPDATE tool_health_config_overrides
              SET expires_at = NULL
            WHERE id = 1`,
        );
      }
      await client.query("COMMIT");
      return {
        reaped: false,
        cleared_overrides: {},
        expired_at: row?.expires_at ?? null,
        audit_id: null,
        previous_updated_by: row?.updated_by ?? null,
      };
    }

    const before = rowToOverrides(row);
    const previousUpdatedBy: string | null = row?.updated_by ?? null;
    const expiredAt: Date =
      row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);

    // Wipe every override field and the expires_at marker. We intentionally
    // leave `updated_by` set to the system attribution string and bump
    // `updated_at` so the dashboard meta line reflects the auto-revert.
    const setClauses = TOOL_HEALTH_CONFIG_FIELDS.map(
      (f) => `${FIELD_TO_COLUMN[f]} = NULL`,
    ).join(", ");
    await client.query(
      `UPDATE tool_health_config_overrides
          SET ${setClauses},
              expires_at = NULL,
              updated_by = $1,
              updated_at = NOW()
        WHERE id = 1`,
      [SYSTEM_REAPER_ATTRIBUTION],
    );

    const beforeBlob: Record<string, unknown> = { ...before };
    beforeBlob._expires_at = expiredAt;
    const note =
      `Auto-cleared because expires_at (${expiredAt.toISOString()}) had passed.`;
    const auditResult = await client.query(
      `INSERT INTO tool_health_config_audit
         (changed_by, before_values, after_values, note)
       VALUES ($1, $2::jsonb, $3::jsonb, $4)
       RETURNING id`,
      [
        SYSTEM_REAPER_ATTRIBUTION,
        JSON.stringify(beforeBlob),
        JSON.stringify({}),
        note,
      ],
    );

    await client.query("COMMIT");
    return {
      reaped: true,
      cleared_overrides: before,
      expired_at: expiredAt,
      audit_id: auditResult.rows[0].id,
      previous_updated_by: previousUpdatedBy,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Stable attribution string written to `changed_by` (and reused in the
 * `updated_by` column on the live row) when the reaper clears an expired
 * override. Exported so callers — and tests — can assert against the
 * literal value the dashboard renders in the audit list.
 */
export const SYSTEM_REAPER_ATTRIBUTION = "system: override expired";

/**
 * Describes an override row that is expiring within a configurable look-ahead
 * window but has not yet passed its `expires_at`.  Returned by
 * {@link getToolHealthOverrideExpiringSoon} so the cron can dispatch a
 * pre-warning Slack message (Task #219).
 */
export interface ToolHealthOverrideExpiringSoon {
  /** The exact timestamp at which the override will auto-revert. */
  expires_at: Date;
  /** Operator who created the time-boxed override (may be null). */
  updated_by: string | null;
  /** The override values currently in effect (non-null fields only). */
  overrides: ToolHealthConfigOverrides;
  /** Approximate minutes remaining until expiry, rounded to nearest minute. */
  minutes_remaining: number;
}

/**
 * Returns the live override row when its `expires_at` falls within the
 * next `windowMs` milliseconds (strictly in the future — not yet expired).
 * Returns `null` when:
 *   • there is no override row;
 *   • `expires_at` is null (no scheduled revert);
 *   • `expires_at` has already passed (let the reaper handle it);
 *   • `expires_at` is further away than `windowMs`;
 *   • a DB error occurs (logged, best-effort).
 *
 * Safe to call on every cron tick — never throws.
 */
export async function getToolHealthOverrideExpiringSoon(
  windowMs: number,
  now: Date = new Date(),
): Promise<ToolHealthOverrideExpiringSoon | null> {
  try {
    await initToolHealthConfigTables();
    const result = await pool.query(
      `SELECT * FROM tool_health_config_overrides WHERE id = 1`,
    );
    const row = result.rows[0];
    if (!row || row.expires_at == null) return null;

    const expiresAt =
      row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
    if (Number.isNaN(expiresAt.getTime())) return null;

    const msRemaining = expiresAt.getTime() - now.getTime();
    // Must be strictly in the future (not expired) and within the look-ahead window.
    if (msRemaining <= 0 || msRemaining > windowMs) return null;

    const overrides = rowToOverrides(row);
    if (Object.keys(overrides).length === 0) return null;

    return {
      expires_at: expiresAt,
      updated_by: row.updated_by ?? null,
      overrides,
      minutes_remaining: Math.round(msRemaining / 60_000),
    };
  } catch (err) {
    console.error("[ToolHealthConfig] Failed to check expiring-soon overrides:", err);
    return null;
  }
}

/**
 * Returns the most recent N audit rows, newest first. Used by the AI Ops
 * panel to surface "who changed what, when" alongside the live form.
 */
export async function getToolHealthConfigAudit(
  limit: number = 20,
): Promise<ToolHealthConfigAuditEntry[]> {
  await initToolHealthConfigTables();
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const result = await pool.query(
    `SELECT id, changed_at, changed_by, before_values, after_values, note
       FROM tool_health_config_audit
       ORDER BY changed_at DESC, id DESC
       LIMIT $1`,
    [safeLimit],
  );
  return result.rows.map((r: any) => ({
    id: r.id,
    changed_at: r.changed_at,
    changed_by: r.changed_by,
    before_values: typeof r.before_values === "string"
      ? JSON.parse(r.before_values)
      : (r.before_values ?? {}),
    after_values: typeof r.after_values === "string"
      ? JSON.parse(r.after_values)
      : (r.after_values ?? {}),
    note: r.note ?? null,
  }));
}
