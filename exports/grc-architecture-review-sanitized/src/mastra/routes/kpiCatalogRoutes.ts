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

/** Map our RAG (+ no-data) to the leadership 7-status wording. */
function ragToLeadershipLabel(
  status: string | null,
  hasValue: boolean,
): string {
  if (!hasValue) return "Not Started";
  if (status === "green") return "On Track";
  if (status === "amber") return "At Risk";
  if (status === "red") return "Off Track";
  return "Not Started";
}

/**
 * Which of this catalog's hardcoded group keys are DEPARTMENT teams — i.e.
 * teams whose KPIs moved to their Quality Reports BU page and must not be
 * listed here. Derived from the BU registry (never hardcoded), so unmapping a
 * BU returns its group to this page automatically.
 *
 * The group keys are `owner_type` values while the registry stores
 * `owner_name`, so each departmental name is resolved through the same
 * owner_type lookup the BU-scoped create endpoint uses.
 *
 * 'shared' is EXCLUDED from the result on purpose. It is the GRQ Team's own
 * owner_type (Sample User 2026-08-16: "shared KPIs are for the GRQ Team, leave them
 * in the KPI engine as is"), and it is also getOwnerTypeForOwnerName's
 * fallback for a team with no KPIs yet — so without this guard, a newly-mapped
 * department with no KPIs would resolve to 'shared' and silently delete the
 * GRQ Team group from this page.
 */
export async function departmentGroupKeys(
  deptOwnerNames: string[],
  resolveOwnerType?: (ownerName: string) => Promise<string>,
): Promise<Set<string>> {
  if (!deptOwnerNames.length) return new Set();
  const resolve =
    resolveOwnerType ??
    (await import("../../utils/kpiDatabase")).getOwnerTypeForOwnerName;
  const types = await Promise.all(deptOwnerNames.map((n) => resolve(n)));
  return new Set(types.filter((t) => t && t !== "shared"));
}

/** Drops the groups whose owner_type belongs to a department team. */
export function withoutDepartmentGroups<T extends { key: string }>(
  groups: T[],
  deptKeys: Set<string>,
): T[] {
  return groups.filter((g) => !deptKeys.has(g.key));
}

/** Removes department-owned KPIs from a group's rows (owner_name match). */
export function withoutDepartmentKpis<T extends { owner_name?: string | null }>(
  defs: T[],
  deptOwnerNames: string[],
): T[] {
  const set = new Set(deptOwnerNames);
  if (!set.size) return defs;
  return defs.filter((d) => !d.owner_name || !set.has(String(d.owner_name)));
}

async function legacyGroup(ownerType: string, deptOwnerNames: string[] = []) {
  const { getKPIsByOwner, getLatestKPIValue } =
    await import("../../utils/kpiDatabase");
  const all = await getKPIsByOwner(ownerType);
  // Belt-and-braces: a department KPI whose owner_type fell back to 'shared'
  // would otherwise surface inside the GRQ Team group, which is not dropped.
  const defs = withoutDepartmentKpis(all as any[], deptOwnerNames);
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
        status_label: ragToLeadershipLabel(status, value !== null),
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
                  status_label: k
                    ? (k.status_label ?? ragToLeadershipLabel(k.status, true))
                    : "Not Started",
                  frequency: "",
                  source: "auto",
                };
              });

          // Department KPIs (SDR / Sales) are reported on their Quality Reports
          // BU page, not here — listing them would contradict the note on
          // /kpis that sends people there.
          const { getDepartmentKpiOwnerNames } = await import(
            "../../utils/qualityReportsDepartments"
          );
          const deptOwnerNames = await getDepartmentKpiOwnerNames();
          const deptKeys = await departmentGroupKeys(deptOwnerNames);

          const [sdr, shared] = await Promise.all([
            legacyGroup("sdr_team", deptOwnerNames),
            legacyGroup("shared", deptOwnerNames),
          ]);

          const groups = [
            { key: "quality_manager", label: "QM Manager (Sample User)", kpis: grqByPrefix("QM-KPI") },
            { key: "grc_manager", label: "GRC Manager (Sample User)", kpis: grqByPrefix("GRC-KPI") },
            { key: "sdr_team", label: "SDR Team", kpis: sdr },
            { key: "sales_team", label: "Sales Team", kpis: [] },
            { key: "cs_team", label: "CS Team", kpis: [] },
            { key: "shared", label: "Shared", kpis: shared },
          ];
          const visibleGroups = withoutDepartmentGroups(groups, deptKeys);
          c.header("Cache-Control", "no-store");
          return c.json({ generated_at: feed.generated_at, groups: visibleGroups });
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
