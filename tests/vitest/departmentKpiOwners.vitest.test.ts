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

beforeEach(() => {
  query.mockReset();
  invalidateDepartmentKpiOwnerCache();
});

describe("getDepartmentKpiOwnerNames", () => {
  it("returns the distinct kpi_owner_name of ACTIVE BUs only", async () => {
    query.mockResolvedValue({
      rows: [{ kpi_owner_name: "SDR Team" }, { kpi_owner_name: "Sales Team" }],
    });
    const names = await getDepartmentKpiOwnerNames();
    expect(names).toEqual(["SDR Team", "Sales Team"]);
    const sql = String(query.mock.calls.at(-1)?.[0]);
    expect(sql).toContain("quality_report_bus");
    expect(sql).toContain("is_active = true");
    expect(sql).toContain("kpi_owner_name IS NOT NULL");
  });

  it("returns [] when no BU maps a KPI owner (must exclude NOTHING downstream)", async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getDepartmentKpiOwnerNames()).toEqual([]);
  });

  it("caches: a second call inside the TTL does not re-query", async () => {
    query.mockResolvedValue({ rows: [{ kpi_owner_name: "SDR Team" }] });
    await getDepartmentKpiOwnerNames();
    const callsAfterFirst = query.mock.calls.length;
    await getDepartmentKpiOwnerNames();
    expect(query.mock.calls.length).toBe(callsAfterFirst);
  });

  it("invalidate forces a re-query", async () => {
    query.mockResolvedValue({ rows: [{ kpi_owner_name: "SDR Team" }] });
    await getDepartmentKpiOwnerNames();
    const before = query.mock.calls.length;
    invalidateDepartmentKpiOwnerCache();
    await getDepartmentKpiOwnerNames();
    expect(query.mock.calls.length).toBeGreaterThan(before);
  });
});
