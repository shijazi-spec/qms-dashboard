/**
 * BU Coverage tracker — for "BU Coverage Rate" (QM-KPI-008). Each Business Unit
 * has a completion %, a due date, and a status (done / in_progress / postponed /
 * not_started). The KPI value = AVERAGE completion % across the BUs (so a BU that
 * is 35% done counts as 0.35 of a covered BU — matching "Audited BUs ÷ Total BUs"
 * with partial credit). Same value feeds /kpis and the leadership platform.
 */
import { logger } from "./logger";
import { redactSensitiveDeep } from "./eventLogsDatabase";
import {
  pool,
  getKPIByCode,
  getKPIById,
  recordKPIValue,
} from "./kpiDatabase";
import {
  FRAMEWORK_BUSINESS_UNITS,
  getFrameworkProgressByBU,
} from "./kpiChecklistDatabase";

export type BuCoverageStatus =
  | "not_started"
  | "in_progress"
  | "postponed"
  | "done";

export interface BuCoverageRow {
  id?: number;
  kpi_id: number;
  bu_name: string;
  completion_pct: number;
  due_date?: string | null; // YYYY-MM-DD
  status: BuCoverageStatus;
  note?: string | null;
  updated_by?: string | null;
  updated_at?: Date;
}

export async function initKpiBuCoverageTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kpi_bu_coverage (
      id SERIAL PRIMARY KEY,
      kpi_id INTEGER NOT NULL REFERENCES kpi_definitions(id) ON DELETE CASCADE,
      bu_name VARCHAR(150) NOT NULL,
      completion_pct INTEGER NOT NULL DEFAULT 0,
      due_date DATE,
      status VARCHAR(20) NOT NULL DEFAULT 'not_started',
      note TEXT,
      updated_by VARCHAR(150),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (kpi_id, bu_name)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_kpi_bu_coverage_kpi ON kpi_bu_coverage(kpi_id)`,
  );
  logger.info("✅ [KPIBuCoverage] kpi_bu_coverage table ready");
  await seedBuCoverage();
}

/**
 * Initial FY2026 coverage Sample User (2026-06-17). Applied ONLY to still-untouched
 * rows (not yet edited) so it pre-fills the tracker without ever overwriting later
 * manual edits. SDR & Sales were onboarded in 2025 → carried in at 100%.
 */
const INITIAL_BU_COVERAGE: Array<{
  bu: string;
  pct: number;
  status: BuCoverageStatus;
  due?: string;
}> = [
  { bu: "Sales", pct: 100, status: "done" },
  { bu: "SDR", pct: 100, status: "done" },
  { bu: "Marketplace", pct: 35, status: "postponed" },
  { bu: "Customer Success", pct: 0, status: "in_progress", due: "2026-06-30" },
];

/** Seed the canonical BUs for QM-KPI-008 (idempotent; never overwrites entered values). */
export async function seedBuCoverage(): Promise<void> {
  const kpi = await getKPIByCode("QM-KPI-008");
  if (!kpi || !kpi.id) return;
  for (const bu of FRAMEWORK_BUSINESS_UNITS) {
    await pool.query(
      `INSERT INTO kpi_bu_coverage (kpi_id, bu_name)
       VALUES ($1, $2) ON CONFLICT (kpi_id, bu_name) DO NOTHING`,
      [kpi.id, bu],
    );
  }
  // Pre-fill the agreed starting values on UNTOUCHED rows only (updated_by IS NULL
  // and still at the default), so it's ready for the meeting but safe to edit.
  for (const init of INITIAL_BU_COVERAGE) {
    await pool.query(
      `UPDATE kpi_bu_coverage
          SET completion_pct = $3, status = $4, due_date = $5
        WHERE kpi_id = $1 AND bu_name = $2
          AND updated_by IS NULL AND completion_pct = 0 AND status = 'not_started'`,
      [kpi.id, init.bu, init.pct, init.status, init.due ?? null],
    );
  }
  // Each BU's % is DERIVED from its Framework checklist (QM-KPI-015) — the single
  // source of truth — then the rolled-up value is recorded so QM-KPI-008 shows a
  // number immediately. (INITIAL_BU_COVERAGE above still seeds status/due dates.)
  try {
    await syncBuCoverageFromChecklist();
  } catch {
    /* fall back to recorded-on-next-recalc */
  }
}

export async function getBuCoverage(kpiId: number): Promise<BuCoverageRow[]> {
  const res = await pool.query(
    `SELECT * FROM kpi_bu_coverage WHERE kpi_id = $1 ORDER BY id ASC`,
    [kpiId],
  );
  return res.rows;
}

/** BUs counted in the headline: anything actually in this period's plan (not 'not_started'). */
export function buCoverageInScope(rows: BuCoverageRow[]): BuCoverageRow[] {
  return rows.filter((r) => r.status !== "not_started");
}

/**
 * KPI value = average completion % across the IN-SCOPE BUs (status != 'not_started').
 * Not-started BUs are future-period scope and are excluded, so the headline reflects
 * the BUs actually being onboarded this period — otherwise a handful of untouched BUs
 * drag a Sales/SDR-100% picture down to ~18%. Falls back to all rows if none in scope.
 */
export function buCoverageAverage(rows: BuCoverageRow[]): number | null {
  if (!rows.length) return null;
  const scoped = buCoverageInScope(rows);
  const used = scoped.length ? scoped : rows;
  const sum = used.reduce((a, r) => a + (Number(r.completion_pct) || 0), 0);
  return Math.round((sum / used.length) * 10) / 10;
}

export async function updateBuCoverage(
  rowId: number,
  patch: {
    completion_pct?: number;
    due_date?: string | null;
    status?: BuCoverageStatus;
    note?: string;
  },
  updatedBy?: string,
): Promise<BuCoverageRow | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let p = 1;
  if (patch.completion_pct !== undefined) {
    fields.push(`completion_pct = $${p}`);
    values.push(Math.max(0, Math.min(100, Math.round(Number(patch.completion_pct)))));
    p++;
  }
  if (patch.due_date !== undefined) {
    fields.push(`due_date = $${p}`);
    values.push(redactSensitiveDeep(patch.due_date || null, "due_date"));
    p++;
  }
  if (patch.status !== undefined) {
    fields.push(`status = $${p}`);
    values.push(redactSensitiveDeep(patch.status, "status"));
    p++;
  }
  if (patch.note !== undefined) {
    fields.push(`note = $${p}`);
    values.push(redactSensitiveDeep(patch.note, "note"));
    p++;
  }
  if (fields.length === 0) return null;
  fields.push(`updated_by = $${p}`);
  values.push(redactSensitiveDeep(updatedBy || null, "updated_by"));
  p++;
  fields.push(`updated_at = NOW()`);
  values.push(rowId);
  const res = await pool.query(
    `UPDATE kpi_bu_coverage SET ${fields.join(", ")} WHERE id = $${p} RETURNING *`,
    values,
  );
  return res.rows[0] || null;
}

/**
 * Record the BU Coverage KPI value = BUs PUBLISHED *and* AUDITED ÷ commercial 8
 * (binary, matches the Leadership Platform — stricter than Framework Completion).
 * The per-BU completion_pct in the tracker still reflects checklist progress (for
 * the modal), but the headline KPI is the milestone-based governed rate.
 */
export async function recordBuCoverageValue(
  kpiId: number,
): Promise<number | null> {
  const { buGovernedRate } = await import("./kpiChecklistDatabase");
  const r = await buGovernedRate();
  if (!r) return null;
  const kpi = await getKPIById(kpiId);
  if (!kpi) return null;
  const now = new Date();
  await recordKPIValue({
    kpi_id: kpiId,
    period_start: new Date(now.getFullYear(), now.getMonth(), 1),
    period_end: new Date(now.getFullYear(), now.getMonth() + 1, 0),
    actual_value: r.value,
    calculated_by: "system_auto",
  });
  return r.value;
}

/**
 * Derive each BU's coverage % from its Framework checklist (QM-KPI-015) — the
 * single source of truth — then re-record QM-KPI-008. completion_pct = phases
 * done ÷ phases × 100; status / due date / notes are left as manually set (e.g.
 * Marketplace stays 'postponed'). Called at boot, on every checklist tick, and on
 * recalc, so the coverage number always tracks the checklist with no double entry.
 * BUs without a checklist section keep their existing value.
 */
export async function syncBuCoverageFromChecklist(): Promise<number | null> {
  const kpi = await getKPIByCode("QM-KPI-008");
  if (!kpi || !kpi.id) return null;
  const progress = await getFrameworkProgressByBU();
  for (const [bu, p] of Object.entries(progress)) {
    if (!bu) continue;
    await pool.query(
      `UPDATE kpi_bu_coverage SET completion_pct = $3, updated_at = NOW()
        WHERE kpi_id = $1 AND bu_name = $2`,
      [kpi.id, bu, p.pct],
    );
  }
  return recordBuCoverageValue(kpi.id);
}

/** BU Coverage value (published+audited ÷ 8) for the leadership feed + auto-calc. */
export async function buCoverageRateForFeed(): Promise<number | null> {
  const { buGovernedRate } = await import("./kpiChecklistDatabase");
  const r = await buGovernedRate();
  return r ? r.value : null;
}
