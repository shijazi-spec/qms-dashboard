/**
 * Why are these known clients missing from the CS-client directory?
 * For each target company, dump every matching DEAL and ACCOUNT row with the
 * fields the directory filters on (Stage, Phase, Churn_Date, Company_Domain,
 * Account_Name.id, domain, account_name). Reveals whether each is excluded
 * because it has no Phase + a non-customer Stage, an Arabic-only name, a
 * sub-4-char name, etc.
 *
 *   npx tsx scripts/inspectMissingClients.ts
 */
import { pool } from "../src/utils/duplicateRadarDatabase";

const TARGETS = [
  "Riyad Bank",
  "SATORP",
  "Mozn",
  "Diriyah",
  "SIDF",
  "Example Organization",
  "JHAH",
  "CMA",
  "HungerStation",
];

async function main() {
  for (const t of TARGETS) {
    console.log(`\n===== ${t} =====`);
    const q = await pool.query(
      `SELECT record_type, CRMProvider_module, account_name, company_name, domain, raw_data
         FROM duplicate_records
        WHERE account_name ILIKE $1 OR company_name ILIKE $1 OR record_name ILIKE $1
        ORDER BY record_type
        LIMIT 12`,
      [`%${t}%`],
    );
    if (!q.rows.length) {
      console.log("  (no deal/account/contact rows match this name)");
      continue;
    }
    for (const r of q.rows) {
      const rd = r.raw_data || {};
      if (r.record_type === "deal") {
        console.log(
          `  [DEAL] name="${r.account_name || r.company_name}" ` +
            `Stage=${JSON.stringify(rd.Stage)} Phase=${JSON.stringify(rd.Phase)} ` +
            `Churn=${JSON.stringify(rd.Churn_Date)} CompanyDomain=${JSON.stringify(rd.Company_Domain)} ` +
            `domainCol=${r.domain} AcctId=${rd.Account_Name?.id ?? "-"}`,
        );
      } else if (r.record_type === "account") {
        console.log(
          `  [ACCOUNT] record_name="${rd.Account_Name ?? r.account_name ?? r.company_name}" ` +
            `domain=${r.domain} website=${JSON.stringify(rd.Website)}`,
        );
      } else {
        console.log(`  [${r.record_type}] name="${r.account_name || r.company_name}" domain=${r.domain}`);
      }
    }
  }
  console.log("");
  process.exit(0);
}

main().catch((e) => {
  console.error("inspect failed:", e);
  process.exit(2);
});
