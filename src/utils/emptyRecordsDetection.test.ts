/**
 * Unit tests for the pure empty/orphaned/test-record classifiers.
 * Run: npx tsx src/utils/emptyRecordsDetection.test.ts
 * (Co-located src/utils/*.test.ts run via the tsx harness in
 *  tests/runIntegrationTests.ts — NOT vitest, which is scoped to tests/vitest/**.)
 */
import {
  isTestOrPlaceholderName,
  classifyDeal,
  classifyAccount,
  classifyContact,
  isProtectedDealStage,
  isJunkOrTestName,
} from "./emptyRecordsDetection";

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

console.log("isTestOrPlaceholderName");
assert(isTestOrPlaceholderName("test") === true, "exact placeholder 'test'");
assert(isTestOrPlaceholderName("N/A") === true, "exact placeholder 'N/A'");
assert(isTestOrPlaceholderName("Test Account") === true, "standalone 'Test'");
assert(isTestOrPlaceholderName("Ahmed Test") === true, "trailing standalone 'Test'");
assert(isTestOrPlaceholderName("dummy account") === true, "standalone 'dummy'");
assert(isTestOrPlaceholderName("Cool Robot (Sample Contact)") === true, "Zoho 'Sample Contact'");
assert(isTestOrPlaceholderName("شركة تجريبي") === true, "Arabic 'تجريبي'");
assert(isTestOrPlaceholderName("Latest Holdings") === false, "embedded 'test' in 'Latest' not flagged");
assert(isTestOrPlaceholderName("Testbed Robotics") === false, "embedded in 'Testbed' not flagged");
assert(isTestOrPlaceholderName("Request Demo | Kooheji Stores") === false, "'demo' is business-legit (dropped)");
assert(isTestOrPlaceholderName("GCC Electrical Testing Laboratory") === false, "'testing' is business-legit (dropped)");
assert(isTestOrPlaceholderName("name") === true, "whole-name junk 'name' (2021 bulk import)");
assert(isTestOrPlaceholderName("Contact") === true, "whole-name junk 'Contact'");
assert(isTestOrPlaceholderName("اسم") === true, "whole-name junk Arabic 'اسم'");
assert(isTestOrPlaceholderName("First Contact Solutions") === false, "real firm with 'Contact' as a word not flagged");
assert(isTestOrPlaceholderName("Mohammed Name Ali") === false, "'name' as a middle word not flagged");
assert(isTestOrPlaceholderName("Saudi Aramco") === false, "real company, no keyword");

console.log("classifyDeal");
{
  const r = classifyDeal({ hasAccount: false, hasContact: false, amount: 0, name: "X" });
  assert(r.reason === "empty" && r.deleteEligible && r.linkEligible, "no account/contact/amount → empty, delete+link");
}
{
  const r = classifyDeal({ hasAccount: false, hasContact: true, amount: 0, name: "X" });
  assert(r.reason === "orphaned" && !r.deleteEligible && r.linkEligible, "no account but has contact → orphaned, link only");
}
{
  // SAFETY: a test-LOOKING name must NOT make a record with real data eligible.
  const r = classifyDeal({ hasAccount: true, hasContact: true, amount: 5000, name: "dummy deal" });
  assert(r.reason === null && !r.deleteEligible, "test name does NOT override real account+contact data");
}
{
  const r = classifyDeal({ hasAccount: true, hasContact: true, amount: 5000, name: "Request Demo | Kooheji Stores" });
  assert(r.reason === null, "'Request Demo' deal is NOT a test record");
}
{
  const r = classifyDeal({ hasAccount: true, hasContact: false, amount: 100, name: "Aramco Renewal" });
  assert(r.reason === null && !r.deleteEligible && !r.linkEligible, "normal deal with account → not flagged");
}

console.log("classifyAccount");
{
  const r = classifyAccount({ hasDeals: false, hasContacts: false, name: "X" });
  assert(r.reason === "empty" && r.structurallyEmpty, "no deals/contacts → empty");
}
{
  // SAFETY: an account with real deals/contacts is never a candidate, even when
  // the name looks like a test (mirrors the "AlasilaCX | تجربة العميل" case).
  const r = classifyAccount({ hasDeals: true, hasContacts: true, name: "Test Co" });
  assert(r.reason === null && !r.structurallyEmpty, "test name does NOT override account with deals/contacts");
}
{
  // "تجربة العميل" (= customer experience) on an empty-mirror account must NOT be
  // auto-classified as a test record anymore.
  const r = classifyAccount({ hasDeals: false, hasContacts: false, name: "AlasilaCX | تجربة العميل" });
  assert(r.reason === "empty", "'تجربة العميل' is not a test keyword → empty, not test");
}
{
  const r = classifyAccount({ hasDeals: true, hasContacts: false, name: "Riyad Bank" });
  assert(r.reason === null, "normal account with a deal → not flagged");
}

console.log("classifyContact");
{
  const r = classifyContact({ hasEmail: false, hasPhone: false, hasAccount: false, hasDeals: false, name: "John" });
  assert(r.reason === "empty" && r.deleteEligible, "name-only → empty, delete-eligible");
}
{
  const r = classifyContact({ hasEmail: true, hasPhone: false, hasAccount: false, hasDeals: false, name: "John" });
  assert(r.reason === null, "has email → not empty");
}
{
  // SAFETY: a contact with email/phone/account/deal is never a candidate, even
  // with a test-looking name.
  const r = classifyContact({ hasEmail: true, hasPhone: true, hasAccount: true, hasDeals: true, name: "test contact" });
  assert(r.reason === null && !r.deleteEligible, "test name does NOT override a contact with full data");
}

console.log("isProtectedDealStage");
assert(isProtectedDealStage("Agreement Signed") === true, "Agreement Signed protected");
assert(isProtectedDealStage("paid") === true, "paid protected (case-insensitive)");
assert(isProtectedDealStage("Proposal") === false, "Proposal not protected");
assert(isProtectedDealStage(null) === false, "null stage not protected");

console.log("classifyDeal — stage + attachment guards");
assert(classifyDeal({ hasAccount: false, hasContact: false, amount: 0, name: "X", hasAttachments: false, stage: "Paid" }).reason !== "empty", "protected-stage deal never empty");
assert(classifyDeal({ hasAccount: false, hasContact: false, amount: 0, name: "X", hasAttachments: false, stage: "Proposal" }).reason === "empty", "bare non-protected deal is empty");
assert(classifyDeal({ hasAccount: false, hasContact: false, amount: 0, name: "X", hasAttachments: true, stage: "Proposal" }).reason !== "empty", "deal with documents not empty");

console.log("classifyAccount — email + attachment guards");
assert(classifyAccount({ hasDeals: false, hasContacts: false, hasEmail: true, name: "X", hasAttachments: false }).reason !== "empty", "account with email not empty");
assert(classifyAccount({ hasDeals: false, hasContacts: false, hasEmail: false, name: "X", hasAttachments: true }).reason !== "empty", "account with documents not empty");
assert(classifyAccount({ hasDeals: false, hasContacts: false, hasEmail: false, name: "X", hasAttachments: false }).reason === "empty", "bare account is empty");

console.log("isJunkOrTestName");
// walaplus exact
assert(isJunkOrTestName("WalaPlus").test === true, "walaplus exact → test");
assert(isJunkOrTestName("wala plus").test === true, "wala plus (collapsed) → test");
assert(isJunkOrTestName("WalaPlus Partners").test === false, "walaplus substring → NOT test");
assert(isJunkOrTestName("walaplus.com deal").test === false, "walaplus in phrase → NOT test");
// junk J1 repeated token (how the gibberish actually appears in the data)
assert(isJunkOrTestName("JYupWMLW JYupWMLW").junk === true, "repeated token → junk");
assert(isJunkOrTestName("tsSLAueP tsSLAueP").junk === true, "repeated token 2 → junk");
assert(isJunkOrTestName("IxbfYeaa IxbfYeaa").junk === true, "repeated token 3 → junk");
// junk J2 machine string (single token, random internal casing >=4 switches)
assert(isJunkOrTestName("jJQaBOcg").junk === true, "machine string → junk");
// guards: never junk
assert(isJunkOrTestName("شركة الرياض").junk === false, "arabic → not junk");
assert(isJunkOrTestName("Acme Trading Co").junk === false, "real multiword → not junk");
assert(isJunkOrTestName("SES").junk === false, "short acronym → not junk");
assert(isJunkOrTestName("12345").junk === false, "numeric → not junk");
assert(isJunkOrTestName("McDonald").junk === false, "CamelCase brand → not junk (no false delete)");
assert(isJunkOrTestName("LinkedIn").junk === false, "CamelCase brand 2 → not junk");
console.log("isJunkOrTestName ok");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
