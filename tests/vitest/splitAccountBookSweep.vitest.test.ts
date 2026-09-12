/**
 * Grouping at BOOK scale, where token containment stops being safe.
 *
 * Over the 1,361 accounts that already hold open deals, containment behaved.
 * Over all 8,985 accounts in the sales book it collapsed (measured
 * 2026-09-11): 42 government authorities became one company because they all
 * begin الهيئة; 21 companies became one because they share the city Riyadh.
 *
 * Two separate faults, and both are pinned here: a single generic hub must not
 * pull in the field, and a containment match must never CHAIN two accounts
 * that do not match each other.
 */
import { describe, it, expect } from "vitest";
import {
  groupByProof,
  containmentPairs,
  distinctiveNames,
  accountAliases,
  type SplitAccountSide,
} from "../../src/utils/splitAccountDealConflicts";

let seq = 0;
const deal = (o: Partial<any> = {}): any => ({
  id: `d${++seq}`, name: "Deal", stage: "Proposal", owner: "Owner",
  amount: 0, layout: "WalaPlus", created: null, ...o,
});
const acct = (name: string, domain: string | null = null): SplitAccountSide => ({
  account_id: `a${++seq}`,
  account_name: name,
  domain,
  deals: [deal()],
});

describe("groupByProof", () => {
  it("groups an identical domain", () => {
    const out = groupByProof([acct("Riyadh Air", "riyadhair.com"), acct("طيران الرياض", "riyadhair.com")]);
    expect(out).toHaveLength(1);
    expect(out[0].signal).toBe("domain");
  });

  it("groups an identical name", () => {
    const out = groupByProof([acct("جامعة تبوك"), acct("جامعة تبوك")]);
    expect(out).toHaveLength(1);
    expect(out[0].signal).toBe("exact_name");
  });

  it("NEVER groups on containment — that is what chained 42 authorities", () => {
    const out = groupByProof([
      acct("الهيئة العامة"),
      acct("الهيئة العامة للنقل"),
      acct("الهيئة العامة للطيران المدني"),
      acct("الهيئة العامة للأمن الغذائي"),
    ]);
    expect(out).toEqual([]);
  });

  it("does not chain two Riyadh companies through a shared city", () => {
    const out = groupByProof([
      acct("Riyadh Air"), acct("Riyadh Cables"), acct("Riyadh Marriott Hotel"),
    ]);
    expect(out).toEqual([]);
  });
});

describe("the deal name is evidence too (Sarah 2026-09-11)", () => {
  // "you can check the deal name, company name, or domain, so you always have
  // a way to catch these". The account record is often the worst-named thing
  // in the cluster; the deal is sometimes the only place the real company name
  // was ever typed.
  const withDeal = (accName: string, dealName: string): SplitAccountSide => ({
    account_id: `a${++seq}`,
    account_name: accName,
    domain: null,
    deals: [deal({ name: dealName })],
    aliases: [dealName],
  });

  it("joins two accounts whose DEALS name the same company", () => {
    // Neither account name matches, but both deals say "Alfran Arabia".
    const out = groupByProof([
      withDeal("Account 11223", "Alfran Arabia"),
      withDeal("New Client - Jeddah", "Alfran Arabia"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].signal).toBe("exact_name");
  });

  it("matches one account's NAME against the other's DEAL name", () => {
    const pairs = containmentPairs([
      { account_id: "x1", account_name: "الفران", domain: null, deals: [deal()] },
      { account_id: "x2", account_name: "Account 5567", domain: null,
        deals: [deal()], aliases: ["شركة الفران العربية"] },
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].shared).toBe("الفران");
  });

  it("will not let a generic DEAL name become a hub", () => {
    // Half the book has a deal called "New Deal". Joining on it would merge
    // the entire pipeline into one company.
    const out = groupByProof([
      withDeal("Alpha Trading", "New Deal"),
      withDeal("Beta Industries", "New Deal"),
      withDeal("Gamma Foods", "New Deal"),
      withDeal("Delta Logistics", "New Deal"),
      withDeal("Epsilon Media", "New Deal"),
    ]);
    expect(out).toEqual([]);
  });

  it("drops a withheld-name alias but keeps the real ones", () => {
    const s: SplitAccountSide = {
      account_id: "z1", account_name: "Confidential", domain: null,
      deals: [deal()], aliases: ["Confidential", "Alfran Arabia"],
    };
    expect(accountAliases(s)).toEqual(["alfran arabia"]);
  });

  it("distinctiveNames keeps a company and drops a category", () => {
    const sides = [
      withDeal("Alfran Arabia", "الفران"),
      withDeal("A", "New Deal"), withDeal("B", "New Deal"),
      withDeal("C", "New Deal"), withDeal("D", "New Deal"),
    ];
    const d = distinctiveNames(sides);
    expect(d.has("الفران")).toBe(true);
    expect(d.has("new deal")).toBe(false);
  });
});

describe("containmentPairs", () => {
  it("still finds الفران — the case the sweep exists for", () => {
    const a = acct("الفران");
    const b = acct("شركة الفران العربية");
    const pairs = containmentPairs([a, b]);
    // "شركة" is boilerplate and stripped, so "الفران" sits inside
    // "الفران العربية" on a token boundary.
    expect(pairs).toHaveLength(1);
    expect(pairs[0].shared).toBe("الفران");
  });

  it("reports ONE EDGE per match, never a chain", () => {
    // Two edges, not three: "Yanbu Aramco" sits inside both of the others, but
    // "…Sinopec" and "…Refining Company" do not contain each other. Under the
    // old grouping all three collapsed into one company.
    const pairs = containmentPairs([
      acct("Yanbu Aramco"),
      acct("Yanbu Aramco Sinopec"),
      acct("Yanbu Aramco Refining Company"),
    ]);
    expect(pairs).toHaveLength(2);
    for (const p of pairs) expect(p.a.account_id).not.toBe(p.b.account_id);
  });

  it("drops a hub by FAN-OUT, not by token count", () => {
    // "الهيئة" is the hub that chained 42 authorities. It is ONE token — and so
    // is "الفران", a real company. Length cannot separate them; how many
    // accounts the name sits inside can.
    const authorities = containmentPairs([
      acct("الهيئة"),
      acct("الهيئة العامة للنقل"),
      acct("الهيئة العامة للطيران المدني"),
      acct("الهيئة العامة للأمن الغذائي"),
      acct("الهيئة الملكية للجبيل وينبع"),
      acct("الهيئة السعودية للمواصفات"),
    ]);
    expect(authorities).toEqual([]);

    const city = containmentPairs([
      acct("Riyadh"), acct("Riyadh Cables"), acct("Riyadh Marriott Hotel"),
      acct("Riyadh Air"), acct("Riyadh Municipality"), acct("Riyadh Schools"),
    ]);
    expect(city).toEqual([]);
  });

  it("skips identical names — those are proof and already grouped", () => {
    expect(containmentPairs([acct("جامعة تبوك"), acct("جامعة تبوك")])).toEqual([]);
  });

  it("honours a dismissed pair", () => {
    const a = acct("الفران");
    const b = acct("شركة الفران العربية");
    const key = a.account_id < b.account_id
      ? `${a.account_id}|${b.account_id}`
      : `${b.account_id}|${a.account_id}`;
    expect(containmentPairs([a, b], new Set([key]))).toEqual([]);
  });

  it("refuses a withheld-name stand-in as either side", () => {
    expect(containmentPairs([acct("Confidential"), acct("Confidential Government")])).toEqual([]);
  });
});
