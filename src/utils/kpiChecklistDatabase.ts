/**
 * KPI Checklists — for KPIs whose live value can't be auto-computed from process
 * data and instead need a human to confirm a set of completion items (calc_mode
 * = 'checklist'). The KPI's value = (# done ÷ # items) × 100, recorded into
 * kpi_values like any other KPI so it shows on /kpis with a RAG status.
 *
 * Examples: "BU Framework Completion" (build + pilot-audit checkpoints per BU),
 * "Certification Milestones On-Track", "QMS Adoption Rate".
 */
import { logger } from "./logger";
import { pool, getKPIById, recordKPIValue } from "./kpiDatabase";

export interface KPIChecklistItem {
  id?: number;
  kpi_id: number;
  item_text: string;
  is_done: boolean;
  note?: string | null;
  updated_by?: string | null;
  created_at?: Date;
  updated_at?: Date;
}

export async function initKPIChecklistTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kpi_checklist_items (
      id SERIAL PRIMARY KEY,
      kpi_id INTEGER NOT NULL REFERENCES kpi_definitions(id) ON DELETE CASCADE,
      item_text TEXT NOT NULL,
      is_done BOOLEAN DEFAULT false,
      note TEXT,
      updated_by VARCHAR(150),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_kpi_checklist_kpi ON kpi_checklist_items(kpi_id)`,
  );
  logger.info("✅ [KPIChecklist] kpi_checklist_items table ready");
}

export async function getChecklistItems(
  kpiId: number,
): Promise<KPIChecklistItem[]> {
  const res = await pool.query(
    `SELECT * FROM kpi_checklist_items WHERE kpi_id = $1 ORDER BY id ASC`,
    [kpiId],
  );
  return res.rows;
}

export function checklistProgress(items: KPIChecklistItem[]): {
  total: number;
  done: number;
  pct: number;
} {
  const total = items.length;
  const done = items.filter((i) => i.is_done).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { total, done, pct };
}

export async function addChecklistItem(
  kpiId: number,
  itemText: string,
  updatedBy?: string,
): Promise<KPIChecklistItem> {
  const res = await pool.query(
    `INSERT INTO kpi_checklist_items (kpi_id, item_text, updated_by)
     VALUES ($1, $2, $3) RETURNING *`,
    [kpiId, itemText, updatedBy || null],
  );
  return res.rows[0];
}

export async function updateChecklistItem(
  itemId: number,
  patch: { item_text?: string; is_done?: boolean; note?: string },
  updatedBy?: string,
): Promise<KPIChecklistItem | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let p = 1;
  for (const key of ["item_text", "is_done", "note"] as const) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = $${p}`);
      values.push(patch[key]);
      p++;
    }
  }
  if (fields.length === 0) return null;
  fields.push(`updated_by = $${p}`);
  values.push(updatedBy || null);
  p++;
  fields.push(`updated_at = NOW()`);
  values.push(itemId);
  const res = await pool.query(
    `UPDATE kpi_checklist_items SET ${fields.join(", ")} WHERE id = $${p} RETURNING *`,
    values,
  );
  return res.rows[0] || null;
}

export async function deleteChecklistItem(itemId: number): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM kpi_checklist_items WHERE id = $1`,
    [itemId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Recompute a checklist-mode KPI's value (= % of items done) and record it into
 * kpi_values for the current period. No-op if the KPI has no checklist items
 * yet (so it stays "--" rather than showing a fake 0%). Returns the % or null.
 */
export async function recordChecklistKPIValue(
  kpiId: number,
): Promise<number | null> {
  const items = await getChecklistItems(kpiId);
  if (items.length === 0) return null;
  const { pct } = checklistProgress(items);
  const kpi = await getKPIById(kpiId);
  if (!kpi) return null;
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  await recordKPIValue({
    kpi_id: kpiId,
    period_start: periodStart,
    period_end: periodEnd,
    actual_value: pct,
    calculated_by: "system_auto",
  });
  return pct;
}
