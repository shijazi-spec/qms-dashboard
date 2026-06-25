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
  const r = classifyDeal({ hasAccount: true, hasContact: true, amount: 5000, name: "dummy deal" });
  assert(r.reason === "test" && r.deleteEligible, "test name → delete-eligible despite data");
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
  const r = classifyAccount({ hasDeals: true, hasContacts: true, name: "Test Co" });
  assert(r.reason === "test", "test name flagged regardless of links");
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
  const r = classifyContact({ hasEmail: true, hasPhone: true, hasAccount: true, hasDeals: true, name: "test contact" });
  assert(r.reason === "test" && r.deleteEligible, "test name → flagged despite full data");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
