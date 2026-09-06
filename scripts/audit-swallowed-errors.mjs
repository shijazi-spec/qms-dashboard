#!/usr/bin/env node
/**
 * Inventory errors the code throws away, ranked by what the guarded operation
 * actually does.
 *
 * REPORT ONLY — never fails the build. An empty catch is not automatically a
 * defect: cleanup, fire-and-forget telemetry and localStorage guards are
 * legitimately silent, and blanket-fixing them would be worse than leaving
 * them. What this exists to surface is the pattern that keeps biting this
 * platform:
 *
 *     the operation FAILED, the caller was told it SUCCEEDED,
 *     and nothing was written down.
 *
 * Real instances found so far: "Mark all read" writing to a shadowed handler
 * and reporting success; eighteen days of audit history lost because logEvent
 * swallowed its own failure; DELETE /api/consultant/threads/:id returning
 * { ok: true } after a failed delete, so the chat reappeared on next load.
 *
 * Ranking is a heuristic on the guarded body, so triage the output — it is a
 * reviewer's worklist, not a verdict. Expect false positives (a comment
 * mentioning "verify", a toast string containing "POST").
 *
 * Run: node scripts/audit-swallowed-errors.mjs
 *      node scripts/audit-swallowed-errors.mjs --all   (also list MEDIUM/LOW)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOW_ALL = process.argv.includes("--all");

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".mastra",
  "dist",
  "coverage",
  // A sanitized COPY of the codebase produced for the GRC review — auditing it
  // double-counts every finding in src/.
  "exports",
]);

function walk(dir, exts) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((x) => e.endsWith(x))) out.push(full);
  }
  return out;
}

/** `catch {}` / `catch (e) {}` / a body that is only comments. */
const EMPTY_CATCH = /catch\s*(?:\(([^)]*)\))?\s*\{\s*(?:\/\/[^\n]*\s*)*\}/g;
/** `.catch(() => {})` / `.catch(function (e) {})` */
const DROPPED_PROMISE =
  /\.catch\(\s*(?:\(\s*[a-zA-Z_$]*\s*\)|function\s*\([^)]*\))\s*=>?\s*\{\s*(?:\/\/[^\n]*\s*)*\}\s*\)/g;

// Ordered: first match wins.
const HIGH = [
  [/\bINSERT\s+INTO\b/i, "write: INSERT"],
  [/\bUPDATE\s+\w+\s+SET\b/i, "write: UPDATE"],
  [/\bDELETE\s+FROM\b/i, "write: DELETE"],
  [/method:\s*['"]POST['"]/i, "write: POST request"],
  [/method:\s*['"](PUT|PATCH|DELETE)['"]/i, "write: mutating request"],
  [/\b(requireRole|requirePermission|requireAdmin|canAccessRoute)\b/, "auth check"],
  [/\b(logEvent|auditLog|recordResolutionLedgerEntry)\b/, "audit / ledger write"],
  [/\b(createNotification|notifyEvent)\b/, "notification write"],
  [/\bCOMMIT\b|\bROLLBACK\b/i, "transaction control"],
];
const LOW = [
  [/localStorage|sessionStorage/, "browser storage guard"],
  [
    /clearInterval|clearTimeout|removeEventListener|disconnect\(\)|\.close\(\)|\.end\(\)/,
    "cleanup / teardown",
  ],
  [/JSON\.parse/, "optional parse with fallback"],
  [/console\.(warn|error|log)/, "logging only"],
  [
    /getBoundingClientRect|scrollIntoView|matchMedia|requestAnimationFrame/,
    "DOM measurement",
  ],
];

const results = { HIGH: [], MEDIUM: [], LOW: [] };

function classify(file, text, index, kind) {
  const before = text.slice(Math.max(0, index - 1500), index);
  const tryIdx = before.lastIndexOf("try");
  const body = tryIdx >= 0 ? before.slice(tryIdx) : before.slice(-600);
  const rec = {
    file: relative(ROOT, file).replace(/\\/g, "/"),
    line: text.slice(0, index).split("\n").length,
    kind,
  };
  for (const [re, why] of HIGH)
    if (re.test(body)) return results.HIGH.push({ ...rec, why });
  for (const [re, why] of LOW)
    if (re.test(body)) return results.LOW.push({ ...rec, why });
  results.MEDIUM.push({ ...rec, why: "unclassified" });
}

for (const f of [
  ...walk(join(ROOT, "src"), [".ts"]),
  ...walk(join(ROOT, "dashboard"), [".js", ".html"]),
]) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(EMPTY_CATCH)) classify(f, text, m.index, "empty catch");
  for (const m of text.matchAll(DROPPED_PROMISE))
    classify(f, text, m.index, "dropped promise");
}

const total = results.HIGH.length + results.MEDIUM.length + results.LOW.length;
console.log(`audit-swallowed-errors: ${total} site(s) where an error is discarded\n`);
console.log(`  HIGH   ${results.HIGH.length}\tguards a write, an auth check or an audit record`);
console.log(`  MEDIUM ${results.MEDIUM.length}\tunclassified — needs a human`);
console.log(`  LOW    ${results.LOW.length}\tcleanup / telemetry / storage guards\n`);

console.log("=== HIGH ===");
for (const r of results.HIGH) console.log(`  ${r.file}:${r.line}  [${r.why}] (${r.kind})`);

if (SHOW_ALL) {
  for (const bucket of ["MEDIUM", "LOW"]) {
    console.log(`\n=== ${bucket} ===`);
    for (const r of results[bucket])
      console.log(`  ${r.file}:${r.line}  [${r.why}] (${r.kind})`);
  }
} else {
  console.log(`\n(${results.MEDIUM.length} MEDIUM and ${results.LOW.length} LOW hidden — pass --all)`);
}

// Report-only, by design.
process.exit(0);
