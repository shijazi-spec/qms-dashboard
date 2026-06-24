/**
 * Confirm the marketplace-exclusion fix uses the right layout names.
 *   npx tsx scripts/inspectDealLayouts.ts
 *
 * Prints the distinct Deal layout_name values (with counts) so we know the exact
 * strings, and shows ATOM's deal layout — it should be a Marketplace layout that
 * the directory now excludes (so ATOM stops blocking and Sales can contact it).
 */
import { pool } from "../src/utils/duplicateRadarDatabase";

async function main() {
  console.log("\n=== distinct Deal layout_name (top 25 by count) ===");
  const q = await pool.query(
    `SELECT COALESCE(NULLIF(layout_name,''), raw_data->'Layout'->>'name', '(blank)') AS layout, COUNT(*) AS n
       FROM duplicate_records WHERE record_type='deal'
      GROUP BY 1 ORDER BY n DESC LIMIT 25`,
  );
  for (const r of q.rows) console.log(`  ${String(r.n).padStart(7)}  ${r.layout}`);

  console.log("\n=== ATOM deal(s) — layout + phase/stage ===");
  const atom = await pool.query(
    `SELECT account_name, company_name,
            COALESCE(NULLIF(layout_name,''), raw_data->'Layout'->>'name','(blank)') AS layout,
            raw_data->>'Phase' AS phase, COALESCE(NULLIF(stage,''), raw_data->>'Stage') AS stage
       FROM duplicate_records
      WHERE record_type='deal' AND (account_name ILIKE '%atom%' OR company_name ILIKE '%atom%')
      LIMIT 10`,
  );
  for (const r of atom.rows)
    console.log(`  name="${r.account_name || r.company_name}" layout="${r.layout}" phase=${r.phase} stage=${r.stage}`);

  console.log("\nNote: directory now EXCLUDES layouts: marketplace, partner accounts.");
  console.log("");
  process.exit(0);
}
main().catch((e) => { console.error("inspect failed:", e); process.exit(2); });
