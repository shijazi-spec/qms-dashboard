/**
 * "One ACTIVE deal per company, within one layout" (Sarah 2026-08-24).
 *
 * Two open deals on the same company mean two sellers can be working it, the
 * client can be contacted twice, and the pipeline is counted twice. Sarah found
 * eleven of these by hand — Mayar Foods, Stc, Center3, FUCHS KSA, Gulf
 * International Bank, Lendo, HAKA, YASREF, LAVENDERY, BSF Capital, P&G — and
 * needs the full set.
 *
 * Three decisions in the rule, each of which changes the answer:
 *   OPEN ONLY   — closed/won deals never count. Most of those accounts carry
 *                 old Closed Lost deals; counting deals-per-account instead of
 *                 OPEN-deals-per-account would flag nearly everything.
 *   BY DOMAIN   — not by Account id. The same company can hold TWO Account
 *                 records with one open deal on each; Account-id grouping sees
 *                 one deal apiece and misses the collision.
 *   ONE LAYOUT  — a WalaPlus deal and a WalaOne deal on the same company are
 *                 two legitimate products, not a collision.
 */
import { describe, it, expect } from "vitest";
import { openStagePredicate } from "../../src/utils/duplicateRadarDatabase";

/** Evaluate the shipped open-stage SQL in JS, same helper the stage tests use. */
function isOpen(stage: string): boolean {
  const sql = openStagePredicate("r");
  const listed = /NOT IN \(([^)]*)\)/.exec(sql)![1]
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, ""));
  const rx = new RegExp(/!~ '\(([^']*)\)'/.exec(sql)![1], "i");
  const s = (stage || "").toLowerCase();
  return !listed.includes(s) && !rx.test(s);
}

type Deal = { stage: string; owner: string; domain?: string; account?: string; layout?: string };

/** The grouping the SQL performs, modelled for assertions. */
function violations(deals: Deal[], layout = "WalaPlus") {
  const open = deals.filter(
    (d) => isOpen(d.stage) && (d.layout ?? "WalaPlus") === layout,
  );
  const groups = new Map<string, Deal[]>();
  for (const d of open) {
    const key = (d.domain || "").trim().toLowerCase() || "name:" + (d.account || "").toLowerCase();
    groups.set(key, [...(groups.get(key) || []), d]);
  }
  return [...groups.entries()]
    .filter(([, ds]) => ds.length > 1)
    .map(([key, ds]) => ({
      key,
      open_deals: ds.length,
      distinct_owners: new Set(ds.map((d) => d.owner)).size,
    }));
}

describe("only OPEN deals count", () => {
  it("flags Stc: two open deals, four Closed Lost ignored", () => {
    // The real record from the CRM on 2026-08-24.
    const v = violations([
      { stage: "Proposal", owner: "Ali AlRajhi", domain: "stc.com" },
      { stage: "On Hold", owner: "Khowla Saeed", domain: "stc.com" },
      { stage: "Closed Lost", owner: "Naif AlSaif", domain: "stc.com" },
      { stage: "Closed Lost", owner: "Abubaker Hashem", domain: "stc.com" },
      { stage: "Closed Lost", owner: "هاجر الحبردي", domain: "stc.com" },
      { stage: "Closed Lost", owner: "WalaPlus", domain: "stc.com" },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].open_deals).toBe(2);
    expect(v[0].distinct_owners).toBe(2);
  });

  it("does NOT flag one open deal beside many closed ones", () => {
    // Counting deals-per-account rather than OPEN-deals-per-account would
    // wrongly flag this — the single most likely way to get the rule wrong.
    expect(
      violations([
        { stage: "Proposal", owner: "A", domain: "clean.com" },
        { stage: "Closed Lost", owner: "B", domain: "clean.com" },
        { stage: "Closed Lost", owner: "C", domain: "clean.com" },
      ]),
    ).toHaveLength(0);
  });

  it("does NOT count won or activated stages as open", () => {
    for (const won of ["Agreement Signed", "Paid", "Partner Active", "Signed"]) {
      expect(
        violations([
          { stage: "Proposal", owner: "A", domain: "x.com" },
          { stage: won, owner: "B", domain: "x.com" },
        ]),
      ).toHaveLength(0);
    }
  });
});

describe("grouping is by domain, not Account record", () => {
  it("catches two open deals split across DUPLICATE account records", () => {
    // One deal on each of two Account rows for the same company. Account-id
    // grouping sees one deal apiece and reports nothing.
    const v = violations([
      { stage: "Contacted", owner: "Bader", domain: "gib.com", account: "Gulf International Bank" },
      { stage: "Contacted", owner: "Wafaa", domain: "gib.com", account: "Gulf Intl Bank" },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].distinct_owners).toBe(2);
  });

  it("falls back to company name when a deal has no domain", () => {
    const v = violations([
      { stage: "Contacted", owner: "Khowla", account: "Aseer Development Authority" },
      { stage: "Contacted", owner: "Khowla", account: "aseer development authority" },
    ]);
    expect(v).toHaveLength(1);
    // Same owner both sides: a housekeeping breach, not a collision.
    expect(v[0].distinct_owners).toBe(1);
  });

  it("keeps different companies apart", () => {
    expect(
      violations([
        { stage: "Proposal", owner: "A", domain: "one.com" },
        { stage: "Proposal", owner: "B", domain: "two.com" },
      ]),
    ).toHaveLength(0);
  });
});

describe("the rule holds within ONE layout", () => {
  it("does not flag a WalaPlus deal against a WalaOne deal", () => {
    // BSF Capital: two WalaPlus opens plus a WalaOne Proposal. The WalaOne deal
    // is a different product, not a second seller on the same sale.
    const v = violations([
      { stage: "Contacted", owner: "Khowla", domain: "bsf.com", layout: "WalaPlus" },
      { stage: "Proposal", owner: "Abdulaziz", domain: "bsf.com", layout: "WalaOne" },
    ]);
    expect(v).toHaveLength(0);
  });

  it("still flags two open deals inside the same layout", () => {
    const v = violations([
      { stage: "Contacted", owner: "Khowla", domain: "bsf.com", layout: "WalaPlus" },
      { stage: "On Hold", owner: "Abdulrahman", domain: "bsf.com", layout: "WalaPlus" },
      { stage: "Proposal", owner: "Abdulaziz", domain: "bsf.com", layout: "WalaOne" },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].open_deals).toBe(2);
  });
});

describe("owner collision is reported separately", () => {
  it("distinguishes two owners from one owner holding both", () => {
    const collision = violations([
      { stage: "New Deal", owner: "Ali AlRajhi", domain: "lavendery.com" },
      { stage: "New Deal", owner: "Khowla Saeed", domain: "lavendery.com" },
    ]);
    const housekeeping = violations([
      { stage: "Proposal", owner: "فايز الأسمري", domain: "alshaya.com" },
      { stage: "On Hold", owner: "فايز الأسمري", domain: "alshaya.com" },
    ]);
    expect(collision[0].distinct_owners).toBe(2);
    expect(housekeeping[0].distinct_owners).toBe(1);
    // Both breach "one active deal per company"; only the first needs Sales to
    // decide who owns the client.
    expect(collision).toHaveLength(1);
    expect(housekeeping).toHaveLength(1);
  });
});
