/**
 * North Star source-data routes
 * ==============================
 * Capture endpoints for the five North Star KPIs that had no existing QMS data
 * source (see src/utils/northStarSources.ts). Quality/GRC managers enter rows
 * here; the leadership feed then computes and serves the actuals.
 *
 *   GET  /api/northstar/:source          → list rows (newest 500)
 *   POST /api/northstar/:source          → insert a row
 *
 * :source ∈ certification_milestones | evidence_requests | tpra_requests |
 *           qms_adoption | value_realization
 */

import { join } from "path";
import { readFileSync, existsSync } from "fs";

import { logger as safeLogger } from "../../utils/logger";
import {
  initNorthStarSourceTables,
  isValidSource,
  listSource,
  insertSource,
} from "../../utils/northStarSources";

initNorthStarSourceTables().catch((err) =>
  safeLogger.error("[NorthStarSources] init failed", err),
);

const READ_ROLES = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "executive",
  "auditor",
  "team_lead",
  "ai_specialist",
  "viewer",
] as const;
const WRITE_ROLES = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
] as const;

export const northStarSourceRoutes = [
  {
    // Data-entry page for the five capture-table KPIs.
    path: "/leadership-kpis/data",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "northstar-data.html"),
            "/home/runner/workspace/dashboard/northstar-data.html",
          ];
          for (const p of possiblePaths) {
            if (existsSync(p)) return c.html(readFileSync(p, "utf-8"));
          }
          return c.text("Data-entry page not found", 404);
        } catch (error) {
          safeLogger.error("[NorthStarSources] page serve failed:", error);
          return c.text("Error loading page", 500);
        }
      };
    },
  },
  {
    path: "/api/northstar/:source",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...READ_ROLES]);
          if (!user)
            return forbiddenResponse(c, "Insufficient permissions");
          const source = c.req.param("source");
          if (!isValidSource(source))
            return c.json({ error: "Unknown source" }, 404);
          const rows = await listSource(source);
          return c.json({ source, count: rows.length, rows });
        } catch (error) {
          safeLogger.error("[NorthStarSources] list failed:", error);
          return c.json({ error: "Failed to list source" }, 500);
        }
      };
    },
  },
  {
    path: "/api/northstar/:source",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...WRITE_ROLES]);
          if (!user)
            return forbiddenResponse(c, "Insufficient permissions");
          const source = c.req.param("source");
          if (!isValidSource(source))
            return c.json({ error: "Unknown source" }, 404);
          const body = await c.req.json();
          const row = await insertSource(source, body);
          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: "CREATE",
              entityType: "NORTHSTAR_SOURCE",
              entityId: String(row?.id ?? ""),
              entityName: source,
              description: `North Star source row added: ${source}`,
              module: "kpis",
              severity: "INFO",
            });
          } catch {}
          return c.json(row, 201);
        } catch (error) {
          safeLogger.error("[NorthStarSources] insert failed:", error);
          return c.json(
            { error: String((error as Error)?.message || "Insert failed") },
            400,
          );
        }
      };
    },
  },
];
