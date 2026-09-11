/**
 * Filenames the matcher missed on Ziad's signed deals, taken from the first
 * live run of the unmatched-file capture (2026-09-12).
 *
 * Ziad said documents were attached and the platform was not reading them.
 * These are the actual names, verbatim from production, that proved him right:
 * real signed agreements and quotations sitting on deals we were reporting as
 * missing documents. Not a speculative keyword list — every entry below was
 * observed.
 *
 * The counter-cases matter as much. A large share of what is attached is
 * genuinely not a required document — WhatsApp photos, logos, ID cards, Xerox
 * scans, CS launch forms — and widening the matcher until those pass would
 * turn a report that understates compliance into one that overstates it.
 */
import { describe, it, expect } from "vitest";
import { evaluateDocCompliance } from "../../src/utils/dealComplianceCheck";

const att = (fileName: string) => ({ fileName }) as any;
/** Does this filename satisfy the contract/quotation requirement? */
const readsAsContract = (name: string) =>
  evaluateDocCompliance("Agreement Signed", [att(name)]).presentDocs.some(
    (p) => p.key === "quotation_agreement",
  );

describe("real filenames we were failing to read", () => {
  const REAL: Array<[string, string]> = [
    ["Agreemnt - ACE Gallagher Arabia Insurance Brokers (002) 06-01-2025 (1) (1).pdf", "agreement, misspelled"],
    ["WalaPlus Aggrement- Signed.pdf", "agreement, misspelled the other way"],
    ["QT - Drsulaimanalhabib.pdf", "QT = quotation"],
    ["Qt suشركة المنطقة الخاصة.pdf", "QT, lowercase, Arabic company"],
    ["PA_KFUPM-2025-AGR98_0.pdf", "AGR = agreement"],
    ["3-APO-2500241 (1).pdf", "APO — \\bPO\\b cannot fire mid-word"],
  ];

  for (const [name, why] of REAL) {
    it(`reads "${name.slice(0, 40)}…" (${why})`, () => {
      expect(readsAsContract(name)).toBe(true);
    });
  }

  it("reads an invoice whose name is prefixed with an underscore", () => {
    // `_` is a word character, so `\binv` has NO boundary after it. Zoho's own
    // invoice exports are named exactly this way and three were hidden by that
    // single subtlety. Found in the full re-check, 2026-09-12.
    expect(readsAsContract("310218493500003_20251202T134436_INV25-370163.pdf")).toBe(true);
    expect(readsAsContract("310218493500003_20251224T124140_INV25-379995.pdf")).toBe(true);
  });

  it("reads an agreement named in Arabic for the act of signing", () => {
    expect(readsAsContract("WalaPuls 2_0001(1)si (1) (1) بعد التوقيع.pdf")).toBe(true);
  });

  it("still reads the spellings it always did", () => {
    for (const n of [
      "Service Agreement - WalaPlus.pdf",
      "PO - ولاء بلس 2025.pdf",
      "INV-006953.pdf",
      "__Mukatafa - اتفاقية (1).pdf",
      "msa for RB Employee Program.pdf",
    ]) {
      expect(readsAsContract(n), n).toBe(true);
    }
  });
});

describe("proof-of-address is the National Address", () => {
  const readsAsAddress = (name: string) =>
    evaluateDocCompliance("Agreement Signed", [att(name)]).presentDocs.some(
      (p) => p.key === "national_address",
    );

  it("reads the name the issuing service prints on it", () => {
    // The worst-performing requirement in the set — 401 of 494 missing — so
    // reading it correctly matters more here than anywhere else.
    expect(readsAsAddress("proof-of-address (1).png")).toBe(true);
    expect(readsAsAddress("14.08.2025 proof-of-address.pdf")).toBe(true);
    expect(readsAsAddress("Proof Of Address.pdf")).toBe(true);
  });

  it("still reads the names it always did", () => {
    expect(readsAsAddress("National Address.pdf")).toBe(true);
    expect(readsAsAddress("العنوان الوطني.pdf")).toBe(true);
  });

  it("does not fire on an unrelated address", () => {
    expect(readsAsAddress("email address list.xlsx")).toBe(false);
  });
});

describe("what must NOT be read as a required document", () => {
  // Widening the matcher until these pass would replace a report that
  // understates compliance with one that overstates it — the worse failure,
  // because nobody questions a clean number.
  const NOISE = [
    "WhatsApp Image 2025-02-09 at 8.47.12 AM.jpeg",
    "Logo.png",
    "LOGO MCR (1).jpg",
    "KFUPM ID.jpg",
    "image.png",
    "Employee_Report.xlsx",
    "Luberef Employment Emails.xlsx",
    "نموذج تدشين .pdf",
    "FourPrinciples cs form.pdf",
    "Badeel - Zakat.PDF",
    "ACCOUNT_STATEMENT_DETAILS_1759641056355.pdf",
  ];

  for (const n of NOISE) {
    it(`does not treat "${n.slice(0, 36)}…" as a contract`, () => {
      expect(readsAsContract(n)).toBe(false);
    });
  }

  it("the new abbreviations stay word-bounded", () => {
    // \bqt\b and \bagr\b must not fire inside ordinary words, and the PO rule
    // requires a following number.
    for (const n of ["quantity report.pdf", "agriculture survey.pdf", "apology letter.pdf"]) {
      expect(readsAsContract(n), n).toBe(false);
    }
  });
});
