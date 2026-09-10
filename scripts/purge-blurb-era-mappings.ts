/**
 * CLI wrapper over purgeBlurbEraMappings — see src/utils/blurbEraPurge.ts for
 * what "blurb-era" means and why the purge has to clear five tables, not one.
 *
 * The same logic backs the "Clear blurb-era mappings" button on the Mapping
 * Console, so the two entry points can never drift apart.
 *
 * USAGE (DATABASE_URL must point at the QMS Postgres)
 *   npx tsx scripts/purge-blurb-era-mappings.ts             # dry run, writes nothing
 *   npx tsx scripts/purge-blurb-era-mappings.ts --apply     # back up to JSON, then delete
 *   npx tsx scripts/purge-blurb-era-mappings.ts --apply --out=/tmp/backup.json
 *
 * Dry run is the default. Read the `database` and `documents_total` values it
 * prints BEFORE using --apply — a workspace shell does not always point at the
 * same Postgres the published app uses.
 */
import { writeFileSync } from "fs";
import { purgeBlurbEraMappings, PURGE_LABELS } from "../src/utils/blurbEraPurge";

const APPLY = process.argv.includes("--apply");
const OUT =
  process.argv.find((a) => a.startsWith("--out="))?.slice("--out=".length) ||
  `blurb-era-purge-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

function printCounts(counts: Record<string, number>): void {
  console.table(
    Object.entries(counts).map(([k, n]) => ({ Table: PURGE_LABELS[k] || k, Rows: n })),
  );
}

async function main(): Promise<void> {
  console.log(
    `\n=== Blurb-era mapping purge — ${APPLY ? "APPLY" : "DRY RUN (nothing will be written)"} ===\n`,
  );

  // Always count first, even for --apply: the counts become the backup, and
  // seeing them is what tells the operator they are on the right database.
  const preview = await purgeBlurbEraMappings({
    dryRun: true,
    includeRows: APPLY,
  });
  console.table(preview.scope);

  if (preview.scope.documents_placeholder === 0) {
    console.log(
      "\nNo placeholder documents — nothing to purge. This is what a clean database looks like.\n",
    );
    return;
  }

  console.log("\n— rows this run removes —");
  printCounts(preview.counts as unknown as Record<string, number>);

  console.log(
    `\nHuman links preserved: ${preview.preserved_manual_links.length}` +
      (preview.preserved_manual_links.length
        ? "  (each one keeps that document × framework pair out of the re-map)"
        : ""),
  );
  if (preview.preserved_manual_links.length) {
    console.table(preview.preserved_manual_links);
  }

  if (preview.total === 0) {
    console.log("\nNothing to delete.\n");
    return;
  }

  if (!APPLY) {
    console.log(
      `\nDry run only — ${preview.total} rows WOULD be deleted. Re-run with --apply to do it.\n`,
    );
    return;
  }

  // Back up BEFORE deleting, to a file rather than a table: a table created
  // only by a script is exactly what Replit's publish schema-diff offers to DROP.
  writeFileSync(
    OUT,
    JSON.stringify({ purged_at: new Date().toISOString(), ...preview }, null, 2),
  );
  console.log(`\nBackup written: ${OUT}`);

  const result = await purgeBlurbEraMappings({ dryRun: false });
  console.log("\n— deleted —");
  printCounts(result.counts as unknown as Record<string, number>);
  console.table({
    links_remaining: result.scope.links_total - result.counts.links,
    findings_remaining: result.scope.findings_total - result.counts.findings,
  });

  console.log(
    "\nDone. The Mapping Console now reports what is actually known.\n" +
      "Re-mapping is NOT run here, and running it now would only re-map the same\n" +
      "blurbs. Once the English files are attached the projection re-extracts on\n" +
      "its own; then press “Map all frameworks”.\n",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
