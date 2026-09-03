/**
 * The Certification Actions seed breaks the 7 plan milestones (+ 2
 * Technology dependencies) from certification_milestones into the 23
 * checkable actions listed in GRQ-PLAN-2026-01 §3.1. These assertions are
 * the contract between the Word document and the DB.
 */
import { describe, it, expect } from "vitest";

import { CERTIFICATION_ACTIONS as ACTIONS } from "../../src/utils/seeds/certificationActions";
import { CERTIFICATION_MILESTONE_PLAN as PLAN } from "../../src/utils/seeds/certificationMilestonePlan";

describe("certification actions seed", () => {
  it("has 23 rows — the real total per spec §3.1's own per-milestone tables", () => {
    // §3.1's per-milestone tables total 2+6+4+2+3+2+2 = 21 plan actions,
    // plus the 2 Technology dependency actions (D.1, D.2) = 23. The design
    // spec's decision #1 prose says "20 actions... plus 2 dependencies" but
    // the section headers it is built from are authoritative over that count.
    expect(ACTIONS).toHaveLength(23);
  });

  it("has the exact per-milestone counts from §3.1: 2/6/4/2/3/2/2, plus 1 per dependency", () => {
    const by = (k: string) => ACTIONS.filter((a) => a.milestone_key === k).length;
    expect(by("PLAN-2026-08-DOCS")).toBe(2);
    expect(by("PLAN-2026-09-APPROVE")).toBe(6);
    expect(by("PLAN-2026-10-SAQA")).toBe(4);
    expect(by("PLAN-2026-11-AUDIT")).toBe(2);
    expect(by("PLAN-2026-12-MGMTREV")).toBe(3);
    expect(by("PLAN-2027-01-PENTEST")).toBe(2);
    expect(by("PLAN-2027-02-SURV")).toBe(2);
    expect(by("DEP-TECH-ANSWERS")).toBe(1);
    expect(by("DEP-TECH-EVIDENCE")).toBe(1);
  });

  it("has unique action keys", () => {
    const keys = ACTIONS.map((a) => a.action_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("references only milestone_keys that exist in the plan", () => {
    const known = new Set(PLAN.map((r) => r.milestone_key));
    for (const a of ACTIONS) {
      expect(known.has(a.milestone_key), a.action_key).toBe(true);
    }
  });

  it("has every verification_mode exactly 'auto' or 'manual'", () => {
    for (const a of ACTIONS) {
      expect(["auto", "manual"], a.action_key).toContain(a.verification_mode);
    }
  });

  it("gives every auto row a non-empty evidence_source and every manual row null", () => {
    for (const a of ACTIONS) {
      if (a.verification_mode === "auto") {
        expect(typeof a.evidence_source, a.action_key).toBe("string");
        expect((a.evidence_source ?? "").length, a.action_key).toBeGreaterThan(0);
      } else {
        expect(a.evidence_source, a.action_key).toBeNull();
      }
    }
  });

  it("gives every row non-empty action_text and owner, transcribed from the plan", () => {
    for (const a of ACTIONS) {
      expect(a.action_text.length, a.action_key).toBeGreaterThan(0);
      expect(a.owner.length, a.action_key).toBeGreaterThan(0);
    }
  });

  it("keeps sort_order contiguous and 1-based within each milestone", () => {
    const milestoneKeys = new Set(ACTIONS.map((a) => a.milestone_key));
    for (const mk of milestoneKeys) {
      const orders = ACTIONS.filter((a) => a.milestone_key === mk)
        .map((a) => a.sort_order)
        .sort((x, y) => x - y);
      expect(orders, mk).toEqual(orders.map((_, i) => i + 1));
    }
  });

  it("has exactly 16 auto rows and 7 manual rows, per §3.1's class column", () => {
    // §3.1 lists 14 plain `auto` + 6 `auto (awaiting data)` = 16 stored as
    // `auto` (see the module comment — awaiting-data is a runtime state, not
    // a seed-time class), plus 7 `manual` rows (2.2, 2.4, 2.6, 3.1, 3.2, D.1,
    // D.2).
    const auto = ACTIONS.filter((a) => a.verification_mode === "auto").length;
    const manual = ACTIONS.filter((a) => a.verification_mode === "manual").length;
    expect(auto).toBe(16);
    expect(manual).toBe(7);
  });

  it("pins each row's verification_mode to the class §3.1 assigns it", () => {
    // Expected modes transcribed from spec §3.1's "Class" column, NOT from
    // the seed under test: `auto` and `auto (awaiting data)` both store as
    // "auto" (awaiting-data is a runtime resolution state — see the module
    // comment); `manual` stores as "manual". Both Technology dependency rows
    // (D.1, D.2) are `manual` per §3.1's dependencies table.
    const expected: Record<string, "auto" | "manual"> = {
      // Milestone 1 — Document Library · GRC
      "ACT-2026-08-DOCS-01": "auto", // 1.1 auto
      "ACT-2026-08-DOCS-02": "auto", // 1.2 auto
      // Milestone 2 — Document Library / SACS-002 · GRC, Alhanouf
      "ACT-2026-09-APPROVE-01": "auto", // 2.1 auto
      "ACT-2026-09-APPROVE-02": "manual", // 2.2 manual
      "ACT-2026-09-APPROVE-03": "auto", // 2.3 auto (awaiting data)
      "ACT-2026-09-APPROVE-04": "manual", // 2.4 manual
      "ACT-2026-09-APPROVE-05": "auto", // 2.5 auto
      "ACT-2026-09-APPROVE-06": "manual", // 2.6 manual
      // Milestone 3 — PCI DSS · GRC, HR, Technology
      "ACT-2026-10-SAQA-01": "manual", // 3.1 manual
      "ACT-2026-10-SAQA-02": "manual", // 3.2 manual
      "ACT-2026-10-SAQA-03": "auto", // 3.3 auto (awaiting data)
      "ACT-2026-10-SAQA-04": "auto", // 3.4 auto (awaiting data)
      // Milestone 4 — ISO 27001 / PDPL · GRQ
      "ACT-2026-11-AUDIT-01": "auto", // 4.1 auto (awaiting data)
      "ACT-2026-11-AUDIT-02": "auto", // 4.2 auto (awaiting data)
      // Milestone 5 — PDPL · Head of GRQ
      "ACT-2026-12-MGMTREV-01": "auto", // 5.1 auto (awaiting data)
      "ACT-2026-12-MGMTREV-02": "auto", // 5.2 auto
      "ACT-2026-12-MGMTREV-03": "auto", // 5.3 auto
      // Milestone 6 — ISO 27001 · Technology, GRC
      "ACT-2027-01-PENTEST-01": "auto", // 6.1 auto (awaiting data)
      "ACT-2027-01-PENTEST-02": "auto", // 6.2 auto
      // Milestone 7 — ISO 27001 · Bureau Veritas
      "ACT-2027-02-SURV-01": "auto", // 7.1 auto
      "ACT-2027-02-SURV-02": "auto", // 7.2 auto
      // Dependencies — Technology (both manual per §3.1)
      "ACT-DEP-TECH-ANSWERS-01": "manual", // D.1 manual
      "ACT-DEP-TECH-EVIDENCE-01": "manual", // D.2 manual
    };

    expect(Object.keys(expected).sort()).toEqual(ACTIONS.map((a) => a.action_key).sort());
    for (const a of ACTIONS) {
      expect(a.verification_mode, a.action_key).toBe(expected[a.action_key]);
    }
  });
});
