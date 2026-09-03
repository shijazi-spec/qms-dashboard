/**
 * Audit a PASS domain list against the LIVE preflight engine. For every
 * corporate domain it runs the REAL runPreflight cascade (domain → name) and
 * reports any that come back as anything other than PASS — i.e. a client that
 * leaked into the safe-to-import list. Public / blank domains (#n, gmail,
 * hotmail, …) can't be domain-matched and are listed separately as "skipped".
 *
 *   npx tsx scripts/checkPassDomains.ts
 *
 * Each probe row gets a throwaway <REDACTED_HOST> email so Rule 1 (contact
 * duplicate) can't fire and the row isn't skipped as name-only — the verdict
 * reflects ONLY the existing-client (domain) check.
 */
import { runPreflight } from "../src/utils/duplicateRadarPreflight";

// The exact PASS "Domain" column pasted by Sample User 2026-06-25.
const RAW = `
#n
19011.tel
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
hotmail
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
alfaisal.edu
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
gmail
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>.uk
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
شركة أجيالنا التعليمية
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
bridgestone.ae
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
digitrends.pk
<REDACTED_HOST>
<REDACTED_HOST>
fakeeh.care
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
ewpartners.fund
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>.kr
<REDACTED_HOST>
<REDACTED_HOST>.cn
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
lhsc.on.ca
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
mapa.group
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
pma.ps
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
outlook
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>.uk
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
usj.edu.lb
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
sgc.it
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
sicim.eu
<REDACTED_HOST>
<REDACTED_HOST>
yahoo
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
tamam.life
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>.tr
<REDACTED_HOST>
<REDACTED_HOST>
tecnicasreunidas.es
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
aup.edu.pk
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
vt.edu
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
<REDACTED_HOST>
`;

function isPublicOrBlank(d: string): boolean {
  const x = d.trim().toLowerCase();
  if (!x || x === "#n") return true;
  if (!x.includes(".")) return true; // "hotmail"/"gmail"/"yahoo"/"outlook" w/o TLD, or a name
  return /^(gmail|googlemail|hotmail|outlook|live|yahoo|ymail|icloud|aol|proton|gmx|mail)\b/.test(x);
}
// A token in the domain column that isn't a domain at all (e.g. an Arabic name).
function looksLikeName(d: string): boolean {
  const x = d.trim();
  return !x.includes(".") && /[^\x00-\x7F]/.test(x); // has non-ASCII and no dot
}

async function main() {
  const all = RAW.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const nonDomains = Array.from(new Set(all.filter(looksLikeName)));
  const checkable = Array.from(new Set(all.filter((d) => !isPublicOrBlank(d))));
  const skipped = all.filter((d) => isPublicOrBlank(d)).length;

  console.log(`Total rows: ${all.length} | unique checkable domains: ${checkable.length} | public/blank skipped: ${skipped}`);
  if (nonDomains.length) console.log(`Not a domain (fix in source): ${nonDomains.join(" , ")}`);

  const rows = checkable.map((d, i) => ({
    company_name: "Example Organization",
    domain: d,
    email: `probe${i}@<REDACTED_HOST>`,
  }));
  const res = await runPreflight({ rows, refresh_overlap: false });

  const leaks = (res.rows || []).filter(
    (r: any) => r.verdict !== "pass" && r.verdict !== "no_contact",
  );

  console.log(`\n================  RESULT  ================`);
  if (leaks.length === 0) {
    console.log(`✓ CLEAN — all ${checkable.length} domains correctly PASS (no client leaked in).`);
  } else {
    console.log(`✗ ${leaks.length} domain(s) should NOT be PASS:\n`);
    for (const r of leaks) {
      const churn = r.churn_days != null ? `, churned ${r.churn_days}d` : "";
      console.log(`  ${r.input.domain}  ->  ${r.verdict.toUpperCase()}${churn}`);
      console.log(`     ${(r.executive_action || r.reason || "").toString().slice(0, 140)}`);
      if (r.cs_owner) console.log(`     CS owner: ${r.cs_owner}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error("check failed:", e); process.exit(2); });
