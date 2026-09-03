#!/usr/bin/env node
/**
 * Dashboard HTML script-block syntax guardrail.
 * ----------------------------------------------------------------------------
 * Browser-served dashboard HTML files embed JavaScript inside <script> tags.
 * The TypeScript compiler doesn't see this code (it lives in `.html`), and
 * neither does any other check in CI. The 2026-05-28 outage proved how
 * expensive that gap is:
 *
 *   - Phase 3b shipped a comment containing backticks around `sdr_qa_checked`
 *     inside an HTML comment that was itself nested inside a JS template
 *     literal (the renderSelectedEvalContent render block).
 *   - The inner backticks prematurely closed the outer template literal,
 *     leaving `sdr_qa_checked` as a free-floating unbound identifier.
 *   - The browser's parser threw `Uncaught SyntaxError: Unexpected identifier
 *     'sdr_qa_checked' (at calls:6885)`. The ENTIRE <script> block failed to
 *     parse, so refreshData() never ran, the loading spinner never cleared,
 *     and even the Promise.allSettled defensive fix from the previous commit
 *     was never loaded into the browser.
 *
 * This script closes that gap. It parses every <script> tag in every
 * dashboard/*.html file with acorn. Syntax errors fail the commit / CI run.
 *
 * Limitations:
 *   - acorn is a vanilla ES parser; it does NOT execute the code, so a
 *     runtime ReferenceError (e.g. `foo()` where `foo` isn't defined) won't
 *     be caught. That's a separate problem solved by smoke tests.
 *   - <script type="module"> blocks are parsed as ES modules.
 *   - <script> blocks without a `type` are parsed as classic scripts.
 *   - Tags without a body (e.g. `<script src="..."></script>`) are skipped.
 *
 * Exit codes:
 *   0 = all script blocks parsed cleanly
 *   1 = at least one file had a syntax error (details printed)
 *   2 = guardrail itself failed (couldn't read a file, etc.)
 * ----------------------------------------------------------------------------
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse } from "acorn";

const ROOT = resolve(process.cwd());
const DASHBOARD_DIR = resolve(ROOT, "dashboard");
let exitCode = 0;
let filesScanned = 0;
let scriptsScanned = 0;
let failures = 0;

function listHtmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listHtmlFiles(full));
    } else if (entry.endsWith(".html")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Walk the file finding each <script> tag and yielding
 * { type, body, startOffset } so we can compute line:col offsets
 * relative to the original file when an error fires.
 *
 * Critical: after yielding a block, the iterator advances PAST the
 * closing </script>. Without this, an opening <script> tag appearing
 * inside the previous block's template literal (e.g. infographic.html
 * builds an HTML document with `<script>...</script>` text inside a
 * template literal) would be re-matched as a new opening tag, and we'd
 * try to parse a partial fragment of JS — false-positive parse error.
 */
function* extractScriptBlocks(source) {
  // [^<]* would be wrong because script bodies legitimately contain `<`
  // characters in template literals — per HTML spec only the literal
  // closing </script> ends a block, so we use indexOf for the close.
  const openRe = /<script\b([^>]*)>/gi;
  let searchFrom = 0;
  for (;;) {
    openRe.lastIndex = searchFrom;
    const m = openRe.exec(source);
    if (!m) break;
    const attrs = m[1] || "";
    const openEnd = m.index + m[0].length;
    const closeIdx = source.indexOf("</script>", openEnd);
    if (closeIdx === -1) break;
    const closeEnd = closeIdx + "</script>".length;
    // Advance past the closing tag for the next iteration so nested
    // `<script>` text in template literals is never re-matched.
    searchFrom = closeEnd;

    const body = source.slice(openEnd, closeIdx);
    // Skip empty bodies (e.g. external src).
    if (!body.trim()) continue;
    // Skip non-JS script types — application/json, importmap, etc.
    const typeMatch = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    const type = typeMatch ? typeMatch[1].toLowerCase() : "";
    if (type && type !== "module" && type !== "text/javascript" && type !== "application/javascript") {
      continue;
    }
    yield { type, body, startOffset: openEnd };
  }
}

/**
 * Translate a character offset back into a 1-indexed line:col so the error
 * report points at the right place in the original .html file.
 */
function offsetToLineCol(source, offset) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

if (!statSync(DASHBOARD_DIR, { throwIfNoEntry: false })?.isDirectory?.()) {
  console.error(`✗ check-dashboard-html-js: ${DASHBOARD_DIR} is not a directory`);
  process.exit(2);
}

for (const file of listHtmlFiles(DASHBOARD_DIR)) {
  filesScanned++;
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`✗ check-dashboard-html-js: cannot read ${file}: ${err.message}`);
    exitCode = 2;
    continue;
  }

  for (const block of extractScriptBlocks(source)) {
    scriptsScanned++;
    try {
      parse(block.body, {
        ecmaVersion: "latest",
        sourceType: block.type === "module" ? "module" : "script",
        allowReturnOutsideFunction: true, // tolerant — some inline blocks use bare return
        allowHashBang: true,
        locations: true,
      });
    } catch (parseErr) {
      // acorn errors give { message, loc: { line, column }, pos }.
      // Translate the block-relative position back into the original file.
      const blockPos = parseErr.pos ?? 0;
      const fileOffset = block.startOffset + blockPos;
      const { line, col } = offsetToLineCol(source, fileOffset);
      const relFile = file.replace(ROOT + "\\", "").replace(ROOT + "/", "");
      console.error(
        `✗ ${relFile}:${line}:${col} — ${parseErr.message.replace(/\s*\(\d+:\d+\)\s*$/, "")}`,
      );
      // Print the offending line so the operator sees context without
      // having to open the file. Keep to the line itself; multi-line
      // template literal context is too noisy.
      const lines = source.split(/\r?\n/);
      const offending = lines[line - 1] ?? "";
      console.error(`    > ${offending.trim().slice(0, 200)}`);
      failures++;
      exitCode = 1;
    }
  }
}

// Standalone dashboard JS files (dashboard/js/*.js). These are served verbatim
// to the browser, so a syntax error breaks the page exactly like a bad inline
// <script> block — and the 2026-06-26 perf refactor moved ~700KB of Duplicate
// Radar JS out of duplicates.html into js/duplicates-app.js, so without this it
// would lose all syntax coverage. Parse each whole file as a classic script.
function listJsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // js dir absent → nothing to scan
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isFile() && entry.endsWith(".js")) out.push(full);
  }
  return out;
}

for (const file of listJsFiles(resolve(DASHBOARD_DIR, "js"))) {
  filesScanned++;
  scriptsScanned++;
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`✗ check-dashboard-html-js: cannot read ${file}: ${err.message}`);
    exitCode = 2;
    continue;
  }
  try {
    parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowHashBang: true,
      locations: true,
    });
  } catch (parseErr) {
    const { line, col } = offsetToLineCol(source, parseErr.pos ?? 0);
    const relFile = file.replace(ROOT + "\\", "").replace(ROOT + "/", "");
    console.error(
      `✗ ${relFile}:${line}:${col} — ${parseErr.message.replace(/\s*\(\d+:\d+\)\s*$/, "")}`,
    );
    const offending = source.split(/\r?\n/)[line - 1] ?? "";
    console.error(`    > ${offending.trim().slice(0, 200)}`);
    failures++;
    exitCode = 1;
  }
}

if (failures > 0) {
  console.error("");
  console.error(
    `✗ check-dashboard-html-js: ${failures} script block(s) failed to parse across ${filesScanned} file(s).`,
  );
  console.error(
    `   Fix the syntax error(s) above. Most common cause: backticks (\`) inside an HTML comment that's nested in a JS template literal — use single quotes instead.`,
  );
  process.exit(exitCode);
}

console.log(
  `✓ check-dashboard-html-js: ${scriptsScanned} script block(s) across ${filesScanned} file(s) parsed cleanly.`,
);
