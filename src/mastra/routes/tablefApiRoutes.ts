import type { UserRole } from "../../utils/rbacDatabase";
import { requireRole, forbiddenResponse } from "../../utils/rbacMiddleware";

import { logger } from "../../utils/logger";
const TABLEF_READ_ROLES: UserRole[] = [
  "admin",
  "head_of_operations_quality",
  "quality_manager",
  "grc_manager",
  "executive",
  "bu_owner",
];
const TABLEF_WRITE_ROLES: UserRole[] = [
  "admin",
  "head_of_operations_quality",
  "quality_manager",
  "grc_manager",
];

function tablefGate<
  T extends { path: string; method: string; createHandler: (deps: any) => any },
>(route: T): T {
  const roles: UserRole[] = ["POST", "PUT", "DELETE"].includes(route.method)
    ? TABLEF_WRITE_ROLES
    : TABLEF_READ_ROLES;
  const originalCreate = route.createHandler;
  return {
    ...route,
    createHandler: async (deps: any) => {
      const inner = await originalCreate(deps);
      return async (c: any) => {
        const user = await requireRole(c, roles);
        if (!user)
          return forbiddenResponse(
            c,
            "Insufficient permissions for TableF data",
          );
        return inner(c);
      };
    },
  };
}

export const tablefApiRoutes = [
  {
    path: "/api/tablef/departments",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { Pool } = await import("pg");
          const pool = new Pool({ connectionString: process.env.DATABASE_URL });
          const result = await pool.query(
            "SELECT * FROM tablef_departments WHERE active = true ORDER BY name",
          );
          await pool.end();
          return c.json({ departments: result.rows });
        } catch (error) {
          logger.error("Error fetching departments:", error);
          return c.json(
            { error: "Failed to fetch departments", departments: [] },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/tablef/kpis",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { Pool } = await import("pg");
          const pool = new Pool({ connectionString: process.env.DATABASE_URL });
          const deptId = c.req.query("department_id");
          let query = "SELECT * FROM tablef_kpis WHERE enabled = true";
          const params: string[] = [];
          if (deptId) {
            query += " AND department_id = $1";
            params.push(deptId);
          }
          query += " ORDER BY department_id, name";
          const result = await pool.query(query, params);
          await pool.end();
          return c.json({ kpis: result.rows });
        } catch (error) {
          logger.error("Error fetching KPIs:", error);
          return c.json({ error: "Failed to fetch KPIs", kpis: [] }, 500);
        }
      };
    },
  },
  {
    path: "/api/tablef/kpis",
    method: "POST",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { Pool } = await import("pg");
          const pool = new Pool({ connectionString: process.env.DATABASE_URL });
          const data = await c.req.json();
          let result;
          if (data.kpi_id) {
            result = await pool.query(
              `UPDATE tablef_kpis SET department_id=$1,name=$2,description=$3,category=$4,unit=$5,target_annual=$6,target_monthly=$7,weight=$8,owner_email=$9,data_source=$10,calculation_definition=$11,updated_at=CURRENT_TIMESTAMP WHERE kpi_id=$12 RETURNING *`,
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
          } else {
            const kpiId = `KPI-${Date.now()}`;
            result = await pool.query(
              `INSERT INTO tablef_kpis (kpi_id,department_id,name,description,category,unit,target_annual,target_monthly,weight,owner_email,data_source,calculation_definition) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
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
          }
          await pool.end();
          return c.json({ success: true, kpi: result.rows[0] });
        } catch (error) {
          logger.error("Error saving KPI:", error);
          return c.json({ error: "Failed to save KPI" }, 500);
        }
      };
    },
  },
  {
    path: "/api/tablef/performance",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { Pool } = await import("pg");
          const pool = new Pool({ connectionString: process.env.DATABASE_URL });
          const result = await pool.query(
            "SELECT * FROM tablef_performance ORDER BY period_month DESC",
          );
          await pool.end();
          return c.json({ performance: result.rows });
        } catch (error) {
          logger.error("Error fetching performance:", error);
          return c.json(
            { error: "Failed to fetch performance", performance: [] },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/tablef/performance",
    method: "POST",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { Pool } = await import("pg");
          const pool = new Pool({ connectionString: process.env.DATABASE_URL });
          const data = await c.req.json();
          const variance = data.achieved - data.target;
          const variancePercent =
            data.target !== 0
              ? ((data.achieved - data.target) / data.target) * 100
              : 0;
          let status = "NOT_MET";
          if (data.achieved >= data.target) status = "MET";
          else if (data.achieved >= data.target * 0.9) status = "IMPROVING";
          const existingResult = await pool.query(
            "SELECT * FROM tablef_performance WHERE kpi_id=$1 AND period_month=$2",
            [data.kpi_id, data.period_month],
          );
          const prevResult = await pool.query(
            `SELECT achieved FROM tablef_performance WHERE kpi_id=$1 AND period_month<$2 ORDER BY period_month DESC LIMIT 1`,
            [data.kpi_id, data.period_month],
          );
          let trend = "FLAT";
          if (prevResult.rows.length > 0) {
            const prevAchieved = parseFloat(prevResult.rows[0].achieved);
            if (data.achieved > prevAchieved) trend = "UP";
            else if (data.achieved < prevAchieved) trend = "DOWN";
          }
          if (existingResult.rows.length > 0) {
            await pool.query(
              `UPDATE tablef_performance SET target=$1,achieved=$2,variance=$3,variance_percent=$4,status=$5,trend=$6,comment=$7,evidence_link=$8,updated_at=CURRENT_TIMESTAMP WHERE kpi_id=$9 AND period_month=$10`,
              [
                data.target,
                data.achieved,
                variance,
                variancePercent,
                status,
                trend,
                data.comment,
                data.evidence_link,
                data.kpi_id,
                data.period_month,
              ],
            );
          } else {
            await pool.query(
              `INSERT INTO tablef_performance (kpi_id,department_id,period_month,target,achieved,variance,variance_percent,status,trend,comment,evidence_link) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
              [
                data.kpi_id,
                data.department_id,
                data.period_month,
                data.target,
                data.achieved,
                variance,
                variancePercent,
                status,
                trend,
                data.comment,
                data.evidence_link,
              ],
            );
          }
          await pool.end();
          return c.json({
            success: true,
            status,
            trend,
            variance,
            variancePercent,
          });
        } catch (error) {
          logger.error("Error saving performance:", error);
          return c.json({ error: "Failed to save performance" }, 500);
        }
      };
    },
  },
  {
    path: "/api/tablef/users",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { Pool } = await import("pg");
          const pool = new Pool({ connectionString: process.env.DATABASE_URL });
          const result = await pool.query(
            "SELECT * FROM tablef_users ORDER BY name",
          );
          await pool.end();
          return c.json({ users: result.rows });
        } catch (error) {
          logger.error("Error fetching users:", error);
          return c.json({ error: "Failed to fetch users", users: [] }, 500);
        }
      };
    },
  },
].map(tablefGate);
