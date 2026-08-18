/**
 * KPI → Sales SOP clause mapping for the detail page's "Process reference".
 *
 * The SOP that SALES-KPI-01/03/04 grade against is not in Document Control
 * (154 policies, 13 departments, no Sales or SDR process — checked 2026-08-18),
 * so the citation is derived from salesStageSlaSpec, the same constants that
 * drive the grading. That keeps the citation and the applied SLA from drifting.
 */
import { describe, it, expect } from "vitest";

import {
  getKpiProcessReference,
  SALES_SOP_DOCUMENT,
  SALES_STAGE_SLA_SPEC,
} from "../../src/utils/salesStageSlaSpec";

describe("KPIs that the SOP actually covers", () => {
  it("cites every stage clause for stage-aging compliance", () => {
    const r = getKpiProcessReference("SALES-KPI-01")!;
    expect(r.document).toBe(
      `${SALES_SOP_DOCUMENT.title} (${SALES_SOP_DOCUMENT.reference}, ${SALES_SOP_DOCUMENT.issued})`,
    );
    // It grades EVERY stage, so it must cite every clause — a partial list
    // would understate what the KPI enforces.
    expect(r.clauses).toHaveLength(SALES_STAGE_SLA_SPEC.length);
    expect(r.clauses.map((c) => c.stage)).toEqual(
      SALES_STAGE_SLA_SPEC.map((s) => s.stage),
    );
  });

  it("cites only the Proposal clause for proposal cycle time", () => {
    const r = getKpiProcessReference("SALES-KPI-03")!;
    expect(r.clauses).toHaveLength(1);
    expect(r.clauses[0].stage).toBe("Proposal");
    expect(r.clauses[0].sla).toMatch(/7\.4\.2/);
  });

  it("cites only the Agreement Sent clause for agreement cycle time", () => {
    const r = getKpiProcessReference("SALES-KPI-04")!;
    expect(r.clauses).toHaveLength(1);
    expect(r.clauses[0].stage).toBe("Agreement Sent");
    expect(r.clauses[0].sla).toMatch(/7\.5\.1/);
  });

  it("reuses describeSla, so the citation cannot drift from the applied SLA", () => {
    const r = getKpiProcessReference("SALES-KPI-01")!;
    const meeting = r.clauses.find((c) => c.stage === "Meeting")!;
    // 10 business days is what gradeStageAging enforces; if someone edits the
    // spec, this text moves with it rather than becoming a stale quote.
    expect(meeting.sla).toMatch(/10 business days/);
    expect(meeting.sla).toMatch(/7\.3\b/);
  });
});

describe("KPIs the SOP does NOT cover", () => {
  it("returns null rather than inventing a clause", () => {
    // Win rate, document compliance, CRM accuracy, follow-up, first-contact and
    // duplicates have no clause in this SOP. A citation here would be one an
    // auditor could not trace to the document.
    for (const code of [
      "SALES-KPI-02", "SALES-KPI-05", "SALES-KPI-06",
      "SALES-KPI-07", "SALES-KPI-08", "SALES-KPI-09",
    ]) {
      expect(getKpiProcessReference(code), `${code} should have no reference`).toBeNull();
    }
  });

  it("returns null for SDR, ad-hoc and unknown codes", () => {
    expect(getKpiProcessReference("SDR-KPI-01")).toBeNull();
    expect(getKpiProcessReference("ADHOC-SALES-01")).toBeNull();
    expect(getKpiProcessReference("")).toBeNull();
    expect(getKpiProcessReference("NOPE-1")).toBeNull();
  });
});
