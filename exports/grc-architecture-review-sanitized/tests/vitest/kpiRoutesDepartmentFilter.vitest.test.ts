import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAllKPIDefinitions, getKPIsByOwner, getLatestKPIValue, deptOwners } =
  vi.hoisted(() => ({
    getAllKPIDefinitions: vi.fn(),
    getKPIsByOwner: vi.fn(),
    getLatestKPIValue: vi.fn(),
    deptOwners: vi.fn(),
  }));

vi.mock("../../src/utils/kpiDatabase", () => ({
  initKPITables: vi.fn(async () => {}),
  getAllKPIDefinitions,
  getKPIsByOwner,
  getKPIById: vi.fn(),
  getKPIByCode: vi.fn(),
  getLatestKPIValue,
  getLatestKPIValueForQuarter: vi.fn(),
  getKPIDashboardSummary: vi.fn(),
  createKPIDefinition: vi.fn(),
  updateKPIDefinition: vi.fn(),
  recordKPIValue: vi.fn(),
  getKPIHistory: vi.fn(),
  createExecutiveReport: vi.fn(),
  getExecutiveReports: vi.fn(),
  getExecutiveReportById: vi.fn(),
  updateExecutiveReport: vi.fn(),
  generateMBRData: vi.fn(),
  seedMohammedKPIsManual: vi.fn(),
  seedSDRKPIsManual: vi.fn(),
  seedSalesKPIsManual: vi.fn(),
}));
vi.mock("../../src/utils/qualityReportsDepartments", () => ({
  getDepartmentKpiOwnerNames: deptOwners,
}));
vi.mock("../../src/utils/rbacMiddleware", () => ({
  requireRole: vi.fn(async () => ({ email: "<REDACTED_EMAIL>", role: "admin" })),
  forbiddenResponse: (c: any) => c.json({ error: "forbidden" }, 403),
}));

import { kpiRoutes } from "../../src/mastra/routes/kpiRoutes";

function ctx(query: Record<string, string> = {}) {
  return {
    req: { query: (k: string) => query[k], param: () => undefined },
    json: (body: any, status?: number) => ({ body, status: status ?? 200 }),
  };
}

async function callGetKpis(c: any) {
  const route: any = kpiRoutes.find(
    (r: any) => r.path === "/api/kpis" && r.method === "GET",
  );
  const handler = await route.createHandler();
  return handler(c);
}

beforeEach(() => {
  getAllKPIDefinitions.mockReset();
  getKPIsByOwner.mockReset();
  getLatestKPIValue.mockReset().mockResolvedValue(null);
  deptOwners.mockReset();
});

describe("GET /api/kpis department filter", () => {
  it("drops KPIs owned by a department team", async () => {
    getAllKPIDefinitions.mockResolvedValue([
      { id: 1, kpi_code: "QM-KPI-001", owner_name: "Sample User" },
      { id: 2, kpi_code: "SDR-KPI-01", owner_name: "Sample User" },
      { id: 3, kpi_code: "SALES-KPI-01", owner_name: "Sample User" },
    ]);
    deptOwners.mockResolvedValue(["SDR Team", "Sales Team"]);
    const res: any = await callGetKpis(ctx());
    expect(res.body.map((k: any) => k.kpi_code)).toEqual(["QM-KPI-001"]);
  });

  it("keeps KPIs with a NULL owner_name", async () => {
    getAllKPIDefinitions.mockResolvedValue([
      { id: 1, kpi_code: "LEGACY-01", owner_name: null },
      { id: 2, kpi_code: "SDR-KPI-01", owner_name: "Sample User" },
    ]);
    deptOwners.mockResolvedValue(["SDR Team"]);
    const res: any = await callGetKpis(ctx());
    expect(res.body.map((k: any) => k.kpi_code)).toEqual(["LEGACY-01"]);
  });

  it("excludes NOTHING when no BU maps a KPI owner", async () => {
    getAllKPIDefinitions.mockResolvedValue([
      { id: 1, kpi_code: "QM-KPI-001", owner_name: "Sample User" },
      { id: 2, kpi_code: "SDR-KPI-01", owner_name: "Sample User" },
    ]);
    deptOwners.mockResolvedValue([]);
    const res: any = await callGetKpis(ctx());
    expect(res.body).toHaveLength(2);
  });

  it("applies to the ?owner= branch too", async () => {
    getKPIsByOwner.mockResolvedValue([
      { id: 2, kpi_code: "SDR-KPI-01", owner_name: "Sample User" },
    ]);
    deptOwners.mockResolvedValue(["SDR Team"]);
    const res: any = await callGetKpis(ctx({ owner: "sdr_team" }));
    expect(res.body).toEqual([]);
  });
});
