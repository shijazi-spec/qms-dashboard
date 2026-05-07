/**
 * Persisted overrides for the prompt-regression alert thresholds defined in
 * `src/mastra/workflows/promptRegressionAlertsCron.ts`.
 *
 * Why a DB row?
 *   The thresholds that drive prompt-regression alerts (drop in pp vs the
 *   best version, min sample size, evaluation window, and the cooldown
 *   between repeat pages) used to live exclusively in env vars. That meant
 *   tuning sensitivity required editing secrets and restarting workers.
 *   This table backs the new "Prompt regression thresholds" section in the
 *   AI Operations panel so admins can adjust them in real time.
 *
 * Schema
 *   prompt_regression_config_overrides — single row pinned to id = 1. Each
 *     tunable column is NULLable; NULL means "fall back to the env-derived
 *     baseline". `updated_by` and `updated_at` record the operator who last
 *     touched the row.
 *   prompt_regression_config_audit — append-only history of changes. Every
 *     successful PUT writes a row capturing the before/after JSON blobs,
 *     the operator, and an optional free-form note.
 *
 * Mirrors the design of toolHealthConfigDatabase.ts (the per-tool health
 * threshold form) so the two admin panels behave consistently.
 */

import { sharedPool } from "./sharedPool";
import { wrapPoolForRedaction } from "./redactedPool";

import { logger } from "./logger";

const pool = wrapPoolForRedaction(sharedPool);

/**
 * The full set of tunables exposed in the AI Operations panel for prompt
 * regression. Every key is a positive integer; the API layer enforces sane
 * bounds before this module sees the value.
 */
export interface PromptRegressionConfigValues {
  /** Minimum drop in percentage points vs the best version before alerting. */
  dropPctPoints: number;
  /** Minimum thumbs-up + thumbs-down samples a version needs to be eligible. */
  minFeedback: number;
  /** Rolling window (days) over which feedback is aggregated. */
  windowDays: number;
  /** Minutes within which the same `<agent>:<version>` key will not be paged twice. */
  notifyThrottleMin: number;
}

export type PromptRegressionConfigOverrides =
  Partial<PromptRegressionConfigValues>;

export interface PromptRegressionConfigRow {
  overrides: PromptRegressionConfigOverrides;
  updated_by: string | null;
  updated_at: Date | null;
}

export interface PromptRegressionConfigAuditEntry {
  id: number;
  changed_at: Date;
  changed_by: string;
  before_values: PromptRegressionConfigOverrides;
  after_values: PromptRegressionConfigOverrides;
  note: string | null;
}

/**
 * Column ↔ field mapping for the override row. Kept in one place so the
 * read path, write path, and audit blobs can never disagree.
 */
const FIELD_TO_COLUMN: Record<keyof PromptRegressionConfigValues, string> = {
  dropPctPoints: "drop_pct_points",
  minFeedback: "min_feedback",
  windowDays: "window_days",
  notifyThrottleMin: "notify_throttle_min",
};

export const PROMPT_REGRESSION_CONFIG_FIELDS = Object.keys(
  FIELD_TO_COLUMN,
) as Array<keyof PromptRegressionConfigValues>;

let initPromise: Promise<void> | null = null;

export async function initPromptRegressionConfigTables(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS prompt_regression_config_overrides (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        drop_pct_points     INTEGER,
        min_feedback        INTEGER,
        window_days         INTEGER,
        notify_throttle_min INTEGER,
        updated_by          VARCHAR(255),
        updated_at          TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS prompt_regression_config_audit (
        id            SERIAL PRIMARY KEY,
        changed_at    TIMESTAMP DEFAULT NOW(),
        changed_by    VARCHAR(255) NOT NULL,
        before_values JSONB NOT NULL,
        after_values  JSONB NOT NULL,
        note          TEXT
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_prompt_regression_config_audit_changed_at
        ON prompt_regression_config_audit(changed_at DESC)
    `);
  })().catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

/**
 * @internal Test-only — drops the cached init promise so a subsequent call
 * to {@link initPromptRegressionConfigTables} re-runs the schema bootstrap.
 */
export function __resetInitPromiseForTests(): void {
  initPromise = null;
}

function rowToOverrides(
  row: any | undefined | null,
): PromptRegressionConfigOverrides {
  if (!row) return {};
  const out: PromptRegressionConfigOverrides = {};
  for (const field of PROMPT_REGRESSION_CONFIG_FIELDS) {
    const v = row[FIELD_TO_COLUMN[field]];
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) out[field] = n;
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
export async function getPromptRegressionConfigOverrides(): Promise<PromptRegressionConfigOverrides> {
  try {
    await initPromptRegressionConfigTables();
    const result = await pool.query(
      `SELECT * FROM prompt_regression_config_overrides WHERE id = 1`,
    );
    return rowToOverrides(result.rows[0]);
  } catch (err) {
    logger.error("[PromptRegressionConfig] Failed to load overrides:", err);
    return {};
  }
}

/**
 * Loads the persisted overrides row plus the bookkeeping fields the AI Ops
 * panel needs to render "last changed by X at T".
 */
export async function getPromptRegressionConfigRow(): Promise<PromptRegressionConfigRow> {
  await initPromptRegressionConfigTables();
  const result = await pool.query(
    `SELECT * FROM prompt_regression_config_overrides WHERE id = 1`,
  );
  const row = result.rows[0];
  return {
    overrides: rowToOverrides(row),
    updated_by: row?.updated_by ?? null,
    updated_at: row?.updated_at ?? null,
  };
}

/**
 * Persists a new set of overrides and writes an audit row. Pass `null` for
 * any field to clear the override and let the env baseline apply again.
 *
 * The update + audit insert run inside a single transaction so the audit
 * trail can never disagree with the live row.
 */
export async function setPromptRegressionConfigOverrides(input: {
  overrides: { [K in keyof PromptRegressionConfigValues]?: number | null };
  changedBy: string;
  note?: string | null;
}): Promise<{
  before: PromptRegressionConfigOverrides;
  after: PromptRegressionConfigOverrides;
  audit_id: number;
}> {
  await initPromptRegressionConfigTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const beforeResult = await client.query(
      `SELECT * FROM prompt_regression_config_overrides WHERE id = 1 FOR UPDATE`,
    );
    const beforeRow = beforeResult.rows[0];
    const before = rowToOverrides(beforeRow);

    const merged: { [K in keyof PromptRegressionConfigValues]: number | null } =
      {
        dropPctPoints: before.dropPctPoints ?? null,
        minFeedback: before.minFeedback ?? null,
        windowDays: before.windowDays ?? null,
        notifyThrottleMin: before.notifyThrottleMin ?? null,
      };
    for (const field of PROMPT_REGRESSION_CONFIG_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(input.overrides, field)) {
        const v = input.overrides[field];
        merged[field] = v == null ? null : Number(v);
      }
    }

    const cols = PROMPT_REGRESSION_CONFIG_FIELDS.map((f) => FIELD_TO_COLUMN[f]);
    const placeholders = PROMPT_REGRESSION_CONFIG_FIELDS.map(
      (_, i) => `$${i + 1}`,
    );
    const updates = PROMPT_REGRESSION_CONFIG_FIELDS.map(
      (f) => `${FIELD_TO_COLUMN[f]} = EXCLUDED.${FIELD_TO_COLUMN[f]}`,
    );
    const params: any[] = PROMPT_REGRESSION_CONFIG_FIELDS.map(
      (f) => merged[f],
    );
    params.push(input.changedBy);

    await client.query(
      `INSERT INTO prompt_regression_config_overrides
         (id, ${cols.join(", ")}, updated_by, updated_at)
       VALUES (1, ${placeholders.join(", ")}, $${params.length}, NOW())
       ON CONFLICT (id) DO UPDATE SET
         ${updates.join(", ")},
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      params,
    );

    const afterResult = await client.query(
      `SELECT * FROM prompt_regression_config_overrides WHERE id = 1`,
    );
    const after = rowToOverrides(afterResult.rows[0]);

    const auditResult = await client.query(
      `INSERT INTO prompt_regression_config_audit
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
    return {
      before,
      after,
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
 * Returns the most recent N audit rows, newest first.
 */
export async function getPromptRegressionConfigAudit(
  limit: number = 25,
): Promise<PromptRegressionConfigAuditEntry[]> {
  await initPromptRegressionConfigTables();
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const result = await pool.query(
    `SELECT id, changed_at, changed_by, before_values, after_values, note
       FROM prompt_regression_config_audit
       ORDER BY changed_at DESC, id DESC
       LIMIT $1`,
    [safeLimit],
  );
  return result.rows.map((r: any) => ({
    id: r.id,
    changed_at: r.changed_at,
    changed_by: r.changed_by,
    before_values:
      typeof r.before_values === "string"
        ? JSON.parse(r.before_values)
        : (r.before_values ?? {}),
    after_values:
      typeof r.after_values === "string"
        ? JSON.parse(r.after_values)
        : (r.after_values ?? {}),
    note: r.note ?? null,
  }));
}
