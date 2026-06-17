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
import { pool, getKPIById, getKPIByCode, recordKPIValue } from "./kpiDatabase";

export interface KPIChecklistItem {
  id?: number;
  kpi_id: number;
  /** Optional group header (e.g. a Business Unit). Flat checklists leave it blank. */
  section?: string | null;
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
      section VARCHAR(150),
      item_text TEXT NOT NULL,
      is_done BOOLEAN DEFAULT false,
      note TEXT,
      updated_by VARCHAR(150),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(
    `ALTER TABLE kpi_checklist_items ADD COLUMN IF NOT EXISTS section VARCHAR(150)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_kpi_checklist_kpi ON kpi_checklist_items(kpi_id)`,
  );
  logger.info("✅ [KPIChecklist] kpi_checklist_items table ready");

  // Seed the BU Framework Completion KPI (QM-KPI-015) with the Business Units +
  // their standard framework action plan, so it opens ready-to-use. Idempotent.
  await seedBuFrameworkChecklist();
}

/**
 * The Business Units the Quality governance framework is rolled out across
 * (Quality Plan 2026 → BU Coverage Plan). Editable in the UI afterwards.
 */
export const FRAMEWORK_BUSINESS_UNITS = [
  "SDR",
  "Sales",
  "Marketplace",
  "Customer Success",
  "WalaOne",
  "Marketing",
  "HR",
  "Finance",
  "IT",
  "Software",
  "Customer Support",
  "GRC",
  "Quality",
];

/**
 * Standard framework-build action plan applied to every BU — Sarah's actual
 * methodology (generalized from the CS Action Plan, 2026-06-17). 9 phases ending
 * in the trial audit + report.
 */
export const BU_FRAMEWORK_ACTION_PLAN = [
  "One-to-One Meetings (BU Team)",
  "Process Drafting",
  "Process Revision",
  "One-to-One Meetings (Relevant Parties)",
  "Platform Review",
  "Process Releasing",
  "Training on Pilot Phase",
  "Trial Audit",
  "Trial Audit Report",
];

/**
 * Seed QM-KPI-015 (BU Framework Completion) with one section per Business Unit,
 * each carrying the standard action-plan checklist. Only seeds when the KPI has
 * NO checklist items yet (never overwrites edits). KPI value = % of all action
 * items done across all BUs (with equal templates this equals average BU
 * completion); per-BU progress is surfaced in the UI.
 */
export async function seedBuFrameworkChecklist(): Promise<void> {
  const kpi = await getKPIByCode("QM-KPI-015");
  if (!kpi || !kpi.id) return;
  const cur = await pool.query(
    `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE is_done)::int AS done
       FROM kpi_checklist_items WHERE kpi_id = $1`,
    [kpi.id],
  );
  const n = Number(cur.rows[0]?.n || 0);
  const done = Number(cur.rows[0]?.done || 0);

  if (n > 0) {
    // Does the existing checklist already match the current action plan?
    const texts = await pool.query(
      `SELECT DISTINCT item_text FROM kpi_checklist_items WHERE kpi_id = $1`,
      [kpi.id],
    );
    const existing = new Set(texts.rows.map((r: any) => r.item_text));
    const matches =
      existing.size === BU_FRAMEWORK_ACTION_PLAN.length &&
      BU_FRAMEWORK_ACTION_PLAN.every((s) => existing.has(s));
    if (matches) return; // already current
    if (done > 0) return; // someone has started ticking — never disturb their progress
    // Untouched + outdated → rebuild with the current plan.
    await pool.query(`DELETE FROM kpi_checklist_items WHERE kpi_id = $1`, [kpi.id]);
  }

  for (const bu of FRAMEWORK_BUSINESS_UNITS) {
    for (const step of BU_FRAMEWORK_ACTION_PLAN) {
      await pool.query(
        `INSERT INTO kpi_checklist_items (kpi_id, section, item_text, updated_by)
         VALUES ($1, $2, $3, 'system')`,
        [kpi.id, bu, step],
      );
    }
  }
  logger.info(
    `🌱 [KPIChecklist] Seeded BU Framework Completion: ${FRAMEWORK_BUSINESS_UNITS.length} BUs × ${BU_FRAMEWORK_ACTION_PLAN.length} action items`,
  );
}

export async function getChecklistItems(
  kpiId: number,
): Promise<KPIChecklistItem[]> {
  const res = await pool.query(
    `SELECT * FROM kpi_checklist_items WHERE kpi_id = $1
     ORDER BY section NULLS FIRST, id ASC`,
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

export interface ChecklistSection {
  section: string;
  total: number;
  done: number;
  pct: number;
  complete: boolean;
  items: KPIChecklistItem[];
}

/** Group items by section (BU) with per-section progress, in stable order. */
export function groupChecklistBySection(
  items: KPIChecklistItem[],
): ChecklistSection[] {
  const order: string[] = [];
  const map = new Map<string, KPIChecklistItem[]>();
  for (const it of items) {
    const key = (it.section || "").trim();
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(it);
  }
  return order.map((section) => {
    const secItems = map.get(section)!;
    const total = secItems.length;
    const done = secItems.filter((i) => i.is_done).length;
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    return { section, total, done, pct, complete: total > 0 && done === total, items: secItems };
  });
}

export async function addChecklistItem(
  kpiId: number,
  itemText: string,
  updatedBy?: string,
  section?: string,
): Promise<KPIChecklistItem> {
  const res = await pool.query(
    `INSERT INTO kpi_checklist_items (kpi_id, section, item_text, updated_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [kpiId, section?.trim() || null, itemText, updatedBy || null],
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
