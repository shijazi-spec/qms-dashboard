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
  SALES_SOP_DOCUMENT,
  SALES_STAGE_SLA_SPEC,
} from "../../src/utils/salesStageSlaSpec";
import {
  getKpiProcessReference,
  CS_SOP_DOCUMENT,
} from "../../src/utils/kpiProcessReference";

describe("KPIs that the SOP actually covers", () => {
  it("cites every stage clause for stage-aging compliance", () => {
    const r = getKpiProcessReference("SALES-KPI-01")!;
    expect(r.document).toBe(
      `${SALES_SOP_DOCUMENT.title} (${SALES_SOP_DOCUMENT.reference} v${SALES_SOP_DOCUMENT.version}, ${SALES_SOP_DOCUMENT.issued})`,
    );
    // Cite the RELEASED version, not the newest file on the drive. v1.2 exists
    // as an EN .docx with no PDF and its Arabic marked "(lesa)" — not yet — so
    // it is an unreleased revision. The old citation also used "WP-SOP Sales",
    // a code the document never carried; its cover page has a real Document
    // Code block, which is version-stamped.
    expect(r.document).toContain("v1.1");
    expect(r.document).toContain("WalaPlus_Sales_1.1_01.12.2025");
    expect(r.document).not.toContain("WP-SOP");
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

  it("returns null for unmapped SDR, ad-hoc and unknown codes", () => {
    expect(getKpiProcessReference("SDR-KPI-01")).toBeNull();
    expect(getKpiProcessReference("ADHOC-SALES-01")).toBeNull();
    expect(getKpiProcessReference("")).toBeNull();
    expect(getKpiProcessReference("NOPE-1")).toBeNull();
  });
});

describe("SDR — WalaPlus_SDR v2.2", () => {
  it("cites the document and the table, with the SOP's own calculation", () => {
    const r = getKpiProcessReference("SDR-KPI-12")!;
    expect(r.document).toContain("WalaPlus_SDR v2.2");
    expect(r.document).toContain("08.12.2025");
    expect(r.section).toBe("Individual KPIs table");
    expect(r.clauses[0].stage).toBe("Booking Conversion Rate");
    // The formula and target are quoted from the document, not invented — the
    // ad-hoc KPI this replaced carried a 20% target that appears nowhere in
    // governance.
    expect(r.clauses[0].sla).toMatch(/Booked meetings/);
    expect(r.clauses[0].sla).toMatch(/40%/);
  });

  it("cites the SOP's Successful Meetings formula for Show Rate", () => {
    const r = getKpiProcessReference("SDR-KPI-05")!;
    expect(r.clauses[0].stage).toBe("Successful Meetings");
    expect(r.clauses[0].sla).toMatch(/Client attend meeting/);
  });

  it("does not cite a clause number the SDR table does not carry", () => {
    // The SDR KPI table is not numbered as a clause. Section only.
    for (const code of ["SDR-KPI-12", "SDR-KPI-05"]) {
      expect(getKpiProcessReference(code)!.section).not.toMatch(/\d+\.\d+/);
    }
  });
});

describe("Customer Success — WP-BU-CS-SOP-003", () => {
  it("names the controlled document with its version", () => {
    const r = getKpiProcessReference("CS-KPI-01")!;
    expect(r.document).toContain(CS_SOP_DOCUMENT.reference);
    expect(r.document).toContain("v1.1");
    expect(r.document).toContain("13.08.2026");
  });

  it("cites the section of the SOP that defines each tier", () => {
    expect(getKpiProcessReference("CS-KPI-01")!.section).toBe("8.1 Individual KPIs");
    expect(getKpiProcessReference("CS-KPI-08")!.section).toBe("8.1 Individual KPIs");
    expect(getKpiProcessReference("CS-KPI-09")!.section).toBe("8.2 Process KPIs");
    expect(getKpiProcessReference("CS-KPI-22")!.section).toBe("8.2 Process KPIs");
    expect(getKpiProcessReference("CS-KPI-23")!.section).toBe("8.3 Governance KPIs");
    expect(getKpiProcessReference("CS-KPI-33")!.section).toBe("8.3 Governance KPIs");
  });

  it("cites a SECTION, never an invented clause number", () => {
    // The SOP's §8 KPI tables carry no per-KPI clause reference. Naming one
    // would be fabricating a citation an auditor could not trace, which is
    // worse than a blank field because it reads as evidence.
    for (const code of ["CS-KPI-01", "CS-KPI-14", "CS-KPI-33"]) {
      expect(getKpiProcessReference(code)!.clauses).toEqual([]);
    }
  });

  it("adds the SLA table only for the KPI that grades against it", () => {
    // Section 9 IS the list of timeframes CS-KPI-25 measures adherence to.
    const sla = getKpiProcessReference("CS-KPI-25")!;
    expect(sla.clauses).toHaveLength(1);
    expect(sla.clauses[0].sla).toMatch(/Section 9/);
    expect(getKpiProcessReference("CS-KPI-24")!.clauses).toEqual([]);
  });

  it("ignores codes outside the document's numbering", () => {
    expect(getKpiProcessReference("CS-KPI-00")).toBeNull();
    expect(getKpiProcessReference("CS-KPI-34")).toBeNull();
    expect(getKpiProcessReference("CS-KPI-1")).toBeNull();
  });
});
