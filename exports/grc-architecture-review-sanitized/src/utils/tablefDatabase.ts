// ──────────────────────────────────────────────────────────────────────────────
// TableF persistence layer (Task #746)
//
// All INSERT/UPDATE statements that previously lived inline in
// `src/mastra/routes/tablefRoutes.ts` and `src/mastra/routes/tablefApiRoutes.ts`
// now live here. The route files keep their CREATE TABLE / SELECT logic and
// delegate every write to the functions below. This consolidation lets the
// secret-leak coverage gate (scripts/check-db-test-coverage.sh) stop tracking
// the route files as writers.
//
// The companion secret-leak test for these write paths is the existing
// `src/mastra/routes/tablefRoutes.test.ts` (mapped via COMPANION_TESTS in
// scripts/check-db-test-coverage.sh). It patches `pg.Pool.prototype.query`
// globally, so calls issued by this module's pool are still captured.
// ──────────────────────────────────────────────────────────────────────────────

import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function seedTablefDepartment(
  departmentId: string,
  name: string,
  description: string,
): Promise<void> {
  await pool.query(
    "INSERT INTO tablef_departments (department_id, name, description, active) VALUES ($1,$2,$3,true) ON CONFLICT (department_id) DO NOTHING",
    [departmentId, name, description],
  );
}

export interface TablefKpiInput {
  kpi_id?: string;
  department_id?: string;
  name?: string;
  description?: string;
  category?: string;
  unit?: string;
  target_annual?: number | string | null;
  target_monthly?: number | string | null;
  weight?: number | string | null;
  owner_email?: string;
  data_source?: string;
  calculation_definition?: string;
}

export async function updateTablefKpi(<REDACTED_SCHEME> TablefKpiInput): Promise<any> {
  const result = await pool.query(
    `UPDATE tablef_kpis SET
       department_id = $1, name = $2, description = $3, category = $4,
       unit = $5, target_annual = $6, target_monthly = $7, weight = $8,
       owner_email = $9, data_source = $10, calculation_definition = $11,
       updated_at = CURRENT_TIMESTAMP
     WHERE kpi_id = $12 RETURNING *`,
    [
      data.department_id,
      data.name,
      data.description,
      data.category,
      data.unit,
      data.target_annual,
      data.target_monthly,
      data.weight,
      data.owner_email,
      data.data_source,
      data.calculation_definition,
      data.kpi_id,
    ],
  );
  return result.rows[0];
}

export async function insertTablefKpi(
  kpiId: string,
  <REDACTED_SCHEME> TablefKpiInput,
): Promise<any> {
  const result = await pool.query(
    `INSERT INTO tablef_kpis
       (kpi_id, department_id, name, description, category, unit, target_annual,
        target_monthly, weight, owner_email, data_source, calculation_definition)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      kpiId,
      data.department_id,
      data.name,
      data.description,
      data.category,
      data.unit,
      data.target_annual,
      data.target_monthly,
      data.weight,
      data.owner_email,
      data.data_source,
      data.calculation_definition,
    ],
  );
  return result.rows[0];
}

export async function archiveTablefKpi(kpiId: string): Promise<void> {
  await pool.query(
    "UPDATE tablef_kpis SET enabled = false, updated_at = CURRENT_TIMESTAMP WHERE kpi_id = $1",
    [kpiId],
  );
}

export interface TablefPerformanceUpdate {
  kpi_id: string;
  period_month: string;
  target: number | string;
  achieved: number | string;
  variance: number;
  variance_percent: number;
  status: string;
  trend: string;
  comment?: string;
  evidence_link?: string;
}

export async function updateTablefPerformance(
  <REDACTED_SCHEME> TablefPerformanceUpdate,
): Promise<void> {
  await pool.query(
    `UPDATE tablef_performance SET
       target = $1, achieved = $2, variance = $3, variance_percent = $4,
       status = $5, trend = $6, comment = $7, evidence_link = $8,
       updated_at = CURRENT_TIMESTAMP
     WHERE kpi_id = $9 AND period_month = $10`,
    [
      data.target,
      data.achieved,
      data.variance,
      data.variance_percent,
      data.status,
      data.trend,
      data.comment,
      data.evidence_link,
      data.kpi_id,
      data.period_month,
    ],
  );
}

export interface TablefPerformanceInsert extends TablefPerformanceUpdate {
  department_id?: string;
}

export async function insertTablefPerformance(
  <REDACTED_SCHEME> TablefPerformanceInsert,
): Promise<void> {
  await pool.query(
    `INSERT INTO tablef_performance
       (kpi_id, department_id, period_month, target, achieved, variance,
        variance_percent, status, trend, comment, evidence_link)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      data.kpi_id,
      data.department_id,
      data.period_month,
      data.target,
      data.achieved,
      data.variance,
      data.variance_percent,
      data.status,
      data.trend,
      data.comment,
      data.evidence_link,
    ],
  );
}

export interface TablefSnapshotUpsert {
  department_id: string;
  period: string;
  total_kpis: number;
  kpis_met: number;
  kpis_improving: number;
  kpis_not_met: number;
  percent_met: number;
  percent_met_or_improving: number;
  copc_status: string;
  ai_risk_level: string;
}

export async function upsertTablefSnapshot(
  <REDACTED_SCHEME> TablefSnapshotUpsert,
): Promise<void> {
  await pool.query(
    `INSERT INTO tablef_snapshots
       (department_id, period, total_kpis, kpis_met, kpis_improving, kpis_not_met,
        percent_met, percent_met_or_improving, copc_status, ai_risk_level)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (department_id, period)
     DO UPDATE SET
       total_kpis = $3, kpis_met = $4, kpis_improving = $5, kpis_not_met = $6,
       percent_met = $7, percent_met_or_improving = $8, copc_status = $9,
       ai_risk_level = $10, calculated_at = CURRENT_TIMESTAMP`,
    [
      data.department_id,
      data.period,
      data.total_kpis,
      data.kpis_met,
      data.kpis_improving,
      data.kpis_not_met,
      data.percent_met,
      data.percent_met_or_improving,
      data.copc_status,
      data.ai_risk_level,
    ],
  );
}

export interface TablefUserUpdate {
  user_id: string;
  name?: string;
  email?: string;
  role?: string;
  departments?: string[];
  active?: boolean;
}

export async function updateTablefUser(<REDACTED_SCHEME> TablefUserUpdate): Promise<void> {
  await pool.query(
    `UPDATE tablef_users SET
       name = $1, email = $2, role = $3, departments = $4,
       active = $5, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = $6`,
    [
      data.name,
      data.email,
      data.role,
      data.departments,
      data.active,
      data.user_id,
    ],
  );
}

export interface TablefUserInsert {
  user_id: string;
  name?: string;
  email?: string;
  role?: string;
  departments?: string[];
}

export async function insertTablefUser(<REDACTED_SCHEME> TablefUserInsert): Promise<void> {
  await pool.query(
    `INSERT INTO tablef_users (user_id, name, email, role, departments)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      data.user_id,
      data.name,
      data.email,
      data.role,
      data.departments || [],
    ],
  );
}
