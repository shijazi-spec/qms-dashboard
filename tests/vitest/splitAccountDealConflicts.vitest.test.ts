/**
 * The reverse of the Active Deal Conflicts detector: one company split across
 * two or more Account records, one open deal on each. The main tab groups by
 * Account, so every one of these accounts looks clean on its own.
 *
 * The grouping is the whole risk here. Joining two Account records on a fuzzy
 * name match is evidence, not proof, so these tests pin BOTH directions: the
 * splits that must be caught, and the near-misses that must NOT be joined —
 * two different Riyadh companies are not one company, and a three-letter brand
 * is not enough to merge anything.
 */
import { describe, it, expect } from "vitest";
import {
  groupSplitAccountConflicts,
  normalizeAccountDomain,
  type SplitAccountSide,
} from "../../src/utils/splitAccountDealConflicts";

let seq = 0;
const deal = (o: Partial<any> = {}): any => ({
  id: `d${++seq}`,
  name: "Deal",
  stage: "Proposal",
  owner: "Owner A",
  amount: 1000,
  layout: "WalaPlus",
  created: "2026-01-01T00:00:00.000Z",
  ...o,
});

const side = (o: Partial<SplitAccountSide> = {}): SplitAccountSide => ({
  account_id: `acc-${++seq}`,
  account_name: "Acme",
  domain: null,
  deals: [deal()],
  ...o,
});

describe("groupSplitAccountConflicts", () => {
  it("joins two Account records that share a domain", () => {
    const out = groupSplitAccountConflicts([
      side({ account_id: "a1", account_name: "Acme Riyadh", domain: "acme.com" }),
      side({ account_id: "a2", account_name: "Acme KSA", domain: "https://www.acme.com/careers" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].signal).toBe("domain");
    expect(out[0].account_count).toBe(2);
    expect(out[0].open_deals).toBe(2);
  });

  it("joins on token-aligned containment — the live Yanbu Aramco case", () => {
    const out = groupSplitAccountConflicts([
      side({
        account_id: "y1",
        account_name: "Yanbu Aramco Sinopec ياسرف",
        deals: [deal({ stage: "On Hold", owner: "فايز الأسمري" })],
      }),
      side({
        account_id: "y2",
        account_name: "Yanbu Aramco",
        deals: [deal({ stage: "New Deal", owner: "Yahya Alshehri" })],
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].signal).toBe("name_containment");
    expect(out[0].distinct_owners).toBe(2);
    // The longer name is the readable label for the group.
    expect(out[0].company).toBe("Yanbu Aramco Sinopec ياسرف");
  });

  it("does NOT join two different companies that share a first token", () => {
    const out = groupSplitAccountConflicts([
      side({ account_id: "r1", account_name: "Riyadh Cables" }),
      side({ account_id: "r2", account_name: "Riyadh Airports" }),
    ]);
    expect(out).toEqual([]);
  });

  it("does NOT join on a brand shorter than the minimum — the known stc blind spot", () => {
    const out = groupSplitAccountConflicts([
      side({ account_id: "s1", account_name: "Stc" }),
      side({ account_id: "s2", account_name: "stcbank" }),
    ]);
    expect(out).toEqual([]);
  });

  it("ignores a single Account carrying two open deals — that is the main tab's job", () => {
    const out = groupSplitAccountConflicts([
      side({ account_id: "m1", account_name: "Solo Co", deals: [deal(), deal()] }),
    ]);
    expect(out).toEqual([]);
  });

  it("flags a group that also overlaps the main tab", () => {
    const out = groupSplitAccountConflicts([
      side({ account_id: "o1", account_name: "Overlap Trading", domain: "overlap.sa", deals: [deal(), deal()] }),
      side({ account_id: "o2", account_name: "Overlap Trading Est", domain: "overlap.sa" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].overlaps_main_tab).toBe(true);
    expect(out[0].open_deals).toBe(3);
  });

  it("reports the strongest signal when a group is joined by more than one", () => {
    const out = groupSplitAccountConflicts([
      side({ account_id: "b1", account_name: "Bawan Industrial", domain: "bawan.sa" }),
      side({ account_id: "b2", account_name: "Bawan Industrial Riyadh", domain: "bawan.sa" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].signal).toBe("domain");
  });

  it("sums open value across every account in the group", () => {
    const out = groupSplitAccountConflicts([
      side({ account_id: "v1", account_name: "Value Co Alpha", domain: "value.sa", deals: [deal({ amount: 5000 })] }),
      side({ account_id: "v2", account_name: "Value Co Beta", domain: "value.sa", deals: [deal({ amount: 2500 })] }),
    ]);
    expect(out[0].total_open_value).toBe(7500);
  });

  it("skips accounts with no open deals", () => {
    const out = groupSplitAccountConflicts([
      side({ account_id: "e1", account_name: "Empty Co", domain: "empty.sa", deals: [] }),
      side({ account_id: "e2", account_name: "Empty Co Two", domain: "empty.sa" }),
    ]);
    expect(out).toEqual([]);
  });
});

describe("normalizeAccountDomain", () => {
  it("reduces a website to a bare host", () => {
    expect(normalizeAccountDomain("https://www.lendo.sa/about?x=1")).toBe("lendo.sa");
    expect(normalizeAccountDomain("  STC.COM  ")).toBe("stc.com");
  });

  it("returns null for blanks", () => {
    expect(normalizeAccountDomain("")).toBeNull();
    expect(normalizeAccountDomain(null)).toBeNull();
    expect(normalizeAccountDomain("   ")).toBeNull();
  });
});
