/**
 * Unit tests for preflightStructuredPush constants.
 * Run: npx tsx src/utils/preflightStructuredPush.test.ts
 * (Co-located src/utils/*.test.ts run via the tsx harness in
 *  tests/runIntegrationTests.ts — NOT vitest, which is scoped to tests/vitest/**.)
 */
import assert from "node:assert";

let passed = 0;
let failed = 0;
function assertEq(cond: boolean, label: string): void {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

import { PREFLIGHT_DEAL_TARGET, PREFLIGHT_LEAD_TARGET, splitContactName } from "./preflightStructuredPush";
assertEq(PREFLIGHT_DEAL_TARGET.layoutId === "<REDACTED_ID>", "deal layout id default (ExampleOrg Deals layout)");
assertEq(PREFLIGHT_DEAL_TARGET.pipeline === "Standard (Corporates)", "deal pipeline default");
assertEq(PREFLIGHT_DEAL_TARGET.stage === "New Deal", "deal stage default");
assertEq(PREFLIGHT_LEAD_TARGET.layoutId === "<REDACTED_ID>", "lead layout id default");
assertEq(PREFLIGHT_LEAD_TARGET.status === "New Lead", "lead status default");
console.log("preflightStructuredPush constants ok");

if (failed > 0) { console.error(`\n${failed} test(s) FAILED`); process.exit(1); }

// ---------------------------------------------------------------------------
// splitContactName tests
// ---------------------------------------------------------------------------
{
  const r1 = splitContactName("Sally Mahasna");
  assertEq(r1.first === "Sally" && r1.last === "Mahasna", "splitContactName: two-token name");

  const r2 = splitContactName("Sulaiman Al Qafari");
  assertEq(r2.first === "Sulaiman Al" && r2.last === "Qafari", "splitContactName: three-token name");

  const r3 = splitContactName("Basserah");
  assertEq(r3.first === "" && r3.last === "Basserah", "splitContactName: single token");

  const r4 = splitContactName("");
  assertEq(r4.first === "" && r4.last === "", "splitContactName: empty string");

  const r5 = splitContactName(null);
  assertEq(r5.first === "" && r5.last === "", "splitContactName: null");

  const r6 = splitContactName(undefined);
  assertEq(r6.first === "" && r6.last === "", "splitContactName: undefined");
}
if (failed > 0) { console.error(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log("splitContactName ok");

// ---------------------------------------------------------------------------
// Task 2: buildStructuredPushPlan tests
// ---------------------------------------------------------------------------
import { buildStructuredPushPlan, normalizeCompanyKey } from "./preflightStructuredPush";
const mk = (o: Partial<any>): any => ({ row_index: 0, company: "", domain: "", email: "", phone: "", contact_name: "Sample User", verdict: "pass", cluster_id: null, lifecycle_state: null, ...o });

// normalizeCompanyKey
assertEq(normalizeCompanyKey("  Example Organization  Co ", "") === "Example Organization  co", "company key trims+lowercases");
assertEq(normalizeCompanyKey("", "<REDACTED_HOST>") === "<REDACTED_HOST>", "falls back to domain");

// A1 — churned past cool-off, matched → one company entry, carries clusterId
{
  const rows = [mk({ row_index: 1, company: "Churn Co", email: "<REDACTED_EMAIL>", verdict: "pass", cluster_id: 9, lifecycle_state: "termination_old" })];
  const p = buildStructuredPushPlan(1, rows, {});
  assertEq(p.companies.length === 1 && p.companies[0].clusterId === 9, "A1 picks churned-matched company");
  assertEq(p.eligible_count === 1 && p.contact_count === 1, "A1 counts");
}
// A1 — churned past cool-off with NO cluster_id (basic-mode CS-directory match):
// still eligible — the endpoint resolves the account by domain/name.
{
  const rows = [mk({ row_index: 1, company: "Churn Co", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>", verdict: "pass", cluster_id: null, lifecycle_state: "termination_old" })];
  const p = buildStructuredPushPlan(1, rows, {});
  assertEq(p.companies.length === 1 && p.companies[0].clusterId === null, "A1 picks churned company even without cluster_id");
}
// A1 ignores a genuinely-new, non-matched company (no existing account, not
// churned, no cluster) — that belongs in A2/A3, not A1.
{
  const rows = [mk({ row_index: 1, company: "New Co", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>", verdict: "pass" })];
  const p = buildStructuredPushPlan(1, rows, {});
  assertEq(p.companies.length === 0, "A1 skips a non-matched new company");
}
// A1 LINKS a contact that matched an existing account (matched_account_CRMProvider_id),
// grouped by the resolved account id and named by the resolved account NAME
// (not the row's wrong label).
{
  const rows = [mk({ row_index: 1, company: "Whatever Label", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>", matched_account_CRMProvider_id: "ACC1", matched_account_name: "Riyad Bank" })];
  const p = buildStructuredPushPlan(1, rows, {});
  assertEq(p.companies.length === 1 && p.companies[0].companyKey === "ACC1", "A1 links a matched contact, keyed by account id");
  assertEq(p.companies[0].companyName === "Riyad Bank", "A1 names the group by the RESOLVED account name, not the label");
}
// Two contacts under ONE wrong label but matched to DIFFERENT accounts → two
// separate A1 links (never merged under the bad label).
{
  const rows = [
    mk({ row_index: 1, company: "Maersk", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>", matched_account_CRMProvider_id: "ACC_A" }),
    mk({ row_index: 2, company: "Maersk", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>", matched_account_CRMProvider_id: "ACC_B" }),
  ];
  const p = buildStructuredPushPlan(1, rows, {});
  assertEq(p.companies.length === 2, "A1 splits same-label contacts matched to different accounts");
}
// Matched + unmatched under one label SPLIT: matched → A1, new → A3.
{
  const rows = [
    mk({ row_index: 1, company: "New Startup", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>", matched_account_CRMProvider_id: "ACC1" }),
    mk({ row_index: 2, company: "New Startup", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>" }),
  ];
  const a1 = buildStructuredPushPlan(1, rows, {});
  assertEq(a1.companies.length === 1 && a1.companies[0].companyKey === "ACC1" && a1.companies[0].contacts.length === 1, "ladder: matched contact → A1 (link)");
  const a3 = buildStructuredPushPlan(3, rows, {});
  assertEq(a3.companies.length === 1 && a3.companies[0].companyName === "New Startup" && a3.companies[0].contacts.length === 1, "ladder: unmatched colleague → A3 (new)");
}
// A2 — new company with 2 contacts → one company, 2 contacts
{
  const rows = [
    mk({ row_index: 1, company: "New Multi", email: "<REDACTED_EMAIL>" }),
    mk({ row_index: 2, company: "New Multi", phone: "<REDACTED_PHONE>" }),
  ];
  const p = buildStructuredPushPlan(2, rows, {});
  assertEq(p.companies.length === 1 && p.companies[0].contacts.length === 2, "A2 groups 2 contacts into one company");
}
// A2 ignores a single-contact company
{
  const rows = [mk({ row_index: 1, company: "Solo Co", email: "<REDACTED_EMAIL>" })];
  const p = buildStructuredPushPlan(2, rows, {});
  assertEq(p.companies.length === 0, "A2 excludes single-contact company");
}
// A3 — single-contact new companies (verified by their own corporate email),
// sliced by count/offset.
{
  const rows = [
    mk({ row_index: 1, company: "S1", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>" }),
    mk({ row_index: 2, company: "S2", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>" }),
    mk({ row_index: 3, company: "S3", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>" }),
  ];
  const a3 = buildStructuredPushPlan(3, rows, { count: 2 });
  assertEq(a3.companies.length === 2 && a3.companies[0].companyName === "S1" && a3.companies[1].companyName === "S2", "A3 takes first 2");
  const a3b = buildStructuredPushPlan(3, rows, { count: 2, offset: 2 });
  assertEq(a3b.companies.length === 1 && a3b.companies[0].companyName === "S3", "A3 offset 2 -> S3");
}
// A4 — lead-routed rows only (free-mail / phone-only at unverifiable
// companies), each an individual Lead, sliced by count/offset.
{
  const rows = [
    mk({ row_index: 1, company: "LeadCo1", phone: "<REDACTED_PHONE>" }),          // no email, no domain -> lead
    mk({ row_index: 2, company: "LeadCo2", email: "<REDACTED_EMAIL>" }),        // free-mail, unverifiable -> lead
    mk({ row_index: 3, company: "Verified", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>" }), // account-routed, NOT a lead
  ];
  const a4all = buildStructuredPushPlan(4, rows, {});
  assertEq(a4all.leads.length === 2, "A4 = both lead-routed rows (verified account row excluded)");
  const a4slice = buildStructuredPushPlan(4, rows, { count: 1, offset: 0 });
  assertEq(a4slice.leads.length === 1 && a4slice.leads[0].company === "LeadCo1", "A4 slice: first lead");
  const a4next = buildStructuredPushPlan(4, rows, { count: 1, offset: 1 });
  assertEq(a4next.leads.length === 1 && a4next.leads[0].company === "LeadCo2", "A4 slice: next lead");
}
// No company identity (no company name AND no real domain) — even with a
// corporate email — routes to a LEAD (never dropped, never a new account).
{
  const rows = [
    mk({ row_index: 1, company: "", domain: "", email: "<REDACTED_EMAIL>", phone: "<REDACTED_PHONE>" }),
  ];
  const a4 = buildStructuredPushPlan(4, rows, {});
  assertEq(a4.leads.length === 1, "no-company corporate-email contact → lead (not dropped)");
  const a3 = buildStructuredPushPlan(3, rows, {});
  assertEq(a3.companies.length === 0, "no-company contact never opens a new account");
}
// PASS-gate: non-PASS rows (block / review / duplicate / no-contact) are NEVER
// pushable — not via A1 (even if they match an existing account), not via A4.
{
  const rows = [
    mk({ row_index: 1, company: "Dup Co", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>", matched_account_CRMProvider_id: "ACC1", verdict: "duplicate" }),
    mk({ row_index: 2, company: "Blocked", domain: "#n", phone: "<REDACTED_PHONE>", verdict: "block" }),
    mk({ row_index: 3, company: "Good", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>", verdict: "pass" }),
  ];
  assertEq(buildStructuredPushPlan(1, rows, {}).companies.length === 0, "PASS-gate: duplicate row excluded from A1 even with a matched account");
  assertEq(buildStructuredPushPlan(4, rows, {}).leads.length === 0, "PASS-gate: block row excluded from A4");
  const a3 = buildStructuredPushPlan(3, rows, {});
  assertEq(a3.companies.length === 1 && a3.companies[0].companyName === "Good", "PASS-gate: only the pass row survives");
}
// Deal split — of the NEW companies, only dealPercent% become deals (richest
// first); the rest are parked as leads. Unverifiable contacts stay leads.
{
  // 4 genuinely-new single-contact companies (all A3-eligible), 1 free-mail lead.
  const rows = [
    mk({ row_index: 1, company: "NewA", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>" }),
    mk({ row_index: 2, company: "NewB", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>" }),
    mk({ row_index: 3, company: "NewC", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>" }),
    mk({ row_index: 4, company: "NewD", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>" }),
    mk({ row_index: 5, company: "FreeLead", email: "<REDACTED_EMAIL>" }),
  ];
  // 100% (default) → all 4 new companies are deals, only the free-mail is a lead.
  assertEq(buildStructuredPushPlan(3, rows, { dealPercent: 100 }).companies.length === 4, "split 100%: all 4 new companies are deals");
  assertEq(buildStructuredPushPlan(4, rows, { dealPercent: 100 }).leads.length === 1, "split 100%: only free-mail is a lead");
  // 25% → ceil(0.25*4)=1 deal, other 3 parked as leads (+ the free-mail = 4).
  assertEq(buildStructuredPushPlan(3, rows, { dealPercent: 25 }).companies.length === 1, "split 25%: 1 new company is a deal");
  assertEq(buildStructuredPushPlan(4, rows, { dealPercent: 25 }).leads.length === 4, "split 25%: 3 parked + 1 free-mail = 4 leads");
  // 0% → no deals, all 4 new companies parked as leads (+ free-mail = 5).
  assertEq(buildStructuredPushPlan(3, rows, { dealPercent: 0 }).companies.length === 0, "split 0%: no deals");
  assertEq(buildStructuredPushPlan(4, rows, { dealPercent: 0 }).leads.length === 5, "split 0%: all parked as leads");
  // Omitted dealPercent = back-compat 100%.
  assertEq(buildStructuredPushPlan(3, rows, {}).companies.length === 4, "split omitted: defaults to all-deals");
}
console.log("buildStructuredPushPlan ok");

// ---------------------------------------------------------------------------
// Regression (2026-07-01): the preflight result row MUST echo the contact
// identity (email/phone/contact_name). It used to carry only input.domain +
// input.company_name, so the row->SPRow mapping produced empty email/phone,
// every group's contact-count was 0, and ALL four Structured Push actions
// returned 0 / "PASS remaining: 0". This pins the field names the builder has
// to emit, by running a builder-shaped row through the same mapping the
// endpoint + frontend use, then through the real planner.
// ---------------------------------------------------------------------------
function preflightRowToSPRow(r: any, idx: number): any {
  return {
    row_index: r.row_index != null ? r.row_index : idx,
    company: (r.input && r.input.company_name) || r.company_name || "",
    domain: (r.input && r.input.domain) || r.domain || "",
    email: r.email || "",
    phone: r.phone || "",
    contact_name: r.contact_name || (r.input && r.input.contact_name) || "",
    verdict: r.verdict || "",
    cluster_id: r.cluster_id != null ? r.cluster_id : null,
    lifecycle_state: r.lifecycle_state != null ? r.lifecycle_state : null,
  };
}
// OLD (broken) shape — input only domain+company_name, no echoed contact.
{
  const oldRow = { row_index: 1, input: { domain: "<REDACTED_HOST>", company_name: "Example Organization" }, verdict: "pass", cluster_id: null };
  const plan = buildStructuredPushPlan(3, [preflightRowToSPRow(oldRow, 0)], { count: 5 });
  assertEq(plan.companies.length === 0, "regression: PASS row with NO echoed contact -> A3 pool empty (the bug)");
}
// FIXED shape — email echoed top-level (what runPreflightBasic now emits).
{
  const newRow = { row_index: 1, input: { domain: "<REDACTED_HOST>", company_name: "Example Organization" }, email: "<REDACTED_EMAIL>", phone: null, contact_name: null, verdict: "pass", cluster_id: null };
  const plan = buildStructuredPushPlan(3, [preflightRowToSPRow(newRow, 0)], { count: 5 });
  assertEq(plan.companies.length === 1 && plan.companies[0].contacts.length === 1, "regression: PASS row WITH echoed email -> A3 picks it up (the fix)");
}
console.log("preflight row-shape regression ok");

// ---------------------------------------------------------------------------
// websiteFromDomain — must suppress placeholder/free-mail domains so the push
// never writes "<REDACTED_URL>" / "<REDACTED_URL>" onto new Accounts/Leads.
// ---------------------------------------------------------------------------
import { websiteFromDomain } from "./preflightStructuredPush";
{
  assertEq(websiteFromDomain("<REDACTED_HOST>") === "<REDACTED_URL>", "website: real domain kept");
  assertEq(websiteFromDomain("<REDACTED_HOST>") === "<REDACTED_URL>", "website: lowercased");
  assertEq(websiteFromDomain("<REDACTED_URL>") === "<REDACTED_URL>", "website: strips scheme+path");
  assertEq(websiteFromDomain("<REDACTED_HOST>.uk") === "<REDACTED_URL>", "website: multi-label kept");
  assertEq(websiteFromDomain("#n") === null, "website: #n placeholder suppressed");
  assertEq(websiteFromDomain("gmail") === null, "website: bare free-mail token suppressed");
  assertEq(websiteFromDomain("<REDACTED_HOST>") === null, "website: free-mail domain suppressed");
  assertEq(websiteFromDomain("N/A") === null, "website: N/A suppressed");
  assertEq(websiteFromDomain("<REDACTED_HOST>") === null, "website: no-dot token suppressed");
  assertEq(websiteFromDomain("") === null, "website: empty -> null");
  assertEq(websiteFromDomain(null) === null, "website: null -> null");
}
console.log("websiteFromDomain ok");

// ---------------------------------------------------------------------------
// Fuzzy identity helpers (possible-existing-client flag).
// ---------------------------------------------------------------------------
import { normalizeCoreName, significantTokens, domainRootToken } from "./preflightStructuredPush";
{
  assertEq(normalizeCoreName("Example Organization Trading Co.") === "Example Organization trading", "core: strips legal suffix + punctuation");
  assertEq(normalizeCoreName("Example Organization trading") === "Example Organization trading", "core: already normalized");
  assertEq(normalizeCoreName("Shaqra University | جامعة شقراء") === "shaqra university", "core: drops bilingual half");
  assertEq(normalizeCoreName("Al Rajhi Bank") === "al rajhi bank", "core: keeps distinguishing words (not an article strip)");
  assertEq(significantTokens("Arabian Drilling Co.").join(",") === "arabian,drilling", "tokens: >=4-char core tokens");
  assertEq(domainRootToken("<REDACTED_HOST>") === "arabiandrilling", "domainRoot: .com");
  assertEq(domainRootToken("<REDACTED_HOST>") === "kfshrc", "domainRoot: .<REDACTED_HOST> multi-part TLD");
  assertEq(domainRootToken("<REDACTED_HOST>") === "Example Organization", "domainRoot: subdomain");
  assertEq(domainRootToken("#n") === "", "domainRoot: placeholder -> empty");
  assertEq(domainRootToken("<REDACTED_EMAIL>") === "riyadbank", "domainRoot: from an email");
}
console.log("fuzzy identity helpers ok");

// ---------------------------------------------------------------------------
// A1/A2 slicing — count/offset must window the eligible companies so a big
// batch can be pushed in timeout-safe slices. count<=0 = all (back-compat).
// ---------------------------------------------------------------------------
{
  // 5 distinct churned companies (past cool-off) -> A1 eligible.
  const churned: any[] = [];
  for (let i = 0; i < 5; i++) {
    churned.push(mk({ row_index: i, company: `C${i}`, email: `c${i}@<REDACTED_HOST>`, verdict: "pass", lifecycle_state: "termination_old" }));
  }
  const a1All = buildStructuredPushPlan(1, churned, {});
  assertEq(a1All.companies.length === 5, "A1 slice: count omitted -> all 5");
  const a1First = buildStructuredPushPlan(1, churned, { count: 2, offset: 0 });
  assertEq(a1First.companies.length === 2 && a1First.companies[0].companyName === "C0" && a1First.companies[1].companyName === "C1", "A1 slice: first 2 (C0,C1)");
  const a1Mid = buildStructuredPushPlan(1, churned, { count: 2, offset: 2 });
  assertEq(a1Mid.companies.length === 2 && a1Mid.companies[0].companyName === "C2", "A1 slice: offset 2 -> C2,C3");
  const a1Tail = buildStructuredPushPlan(1, churned, { count: 2, offset: 4 });
  assertEq(a1Tail.companies.length === 1 && a1Tail.companies[0].companyName === "C4" && a1Tail.eligible_count === 1, "A1 slice: tail shorter than count");

  // 5 distinct multi-contact NEW companies -> A2 eligible (2 contacts each).
  const multi: any[] = [];
  for (let i = 0; i < 5; i++) {
    multi.push(mk({ row_index: i * 2, company: `M${i}`, email: `a${i}@<REDACTED_HOST>`, verdict: "pass" }));
    multi.push(mk({ row_index: i * 2 + 1, company: `M${i}`, phone: `12300${i}`, verdict: "pass" }));
  }
  const a2All = buildStructuredPushPlan(2, multi, {});
  assertEq(a2All.companies.length === 5, "A2 slice: count omitted -> all 5");
  const a2Slice = buildStructuredPushPlan(2, multi, { count: 2, offset: 0 });
  assertEq(a2Slice.companies.length === 2 && a2Slice.eligible_count === 2, "A2 slice: first 2 companies");
  const a2Next = buildStructuredPushPlan(2, multi, { count: 2, offset: 2 });
  assertEq(a2Next.companies.length === 2 && a2Next.companies[0].companyName === "M2", "A2 slice: offset 2 -> M2,M3");
}
console.log("A1/A2 slicing ok");

// ---------------------------------------------------------------------------
// routeContactsByDomainConsistency — the domain-consistency router.
// ---------------------------------------------------------------------------
import { routeContactsByDomainConsistency } from "./preflightStructuredPush";
{
  const routeOf = (rows: any[]) => {
    const m: Record<number, string> = {};
    routeContactsByDomainConsistency(rows).forEach(r => { m[r.row_index] = r.route; });
    return m;
  };

  // Verified company (one email matches the domain): matching email + phone-only
  // colleague are kept; a contradicting corporate email is rejected.
  {
    const rows = [
      mk({ row_index: 1, company: "Example Organization", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>" }),
      mk({ row_index: 2, company: "Example Organization", domain: "<REDACTED_HOST>", phone: "<REDACTED_PHONE>" }),
      mk({ row_index: 3, company: "Example Organization", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>" }),
    ];
    const r = routeOf(rows);
    assertEq(r[1] === "account", "route: email matches company domain -> account");
    assertEq(r[2] === "account", "route: phone-only colleague of verified company -> account");
    assertEq(r[3] === "reject", "route: contradicting corporate email -> reject");
  }

  // The Maersk case: two corporate emails, NEITHER matching the company domain
  // -> unverifiable company -> both rejected (no false Account created).
  {
    const rows = [
      mk({ row_index: 1, company: "Maersk", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>" }),
      mk({ row_index: 2, company: "Maersk", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>" }),
    ];
    const r = routeOf(rows);
    assertEq(r[1] === "reject" && r[2] === "reject", "route: contradicting emails at unverified company -> reject");
  }

  // Free-mail and no-email at an unverifiable company -> lead.
  {
    const rows = [
      mk({ row_index: 1, company: "Foo", domain: "#n", email: "<REDACTED_EMAIL>" }),
      mk({ row_index: 2, company: "Bar", domain: "#n", phone: "<REDACTED_PHONE>" }),
    ];
    const r = routeOf(rows);
    assertEq(r[1] === "lead", "route: free-mail at unverifiable company -> lead");
    assertEq(r[2] === "lead", "route: phone-only at unverifiable company -> lead");
  }

  // CRM-matched company (churned / cluster / matched account) is trusted: ALL
  // its contacts stay account-routed even if an email domain differs.
  {
    const rows = [
      mk({ row_index: 1, company: "Churn", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>", lifecycle_state: "termination_old" }),
      mk({ row_index: 2, company: "Churn", domain: "<REDACTED_HOST>", phone: "<REDACTED_PHONE>" }),
    ];
    const r = routeOf(rows);
    assertEq(r[1] === "account" && r[2] === "account", "route: CRM-matched (churned) company keeps all contacts");
  }
}
console.log("routeContactsByDomainConsistency ok");

if (failed > 0) { console.error(`\n${failed} test(s) FAILED`); process.exit(1); }
