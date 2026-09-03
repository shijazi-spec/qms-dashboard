import { describe, it, expect } from "vitest";
import {
  orderChain, milestoneState, frameworkReadiness,
} from "../../src/utils/certificationRoadmap";

const row = (o: any) => ({
  milestone_key: "K", milestone_type: "plan", certification: "C", milestone_name: "M",
  planned_date: null, delivered_date: null, status: "planned", owner: "O", notes: "",
  regulation_code: null, depends_on_key: null, unlocks_codes: [], gates_keys: [], ...o,
});

describe("orderChain", () => {
  it("orders by the dependency chain, not by array order", () => {
    const rows = [
      row({ milestone_key: "C", depends_on_key: "B" }),
      row({ milestone_key: "A", depends_on_key: null }),
      row({ milestone_key: "B", depends_on_key: "A" }),
    ];
    expect(orderChain(rows).map((r) => r.milestone_key)).toEqual(["A", "B", "C"]);
  });

  it("does not drop rows whose predecessor is missing", () => {
    const rows = [row({ milestone_key: "A", depends_on_key: null }),
                  row({ milestone_key: "X", depends_on_key: "GONE" })];
    expect(orderChain(rows)).toHaveLength(2);
  });

  it("terminates on a cyclic chain instead of looping forever", () => {
    const rows = [row({ milestone_key: "A", depends_on_key: "B" }),
                  row({ milestone_key: "B", depends_on_key: "A" })];
    expect(orderChain(rows)).toHaveLength(2);
  });

  it("keeps both rows when two share a milestone_key", () => {
    const rows = [
      row({ milestone_key: "A", depends_on_key: null, planned_date: "2026-01-01" }),
      row({ milestone_key: "A", depends_on_key: null, planned_date: "2026-02-01" }),
    ];
    expect(orderChain(rows)).toHaveLength(2);
  });

  it("terminates on a self-referencing row", () => {
    const rows = [row({ milestone_key: "A", depends_on_key: "A" })];
    expect(orderChain(rows)).toHaveLength(1);
  });

  it("keeps both entries when the same row object appears twice", () => {
    const a = row({ milestone_key: "A", depends_on_key: null, planned_date: "2026-01-01" });
    expect(orderChain([a, a])).toHaveLength(2);
  });
});

describe("milestoneState", () => {
  const today = "2026-09-03";

  it("is delivered_on_time when delivered on the planned date", () => {
    const r = row({ planned_date: "2026-08-30", delivered_date: "2026-08-30" });
    expect(milestoneState(r, [r], today)).toBe("delivered_on_time");
  });

  it("is delivered_late when delivered after the planned date", () => {
    const r = row({ planned_date: "2026-08-30", delivered_date: "2026-09-01" });
    expect(milestoneState(r, [r], today)).toBe("delivered_late");
  });

  it("is overdue when past its date and undelivered", () => {
    const r = row({ milestone_key: "A", planned_date: "2026-08-30" });
    expect(milestoneState(r, [r], today)).toBe("overdue");
  });

  it("is blocked when an undelivered dependency gates it", () => {
    const m = row({ milestone_key: "OCT", planned_date: "2026-10-31" });
    const dep = row({ milestone_key: "DEP", milestone_type: "dependency", gates_keys: ["OCT"] });
    expect(milestoneState(m, [m, dep], today)).toBe("blocked");
  });

  it("is not blocked once the gating dependency is delivered", () => {
    const m = row({ milestone_key: "OCT", planned_date: "2026-10-31" });
    const dep = row({ milestone_key: "DEP", milestone_type: "dependency",
                      gates_keys: ["OCT"], delivered_date: "2026-09-30" });
    expect(milestoneState(m, [m, dep], today)).not.toBe("blocked");
  });

  it("marks the earliest undelivered future milestone active", () => {
    const a = row({ milestone_key: "A", planned_date: "2026-09-30" });
    const b = row({ milestone_key: "B", planned_date: "2026-10-31" });
    expect(milestoneState(a, [a, b], today)).toBe("active");
    expect(milestoneState(b, [a, b], today)).toBe("planned");
  });

  it("still marks a later milestone active when an earlier one is overdue", () => {
    const overdue = row({ milestone_key: "AUG", planned_date: "2026-08-30" });
    const next = row({ milestone_key: "SEP", planned_date: "2026-09-30" });
    const all = [overdue, next];
    expect(milestoneState(overdue, all, "2026-09-03")).toBe("overdue");
    expect(milestoneState(next, all, "2026-09-03")).toBe("active");
  });

  it("does not let a dependency or framework_target row steal the active marker", () => {
    const plan = row({ milestone_key: "SEP", planned_date: "2026-09-30" });
    const dep = row({ milestone_key: "DEP", milestone_type: "dependency", planned_date: "2026-09-01" });
    const ft = row({ milestone_key: "FT", milestone_type: "framework_target", planned_date: "2026-09-02" });
    expect(milestoneState(plan, [plan, dep, ft], "2026-08-01")).toBe("active");
  });
});

describe("frameworkReadiness", () => {
  it("counts delivered unlocking milestones per framework", () => {
    const rows = [
      row({ milestone_key: "P1", unlocks_codes: ["PDPL"], delivered_date: "2026-11-30",
            planned_date: "2026-11-30" }),
      row({ milestone_key: "P2", unlocks_codes: ["PDPL"], planned_date: "2026-12-31" }),
      row({ milestone_key: "FT", milestone_type: "framework_target",
            regulation_code: "PDPL", planned_date: "2026-12-31" }),
    ];
    const pdpl = frameworkReadiness(rows).find((f) => f.code === "PDPL")!;
    expect(pdpl.total).toBe(2);
    expect(pdpl.delivered).toBe(1);
    expect(pdpl.pct).toBe(50);
    expect(pdpl.unreachable).toBe(false);
  });

  it("flags a framework no milestone unlocks as unreachable", () => {
    const rows = [row({ milestone_key: "FT", milestone_type: "framework_target",
                        regulation_code: "NCA-ECC", planned_date: "2027-04-30" })];
    const nca = frameworkReadiness(rows).find((f) => f.code === "NCA-ECC")!;
    expect(nca.unreachable).toBe(true);
    expect(nca.total).toBe(0);
    expect(nca.pct).toBe(0);
  });

  it("skips a framework_target with no regulation_code", () => {
    const rows = [row({ milestone_key: "FT", milestone_type: "framework_target", regulation_code: null })];
    expect(frameworkReadiness(rows)).toHaveLength(0);
  });
});
