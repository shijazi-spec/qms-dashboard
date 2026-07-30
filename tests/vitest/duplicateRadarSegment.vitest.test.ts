import { describe, it, expect } from "vitest";
import { classifySegmentFromLayout } from "../../src/utils/duplicateRadarSegment";

describe("classifySegmentFromLayout", () => {
  it("classifies marketplace variants", () => {
    expect(classifySegmentFromLayout("Doam Marketplace")).toBe("marketplace");
    expect(classifySegmentFromLayout("Partner Accounts")).toBe("marketplace");
    expect(classifySegmentFromLayout("Marketplace")).toBe("marketplace");
  });
  it("classifies walaone variants", () => {
    expect(classifySegmentFromLayout("WalaOne")).toBe("walaone");
    expect(classifySegmentFromLayout("Wala One")).toBe("walaone");
    expect(classifySegmentFromLayout("wala-one corporate")).toBe("walaone");
  });
  it("defaults blank/other to walaplus", () => {
    expect(classifySegmentFromLayout("")).toBe("walaplus");
    expect(classifySegmentFromLayout(null)).toBe("walaplus");
    expect(classifySegmentFromLayout("Corporate")).toBe("walaplus");
  });
});
