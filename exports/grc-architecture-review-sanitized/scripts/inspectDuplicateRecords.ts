/**
 * One-shot inspector for duplicate_records — tells us why the CS-client
 * directory came back empty. Run in the HostingPlatform shell:
 *
 *   npx tsx scripts/inspectDuplicateRecords.ts
 *
 * Prints: row counts by record_type and by CRMProvider_module, a sample deal's
 * raw_data keys + Stage + phase-ish fields, and the actual Riyad Bank row(s)
 * so we can see which column/field the directory query must filter on.
 */
import { pool } from "../src/utils/duplicateRadarDatabase";

async function main() {
  console.log("\n=== row counts by record_type ===");
  const byType = await pool.query(
    `SELECT record_type, COUNT(*) AS n FROM duplicate_records GROUP BY record_type ORDER BY n DESC`,
  );
  for (const r of byType.rows) console.log(`  ${String(r.record_type ?? "(null)").padEnd(12)} ${r.n}`);

  console.log("\n=== row counts by CRMProvider_module ===");
  const byMod = await pool.query(
    `SELECT CRMProvider_module, COUNT(*) AS n FROM duplicate_records GROUP BY CRMProvider_module ORDER BY n DESC`,
  );
  for (const r of byMod.rows) console.log(`  ${String(r.CRMProvider_module ?? "(null)").padEnd(16)} ${r.n}`);

  console.log("\n=== cross-tab: record_type x CRMProvider_module ===");
  const cross = await pool.query(
    `SELECT record_type, CRMProvider_module, COUNT(*) AS n
       FROM duplicate_records GROUP BY record_type, CRMProvider_module ORDER BY n DESC LIMIT 20`,
  );
  for (const r of cross.rows)
    console.log(`  rt=${String(r.record_type ?? "null").padEnd(10)} mod=${String(r.CRMProvider_module ?? "null").padEnd(14)} ${r.n}`);

  console.log("\n=== sample deal raw_data keys (CRMProvider_module='Deals') ===");
  const sample = await pool.query(
    `SELECT record_type, CRMProvider_module, account_name, company_name, domain, raw_data
       FROM duplicate_records WHERE CRMProvider_module = 'Deals' LIMIT 1`,
  );
  if (sample.rows.length) {
    const s = sample.rows[0];
    console.log(`  record_type=${s.record_type}  CRMProvider_module=${s.CRMProvider_module}`);
    console.log(`  account_name=${s.account_name}  domain=${s.domain}`);
    const rd = s.raw_data || {};
    console.log(`  raw_data keys: ${Object.keys(rd).join(", ")}`);
    console.log(`  Stage=${JSON.stringify(rd.Stage)}`);
    for (const k of Object.keys(rd))
      if (/phase|stage|churn|company.?domain/i.test(k)) console.log(`  field "${k}" = ${JSON.stringify(rd[k])}`);
  } else {
    console.log("  (no rows with CRMProvider_module='Deals')");
  }

  console.log("\n=== Riyad Bank — actual record(s) ===");
  const riyad = await pool.query(
    `SELECT record_type, CRMProvider_module, account_name, company_name, domain, raw_data
       FROM duplicate_records
      WHERE (account_name ILIKE '%riyad%' OR company_name ILIKE '%riyad%'
             OR raw_data::text ILIKE '%riyadbank%' OR raw_data::text ILIKE '%الرياض%')
      LIMIT 8`,
  );
  console.log(`  matched ${riyad.rows.length} row(s)`);
  for (const r of riyad.rows) {
    const rd = r.raw_data || {};
    const phaseKeys: string[] = [];
    for (const k of Object.keys(rd))
      if (/phase|churn|company.?domain/i.test(k)) phaseKeys.push(`${k}=${JSON.stringify(rd[k])}`);
    console.log(
      `  [${r.record_type}/${r.CRMProvider_module}] name="${r.account_name || r.company_name}" domain=${r.domain} ` +
        `Stage=${JSON.stringify(rd.Stage)} ${phaseKeys.join(" ")}`,
    );
  }

  console.log("");
  await pool.end?.();
  process.exit(0);
}

main().catch((e) => {
  console.error("inspect failed:", e);
  process.exit(2);
});
