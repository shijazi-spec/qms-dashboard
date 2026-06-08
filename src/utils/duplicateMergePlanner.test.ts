/**
 * Unit tests for the deterministic Accounts merge planner.
 *
 * Pure logic, no DB / network. Verifies master selection, gap-fill vs conflict
 * field decisions, raw_data precedence over fallback columns, duplicate tagging
 * set, and guard rails (too-few records, non-Account records ignored).
 *
 * Run:    npx tsx src/utils/duplicateMergePlanner.test.ts
 * Wired:  auto-discovered by tests/runIntegrationTests.ts
 */

import {
  buildAccountMergePlan,
  buildMergePlan,
} from "./duplicateMergePlanner";
import type { DuplicateRecord } from "./duplicateRadarDatabase";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function rec(partial: Partial<DuplicateRecord>): DuplicateRecord {
  return {
    cluster_id: 1,
    record_type: "account",
    record_name: "Unnamed",
    is_primary: false,
    confidence_score: 90,
    is_mock_data: false,
    ...partial,
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
// A: most complete (5 fields), Phone empty, Website "a.com", created earlier.
// B: fewer fields, has Phone (raw_data wins over column), Website "b.com".

const recA = rec({
  id: 10,
  zoho_record_id: "ZA",
  record_name: "Acme",
  created_date: new Date("2022-01-01"),
  modified_date: new Date("2022-06-01"),
  owner_name: "Sara",
  raw_data: {
    Account_Name: "Acme",
    Website: "a.com",
    Industry: "Tech",
    Billing_Country: "SA",
    Account_Type: "Customer",
  },
});

const recB = rec({
  id: 11,
  zoho_record_id: "ZB",
  record_name: "Acme",
  created_date: new Date("2023-03-01"),
  modified_date: new Date("2024-09-01"),
  phone: "999", // column — should be overridden by raw_data below
  raw_data: {
    Account_Name: "Acme",
    Phone: "111",
    Website: "b.com",
  },
});

console.log("buildAccountMergePlan — core behaviour");
const plan = buildAccountMergePlan(7, [recA, recB], {
  tagName: "Duplicate-Delete",
  generatedBy: "tester@walaplus.com",
  generatedAt: "2026-06-08T00:00:00.000Z",
});

assert(plan.clusterId === 7, "carries cluster id");
assert(
  plan.method === "migrate_tag" && plan.module === "Accounts",
  "Phase 1 method/module",
);
assert(plan.masterZohoId === "ZA", "master = most-complete record (A)");
assert(
  plan.duplicateZohoIds.length === 1 && plan.duplicateZohoIds[0] === "ZB",
  "only B tagged as duplicate",
);
assert(
  !plan.duplicateZohoIds.includes("ZA"),
  "master never tagged for deletion",
);
assert(plan.tagName === "Duplicate-Delete", "uses the agreed tag name");
assert(
  plan.generatedBy === "tester@walaplus.com" &&
    plan.generatedAt === "2026-06-08T00:00:00.000Z",
  "stamps provenance",
);

const phone = plan.fieldDecisions.find((d) => d.field === "Phone");
assert(
  !!phone && phone.action === "fill",
  "Phone is a gap-fill (master empty)",
);
assert(
  !!phone && phone.chosenValue === "111",
  "Phone value taken from raw_data, not the column (999)",
);
assert(!!phone && phone.fromZohoId === "ZB", "Phone filled from record B");

const website = plan.fieldDecisions.find((d) => d.field === "Website");
assert(
  !!website && website.action === "conflict",
  "Website is a conflict (master has a differing value)",
);
assert(
  !!website && website.chosenValue === "a.com",
  "conflict keeps the master's value",
);
assert(
  !!website && website.alternatives.some((a) => a.value === "b.com"),
  "conflict surfaces the duplicate's alternative value",
);
assert(
  plan.warnings.some((w) => w.toLowerCase().includes("website")),
  "conflict produces a warning",
);

const acctName = plan.fieldDecisions.find((d) => d.field === "Account_Name");
assert(
  !acctName,
  "identical Account_Name produces no decision (keeps are omitted)",
);

assert(
  plan.records.length === 2 &&
    plan.records.filter((r) => r.isMaster).length === 1,
  "exactly one master in summary",
);
assert(
  typeof plan.rationale === "string" && plan.rationale.includes("Acme"),
  "human-readable rationale present",
);

console.log("guard rails");
let threw = false;
try {
  buildAccountMergePlan(8, [recA]);
} catch {
  threw = true;
}
assert(threw, "throws when fewer than 2 Account records");

const withLead = buildAccountMergePlan(9, [
  recA,
  recB,
  rec({
    id: 12,
    zoho_record_id: "ZL",
    record_type: "lead",
    record_name: "Acme Lead",
  }),
]);
assert(
  withLead.records.length === 2,
  "non-Account records excluded from the plan",
);
assert(
  withLead.warnings.some((w) => w.toLowerCase().includes("non-account")),
  "warns that non-Account records were ignored",
);
assert(
  !withLead.duplicateZohoIds.includes("ZL"),
  "lead record is never tagged in an Accounts plan",
);

console.log("subset selection (includeZohoIds)");
const recC = rec({
  id: 20,
  zoho_record_id: "ZC",
  record_name: "Acme Branch",
  raw_data: { Account_Name: "Acme Branch", Website: "c.com" },
});
const subset = buildAccountMergePlan(11, [recA, recB, recC], {
  includeZohoIds: ["ZA", "ZB"],
});
assert(subset.records.length === 3, "all 3 accounts still listed in summary");
assert(
  subset.records.filter((r) => r.included).length === 2,
  "only the 2 selected accounts are in the merge set",
);
const cSummary = subset.records.find((r) => r.zohoId === "ZC");
assert(!!cSummary && cSummary.included === false, "unselected account is included=false");
assert(!subset.duplicateZohoIds.includes("ZC"), "excluded account is never tagged");
assert(["ZA", "ZB"].includes(subset.masterZohoId || ""), "survivor is chosen from the selected set");

let threwSel = false;
try {
  buildAccountMergePlan(12, [recA, recB, recC], { includeZohoIds: ["ZA"] });
} catch {
  threwSel = true;
}
assert(threwSel, "throws when fewer than 2 accounts are selected");

console.log("survivor override (masterZohoId)");
const forced = buildAccountMergePlan(13, [recA, recB], { masterZohoId: "ZB" });
assert(forced.masterZohoId === "ZB", "operator-forced survivor is honoured");
assert(
  /operator-selected/i.test(forced.masterReason),
  "forced survivor reason notes it was operator-selected (not 'most complete')",
);
const badForce = buildAccountMergePlan(14, [recA, recB], { masterZohoId: "NOPE" });
assert(
  badForce.masterZohoId === "ZA" &&
    badForce.warnings.some((w) => /not in the selected merge set/i.test(w)),
  "invalid forced master falls back to the auto-pick with a warning",
);

console.log("multi-module (Leads / Deals / Contacts)");
const lead1 = rec({
  id: 30,
  zoho_record_id: "L1",
  record_type: "lead",
  record_name: "Sam",
  // Most complete (3 fields) but NO Phone → Phone should gap-fill from L2.
  raw_data: { Last_Name: "Sam", Company: "Acme", Email: "s@a.com" },
});
const lead2 = rec({
  id: 31,
  zoho_record_id: "L2",
  record_type: "lead",
  record_name: "Sam",
  raw_data: { Last_Name: "Sam", Phone: "0501234567" },
});
const leadPlan = buildMergePlan("Leads", 20, [lead1, lead2]);
assert(leadPlan.module === "Leads", "Leads plan carries module=Leads");
assert(leadPlan.masterZohoId === "L1", "Leads survivor = most-complete lead");
assert(
  leadPlan.duplicateZohoIds.length === 1 && leadPlan.duplicateZohoIds[0] === "L2",
  "Leads plan tags the other lead",
);
assert(
  leadPlan.fieldDecisions.some((d) => d.field === "Phone" && d.action === "fill"),
  "Leads plan migrates lead fields (Phone gap-fill from L2)",
);

const deal1 = rec({
  id: 40,
  zoho_record_id: "D1",
  record_type: "deal",
  record_name: "Big Deal",
  raw_data: { Deal_Name: "Big Deal", Amount: 100, Stage: "Won" },
});
const deal2 = rec({
  id: 41,
  zoho_record_id: "D2",
  record_type: "deal",
  record_name: "Big Deal",
  raw_data: { Deal_Name: "Big Deal" },
});
const dealPlan = buildMergePlan("Deals", 21, [deal1, deal2]);
assert(
  dealPlan.module === "Deals" && dealPlan.masterZohoId === "D1",
  "Deals plan carries module + most-complete survivor",
);

let threwMod = false;
try {
  buildMergePlan("Leads", 22, [recA, recB]);
} catch {
  threwMod = true;
}
assert(threwMod, "Leads plan over an Accounts-only cluster throws (no lead records)");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
