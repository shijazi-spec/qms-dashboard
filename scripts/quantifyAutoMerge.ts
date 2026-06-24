/**
 * How much of the Accounts/Contacts duplicate backlog can be SAFELY auto-merged
 * right now? Runs every read-only preview (no writes) and totals what each rule
 * would resolve, so we can see where to accelerate.
 *
 *   npx tsx scripts/quantifyAutoMerge.ts
 */
import {
  previewExactContactMatches,
  previewNamePhoneContactMatches,
  previewAccountDomainNameMerge,
  previewAccountDomainOnlyMerge,
  previewContactLinkToAccount,
} from "../src/utils/duplicateRadarDatabase";

async function main() {
  const [exact, namePhone, acctDN, acctDom, link] = await Promise.all([
    previewExactContactMatches(),
    previewNamePhoneContactMatches(),
    previewAccountDomainNameMerge(),
    previewAccountDomainOnlyMerge(),
    previewContactLinkToAccount(),
  ]);

  console.log("\n================ AUTO-SOLVABLE BACKLOG (dry-run, no writes) ================\n");

  console.log("CONTACTS — auto-merge (same person):");
  console.log(`  exact email+phone : ${exact.qualifyingGroups} group(s) → ${exact.duplicatesToTag} duplicate(s) tagged`);
  console.log(`  same name+phone   : ${namePhone.qualifyingGroups} group(s) → ${namePhone.duplicatesToTag} duplicate(s) tagged`);
  console.log(`                      (${namePhone.emailsPreserved} survivors keep a 2nd email)`);

  console.log("\nCONTACTS — link colleagues to their Account (no merge, no tagging):");
  console.log(`  ${link.clusters} cluster(s) → ${link.contacts} contact(s) get Account_Name set`);

  console.log("\nACCOUNTS — auto-merge (same company):");
  const dn = acctDN.corporate.groups + acctDN.partner.groups;
  const dnTag = acctDN.corporate.accountsToTag + acctDN.partner.accountsToTag;
  const dom = acctDom.corporate.groups + acctDom.partner.groups;
  const domTag = acctDom.corporate.accountsToTag + acctDom.partner.accountsToTag;
  console.log(`  same domain + name : ${dn} group(s) → ${dnTag} account(s) tagged   [tightest / safest]`);
  console.log(`  same domain (only) : ${dom} group(s) → ${domTag} account(s) tagged   [broader; shared-domain guard applies]`);

  const totalContacts = exact.duplicatesToTag + namePhone.duplicatesToTag;
  const totalAccounts = dnTag;
  console.log("\n---------------------------------------------------------------------------");
  console.log(`  SAFEST one-click set today:`);
  console.log(`    ~${totalContacts} contact duplicate(s)  +  ~${totalAccounts} account duplicate(s)  can be tagged/merged now`);
  console.log(`    + ${link.contacts} colleague contact(s) linked to their Account`);
  console.log("  (all preview -> admin password -> batched apply; nothing deleted by the platform)");
  console.log("");
  process.exit(0);
}
main().catch((e) => { console.error("quantify failed:", e); process.exit(2); });
