/**
 * Debug why "Abdul Latif Jameel United Finance" isn't matching the directory.
 *   npx tsx scripts/debugAljMatch.ts
 */
import { debugDirectoryMatch } from "../src/utils/duplicateRadarPreflight";

async function main() {
  for (const name of [
    "Abdul Latif Jameel United Finance",
    "Abdul Latif Jameel",
  ]) {
    const d = await debugDirectoryMatch(name);
    console.log(`\n===== ${name} =====`);
    console.log(`  normalized   = "${d.normalized}"`);
    console.log(`  byName size  = ${d.byNameSize}`);
    console.log(`  exact match  = ${d.exact}`);
    console.log(`  containment  = ${d.contained ?? "(none)"}`);
    console.log(`  fuzzy        = ${d.fuzzy ?? "(none)"}`);
    console.log(`  related byName keys (${d.relatedNameKeys.length}):`);
    for (const k of d.relatedNameKeys) console.log(`     "${k}"`);
    console.log(`  related domain keys: ${d.relatedDomainKeys.join(", ") || "(none)"}`);
  }
  console.log("");
  process.exit(0);
}
main().catch((e) => { console.error("debug failed:", e); process.exit(2); });
