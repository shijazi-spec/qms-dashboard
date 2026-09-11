/**
 * Document compliance is judged on the DEAL's own attachments. Nothing else.
 *
 * Between 2026-09-03 and 09-06 this module also accepted the three company
 * certificates (VAT, Commercial Registration, National Address) from the linked
 * Account, on the theory that documents which do not change per deal would be
 * filed once at Account level. The live data refuted it: every Account sampled
 * returned ZERO attachments while its deals returned files, and both Rawabi
 * Holding and مؤسسة الاسكان had VAT, CR and National Address attached to the
 * DEAL. Sarah settled it on 2026-09-06 — "Deals is the place that will have the
 * documents, not the accounts" — so the Account lookup was removed.
 *
 * These tests pin that it stays removed, and keep the file-name matching that
 * the episode did earn: MSA, SOW and numbered invoices, which the matcher had
 * been silently failing to recognise.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  evaluateDocCompliance,
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

describe("only the deal's own attachments count", () => {
  it("never reads an account — only the deal's own evidence", () => {
    // This used to assert arity 2, on the reasoning that "a third argument
    // would be silently ignored, so the arity IS the contract". A third
    // argument arrived on 2026-09-11 — the DEAL's own CR/VAT numbers, since
    // Sarah ruled those satisfy the requirement as well as the certificate.
    // Giving it a default would have kept .length at 2 and left this test
    // passing while quietly meaning nothing, so it now asserts the rule
    // itself: nothing in this module reaches for an account.
    //
    // Scanned with comments STRIPPED: this file's header explains at length
    // why the Account lookup was removed and must not be reintroduced, so a
    // raw scan matches its own documentation and fails. Same trap as
    // check-i18n.cjs reading t('key') out of a comment.
    const SRC = readFileSync(
      join(__dirname, "../../src/utils/dealComplianceCheck.ts"),
      "utf8",
    );
    const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(CODE).not.toMatch(/account/i);
  });

  it("passes when the full set is on the deal", () => {
    const r = evaluateDocCompliance("Agreement Signed", f(...FULL));
    expect(r.compliant).toBe(true);
    expect(r.missingDocs).toEqual([]);
  });

  it("fails for documents that are not on the deal, wherever else they live", () => {
    const r = evaluateDocCompliance("Paid", f("Proposal.pdf", "Contract.pdf"));
    expect(r.compliant).toBe(false);
    expect(r.missingDocs.map((m) => m.key).sort()).toEqual([
      "commercial_registration",
      "national_address",
      "vat",
    ]);
  });

  it("counts only the deal's files", () => {
    const r = evaluateDocCompliance("Paid", f("Proposal.pdf"));
    expect(r.attachmentCount).toBe(1);
  });

  it("reports no source or account fields", () => {
    // Leftovers from the Account experiment would imply a lookup that no
    // longer happens.
    const r = evaluateDocCompliance("Paid", f(...FULL)) as unknown as Record<string, unknown>;
    expect(r.accountAttachmentCount).toBeUndefined();
    expect((r.presentDocs as any[])[0].source).toBeUndefined();
  });

  it("still requires all five at a closing stage", () => {
    expect(requiredDocsForStage("Paid").map((d) => d.key)).toEqual([
      "proposal_sent",
      "quotation_agreement",
      "vat",
      "commercial_registration",
      "national_address",
    ]);
  });

  it("requires only the financial offer at Proposal", () => {
    expect(requiredDocsForStage("Proposal").map((d) => d.key)).toEqual([
      "financial_offer",
    ]);
  });
});

describe("contracts filed under the abbreviations the business actually uses", () => {
  // From Riyad Bank's real attachment list. Writing the test against the true
  // file names is what exposed these: the matcher knew "agreement" and
  // "contract" but not "MSA" or "SOW", and "invoice" but not "INV-26124340".
  const matches = (fileName: string) =>
    evaluateDocCompliance(
      "Paid",
      f("Proposal.pdf", fileName, "VAT.pdf", "CR.pdf", "National Address.pdf"),
    ).presentDocs.some((p) => p.key === "quotation_agreement");

  it("recognises a Master Service Agreement", () => {
    expect(matches("msa for RB Employee Program Wala plus ag#88206.pdf")).toBe(true);
  });

  it("recognises a Statement of Work", () => {
    expect(matches("sow for RB Employee Program Wala plus.pdf")).toBe(true);
  });

  it("recognises an invoice numbered rather than named", () => {
    expect(matches("INV-26124340.pdf")).toBe(true);
  });

  it("still recognises the spelled-out forms", () => {
    for (const n of [
      "Service Agreement signed.pdf",
      "Contract final.pdf",
      "Quotation.pdf",
      "عقد.pdf",
    ]) {
      expect(matches(n)).toBe(true);
    }
  });

  it("does not fire on those letters inside a longer word", () => {
    expect(matches("Damsa report.pdf")).toBe(false);
    expect(matches("sowing season notes.pdf")).toBe(false);
  });
});
