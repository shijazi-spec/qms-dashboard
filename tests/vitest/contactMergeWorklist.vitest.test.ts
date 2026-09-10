/**
 * The two decisions the merge worklist makes before a human sees it: which
 * record survives, and which records are the same person at all.
 *
 * Both are pinned in BOTH directions. A false positive here proposes merging
 * two different colleagues into one contact; a false negative leaves a genuine
 * duplicate scattered. The rule is 2 of {email, phone, full name} — one alone
 * is never enough, because a switchboard number is shared and "Mohammed" is not
 * an identity.
 */
import { describe, it, expect } from "vitest";
import {
  matchSignals,
  pickMaster,
  buildMergeGroup,
  type MergeCandidateContact,
} from "../../src/utils/contactMergeWorklist";

let seq = 0;
const c = (o: Partial<MergeCandidateContact> = {}): MergeCandidateContact => ({
  zoho_contact_id: `id${++seq}`,
  name: "Diana Ahmed",
  email: null,
  phone: null,
  account: "Exhale Yoga",
  created_date: "2024-01-01T00:00:00.000Z",
  activity_total: null,
  activity_verified: false,
  ...o,
});

describe("matchSignals", () => {
  it("matches an email regardless of case and spacing", () => {
    expect(matchSignals(c({ email: " Diana@Exhale.NET " }), c({ email: "diana@exhale.net" })))
      .toContain("email");
  });

  it("treats +966 5x and 05x as the same number", () => {
    expect(matchSignals(c({ phone: "+966 54 593 7834" }), c({ phone: "0545937834" })))
      .toContain("phone");
  });

  it("ignores a phone too short to identify anyone", () => {
    // "11" is real junk in this CRM and would otherwise match every contact.
    expect(matchSignals(c({ phone: "11" }), c({ phone: "11" }))).not.toContain("phone");
  });

  it("matches a full name case- and whitespace-insensitively", () => {
    expect(matchSignals(c({ name: "Diana  ahmed" }), c({ name: "diana Ahmed" })))
      .toContain("name");
  });

  it("returns nothing for two unrelated people", () => {
    expect(matchSignals(
      c({ name: "Ali AlRajhi", email: "ali@x.com", phone: "0500000001" }),
      c({ name: "Khowla Saeed", email: "khowla@y.com", phone: "0500000002" }),
    )).toEqual([]);
  });
});

describe("pickMaster", () => {
  it("keeps the record with the most activity", () => {
    const busy = c({ zoho_contact_id: "busy", activity_total: 12, activity_verified: true });
    const empty = c({ zoho_contact_id: "empty", activity_total: 0, activity_verified: true });
    const { master, reason } = pickMaster([empty, busy]);
    expect(master.zoho_contact_id).toBe("busy");
    expect(reason).toMatch(/only record with activity|Most activity/);
  });

  it("prefers a counted record over an uncounted one when neither has activity", () => {
    const counted = c({ zoho_contact_id: "counted", activity_total: 0, activity_verified: true });
    const unknown = c({ zoho_contact_id: "unknown", activity_total: null });
    expect(pickMaster([unknown, counted]).master.zoho_contact_id).toBe("counted");
  });

  it("says so when nothing has been counted, instead of implying confidence", () => {
    const { reason } = pickMaster([
      c({ zoho_contact_id: "a", email: "a@x.com" }),
      c({ zoho_contact_id: "b" }),
    ]);
    // The point is that the reason ADMITS the uncertainty and sends the reader
    // to Zoho, rather than stating a confident-sounding basis it does not have.
    expect(reason).toMatch(/counted yet/i);
    expect(reason).toMatch(/check in zoho/i);
  });

  it("breaks a tie on having an email, then on age", () => {
    const older = c({ zoho_contact_id: "older", email: "d@x.com", created_date: "2020-01-01T00:00:00.000Z", activity_total: 0, activity_verified: true });
    const newer = c({ zoho_contact_id: "newer", email: "d@x.com", created_date: "2025-01-01T00:00:00.000Z", activity_total: 0, activity_verified: true });
    expect(pickMaster([newer, older]).master.zoho_contact_id).toBe("older");
  });
});

describe("buildMergeGroup", () => {
  const NONE = new Set<string>();

  it("builds the merged preview, keeping both emails and both phones", () => {
    const master = c({ zoho_contact_id: "m", name: "Diana Ahmed", email: "Kakoook@gmail.com", phone: "0545937834", activity_total: 9, activity_verified: true });
    const dup = c({ zoho_contact_id: "d", name: "Diana ahmed", email: "Diana@exhaleyogasa.net", phone: "+966 54 593 7834", activity_total: 0, activity_verified: true });
    const g = buildMergeGroup(1, [master, dup], NONE)!;
    expect(g.master.zoho_contact_id).toBe("m");
    expect(g.duplicates.map((x) => x.zoho_contact_id)).toEqual(["d"]);
    expect(g.merged_preview.emails).toEqual(["Kakoook@gmail.com", "Diana@exhaleyogasa.net"]);
    // Same number in two formats collapses to one entry, in the master's
    // format. Listing it twice would imply the merge keeps a second number
    // that does not exist.
    expect(g.merged_preview.phones).toEqual(["0545937834"]);
    expect(g.merged_preview.activities).toBe(9);
    expect(g.activity_fully_counted).toBe(true);
    expect(g.matched_on.sort()).toEqual(["name", "phone"]);
  });

  it("refuses a pair that shares only ONE attribute", () => {
    // Two colleagues on the company switchboard. Same phone, nothing else.
    const a = c({ zoho_contact_id: "a", name: "Ali AlRajhi", email: "ali@co.com", phone: "0112345678" });
    const b = c({ zoho_contact_id: "b", name: "Khowla Saeed", email: "khowla@co.com", phone: "0112345678" });
    expect(buildMergeGroup(2, [a, b], NONE)).toBeNull();
  });

  it("honours the separation ledger — a rejected merge stays rejected", () => {
    const a = c({ zoho_contact_id: "a", name: "Same Person", email: "s@x.com", activity_total: 5, activity_verified: true });
    const b = c({ zoho_contact_id: "b", name: "Same Person", email: "s@x.com", activity_total: 0, activity_verified: true });
    const separated = new Set<string>(["a|b"]);
    expect(buildMergeGroup(3, [a, b], separated)).toBeNull();
  });

  it("reports the activity total as unknown when any side is uncounted", () => {
    const a = c({ zoho_contact_id: "a", name: "P", email: "p@x.com", activity_total: 4, activity_verified: true });
    const b = c({ zoho_contact_id: "b", name: "P", email: "p@x.com", activity_total: null });
    const g = buildMergeGroup(4, [a, b], NONE)!;
    expect(g.activity_fully_counted).toBe(false);
    expect(g.merged_preview.activities).toBeNull();
  });

  it("drops a stranger from a three-record cluster but keeps the real duplicate", () => {
    const master = c({ zoho_contact_id: "m", name: "Diana Ahmed", email: "d@x.com", phone: "0545937834", activity_total: 3, activity_verified: true });
    const real = c({ zoho_contact_id: "r", name: "Diana Ahmed", email: "d@x.com", phone: "0545937834", activity_total: 0, activity_verified: true });
    const stranger = c({ zoho_contact_id: "s", name: "Yazeed Alnassar", email: "y@x.com", phone: "0500000000", activity_total: 0, activity_verified: true });
    const g = buildMergeGroup(5, [master, real, stranger], NONE)!;
    expect(g.duplicates.map((x) => x.zoho_contact_id)).toEqual(["r"]);
  });
});
