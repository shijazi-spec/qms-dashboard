/**
 * Read-only smoke check for the Empty / Orphaned Records detection. Prints the
 * counts by reason (orphaned / empty / test) and the first ~15 of each so the
 * operator can eyeball detection against the live DB before publishing. No writes.
 *
 *   npx tsx scripts/smokeEmptyRecords.ts
 */
import {
  getEmptyDeals,
  getEmptyAccounts,
  getEmptyContacts,
} from "../src/utils/emptyRecordsDatabase";

async function main() {
  const sections: Array<[string, () => Promise<any[]>]> = [
    ["DEALS", getEmptyDeals],
    ["ACCOUNTS", getEmptyAccounts],
    ["CONTACTS", getEmptyContacts],
  ];
  for (const [label, fn] of sections) {
    const rows = await fn();
    const by: Record<string, number> = {};
    for (const r of rows) by[r.reason] = (by[r.reason] || 0) + 1;
    console.log(`\n===== ${label}: ${rows.length} (${JSON.stringify(by)}) =====`);
    for (const r of rows.slice(0, 15)) {
      console.log(`  [${r.reason}] ${r.zohoId} "${(r.name || "").slice(0, 40)}" deleteEligible=${r.deleteEligible}`);
    }
  }
  console.log("\n(done — read-only, nothing written)");
  process.exit(0);
}
main().catch((e) => { console.error("smoke failed:", e); process.exit(2); });
