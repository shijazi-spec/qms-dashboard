/**
 * Diagnose the 5 reported preflight name-match mistakes against the LIVE
 * CS-client directory. For each inbound company (+ its domain) it prints the
 * normalized name, the distinctive (brand) tokens, and exactly which tier the
 * cascade resolves through (domain / exact / containment / fuzzy) and to which
 * client — so we can confirm the hardened matcher no longer fuses them, and see
 * the real path for the puzzling Alesayi→Yanbu case.
 *
 *   npx tsx scripts/debugPreflightMatches.ts
 *
 * Expected AFTER the fix: resolvedVia = null for all five (no client match) —
 * EXCEPT where the row legitimately matches its OWN client.
 */
import { debugDirectoryMatch } from "../src/utils/duplicateRadarPreflight";

const CASES: Array<{ name: string; domain?: string }> = [
  { name: "SAJA Pharmaceuticals" },
  { name: "Kasab International Energy Services LLC", domain: "<REDACTED_HOST>" },
  { name: "Rawabi Vallianz Offshore Services", domain: "" },
  { name: "Alesayi Motors", domain: "<REDACTED_HOST>" },
  { name: "Alesayi Motors" }, // the #n / no-domain sibling row
  { name: "Confidential Construction" },
  { name: "Confidential" },
];

async function main() {
  for (const c of CASES) {
    const r = await debugDirectoryMatch(c.name, c.domain);
    console.log("\n=================================================");
    console.log(`INBOUND : "${c.name}"${c.domain ? "  (domain: " + c.domain + ")" : "  (no domain)"}`);
    console.log(`normalized       : "${r.normalized}"`);
    console.log(`distinctiveTokens: [${r.distinctiveTokens.join(", ")}]`);
    console.log(`domainHit        : ${r.domainHit ? r.domainHit.key + " -> " + r.domainHit.client : "—"}`);
    console.log(`exact byName     : ${r.exact}`);
    console.log(`containment      : ${r.contained ?? "—"}`);
    console.log(`fuzzy            : ${r.fuzzy ?? "—"}`);
    console.log(`>> RESOLVES VIA  : ${r.resolvedVia ?? "NO MATCH"}  ${r.resolvedVia ? "-> " + r.resolvedClient + " (active=" + r.resolvedActive + ")" : ""}`);
    if (r.resolvedVia) {
      console.log(`   relatedNameKeys: ${r.relatedNameKeys.slice(0, 12).join(" | ") || "—"}`);
      if (r.relatedDomainKeys.length) console.log(`   relatedDomainKeys: ${r.relatedDomainKeys.join(" | ")}`);
    }
  }
  console.log("\n(done)");
  process.exit(0);
}
main().catch((e) => { console.error("debug failed:", e); process.exit(2); });
