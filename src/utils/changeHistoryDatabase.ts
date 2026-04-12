import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

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
  await pool.query(
    `INSERT INTO nc_change_history (record_id, field_changed, old_value, new_value, changed_by, change_reason) VALUES ($1, $2, $3, $4, $5, $6)`,
    [recordId, fieldChanged, oldValue != null ? String(oldValue) : null, newValue != null ? String(newValue) : null, changedBy, reason || null]
  );
}

export async function logCAPAChange(recordId: number, fieldChanged: string, oldValue: any, newValue: any, changedBy: string, reason?: string): Promise<void> {
  await pool.query(
    `INSERT INTO capa_change_history (record_id, field_changed, old_value, new_value, changed_by, change_reason) VALUES ($1, $2, $3, $4, $5, $6)`,
    [recordId, fieldChanged, oldValue != null ? String(oldValue) : null, newValue != null ? String(newValue) : null, changedBy, reason || null]
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
