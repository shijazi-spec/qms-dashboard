/**
 * Comprehensive coverage audit of the whole preflight approach.
 *   npx tsx scripts/auditDirectoryCoverage.ts
 *
 * Enumerates every ACTIVE client in the CRM and checks the directory catches it
 * by domain and/or name. Reports the leak classes:
 *   - UNCOVERED  : caught by neither name nor domain -> ALWAYS leaks (must be 0)
 *   - DOMAIN-ONLY: caught only by domain -> leaks when an inbound row has no
 *                  domain (the "#n" class). Lists samples so we can judge risk.
 */
import { auditDirectoryCoverage } from "../src/utils/duplicateRadarPreflight";

async function main() {
  const a = await auditDirectoryCoverage();
  console.log("\n=== DIRECTORY ===");
  console.log(`  byName=${a.stats.names}  byDomain=${a.stats.domains}`);
  console.log("\n=== ACTIVE-CLIENT COVERAGE ===");
  console.log(`  active client deals : ${a.activeClients}`);
  console.log(`  covered by domain   : ${a.coveredByDomain}`);
  console.log(`  covered by name     : ${a.coveredByName}`);
  console.log(`  DOMAIN-ONLY (leak if inbound has no domain): ${a.domainOnly}`);
  console.log(`  no domain anywhere  : ${a.nameOnly}  (of which name path MISSES: ${a.nameOnlyUncovered})`);
  console.log(`  UNCOVERED (always leak): ${a.uncoveredCount}`);

  if (a.uncovered.length) {
    console.log("\n=== UNCOVERED active clients (MUST be 0) ===");
    for (const u of a.uncovered)
      console.log(`  ! "${u.name}" domain=${u.domain} layout=${u.layout} phase=${u.phase} stage=${u.stage}`);
  }
  if (a.domainOnlySamples.length) {
    console.log("\n=== DOMAIN-ONLY samples (would leak on a no-domain inbound row) ===");
    for (const d of a.domainOnlySamples)
      console.log(`  ~ "${d.name}" domain=${d.domain} phase=${d.phase} stage=${d.stage}`);
  }

  console.log("\n=== VERDICT ===");
  const ok = a.uncoveredCount === 0 && a.nameOnlyUncovered === 0;
  console.log(
    ok
      ? "  ✓ Every active client is catchable. No always-leak or name-only-miss class remains."
      : "  ✗ Gaps remain (listed above) — fix before trusting a PASS file.",
  );
  console.log("");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("audit failed:", e); process.exit(2); });
