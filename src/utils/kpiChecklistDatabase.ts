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
import { redactSensitiveDeep } from "./eventLogsDatabase";

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
  // Pre-fill the agreed FY2026 baseline (Sales/SDR done, Marketplace ~35%) on
  // still-untouched phases, so BU Coverage (which is derived from this checklist)
  // reads correctly out of the box. Idempotent + never overrides a human tick.
  await backfillInitialFrameworkProgress();
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
    [
      kpiId,
      redactSensitiveDeep(section?.trim() || null, "section"),
      redactSensitiveDeep(itemText, "item_text"),
      redactSensitiveDeep(updatedBy || null, "updated_by"),
    ],
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
      values.push(redactSensitiveDeep(patch[key], key));
      p++;
    }
  }
  if (fields.length === 0) return null;
  fields.push(`updated_by = $${p}`);
  values.push(redactSensitiveDeep(updatedBy || null, "updated_by"));
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
/**
 * Framework completion for the BUs IN SCOPE THIS QUARTER only — i.e. BUs marked
 * 'in_progress' or 'postponed' in the BU Coverage tracker (e.g. Q2 = Marketplace
 * + Customer Success). value = phases done ÷ total phases across just those BUs,
 * NOT all 13 (which would be dragged to ~22% by the not-started BUs). Returns null
 * if no BU is in scope, so the KPI reads unavailable rather than a misleading 0.
 * Scope is controlled by editing BU statuses in the Manage BU Coverage modal.
 */
export async function frameworkInScopeProgress(): Promise<{
  done: number;
  total: number;
  pct: number;
} | null> {
  const fw = await getKPIByCode("QM-KPI-015");
  const bu = await getKPIByCode("QM-KPI-008");
  if (!fw?.id || !bu?.id) return null;
  const res = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE is_done)::int AS done
       FROM kpi_checklist_items
      WHERE kpi_id = $1
        AND section IN (
          SELECT bu_name FROM kpi_bu_coverage
           WHERE kpi_id = $2
             AND (
               status IN ('in_progress','postponed')
               -- a BU COMPLETED this quarter still counts (don't let finishing it
               -- drop the BU out of the denominator); BUs done in a prior period
               -- (no current-quarter due date, e.g. Sales/SDR 2025) stay excluded.
               OR (status = 'done'
                   AND due_date >= date_trunc('quarter', NOW())::date
                   AND due_date <  (date_trunc('quarter', NOW()) + interval '3 months')::date)
             )
        )`,
    [fw.id, bu.id],
  );
  const total = Number(res.rows[0]?.total || 0);
  const done = Number(res.rows[0]?.done || 0);
  if (total <= 0) return null;
  return { done, total, pct: Math.round((done / total) * 1000) / 10 };
}

export async function recordChecklistKPIValue(
  kpiId: number,
): Promise<number | null> {
  const kpi = await getKPIById(kpiId);
  if (!kpi) return null;
  let pct: number | null;
  if (kpi.kpi_code === "QM-KPI-015") {
    // Framework Completion counts only the BUs in scope THIS quarter.
    const ip = await frameworkInScopeProgress();
    pct = ip ? ip.pct : null;
  } else {
    const items = await getChecklistItems(kpiId);
    if (items.length === 0) return null;
    pct = checklistProgress(items).pct;
  }
  if (pct === null) return null;
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

/**
 * Per-BU framework progress from the QM-KPI-015 checklist: BU name → {done,total,pct}.
 * This is the single source of truth that BU Coverage (QM-KPI-008) is derived from.
 */
export async function getFrameworkProgressByBU(): Promise<
  Record<string, { done: number; total: number; pct: number }>
> {
  const out: Record<string, { done: number; total: number; pct: number }> = {};
  const kpi = await getKPIByCode("QM-KPI-015");
  if (!kpi || !kpi.id) return out;
  const items = await getChecklistItems(kpi.id);
  for (const sec of groupChecklistBySection(items)) {
    const name = (sec.section || "").trim();
    if (!name) continue;
    out[name] = { done: sec.done, total: sec.total, pct: sec.pct };
  }
  return out;
}

/**
 * One-time pre-fill of the agreed FY2026 baseline on the Framework checklist:
 * Sales & SDR were completed in 2025 (all 9 phases done); Marketplace is postponed
 * at ~35% (first 3 of 9 phases). Customer Success and every other BU are driven by
 * live ticks. Only touches UNTOUCHED system-seeded phases (never overrides a human
 * tick), and skips any BU that already has a phase done — so it's idempotent and
 * safe to run on every boot.
 */
export async function backfillInitialFrameworkProgress(): Promise<void> {
  const kpi = await getKPIByCode("QM-KPI-015");
  if (!kpi || !kpi.id) return;
  const markAll = ["Sales", "SDR"];
  const markFirst: Record<string, number> = { Marketplace: 3 };

  const alreadyStarted = async (bu: string): Promise<boolean> => {
    const r = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE is_done)::int AS done
         FROM kpi_checklist_items WHERE kpi_id = $1 AND section = $2`,
      [kpi.id, bu],
    );
    return Number(r.rows[0]?.done || 0) > 0;
  };

  let changed = false;
  for (const bu of markAll) {
    if (await alreadyStarted(bu)) continue;
    const r = await pool.query(
      `UPDATE kpi_checklist_items SET is_done = true, updated_at = NOW()
        WHERE kpi_id = $1 AND section = $2
          AND (updated_by IS NULL OR updated_by = 'system')`,
      [kpi.id, bu],
    );
    if ((r.rowCount ?? 0) > 0) changed = true;
  }
  for (const [bu, n] of Object.entries(markFirst)) {
    if (await alreadyStarted(bu)) continue;
    const r = await pool.query(
      `UPDATE kpi_checklist_items SET is_done = true, updated_at = NOW()
        WHERE id IN (
          SELECT id FROM kpi_checklist_items
           WHERE kpi_id = $1 AND section = $2
             AND (updated_by IS NULL OR updated_by = 'system')
           ORDER BY id ASC LIMIT $3
        )`,
      [kpi.id, bu, n],
    );
    if ((r.rowCount ?? 0) > 0) changed = true;
  }
  if (changed) {
    try {
      await recordChecklistKPIValue(kpi.id);
    } catch {
      /* recorded on the next recalc otherwise */
    }
    logger.info(
      "🌱 [KPIChecklist] Backfilled FY2026 framework baseline (Sales/SDR=100%, Marketplace~33%)",
    );
  }
}
