/**
 * Find DEALS whose own company name disagrees with the Account they're linked
 * to — the "company name ≠ account name" class that pollutes the CS-client
 * directory (a deal under the Yanbu account whose Company field says "Alesayi"
 * makes byName["alesayi"] resolve to Yanbu). For each such deal it prints the
 * conflicting names + owner + stage so CS can fix them at source in Zoho.
 *
 *   npx tsx scripts/findMislabeledDeals.ts
 *
 * A conflict = the deal's company_name and its linked Account_Name share NO
 * distinctive (brand) token (using the SAME logic the matcher uses), and both
 * carry real identity (not placeholders / all-generic).
 */
import { pool } from "../src/utils/duplicateRadarDatabase";
import { normalizeCompanyName, isPlaceholderName } from "../src/utils/duplicateRadarDatabase";
import { distinctiveTokensOf } from "../src/utils/duplicateRadarPreflight";

function shareBrandToken(a: string, b: string): boolean {
  const ta = new Set(distinctiveTokensOf(a));
  return distinctiveTokensOf(b).some((t) => ta.has(t));
}

async function main() {
  const q = await pool.query(
    `SELECT zoho_record_id, owner_name,
            company_name, account_name,
            raw_data->'Account_Name'->>'name' AS linked_account,
            COALESCE(NULLIF(stage,''), raw_data->>'Stage') AS stage,
            raw_data->>'Deal_Name' AS deal_name,
            raw_data->>'Phase' AS phase
       FROM duplicate_records
      WHERE record_type='deal'
        AND raw_data->'Account_Name'->>'name' IS NOT NULL
        AND company_name IS NOT NULL`,
  );

  const flagged: any[] = [];
  for (const r of q.rows) {
    const account = (r.linked_account || r.account_name || "").toString().trim();
    const company = (r.company_name || "").toString().trim();
    if (!account || !company) continue;
    const na = normalizeCompanyName(account);
    const nc = normalizeCompanyName(company);
    if (!na || !nc || na === nc) continue;
    if (isPlaceholderName(account) || isPlaceholderName(company)) continue;
    // Both must carry brand identity, and they must share NONE of it.
    if (
      distinctiveTokensOf(account).length > 0 &&
      distinctiveTokensOf(company).length > 0 &&
      !shareBrandToken(account, company)
    ) {
      flagged.push(r);
    }
  }

  console.log(`Scanned ${q.rows.length} linked deal(s). Conflicts (company ≠ account): ${flagged.length}\n`);
  for (const r of flagged.slice(0, 200)) {
    console.log(`  deal ${r.zoho_record_id}  [stage=${r.stage || "—"} phase=${r.phase || "—"} owner=${r.owner_name || "—"}]`);
    console.log(`      Company field : "${r.company_name}"`);
    console.log(`      Linked Account: "${r.linked_account || r.account_name}"`);
    if (r.deal_name) console.log(`      Deal name     : "${r.deal_name}"`);
  }
  if (flagged.length > 200) console.log(`\n… and ${flagged.length - 200} more.`);
  console.log(`\nFix at source in Zoho: align the deal's Company field with its Account (or relink).`);
  process.exit(0);
}
main().catch((e) => { console.error("finder failed:", e); process.exit(2); });
