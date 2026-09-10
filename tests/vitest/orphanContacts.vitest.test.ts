/**
 * The rule that decides whether a contact can be deleted outright.
 *
 * This is the same class of decision that once cost the Sales team their
 * activity history, so the tests pin the REFUSALS as hard as the approvals.
 * In particular: an uncounted contact is UNKNOWN, not empty, and unknown is
 * never deletable — absence of evidence is not evidence of absence.
 */
import { describe, it, expect } from "vitest";
import { isSafeToRemove, orphanReasons, type OrphanFacts } from "../../src/utils/orphanContacts";

/** A record that qualifies on every clause; each test breaks exactly one. */
const orphan = (o: Partial<OrphanFacts> = {}): OrphanFacts => ({
  zoho_contact_id: "c1",
  name: "-",
  account_id: null,
  deal_count: 0,
  email: null,
  phone: null,
  activity_total: 0,
  activity_verified: true,
  created_date: "2019-11-13T00:00:00.000Z",
  owner: "Naif Almutairi",
  ...o,
});

describe("isSafeToRemove", () => {
  it("accepts a record attached to nothing and holding nothing", () => {
    expect(isSafeToRemove(orphan())).toBe(true);
  });

  it("refuses a record whose activity was never counted", () => {
    // The failure mode that matters: a contact the census has not reached
    // looks identical to an empty one until you ask.
    expect(isSafeToRemove(orphan({ activity_total: null, activity_verified: false }))).toBe(false);
  });

  it("refuses a record counted but not verified", () => {
    // Bulk counts alone miss emails, notes and attachments.
    expect(isSafeToRemove(orphan({ activity_total: 0, activity_verified: false }))).toBe(false);
  });

  it("refuses a record that holds any activity", () => {
    expect(isSafeToRemove(orphan({ activity_total: 1 }))).toBe(false);
  });

  it("refuses a record linked to an Account", () => {
    expect(isSafeToRemove(orphan({ account_id: "5146753000000892515" }))).toBe(false);
  });

  it("refuses a record a Deal points at", () => {
    expect(isSafeToRemove(orphan({ deal_count: 1 }))).toBe(false);
  });

  it("refuses a record that still carries an email or a phone", () => {
    // Even with no activity, this is the only way to reach the person — and
    // it is something a merge could contribute to another record.
    expect(isSafeToRemove(orphan({ email: "someone@company.com" }))).toBe(false);
    expect(isSafeToRemove(orphan({ phone: "0545937834" }))).toBe(false);
  });

  it("treats whitespace-only contact details as absent", () => {
    expect(isSafeToRemove(orphan({ email: "   ", phone: "\t" }))).toBe(true);
  });
});

describe("orphanReasons", () => {
  it("reports what was checked, not just the verdict", () => {
    expect(orphanReasons(orphan())).toEqual([
      "no Account",
      "no Deal",
      "no email, no phone",
      "verified: no activity",
    ]);
  });

  it("names the uncounted case explicitly rather than implying empty", () => {
    const r = orphanReasons(orphan({ activity_total: null, activity_verified: false }));
    expect(r).toContain("activity NOT COUNTED yet");
  });

  it("reports the reasons a record failed to qualify", () => {
    const r = orphanReasons(orphan({ account_id: "a1", deal_count: 2, email: "x@y.com", activity_total: 5 }));
    expect(r).toEqual([
      "linked to an Account",
      "2 Deal(s) point at it",
      "has an email or phone",
      "5 activity(ies)",
    ]);
  });
});
