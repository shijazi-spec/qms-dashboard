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
 *     record the last operator who touched the row.
 *   tool_health_config_audit — append-only history of changes. Every
 *     successful PUT writes a row capturing the before/after JSON blobs,
 *     the operator, and an optional free-form note. Used by the AI Ops
 *     panel to surface "who changed what, when".
 *
 * The persistence layer is intentionally decoupled from the cron itself:
 *   • runToolHealthCheck() loads the merged config via getToolHealthConfigOverrides()
 *     on every pass, so operators see the new floors take effect at the next cron tick.
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
 * Loads the persisted overrides row. Returns an empty object when no row
 * exists yet (i.e. nothing has been tuned through the UI), which signals to
 * the caller that the env baseline should be used as-is.
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
    return rowToOverrides(result.rows[0]);
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
  };
}

/**
 * Persists a new set of overrides and writes an audit row capturing what
 * changed. Pass `null` for any field to clear the override and let the env
 * baseline apply again. Returns the previous and new override snapshots
 * (useful for surfacing a diff in the response).
 *
 * The update + audit insert run inside a single transaction so the audit
 * trail can never disagree with the live row.
 */
export async function setToolHealthConfigOverrides(input: {
  overrides: { [K in keyof ToolHealthConfigValues]?: number | null };
  changedBy: string;
  note?: string | null;
}): Promise<{
  before: ToolHealthConfigOverrides;
  after: ToolHealthConfigOverrides;
  audit_id: number;
}> {
  await initToolHealthConfigTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const beforeResult = await client.query(
      `SELECT * FROM tool_health_config_overrides WHERE id = 1 FOR UPDATE`,
    );
    const before = rowToOverrides(beforeResult.rows[0]);

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

    const cols = TOOL_HEALTH_CONFIG_FIELDS.map((f) => FIELD_TO_COLUMN[f]);
    const placeholders = TOOL_HEALTH_CONFIG_FIELDS.map((_, i) => `$${i + 1}`);
    const updates = TOOL_HEALTH_CONFIG_FIELDS.map(
      (f, i) => `${FIELD_TO_COLUMN[f]} = EXCLUDED.${FIELD_TO_COLUMN[f]}`,
    );
    const params: any[] = TOOL_HEALTH_CONFIG_FIELDS.map((f) => merged[f]);
    params.push(input.changedBy);

    await client.query(
      `INSERT INTO tool_health_config_overrides
         (id, ${cols.join(", ")}, updated_by, updated_at)
       VALUES (1, ${placeholders.join(", ")}, $${params.length}, NOW())
       ON CONFLICT (id) DO UPDATE SET
         ${updates.join(", ")},
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      params,
    );

    const afterResult = await client.query(
      `SELECT * FROM tool_health_config_overrides WHERE id = 1`,
    );
    const after = rowToOverrides(afterResult.rows[0]);

    const auditResult = await client.query(
      `INSERT INTO tool_health_config_audit
         (changed_by, before_values, after_values, note)
       VALUES ($1, $2::jsonb, $3::jsonb, $4)
       RETURNING id`,
      [
        input.changedBy,
        JSON.stringify(before),
        JSON.stringify(after),
        input.note ?? null,
      ],
    );

    await client.query("COMMIT");
    return { before, after, audit_id: auditResult.rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
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
