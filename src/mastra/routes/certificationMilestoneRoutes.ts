import { sharedPool as pool } from "../../utils/sharedPool";
import { PLAN_VERSION, SOURCE_DOC } from "../../utils/seeds/certificationMilestonePlan";
import { logger as safeLogger } from "../../utils/logger";

export interface MilestoneRow {
  milestone_key: string;
  milestone_type: "plan" | "framework_target" | "dependency";
  certification: string;
  milestone_name: string;
  planned_date: string | null;
  delivered_date: string | null;
  status: string;
  owner: string;
  notes: string;
  regulation_code: string | null;
}

/** Pure bucketing so the shape is stable even when a section is empty. */
export function groupMilestonesByType(rows: MilestoneRow[]) {
  const out = {
    plan: [] as MilestoneRow[],
    framework_target: [] as MilestoneRow[],
    dependency: [] as MilestoneRow[],
  };
  for (const r of rows) {
    if (r.milestone_type in out) out[r.milestone_type].push(r);
  }
  return out;
}

export const certificationMilestoneRoutes = [
  {
    path: "/api/certification-milestones",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireRole, unauthorizedResponse, forbiddenResponse, getSessionUser } =
          await import("../../utils/rbacMiddleware");
        const user = await requireRole(c, [
          "admin", "head_of_operations_quality", "grc_manager",
          "quality_manager", "executive",
        ]);
        if (!user) {
          if (!getSessionUser(c)) return unauthorizedResponse(c);
          return forbiddenResponse(c);
        }

        const r = await pool.query(
          // pg returns DATE as a JS Date at local midnight; JSON-serialising it with
          // toISOString() shifts the day in any non-UTC server timezone. Format in SQL
          // instead so plain 'YYYY-MM-DD' strings (or null) come back, as in
          // calcCertMilestoneDelivery() in src/utils/northStarSources.ts.
          `SELECT cm.milestone_key, cm.milestone_type, cm.certification,
                  cm.milestone_name, TO_CHAR(cm.planned_date, 'YYYY-MM-DD')   AS planned_date,
                  TO_CHAR(cm.delivered_date, 'YYYY-MM-DD') AS delivered_date,
                  cm.status, cm.owner, cm.notes, reg.regulation_code
             FROM certification_milestones cm
             LEFT JOIN regulations reg ON reg.id = cm.regulation_id
            WHERE cm.milestone_key IS NOT NULL
            ORDER BY cm.planned_date NULLS LAST, cm.milestone_key`,
        );
        return c.json({
          ...groupMilestonesByType(r.rows as MilestoneRow[]),
          plan_version: PLAN_VERSION,
          source_doc: SOURCE_DOC,
        });
      } catch (error) {
        safeLogger.error(
          "❌ [CertificationMilestonesAPI] Error fetching milestones:",
          error,
        );
        return c.json({ error: "Failed to fetch certification milestones" }, 500);
      }
    },
  },
];
