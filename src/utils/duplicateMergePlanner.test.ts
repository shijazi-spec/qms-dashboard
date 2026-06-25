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

console.log("link survivor to account (Contacts/Deals)");
const acctForLink = rec({
  id: 50,
  zoho_record_id: "ACC1",
  record_type: "account",
  record_name: "Acme Corp",
  is_primary: true,
});
const c1 = rec({
  id: 51,
  zoho_record_id: "C1",
  record_type: "contact",
  record_name: "Khalil",
  raw_data: { Last_Name: "Khalil", Email: "k@a.com", Phone: "1" },
});
const c2 = rec({
  id: 52,
  zoho_record_id: "C2",
  record_type: "contact",
  record_name: "Khalil",
  raw_data: { Last_Name: "Khalil" },
});
const contactPlan = buildMergePlan("Contacts", 30, [acctForLink, c1, c2]);
assert(
  contactPlan.accountCandidates.some((a) => a.zohoId === "ACC1"),
  "Contacts plan surfaces the cluster account as a link candidate",
);
assert(
  contactPlan.linkAccountZohoId === "ACC1",
  "Contacts plan defaults the link to the primary account",
);
const noLink = buildMergePlan("Contacts", 31, [acctForLink, c1, c2], {
  linkAccountZohoId: "",
});
assert(noLink.linkAccountZohoId === null, "explicit empty link target = don't link");
const acctPlanNoLink = buildMergePlan("Accounts", 32, [recA, recB]);
assert(
  acctPlanNoLink.accountCandidates.length === 0 &&
    acctPlanNoLink.linkAccountZohoId === null,
  "Accounts plan has no account-link option",
);

// ── Contacts merge — "keep both" email/phone summary panel (Sarah 2026-06-25) ──
// Three same-person contacts (share name + email ⇒ genuine duplicates) with THREE
// distinct phones. Survivor keeps its Phone; the freshest duplicate's number lands
// in Mobile; the third is an extra Zoho can't store. Master pinned for determinism.
const cM = rec({
  record_type: "contact",
  id: 30, zoho_record_id: "CM", record_name: "Ahmed Ali",
  email: "ahmed@acme.com", phone: "+966501112222", title: "Manager",
  modified_date: new Date("2024-06-01"),
  raw_data: { Last_Name: "Ahmed Ali", Email: "ahmed@acme.com", Phone: "+966501112222", Title: "Manager" },
});
const cD1 = rec({
  record_type: "contact",
  id: 31, zoho_record_id: "CD1", record_name: "Ahmed Ali",
  email: "ahmed@acme.com", phone: "+966553334444",
  modified_date: new Date("2024-05-01"),
  raw_data: { Last_Name: "Ahmed Ali", Email: "ahmed@acme.com", Phone: "+966553334444" },
});
const cD2 = rec({
  record_type: "contact",
  id: 32, zoho_record_id: "CD2", record_name: "Ahmed Ali",
  email: "ahmed@acme.com", phone: "+966509998888",
  modified_date: new Date("2024-04-01"),
  raw_data: { Last_Name: "Ahmed Ali", Email: "ahmed@acme.com", Phone: "+966509998888" },
});
const keepBothPlan = buildMergePlan("Contacts", 30, [cM, cD1, cD2], { masterZohoId: "CM" });
const cds = keepBothPlan.contactDataSummary;
assert(keepBothPlan.masterZohoId === "CM", "survivor pinned to CM");
assert(!!cds, "Contacts plan includes contactDataSummary");
assert(cds?.emails.primary?.value === "ahmed@acme.com", "email primary = the shared email");
assert(cds?.emails.primary?.from === "survivor", "email primary tagged survivor (kept)");
assert(cds?.emails.secondary === null, "no second distinct email ⇒ Secondary_Email empty");
assert(cds?.phones.phone?.value === "+966501112222", "phone primary = survivor's phone");
assert(cds?.phones.phone?.from === "survivor", "phone primary tagged survivor (kept)");
assert(cds?.phones.mobile?.value === "+966553334444", "mobile = freshest duplicate's distinct phone");
assert((cds?.phones.mobile?.from || "") !== "survivor", "mobile tagged from a duplicate");
assert(cds?.phones.extras.length === 1, "third distinct phone is an extra (Zoho holds 2)");
assert(cds?.phones.extras[0]?.value === "+966509998888", "extra phone preserved for manual capture");

// Same-phone, different-emails ⇒ keep both emails (Email + Secondary_Email).
// Shared phone_normalized so the ≥2-attribute rule counts name + phone (the
// dedup gate compares the normalized column, not the raw value).
const eM = rec({
  record_type: "contact", id: 40, zoho_record_id: "EM", record_name: "Sara Q",
  email: "sara@acme.com", phone: "+966500000001", phone_normalized: "500000001", title: "Lead",
  modified_date: new Date("2024-06-01"),
  raw_data: { Last_Name: "Sara Q", Email: "sara@acme.com", Phone: "+966500000001", Title: "Lead" },
});
const eD = rec({
  record_type: "contact", id: 41, zoho_record_id: "ED", record_name: "Sara Q",
  email: "sara.q@gmail.com", phone: "+966500000001", phone_normalized: "500000001",
  modified_date: new Date("2024-05-01"),
  raw_data: { Last_Name: "Sara Q", Email: "sara.q@gmail.com", Phone: "+966500000001" },
});
const emailPlan = buildMergePlan("Contacts", 40, [eM, eD], { masterZohoId: "EM" });
const ecds = emailPlan.contactDataSummary;
assert(ecds?.emails.primary?.value === "sara@acme.com", "email primary = survivor's email");
assert(ecds?.emails.secondary?.value === "sara.q@gmail.com", "second distinct email → Secondary_Email");
assert((ecds?.emails.secondary?.from || "") !== "survivor", "Secondary_Email tagged from a duplicate");
assert(ecds?.phones.mobile === null, "same phone ⇒ no Mobile needed");

// ── Relaxed contact-merge bridges (Ahmad 2026-06-26) ─────────────────────────
console.log("contact merge — generic-mailbox + same-email bridges");

assert(isRoleMailbox("info@x.com") === true, "info@ is a role mailbox");
assert(isRoleMailbox("e-store@8ozcafe.com") === true, "e-store@ is a role mailbox");
assert(isRoleMailbox("yamen@collectionneur.sa") === false, "personal email is not a role mailbox");
assert(isRoleMailbox("infofahad@x.com") === false, "role detection is exact local-part, not a prefix");
assert(isRoleMailbox("") === false, "empty email is not a role mailbox");

// Bridge 2 — shared phone + a generic role mailbox on the DUPLICATE, DIFFERENT
// names → absorb the role mailbox into the personal survivor; keep both emails.
const rM = rec({
  record_type: "contact", id: 50, zoho_record_id: "RM", record_name: "Yamen Albakour",
  email: "yamen@collectionneur.sa", phone: "+966591700995", phone_normalized: "591700995",
  modified_date: new Date("2024-06-01"),
  raw_data: { Last_Name: "Yamen Albakour", Email: "yamen@collectionneur.sa", Phone: "+966591700995" },
});
const rD = rec({
  record_type: "contact", id: 51, zoho_record_id: "RD", record_name: "Badr Alharbi",
  email: "info@collectionneur.sa", phone: "+966591700995", phone_normalized: "591700995",
  modified_date: new Date("2024-05-01"),
  raw_data: { Last_Name: "Badr Alharbi", Email: "info@collectionneur.sa", Phone: "+966591700995" },
});
const rolePlan = buildMergePlan("Contacts", 50, [rM, rD], { masterZohoId: "RM" });
assert(rolePlan.duplicateZohoIds.includes("RD"), "role-mailbox dup (info@) tagged as duplicate of the personal survivor");
const rcds = rolePlan.contactDataSummary;
assert(rcds?.emails.primary?.value === "yamen@collectionneur.sa", "primary = survivor personal email");
assert(rcds?.emails.secondary?.value === "info@collectionneur.sa", "info@ kept as Secondary_Email");
assert(rolePlan.warnings.some((w) => /relaxed rule|info@\/support@/i.test(w)), "bridge merge is flagged for review");

// Directional guard — if the operator picks the info@ contact as survivor, the
// real person is NOT tagged (never delete a real person for a role mailbox).
const rolePlanRev = buildMergePlan("Contacts", 51, [rM, rD], { masterZohoId: "RD" });
assert(!rolePlanRev.duplicateZohoIds.includes("RM"), "personal contact NOT tagged when the role mailbox is the survivor");

// Bridge 1 — same exact PERSONAL email, different name AND different phone →
// same person; merged, second phone preserved as Mobile.
const pM = rec({
  record_type: "contact", id: 60, zoho_record_id: "PM", record_name: "Omar A",
  email: "omar@acme.com", phone: "+966500000010", phone_normalized: "500000010",
  modified_date: new Date("2024-06-01"),
  raw_data: { Last_Name: "Omar A", Email: "omar@acme.com", Phone: "+966500000010" },
});
const pD = rec({
  record_type: "contact", id: 61, zoho_record_id: "PD", record_name: "Omar Alotaibi",
  email: "omar@acme.com", phone: "+966500000099", phone_normalized: "500000099",
  modified_date: new Date("2024-05-01"),
  raw_data: { Last_Name: "Omar Alotaibi", Email: "omar@acme.com", Phone: "+966500000099" },
});
const sameEmailPlan = buildMergePlan("Contacts", 60, [pM, pD], { masterZohoId: "PM" });
assert(sameEmailPlan.duplicateZohoIds.includes("PD"), "same personal email ⇒ merged even with different name + phone");
assert(sameEmailPlan.contactDataSummary?.phones.mobile?.value != null, "second distinct phone preserved as Mobile");

// Negative — two DIFFERENT personal emails sharing ONLY a phone (no role
// mailbox, different names) must STAY soft-excluded (the safe ≥2 rule holds).
const nM = rec({
  record_type: "contact", id: 70, zoho_record_id: "NM", record_name: "Ali One",
  email: "ali@acme.com", phone: "+966555000000", phone_normalized: "555000000",
  raw_data: { Last_Name: "Ali One", Email: "ali@acme.com", Phone: "+966555000000" },
});
const nD = rec({
  record_type: "contact", id: 71, zoho_record_id: "ND", record_name: "Khalid Two",
  email: "khalid@acme.com", phone: "+966555000000", phone_normalized: "555000000",
  raw_data: { Last_Name: "Khalid Two", Email: "khalid@acme.com", Phone: "+966555000000" },
});
const negPlan = buildMergePlan("Contacts", 70, [nM, nD], { masterZohoId: "NM" });
assert(!negPlan.duplicateZohoIds.includes("ND"), "two different personal emails sharing only a phone are NOT merged");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
