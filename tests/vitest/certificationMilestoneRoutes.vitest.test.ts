import { describe, it, expect } from "vitest";

import { groupMilestonesByType } from "../../src/mastra/routes/certificationMilestoneRoutes";
import {
  orderChain,
  milestoneState,
  frameworkReadiness,
  type RoadmapRow,
} from "../../src/utils/certificationRoadmap";

describe("groupMilestonesByType", () => {
  it("buckets rows into the three plan sections", () => {
    const g = groupMilestonesByType([
      { milestone_key: "a", milestone_type: "plan" },
      { milestone_key: "b", milestone_type: "framework_target" },
      { milestone_key: "c", milestone_type: "dependency" },
      { milestone_key: "d", milestone_type: "plan" },
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

describe("certification-milestones payload shape (chain + readiness)", () => {
  // Mirrors exactly what the route handler builds from `r.rows`, without a
  // live DB — this is the same derivation, just fed a fixture row set.
  function buildPayload(all: RoadmapRow[], today: string) {
    const chain = orderChain(all.filter((x) => x.milestone_type === "plan")).map(
      (m) => ({ ...m, state: milestoneState(m, all, today) }),
    );
    const readiness = frameworkReadiness(all);
    return {
      ...groupMilestonesByType(all as any),
      chain,
      readiness,
      plan_version: "test-version",
      source_doc: "test-doc",
    };
  }

  const rows: RoadmapRow[] = [
    {
      milestone_key: "m1",
      milestone_type: "plan",
      certification: "ISO 27001",
      milestone_name: "Gap assessment",
      planned_date: "2026-01-01",
      delivered_date: "2026-01-01",
      status: "done",
      owner: "GRC",
      notes: "",
      regulation_code: null,
      depends_on_key: null,
      unlocks_codes: ["ISO27001"],
      gates_keys: [],
    },
    {
      milestone_key: "m2",
      milestone_type: "plan",
      certification: "ISO 27001",
      milestone_name: "Internal audit",
      planned_date: "2026-06-01",
      delivered_date: null,
      status: "planned",
      owner: "GRC",
      notes: "",
      regulation_code: null,
      depends_on_key: "m1",
      unlocks_codes: ["ISO27001"],
      gates_keys: [],
    },
    {
      milestone_key: "ft1",
      milestone_type: "framework_target",
      certification: "ISO 27001",
      milestone_name: "ISO 27001 certified",
      planned_date: "2026-12-01",
      delivered_date: null,
      status: "planned",
      owner: "GRC",
      notes: "",
      regulation_code: "ISO27001",
      depends_on_key: null,
      unlocks_codes: [],
      gates_keys: [],
    },
    {
      milestone_key: "dep1",
      milestone_type: "dependency",
      certification: "ISO 27001",
      milestone_name: "Vendor contract signed",
      planned_date: "2026-02-01",
      delivered_date: null,
      status: "planned",
      owner: "Legal",
      notes: "",
      regulation_code: null,
      depends_on_key: null,
      unlocks_codes: [],
      gates_keys: ["m2"],
    },
  ];

  it("includes chain (ordered, with state) and readiness alongside the three grouped arrays", () => {
    const payload = buildPayload(rows, "2026-03-01");

    // Existing grouped arrays are untouched.
    expect(payload.plan).toHaveLength(2);
    expect(payload.framework_target).toHaveLength(1);
    expect(payload.dependency).toHaveLength(1);

    // chain: ordered plan rows, each carrying a `state`.
    expect(payload.chain.map((m) => m.milestone_key)).toEqual(["m1", "m2"]);
    expect(payload.chain[0].state).toBe("delivered_on_time");
    // m2 is gated by an undelivered dependency (dep1) via gates_keys.
    expect(payload.chain[1].state).toBe("blocked");

    // readiness: one entry per framework_target.
    expect(payload.readiness).toEqual([
      {
        code: "ISO27001",
        planned_date: "2026-12-01",
        total: 2,
        delivered: 1,
        pct: 50,
        unreachable: false,
      },
    ]);
  });

  it("groupMilestonesByType still returns all three keys when chain/readiness are added", () => {
    const payload = buildPayload(rows, "2026-03-01");
    expect(payload).toHaveProperty("chain");
    expect(payload).toHaveProperty("readiness");
    expect(Object.keys(groupMilestonesByType(rows as any)).sort()).toEqual([
      "dependency",
      "framework_target",
      "plan",
    ]);
  });
});
