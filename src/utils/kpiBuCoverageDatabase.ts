/**
 * BU Coverage tracker — for "BU Coverage Rate" (QM-KPI-008). Each Business Unit
 * has a completion %, a due date, and a status (done / in_progress / postponed /
 * not_started). The KPI value = AVERAGE completion % across the BUs (so a BU that
 * is 35% done counts as 0.35 of a covered BU — matching "Audited BUs ÷ Total BUs"
 * with partial credit). Same value feeds /kpis and the leadership platform.
 */
import { logger } from "./logger";
import {
  pool,
  getKPIByCode,
  getKPIById,
  recordKPIValue,
} from "./kpiDatabase";
import { FRAMEWORK_BUSINESS_UNITS } from "./kpiChecklistDatabase";

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
}

export async function getBuCoverage(kpiId: number): Promise<BuCoverageRow[]> {
  const res = await pool.query(
    `SELECT * FROM kpi_bu_coverage WHERE kpi_id = $1 ORDER BY id ASC`,
    [kpiId],
  );
  return res.rows;
}

export function buCoverageAverage(rows: BuCoverageRow[]): number | null {
  if (!rows.length) return null;
  const sum = rows.reduce((a, r) => a + (Number(r.completion_pct) || 0), 0);
  return Math.round((sum / rows.length) * 10) / 10;
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
    values.push(patch.due_date || null);
    p++;
  }
  if (patch.status !== undefined) {
    fields.push(`status = $${p}`);
    values.push(patch.status);
    p++;
  }
  if (patch.note !== undefined) {
    fields.push(`note = $${p}`);
    values.push(patch.note);
    p++;
  }
  if (fields.length === 0) return null;
  fields.push(`updated_by = $${p}`);
  values.push(updatedBy || null);
  p++;
  fields.push(`updated_at = NOW()`);
  values.push(rowId);
  const res = await pool.query(
    `UPDATE kpi_bu_coverage SET ${fields.join(", ")} WHERE id = $${p} RETURNING *`,
    values,
  );
  return res.rows[0] || null;
}

/** Record the KPI value (avg coverage %) into kpi_values. Null if no BUs seeded. */
export async function recordBuCoverageValue(
  kpiId: number,
): Promise<number | null> {
  const rows = await getBuCoverage(kpiId);
  const avg = buCoverageAverage(rows);
  if (avg === null) return null;
  const kpi = await getKPIById(kpiId);
  if (!kpi) return null;
  const now = new Date();
  await recordKPIValue({
    kpi_id: kpiId,
    period_start: new Date(now.getFullYear(), now.getMonth(), 1),
    period_end: new Date(now.getFullYear(), now.getMonth() + 1, 0),
    actual_value: avg,
    calculated_by: "system_auto",
  });
  return avg;
}

/** Avg coverage % for QM-KPI-008 (used by the leadership feed + auto-calc). */
export async function buCoverageRateForFeed(): Promise<number | null> {
  const kpi = await getKPIByCode("QM-KPI-008");
  if (!kpi || !kpi.id) return null;
  return buCoverageAverage(await getBuCoverage(kpi.id));
}
