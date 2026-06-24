/**
 * Why is a company the user KNOWS is a client landing in PASS? Show its deals
 * (layout / phase / stage / domain / CS owner) and accounts so we can tell if
 * it's catchable (has a WalaPlus CS deal) or a CRM data gap (no phase/domain,
 * or only a Marketplace deal).
 *
 *   npx tsx scripts/inspectClientMiss.ts
 *
 * Edit TARGETS to add any company the user flags as a missed client.
 */
import { pool } from "../src/utils/duplicateRadarDatabase";

const TARGETS = [
  "Abdul Latif Jameel United Finance",
  "Abdul Latif Jameel",
  "United Finance",
];

const LAYOUT = "COALESCE(NULLIF(layout_name,''), raw_data->'Layout'->>'name','(blank)')";
const CSOWNER =
  "COALESCE(raw_data->'CS_Owner_Name'->>'name', raw_data->>'CS_Owner_Name', raw_data->'CS_Owner1'->>'name', raw_data->>'CS_Owner1')";

async function main() {
  for (const t of TARGETS) {
    console.log(`\n===== ${t} =====`);
    const deals = await pool.query(
      `SELECT account_name, company_name, ${LAYOUT} AS layout,
              raw_data->>'Phase' AS phase,
              COALESCE(NULLIF(stage,''), raw_data->>'Stage') AS stage,
              LOWER(domain) AS domain,
              NULLIF(raw_data->>'Company_Domain','') AS company_domain,
              ${CSOWNER} AS cs_owner
         FROM duplicate_records
        WHERE record_type='deal'
          AND (account_name ILIKE $1 OR company_name ILIKE $1)
        LIMIT 12`,
      [`%${t}%`],
    );
    console.log(`  DEALS: ${deals.rows.length}`);
    for (const d of deals.rows)
      console.log(
        `   [deal] name="${(d.account_name || d.company_name || "").slice(0, 34)}" layout="${d.layout}" ` +
          `phase=${d.phase || "-"} stage=${d.stage || "-"} domain=${d.domain || "-"} ` +
          `CompanyDomain=${d.company_domain || "-"} csOwner=${d.cs_owner || "-"}`,
      );
    const accts = await pool.query(
      `SELECT record_name, company_name, LOWER(domain) AS domain, ${LAYOUT} AS layout
         FROM duplicate_records
        WHERE record_type='account'
          AND (record_name ILIKE $1 OR company_name ILIKE $1)
        LIMIT 8`,
      [`%${t}%`],
    );
    console.log(`  ACCOUNTS: ${accts.rows.length}`);
    for (const a of accts.rows)
      console.log(`   [acct] name="${(a.record_name || a.company_name || "").slice(0, 34)}" domain=${a.domain || "-"} layout="${a.layout}"`);
  }
  console.log("");
  process.exit(0);
}
main().catch((e) => { console.error("inspect failed:", e); process.exit(2); });
