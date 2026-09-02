/**
 * GRC-KPI-002 had four conflicting definitions. The calculator scores per
 * quarter, so quarterly wins over the old "Per Certificate".
 */
import { describe, it, expect } from "vitest";

import { FINAL_KPIS } from "../../src/utils/finalGrqKpiSeed";

describe("GRC-KPI-002 definition", () => {
  it("is a quarterly percentage targeting 100", () => {
    const k = FINAL_KPIS.find((x: any) => x.code === "GRC-KPI-002")!;
    expect(k.unit).toBe("%");
    expect(k.target).toBe(100);
    expect(k.frequency).toBe("quarterly");
    expect(k.direction).toBe("higher_is_better");
  });

  it("declares the milestone plan as its data source", () => {
    const k = FINAL_KPIS.find((x: any) => x.code === "GRC-KPI-002")!;
    expect(k.data_source).toMatch(/Certification Milestone Plan/i);
  });
});
