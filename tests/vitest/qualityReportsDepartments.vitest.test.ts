import { describe, it, expect } from "vitest";
import { channelToSegment, SEED_BUS } from "../../src/utils/qualityReportsDepartments";

describe("channelToSegment", () => {
  it("maps channel to the fixed segment", () => {
    expect(channelToSegment("B2B")).toBe("walaplus");
    expect(channelToSegment("B2C")).toBe("walaone");
    expect(channelToSegment("MP")).toBe("marketplace");
  });
});
describe("SEED_BUS", () => {
  it("has the 9 canonical BUs with unique keys and valid channels", () => {
    expect(SEED_BUS).toHaveLength(9);
    const keys = SEED_BUS.map((b) => b.bu_key);
    expect(new Set(keys).size).toBe(9);
    for (const b of SEED_BUS) expect(["B2B", "B2C", "MP"]).toContain(b.channel);
    expect(SEED_BUS.map((b) => b.bu_name)).toContain("Partnership (MP)");
    expect(SEED_BUS.map((b) => b.fn)).toContain("partnersuccess");
  });
});
