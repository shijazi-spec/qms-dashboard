/**
 * Trace WHERE a spurious directory byName key came from. For each (key, label)
 * pair the loose audit flagged as a wrong link (e.g. "atc" carrying UTEC's
 * status), this prints every duplicate_records row whose company/account name
 * contains that word — with its record_type, domain, phase/stage — and the
 * label company's own domains. That shows whether a stray record (e.g. a
 * contact whose company field says "ATC" sitting on the client's domain) is
 * minting the false key via the durable name-indexing pass.
 *
 *   npx tsx scripts/traceDirectoryKey.ts
 */
import { pool } from "../src/utils/duplicateRadarDatabase";
import { normalizeCompanyName } from "../src/utils/duplicateRadarDatabase";

const PAIRS = [
  { key: "atc", label: "utec" },
  { key: "stc", label: "sasref" },
  { key: "alesayi", label: "yanbu" },
];

function wordRe(w: string) {
  return `(^|[^[:alpha:]])${w}([^[:alpha:]]|$)`;
}

async function rowsForWord(word: string) {
  const q = await pool.query(
    `SELECT record_type, zoho_record_id,
            company_name, account_name, record_name,
            LOWER(domain) AS domain,
            raw_data->>'Phase' AS phase,
            COALESCE(NULLIF(stage,''), raw_data->>'Stage') AS stage
       FROM duplicate_records
      WHERE company_name ~* $1 OR account_name ~* $1
      LIMIT 120`,
    [wordRe(word)],
  );
  return q.rows as any[];
}

async function main() {
  for (const { key, label } of PAIRS) {
    console.log(`\n========================================================`);
    console.log(`KEY "${key}"  (audit linked it to label "${label}")`);
    console.log(`--------------------------------------------------------`);

    // 1) Records whose company/account NORMALIZES to exactly the key — these are
    //    what get indexed into byName["<key>"].
    const keyRows = await rowsForWord(key);
    const exactKey = keyRows.filter((r) => {
      const cn = normalizeCompanyName(r.company_name || "");
      const an = normalizeCompanyName(r.account_name || "");
      return cn === key || an === key;
    });
    console.log(`Records normalizing to "${key}": ${exactKey.length}`);
    for (const r of exactKey.slice(0, 25)) {
      console.log(`  [${r.record_type}] dom=${r.domain || "—"} phase=${r.phase || "—"} stage=${r.stage || "—"} | company="${r.company_name || ""}" account="${r.account_name || ""}"`);
    }

    // 2) The LABEL company's domains — if a key-record shares one of these,
    //    that's how it inherited the client status.
    const labelRows = await rowsForWord(label);
    const labelDomains = Array.from(
      new Set(
        labelRows
          .map((r) => (r.domain || "").trim())
          .filter((d) => d && d.includes(".")),
      ),
    );
    console.log(`Label "${label}" domains: ${labelDomains.join(", ") || "—"}`);
    const overlap = exactKey.filter((r) => r.domain && labelDomains.includes(r.domain));
    if (overlap.length) {
      console.log(`>>> CULPRIT: ${overlap.length} "${key}" record(s) sit on "${label}"'s domain — durable name-index minted the false key:`);
      for (const r of overlap) {
        console.log(`    [${r.record_type}] ${r.domain} | company="${r.company_name}" account="${r.account_name}"`);
      }
    } else {
      console.log(`(no domain overlap — false key came from a different path; see records above)`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error("trace failed:", e); process.exit(2); });
