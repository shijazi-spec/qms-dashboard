/**
 * `is_department_kpi` on /api/kpis/:id/detail.
 *
 * Sample User 2026-08-18: opening a Sales/SDR KPI filed it under the "KPIs" nav
 * section and dropped a "KPIs" entry into the sidebar's Recent list — pointing
 * at the GRQ KPI Engine, the one page these KPIs were deliberately removed
 * from. The detail page needs to know whose KPI it is before it can stop
 * claiming to be part of /kpis.
 *
 * Tests the predicate directly rather than through the Hono route: the route
 * body resolves getKPIById/getLatestKPIValue/getKPIHistory/getKpiInsight via
 * a mix of static and dynamic imports, and vi.mock does not reliably intercept
 * dynamic ones (it bit kpiCatalogRoutes and kpiRoutes before).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({
    query: (...a: any[]) => query(...a),
    connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }),
  }),
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getDepartmentKpiOwnerNames,
  invalidateDepartmentKpiOwnerCache,
} from "../../src/utils/qualityReportsDepartments";

/** The exact expression the route uses. */
function isDepartmentKpi(ownerName: unknown, deptOwners: string[]): boolean {
  const owner = String(ownerName || "").trim().toLowerCase();
  return !!owner && deptOwners.some((n) => n.trim().toLowerCase() === owner);
}

beforeEach(() => {
  query.mockReset();
  invalidateDepartmentKpiOwnerCache();
});

describe("department detection", () => {
  it("matches a BU-owned KPI regardless of casing or padding", async () => {
    query.mockResolvedValue({ rows: [{ kpi_owner_name: "Sales Team" }, { kpi_owner_name: "SDR Team" }] });
    const owners = await getDepartmentKpiOwnerNames();
    expect(isDepartmentKpi("  sales team ", owners)).toBe(true);
    expect(isDepartmentKpi("SDR Team", owners)).toBe(true);
  });

  it("leaves GRQ-owned KPIs alone", async () => {
    query.mockResolvedValue({ rows: [{ kpi_owner_name: "Sales Team" }] });
    const owners = await getDepartmentKpiOwnerNames();
    // Sample User's own KPIs stay in the engine — mis-flagging one would send its
    // detail page's back link and nav to Quality Reports, where it isn't listed.
    expect(isDepartmentKpi("Sample User", owners)).toBe(false);
    expect(isDepartmentKpi("Sample User", owners)).toBe(false);
  });

  it("treats a blank owner as NOT a department KPI", () => {
    // Empty-string owner must not match an empty entry in the owners list and
    // silently reclassify every unowned KPI.
    expect(isDepartmentKpi("", ["", "Sales Team"])).toBe(false);
    expect(isDepartmentKpi(null, ["Sales Team"])).toBe(false);
  });

  it("degrades to 'not a department KPI' when the owner lookup fails", async () => {
    query.mockRejectedValue(new Error("relation does not exist"));
    const owners = await getDepartmentKpiOwnerNames();
    // getDepartmentKpiOwnerNames never throws — it returns [] so the page keeps
    // its previous behaviour instead of erroring the whole detail request.
    expect(owners).toEqual([]);
    expect(isDepartmentKpi("Sales Team", owners)).toBe(false);
  });
});
