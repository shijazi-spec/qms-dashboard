import pg from 'pg';
const { Pool } = pg;
import { redactSensitiveDeep } from './eventLogsDatabase';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Convert a redacted value into the TEXT representation persisted in the
 * `nc_change_history.old_value` / `new_value` columns. Strings pass through
 * verbatim (so the existing `'open' -> 'closed'` audit trail keeps reading
 * naturally), objects are JSON-serialised so a deep scrub is preserved as
 * inspectable JSON rather than collapsing to `[object Object]`, and
 * null/undefined become a real SQL NULL.
 */
function toStorageString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export interface ChangeHistoryEntry {
  id?: number;
  record_type: 'nc' | 'capa';
  record_id: number;
  field_changed: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string;
  change_reason?: string;
  created_at?: Date;
}

export async function initChangeHistoryTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nc_change_history (
      id SERIAL PRIMARY KEY,
      record_id INTEGER NOT NULL,
      field_changed VARCHAR(100) NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by VARCHAR(255) NOT NULL,
      change_reason TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_nc_history_record ON nc_change_history(record_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS capa_change_history (
      id SERIAL PRIMARY KEY,
      record_id INTEGER NOT NULL,
      field_changed VARCHAR(100) NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by VARCHAR(255) NOT NULL,
      change_reason TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_capa_history_record ON capa_change_history(record_id)`);
}

export async function logNCChange(recordId: number, fieldChanged: string, oldValue: any, newValue: any, changedBy: string, reason?: string): Promise<void> {
  // SECURITY (Task #257 follow-up to #117):
  // `redactSensitiveDeep` applies BOTH defenses in a single pass —
  //   1. key-based deny list (catches values under names like password_hash,
  //      api_key, …, plus the whole-value redaction when fieldChanged itself
  //      is a sensitive column name), AND
  //   2. recursive regex scrub of every string leaf (catches credential-shaped
  //      substrings — `ghp_…`, `sk-…`, JWTs, bcrypt, AWS keys — interpolated
  //      into innocuous nested fields like `notes` or `description`).
  // The previous `redactSecretLikeStrings(redactSensitiveFields(...))` chain
  // ran the regex pass only at the top level, so nested string leaves inside
  // an object payload were blind to the regex deny list.
  const safeOld = redactSensitiveDeep(oldValue, fieldChanged);
  const safeNew = redactSensitiveDeep(newValue, fieldChanged);
  const safeReason = reason != null ? (redactSensitiveDeep(reason) as string) : null;
  await pool.query(
    `INSERT INTO nc_change_history (record_id, field_changed, old_value, new_value, changed_by, change_reason) VALUES ($1, $2, $3, $4, $5, $6)`,
    [recordId, fieldChanged, toStorageString(safeOld), toStorageString(safeNew), changedBy, safeReason]
  );
}

export async function logCAPAChange(recordId: number, fieldChanged: string, oldValue: any, newValue: any, changedBy: string, reason?: string): Promise<void> {
  // See logNCChange — same dual-defense rationale (Task #257).
  const safeOld = redactSensitiveDeep(oldValue, fieldChanged);
  const safeNew = redactSensitiveDeep(newValue, fieldChanged);
  const safeReason = reason != null ? (redactSensitiveDeep(reason) as string) : null;
  await pool.query(
    `INSERT INTO capa_change_history (record_id, field_changed, old_value, new_value, changed_by, change_reason) VALUES ($1, $2, $3, $4, $5, $6)`,
    [recordId, fieldChanged, toStorageString(safeOld), toStorageString(safeNew), changedBy, safeReason]
  );
}

export async function getNCChangeHistory(recordId: number): Promise<ChangeHistoryEntry[]> {
  const result = await pool.query(
    `SELECT * FROM nc_change_history WHERE record_id = $1 ORDER BY created_at DESC`,
    [recordId]
  );
  return result.rows.map((r: any) => ({ ...r, record_type: 'nc' as const }));
}

export async function getCAPAChangeHistory(recordId: number): Promise<ChangeHistoryEntry[]> {
  const result = await pool.query(
    `SELECT * FROM capa_change_history WHERE record_id = $1 ORDER BY created_at DESC`,
    [recordId]
  );
  return result.rows.map((r: any) => ({ ...r, record_type: 'capa' as const }));
}
