/**
 * Audit a PASS company-NAME list against the LIVE preflight name matcher. Reads
 * names from scripts/passNames.txt (one per line; # comments + blanks ignored),
 * runs each through the REAL runPreflight cascade with NO domain — so it tests
 * the NAME path only — and reports any that resolve to an existing client
 * (i.e. a client whose name leaked into the safe-to-import list).
 *
 *   1) Paste the PASS "Company Name" column into scripts/passNames.txt
 *   2) npx tsx scripts/checkPassNames.ts
 *
 * Each probe row gets a throwaway example.com email so Rule 1 (contact
 * duplicate) can't fire and the name-only row isn't skipped — the verdict
 * reflects ONLY the existing-client NAME check.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { runPreflight } from "../src/utils/duplicateRadarPreflight";

async function main() {
  const path = join(process.cwd(), "scripts", "passNames.txt");
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.error(`Could not read ${path}. Create it and paste the names.`);
    process.exit(2);
  }

  const names = Array.from(
    new Set(
      raw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("#")),
    ),
  );

  if (names.length === 0) {
    console.log("No names found in scripts/passNames.txt — paste the Company Name column there first.");
    process.exit(0);
  }

  console.log(`Checking ${names.length} unique company name(s) against the live client directory…`);

  const rows = names.map((n, i) => ({
    company_name: n,
    email: `probe${i}@example.com`,
  }));
  const res = await runPreflight({ rows, refresh_overlap: false });

  const leaks = (res.rows || []).filter(
    (r: any) => r.verdict !== "pass" && r.verdict !== "no_contact",
  );

  console.log(`\n================  RESULT  ================`);
  if (leaks.length === 0) {
    console.log(`✓ CLEAN — all ${names.length} names correctly PASS (no client name leaked in).`);
  } else {
    console.log(`✗ ${leaks.length} name(s) should NOT be PASS:\n`);
    for (const r of leaks) {
      const churn = r.churn_days != null ? `, churned ${r.churn_days}d` : "";
      console.log(`  "${r.input.company_name}"  ->  ${r.verdict.toUpperCase()}${churn}`);
      console.log(`     ${(r.executive_action || r.reason || "").toString().slice(0, 160)}`);
      if (r.cs_owner) console.log(`     CS owner: ${r.cs_owner}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error("check failed:", e); process.exit(2); });
