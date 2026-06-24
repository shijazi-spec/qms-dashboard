/**
 * Bulk targeted re-sync for deals you've corrected in Zoho (so the CS-client
 * directory drops them WITHOUT waiting for a full scan). Re-fetches each
 * matching deal from Zoho and overwrites the local raw_data + stage + layout,
 * then busts the directory cache.
 *
 *   npx tsx scripts/resyncCorrectedDeals.ts
 *
 * Edit TARGETS to add any company you've fixed in Zoho. (The per-row
 * "↻ Re-check from CRM" button on the Preflight page does the same thing for a
 * single company — this script is the bulk fallback when you fix many at once.)
 *
 * Shares the exact logic the button uses: resyncCompanyDealsFromZoho().
 */
import { resyncCompanyDealsFromZoho, ResyncTarget } from "../src/utils/duplicateRadarResync";

const TARGETS: ResyncTarget[] = [
  { label: "AlYemni Group", domains: ["yemni.com"], names: ["yemni", "اليمني"] },
  { label: "Zid", domains: ["zid.sa"], names: ["zid", "زد"] },
  { label: "Tarbiyah Islamiyah Schools", domains: ["tischools.edu.sa"], names: ["tarbyah", "tarbiyah", "tischools", "التربية الإسلامية"] },
];

async function main() {
  for (const t of TARGETS) {
    const res = await resyncCompanyDealsFromZoho([t]);
    console.log(`\n===== ${t.label}: ${res.scanned} local deal(s) =====`);
    for (const d of res.details) {
      if (d.status === "not_in_zoho") {
        console.log(`  ${d.id} "${d.name}": NOT in Zoho (deleted/converted) — left as-is`);
      } else {
        console.log(`  ${d.id} "${(d.name || "").slice(0, 34)}": phase ${d.phaseBefore || "-"} -> ${d.phaseAfter || "-"} | stage ${d.stageBefore || "-"} -> ${d.stageAfter || "-"}`);
      }
    }
  }
  console.log("\nDone. The CS-client directory cache was busted — re-run the preflight check and these should move to PASS.");
  process.exit(0);
}
main().catch((e) => { console.error("resync failed:", e); process.exit(2); });
