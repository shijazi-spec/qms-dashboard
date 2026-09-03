import type { UserRole } from "../../utils/rbacDatabase";
import { requireRole, forbiddenResponse } from "../../utils/rbacMiddleware";
import { redactSensitiveDeep } from "../../utils/sensitiveRedaction";
// All INSERT/UPDATE statements moved to src/utils/tablefDatabase.ts (Task
// #746). Read-only endpoints below still use a per-request pool.
import {
  insertTablefKpi,
  insertTablefPerformance,
  updateTablefKpi,
  updateTablefPerformance,
} from "../../utils/tablefDatabase";

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
          // Scrub deny-list keys / credential-shaped strings out of the
          // user-supplied KPI payload BEFORE it touches Postgres. KPI rows
          // store free-text columns (description, calculation_definition,
          // owner_email, …) where a misbehaving operator could otherwise
          // paste a JWT, GitHub PAT (`ghp_…`), bcrypt hash, etc.
          const data = redactSensitiveDeep(await c.req.json());
          let kpi;
          if (data.kpi_id) {
            kpi = await updateTablefKpi(data);
          } else {
            const kpiId = `KPI-${Date.now()}`;
            kpi = await insertTablefKpi(kpiId, data);
          }
          return c.json({ success: true, kpi });
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
          // Scrub deny-list keys / credential-shaped strings out of the
          // user-supplied performance payload (comment, evidence_link, …)
          // BEFORE it reaches the SQL layer.
          const data = redactSensitiveDeep(await c.req.json());
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
            await updateTablefPerformance({
              kpi_id: data.kpi_id,
              period_month: data.period_month,
              target: data.target,
              achieved: data.achieved,
              variance,
              variance_percent: variancePercent,
              status,
              trend,
              comment: data.comment,
              evidence_link: data.evidence_link,
            });
          } else {
            await insertTablefPerformance({
              kpi_id: data.kpi_id,
              department_id: data.department_id,
              period_month: data.period_month,
              target: data.target,
              achieved: data.achieved,
              variance,
              variance_percent: variancePercent,
              status,
              trend,
              comment: data.comment,
              evidence_link: data.evidence_link,
            });
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
