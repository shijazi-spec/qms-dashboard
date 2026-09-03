import { describe, it, expect } from "vitest";
import { matchCompanyNames } from "../../src/utils/companyNameBatch";

const rows = [
  { crm_name: "KPMG Saudi Arabia", record_type: "account", n: 1, stages: null },
  { crm_name: "KPMG Saudi Arabia", record_type: "deal", n: 2, stages: ["Closed Lost", "Paid"] },
  { crm_name: "Three Lines Trading", record_type: "deal", n: 1, stages: ["Contacted"] },
  { crm_name: "شركة سالم بالحمر القابضة", record_type: "account", n: 1, stages: null },
  { crm_name: "Aster", record_type: "account", n: 1, stages: null },
];

describe("matchCompanyNames", () => {
  it("matches strictly, ignoring legal suffixes and case", () => {
    const [r] = matchCompanyNames(["kpmg saudi arabia ltd"], rows);
    expect(r.matched).toBe(true);
    expect(r.match_type).toBe("strict");
    expect(r.matched_name).toBe("KPMG Saudi Arabia");
    expect(r.counts).toEqual({ leads: 0, deals: 2, contacts: 0, accounts: 1 });
    expect(r.deal_stages.sort()).toEqual(["Closed Lost", "Paid"]);
  });
  it("flags a containment hit as fuzzy, never strict", () => {
    const [r] = matchCompanyNames(["Three Lines"], rows);
    expect(r.matched).toBe(true);
    expect(r.match_type).toBe("fuzzy");
    expect(r.matched_name).toBe("Three Lines Trading");
  });
  it("does not fuzzy-match on a short stub", () => {
    const [r] = matchCompanyNames(["Co"], rows);
    expect(r.matched).toBe(false);
    expect(r.match_type).toBeNull();
    expect(r.counts).toEqual({ leads: 0, deals: 0, contacts: 0, accounts: 0 });
  });
  it("does not fuzzy-match across a word boundary (Aster vs Master Builders)", () => {
    const [r] = matchCompanyNames(["Master Builders"], rows);
    expect(r.matched).toBe(false);
  });
  it("matches Arabic names", () => {
    const [r] = matchCompanyNames(["شركة سالم بالحمر القابضة"], rows);
    expect(r.matched).toBe(true);
    expect(r.match_type).toBe("strict");
  });
  it("reports unmatched cleanly", () => {
    const [r] = matchCompanyNames(["Nonexistent Widgets"], rows);
    expect(r).toEqual({ input: "Nonexistent Widgets", matched: false, match_type: null, matched_name: null, counts: { leads: 0, deals: 0, contacts: 0, accounts: 0 }, deal_stages: [] });
  });
  it("dedupes repeated inputs but keeps original order and spelling", () => {
    const out = matchCompanyNames(["KPMG Saudi Arabia", "Three Lines", "KPMG Saudi Arabia"], rows);
    expect(out.length).toBe(2);
    expect(out.map((x) => x.input)).toEqual(["KPMG Saudi Arabia", "Three Lines"]);
  });
});
