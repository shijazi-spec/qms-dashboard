#!/usr/bin/env node
/**
 * Which tables can this codebase create that the CONNECTED database does not
 * have yet?
 * ----------------------------------------------------------------------------
 * This app owns its schema at runtime: every table is a `CREATE TABLE IF NOT
 * EXISTS` inside an init function, and most of those inits run lazily — on the
 * first read or write of the feature that owns the table. So a table exists in
 * whichever environment happened to exercise that feature, and nowhere else.
 *
 * That asymmetry is the danger, not the laziness. Replit's publish step diffs
 * the DEV database against PRODUCTION, and a table present in prod but absent
 * from dev reads as a DELETION. On 2026-09-07 it offered to rename the live
 * `connector_evidence` table into a brand-new one; the other option's own small
 * print said the table "will be dropped". Neither said DROP TABLE in the
 * heading. One click, unrecoverable.
 *
 * So the useful question is not "which inits are lazy" — nearly all of them are
 * — but "which declared tables are MISSING from this database right now". Run
 * against the dev workspace, that list is exactly what the next publish can
 * offer to drop.
 *
 * REPORT ONLY. It issues one read-only query against information_schema and
 * creates nothing: guessing which init to call could run a feature's migration
 * path in the wrong environment. Fixing a finding means adding that init to the
 * boot sequence (see connector_evidence in src/mastra/index.ts) or exercising
 * the feature once in dev.
 *
 * Usage, from the Replit shell where DATABASE_URL points at DEV:
 *
 *   node scripts/check-lazy-tables.mjs
 *   node scripts/check-lazy-tables.mjs --strict   # exit 1 when anything is missing
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Pool } from "pg";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SRC = join(ROOT, "src");
const STRICT = process.argv.includes("--strict");

/** Every .ts file under src/, recursively. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/**
 * table name → the files that declare it.
 *
 * A table can legitimately be declared in more than one file (two features that
 * both ensure a shared table), so this keeps every declaring file rather than
 * the first — otherwise the report points at an arbitrary one of them.
 */
function collectDeclaredTables() {
  const declared = new Map();
  for (const file of walk(SRC)) {
    // Test files declare fixtures that never ship. Counting them would produce
    // findings nobody can act on.
    if (file.includes(".test.") || file.includes(".spec.")) continue;
    const text = readFileSync(file, "utf8");
    const re = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
    let m;
    while ((m = re.exec(text))) {
      const name = m[1].toLowerCase();
      if (!declared.has(name)) declared.set(name, new Set());
      declared.get(name).add(relative(ROOT, file).replace(/\\/g, "/"));
    }
  }
  return declared;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set — nothing to compare the code against.",
    );
    process.exit(2);
  }

  const declared = collectDeclaredTables();

  // Dedicated small pool: this deployment runs close to its Postgres connection
  // cap, and a one-shot script has no business holding more than it needs.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  let live;
  try {
    const res = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    live = new Set(res.rows.map((r) => String(r.table_name).toLowerCase()));
  } finally {
    await pool.end();
  }

  const missing = [...declared.keys()].filter((t) => !live.has(t)).sort();

  console.log(
    `\ncheck-lazy-tables: ${declared.size} table(s) declared in src/, ${live.size} present in this database.\n`,
  );

  if (missing.length === 0) {
    console.log(
      "✓ Every table this codebase can create already exists here. A publish diff\n" +
        "  from this database has nothing to read as a deletion.\n",
    );
    return;
  }

  console.log(
    `${missing.length} declared table(s) are MISSING from this database.\n` +
      `If this is DEV and any of them exist in PRODUCTION, the next publish can\n` +
      `offer to drop or rename them — sometimes without the word DROP appearing:\n`,
  );
  for (const t of missing) {
    const files = [...declared.get(t)].sort().join(", ");
    console.log(`  ${t}\n      declared in ${files}`);
  }
  console.log(
    `\nTo fix one: call its init in the boot sequence (see connector_evidence in\n` +
      `src/mastra/index.ts), or exercise the feature once in this environment.\n` +
      `Missing here is only a problem if the table EXISTS in the other environment —\n` +
      `a table no environment has yet is simply a feature nobody has used.\n`,
  );

  if (STRICT) process.exit(1);
}

main().catch((err) => {
  console.error(`\ncheck-lazy-tables failed: ${err.message}`);
  process.exit(1);
});
