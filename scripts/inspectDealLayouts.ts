/**
 * Show the Deal layouts so the directory can include CORPORATE clients and
 * exclude MERCHANT / app deals correctly.
 *   npx tsx scripts/inspectDealLayouts.ts
 *
 * Prints: every distinct Deal layout (with counts), then the layout for the
 * companies that SHOULD pass (merchant — Sales may contact) vs SHOULD block
 * (real corporate clients). That tells us exactly which layouts to exclude.
 */
import { pool } from "../src/utils/duplicateRadarDatabase";

const LAYOUT_EXPR =
  "COALESCE(NULLIF(layout_name,''), raw_data->'Layout'->>'name', '(blank)')";

// Companies you flagged as MERCHANT / app (should be contactable -> PASS).
const SHOULD_PASS = ["ATOM", "Huawei", "Beyond ONE", "Beyond", "ToYou", "تويو", "Canon"];
// Companies that are real corporate clients (should stay BLOCK).
const SHOULD_BLOCK = [
  "SIDF",
  "Saudi Industrial Development Fund",
  "Awqaf",
  "Riyad Bank",
  "Saudi Tourism Authority",
  "Monshaat",
];

async function layoutsFor(names: string[]) {
  for (const t of names) {
    const r = await pool.query(
      `SELECT DISTINCT account_name, company_name, ${LAYOUT_EXPR} AS layout,
              raw_data->>'Phase' AS phase
         FROM duplicate_records
        WHERE record_type='deal'
          AND (account_name ILIKE $1 OR company_name ILIKE $1)
        LIMIT 6`,
      [`%${t}%`],
    );
    if (!r.rows.length) { console.log(`  ${t.padEnd(34)} (no deal found)`); continue; }
    for (const row of r.rows)
      console.log(`  ${String(t).padEnd(20)} layout="${row.layout}"  phase=${row.phase || "-"}  name="${(row.account_name || row.company_name || "").slice(0,28)}"`);
  }
}

async function main() {
  console.log("\n=== ALL distinct Deal layouts (by count) ===");
  const q = await pool.query(
    `SELECT ${LAYOUT_EXPR} AS layout, COUNT(*) AS n
       FROM duplicate_records WHERE record_type='deal'
      GROUP BY 1 ORDER BY n DESC`,
  );
  for (const r of q.rows) console.log(`  ${String(r.n).padStart(7)}  ${r.layout}`);

  console.log("\n=== SHOULD PASS (merchant/app — must NOT be in the directory) ===");
  await layoutsFor(SHOULD_PASS);

  console.log("\n=== SHOULD BLOCK (corporate clients — must stay in the directory) ===");
  await layoutsFor(SHOULD_BLOCK);

  console.log("");
  process.exit(0);
}
main().catch((e) => { console.error("inspect failed:", e); process.exit(2); });
