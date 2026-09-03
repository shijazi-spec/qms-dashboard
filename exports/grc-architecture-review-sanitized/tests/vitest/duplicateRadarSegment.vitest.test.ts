import { describe, it, expect } from "vitest";
import { classifySegmentFromLayout } from "../../src/utils/duplicateRadarSegment";

describe("classifySegmentFromLayout", () => {
  it("classifies marketplace variants", () => {
    expect(classifySegmentFromLayout("Doam Marketplace")).toBe("marketplace");
    expect(classifySegmentFromLayout("Partner Accounts")).toBe("marketplace");
    expect(classifySegmentFromLayout("Marketplace")).toBe("marketplace");
  });
  it("classifies Example Organization variants", () => {
    expect(classifySegmentFromLayout("Example Organization")).toBe("Example Organization");
    expect(classifySegmentFromLayout("ExampleOrg One")).toBe("Example Organization");
    expect(classifySegmentFromLayout("ExampleOrg-one corporate")).toBe("Example Organization");
  });
  it("defaults blank/other to ExampleOrg", () => {
    expect(classifySegmentFromLayout("")).toBe("ExampleOrg");
    expect(classifySegmentFromLayout(null)).toBe("ExampleOrg");
    expect(classifySegmentFromLayout("Corporate")).toBe("ExampleOrg");
  });
});
