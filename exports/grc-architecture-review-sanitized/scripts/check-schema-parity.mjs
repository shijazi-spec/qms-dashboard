#!/usr/bin/env node
/**
 * Schema canonical-source parity guardrail.
 * ----------------------------------------------------------------------------
 * Every time we ship a new column via a runtime `ALTER TABLE ... ADD COLUMN
 * IF NOT EXISTS` (e.g. ensureAudioBlobColumns, the linked_via add on first
 * boot) but forget to add the same column to the canonical `CREATE TABLE`
 * statement, we create a silent timebomb:
 *
 *   - Production DB picks up the column via the runtime ALTER (works fine).
 *   - HostingPlatform's deploy-time schema-diff tool reads the canonical CREATE TABLE,
 *     compares it against production, sees the "orphan" columns the code
 *     doesn't declare, and proposes to DROP them.
 *   - Operator approves the deploy without spotting the warning → BYTEA blobs
 *     evaporate, audio playback dies, the duration-backfill button breaks.
 *
 * That's exactly what almost happened on 2026-05-28. HostingPlatform proposed to drop
 * audio_blob / audio_blob_mime / audio_blob_size with "208 items" — a single
 * approval click away from permanent data loss on every recording in prod.
 *
 * This script walks every `ALTER TABLE <name> ADD COLUMN IF NOT EXISTS <col>`
 * statement in src/utils/ and confirms the column is also declared in the
 * matching `CREATE TABLE IF NOT EXISTS <name> (...)` block in the same file
 * (or the file that owns the table). Drift fails CI / pre-commit.
 *
 * Limitations:
 *   - Only inspects src/utils/* and src/mastra/* (the two homes of table
 *     definitions in this codebase). Adjust SOURCE_DIRS if a new module
 *     starts owning DDL.
 *   - Column-name match is case-sensitive (Postgres is case-insensitive by
 *     default, but our codebase only uses lower_snake_case).
 *
 * Operating modes:
 *
 *   - Default (warning mode): prints the drift list, exits 0 so existing
 *     debt doesn't block every commit. Each line is still a real risk
 *     and should be cleaned up incrementally.
 *
 *   - STRICT=1 env: hard gate. Exits 1 on any drift. Use this in CI's
 *     post-cleanup steady state — once the 75 historical instances of
 *     drift have been resolved, flip the workflow to STRICT=1 so no NEW
 *     drift can land.
 *
 *   - --check-table=<name> flag: scope to one table. Useful while
 *     incrementally cleaning up: a developer can run the script with
 *     `--check-table=call_records` to confirm THEIR table is clean
 *     while ignoring the rest of the historical debt.
 *
 * Exit codes:
 *   0 = no drift, OR drift present but running in warning mode
 *   1 = drift detected AND STRICT=1
 *   2 = guardrail itself failed (couldn't read a file, etc.)
 * ----------------------------------------------------------------------------
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(process.cwd());
const SOURCE_DIRS = [resolve(ROOT, "src/utils"), resolve(ROOT, "src/mastra")];
const STRICT = process.env.STRICT === "1" || process.argv.includes("--strict");
const TABLE_FILTER = (() => {
  const arg = process.argv.find((a) => a.startsWith("--check-table="));
  return arg ? arg.slice("--check-table=".length) : null;
})();

function listSourceFiles(dir) {
  const out = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (entry === "node_modules" || entry === "__tests__") continue;
        out.push(...listSourceFiles(full));
      } else if (/\.(ts|js|mjs|cjs)$/.test(entry)) {
        out.push(full);
      }
    }
  } catch {
    // skip missing dirs silently
  }
  return out;
}

// Collect every CREATE TABLE IF NOT EXISTS <name> (...) block in a file.
// Returns Map<tableName, Set<columnName>>.
function collectCreateTableColumns(source) {
  const tables = new Map();
  // Find the opening of each CREATE TABLE, then scan forward with a paren-depth
  // counter, SKIPPING `--` line comments. A naive /\(([\s\S]*?)\);/ capture
  // truncates the body at the first ");" — which a comment like
  // "-- 'dismissed' = ... (false positive);" produces, silently hiding every
  // column declared after it (that false-flagged stale_deal_dismissals.disposition).
  const startRe = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
  let m;
  while ((m = startRe.exec(source)) !== null) {
    const tableName = m[1];
    let i = startRe.lastIndex; // first char after the opening paren
    let depth = 1;
    let body = "";
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "-" && source[i + 1] === "-") {
        const nl = source.indexOf("\n", i);
        i = nl === -1 ? source.length : nl; // skip the comment, keep the newline
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) { i++; break; }
      }
      body += ch;
      i++;
    }
    startRe.lastIndex = i; // continue scanning after this table
    if (depth !== 0) continue; // unbalanced / malformed — skip rather than guess
    const columns = new Set();
    // Each column is the first identifier on a line (or after a comma).
    // Strip line comments first so a -- comment in the body doesn't trip us.
    const stripped = body.replace(/--[^\n]*/g, "");
    for (const line of stripped.split(/[\n,]/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Skip constraint / index lines (PRIMARY KEY, FOREIGN KEY, CHECK, etc).
      if (/^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(trimmed)) {
        continue;
      }
      const colMatch = /^([a-z_][a-z0-9_]*)\s/i.exec(trimmed);
      if (colMatch) {
        columns.add(colMatch[1].toLowerCase());
      }
    }
    // Merge if the same table is declared in multiple files — column set
    // is the union.
    const prior = tables.get(tableName);
    if (prior) {
      for (const c of columns) prior.add(c);
    } else {
      tables.set(tableName, columns);
    }
  }
  return tables;
}

// Collect every ALTER TABLE <name> ADD COLUMN IF NOT EXISTS <col>.
// Returns Array<{ table, column, file, line }>.
function collectAlterTableAdds(source, file) {
  const adds = [];
  const alterRe = /ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  while ((m = alterRe.exec(source)) !== null) {
    const table = m[1];
    const column = m[2].toLowerCase();
    // Translate index to line number.
    const before = source.slice(0, m.index);
    const line = (before.match(/\n/g) || []).length + 1;
    adds.push({ table, column, file, line });
  }
  return adds;
}

const allTables = new Map(); // tableName -> Set<column>
const allAdds = [];

const sources = [];
for (const dir of SOURCE_DIRS) {
  sources.push(...listSourceFiles(dir));
}

for (const file of sources) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`✗ check-schema-parity: cannot read ${file}: ${err.message}`);
    process.exit(2);
  }
  const createTables = collectCreateTableColumns(content);
  for (const [name, cols] of createTables) {
    const prior = allTables.get(name);
    if (prior) {
      for (const c of cols) prior.add(c);
    } else {
      allTables.set(name, cols);
    }
  }
  allAdds.push(...collectAlterTableAdds(content, file));
}

let drift = 0;
const driftReporter = STRICT ? console.error : console.warn;
const driftMark = STRICT ? "✗" : "⚠";
for (const add of allAdds) {
  if (TABLE_FILTER && add.table !== TABLE_FILTER) continue;
  const declared = allTables.get(add.table);
  if (!declared) {
    // Table itself has no CREATE TABLE on record — that's a separate
    // concern (probably defined in another module we don't scan), don't
    // flag it here. The hard case we care about is "table declared,
    // column missing from declaration."
    continue;
  }
  if (!declared.has(add.column)) {
    drift++;
    const rel = add.file.replace(ROOT + "\\", "").replace(ROOT + "/", "");
    driftReporter(
      `${driftMark} ${rel}:${add.line} — runtime ALTER adds ${add.table}.${add.column} but it's missing from the canonical CREATE TABLE`,
    );
  }
}

if (drift > 0) {
  driftReporter("");
  driftReporter(
    `${driftMark} check-schema-parity: ${drift} column(s) declared only by runtime ALTER, not by CREATE TABLE.`,
  );
  driftReporter(
    `   Add the missing column(s) to the matching CREATE TABLE IF NOT EXISTS block.`,
  );
  driftReporter(
    `   Why this matters: HostingPlatform's deploy-time schema-diff tool reads only`,
  );
  driftReporter(
    `   the CREATE TABLE — drift here surfaces as proposed DROP COLUMN`,
  );
  driftReporter(
    `   migrations against production, which on approval would delete data.`,
  );
  if (STRICT) {
    process.exit(1);
  } else {
    driftReporter(
      `   (warning mode — set STRICT=1 to fail the run on drift; ${TABLE_FILTER ? `scoped to table '${TABLE_FILTER}'` : "use --check-table=<name> to scope to one table"})`,
    );
    process.exit(0);
  }
}

console.log(
  `✓ check-schema-parity: ${allAdds.length} ALTER TABLE ADD COLUMN call(s) checked across ${allTables.size} table(s); no drift${TABLE_FILTER ? ` for table '${TABLE_FILTER}'` : ""}.`,
);
