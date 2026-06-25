/**
 * Unit tests for the Duplicate Radar preflight classifier.
 *
 * Run: npx vitest run tests/vitest/duplicateRadarPreflight.vitest.test.ts
 *
 * Scope: pure logic in classifyPreflightRows + resolveDomain. The DB-touching
 * runPreflight wrapper is integration-tested manually against a live DB; here
 * we exercise the verdict ladder against a hand-built clustersByDomain map so
 * we don't need a database connection.
 */
import { describe, expect, test } from "vitest";
import {
  classifyPreflightRows,
  resolveDomain,
  resolvePhone,
  resolveCompany,
  shouldCreateForVerdict,
  buildClusterFromRecords,
  basicPreflightVerdict,
  matchProtectedAccount,
  type PreflightClusterRow,
  type PreflightRowMatch,
  type PreflightRecordRow,
} from "../../src/utils/duplicateRadarPreflight";

describe("resolveDomain", () => {
  test("uses explicit domain when present", () => {
    expect(resolveDomain({ domain: "Example.com" })).toBe("example.com");
  });
  test("falls back to email domain", () => {
    expect(resolveDomain({ email: "alice@example.com" })).toBe("example.com");
  });
  test("strips whitespace", () => {
    expect(resolveDomain({ domain: "  anb.com.sa  " })).toBe("anb.com.sa");
  });
  test("returns null when nothing parseable", () => {
    expect(resolveDomain({})).toBeNull();
    expect(resolveDomain({ email: "not-an-email" })).toBeNull();
  });
});

function fakeCluster(
  partial: Partial<PreflightClusterRow> & { domain: string },
): PreflightClusterRow {
  return {
    id: 1,
    cs_overlap_verdict: null,
    pipeline_lifecycle_state: null,
    client_sector: null,
    arr_exposure: 0,
    owners_involved: [],
    total_leads: 0,
    total_deals: 0,
    total_contacts: 0,
    total_accounts: 0,
    ...partial,
  };
}

describe("classifyPreflightRows verdict ladder", () => {
  test("no clusters → all rows pass", () => {
    const res = classifyPreflightRows({
      rows: [{ domain: "newco.com" }, { domain: "another.com" }],
      clustersByDomain: new Map(),
    });
    expect(res.summary.pass).toBe(2);
    expect(res.summary.block).toBe(0);
    expect(res.rows[0]!.verdict).toBe("pass");
  });

  test("block verdict from cluster cs_overlap_verdict=block", () => {
    const c = fakeCluster({
      id: 7,
      domain: "anb.com.sa",
      cs_overlap_verdict: "block",
      pipeline_lifecycle_state: "adoption",
      client_sector: "private",
      arr_exposure: 47511,
    });
    const res = classifyPreflightRows({
      rows: [{ domain: "anb.com.sa" }],
      clustersByDomain: new Map([["anb.com.sa", c]]),
    });
    expect(res.summary.block).toBe(1);
    expect(res.rows[0]!.verdict).toBe("block");
    expect(res.rows[0]!.cluster_id).toBe(7);
    expect(res.rows[0]!.arr_exposure).toBe(47511);
    expect(res.total_arr_exposure_blocked).toBe(47511);
  });

  test("review verdict from cluster cs_overlap_verdict=review", () => {
    const c = fakeCluster({
      domain: "ex.com",
      cs_overlap_verdict: "review",
      pipeline_lifecycle_state: "termination_recent",
      client_sector: "private",
    });
    const res = classifyPreflightRows({
      rows: [{ domain: "ex.com" }],
      clustersByDomain: new Map([["ex.com", c]]),
    });
    expect(res.summary.review).toBe(1);
    expect(res.rows[0]!.verdict).toBe("review");
  });

  test("warn verdict from cluster cs_overlap_verdict=warn", () => {
    const c = fakeCluster({
      domain: "ex.com",
      cs_overlap_verdict: "warn",
      pipeline_lifecycle_state: "termination_old",
    });
    const res = classifyPreflightRows({
      rows: [{ domain: "ex.com" }],
      clustersByDomain: new Map([["ex.com", c]]),
    });
    expect(res.summary.warn).toBe(1);
    expect(res.rows[0]!.verdict).toBe("warn");
  });

  test("duplicate verdict when cluster exists with no CS verdict", () => {
    const c = fakeCluster({
      domain: "ex.com",
      cs_overlap_verdict: null,
      total_leads: 3,
    });
    const res = classifyPreflightRows({
      rows: [{ domain: "ex.com" }],
      clustersByDomain: new Map([["ex.com", c]]),
    });
    expect(res.summary.duplicate).toBe(1);
    expect(res.rows[0]!.verdict).toBe("duplicate");
    expect(res.rows[0]!.reason).toMatch(/existing_record/);
  });

  test("mixed batch — summary tallies correctly", () => {
    const clusters = new Map<string, PreflightClusterRow>([
      [
        "active.com",
        fakeCluster({
          domain: "active.com",
          cs_overlap_verdict: "block",
          arr_exposure: 100,
        }),
      ],
      [
        "churned-recent.com",
        fakeCluster({
          domain: "churned-recent.com",
          cs_overlap_verdict: "review",
        }),
      ],
      [
        "churned-old.com",
        fakeCluster({
          domain: "churned-old.com",
          cs_overlap_verdict: "warn",
        }),
      ],
      [
        "dup.com",
        fakeCluster({ domain: "dup.com" }), // cs_overlap_verdict=null
      ],
    ]);
    const res = classifyPreflightRows({
      rows: [
        { domain: "active.com" },
        { domain: "churned-recent.com" },
        { domain: "churned-old.com" },
        { domain: "dup.com" },
        { domain: "newco.com" }, // no cluster
      ],
      clustersByDomain: clusters,
    });
    expect(res.summary).toEqual({
      block: 1,
      review: 1,
      warn: 1,
      duplicate: 1,
      pass: 1,
    });
    expect(res.total_arr_exposure_blocked).toBe(100);
  });

  test("rows without resolvable domain → pass with no_domain_resolved reason", () => {
    const res = classifyPreflightRows({
      rows: [{}, { email: "bad" }],
      clustersByDomain: new Map(),
    });
    expect(res.summary.pass).toBe(2);
    for (const r of res.rows) {
      expect(r.reason).toBe("no_domain_resolved");
    }
  });

  test("max_check caps examined rows, extras counted as skipped", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      domain: `co${i}.com`,
    }));
    const res = classifyPreflightRows({
      rows,
      clustersByDomain: new Map(),
      max_check: 3,
    });
    expect(res.total_rows).toBe(10);
    expect(res.examined).toBe(3);
    expect(res.skipped).toBe(7);
    expect(res.rows.length).toBe(3);
  });

  test("ref is echoed back when provided", () => {
    const res = classifyPreflightRows({
      rows: [{ domain: "x.com", ref: "row-42" }],
      clustersByDomain: new Map(),
    });
    expect(res.rows[0]!.ref).toBe("row-42");
  });

  test("string arr_exposure is parsed to number", () => {
    const c = fakeCluster({
      domain: "x.com",
      cs_overlap_verdict: "block",
      arr_exposure: "12345.67" as any,
    });
    const res = classifyPreflightRows({
      rows: [{ domain: "x.com" }],
      clustersByDomain: new Map([["x.com", c]]),
    });
    expect(res.rows[0]!.arr_exposure).toBeCloseTo(12345.67);
    expect(res.total_arr_exposure_blocked).toBeCloseTo(12345.67);
  });

  test("owners_involved JSON array is surfaced (max 5)", () => {
    const c = fakeCluster({
      domain: "x.com",
      cs_overlap_verdict: "block",
      owners_involved: [
        "alice@walaplus.com",
        "bob@walaplus.com",
        "carol@walaplus.com",
        "dan@walaplus.com",
        "eve@walaplus.com",
        "frank@walaplus.com",
      ],
    });
    const res = classifyPreflightRows({
      rows: [{ domain: "x.com" }],
      clustersByDomain: new Map([["x.com", c]]),
    });
    expect(res.rows[0]!.owners).toHaveLength(5);
    expect(res.rows[0]!.owners[0]).toBe("alice@walaplus.com");
  });
});

// ── 2026-06-11 — phone + company-name fallback paths ──────────────────────
describe("resolvePhone", () => {
  test("normalises and accepts phone with ≥7 digits", () => {
    expect(resolvePhone({ phone: "0599 555 375" })).toBe("599555375");
  });
  test("drops phone with <7 digits", () => {
    expect(resolvePhone({ phone: "555" })).toBeNull();
  });
  test("returns null when phone missing", () => {
    expect(resolvePhone({})).toBeNull();
  });
});

describe("resolveCompany", () => {
  test("normalises a company name", () => {
    expect(resolveCompany({ company_name: "Schlumberger SLB" })).toMatch(/schlumberger/);
  });
  test("drops names with <3 normalised chars", () => {
    expect(resolveCompany({ company_name: "AB" })).toBeNull();
  });
  test("keeps 3-char brand names (STC/PIF/NDMC) so they attempt a match", () => {
    expect(resolveCompany({ company_name: "STC" })).not.toBeNull();
  });
  test("returns null when missing", () => {
    expect(resolveCompany({})).toBeNull();
  });
});

describe("classifyPreflightRows — phone & company-name match paths", () => {
  const blockCluster: PreflightClusterRow = {
    id: 42,
    domain: "schlumberger.com",
    cs_overlap_verdict: "block",
    pipeline_lifecycle_state: "adoption",
    client_sector: "private",
    arr_exposure: 1_000_000,
    owners_involved: ["ali@walaplus.com"],
    total_leads: 0,
    total_deals: 2,
    total_contacts: 7,
    total_accounts: 1,
  };

  test("phone-only row matched via phone returns BLOCK with matched_via='phone'", () => {
    const matchByRow = new Map<number, PreflightRowMatch>([
      [0, { cluster: blockCluster, matched_via: "phone" }],
    ]);
    const res = classifyPreflightRows({
      rows: [{ phone: "0599 555 375" }],
      matchByRow,
    });
    expect(res.rows[0]!.verdict).toBe("block");
    expect(res.rows[0]!.matched_via).toBe("phone");
    expect(res.rows[0]!.reason).toBe("phone_match__active_cs_customer");
    expect(res.rows[0]!.arr_exposure).toBe(1_000_000);
  });

  test("company-name-only row matched via fuzzy returns BLOCK with matched_via='company_name'", () => {
    const matchByRow = new Map<number, PreflightRowMatch>([
      [0, { cluster: blockCluster, matched_via: "company_name" }],
    ]);
    const res = classifyPreflightRows({
      rows: [{ company_name: "Schlumberger SLB" }],
      matchByRow,
    });
    expect(res.rows[0]!.verdict).toBe("block");
    expect(res.rows[0]!.matched_via).toBe("company_name");
    expect(res.rows[0]!.reason).toBe("company_fuzzy_match__active_cs_customer");
  });

  test("no match falls through to PASS with matched_via=null", () => {
    const res = classifyPreflightRows({
      rows: [{ phone: "0599 555 375" }],
      matchByRow: new Map(),
    });
    expect(res.rows[0]!.verdict).toBe("pass");
    expect(res.rows[0]!.matched_via).toBeNull();
  });

  test("domain match wins over phone match when both present (priority)", () => {
    // Domain match should set matched_via='domain' with NO prefix on reason.
    const matchByRow = new Map<number, PreflightRowMatch>([
      [0, { cluster: blockCluster, matched_via: "domain" }],
    ]);
    const res = classifyPreflightRows({
      rows: [{ domain: "schlumberger.com", phone: "0599555375" }],
      matchByRow,
    });
    expect(res.rows[0]!.matched_via).toBe("domain");
    expect(res.rows[0]!.reason).toBe("active_cs_customer"); // no prefix
  });
});

describe("shouldCreateForVerdict (R5 — webhook decision policy)", () => {
  // BLOCK and REVIEW are stop-the-create verdicts. The webhook should
  // return should_create=false so a Zoho-side workflow can refuse the
  // insert and route the record to the existing owner / CS instead.
  test("block → false", () => {
    expect(shouldCreateForVerdict("block")).toBe(false);
  });
  test("review → false", () => {
    expect(shouldCreateForVerdict("review")).toBe(false);
  });

  // WARN / DUPLICATE / PASS are allow verdicts. The caller may still
  // tag the record for operator follow-up, but the create itself goes
  // through — these aren't active CS customers, just historical context.
  test("warn → true (past cool-off, sales may re-engage)", () => {
    expect(shouldCreateForVerdict("warn")).toBe(true);
  });
  test("duplicate → true (existing records but no active CS overlap)", () => {
    expect(shouldCreateForVerdict("duplicate")).toBe(true);
  });
  test("pass → true (genuinely new)", () => {
    expect(shouldCreateForVerdict("pass")).toBe(true);
  });

  // Defensive defaults: any verdict the policy doesn't know about must
  // fall to the conservative "do not create" answer rather than silently
  // greenlighting an unknown state.
  test("unknown verdict → false (conservative default)", () => {
    expect(shouldCreateForVerdict("hold" as any)).toBe(false);
    expect(shouldCreateForVerdict("" as any)).toBe(false);
    expect(shouldCreateForVerdict(null)).toBe(false);
    expect(shouldCreateForVerdict(undefined)).toBe(false);
  });
});

describe("buildClusterFromRecords — Tier-1 company state engine", () => {
  const TODAY = Date.parse("2026-06-17T00:00:00Z");
  const rec = (o: Partial<PreflightRecordRow>): PreflightRecordRow => ({
    cluster_id: 5, domain: "acme.com", record_type: "deal", stage: null, status: null,
    lead_status: null, churn_date: null, gov_type: null, owner_name: "Owner A",
    record_name: "Acme", company_name: "Acme Corp", zoho_record_id: "1",
    layout_name: null, account_type: null, lead_type: null, ...o,
  });

  test("current customer (Paid, no churn) → BLOCK", () => {
    const c = buildClusterFromRecords("acme.com", [rec({ stage: "Paid" })], TODAY)!;
    expect(c.cs_overlap_verdict).toBe("block");
    expect(c.has_corporate_records).toBe(true);
  });

  test("churned within Private 180-day cool-off → REVIEW", () => {
    const c = buildClusterFromRecords("acme.com",
      [rec({ stage: "Paid", churn_date: "2026-05-01" })], TODAY)!;
    expect(c.cs_overlap_verdict).toBe("review");
  });

  test("churned past Private cool-off → WARN", () => {
    const c = buildClusterFromRecords("acme.com",
      [rec({ stage: "Agreement Signed", churn_date: "2024-01-01" })], TODAY)!;
    expect(c.cs_overlap_verdict).toBe("warn");
  });

  test("government churn within 365-day window → REVIEW (not WARN)", () => {
    const c = buildClusterFromRecords("acme.gov.sa",
      [rec({ stage: "Paid", churn_date: "2025-10-01", gov_type: "Government" })], TODAY)!;
    expect(c.cs_overlap_verdict).toBe("review");
    expect(c.client_sector).toBe("government");
  });

  test("active open deal (Proposal) → no cs verdict, has_active_deal", () => {
    const c = buildClusterFromRecords("acme.com", [rec({ stage: "Proposal" })], TODAY)!;
    expect(c.cs_overlap_verdict).toBeNull();
    expect(c.has_active_deal).toBe(true);
  });

  test("closed-lost only → no cs verdict, no active deal, deals counted", () => {
    const c = buildClusterFromRecords("acme.com", [rec({ stage: "Closed Lost" })], TODAY)!;
    expect(c.cs_overlap_verdict).toBeNull();
    expect(c.has_active_deal).toBe(false);
    expect(c.total_deals).toBe(1);
  });

  test("active lead detected from a worked Lead_Status", () => {
    const c = buildClusterFromRecords("acme.com",
      [rec({ record_type: "lead", stage: null, lead_status: "Contacted" })], TODAY)!;
    expect(c.has_active_lead).toBe(true);
  });

  test("cold lead statuses (New / Attempted to Contact / Not Qualified) are NOT active", () => {
    for (const s of ["New", "Attempted to Contact", "Not Qualified"]) {
      const c = buildClusterFromRecords("acme.com",
        [rec({ record_type: "lead", stage: null, lead_status: s })], TODAY)!;
      expect(c.has_active_lead).toBe(false);
    }
  });

  test("entirely marketplace/merchant → out of scope (null)", () => {
    const c = buildClusterFromRecords("shop.com",
      [rec({ record_type: "account", stage: null, layout_name: "Marketplace" })], TODAY);
    expect(c).toBeNull();
  });
});

describe("resolveCompany — generic-name blacklist", () => {
  test("drops placeholder company names", () => {
    expect(resolveCompany({ company_name: "Confidential" })).toBeNull();
    expect(resolveCompany({ company_name: "N/A" })).toBeNull();
    expect(resolveCompany({ company_name: "Unknown" })).toBeNull();
  });
  test("keeps a real company name", () => {
    expect(resolveCompany({ company_name: "Saudi Aramco" })).not.toBeNull();
  });
});

describe("basicPreflightVerdict — the two foundational rules (2026-06-18)", () => {
  test("RULE 1 — duplicate contact by email → reject", () => {
    const v = basicPreflightVerdict({ contactVia: "email", isCustomerDomain: false });
    expect(v.verdict).toBe("duplicate");
    expect(v.reason).toBe("contact_duplicate_email");
    expect(v.executive_severity).toBe("high");
    expect(v.executive_action).toMatch(/REJECT/i);
  });

  test("RULE 1 — duplicate contact by phone → reject", () => {
    const v = basicPreflightVerdict({ contactVia: "phone", isCustomerDomain: false });
    expect(v.verdict).toBe("duplicate");
    expect(v.reason).toBe("contact_duplicate_phone");
  });

  test("RULE 1 takes precedence over RULE 2", () => {
    const v = basicPreflightVerdict({ contactVia: "email", isCustomerDomain: true });
    expect(v.verdict).toBe("duplicate");
  });

  test("RULE 2 — existing customer domain (no contact dup) → block", () => {
    const v = basicPreflightVerdict({ contactVia: null, isCustomerDomain: true });
    expect(v.verdict).toBe("block");
    expect(v.reason).toBe("existing_customer_signed_or_paid");
    expect(v.executive_severity).toBe("critical");
  });

  test("neither rule → pass", () => {
    const v = basicPreflightVerdict({ contactVia: null, isCustomerDomain: false });
    expect(v.verdict).toBe("pass");
    expect(v.executive_action).toBe("Safe to import.");
  });
});

describe("matchProtectedAccount — do-not-contact named accounts", () => {
  test("blocks Saudi Aramco by domain", () => {
    expect(matchProtectedAccount("aramco.com", null)?.label).toBe(
      "Saudi Aramco (group)",
    );
    expect(matchProtectedAccount("mail.aramco.com", null)?.label).toBe(
      "Saudi Aramco (group)",
    );
  });
  test("blocks Aramco subsidiaries that do NOT contain 'Aramco' — by name + domain", () => {
    // SASREF / ARO Drilling have no 'aramco' token, so name keywords matter
    expect(matchProtectedAccount(null, "SASREF")?.label).toBe(
      "Saudi Aramco (group)",
    );
    expect(matchProtectedAccount(null, "ARO Drilling")?.label).toBe(
      "Saudi Aramco (group)",
    );
    expect(matchProtectedAccount("satorp.com", null)?.label).toBe(
      "Saudi Aramco (group)",
    );
    expect(matchProtectedAccount("agoc.com.sa", null)?.label).toBe(
      "Saudi Aramco (group)",
    );
  });
  test("blocks Aramco JVs by their full company name", () => {
    expect(
      matchProtectedAccount(
        "#n",
        "Yanbu Aramco Sinopec Refining Company (YASREF) Ltd.",
      )?.label,
    ).toBe("Saudi Aramco (group)");
    expect(
      matchProtectedAccount(null, "Saudi Aramco Base Oil Company-Luberef")
        ?.label,
    ).toBe("Saudi Aramco (group)");
  });
  test("blocks Syarah", () => {
    expect(matchProtectedAccount(null, "Syarah")?.label).toBe("Syarah");
    expect(matchProtectedAccount("syarah.com", null)?.label).toBe("Syarah");
  });
  test("blocks Tree — exact whole-name even with decorative emoji", () => {
    expect(matchProtectedAccount("#n", "Tree 🌳")?.label).toBe("Tree");
    expect(matchProtectedAccount(null, "Tree")?.label).toBe("Tree");
  });
  test("does NOT over-block: 'tree' is whole-name only", () => {
    // substring "tree" must not catch unrelated companies
    expect(matchProtectedAccount(null, "Family Tree Trading")).toBeNull();
    expect(matchProtectedAccount(null, "Palm Tree Resort")).toBeNull();
  });
  test("ignores ordinary companies", () => {
    expect(matchProtectedAccount("totalenergies.com", "TotalEnergies")).toBeNull();
    expect(matchProtectedAccount(null, "Arabio")).toBeNull();
    expect(matchProtectedAccount("#n", "Trinidad Drilling")).toBeNull();
  });
});
