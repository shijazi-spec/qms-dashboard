import { describe, it, expect } from "vitest";

import {
  groupMilestonesByType,
  buildActionsPayload,
  canToggleAction,
  type CertificationActionRow,
  type EvidenceCounts,
} from "../../src/mastra/routes/certificationMilestoneRoutes";
import {
  orderChain,
  milestoneState,
  frameworkReadiness,
  type RoadmapRow,
} from "../../src/utils/certificationRoadmap";
import { getRouteRoleAllowlist, canAccessRoute } from "../../src/utils/rbacMiddleware";

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

describe("buildActionsPayload — pure composition of actions + evidence counts", () => {
  function action(over: Partial<CertificationActionRow>): CertificationActionRow {
    return {
      action_key: "ACT-TEST-01",
      milestone_key: "PLAN-TEST",
      sort_order: 1,
      action_text: "Test action",
      owner: "GRC",
      verification_mode: "auto",
      evidence_source: "policies.compliance_approved_ratio",
      done_at: null,
      done_by: null,
      evidence_policy_id: null,
      note: null,
      plan_version: "v3.0",
      source_doc: "test-doc",
      ...over,
    };
  }

  it("attaches a resolved EvidenceReading to every auto action from countsBySource", () => {
    const actions = [
      action({ action_key: "ACT-A", evidence_source: "policies.compliance_approved_ratio" }),
    ];
    const counts: Record<string, EvidenceCounts> = {
      "policies.compliance_approved_ratio": {
        have: 5,
        total: 5,
        sourceEmpty: false,
        sourceReadable: true,
      },
    };
    const { actions: withReadings } = buildActionsPayload(actions, counts);
    expect(withReadings).toHaveLength(1);
    expect(withReadings[0].reading).toEqual({
      source: "policies.compliance_approved_ratio",
      state: "satisfied",
      have: 5,
      need: 5,
    });
  });

  it("gives a manual action no reading (readings are meaningless for manual ticks)", () => {
    const actions = [
      action({
        action_key: "ACT-MANUAL",
        verification_mode: "manual",
        evidence_source: null,
        done_at: "2026-09-01T10:00:00",
        done_by: "a.amashah@walaplus.com",
      }),
    ];
    const { actions: withReadings } = buildActionsPayload(actions, {});
    expect(withReadings[0].reading).toBeNull();
  });

  it("reports unavailable (never satisfied or crash) when an auto action's source has no counts entry", () => {
    const actions = [action({ action_key: "ACT-MISSING", evidence_source: "some.missing.source" })];
    const { actions: withReadings } = buildActionsPayload(actions, {});
    expect(withReadings[0].reading?.state).toBe("unavailable");
  });

  it("rolls up per-milestone progress: complete only when every action in that milestone is done", () => {
    const actions = [
      action({
        action_key: "ACT-A",
        milestone_key: "PLAN-X",
        verification_mode: "auto",
        evidence_source: "policies.compliance_approved_ratio",
      }),
      action({
        action_key: "ACT-B",
        milestone_key: "PLAN-X",
        verification_mode: "manual",
        evidence_source: null,
        done_at: "2026-09-01T10:00:00",
        done_by: "someone@walaplus.com",
      }),
    ];
    const counts: Record<string, EvidenceCounts> = {
      "policies.compliance_approved_ratio": {
        have: 3,
        total: 3,
        sourceEmpty: false,
        sourceReadable: true,
      },
    };
    const { progressByMilestone } = buildActionsPayload(actions, counts);
    expect(progressByMilestone["PLAN-X"]).toEqual({ done: 2, total: 2, complete: true });
  });

  it("keeps a milestone incomplete while an auto action's evidence is only awaiting_data", () => {
    const actions = [
      action({
        action_key: "ACT-A",
        milestone_key: "PLAN-Y",
        verification_mode: "auto",
        evidence_source: "training_records.count",
      }),
    ];
    const counts: Record<string, EvidenceCounts> = {
      "training_records.count": { have: 0, total: 1, sourceEmpty: true, sourceReadable: true },
    };
    const { actions: withReadings, progressByMilestone } = buildActionsPayload(actions, counts);
    expect(withReadings[0].reading?.state).toBe("awaiting_data");
    expect(progressByMilestone["PLAN-Y"]).toEqual({ done: 0, total: 1, complete: false });
  });
});

describe("canToggleAction — the core write-path invariant", () => {
  it("refuses an auto action (computed from evidence, never asserted by hand)", () => {
    expect(canToggleAction("auto")).toBe(false);
  });

  it("allows a manual action", () => {
    expect(canToggleAction("manual")).toBe(true);
  });
});

describe("RBAC — POST /api/certification-actions/:action_key/toggle is registered", () => {
  const url = "/api/certification-actions/ACT-2026-09-APPROVE-01/toggle";
  const expectedRoles = [
    "admin",
    "head_of_operations_quality",
    "grc_manager",
    "quality_manager",
    "executive",
  ];

  it("matches a realistic action_key URL and returns exactly the five governance roles", () => {
    const allowlist = getRouteRoleAllowlist(url, "POST");
    expect(allowlist).not.toBeNull();
    expect([...(allowlist ?? [])].sort()).toEqual([...expectedRoles].sort());
  });

  it("does NOT match GET (the toggle is POST-only)", () => {
    expect(getRouteRoleAllowlist(url, "GET")).toBeNull();
  });

  it("grants admin (bypass only fires inside a matched rule) and every listed role", () => {
    for (const role of [...expectedRoles, "admin"]) {
      expect(canAccessRoute(role, url, "POST"), role).toBe(true);
    }
  });

  it("denies a role with no business reading the certification plan", () => {
    expect(canAccessRoute("viewer", url, "POST")).toBe(false);
  });

  it("denies POST to the whole route tree by default if unmatched (sanity check on deny-by-default)", () => {
    expect(canAccessRoute("admin", "/api/certification-actions", "POST")).toBe(false);
  });
});
