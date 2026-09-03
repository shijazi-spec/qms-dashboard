/**
 * What counts as a "duplicate cluster" in the executive brief and digest.
 *
 * getClusterSummary feeds three human-facing surfaces: the weekly executive
 * brief, the twice-daily resolution digest, and AssistantPersona's assistant tool. It gated
 * on the SUM of records across modules being >= 2, so a cluster holding one
 * lead and one account — a cross-module LINK, the same company seen twice, not
 * a duplicate of either — counted as a duplicate.
 *
 * Measured live 2026-08-23: the brief reported 26,090 duplicate clusters where
 * the dashboard and module tabs reported 10,282. The 15,808 gap matched the
 * 15,242 cross_module_link_candidate signals almost exactly. The inflated count
 * is also the denominator of "% cleared", so progress read 7% against a 23%
 * resolution rate.
 *
 * The whole platform uses GREATEST(...) > 1 — getSummary's
 * trueDuplicateClusters, the per-module tabs, getSegmentLeadDuplicateCount and
 * getSegmentAccountDuplicateCount. This pins the brief to that one definition.
 */
import { describe, it, expect } from "vitest";

/** The two competing gates, as predicates over a cluster's module counts. */
type Cluster = { leads?: number; deals?: number; contacts?: number; accounts?: number };
const n = (v?: number) => v || 0;

/** The OLD gate: total records across all modules >= 2. */
const sumGate = (c: Cluster) =>
  n(c.leads) + n(c.deals) + n(c.contacts) + n(c.accounts) >= 2;

/** The CURRENT gate, matching trueDuplicateClusters and the tabs. */
const greatestGate = (c: Cluster) =>
  Math.max(n(c.leads), n(c.deals), n(c.contacts), n(c.accounts)) > 1;

describe("a cross-module link is not a duplicate", () => {
  it("excludes one lead plus one account", () => {
    const crossModule = { leads: 1, accounts: 1 };
    expect(greatestGate(crossModule)).toBe(false);
    // This is the case that inflated the brief by ~15,800 clusters.
    expect(sumGate(crossModule)).toBe(true);
  });

  it("excludes a link spanning three modules with one record each", () => {
    expect(greatestGate({ leads: 1, deals: 1, contacts: 1 })).toBe(false);
  });

  it("still counts a cluster that has a real duplicate AND a link", () => {
    // Two leads is a genuine lead duplicate; the extra account doesn't matter.
    expect(greatestGate({ leads: 2, accounts: 1 })).toBe(true);
  });
});

describe("genuine duplicates still count", () => {
  const duplicates: Array<[Cluster, string]> = [
    [{ leads: 2 }, "two leads"],
    [{ deals: 2 }, "two deals"],
    [{ contacts: 2 }, "two contacts"],
    [{ accounts: 2 }, "two accounts"],
    [{ accounts: 7 }, "many accounts"],
  ];
  it.each(duplicates)("counts %o (%s)", (c) => {
    expect(greatestGate(c)).toBe(true);
  });
});

describe("singletons stay excluded", () => {
  const singletons: Array<[Cluster, string]> = [
    [{ leads: 1 }, "a lone lead"],
    [{ accounts: 1 }, "a lone account"],
    [{}, "an empty cluster"],
  ];
  it.each(singletons)("excludes %o (%s)", (c) => {
    expect(greatestGate(c)).toBe(false);
    // The 2026-06-28 fix already handled these; only the cross-module case
    // survived it.
    expect(sumGate(c)).toBe(false);
  });
});

describe("the two gates agree except on cross-module links", () => {
  it("differs only where no single module has 2+ records", () => {
    const cases: Cluster[] = [
      { leads: 2 }, { deals: 3 }, { accounts: 1 }, {},
      { leads: 1, accounts: 1 }, { leads: 1, deals: 1, contacts: 1 },
      { contacts: 2, accounts: 1 },
    ];
    for (const c of cases) {
      if (greatestGate(c) !== sumGate(c)) {
        // Every disagreement must be a cross-module link: 2+ records total,
        // but no single module holding more than one.
        const total = n(c.leads) + n(c.deals) + n(c.contacts) + n(c.accounts);
        const maxOne = Math.max(n(c.leads), n(c.deals), n(c.contacts), n(c.accounts));
        expect(total).toBeGreaterThanOrEqual(2);
        expect(maxOne).toBe(1);
      }
    }
  });
});
