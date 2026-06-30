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

import { PREFLIGHT_DEAL_TARGET, PREFLIGHT_LEAD_TARGET } from "./preflightStructuredPush";
assertEq(PREFLIGHT_DEAL_TARGET.layoutId === "5146753000000019023", "deal layout id default");
assertEq(PREFLIGHT_DEAL_TARGET.pipeline === "Standard (Corporates)", "deal pipeline default");
assertEq(PREFLIGHT_DEAL_TARGET.stage === "New Deal", "deal stage default");
assertEq(PREFLIGHT_LEAD_TARGET.layoutId === "5146753000000091055", "lead layout id default");
assertEq(PREFLIGHT_LEAD_TARGET.status === "New Lead", "lead status default");
console.log("preflightStructuredPush constants ok");

if (failed > 0) { console.error(`\n${failed} test(s) FAILED`); process.exit(1); }

// ---------------------------------------------------------------------------
// Task 2: buildStructuredPushPlan tests
// ---------------------------------------------------------------------------
import { buildStructuredPushPlan, normalizeCompanyKey } from "./preflightStructuredPush";
const mk = (o: Partial<any>): any => ({ row_index: 0, company: "", domain: "", email: "", phone: "", contact_name: "", verdict: "pass", cluster_id: null, lifecycle_state: null, ...o });

// normalizeCompanyKey
assertEq(normalizeCompanyKey("  Acme  Co ", "") === "acme  co", "company key trims+lowercases");
assertEq(normalizeCompanyKey("", "Acme.com") === "acme.com", "falls back to domain");

// A1 — churned past cool-off, matched → one company entry, carries clusterId
{
  const rows = [mk({ row_index: 1, company: "Churn Co", email: "a@churn.co", verdict: "pass", cluster_id: 9, lifecycle_state: "termination_old" })];
  const p = buildStructuredPushPlan(1, rows, {});
  assertEq(p.companies.length === 1 && p.companies[0].clusterId === 9, "A1 picks churned-matched company");
  assertEq(p.eligible_count === 1 && p.contact_count === 1, "A1 counts");
}
// A1 ignores a non-churned matched row
{
  const rows = [mk({ row_index: 1, company: "Active Co", email: "a@x.co", verdict: "block", cluster_id: 5, lifecycle_state: "onboarding" })];
  const p = buildStructuredPushPlan(1, rows, {});
  assertEq(p.companies.length === 0 && p.skipped.length === 1, "A1 skips active client");
}
// A2 — new company with 2 contacts → one company, 2 contacts
{
  const rows = [
    mk({ row_index: 1, company: "New Multi", email: "a@nm.co" }),
    mk({ row_index: 2, company: "New Multi", phone: "+966500000000" }),
  ];
  const p = buildStructuredPushPlan(2, rows, {});
  assertEq(p.companies.length === 1 && p.companies[0].contacts.length === 2, "A2 groups 2 contacts into one company");
}
// A2 ignores a single-contact company
{
  const rows = [mk({ row_index: 1, company: "Solo Co", email: "a@solo.co" })];
  const p = buildStructuredPushPlan(2, rows, {});
  assertEq(p.companies.length === 0, "A2 excludes single-contact company");
}
// A3/A4 — single-contact new companies, top-down split by count
{
  const rows = [
    mk({ row_index: 1, company: "S1", email: "a@s1.co" }),
    mk({ row_index: 2, company: "S2", email: "a@s2.co" }),
    mk({ row_index: 3, company: "S3", email: "a@s3.co" }),
  ];
  const a3 = buildStructuredPushPlan(3, rows, { count: 2 });
  assertEq(a3.companies.length === 2 && a3.companies[0].companyName === "S1" && a3.companies[1].companyName === "S2", "A3 takes first 2");
  const a4 = buildStructuredPushPlan(4, rows, { count: 1, offset: 2 });
  assertEq(a4.leads.length === 1 && a4.leads[0].company === "S3", "A4 takes the next 1 after A3's first 2");
}
console.log("buildStructuredPushPlan ok");

if (failed > 0) { console.error(`\n${failed} test(s) FAILED`); process.exit(1); }
