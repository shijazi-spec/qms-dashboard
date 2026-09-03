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
  isRoleMailbox,
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
// A: most complete (5 fields), Phone empty, Website "<REDACTED_HOST>", created earlier.
// B: fewer fields, has Phone (raw_data wins over column), Website "<REDACTED_HOST>".

const recA = rec({
  id: 10,
  CRMProvider_record_id: "ZA",
  record_name: "Example Organization",
  created_date: new Date("2022-01-01"),
  modified_date: new Date("2022-06-01"),
  owner_name: "Sample User",
  raw_data: {
    Account_Name: "Example Organization",
    Website: "<REDACTED_HOST>",
    Industry: "Tech",
    Billing_Country: "SA",
    Account_Type: "Customer",
  },
});

const recB = rec({
  id: 11,
  CRMProvider_record_id: "ZB",
  record_name: "Example Organization",
  created_date: new Date("2023-03-01"),
  modified_date: new Date("2024-09-01"),
  phone: "999", // column — should be overridden by raw_data below
  raw_data: {
    Account_Name: "Example Organization",
    Phone: "111",
    Website: "<REDACTED_HOST>",
  },
});

console.log("buildAccountMergePlan — core behaviour");
const plan = buildAccountMergePlan(7, [recA, recB], {
  tagName: "Duplicate-Delete",
  generatedBy: "<REDACTED_EMAIL>",
  generatedAt: "2026-06-08T00:00:00.000Z",
});

assert(plan.clusterId === 7, "carries cluster id");
assert(
  plan.method === "migrate_tag" && plan.module === "Accounts",
  "Phase 1 method/module",
);
assert(plan.masterCRMProviderId === "ZA", "master = most-complete record (A)");
assert(
  plan.duplicateCRMProviderIds.length === 1 && plan.duplicateCRMProviderIds[0] === "ZB",
  "only B tagged as duplicate",
);
assert(
  !plan.duplicateCRMProviderIds.includes("ZA"),
  "master never tagged for deletion",
);
assert(plan.tagName === "Duplicate-Delete", "uses the agreed tag name");
assert(
  plan.generatedBy === "<REDACTED_EMAIL>" &&
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
assert(!!phone && phone.fromCRMProviderId === "ZB", "Phone filled from record B");

const website = plan.fieldDecisions.find((d) => d.field === "Website");
assert(
  !!website && website.action === "conflict",
  "Website is a conflict (master has a differing value)",
);
assert(
  !!website && website.chosenValue === "<REDACTED_HOST>",
  "conflict keeps the master's value",
);
assert(
  !!website && website.alternatives.some((a) => a.value === "<REDACTED_HOST>"),
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
  typeof plan.rationale === "string" && plan.rationale.includes("Example Organization"),
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
    CRMProvider_record_id: "ZL",
    record_type: "lead",
    record_name: "Example Organization Lead",
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
  !withLead.duplicateCRMProviderIds.includes("ZL"),
  "lead record is never tagged in an Accounts plan",
);

console.log("subset selection (includeCRMProviderIds)");
const recC = rec({
  id: 20,
  CRMProvider_record_id: "ZC",
  record_name: "Example Organization Branch",
  raw_data: { Account_Name: "Example Organization", Website: "<REDACTED_HOST>" },
});
const subset = buildAccountMergePlan(11, [recA, recB, recC], {
  includeCRMProviderIds: ["ZA", "ZB"],
});
assert(subset.records.length === 3, "all 3 accounts still listed in summary");
assert(
  subset.records.filter((r) => r.included).length === 2,
  "only the 2 selected accounts are in the merge set",
);
const cSummary = subset.records.find((r) => r.CRMProviderId === "ZC");
assert(!!cSummary && cSummary.included === false, "unselected account is included=false");
assert(!subset.duplicateCRMProviderIds.includes("ZC"), "excluded account is never tagged");
assert(["ZA", "ZB"].includes(subset.masterCRMProviderId || ""), "survivor is chosen from the selected set");

let threwSel = false;
try {
  buildAccountMergePlan(12, [recA, recB, recC], { includeCRMProviderIds: ["ZA"] });
} catch {
  threwSel = true;
}
assert(threwSel, "throws when fewer than 2 accounts are selected");

console.log("survivor override (masterCRMProviderId)");
const forced = buildAccountMergePlan(13, [recA, recB], { masterCRMProviderId: "ZB" });
assert(forced.masterCRMProviderId === "ZB", "operator-forced survivor is honoured");
assert(
  /operator-selected/i.test(forced.masterReason),
  "forced survivor reason notes it was operator-selected (not 'most complete')",
);
const badForce = buildAccountMergePlan(14, [recA, recB], { masterCRMProviderId: "NOPE" });
assert(
  badForce.masterCRMProviderId === "ZA" &&
    badForce.warnings.some((w) => /not in the selected merge set/i.test(w)),
  "invalid forced master falls back to the auto-pick with a warning",
);

console.log("multi-module (Leads / Deals / Contacts)");
const lead1 = rec({
  id: 30,
  CRMProvider_record_id: "L1",
  record_type: "lead",
  record_name: "Sam",
  // Most complete (3 fields) but NO Phone → Phone should gap-fill from L2.
  raw_data: { Last_Name: "Sam", Company: "Example Organization", Email: "<REDACTED_EMAIL>" },
});
const lead2 = rec({
  id: 31,
  CRMProvider_record_id: "L2",
  record_type: "lead",
  record_name: "Sam",
  raw_data: { Last_Name: "Sam", Phone: "<REDACTED_PHONE>" },
});
const leadPlan = buildMergePlan("Leads", 20, [lead1, lead2]);
assert(leadPlan.module === "Leads", "Leads plan carries module=Leads");
assert(leadPlan.masterCRMProviderId === "L1", "Leads survivor = most-complete lead");
assert(
  leadPlan.duplicateCRMProviderIds.length === 1 && leadPlan.duplicateCRMProviderIds[0] === "L2",
  "Leads plan tags the other lead",
);
assert(
  leadPlan.fieldDecisions.some((d) => d.field === "Phone" && d.action === "fill"),
  "Leads plan migrates lead fields (Phone gap-fill from L2)",
);

const deal1 = rec({
  id: 40,
  CRMProvider_record_id: "D1",
  record_type: "deal",
  record_name: "Big Deal",
  raw_data: { Deal_Name: "Big Deal", Amount: 100, Stage: "Won" },
});
const deal2 = rec({
  id: 41,
  CRMProvider_record_id: "D2",
  record_type: "deal",
  record_name: "Big Deal",
  raw_data: { Deal_Name: "Big Deal" },
});
const dealPlan = buildMergePlan("Deals", 21, [deal1, deal2]);
assert(
  dealPlan.module === "Deals" && dealPlan.masterCRMProviderId === "D1",
  "Deals plan carries module + most-complete survivor",
);

let threwMod = false;
try {
  buildMergePlan("Leads", 22, [recA, recB]);
} catch {
  threwMod = true;
}
assert(threwMod, "Leads plan over an Accounts-only cluster throws (no lead records)");

console.log("link survivor to account (Contacts/Deals)");
const acctForLink = rec({
  id: 50,
  CRMProvider_record_id: "ACC1",
  record_type: "account",
  record_name: "Example Organization",
  is_primary: true,
});
const c1 = rec({
  id: 51,
  CRMProvider_record_id: "C1",
  record_type: "contact",
  record_name: "Khalil",
  raw_data: { Last_Name: "Khalil", Email: "<REDACTED_EMAIL>", Phone: "1" },
});
const c2 = rec({
  id: 52,
  CRMProvider_record_id: "C2",
  record_type: "contact",
  record_name: "Khalil",
  raw_data: { Last_Name: "Khalil" },
});
const contactPlan = buildMergePlan("Contacts", 30, [acctForLink, c1, c2]);
assert(
  contactPlan.accountCandidates.some((a) => a.CRMProviderId === "ACC1"),
  "Contacts plan surfaces the cluster account as a link candidate",
);
assert(
  contactPlan.linkAccountCRMProviderId === "ACC1",
  "Contacts plan defaults the link to the primary account",
);
const noLink = buildMergePlan("Contacts", 31, [acctForLink, c1, c2], {
  linkAccountCRMProviderId: "",
});
assert(noLink.linkAccountCRMProviderId === null, "explicit empty link target = don't link");
const acctPlanNoLink = buildMergePlan("Accounts", 32, [recA, recB]);
assert(
  acctPlanNoLink.accountCandidates.length === 0 &&
    acctPlanNoLink.linkAccountCRMProviderId === null,
  "Accounts plan has no account-link option",
);

// ── Contacts merge — "keep both" email/phone summary panel (Sample User 2026-06-25) ──
// Three same-person contacts (share name + email ⇒ genuine duplicates) with THREE
// distinct phones. Survivor keeps its Phone; the freshest duplicate's number lands
// in Mobile; the third is an extra CRMProvider can't store. Master pinned for determinism.
const cM = rec({
  record_type: "contact",
  id: 30, CRMProvider_record_id: "CM", record_name: "Sample User",
  email: "<REDACTED_EMAIL>", phone: "<REDACTED_PHONE>", title: "Manager",
  modified_date: new Date("2024-06-01"),
  raw_data: { Last_Name: "Sample User", Email: "<REDACTED_EMAIL>", Phone: "<REDACTED_PHONE>", Title: "Manager" },
});
const cD1 = rec({
  record_type: "contact",
  id: 31, CRMProvider_record_id: "CD1", record_name: "Sample User",
  email: "<REDACTED_EMAIL>", phone: "<REDACTED_PHONE>",
  modified_date: new Date("2024-05-01"),
  raw_data: { Last_Name: "Sample User", Email: "<REDACTED_EMAIL>", Phone: "<REDACTED_PHONE>" },
});
const cD2 = rec({
  record_type: "contact",
  id: 32, CRMProvider_record_id: "CD2", record_name: "Sample User",
  email: "<REDACTED_EMAIL>", phone: "<REDACTED_PHONE>",
  modified_date: new Date("2024-04-01"),
  raw_data: { Last_Name: "Sample User", Email: "<REDACTED_EMAIL>", Phone: "<REDACTED_PHONE>" },
});
const keepBothPlan = buildMergePlan("Contacts", 30, [cM, cD1, cD2], { masterCRMProviderId: "CM" });
const cds = keepBothPlan.contactDataSummary;
assert(keepBothPlan.masterCRMProviderId === "CM", "survivor pinned to CM");
assert(!!cds, "Contacts plan includes contactDataSummary");
assert(cds?.emails.primary?.value === "<REDACTED_EMAIL>", "email primary = the shared email");
assert(cds?.emails.primary?.from === "survivor", "email primary tagged survivor (kept)");
assert(cds?.emails.secondary === null, "no second distinct email ⇒ Secondary_Email empty");
assert(cds?.phones.phone?.value === "<REDACTED_PHONE>", "phone primary = survivor's phone");
assert(cds?.phones.phone?.from === "survivor", "phone primary tagged survivor (kept)");
assert(cds?.phones.mobile?.value === "<REDACTED_PHONE>", "mobile = freshest duplicate's distinct phone");
assert((cds?.phones.mobile?.from || "") !== "survivor", "mobile tagged from a duplicate");
assert(cds?.phones.extras.length === 1, "third distinct phone is an extra (CRMProvider holds 2)");
assert(cds?.phones.extras[0]?.value === "<REDACTED_PHONE>", "extra phone preserved for manual capture");

// Same-phone, different-emails ⇒ keep both emails (Email + Secondary_Email).
// Shared phone_normalized so the ≥2-attribute rule counts name + phone (the
// dedup gate compares the normalized column, not the raw value).
const eM = rec({
  record_type: "contact", id: 40, CRMProvider_record_id: "EM", record_name: "Sara Q",
  email: "<REDACTED_EMAIL>", phone: "<REDACTED_PHONE>", phone_normalized: "<REDACTED_PHONE>", title: "Lead",
  modified_date: new Date("2024-06-01"),
  raw_data: { Last_Name: "Sara Q", Email: "<REDACTED_EMAIL>", Phone: "<REDACTED_PHONE>", Title: "Lead" },
});
const eD = rec({
  record_type: "contact", id: 41, CRMProvider_record_id: "ED", record_name: "Sara Q",
  email: "<REDACTED_EMAIL>", phone: "<REDACTED_PHONE>", phone_normalized: "<REDACTED_PHONE>",
  modified_date: new Date("2024-05-01"),
  raw_data: { Last_Name: "Sara Q", Email: "<REDACTED_EMAIL>", Phone: "<REDACTED_PHONE>" },
});
const emailPlan = buildMergePlan("Contacts", 40, [eM, eD], { masterCRMProviderId: "EM" });
const ecds = emailPlan.contactDataSummary;
assert(ecds?.emails.primary?.value === "<REDACTED_EMAIL>", "email primary = survivor's email");
assert(ecds?.emails.secondary?.value === "<REDACTED_EMAIL>", "second distinct email → Secondary_Email");
assert((ecds?.emails.secondary?.from || "") !== "survivor", "Secondary_Email tagged from a duplicate");
assert(ecds?.phones.mobile === null, "same phone ⇒ no Mobile needed");

// ── Relaxed contact-merge bridges (Sample User 2026-06-26) ─────────────────────────
console.log("contact merge — generic-mailbox + same-email bridges");

assert(isRoleMailbox("<REDACTED_EMAIL>") === true, "info@ is a role mailbox");
assert(isRoleMailbox("<REDACTED_EMAIL>") === true, "e-store@ is a role mailbox");
assert(isRoleMailbox("<REDACTED_EMAIL>") === false, "personal email is not a role mailbox");
assert(isRoleMailbox("<REDACTED_EMAIL>") === false, "role detection is exact local-part, not a prefix");
assert(isRoleMailbox("") === false, "empty email is not a role mailbox");

// Bridge 2 — shared phone + a generic role mailbox on the DUPLICATE, DIFFERENT
// names → absorb the role mailbox into the personal survivor; keep both emails.
const rM = rec({
  record_type: "contact", id: 50, CRMProvider_record_id: "RM", record_name: "Yamen Albakour",
  email: "<REDACTED_EMAIL>", phone: "<REDACTED_PHONE>", phone_normalized: "<REDACTED_PHONE>",
  modified_date: new Date("2024-06-01"),
  raw_data: { Last_Name: "Yamen Albakour", Email: "<REDACTED_EMAIL>", Phone: "<REDACTED_PHONE>" },
});
const rD = rec({
  record_type: "contact", id: 51, CRMProvider_record_id: "RD", record_name: "Badr Alharbi",
  email: "<REDACTED_EMAIL>", phone: "<REDACTED_PHONE>", phone_normalized: "<REDACTED_PHONE>",
  modified_date: new Date("2024-05-01"),
  raw_data: { Last_Name: "Badr Alharbi", Email: "<REDACTED_EMAIL>", Phone: "<REDACTED_PHONE>" },
});
const rolePlan = buildMergePlan("Contacts", 50, [rM, rD], { masterCRMProviderId: "RM" });
assert(rolePlan.duplicateCRMProviderIds.includes("RD"), "role-mailbox dup (info@) tagged as duplicate of the personal survivor");
const rcds = rolePlan.contactDataSummary;
assert(rcds?.emails.primary?.value === "<REDACTED_EMAIL>", "primary = survivor personal email");
assert(rcds?.emails.secondary?.value === "<REDACTED_EMAIL>", "info@ kept as Secondary_Email");
assert(rolePlan.warnings.some((w) => /relaxed rule|info@\/support@/i.test(w)), "bridge merge is flagged for review");

// Directional guard — if the operator picks the info@ contact as survivor, the
// real person is NOT tagged (never delete a real person for a role mailbox).
const rolePlanRev = buildMergePlan("Contacts", 51, [rM, rD], { masterCRMProviderId: "RD" });
assert(!rolePlanRev.duplicateCRMProviderIds.includes("RM"), "personal contact NOT tagged when the role mailbox is the survivor");

// Bridge 1 — same exact PERSONAL email, different name AND different phone →
// same person; merged, second phone preserved as Mobile.
const pM = rec({
  record_type: "contact", id: 60, CRMProvider_record_id: "PM", record_name: "Omar A",
  email: "<REDACTED_EMAIL>", phone: "<REDACTED_PHONE>", phone_normalized: "<REDACTED_PHONE>",
  modified_date: new Date("2024-06-01"),
  raw_data: { Last_Name: "Omar A", Email: "<REDACTED_EMAIL>", Phone: "<REDACTED_PHONE>" },
});
const pD = rec({
  record_type: "contact", id: 61, CRMProvider_record_id: "PD", record_name: "Omar Alotaibi",
  email: "<REDACTED_EMAIL>", phone: "<REDACTED_PHONE>", phone_normalized: "<REDACTED_PHONE>",
  modified_date: new Date("2024-05-01"),
  raw_data: { Last_Name: "Omar Alotaibi", Email: "<REDACTED_EMAIL>", Phone: "<REDACTED_PHONE>" },
});
const sameEmailPlan = buildMergePlan("Contacts", 60, [pM, pD], { masterCRMProviderId: "PM" });
assert(sameEmailPlan.duplicateCRMProviderIds.includes("PD"), "same personal email ⇒ merged even with different name + phone");
assert(sameEmailPlan.contactDataSummary?.phones.mobile?.value != null, "second distinct phone preserved as Mobile");

// Negative — two DIFFERENT personal emails sharing ONLY a phone (no role
// mailbox, different names) must STAY soft-excluded (the safe ≥2 rule holds).
const nM = rec({
  record_type: "contact", id: 70, CRMProvider_record_id: "NM", record_name: "Ali One",
  email: "<REDACTED_EMAIL>", phone: "<REDACTED_PHONE>", phone_normalized: "<REDACTED_PHONE>",
  raw_data: { Last_Name: "Ali One", Email: "<REDACTED_EMAIL>", Phone: "<REDACTED_PHONE>" },
});
const nD = rec({
  record_type: "contact", id: 71, CRMProvider_record_id: "ND", record_name: "Sample User",
  email: "<REDACTED_EMAIL>", phone: "<REDACTED_PHONE>", phone_normalized: "<REDACTED_PHONE>",
  raw_data: { Last_Name: "Sample User", Email: "<REDACTED_EMAIL>", Phone: "<REDACTED_PHONE>" },
});
const negPlan = buildMergePlan("Contacts", 70, [nM, nD], { masterCRMProviderId: "NM" });
assert(!negPlan.duplicateCRMProviderIds.includes("ND"), "two different personal emails sharing only a phone are NOT merged");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
