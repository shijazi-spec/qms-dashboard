/**
 * The Certification Milestone Plan seed mirrors GRQ-PLAN-2026-01 v3.0.
 * These assertions are the contract between the Word document and the DB.
 */
import { describe, it, expect } from "vitest";

import {
  CERTIFICATION_MILESTONE_PLAN as PLAN,
  PLAN_VERSION,
  SOURCE_DOC,
  resolveMilestoneRegulationIds,
} from "../../src/utils/seeds/certificationMilestonePlan";

describe("certification milestone plan seed", () => {
  it("carries the source document provenance", () => {
    expect(PLAN_VERSION).toBe("3.0");
    expect(SOURCE_DOC).toBe("GRQ-PLAN-2026-01");
  });

  it("has 16 rows split 7 plan / 7 framework_target / 2 dependency", () => {
    expect(PLAN).toHaveLength(16);
    const by = (t: string) => PLAN.filter((r) => r.milestone_type === t).length;
    expect(by("plan")).toBe(7);
    expect(by("framework_target")).toBe(7);
    expect(by("dependency")).toBe(2);
  });

  it("has unique milestone keys", () => {
    const keys = PLAN.map((r) => r.milestone_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every KPI-scoring plan row a planned date", () => {
    for (const r of PLAN.filter((x) => x.milestone_type === "plan")) {
      expect(r.planned_date, r.milestone_key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("leaves SOC 2 dateless — it is named in the intro but absent from the plan table", () => {
    const soc2 = PLAN.find((r) => r.milestone_key === "FT-SOC2")!;
    expect(soc2.milestone_type).toBe("framework_target");
    expect(soc2.planned_date).toBeNull();
  });

  it("splits NCA into ECC and DCC, both due April 2027", () => {
    const nca = PLAN.filter((r) => r.regulation_code?.startsWith("NCA-"));
    expect(nca.map((r) => r.regulation_code).sort()).toEqual(["NCA-DCC", "NCA-ECC"]);
    for (const r of nca) expect(r.planned_date).toBe("2027-04-30");
  });

  it("references only framework codes that exist in the platform", () => {
    const known = new Set([
      "PDPL", "SAMA-CSF", "NCA-ECC", "NCA-DCC",
      "ISO-9001", "ISO-27001", "SOC2", "PCI-DSS", "SACS-002",
    ]);
    for (const r of PLAN) {
      if (r.regulation_code !== null) {
        expect(known.has(r.regulation_code), r.regulation_code!).toBe(true);
      }
    }
  });

  it("honours the document's one explicit date", () => {
    expect(PLAN.find((r) => r.milestone_key === "PLAN-2026-08-DOCS")!.planned_date)
      .toBe("2026-08-30");
  });
});

describe("resolveMilestoneRegulationIds", () => {
  it("maps framework codes to ids and leaves unmatched rows null", () => {
    const rows = [
      { ...PLAN[0], regulation_code: null },
      { ...PLAN[0], milestone_key: "X-ISO", regulation_code: "ISO-27001" },
      { ...PLAN[0], milestone_key: "X-GONE", regulation_code: "NOT-SEEDED" },
    ];
    const out = resolveMilestoneRegulationIds(rows, { "ISO-27001": 6 });
    expect(out[0].regulation_id).toBeNull();
    expect(out[1].regulation_id).toBe(6);
    expect(out[2].regulation_id).toBeNull();
  });

  it("never drops rows", () => {
    const out = resolveMilestoneRegulationIds(PLAN, {});
    expect(out).toHaveLength(PLAN.length);
  });
});
