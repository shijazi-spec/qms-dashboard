/**
 * clauseSortKey — ordering guarantees per framework.
 *
 * These encode the bug that prompted the helper: clause lists rendered
 * alphabetically by title, and `obligation_code` (VARCHAR) sorted 10 before 2.
 * Every test below sorts by the generated key and asserts true document order.
 */

import { describe, expect, test } from "vitest";
import {
  buildClauseSortKey,
  compareClauseSortKeys,
  CLAUSE_SORT_KEY_MAX_LEN,
} from "../../src/utils/clauseSortKey";

/** Sort clause references the way the database will, and return them in order. */
function ordered(refs: string[]): string[] {
  return refs
    .map((r) => ({ r, k: buildClauseSortKey(r) }))
    .sort((a, b) => compareClauseSortKeys(a.k, b.k))
    .map((x) => x.r);
}

describe("buildClauseSortKey", () => {
  test("returns null when there is nothing orderable", () => {
    expect(buildClauseSortKey(null, null)).toBeNull();
    expect(buildClauseSortKey("", "")).toBeNull();
    expect(buildClauseSortKey("Cl.", null)).toBeNull();
  });

  test("falls back to obligation_code with the framework prefix stripped", () => {
    expect(buildClauseSortKey(null, "ISO9001-4.1")).toBe(
      buildClauseSortKey("4.1"),
    );
    expect(buildClauseSortKey("", "NCA-ECC-1-1-1")).toBe(
      buildClauseSortKey("1-1-1"),
    );
  });

  test("noise words do not change the key", () => {
    expect(buildClauseSortKey("Cl. 4.1")).toBe(buildClauseSortKey("4.1"));
    expect(buildClauseSortKey("Req. 1.1.1")).toBe(buildClauseSortKey("1.1.1"));
    expect(buildClauseSortKey("§3.7")).toBe(buildClauseSortKey("3.7"));
  });

  test("leading zeros are normalised (SAMA-08 == 8)", () => {
    expect(buildClauseSortKey("08")).toBe(buildClauseSortKey("8"));
  });

  test("a parent clause sorts before its own sub-clauses", () => {
    expect(ordered(["6.1.3", "6", "6.1"])).toEqual(["6", "6.1", "6.1.3"]);
  });

  test("key stays within the VARCHAR(64) column", () => {
    const k = buildClauseSortKey("1.2.3.4.5.6.7.8.9.10.11.12");
    expect(k).not.toBeNull();
    expect((k as string).length).toBeLessThanOrEqual(CLAUSE_SORT_KEY_MAX_LEN);
  });
});

describe("ISO 9001 — the reported case", () => {
  test("10.x sorts LAST, not after 1 (the VARCHAR bug)", () => {
    const refs = [
      "Cl. 10.3",
      "Cl. 4.1",
      "Cl. 9.1.3",
      "Cl. 10.1",
      "Cl. 5.1.2",
      "Cl. 4.4",
      "Cl. 10.2",
      "Cl. 9.1.1",
    ];
    expect(ordered(refs)).toEqual([
      "Cl. 4.1",
      "Cl. 4.4",
      "Cl. 5.1.2",
      "Cl. 9.1.1",
      "Cl. 9.1.3",
      "Cl. 10.1",
      "Cl. 10.2",
      "Cl. 10.3",
    ]);
  });

  test("matches the numbering the GRC Manager asked for: 1, 1.1, 1.2, 2, 2.1, 3", () => {
    expect(ordered(["2.1", "1.1", "3", "1", "2", "1.2", "2.2"])).toEqual([
      "1",
      "1.1",
      "1.2",
      "2",
      "2.1",
      "2.2",
      "3",
    ]);
  });
});

describe("ISO 27001 — main clauses then Annex A", () => {
  test("Cl. 4..10 all precede A.5.1..A.8.34", () => {
    const refs = ["A.5.15", "Cl. 10", "A.8.34", "Cl. 4", "A.5.1", "Cl. 9"];
    expect(ordered(refs)).toEqual([
      "Cl. 4",
      "Cl. 9",
      "Cl. 10",
      "A.5.1",
      "A.5.15",
      "A.8.34",
    ]);
  });

  test("Annex A sub-numbers order numerically (A.5.9 before A.5.15)", () => {
    expect(ordered(["A.5.15", "A.5.9", "A.5.1"])).toEqual([
      "A.5.1",
      "A.5.9",
      "A.5.15",
    ]);
  });

  test("a lettered sub-item sorts after its parent clause", () => {
    expect(ordered(["Cl. 6.1.3 d)", "Cl. 6.1.3", "Cl. 6.1.3 e)"])).toEqual([
      "Cl. 6.1.3",
      "Cl. 6.1.3 d)",
      "Cl. 6.1.3 e)",
    ]);
  });
});

describe("SAMA CSF — §-prefixed hierarchy", () => {
  test("§3.3.5 style references order hierarchically", () => {
    expect(ordered(["§3.3.5", "§3.1", "§3.3.1", "§4.1", "§3.3.10"])).toEqual([
      "§3.1",
      "§3.3.1",
      "§3.3.5",
      "§3.3.10",
      "§4.1",
    ]);
  });

  test("flat SAMA codes order numerically, not lexicographically", () => {
    // The live bug: SAMA-105 rendered before SAMA-11, which rendered before SAMA-51.
    const codes = ["SAMA-105", "SAMA-11", "SAMA-51", "SAMA-08"];
    const sorted = codes
      .map((c) => ({ c, k: buildClauseSortKey(null, c) }))
      .sort((a, b) => compareClauseSortKeys(a.k, b.k))
      .map((x) => x.c);
    expect(sorted).toEqual(["SAMA-08", "SAMA-11", "SAMA-51", "SAMA-105"]);
  });
});

describe("NCA ECC — dash-separated sub-controls", () => {
  test("1-1-1, 1-1-2, 1-2-1, 2-1-1 order correctly", () => {
    expect(ordered(["2-1-1", "1-2-1", "1-1-10", "1-1-2", "1-1-1"])).toEqual([
      "1-1-1",
      "1-1-2",
      "1-1-10",
      "1-2-1",
      "2-1-1",
    ]);
  });
});

describe("PCI DSS — Req. n.n.n", () => {
  test("requirement 2 precedes requirement 12", () => {
    expect(ordered(["Req. 12.1", "Req. 2.1", "Req. 1.1.1", "Req. 10.2"])).toEqual(
      ["Req. 1.1.1", "Req. 2.1", "Req. 10.2", "Req. 12.1"],
    );
  });
});

describe("PDPL — law articles before Implementing Regulations", () => {
  test("Art. n sorts numerically", () => {
    expect(ordered(["Art. 19", "Art. 2", "Art. 11"])).toEqual([
      "Art. 2",
      "Art. 11",
      "Art. 19",
    ]);
  });

  test("IR articles sort after the law's own articles", () => {
    // "IR" is deliberately NOT stripped so the Implementing Regulations form
    // their own block instead of interleaving with the law.
    expect(ordered(["IR Art. 3", "Art. 19", "IR Art. 11", "Art. 2"])).toEqual([
      "Art. 2",
      "Art. 19",
      "IR Art. 3",
      "IR Art. 11",
    ]);
  });
});

describe("SOC 2 — Trust Services Criteria", () => {
  test("criteria within a family order numerically (CC6.10 after CC6.1)", () => {
    expect(ordered(["CC6.1", "CC1.1", "CC10.1", "CC6.10"])).toEqual([
      "CC1.1",
      "CC6.1",
      "CC6.10",
      "CC10.1",
    ]);
  });

  test("cross-family order is alphabetic here and is carried by section_order", () => {
    // The TSC document presents Common Criteria (CC1-CC9) BEFORE the category
    // criteria (A1 / C1 / PI1 / P1-P8). That is a curated convention, not a
    // numeric fact, so the key cannot express it — "A1" < "CC1" alphabetically.
    // The SOC 2 seed therefore assigns section_order to encode family order,
    // and section_order is the PRIMARY sort (see clauseSortKey.ts header).
    expect(ordered(["CC1.1", "A1.2"])).toEqual(["A1.2", "CC1.1"]);
  });
});

describe("compareClauseSortKeys", () => {
  test("null keys sort last so unparseable clauses fall to the end", () => {
    expect(compareClauseSortKeys(null, "000001")).toBe(1);
    expect(compareClauseSortKeys("000001", null)).toBe(-1);
    expect(compareClauseSortKeys(null, null)).toBe(0);
  });
});
