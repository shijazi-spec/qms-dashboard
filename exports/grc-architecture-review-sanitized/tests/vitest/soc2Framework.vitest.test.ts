/**
 * SOC 2 framework — seed integrity and citation recognition.
 *
 * The failure this guards against: seeding the SOC 2 regulation and its criteria
 * WITHOUT teaching clauseCitationExtractor about them produces a framework whose
 * coverage is structurally 0% forever — the column appears, every cell reads
 * "not mapped", and nothing can ever create a link. The extractor assertions
 * below are the load-bearing half of the feature.
 */

import { describe, expect, test } from "vitest";
import { SOC2_OBLIGATION_DEFINITIONS } from "../../src/utils/seeds/soc2Obligations";
import {
  extractRawCitations,
  canonicaliseFramework,
} from "../../src/utils/clauseCitationExtractor";

describe("SOC 2 seed", () => {
  test("covers the full Trust Services Criteria set", () => {
    expect(SOC2_OBLIGATION_DEFINITIONS.length).toBeGreaterThanOrEqual(33);
    const cc = SOC2_OBLIGATION_DEFINITIONS.filter((d) =>
      d.code.startsWith("SOC2-CC"),
    );
    // CC1-CC9 are mandatory for every SOC 2 report.
    expect(cc.length).toBe(33);
  });

  test("every code is SOC2- prefixed and unique", () => {
    const codes = SOC2_OBLIGATION_DEFINITIONS.map((d) => d.code);
    expect(codes.every((c) => c.startsWith("SOC2-"))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("section_order strictly increases so families keep TSC document order", () => {
    // CC first, then A1 / C1 / PI1 / P — section_order is the PRIMARY clause
    // sort, and alphabetically "A1.1" would otherwise precede "CC1.1".
    const orders = SOC2_OBLIGATION_DEFINITIONS.map((d) => d.order);
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]).toBeGreaterThan(orders[i - 1]);
    }
    const firstA1 = SOC2_OBLIGATION_DEFINITIONS.findIndex((d) =>
      d.code.startsWith("SOC2-A1."),
    );
    const lastCC = SOC2_OBLIGATION_DEFINITIONS.map((d) =>
      d.code.startsWith("SOC2-CC"),
    ).lastIndexOf(true);
    expect(firstA1).toBeGreaterThan(lastCC);
  });
});

describe("SOC 2 citation recognition", () => {
  test("all three ways SOC 2 is cited resolve to the same code", () => {
    for (const alias of ["SOC 2", "SOC-2", "SOC2", "Trust Services Criteria", "TSC"]) {
      expect(canonicaliseFramework(alias)).toBe("SOC2");
    }
  });

  test("a framework-qualified criterion is picked up", () => {
    const hits = extractRawCitations(
      "Access is granted per SOC 2 CC6.1 and reviewed quarterly.",
    );
    expect(
      hits.some(
        (h) => h.framework_hint && canonicaliseFramework(h.framework_hint) === "SOC2",
      ),
    ).toBe(true);
  });

  test("bare criteria ids are picked up across every category", () => {
    const hits = extractRawCitations(
      "Availability is covered by A1.2, confidentiality by C1.1, integrity by PI1.3, privacy by P6.6, and security by CC7.4.",
    );
    expect(hits.length).toBeGreaterThanOrEqual(4);
  });

  test("REGRESSION: ISO 27001 Annex A still resolves to ISO, not SOC 2", () => {
    // "A1.2" (TSC) and "A.1.2" (ISO Annex A) are deliberately distinct shapes.
    const hits = extractRawCitations(
      "This control satisfies ISO 27001 A.1.1 requirements.",
    );
    expect(
      hits.some(
        (h) =>
          h.framework_hint && canonicaliseFramework(h.framework_hint) === "ISO-27001",
      ),
    ).toBe(true);
  });

  test("COPC no longer resolves — the framework was retired", () => {
    expect(canonicaliseFramework("COPC")).toBeNull();
  });
});
