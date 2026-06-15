/**
 * Unified KPI Catalog — owner-grouped
 * ===================================
 *   GET /api/kpi-catalog → all KPIs grouped into owner "boxes":
 *       QM Manager + GRC Manager  ← the live GRQ feed (auto-calculated)
 *       SDR Team + Shared         ← kpi_definitions (manual values)
 *       Sales Team + CS Team      ← placeholders (no KPIs defined yet)
 *   GET /kpi-catalog → the page.
 *
 * This is the single owner-grouped catalog. The legacy /kpis engine is left
 * untouched; the stale legacy QM/GRC definitions are intentionally NOT shown
 * here (superseded by the QM-KPI-### / GRC-KPI-### set).
 */

import { join } from "path";
import { readFileSync, existsSync } from "fs";

import { logger as safeLogger } from "../../utils/logger";

// Read-only KPI catalog — viewable by any active platform user (the global
// middleware already requires a valid session). Broadened so managers aren't
// blocked by a narrow role list.
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

async function legacyGroup(ownerType: string) {
  const { getKPIsByOwner, getLatestKPIValue } =
    await import("../../utils/kpiDatabase");
  const defs = await getKPIsByOwner(ownerType);
  return Promise.all(
    defs.map(async (d: any) => {
      let value: number | null = null;
      let status: string | null = null;
      try {
        const v = await getLatestKPIValue(d.id);
        if (v) {
          value = v.actual_value ?? null;
          status = v.status ?? null;
        }
      } catch {}
      return {
        code: d.kpi_code,
        name: d.kpi_name,
        unit: d.unit || "%",
        target: d.target_value ?? null,
        value,
        status,
        frequency: d.frequency || "",
        source: "manual",
      };
    }),
  );
}

export const kpiCatalogRoutes = [
  {
    path: "/api/kpi-catalog",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...READ_ROLES]);
          if (!user)
            return forbiddenResponse(c, "Insufficient permissions for KPIs");

          const { buildLeadershipKpiFeed } =
            await import("../../utils/leadershipKpiFeed");
          const feed = await buildLeadershipKpiFeed();
          const live = new Map(feed.kpis.map((k) => [k.code, k]));
          const grqByPrefix = (prefix: string) =>
            feed.definitions
              .filter((d) => d.code.startsWith(prefix))
              .map((d) => {
                const k = live.get(d.code);
                return {
                  code: d.code,
                  name: d.name,
                  unit: d.unit,
                  target: d.target,
                  value: k ? k.value : null,
                  status: k ? k.status : null,
                  frequency: "",
                  source: "auto",
                };
              });

          const [sdr, shared] = await Promise.all([
            legacyGroup("sdr_team"),
            legacyGroup("shared"),
          ]);

          const groups = [
            { key: "quality_manager", label: "QM Manager (Sara)", kpis: grqByPrefix("QM-KPI") },
            { key: "grc_manager", label: "GRC Manager (Maram)", kpis: grqByPrefix("GRC-KPI") },
            { key: "sdr_team", label: "SDR Team", kpis: sdr },
            { key: "sales_team", label: "Sales Team", kpis: [] },
            { key: "cs_team", label: "CS Team", kpis: [] },
            { key: "shared", label: "Shared", kpis: shared },
          ];
          c.header("Cache-Control", "no-store");
          return c.json({ generated_at: feed.generated_at, groups });
        } catch (error) {
          safeLogger.error("[KpiCatalog] failed:", error);
          return c.json({ error: "Failed to build KPI catalog" }, 500);
        }
      };
    },
  },
  {
    path: "/kpi-catalog",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "kpi-catalog.html"),
            "/home/runner/workspace/dashboard/kpi-catalog.html",
          ];
          for (const p of possiblePaths) {
            if (existsSync(p)) return c.html(readFileSync(p, "utf-8"));
          }
          return c.text("KPI Catalog page not found", 404);
        } catch (error) {
          safeLogger.error("[KpiCatalog] page serve failed:", error);
          return c.text("Error loading page", 500);
        }
      };
    },
  },
];
