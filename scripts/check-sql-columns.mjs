#!/usr/bin/env node
/**
 * Does every column a query NAMES actually exist in the declared schema?
 * ----------------------------------------------------------------------------
 * `check:schema-parity` answers a different question: when a column is added by
 * `ALTER TABLE ... ADD COLUMN`, is it also in the canonical `CREATE TABLE`? It
 * never asks whether a column a query references exists at all.
 *
 * That gap cost four bugs. `call_records.contact_phone` was queried in five
 * places and declared nowhere — the phone has always lived in `metadata` JSONB.
 * Three sweeps threw `column "contact_phone" does not exist` before reading a
 * single row, and an export cell read the same missing field in JavaScript and
 * rendered blank on every export ever produced. Someone diagnosed it correctly
 * in May 2026 and fixed ONE of the five; the others sat there, one of them 500
 * lines below the comment explaining the bug.
 *
 * WHAT IT CHECKS, and why it is deliberately narrow. A checker that invents
 * findings is worse than none — it costs exactly the attention it was built to
 * save, and the one real finding gets read with the same suspicion as the fake
 * ones. So this only reports what it can be confident about:
 *
 *   PASS A (default) — QUALIFIED references, `alias.column`, where the alias
 *   resolves to a declared table via FROM/JOIN/UPDATE. This is exact: the table
 *   is unambiguous, so a column that is not in it is a real finding. It is the
 *   shape the routes bug took (`cr.contact_phone`).
 *
 *   PASS B (--unqualified) — BARE identifiers, but ONLY in a query that touches
 *   exactly one declared table, has no CTE, and no `${}` interpolation. With
 *   one table there is nothing to disambiguate against. This is the shape the
 *   backfill bugs took. It is opt-in because bare identifiers collide with SQL
 *   keywords and function names, and that list can never be complete.
 *
 * WHAT IT SKIPS, on purpose:
 *   · any query containing `${}` — the text is incomplete, so any conclusion
 *     drawn from it is a guess;
 *   · tables it has no declaration for (a view, or a table owned elsewhere);
 *   · everything inside string literals, comments and `$n` parameters —
 *     `metadata->>'contact_phone'` names a JSON key, not a column, and reading
 *     it as one is how this kind of checker starts lying.
 *
 * REPORT ONLY by default. `--strict` exits 1. Not in `check:all` until a clean
 * run says it has earned a place there.
 *
 *   node scripts/check-sql-columns.mjs
 *   node scripts/check-sql-columns.mjs --unqualified
 *   node scripts/check-sql-columns.mjs --unqualified --strict
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);
const SRC = join(ROOT, "src");
const BASELINE_PATH = join(ROOT, "scripts", "sql-columns-baseline.json");
const UNQUALIFIED = process.argv.includes("--unqualified");
const STRICT = process.argv.includes("--strict");

/* ── source walking ───────────────────────────────────────────────────────── */

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
 * Strip comments before ANY analysis.
 *
 * Not optional. Four separate checkers in this repo have reported a phantom
 * finding by reading prose as code — most recently check-lazy-tables, which
 * announced a missing table called `and` after matching the sentence "The init
 * is CREATE TABLE IF NOT EXISTS and is already called...".
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/* ── the declared schema ──────────────────────────────────────────────────── */

/**
 * table → Set(columns), from every CREATE TABLE and ALTER TABLE ADD COLUMN.
 *
 * Column names are taken as the first identifier of each top-level line inside
 * the CREATE body. Table CONSTRAINT / PRIMARY KEY / UNIQUE / FOREIGN KEY lines
 * are not columns and are dropped, otherwise "PRIMARY" becomes a column and
 * every query mentioning it looks wrong.
 */
function buildSchema(files) {
  const schema = new Map();
  /**
   * Tables we have an actual CREATE for.
   *
   * ONLY these are checkable. An ALTER adds to a schema, it never defines one,
   * so a table known only from `ALTER TABLE x ADD COLUMN y` has a one-column
   * "schema" and every other column on it looks undeclared. That is exactly
   * what happened to quality_audit_results, which has no CREATE anywhere in
   * src/ and produced two confident, wrong findings on its second run.
   */
  const created = new Set();
  const add = (table, col) => {
    const t = table.toLowerCase();
    if (!schema.has(t)) schema.set(t, new Set());
    schema.get(t).add(col.toLowerCase());
  };

  const NON_COLUMN_LEADERS = new Set([
    "primary",
    "unique",
    "constraint",
    "foreign",
    "check",
    "exclude",
    "like",
  ]);

  for (const file of files) {
    const text = stripComments(readFileSync(file, "utf8"));

    // CREATE TABLE [IF NOT EXISTS] name ( ...body... )
    const createRe =
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s*\(/gi;
    let m;
    while ((m = createRe.exec(text))) {
      const table = m[1];
      created.add(table.toLowerCase());
      // Walk forward counting parens so a column like NUMERIC(10,2) or a CHECK
      // (...) does not end the body early.
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        i++;
      }
      // SQL line comments, stripped INSIDE the body only.
      //
      // stripComments() above removes JavaScript comments; a CREATE TABLE body
      // lives inside a template literal and comments there are `--`. Without
      // this, a comment containing a comma splits the body mid-sentence: the
      // next fragment begins with a prose word, which is recorded as a column,
      // and the REAL column after the comment is swallowed with it. That is how
      // kpi_values came back with `and`, `silently` and `windows` as columns
      // and without `actual_value` — which then reported six false findings
      // against a column that has always existed.
      //
      // Scoped to the body rather than the whole file because `--` is a
      // decrement operator in JavaScript.
      const body = text.slice(start, i - 1).replace(/--[^\n]*/g, " ");

      // Split on top-level commas only.
      let d = 0;
      let cur = "";
      const parts = [];
      for (const ch of body) {
        if (ch === "(") d++;
        if (ch === ")") d--;
        if (ch === "," && d === 0) {
          parts.push(cur);
          cur = "";
        } else cur += ch;
      }
      parts.push(cur);

      for (const part of parts) {
        const tokens = part.trim().split(/\s+/).filter(Boolean);
        // A column definition is always at least `name TYPE`. A lone word is
        // debris, not a column — cheap belt to the comment-stripping braces
        // above, since the failure mode here is silent: a bad column name
        // never errors, it just makes a real reference look undeclared.
        if (tokens.length < 2) continue;
        const bare = tokens[0].replace(/["`]/g, "");
        if (!/^[a-zA-Z_][\w]*$/.test(bare)) continue;
        if (NON_COLUMN_LEADERS.has(bare.toLowerCase())) continue;
        add(table, bare);
      }
    }

    // ALTER TABLE name ADD COLUMN [IF NOT EXISTS] col
    const alterRe =
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*)/gi;
    while ((m = alterRe.exec(text))) add(m[1], m[2]);

    // addColumnIfNotExists("table", "column", "TYPE")
    //
    // A THIRD way this codebase declares a column, and the one that produced
    // most of the second run's findings. auditDatabase alone adds 26 columns
    // this way — audits.audit_code, planned_start_date and the rest are all
    // real, declared columns that simply never appear as literal SQL.
    //
    // A checker that only understands the syntaxes it was told about will
    // confidently report the ones it was not.
    const helperRe =
      /addColumnIfNotExists\(\s*["'`]([a-zA-Z_][\w]*)["'`]\s*,\s*["'`]([a-zA-Z_][\w]*)["'`]/g;
    while ((m = helperRe.exec(text))) add(m[1], m[2]);
  }

  // Drop anything we never saw a CREATE for.
  for (const t of [...schema.keys()]) if (!created.has(t)) schema.delete(t);
  return schema;
}

/* ── SQL extraction ───────────────────────────────────────────────────────── */

/**
 * Template literals that look like SQL.
 *
 * `raw` is the ORIGINAL file text, `text` the comment-stripped copy. Line
 * numbers are computed against `raw`: stripping collapses every block comment
 * to a single space, so a line number from the stripped text drifts further
 * from the truth the deeper into the file it is. The first run pointed at
 * duplicateRadarDatabase.ts:11651 for a query that lives at 12519 — 868 lines
 * out, and pointing at a function signature. A finding you cannot locate is
 * barely a finding.
 */
function extractQueries(text, raw) {
  const out = [];
  const re = /`([^`]*)`/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[1];
    if (!/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(body)) continue;
    // Locate this exact query in the original text to get a usable line number.
    const anchor = body.slice(0, 60);
    const at = anchor.trim() ? raw.indexOf(anchor) : -1;
    const line =
      at >= 0
        ? raw.slice(0, at).split("\n").length
        : text.slice(0, m.index).split("\n").length;
    out.push({ sql: body, line, hasInterpolation: /\$\{/.test(body) });
  }
  return out;
}

/**
 * Remove everything that is not a column reference.
 *
 * String literals go first and matter most: `metadata->>'contact_phone'` names
 * a JSON key. Treating that as a column would report the very field this
 * checker was written to defend, which is the sort of irony that gets a gate
 * switched off.
 */
function sanitizeSql(sql) {
  return (
    sql
      // An identifier GLUED to an interpolation is not a column name — it is a
      // fragment of one. `total_${o.col}` left `total_` behind and the first
      // calibration run duly reported a missing column `duplicate_clusters
      // .total_`. Kill the whole token, both sides.
      .replace(/[a-zA-Z_]\w*\$\{[^}]*\}[\w]*/g, " ")
      .replace(/\$\{[^}]*\}[a-zA-Z_]\w*/g, " ")
      .replace(/\$\{[^}]*\}/g, " ")
      // NAMED FUNCTION ARGUMENTS: MAKE_INTERVAL(hours => $2). `hours` is a
      // parameter name, not a column. The first run reported
      // notifications.hours and notifications.days from my own dedup helper,
      // and enterprise_risks.days from riskDatabase.
      .replace(/\b[a-zA-Z_]\w*\s*=>/g, " ")
      .replace(/'(?:[^'\\]|\\.)*'/g, " '' ")
      .replace(/--[^\n]*/g, " ")
      .replace(/\$\d+/g, " ")
      .replace(/::[a-zA-Z_][\w]*(\[\])?/g, " ")
  );
}

/**
 * Aliases attached to a DERIVED table — `) alias` closing a subquery.
 *
 * These shadow real table aliases and must never be resolved to a table. In
 * duplicateResolutionRunner one query joins `duplicate_resolution_ledger lg`
 * inside a subquery and then closes that subquery as `) lg`. The outer
 * `lg.cluster_id` refers to the DERIVED table's select list, not to the ledger
 * — which has no cluster_id — so the checker reported a bug in a correct query.
 */
function derivedAliases(sql) {
  const out = new Set();
  const re = /\)\s*(?:AS\s+)?([a-zA-Z_][\w]*)/gi;
  let m;
  while ((m = re.exec(sql))) {
    const name = m[1].toLowerCase();
    if (!SQL_KEYWORDS.has(name)) out.add(name);
  }
  return out;
}

/** alias/table → table, from FROM / JOIN / UPDATE / INSERT INTO. */
function tableRefs(sql) {
  const map = new Map();
  const tables = new Set();
  const push = (table, alias) => {
    const t = table.toLowerCase();
    tables.add(t);
    map.set(t, t);
    if (alias) map.set(alias.toLowerCase(), t);
  };
  const re =
    /\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO)\s+([a-zA-Z_][\w]*)\s*(?:(?:AS\s+)?([a-zA-Z_][\w]*))?/gi;
  let m;
  while ((m = re.exec(sql))) {
    const kw = (m[2] || "").toUpperCase();
    // "FROM x WHERE" — WHERE is not an alias.
    const alias = SQL_KEYWORDS.has(kw.toLowerCase()) ? null : m[2];
    push(m[1], alias);
  }
  return { map, tables };
}

/** Names introduced by the query itself — never columns of the table. */
function queryAliases(sql) {
  const out = new Set();
  const asRe = /\bAS\s+([a-zA-Z_][\w]*)/gi;
  let m;
  while ((m = asRe.exec(sql))) out.add(m[1].toLowerCase());
  const withRe = /\bWITH\s+([a-zA-Z_][\w]*)/gi;
  while ((m = withRe.exec(sql))) out.add(m[1].toLowerCase());
  return out;
}

const SQL_KEYWORDS = new Set(
  (
    "select insert update delete from where and or not null is in exists between like ilike " +
    "join left right inner outer full cross on using group by order having limit offset " +
    "asc desc distinct as case when then else end union all except intersect with recursive " +
    "values into set returning conflict do nothing update_ constraint primary key unique foreign " +
    "references cascade default check true false count sum avg min max coalesce nullif greatest least " +
    "extract epoch interval now current_date current_timestamp date_trunc to_char to_timestamp cast " +
    "array unnest jsonb_build_object json_build_object jsonb_agg json_agg row_number rank dense_rank " +
    "over partition filter lateral string_agg concat lower upper trim substring position length " +
    "abs round floor ceil random generate_series make_interval age justify_interval " +
    "text integer int bigint boolean bool varchar char numeric decimal real double precision " +
    "timestamp timestamptz date time serial bigserial jsonb json bytea uuid " +
    "asc_ nulls first last only table column exists_ any some ilike_ similar escape " +
    "isnull notnull collate window rows range preceding following current row unbounded " +
    "add drop alter create index if replace view materialized temp temporary sequence " +
    "of_ for share nowait skip locked returning_ conflict_ excluded"
  ).split(/\s+/),
);

/* ── the check ────────────────────────────────────────────────────────────── */

function main() {
  const files = walk(SRC).filter(
    (f) => !f.includes(".test.") && !f.includes(".spec."),
  );
  const schema = buildSchema(files);

  /**
   * --debug-table <name>: print what the CREATE parser actually found.
   *
   * Added after the first calibration run reported kpi_values.actual_value as
   * undeclared six times over — while the column is plainly declared at
   * kpiDatabase.ts:179. Either the parser is missing columns or the finding is
   * real, and guessing between those two from the outside is how a checker
   * gets argued with instead of fixed. This makes it answer for itself.
   */
  const dbgIdx = process.argv.indexOf("--debug-table");
  if (dbgIdx >= 0 && process.argv[dbgIdx + 1]) {
    const t = process.argv[dbgIdx + 1].toLowerCase();
    const cols = schema.get(t);
    console.log(`\n--debug-table ${t}`);
    if (!cols) {
      console.log(
        `  NO CREATE TABLE parsed for "${t}". Every reference to it is skipped,\n` +
          `  so it cannot be the source of a finding — unless the finding names a\n` +
          `  different table than you expect.\n`,
      );
    } else {
      console.log(`  ${cols.size} column(s) parsed:`);
      console.log(`    ${[...cols].sort().join(", ")}\n`);
    }
    return;
  }

  let baseline = new Set();
  if (existsSync(BASELINE_PATH)) {
    try {
      baseline = new Set(JSON.parse(readFileSync(BASELINE_PATH, "utf8")));
    } catch {
      /* a malformed baseline must not silently pass everything */
    }
  }

  const findings = [];

  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const raw = readFileSync(file, "utf8");
    const text = stripComments(raw);
    for (const q of extractQueries(text, raw)) {
      const sql = sanitizeSql(q.sql);
      const { map, tables } = tableRefs(sql);
      if (tables.size === 0) continue;
      const aliases = queryAliases(sql);
      // Derived-table aliases shadow real ones; drop them from resolution
      // entirely rather than resolving them to the wrong table.
      for (const d of derivedAliases(sql)) map.delete(d);

      // ── Pass A: qualified references ────────────────────────────────────
      const qualRe = /\b([a-zA-Z_][\w]*)\.([a-zA-Z_][\w]*)\b/g;
      let m;
      while ((m = qualRe.exec(sql))) {
        const [, qual, col] = m;
        const table = map.get(qual.toLowerCase());
        if (!table) continue;
        const cols = schema.get(table);
        if (!cols) continue;
        if (cols.has(col.toLowerCase())) continue;
        if (aliases.has(col.toLowerCase())) continue;
        if (SQL_KEYWORDS.has(col.toLowerCase())) continue;
        const key = `${rel}:${table}.${col}`;
        if (baseline.has(key)) continue;
        findings.push({ key, rel, line: q.line, table, col, kind: "qualified" });
      }

      // ── Pass B: bare identifiers, single declared table only ────────────
      if (!UNQUALIFIED) continue;
      if (q.hasInterpolation) continue;
      if (tables.size !== 1) continue;
      if (/\bWITH\b/i.test(sql)) continue;
      const table = [...tables][0];
      const cols = schema.get(table);
      if (!cols) continue;

      const bareRe = /(?<![.\w])([a-zA-Z_][\w]*)(?![\w.(])/g;
      while ((m = bareRe.exec(sql))) {
        const id = m[1].toLowerCase();
        if (SQL_KEYWORDS.has(id)) continue;
        if (aliases.has(id)) continue;
        if (map.has(id)) continue;
        if (cols.has(id)) continue;
        const key = `${rel}:${table}.${id}`;
        if (baseline.has(key)) continue;
        findings.push({
          key,
          rel,
          line: q.line,
          table,
          col: id,
          kind: "bare",
        });
      }
    }
  }

  // De-duplicate: the same missing column in the same file is one problem.
  const seen = new Set();
  const unique = findings.filter((f) =>
    seen.has(f.key) ? false : (seen.add(f.key), true),
  );

  console.log(
    `\ncheck-sql-columns: ${schema.size} table(s) declared in src/. ` +
      `Pass B (bare identifiers) ${UNQUALIFIED ? "ON" : "off — add --unqualified"}.\n`,
  );

  if (unique.length === 0) {
    console.log("✓ Every column reference resolves to a declared column.\n");
    return;
  }

  console.log(`${unique.length} reference(s) name a column that is not declared:\n`);
  for (const f of unique) {
    console.log(`  ${f.table}.${f.col}   (${f.kind})\n      ${f.rel}:~${f.line}`);
  }
  console.log(
    `\nEach is one of three things:\n` +
      `  · a real bug — the query throws, or reads a field that is always null;\n` +
      `  · a column on a table this checker has no CREATE for (a view, or one\n` +
      `    owned outside src/) — add the key to scripts/sql-columns-baseline.json;\n` +
      `  · a checker limitation — same fix, and tell me so the parser improves.\n`,
  );

  if (STRICT) process.exit(1);
}

main();
