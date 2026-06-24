/**
 * INDEPENDENT recall audit of the PASS names (does NOT rely on the strict
 * matcher). Reads scripts/passNames.txt and, for every name, finds the closest
 * CLIENT in the directory that shares a distinctive brand token — even below the
 * block threshold — so you can eyeball whether a PASS company is actually a
 * client the strict cascade missed. Over-surfaces on purpose; you confirm.
 *
 *   npx tsx scripts/auditPassNamesLoose.ts
 *
 * Only ACTIVE or in-cool-off clients are reported (churned-past-cool-off
 * correctly PASS and are dropped as noise). Bands:
 *   leak_strict     — strict matcher SHOULD have caught it (real miss / drift)
 *   short_name_skip — exact client name but inbound <4 chars (≥4 floor skipped it)
 *   near_miss       — resembles a live client; human eyeball (often different org)
 */
import { readFileSync } from "fs";
import { join } from "path";
import { auditPassNamesLoose } from "../src/utils/duplicateRadarPreflight";

async function main() {
  const path = join(process.cwd(), "scripts", "passNames.txt");
  const raw = readFileSync(path, "utf8");
  const names = Array.from(
    new Set(
      raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#")),
    ),
  );
  console.log(`Loose-auditing ${names.length} PASS name(s) against the live client directory…\n`);

  const hits = await auditPassNamesLoose(names);
  const byBand = (b: string) => hits.filter((h) => h.band === b);

  for (const band of ["leak_strict", "short_name_skip", "near_miss"] as const) {
    const rows = byBand(band);
    console.log(`\n===== ${band.toUpperCase()} (${rows.length}) =====`);
    for (const h of rows) {
      const status = h.status === "active" ? "ACTIVE" : `in cool-off (churned ${h.churnDays}d, ${h.sector})`;
      console.log(`  "${h.name}"`);
      console.log(`      ~ ${h.clientLabel}  [${status}]  dice=${h.dice}  shared=[${h.sharedTokens.join(", ")}]`);
    }
  }
  console.log(`\nReported (active / in-cool-off only): ${hits.length} of ${names.length}.`);
  console.log(`leak_strict should be ~0; short_name_skip = the ≥4-char floor gap; near_miss = human eyeball.`);
  process.exit(0);
}
main().catch((e) => { console.error("audit failed:", e); process.exit(2); });
