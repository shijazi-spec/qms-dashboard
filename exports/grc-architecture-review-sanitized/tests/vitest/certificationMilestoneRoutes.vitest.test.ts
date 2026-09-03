import { describe, it, expect } from "vitest";

import { groupMilestonesByType } from "../../src/mastra/routes/certificationMilestoneRoutes";

describe("groupMilestonesByType", () => {
  it("buckets rows into the three plan sections", () => {
    const g = groupMilestonesByType([
      { milestone_key: "<REDACTED_SECRET>", milestone_type: "plan" },
      { milestone_key: "<REDACTED_SECRET>", milestone_type: "framework_target" },
      { milestone_key: "<REDACTED_SECRET>", milestone_type: "dependency" },
      { milestone_key: "<REDACTED_SECRET>", milestone_type: "plan" },
    ] as any);
    expect(g.plan).toHaveLength(2);
    expect(g.framework_target).toHaveLength(1);
    expect(g.dependency).toHaveLength(1);
  });

  it("always returns all three keys even when empty", () => {
    const g = groupMilestonesByType([]);
    expect(Object.keys(g).sort()).toEqual(["dependency", "framework_target", "plan"]);
  });
});
