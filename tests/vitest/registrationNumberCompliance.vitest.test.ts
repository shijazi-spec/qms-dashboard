/**
 * CR and VAT: the certificate OR a genuine recorded number.
 *
 * Sarah, 2026-09-11: "since you have the document of the CR or VAT it's ok,
 * since it's added as data real it's ok, that's compliant, but if there is
 * both not here so it's non-compliant, and the dummy data is a part of the
 * non-compliant too."
 *
 * Measured on the WalaPlus signed book the same evening, which is why the
 * dummy rule is not optional: of 271 deals carrying CR text only 134 held a
 * real number; of 271 carrying VAT text, 99. The rest were `00`,
 * `0000000000`, `....`, values far too short — and two Saudi MOBILE numbers
 * (`0507327065`), which are exactly ten digits and would sail through any
 * length-only check.
 *
 * Only CR and VAT work this way. A proposal or a contract cannot be recorded
 * as data, and nothing here reaches for an Account.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateDocCompliance,
  isRealRegistrationNumber,
} from "../../src/utils/dealComplianceCheck";

const att = (fileName: string) => ({ fileName }) as any;
const CR = "1010954387";
const VAT = "311922627400003";

describe("what counts as a real number", () => {
  it("accepts a genuine CR and VAT", () => {
    expect(isRealRegistrationNumber(CR, "cr")).toBe(true);
    expect(isRealRegistrationNumber(VAT, "vat")).toBe(true);
  });

  it("reads through separators and labels", () => {
    expect(isRealRegistrationNumber("CR 1010954387", "cr")).toBe(true);
    expect(isRealRegistrationNumber("3119 2262 7400 003", "vat")).toBe(true);
  });

  it("rejects the zeros, which are dummy data", () => {
    for (const v of ["0", "00", "0000000000", "000000000000000", "00000-00000"]) {
      expect(isRealRegistrationNumber(v, "cr"), v).toBe(false);
      expect(isRealRegistrationNumber(v, "vat"), v).toBe(false);
    }
  });

  it("rejects a Saudi mobile number masquerading as a CR", () => {
    // Ten digits, so length alone passes it. A real CR never leads with 0.
    expect(isRealRegistrationNumber("0507327065", "cr")).toBe(false);
    expect(isRealRegistrationNumber("0507792529", "cr")).toBe(false);
  });

  it("rejects any repeated single digit, not only zero", () => {
    expect(isRealRegistrationNumber("7777777777", "cr")).toBe(false);
  });

  it("rejects text, dots and the wrong length", () => {
    for (const v of ["....", "..", "77", "70058633", "", null, undefined]) {
      expect(isRealRegistrationNumber(v, "cr"), String(v)).toBe(false);
    }
    expect(isRealRegistrationNumber(CR, "vat")).toBe(false); // 10 ≠ 15
    expect(isRealRegistrationNumber(VAT, "cr")).toBe(false); // 15 ≠ 10
  });
});

describe("either the document or the data satisfies the requirement", () => {
  const others = [
    att("Proposal v3.pdf"),
    att("Service Agreement.pdf"),
    att("National Address.pdf"),
  ];

  it("the certificate alone is enough", () => {
    const r = evaluateDocCompliance("Agreement Signed", [
      ...others,
      att("CR certificate.pdf"),
      att("VAT certificate.pdf"),
    ]);
    expect(r.compliant).toBe(true);
    expect(r.presentDocs.find((p) => p.key === "commercial_registration")!.via).toBe("attachment");
  });

  it("a genuine recorded number alone is enough", () => {
    const r = evaluateDocCompliance("Agreement Signed", others, {
      crNumber: CR,
      vatNumber: VAT,
    });
    expect(r.compliant).toBe(true);
    const cr = r.presentDocs.find((p) => p.key === "commercial_registration")!;
    expect(cr.via).toBe("field");
    expect(cr.fileName).toBe("[recorded as data]");
  });

  it("neither present is non-compliant", () => {
    const r = evaluateDocCompliance("Agreement Signed", others);
    expect(r.compliant).toBe(false);
    expect(r.missingDocs.map((m) => m.key).sort()).toEqual([
      "commercial_registration",
      "vat",
    ]);
  });

  it("DUMMY data is non-compliant, exactly like an empty field", () => {
    // The whole point. A field stuffed with zeros to get past validation must
    // not read as evidence.
    const r = evaluateDocCompliance("Agreement Signed", others, {
      crNumber: "0000000000",
      vatNumber: "000000000000000",
    });
    expect(r.compliant).toBe(false);
    expect(r.missingDocs.map((m) => m.key).sort()).toEqual([
      "commercial_registration",
      "vat",
    ]);
  });

  it("prefers the document when both exist, and says so", () => {
    const r = evaluateDocCompliance(
      "Agreement Signed",
      [...others, att("CR certificate.pdf"), att("VAT cert.pdf")],
      { crNumber: CR, vatNumber: VAT },
    );
    expect(r.presentDocs.find((p) => p.key === "commercial_registration")!.via).toBe("attachment");
  });

  it("does NOT extend the rule to the other three documents", () => {
    // A proposal cannot be "recorded as data". Passing numbers must not
    // accidentally satisfy anything else.
    const r = evaluateDocCompliance("Agreement Signed", [], {
      crNumber: CR,
      vatNumber: VAT,
    });
    expect(r.missingDocs.map((m) => m.key).sort()).toEqual([
      "national_address",
      "proposal_sent",
      "quotation_agreement",
    ]);
  });

  it("leaves Proposal and Agreement Sent untouched", () => {
    // Neither stage requires CR or VAT, so a recorded number changes nothing.
    expect(evaluateDocCompliance("Proposal", [], { crNumber: CR }).compliant).toBe(false);
    expect(
      evaluateDocCompliance("Agreement Sent", [att("Proposal.pdf")], { crNumber: CR })
        .compliant,
    ).toBe(true);
  });
});
