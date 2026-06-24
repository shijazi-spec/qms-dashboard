/**
 * Fast targeted re-sync for the deals the user corrected in Zoho (so the
 * CS-client directory drops them WITHOUT waiting for a full scan). Re-fetches
 * each matching deal from Zoho and overwrites the local raw_data + stage +
 * layout so the directory rebuilds correctly within its 60s cache.
 *
 *   npx tsx scripts/resyncCorrectedDeals.ts
 *
 * Edit TARGETS to add any company you've fixed in Zoho.
 */
import { pool } from "../src/utils/duplicateRadarDatabase";
import { fetchZohoRecordById } from "../src/utils/zohoCRM";

const TARGETS: Array<{ label: string; domains: string[]; names: string[] }> = [
  { label: "AlYemni Group", domains: ["yemni.com"], names: ["yemni", "اليمني"] },
  { label: "Zid", domains: ["zid.sa"], names: ["zid", "زد"] },
  { label: "Tarbiyah Islamiyah Schools", domains: ["tischools.edu.sa"], names: ["tarbyah", "tarbiyah", "tischools", "التربية الإسلامية"] },
];

async function main() {
  let updated = 0, missing = 0;
  for (const t of TARGETS) {
    const conds: string[] = [];
    const params: any[] = [];
    let i = 1;
    for (const d of t.domains) { conds.push(`LOWER(domain) = $${i}`); params.push(d.toLowerCase()); i++; }
    for (const n of t.names) {
      conds.push(`account_name ILIKE $${i}`); params.push(`%${n}%`); i++;
      conds.push(`company_name ILIKE $${i}`); params.push(`%${n}%`); i++;
    }
    const q = await pool.query(
      `SELECT zoho_record_id, account_name, company_name,
              raw_data->>'Phase' AS phase,
              COALESCE(NULLIF(stage,''), raw_data->>'Stage') AS stage
         FROM duplicate_records
        WHERE record_type='deal' AND (${conds.join(" OR ")})
        LIMIT 60`,
      params,
    );
    console.log(`\n===== ${t.label}: ${q.rows.length} local deal(s) =====`);
    for (const r of q.rows) {
      const fresh: any = await fetchZohoRecordById("Deals", r.zoho_record_id).catch(() => null);
      if (!fresh) {
        missing++;
        console.log(`  ${r.zoho_record_id} "${r.account_name || r.company_name}": NOT in Zoho (deleted/converted) — left as-is`);
        continue;
      }
      const newPhase = fresh.Phase ?? null;
      const newStage = fresh.Stage ?? null;
      const newLayout = fresh.Layout?.name ?? fresh.$layout?.name ?? null;
      await pool.query(
        `UPDATE duplicate_records
            SET raw_data = $1::jsonb,
                stage = $2,
                layout_name = COALESCE($3, layout_name)
          WHERE record_type='deal' AND zoho_record_id = $4`,
        [JSON.stringify(fresh), newStage, newLayout, r.zoho_record_id],
      );
      updated++;
      console.log(`  ${r.zoho_record_id} "${(r.account_name || r.company_name || "").slice(0,34)}": phase ${r.phase || "-"} -> ${newPhase || "-"} | stage ${r.stage || "-"} -> ${newStage || "-"}`);
    }
  }
  console.log(`\nDone. Updated ${updated} deal(s) (${missing} not found in Zoho).`);
  console.log("The CS-client directory rebuilds within ~60s — re-run the preflight check and these should move to PASS.");
  process.exit(0);
}
main().catch((e) => { console.error("resync failed:", e); process.exit(2); });
