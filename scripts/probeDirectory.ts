/**
 * Probe the live CS-client directory for one or more terms — each is checked
 * BOTH as a domain and as a company name, showing whether it resolves to a
 * client and how (domain / exact / containment / fuzzy).
 *
 *   npx tsx scripts/probeDirectory.ts "boe.gov.sa" "هيئة الخبراء" "Aon"
 */
import { debugDirectoryMatch } from "../src/utils/duplicateRadarPreflight";

async function main() {
  const terms = process.argv.slice(2);
  if (!terms.length) {
    console.error('Pass terms: npx tsx scripts/probeDirectory.ts "boe.gov.sa" "هيئة الخبراء" "Aon"');
    process.exit(2);
  }
  for (const t of terms) {
    const r = await debugDirectoryMatch(t, t);
    console.log(`\n=== "${t}" ===`);
    console.log(`  domainHit   : ${r.domainHit ? r.domainHit.key + " -> " + r.domainHit.client : "—"}`);
    console.log(`  exact byName: ${r.exact}`);
    console.log(`  containment : ${r.contained ?? "—"}`);
    console.log(`  fuzzy       : ${r.fuzzy ?? "—"}`);
    console.log(`  >> RESOLVES : ${r.resolvedVia ?? "NO MATCH"}${r.resolvedVia ? "  -> " + r.resolvedClient + " (active=" + r.resolvedActive + ")" : ""}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error("probe failed:", e); process.exit(2); });
