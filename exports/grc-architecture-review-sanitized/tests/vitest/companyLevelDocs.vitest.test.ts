/**
 * Company documents are checked on the ACCOUNT, deal documents on the DEAL.
 *
 * Measured on live data 2026-09-02: of 1,077 deals marked non-compliant, 813
 * were missing "National Address", 805 the CR and 795 the VAT certificate —
 * and 513 of those deals DID carry attachments. Riyad Bank was flagged
 * non-compliant while holding 18 files including the MSA, the SOW, the PO and
 * the invoice; the only things "missing" were the three company certificates.
 *
 * A VAT certificate does not change between deals, so the business files it
 * once on the Account. Checking it per deal measured filing convention, not
 * compliance, and produced a 96-100% failure rate that would not have survived
 * its first meeting with Sales (Sample User change 2026-09-03).
 *
 * The dangerous half of this change is the part that must NOT happen: deal
 * documents must never be satisfied from the Account. One signed contract on a
 * shared Account would otherwise mark a whole company's pipeline compliant.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateDocCompliance,
  isCompanyLevelDoc,
  requiredDocsForStage,
} from "../../src/utils/dealComplianceCheck";

const f = (...names: string[]) => names.map((fileName) => ({ fileName }));

const FULL = [
  "Proposal v3.pdf",
  "Service Agreement signed.pdf",
  "VAT certificate.pdf",
  "Commercial Registration.pdf",
  "National Address.pdf",
];

describe("which documents belong to the company", () => {
  it("classifies the three certificates as company-level", () => {
    expect(isCompanyLevelDoc("vat")).toBe(true);
    expect(isCompanyLevelDoc("commercial_registration")).toBe(true);
    expect(isCompanyLevelDoc("national_address")).toBe(true);
  });

  it("classifies deal paperwork as NOT company-level", () => {
    expect(isCompanyLevelDoc("proposal_sent")).toBe(false);
    expect(isCompanyLevelDoc("quotation_agreement")).toBe(false);
    expect(isCompanyLevelDoc("financial_offer")).toBe(false);
  });

  it("covers every required doc for a closing stage", () => {
    // If a new required document is added, this test forces a decision about
    // which side of the line it falls on rather than defaulting to "deal".
    const keys = requiredDocsForStage("Paid").map((d) => d.key);
    expect(keys).toEqual([
      "proposal_sent",
      "quotation_agreement",
      "vat",
      "commercial_registration",
      "national_address",
    ]);
  });
});

describe("contracts filed under the abbreviations the business actually uses", () => {
  // From Riyad Bank's real attachment list, 2026-09-02. Writing the test
  // against the true file names is what exposed these: the matcher knew
  // "agreement" and "contract" but not "MSA" or "SOW", and knew "invoice" but
  // not "INV-26124340".
  const matches = (fileName: string) =>
    evaluateDocCompliance("Paid", f("Proposal.pdf", fileName, "VAT.pdf", "CR.pdf", "National Address.pdf"))
      .presentDocs.some((p) => p.key === "quotation_agreement");

  it("recognises a Master Service Agreement", () => {
    expect(matches("msa for RB Employee Program ExampleOrg ag#88206.pdf")).toBe(true);
  });

  it("recognises a Statement of Work", () => {
    expect(matches("sow for RB Employee Program ExampleOrg.pdf")).toBe(true);
  });

  it("recognises an invoice numbered rather than named", () => {
    expect(matches("INV-26124340.pdf")).toBe(true);
  });

  it("still recognises the spelled-out forms", () => {
    for (const n of ["Service Agreement signed.pdf", "Contract final.pdf", "Quotation.pdf", "عقد.pdf"]) {
      expect(matches(n)).toBe(true);
    }
  });

  it("does not fire on those letters inside a longer word", () => {
    // "msa" and "sow" are short; unbounded they would match "Damsa", "sowing".
    expect(matches("Damsa report.pdf")).toBe(false);
    expect(matches("sowing season notes.pdf")).toBe(false);
  });
});

describe("company documents may come from the Account", () => {
  it("passes a deal whose certificates live on the Account", () => {
    // The Riyad Bank shape, reduced: real deal paperwork on the deal, the
    // three certificates filed once on the company.
    const r = evaluateDocCompliance(
      "Agreement Signed",
      f("msa for RB Employee Program.pdf", "Proposal sent.pdf"),
      f("VAT certificate.pdf", "Commercial Registration.pdf", "National Address.pdf"),
    );
    expect(r.compliant).toBe(true);
    expect(r.missingDocs).toEqual([]);
  });

  it("records WHERE each document was found", () => {
    const r = evaluateDocCompliance(
      "Paid",
      f("Proposal v1.pdf", "Contract.pdf"),
      f("VAT cert.pdf", "CR.pdf", "National Address.pdf"),
    );
    const bySource = Object.fromEntries(r.presentDocs.map((p) => [p.key, p.source]));
    expect(bySource.proposal_sent).toBe("deal");
    expect(bySource.quotation_agreement).toBe("deal");
    expect(bySource.vat).toBe("account");
    expect(bySource.commercial_registration).toBe("account");
    expect(bySource.national_address).toBe("account");
  });

  it("prefers the deal's own copy when the certificate is attached to both", () => {
    const r = evaluateDocCompliance(
      "Paid",
      f("Proposal.pdf", "Contract.pdf", "VAT certificate DEAL.pdf", "CR.pdf", "National Address.pdf"),
      f("VAT certificate ACCOUNT.pdf"),
    );
    const vat = r.presentDocs.find((p) => p.key === "vat")!;
    expect(vat.source).toBe("deal");
    expect(vat.fileName).toContain("DEAL");
  });

  it("still fails when the certificates are on neither", () => {
    const r = evaluateDocCompliance("Paid", f("Proposal.pdf", "Contract.pdf"), f("random.pdf"));
    expect(r.compliant).toBe(false);
    expect(r.missingDocs.map((m) => m.key).sort()).toEqual([
      "commercial_registration",
      "national_address",
      "vat",
    ]);
  });
});

describe("deal documents are NEVER satisfied from the Account", () => {
  it("does not accept a contract filed on the shared Account", () => {
    // The failure this guard exists to prevent: one signed contract on an
    // Account marking every deal for that company compliant.
    const r = evaluateDocCompliance(
      "Paid",
      f("VAT.pdf", "CR.pdf", "National Address.pdf"),
      f("Service Agreement signed.pdf", "Proposal v9.pdf"),
    );
    expect(r.compliant).toBe(false);
    expect(r.missingDocs.map((m) => m.key).sort()).toEqual([
      "proposal_sent",
      "quotation_agreement",
    ]);
  });

  it("does not accept the Proposal-stage financial offer from the Account", () => {
    const r = evaluateDocCompliance("Proposal", f("unrelated.pdf"), f("العرض المالي.pdf"));
    expect(r.compliant).toBe(false);
    expect(r.missingDocs[0].key).toBe("financial_offer");
  });
});

describe("behaviour without an Account", () => {
  it("is unchanged when no account attachments are supplied", () => {
    // Every existing caller that passes only the deal must behave exactly as
    // before — including the sweep's fallback when an Account is unreadable.
    const before = evaluateDocCompliance("Paid", f(...FULL));
    expect(before.compliant).toBe(true);
    expect(before.accountAttachmentCount).toBeUndefined();
    const partial = evaluateDocCompliance("Paid", f("Proposal.pdf", "Contract.pdf"));
    expect(partial.compliant).toBe(false);
    expect(partial.missingDocs).toHaveLength(3);
  });

  it("treats an empty Account attachment list as 'nothing there', not as absent", () => {
    const r = evaluateDocCompliance("Paid", f("Proposal.pdf", "Contract.pdf"), []);
    expect(r.compliant).toBe(false);
    expect(r.accountAttachmentCount).toBe(0);
  });
});

describe("the attachment count still describes the DEAL", () => {
  it("does not fold Account files into the deal's count", () => {
    // The operator sees this number against the deal record; inflating it with
    // the Account's files would make a bare deal look documented.
    const r = evaluateDocCompliance("Paid", f("Proposal.pdf"), f("a.pdf", "b.pdf", "c.pdf"));
    expect(r.attachmentCount).toBe(1);
    expect(r.accountAttachmentCount).toBe(3);
  });
});
