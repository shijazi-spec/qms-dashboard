/**
 * OKR routes
 * ==========
 *   GET /api/okrs   → objectives + key results, each KR enriched with the live
 *                     value/status from the leadership feed (joined by kpi_code).
 *                     KRs without a kpi_code are returned as "pending" (no value).
 *   GET /okrs       → the OKR dashboard page.
 */

import { join } from "path";
import { readFileSync, existsSync } from "fs";

import { logger as safeLogger } from "../../utils/logger";
import { initOkrTables, getOkrs } from "../../utils/okrDatabase";

initOkrTables().catch((err) =>
  safeLogger.error("[OKR] initOkrTables failed", err),
);

const READ_ROLES = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "executive",
] as const;

export const okrRoutes = [
  {
    path: "/api/okrs",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...READ_ROLES]);
          if (!user)
            return forbiddenResponse(c, "Insufficient permissions for OKRs");

          const { buildLeadershipKpiFeed } =
            await import("../../utils/leadershipKpiFeed");
          const [objectives, feed] = await Promise.all([
            getOkrs(),
            buildLeadershipKpiFeed(),
          ]);
          const live = new Map(feed.kpis.map((k) => [k.code, k]));

          const enriched = objectives.map((o) => ({
            ...o,
            key_results: o.key_results.map((kr: any) => {
              const k = kr.kpi_code ? live.get(kr.kpi_code) : undefined;
              return {
                ...kr,
                current_value: k ? k.value : null,
                current_unit: k ? k.unit : null,
                status: k ? k.status : null,
                state: kr.kpi_code
                  ? k
                    ? "live"
                    : "awaiting_data"
                  : "pending_calculator",
              };
            }),
          }));
          c.header("Cache-Control", "no-store");
          return c.json({ generated_at: feed.generated_at, objectives: enriched });
        } catch (error) {
          safeLogger.error("[OKR] list failed:", error);
          return c.json({ error: "Failed to load OKRs" }, 500);
        }
      };
    },
  },
  {
    path: "/okrs",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "okrs.html"),
            "/home/runner/workspace/dashboard/okrs.html",
          ];
          for (const p of possiblePaths) {
            if (existsSync(p)) return c.html(readFileSync(p, "utf-8"));
          }
          return c.text("OKRs page not found", 404);
        } catch (error) {
          safeLogger.error("[OKR] page serve failed:", error);
          return c.text("Error loading page", 500);
        }
      };
    },
  },
];
