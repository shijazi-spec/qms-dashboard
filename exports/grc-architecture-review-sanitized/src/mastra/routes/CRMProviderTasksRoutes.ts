/**
 * CRMProvider Tasks sync endpoints.
 *
 *   POST /api/CRMProvider/tasks/sync   — pull Tasks into the local `CRMProvider_tasks` table
 *   GET  /api/CRMProvider/tasks/stats  — census: how many, and how they are linked
 *
 * The sync feeds the follow-up KPIs (SDR-KPI-11, SALES-KPI-07, SALES-KPI-08),
 * which cannot use the per-record activities reader — that costs one CRMProvider
 * request per parent record. See CRMProviderTasksSync.ts.
 *
 * /stats exists to answer a question BEFORE anyone builds on this data: are
 * tasks actually linked to leads and deals in this tenant? A large `total` with
 * near-zero linkage means the follow-up KPIs would measure nothing, and the
 * honest response is to redefine them rather than ship 0%.
 */
import {
  requireRoleOrKey,
  unauthorizedResponse,
} from "../../utils/rbacMiddleware";
import { logger } from "../../utils/logger";

// Reading the census is a governance read; running the sync writes to our own
// mirror and calls CRMProvider, so it is held to the tighter write set.
const TASKS_READ_ROLES = [
  "admin",
  "grc_manager",
  "ai_specialist",
  "head_of_operations_quality",
  "quality_manager",
  "bu_owner",
  "executive",
] as const;

const TASKS_WRITE_ROLES = [
  "admin",
  "grc_manager",
  "head_of_operations_quality",
  "quality_manager",
] as const;

export const CRMProviderTasksRoutes = [
  {
    path: "/api/CRMProvider/tasks/sync",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRoleOrKey(c, [...TASKS_WRITE_ROLES]);
          if (!user) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));
          const days = Number.isFinite(Number(body?.days))
            ? Math.max(1, Math.min(Number(body.days), 365))
            : 90;
          const maxRecords = Number.isFinite(Number(body?.max))
            ? Math.max(1, Math.min(Number(body.max), 20000))
            : 5000;
          const sinceIso = new Date(
            Date.now() - days * 24 * 60 * 60 * 1000,
          ).toISOString();

          const { runCRMProviderTasksSync } = await import("../../utils/CRMProviderTasksSync");
          const result = await runCRMProviderTasksSync({ sinceIso, maxRecords });
          logger.info("[CRMProviderTasks] sync run", {
            actor: (user as any).email,
            days,
            maxRecords,
            scanned: result.scanned,
            linkage: result.linkage,
          });
          return c.json({ success: result.errors === 0, ...result });
        } catch (error: any) {
          logger.error("[CRMProviderTasks] sync failed:", error);
          return c.json({ error: "Failed to sync CRMProvider tasks" }, 500);
        }
      };
    },
  },
  {
    path: "/api/CRMProvider/tasks/stats",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRoleOrKey(c, [...TASKS_READ_ROLES]);
          if (!user) return unauthorizedResponse(c);
          const { getCRMProviderTaskStats } = await import("../../utils/CRMProviderTasksSync");
          return c.json({ success: true, ...(await getCRMProviderTaskStats()) });
        } catch (error: any) {
          logger.error("[CRMProviderTasks] stats failed:", error);
          return c.json({ error: "Failed to read CRMProvider task stats" }, 500);
        }
      };
    },
  },
];
