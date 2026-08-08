import { describe, it, expect } from "vitest";
import { functionReportKeys } from "../../src/utils/qualityReportsAggregator";

describe("functionReportKeys", () => {
  it("maps each function to its report set", () => {
    expect(functionReportKeys("sdr")).toEqual(["leads"]);
    expect(functionReportKeys("sales")).toEqual(["deals", "stage_aging"]);
    expect(functionReportKeys("cs")).toEqual(["cs_lifecycle"]);
    expect(functionReportKeys("partnersuccess")).toEqual(["cs_lifecycle"]);
    expect(functionReportKeys("partnership")).toEqual(["leads", "deals"]);
    expect(functionReportKeys("onboarding")).toEqual(["cs_lifecycle_onboarding", "deals"]);
    expect(functionReportKeys("unknown")).toEqual([]);
  });
});
