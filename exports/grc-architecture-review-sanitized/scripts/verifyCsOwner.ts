/**
 * Confirm the directory now takes the CS owner from the deal's "CS Owner Name"
 * field (Customer Success section), not the deal owner.
 *
 *   npx tsx scripts/verifyCsOwner.ts
 *
 * For a sample of client deals it prints: deal owner_name vs each candidate CS
 * owner field, and the value the directory will now use. Also spotlights the
 * Remat Al-Riyadh deal (<REDACTED_HOST>) which should show CS owner = Zeina Alsoudi.
 */
import { pool } from "../src/utils/duplicateRadarDatabase";

const KEYS = ["CS_Owner_Name", "cs_owner_name", "CS Owner Name", "CS_Owner1", "CS_Owner"];

function pick(rd: any): { field: string; value: string } | null {
  for (const k of KEYS) {
    const v = rd?.[k];
    if (v == null) continue;
    const name = typeof v === "object" ? (v.name ?? "") : String(v);
    if (name && String(name).trim()) return { field: k, value: String(name).trim() };
  }
  return null;
}

async function main() {
  console.log("\n=== Remat Al-Riyadh (<REDACTED_HOST>) ===");
  const remat = await pool.query(
    `SELECT account_name, company_name, owner_name, raw_data
       FROM duplicate_records
      WHERE record_type='deal'
        AND (LOWER(domain)='<REDACTED_HOST>' OR account_name ILIKE '%ريمات%' OR company_name ILIKE '%remat%')
      LIMIT 5`,
  );
  for (const r of remat.rows) {
    const cs = pick(r.raw_data || {});
    console.log(`  name="${r.account_name || r.company_name}"`);
    console.log(`     deal owner_name = ${r.owner_name}`);
    console.log(`     CS owner        = ${cs ? `${cs.value}  (from ${cs.field})` : "(none of the CS fields set)"}`);
  }

  console.log("\n=== sample of 12 client deals — deal owner vs CS owner ===");
  const sample = await pool.query(
    `SELECT account_name, company_name, owner_name, raw_data
       FROM duplicate_records
      WHERE record_type='deal'
        AND NULLIF(raw_data->>'Phase','') IS NOT NULL
      LIMIT 12`,
  );
  let same = 0, diff = 0, missing = 0;
  for (const r of sample.rows) {
    const cs = pick(r.raw_data || {});
    const dealOwner = (r.owner_name || "").trim();
    const tag = !cs ? "NO-CS-OWNER" : cs.value === dealOwner ? "same" : "DIFFERENT";
    if (!cs) missing++; else if (cs.value === dealOwner) same++; else diff++;
    console.log(`  [${tag}] ${String(r.account_name || r.company_name).slice(0, 30).padEnd(30)} deal=${dealOwner || "-"} | cs=${cs ? cs.value : "-"}`);
  }
  console.log(`\n  summary: ${diff} differ (CS owner ≠ deal owner — this is the fix), ${same} same, ${missing} no CS owner set`);
  console.log("");
  process.exit(0);
}

main().catch((e) => { console.error("verify failed:", e); process.exit(2); });
