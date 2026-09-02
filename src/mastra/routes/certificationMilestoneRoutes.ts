import { sharedPool as pool } from "../../utils/sharedPool";
import { PLAN_VERSION, SOURCE_DOC } from "../../utils/seeds/certificationMilestonePlan";

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
      const { requireRole } = await import("../../utils/rbacMiddleware");
      const user = await requireRole(c, [
        "admin", "head_of_operations_quality", "grc_manager",
        "quality_manager", "executive",
      ]);
      if (!user) return c.json({ error: "Insufficient permissions" }, 403);

      const r = await pool.query(
        `SELECT cm.milestone_key, cm.milestone_type, cm.certification,
                cm.milestone_name, cm.planned_date, cm.delivered_date,
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
    },
  },
];
