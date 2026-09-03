/**
 * "One ACTIVE deal per company, within one layout" (Sample User 2026-08-24).
 *
 * Two open deals on the same company mean two sellers can be working it, the
 * client can be contacted twice, and the pipeline is counted twice. Sample User
 * eleven of these by hand — Mayar Foods, Example Organization, Center3, FUCHS KSA, Gulf
 * International Bank, Lendo, HAKA, Example Organization, LAVENDERY, Example Organization, P&G — and
 * needs the full set.
 *
 * Three decisions in the rule, each of which changes the answer:
 *   OPEN ONLY   — closed/won deals never count. Most of those accounts carry
 *                 old Closed Lost deals; counting deals-per-account instead of
 *                 OPEN-deals-per-account would flag nearly everything.
 *   GROUPING    — domain, then Account id, then normalised name. Domain leads
 *                 because one company can hold TWO Account records with one
 *                 open deal on each, and only domain merges those. But deal
 *                 records in this tenant carry NO domain, so Account id does
 *                 the real work; a domain-only version missed 6 of the 13
 *                 accounts Sample User hand. Name cannot lead — company_name
 *                 varies per deal for one Account.
 *   ONE LAYOUT  — a ExampleOrg deal and a Example Organization deal on the same company are
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

type Deal = {
  stage: string;
  owner: string;
  domain?: string;
  accountId?: string;
  account?: string;
  layout?: string;
};

/** The grouping the SQL performs, modelled for assertions. */
function violations(deals: Deal[], layout = "ExampleOrg") {
  const open = deals.filter(
    (d) => isOpen(d.stage) && (d.layout ?? "ExampleOrg") === layout,
  );
  const groups = new Map<string, Deal[]>();
  for (const d of open) {
    // domain → account id → normalised name, matching the SQL.
    const key =
      (d.domain || "").trim().toLowerCase() ||
      (d.accountId ? "acct:" + d.accountId : "") ||
      "name:" + (d.account || "").toLowerCase();
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
  it("flags Example Organization: two open deals, four Closed Lost ignored", () => {
    // The real record from the CRM on 2026-08-24.
    const v = violations([
      { stage: "Proposal", owner: "Sample User AlRajhi", domain: "<REDACTED_HOST>" },
      { stage: "On Hold", owner: "Sample User", domain: "<REDACTED_HOST>" },
      { stage: "Closed Lost", owner: "Naif AlSaif", domain: "<REDACTED_HOST>" },
      { stage: "Closed Lost", owner: "Abubaker Hashem", domain: "<REDACTED_HOST>" },
      { stage: "Closed Lost", owner: "هاجر الحبردي", domain: "<REDACTED_HOST>" },
      { stage: "Closed Lost", owner: "ExampleOrg", domain: "<REDACTED_HOST>" },
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
        { stage: "Proposal", owner: "A", domain: "<REDACTED_HOST>" },
        { stage: "Closed Lost", owner: "B", domain: "<REDACTED_HOST>" },
        { stage: "Closed Lost", owner: "C", domain: "<REDACTED_HOST>" },
      ]),
    ).toHaveLength(0);
  });

  it("does NOT count won or activated stages as open", () => {
    for (const won of ["Agreement Signed", "Paid", "Partner Active", "Signed"]) {
      expect(
        violations([
          { stage: "Proposal", owner: "A", domain: "<REDACTED_HOST>" },
          { stage: won, owner: "B", domain: "<REDACTED_HOST>" },
        ]),
      ).toHaveLength(0);
    }
  });
});

describe("domain merges duplicate Account records", () => {
  it("catches two open deals split across DUPLICATE account records", () => {
    // One deal on each of two Account rows for the same company. Account-id
    // grouping sees one deal apiece and reports nothing.
    const v = violations([
      { stage: "Contacted", owner: "Bader", domain: "<REDACTED_HOST>", account: "Gulf International Bank" },
      { stage: "Contacted", owner: "Wafaa", domain: "<REDACTED_HOST>", account: "Gulf Intl Bank" },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].distinct_owners).toBe(2);
  });

  it("falls back to company name when a deal has no domain", () => {
    const v = violations([
      { stage: "Contacted", owner: "Sample User", account: "Example Organization" },
      { stage: "Contacted", owner: "Sample User", account: "Example Organization" },
    ]);
    expect(v).toHaveLength(1);
    // Same owner both sides: a housekeeping breach, not a collision.
    expect(v[0].distinct_owners).toBe(1);
  });

  it("keeps different companies apart", () => {
    expect(
      violations([
        { stage: "Proposal", owner: "A", domain: "<REDACTED_HOST>" },
        { stage: "Proposal", owner: "B", domain: "<REDACTED_HOST>" },
      ]),
    ).toHaveLength(0);
  });
});

describe("the rule holds within ONE layout", () => {
  it("does not flag a ExampleOrg deal against a Example Organization deal", () => {
    // Example Organization: two ExampleOrg opens plus a Example Organization Proposal. The Example Organization deal
    // is a different product, not a second seller on the same sale.
    const v = violations([
      { stage: "Contacted", owner: "Sample User", domain: "<REDACTED_HOST>", layout: "ExampleOrg" },
      { stage: "Proposal", owner: "Sample User", domain: "<REDACTED_HOST>", layout: "Example Organization" },
    ]);
    expect(v).toHaveLength(0);
  });

  it("still flags two open deals inside the same layout", () => {
    const v = violations([
      { stage: "Contacted", owner: "Sample User", domain: "<REDACTED_HOST>", layout: "ExampleOrg" },
      { stage: "On Hold", owner: "Sample User", domain: "<REDACTED_HOST>", layout: "ExampleOrg" },
      { stage: "Proposal", owner: "Sample User", domain: "<REDACTED_HOST>", layout: "Example Organization" },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].open_deals).toBe(2);
  });
});

describe("owner collision is reported separately", () => {
  it("distinguishes two owners from one owner holding both", () => {
    const collision = violations([
      { stage: "New Deal", owner: "Sample User AlRajhi", domain: "<REDACTED_HOST>" },
      { stage: "New Deal", owner: "Sample User", domain: "<REDACTED_HOST>" },
    ]);
    const housekeeping = violations([
      { stage: "Proposal", owner: "فايز الأسمري", domain: "<REDACTED_HOST>" },
      { stage: "On Hold", owner: "فايز الأسمري", domain: "<REDACTED_HOST>" },
    ]);
    expect(collision[0].distinct_owners).toBe(2);
    expect(housekeeping[0].distinct_owners).toBe(1);
    // Both breach "one active deal per company"; only the first needs Sales to
    // decide who owns the client.
    expect(collision).toHaveLength(1);
    expect(housekeeping).toHaveLength(1);
  });
});

describe("grouping falls back to the Account id when there is no domain", () => {
  // Measured 2026-08-24: deal records in this tenant carry NO domain, but do
  // carry raw_data->Account_Name->id. A domain-only rule found 0 groups by
  // domain and missed 6 of the 13 accounts Sample User by hand.
  it("groups two open deals on one Account id", () => {
    const v = violations([
      { stage: "Proposal", owner: "Sample User AlRajhi", accountId: "<REDACTED_ID>", account: "Example Organization" },
      { stage: "On Hold", owner: "Sample User", accountId: "<REDACTED_ID>", account: "Example Organization" },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].distinct_owners).toBe(2);
  });

  it("does NOT merge genuinely different Accounts that share a name fragment", () => {
    // "Example Organization" and "stcbank" are separate companies with separate Account ids.
    expect(
      violations([
        { stage: "Proposal", owner: "Sample User AlRajhi", accountId: "<REDACTED_ID>", account: "Example Organization" },
        { stage: "Contacted", owner: "Sample User AlRajhi", accountId: "<REDACTED_ID>", account: "stcbank" },
      ]),
    ).toHaveLength(0);
  });

  it("keeps one Account together even when company_name differs per deal", () => {
    // The failure that hid these: company_name varies ("Example Organization", "الاتصالات
    // السعودية"), so leading with name splits one Account into several groups.
    const v = violations([
      { stage: "Proposal", owner: "A", accountId: "acc-1", account: "Example Organization" },
      { stage: "Meeting", owner: "B", accountId: "acc-1", account: "الاتصالات السعودية" },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].open_deals).toBe(2);
  });

  it("still lets domain merge two duplicate Account records", () => {
    const v = violations([
      { stage: "Contacted", owner: "Bader", domain: "<REDACTED_HOST>", accountId: "acc-1" },
      { stage: "Contacted", owner: "Wafaa", domain: "<REDACTED_HOST>", accountId: "acc-2" },
    ]);
    expect(v).toHaveLength(1);
  });
});
