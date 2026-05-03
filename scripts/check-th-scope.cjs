#!/usr/bin/env node
/**
 * WalaPlus dashboard — table header `scope` accessibility guardrail
 * (Task #757, hardening Task #46 / Task #263).
 *
 * Screen readers (NVDA, JAWS, VoiceOver, TalkBack) rely on the
 * `<th scope="col|row|colgroup|rowgroup">` attribute to know which header
 * announces which cell when a user navigates a table. Without `scope`,
 * the assistive-tech heuristic falls back to "first row / first column"
 * which silently mis-associates headers in any table that has a corner
 * spacer cell, multiple header rows, or row-headers — exactly the layouts
 * the dashboard uses on the `crm`, `duplicates`, `ai-ops`, and
 * `tablef` pages. Task #46 / #263 added `scope` by hand to every existing
 * `<th>`; this guard is the regression net so a new column added without
 * `scope` fails CI before it reaches users.
 *
 * Two passes
 * ----------
 *   1. **HTML pass** — tokenises every `dashboard/*.html` page (the same
 *      tokeniser shape used by `scripts/check-rtl-classes.cjs`) and flags
 *      any `<th …>` opening tag whose attributes do not contain
 *      `scope="col" | "row" | "colgroup" | "rowgroup"`. `<thead>` /
 *      `<th-` custom elements are NOT matched (the regex requires a
 *      whitespace or `>` boundary after `th`).
 *
 *   2. **JS-string pass** — the dashboard renders many tables from JS
 *      template strings inside `<script>` blocks (e.g. `crm.html`,
 *      `duplicates.html`, `ai-ops.html`). The HTML pass intentionally
 *      skips `<script>` bodies, so without a second pass a `<th>`
 *      smuggled into a JS template string would never be checked. The
 *      JS pass scans the body of every inline JS `<script>` block for
 *      the same `<th[\s>]` opening pattern in any string-literal /
 *      template-literal context and applies the same `scope` rule.
 *
 * Per-file allowlists
 * -------------------
 * Both passes accept a per-file allowlist (empty today — every current
 * file is clean per Task #263). New dashboard HTML files (or any file
 * removed from an allowlist) are subject to the full rule.
 *
 * Per-line opt-out
 * ----------------
 * The very rare case where a `<th>` legitimately must NOT carry a `scope`
 * attribute (e.g. a presentational header in a non-data table) can opt
 * out by appending the marker `th-scope-safe: <reason>` on the same line
 * (HTML comment or JS comment). The scanner skips that line.
 *
 * Exit codes
 * ----------
 *   0 — no violations
 *   1 — at least one `<th>` is missing `scope`
 *   2 — script error (couldn't read a file, etc.)
 *
 * Run:  node scripts/check-th-scope.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIR = path.join(ROOT, "dashboard");

const OPT_OUT_MARKER = "th-scope-safe";
const VALID_SCOPES = new Set(["col", "row", "colgroup", "rowgroup"]);

/**
 * Per-file allowlist. Files listed here are exempt from the rule (e.g.
 * because they ship pre-existing violations that are tracked separately).
 * Empty today — Task #46 / #263 finished migrating every dashboard page.
 * Adding a new dashboard HTML file does NOT add it here automatically:
 * the new file must use `<th scope="…">` from the start.
 */
const HTML_ALLOWLIST = new Set([]);
const JS_ALLOWLIST = new Set([]);

// Match `<th` followed by a whitespace or `>` boundary so `<thead>` and
// any custom `<th-something>` element are NOT matched. Capture the full
// opening tag up to the first unescaped `>` so we can inspect its
// attributes. The regex is run with /g and lastIndex management.
const TH_OPEN_RE = /<th(?=[\s>\/])([^>]*)>/gi;

const SCOPE_ATTR_RE = /\sscope\s*=\s*("([^"]*)"|'([^']*)')/i;

const SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function isInlineJsScript(openTag) {
  // External scripts have a `src=` attribute — no inline body to scan.
  if (/\ssrc\s*=/i.test(openTag)) return false;
  // Non-JS script bodies (`type="application/json"`, `text/template`, …)
  // are not HTML-as-strings — skip them to avoid noisy false positives
  // on JSON blobs that happen to mention `<th>`.
  const typeMatch = openTag.match(/\stype\s*=\s*("([^"]*)"|'([^']*)')/i);
  if (typeMatch) {
    const t = (typeMatch[2] || typeMatch[3] || "").trim().toLowerCase();
    if (!t) return true;
    if (t === "module") return true;
    if (t === "text/javascript" || t === "application/javascript") return true;
    return false;
  }
  return true;
}

function listHtmlFiles() {
  if (!fs.existsSync(SCAN_DIR)) return [];
  return fs
    .readdirSync(SCAN_DIR)
    .filter((f) => f.endsWith(".html"))
    .map((f) => path.join(SCAN_DIR, f))
    .sort();
}

function lineColAt(src, offset) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

function lineTextAt(src, offset) {
  const lineStart = src.lastIndexOf("\n", offset - 1) + 1;
  let lineEnd = src.indexOf("\n", offset);
  if (lineEnd === -1) lineEnd = src.length;
  return src.slice(lineStart, lineEnd);
}

function thHasValidScope(openTagInner) {
  const m = openTagInner.match(SCOPE_ATTR_RE);
  if (!m) return false;
  const value = (m[2] || m[3] || "").trim().toLowerCase();
  return VALID_SCOPES.has(value);
}

function scanHtml(absPath) {
  const rel = path.relative(ROOT, absPath).split(path.sep).join("/");
  if (HTML_ALLOWLIST.has(rel)) return [];
  const html = fs.readFileSync(absPath, "utf8");
  const violations = [];

  // Mask `<script>…</script>` and `<style>…</style>` bodies with
  // whitespace (preserving offsets) so the HTML pass does not match
  // `<th` tokens that live in JS template strings or CSS selectors.
  // The JS-string pass below handles `<script>` bodies separately.
  const maskedHtml = maskScriptAndStyle(html);

  TH_OPEN_RE.lastIndex = 0;
  let m;
  while ((m = TH_OPEN_RE.exec(maskedHtml)) !== null) {
    const inner = m[1];
    if (thHasValidScope(inner)) continue;
    const offset = m.index;
    const lineText = lineTextAt(html, offset);
    if (lineText.includes(OPT_OUT_MARKER)) continue;
    const { line, col } = lineColAt(html, offset);
    violations.push({
      file: rel,
      line,
      col,
      ruleId: "thMissingScope",
      message:
        "<th> is missing the `scope` attribute (must be one of: col, row, colgroup, rowgroup).",
      snippet: lineText.trim().length > 200 ? lineText.trim().slice(0, 197) + "…" : lineText.trim(),
    });
  }

  return violations;
}

function maskScriptAndStyle(html) {
  return html.replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,
    (match) => {
      // Keep the opening and closing tags so offsets line up; replace
      // body characters with spaces (newlines preserved for line numbers).
      const openEnd = match.indexOf(">") + 1;
      const closeStart = match.lastIndexOf("<");
      const open = match.slice(0, openEnd);
      const close = match.slice(closeStart);
      const body = match.slice(openEnd, closeStart);
      const blanked = body.replace(/[^\n]/g, " ");
      return open + blanked + close;
    },
  );
}

function scanScripts(absPath) {
  const rel = path.relative(ROOT, absPath).split(path.sep).join("/");
  if (JS_ALLOWLIST.has(rel)) return [];
  const html = fs.readFileSync(absPath, "utf8");
  const violations = [];

  let blockMatch;
  SCRIPT_BLOCK_RE.lastIndex = 0;
  while ((blockMatch = SCRIPT_BLOCK_RE.exec(html)) !== null) {
    const openAttrs = blockMatch[1] || "";
    if (!isInlineJsScript("<script" + openAttrs + ">")) continue;
    const body = blockMatch[2] || "";
    const bodyOffset = blockMatch.index + blockMatch[0].indexOf(">") + 1;

    TH_OPEN_RE.lastIndex = 0;
    let m;
    while ((m = TH_OPEN_RE.exec(body)) !== null) {
      const inner = m[1];
      if (thHasValidScope(inner)) continue;
      const absOffset = bodyOffset + m.index;
      const lineText = lineTextAt(html, absOffset);
      if (lineText.includes(OPT_OUT_MARKER)) continue;
      const { line, col } = lineColAt(html, absOffset);
      violations.push({
        file: rel,
        line,
        col,
        ruleId: "thMissingScopeInJsString",
        message:
          "<th> rendered from a <script> template string is missing `scope` (must be one of: col, row, colgroup, rowgroup).",
        snippet: lineText.trim().length > 200 ? lineText.trim().slice(0, 197) + "…" : lineText.trim(),
      });
    }
  }

  return violations;
}

function main() {
  const files = listHtmlFiles();
  if (files.length === 0) {
    console.log("✓ <th scope> guardrail: no dashboard HTML files to scan.");
    process.exit(0);
  }

  const all = [];
  for (const f of files) {
    try {
      all.push(...scanHtml(f));
      all.push(...scanScripts(f));
    } catch (err) {
      console.error(
        `✗ Failed to scan ${path.relative(ROOT, f)}: ${err && err.message ? err.message : err}`,
      );
      process.exit(2);
    }
  }

  if (all.length === 0) {
    console.log(
      `✓ <th scope> accessibility guardrail PASS — scanned ${files.length} dashboard HTML file(s) (HTML tags + JS template strings inside <script> bodies); every <th> carries a valid scope attribute.`,
    );
    process.exit(0);
  }

  console.error("");
  console.error(`✗ <th scope> accessibility guardrail FAIL — ${all.length} violation(s):`);
  console.error("");
  for (const v of all) {
    console.error(`  ${v.file}:${v.line}:${v.col}  [${v.ruleId}]  ${v.message}`);
    console.error(`      → ${v.snippet.replace(/\s+/g, " ").trim()}`);
  }
  console.error("");
  console.error("Why this matters:");
  console.error("  Screen readers rely on <th scope=\"col|row\"> to announce which header");
  console.error("  applies to which cell. Without scope, NVDA / JAWS / VoiceOver / TalkBack");
  console.error("  fall back to a positional heuristic that silently mis-associates headers");
  console.error("  in any table that has a corner cell, multiple header rows, or row");
  console.error("  headers — making the table unusable for assistive-tech users.");
  console.error("");
  console.error("Fix recipe:");
  console.error("  • Column header (most tables): <th scope=\"col\">…</th>");
  console.error("  • Row header (first cell of each row): <th scope=\"row\">…</th>");
  console.error("  • Header that spans a column group: <th scope=\"colgroup\">…</th>");
  console.error("  • Header that spans a row group:    <th scope=\"rowgroup\">…</th>");
  console.error("");
  console.error(
    `If a particular <th> truly must not carry scope (rare — presentational header in a`,
  );
  console.error(
    `non-data table), add a trailing comment on the same line containing`,
  );
  console.error(`\`${OPT_OUT_MARKER}: <reason>\` and the scanner will skip that line.`);
  process.exit(1);
}

main();
