import { describe, it, expect, vi, beforeEach } from "vitest";

const { getBUByKey, createKPIDefinition, getOwnerTypeForOwnerName } = vi.hoisted(
  () => ({
    getBUByKey: vi.fn(),
    createKPIDefinition: vi.fn(),
    getOwnerTypeForOwnerName: vi.fn(),
  }),
);

vi.mock("../../src/utils/qualityReportsDepartments", () => ({
  getBUByKey,
  listBUs: vi.fn(),
  upsertBU: vi.fn(),
  deleteBU: vi.fn(),
  setBUOwners: vi.fn(),
  getDepartmentKpiOwnerNames: vi.fn(async () => []),
}));
vi.mock("../../src/utils/kpiDatabase", () => ({
  createKPIDefinition,
  getOwnerTypeForOwnerName,
}));
// qualityReportsRoutes statically imports the aggregator, which pulls in
// duplicateRadarDatabase and its pool. Stub it so this suite stays a unit test.
vi.mock("../../src/utils/qualityReportsAggregator", () => ({
  getBUReport: vi.fn(),
  getBUHeadline: vi.fn(),
}));
vi.mock("../../src/utils/rbacMiddleware", () => ({
  requireRole: vi.fn(async () => ({ email: "<REDACTED_EMAIL>", role: "admin" })),
  forbiddenResponse: (c: any) => c.json({ error: "forbidden" }, 403),
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { qualityReportsRoutes } from "../../src/mastra/routes/qualityReportsRoutes";

function ctx(buKey: string, body: any) {
  return {
    req: { param: () => buKey, json: async () => body },
    json: (b: any, status?: number) => ({ body: b, status: status ?? 200 }),
  };
}

async function post(buKey: string, body: any) {
  const route: any = qualityReportsRoutes.find(
    (r: any) => r.path === "/api/quality-reports/bus/:buKey/kpis" && r.method === "POST",
  );
  const handler = await route.createHandler();
  return handler(ctx(buKey, body));
}

const VALID = {
  kpi_name: "Answer Rate",
  kpi_code: "SDR-KPI-12",
  category: "quality",
  unit: "%",
  target_value: 80,
  threshold_green: 80,
  threshold_amber: 60,
  threshold_red: 40,
  threshold_direction: "higher_is_better",
};

beforeEach(() => {
  getBUByKey.mockReset();
  createKPIDefinition.mockReset().mockResolvedValue({ id: 99, ...VALID });
  getOwnerTypeForOwnerName.mockReset().mockResolvedValue("sdr_team");
});

describe("POST /api/quality-reports/bus/:buKey/kpis", () => {
  it("sets owner_name from the BU, never from the body", async () => {
    getBUByKey.mockResolvedValue({ bu_key: "sdr_b2b", kpi_owner_name: "SDR Team", is_active: true });
    await post("sdr_b2b", { ...VALID, owner_name: "Sample User", owner_type: "quality_manager" });
    const arg = createKPIDefinition.mock.calls[0][0];
    expect(arg.owner_name).toBe("SDR Team");
    expect(arg.owner_type).toBe("sdr_team");
  });

  it("404s for an unknown BU", async () => {
    getBUByKey.mockResolvedValue(null);
    const res: any = await post("nope", VALID);
    expect(res.status).toBe(404);
  });

  it("400s when the BU has no KPI owner mapped", async () => {
    getBUByKey.mockResolvedValue({ bu_key: "sdr_b2c", kpi_owner_name: null, is_active: true });
    const res: any = await post("sdr_b2c", VALID);
    expect(res.status).toBe(400);
    expect(createKPIDefinition).not.toHaveBeenCalled();
  });

  it("400s when a required field is missing", async () => {
    getBUByKey.mockResolvedValue({ bu_key: "sdr_b2b", kpi_owner_name: "SDR Team", is_active: true });
    const res: any = await post("sdr_b2b", { ...VALID, kpi_code: "" });
    expect(res.status).toBe(400);
    expect(createKPIDefinition).not.toHaveBeenCalled();
  });

  it("409s on a duplicate kpi_code", async () => {
    getBUByKey.mockResolvedValue({ bu_key: "sdr_b2b", kpi_owner_name: "SDR Team", is_active: true });
    createKPIDefinition.mockRejectedValue(
      Object.assign(new Error("dup"), { code: "23505" }),
    );
    const res: any = await post("sdr_b2b", VALID);
    expect(res.status).toBe(409);
  });

  it("400s when the BU is inactive, even with a KPI owner mapped", async () => {
    getBUByKey.mockResolvedValue({ bu_key: "cs_team_old", kpi_owner_name: "CS Team", is_active: false });
    const res: any = await post("cs_team_old", VALID);
    expect(res.status).toBe(400);
    expect(createKPIDefinition).not.toHaveBeenCalled();
  });
});

describe("ad-hoc default", () => {
  it("tags a BU-page creation as ad-hoc so it lands in the Ad-hoc box", async () => {
    getBUByKey.mockResolvedValue({ bu_key: "sdr_b2b", kpi_owner_name: "SDR Team", is_active: true });
    await post("sdr_b2b", VALID);
    // This endpoint IS the ad-hoc path — a KPI added from a BU page is the
    // team's own addition, not part of the seeded catalog.
    expect(createKPIDefinition.mock.calls[0][0].is_adhoc).toBe(true);
  });

  it("lets the caller opt out explicitly", async () => {
    getBUByKey.mockResolvedValue({ bu_key: "sdr_b2b", kpi_owner_name: "SDR Team", is_active: true });
    await post("sdr_b2b", { ...VALID, is_adhoc: false });
    expect(createKPIDefinition.mock.calls[0][0].is_adhoc).toBe(false);
  });
});
