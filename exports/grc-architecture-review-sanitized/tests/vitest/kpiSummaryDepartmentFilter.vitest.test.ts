import { describe, it, expect, vi, beforeEach } from "vitest";
const { query, deptOwners } = vi.hoisted(() => ({
  query: vi.fn(),
  deptOwners: vi.fn(),
}));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({
    query: (...a: any[]) => query(...a),
    connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }),
  }),
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/utils/qualityReportsDepartments", () => ({
  getDepartmentKpiOwnerNames: deptOwners,
}));
import { getKPIDashboardSummary } from "../../src/utils/kpiDatabase";

beforeEach(() => {
  query.mockReset();
  deptOwners.mockReset();
});

describe("getKPIDashboardSummary department filter", () => {
  it("excludes department KPIs from total and byOwner", async () => {
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM kpi_definitions")) {
        return {
          rows: [
            { id: 1, kpi_code: "QM-KPI-001", owner_name: "Sample User", owner_type: "quality_manager", category: "quality" },
            { id: 2, kpi_code: "SDR-KPI-01", owner_name: "Sample User", owner_type: "sdr_team", category: "quality" },
          ],
        };
      }
      return { rows: [] };
    });
    deptOwners.mockResolvedValue(["SDR Team"]);
    const s = await getKPIDashboardSummary();
    expect(s.total).toBe(1);
    expect(s.byOwner.sdr_team).toBeUndefined();
    expect(s.byOwner.sales_team).toBeUndefined();
    expect(s.byOwner.quality_manager).toBe(1);
  });

  it("excludes nothing when the departmental set is empty", async () => {
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM kpi_definitions")) {
        return {
          rows: [
            { id: 1, kpi_code: "QM-KPI-001", owner_name: "Sample User", owner_type: "quality_manager", category: "quality" },
            { id: 2, kpi_code: "SDR-KPI-01", owner_name: "Sample User", owner_type: "sdr_team", category: "quality" },
          ],
        };
      }
      return { rows: [] };
    });
    deptOwners.mockResolvedValue([]);
    const s = await getKPIDashboardSummary();
    expect(s.total).toBe(2);
  });
});
