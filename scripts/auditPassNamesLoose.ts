/**
 * INDEPENDENT recall audit of the PASS names (does NOT rely on the strict
 * matcher). Reads scripts/passNames.txt and, for every name, finds the closest
 * CLIENT in the directory that shares a distinctive brand token — even below the
 * block threshold — so you can eyeball whether a PASS company is actually a
 * client the strict cascade missed. Over-surfaces on purpose; you confirm.
 *
 *   npx tsx scripts/auditPassNamesLoose.ts
 *
 * Bands:
 *   would_block    — strict matcher SHOULD have caught this (investigate now)
 *   strong_review  — shares >=2 brand tokens with a client (likely the same org)
 *   weak_review    — single shared brand token + notable similarity (maybe)
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

  for (const band of ["would_block", "strong_review", "weak_review"] as const) {
    const rows = byBand(band);
    console.log(`\n===== ${band.toUpperCase()} (${rows.length}) =====`);
    for (const h of rows) {
      const status = h.active ? "ACTIVE client" : h.churnDays != null ? `churned ${h.churnDays}d` : "client";
      console.log(`  "${h.name}"`);
      console.log(`      ~ ${h.clientLabel}  [${status}]  dice=${h.dice}  shared=[${h.sharedTokens.join(", ")}]`);
    }
  }
  console.log(`\nTotal flagged for human review: ${hits.length} of ${names.length}.`);
  console.log(`(would_block should be 0 — anything there is a real strict-matcher miss.)`);
  process.exit(0);
}
main().catch((e) => { console.error("audit failed:", e); process.exit(2); });
