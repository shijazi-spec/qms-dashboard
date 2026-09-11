/**
 * Agreement Sent — checked, and graded on ONE document.
 *
 * Sarah, 2026-09-11: "agreement sent at least shall have the proposal that
 * sent before, so it shall be checked too." 32 WalaPlus deals sit at this
 * stage: the agreement is out, awaiting signature, which is the last moment
 * getting the paperwork straight is cheap.
 *
 * The trap this test exists for: "agreement sent" was ALREADY in
 * FULL_DOC_STAGES, demanding all five documents — including a signed contract
 * that by definition cannot exist at a stage defined by the agreement being
 * out for signature. All 32 deals would have failed as a matter of arithmetic,
 * not of conduct. It was invisible only because the stage was missing from
 * DEAL_COMPLIANCE_STAGES, so nothing was ever checked. Adding the stage
 * without removing it from FULL_DOC_STAGES would have shipped the defect
 * wearing the feature's name.
 *
 * SOP 7.5.10 requires the full set at Agreement Signed / Paid. Not before.
 */
import { describe, it, expect } from "vitest";
import {
  requiredDocsForStage,
  evaluateDocCompliance,
  DEAL_COMPLIANCE_STAGES,
} from "../../src/utils/dealComplianceCheck";
import {
  REPORT_STAGES,
  EXPORT_STAGES,
} from "../../src/utils/dealComplianceReportExport";

const att = (fileName: string) => ({ fileName }) as any;

describe("what Agreement Sent requires", () => {
  it("requires exactly one document", () => {
    expect(requiredDocsForStage("Agreement Sent")).toHaveLength(1);
  });

  it("requires the proposal that was sent, not the signed contract", () => {
    const [doc] = requiredDocsForStage("Agreement Sent");
    expect(doc.key).toBe("proposal_sent");
  });

  it("does NOT demand the statutory papers that are only due at signature", () => {
    const keys = requiredDocsForStage("Agreement Sent").map((d) => d.key);
    for (const k of ["vat", "commercial_registration", "national_address"]) {
      expect(keys, `${k} is not due until Agreement Signed`).not.toContain(k);
    }
  });

  it("is case- and whitespace-insensitive, like every other stage", () => {
    expect(requiredDocsForStage("  agreement sent  ")).toHaveLength(1);
    expect(requiredDocsForStage("AGREEMENT SENT")).toHaveLength(1);
  });

  it("Agreement Signed still requires the full five", () => {
    // Removing "agreement sent" from FULL_DOC_STAGES must not have disturbed
    // the stage the SOP actually governs.
    expect(requiredDocsForStage("Agreement Signed")).toHaveLength(5);
    expect(requiredDocsForStage("Paid")).toHaveLength(5);
  });
});

describe("a deal at Agreement Sent can actually pass", () => {
  it("passes with the proposal attached", () => {
    // The point of the whole change: a reachable standard. Under the old
    // FULL_DOC_STAGES entry this deal would have failed on four counts.
    const r = evaluateDocCompliance("Agreement Sent", [
      att("Proposal v3 - final.pdf"),
    ]);
    expect(r.compliant).toBe(true);
    expect(r.missingDocs).toHaveLength(0);
  });

  it("fails when no proposal is attached", () => {
    const r = evaluateDocCompliance("Agreement Sent", [att("site visit.jpg")]);
    expect(r.compliant).toBe(false);
    expect(r.missingDocs.map((m) => m.key)).toEqual(["proposal_sent"]);
    expect(r.unmatchedFiles).toEqual(["site visit.jpg"]);
  });

  it("keeps the document satisfied when the deal moves Sent -> Signed", () => {
    // Same doc key both sides, so a deal does not appear to LOSE a document it
    // already has the moment its stage advances.
    const sent = evaluateDocCompliance("Agreement Sent", [att("Proposal.pdf")]);
    const signed = evaluateDocCompliance("Agreement Signed", [att("Proposal.pdf")]);
    expect(sent.presentDocs[0].key).toBe("proposal_sent");
    expect(signed.presentDocs.map((p) => p.key)).toContain("proposal_sent");
  });
});

describe("where the stage appears", () => {
  it("is swept, displayed and exported", () => {
    expect(DEAL_COMPLIANCE_STAGES).toContain("Agreement Sent");
    expect(EXPORT_STAGES).toContain("Agreement Sent");
  });

  it("is counted in the Head of Sales email", () => {
    expect(REPORT_STAGES).toContain("Agreement Sent");
  });

  it("Paid stays OUT of the email and IN the export", () => {
    // Confirmed again 2026-09-11: Paid is Customer Success's once a deal is
    // won. This is the rule that keeps getting "fixed" by someone noticing
    // Paid missing from the email.
    expect(REPORT_STAGES as readonly string[]).not.toContain("Paid");
    expect(EXPORT_STAGES as readonly string[]).toContain("Paid");
  });
});
