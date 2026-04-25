#!/usr/bin/env node
/**
 * WalaPlus dashboard — RTL physical-direction class guardrail (Task #315).
 *
 * The dashboard supports Arabic (RTL) via `html[dir="rtl"]` set by
 * `dashboard/js/i18n.js`. Per the "RTL Layout Convention" section of
 * `replit.md`, layout details that should mirror in RTL must be expressed
 * with CSS logical-direction utilities (`text-start`, `border-s-4`, `ms-2`,
 * `me-2`, …) — NOT physical-direction Tailwind classes (`text-left`,
 * `text-right`, `border-l-4`, `border-r-4`, `ml-*`, `mr-*`, …). Physical
 * classes pin the layout to LTR and silently break the Arabic experience.
 *
 * This guard scans `dashboard/*.html` and fails (exit 1) when it spots any
 * of the three high-impact patterns developers most commonly reintroduce on
 * new pages:
 *
 *   1. `<th>` elements whose `class="…"` contains `text-left` or `text-right`
 *      → use `text-start` / `text-end` instead (table headers must mirror).
 *   2. Any element whose `class="…"` contains `border-l-4` or `border-r-4`
 *      → use `border-s-4` / `border-e-4` instead (stat-card accent borders
 *      must appear on the inline-start edge in both LTR and RTL).
 *   3. `<button>` elements whose `class="…"` contains `ml-<n>` or `mr-<n>`
 *      → use `ms-<n>` / `me-<n>` instead (icon gutters / button margins
 *      must flip with writing direction).
 *
 * The scan is HTML-tag aware (the same tokeniser used by
 * `scripts/check-handlers.cjs`): only attributes inside real opening tags
 * are inspected, so a JS string like `'border-l-4'` inside a `<script>`
 * block, or a `text-left` inside an inline `<style>` block, will never be
 * flagged.
 *
 * Allowlists
 * ----------
 * The pre-existing dashboard pages that already ship with these patterns
 * are listed in `ALLOWLISTS` below and grandfathered in. They are exempt
 * from the corresponding rule, so the guard can be enabled as a CI gate
 * today without first having to migrate every legacy page. New dashboard
 * HTML files (or removing a file from an allowlist) are subject to the
 * full rule and will fail CI immediately. Per-rule allowlisting also
 * means an existing page that, say, has legacy `<th text-left>` rows is
 * still blocked from picking up a new `border-l-4` accent card.
 *
 * Per-line opt-out
 * ----------------
 * If you have a genuinely direction-specific element that must NOT mirror
 * in RTL (extremely rare — almost always a sign of a bug), add a trailing
 * HTML comment containing `rtl-safe-physical: <reason>` to the same line
 * as the offending tag. The scanner will skip violations on those lines.
 *
 * Wiring
 * ------
 *   * Standalone:     node scripts/check-rtl-classes.cjs
 *   * CI gate:        wired into `scripts/post-merge.sh`.
 *   * Test suite:     `tests/noPhysicalDirectionClasses.test.ts` runs this
 *                     script in every `npm test` invocation.
 *
 * Exit codes:
 *   0  guardrail PASS
 *   1  guardrail FAIL — at least one violation
 *   2  internal error (unreadable file, etc.)
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIR = path.join(ROOT, "dashboard");

const OPT_OUT_MARKER = "rtl-safe-physical";

/**
 * Per-rule allowlist of dashboard HTML files (paths relative to the repo
 * root) that already contain the corresponding pattern. These are
 * grandfathered in so the guard can run green today; new files added to
 * `dashboard/` will NOT be allowlisted and must use logical-direction
 * utilities from the start. To migrate a file off an allowlist, replace
 * the physical classes with their logical equivalents and remove the
 * file from the relevant array below.
 */
const ALLOWLISTS = {
  thTextAlign: new Set([
    "dashboard/admin.html",
    "dashboard/ai-ops.html",
    "dashboard/calls.html",
    "dashboard/crm.html",
    "dashboard/duplicates.html",
    "dashboard/external-audits.html",
    "dashboard/grc.html",
    "dashboard/guide.html",
    "dashboard/index.html",
    "dashboard/intake.html",
    "dashboard/logs.html",
    "dashboard/migration.html",
    "dashboard/pdpl.html",
    "dashboard/policies.html",
    "dashboard/projects.html",
    "dashboard/qms.html",
    "dashboard/reviews.html",
    "dashboard/roi.html",
    "dashboard/tablef.html",
    "dashboard/team.html",
    "dashboard/users.html",
  ]),
  borderLR4: new Set([
    "dashboard/duplicates.html",
    "dashboard/external-audits.html",
    "dashboard/grc.html",
    "dashboard/guide.html",
    "dashboard/index.html",
    "dashboard/intake.html",
    "dashboard/migration.html",
    "dashboard/policies.html",
    "dashboard/projects.html",
    "dashboard/qms.html",
    "dashboard/scorecard.html",
    "dashboard/tablef.html",
  ]),
  buttonMlMr: new Set([
    "dashboard/ai-approvals.html",
    "dashboard/ai-ops.html",
    "dashboard/consultant.html",
    "dashboard/projects.html",
    "dashboard/reviews.html",
    "dashboard/roi.html",
    "dashboard/tablef.html",
    "dashboard/users.html",
  ]),
};

const TAG_OPEN_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\b/;
const CLASS_ATTR_RE = /\sclass\s*=\s*"([^"]*)"|\sclass\s*=\s*'([^']*)'/i;

const RULES = [
  {
    id: "thTextAlign",
    label: "uses physical text-left/text-right",
    appliesToTag: (tag) => tag === "th",
    classRegex: /\b(text-left|text-right)\b/,
    fix: "Use `text-start` / `text-end` (logical) so the column header mirrors in Arabic RTL.",
  },
  {
    id: "borderLR4",
    label: "uses physical border-l-4/border-r-4",
    appliesToTag: () => true,
    classRegex: /\b(border-l-4|border-r-4)\b/,
    fix: "Use `border-s-4` / `border-e-4` (logical) so the accent border appears on the correct edge in Arabic RTL.",
  },
  {
    id: "buttonMlMr",
    // Matches every Tailwind variant of ml-/mr-: numeric (`mr-2`, `ml-1.5`),
    // fractional (`mr-1/2`), keyword (`ml-px`, `ml-auto`, `mr-full`), and
    // arbitrary value (`ml-[3px]`).
    label: "uses physical ml-/mr- margin",
    appliesToTag: (tag) => tag === "button",
    // `\b`-anchoring fails after `]`, so use whitespace/start lookarounds that
    // line up with the way Tailwind tokens sit inside the class attribute.
    classRegex: /(?<=^|\s)(m[lr]-(?:[0-9]+(?:\.[0-9]+)?(?:\/[0-9]+)?|px|auto|full|reverse|\[[^\]]+\]))(?=\s|$)/,
    fix: "Use `ms-…` / `me-…` (logical) so the icon-gutter margin flips with writing direction.",
  },
];

function listHtmlFiles() {
  if (!fs.existsSync(SCAN_DIR)) return [];
  return fs
    .readdirSync(SCAN_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".html"))
    .map((e) => path.join(SCAN_DIR, e.name))
    .sort();
}

/**
 * Walk the HTML linearly and yield region tokens. Only `tag` regions are
 * inspected by the rule engine; `<script>` and `<style>` bodies are
 * fast-forwarded so JS / CSS that mentions a forbidden class string is
 * never flagged.
 */
function tokenize(html) {
  const tokens = [];
  let i = 0;
  const len = html.length;

  while (i < len) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      i = close === -1 ? len : close + 3;
      continue;
    }
    if (html.startsWith("<!", lt)) {
      const close = html.indexOf(">", lt + 2);
      i = close === -1 ? len : close + 1;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    const tagText = html.slice(lt, gt + 1);
    const m = tagText.match(TAG_OPEN_RE);
    if (!m) {
      i = gt + 1;
      continue;
    }
    const tagName = m[1].toLowerCase();
    const isClose = tagText.startsWith("</");

    if (!isClose) {
      tokens.push({ kind: "tag", start: lt, end: gt + 1, text: tagText, tagName });
    }

    // Skip <script> / <style> bodies entirely.
    if (
      (tagName === "script" || tagName === "style") &&
      !isClose &&
      !tagText.endsWith("/>")
    ) {
      const closeRe = new RegExp(`</${tagName}\\s*>`, "i");
      const rest = html.slice(gt + 1);
      const closeMatch = rest.match(closeRe);
      i = closeMatch ? gt + 1 + closeMatch.index + closeMatch[0].length : len;
      continue;
    }

    i = gt + 1;
  }
  return tokens;
}

function lineColAt(html, offset) {
  let line = 1;
  let lastNl = -1;
  for (let j = 0; j < offset && j < html.length; j++) {
    if (html.charCodeAt(j) === 10) {
      line++;
      lastNl = j;
    }
  }
  return { line, col: offset - lastNl };
}

/**
 * Returns the substring of `html` corresponding to the line containing
 * `offset` so we can check for the per-line `rtl-safe-physical` opt-out
 * marker.
 */
function lineTextAt(html, offset) {
  let start = offset;
  while (start > 0 && html.charCodeAt(start - 1) !== 10) start--;
  let end = offset;
  while (end < html.length && html.charCodeAt(end) !== 10) end++;
  return html.slice(start, end);
}

function extractClassValue(tagText) {
  const m = tagText.match(CLASS_ATTR_RE);
  if (!m) return null;
  return m[1] != null ? m[1] : m[2];
}

function scanFile(absPath) {
  const rel = path.relative(ROOT, absPath).split(path.sep).join("/");
  const html = fs.readFileSync(absPath, "utf8");
  const tokens = tokenize(html);
  const violations = [];

  for (const tok of tokens) {
    const classValue = extractClassValue(tok.text);
    if (!classValue) continue;
    for (const rule of RULES) {
      if (!rule.appliesToTag(tok.tagName)) continue;
      const allowlist = ALLOWLISTS[rule.id];
      if (allowlist && allowlist.has(rel)) continue;
      const m = classValue.match(rule.classRegex);
      if (!m) continue;
      const lineText = lineTextAt(html, tok.start);
      if (lineText.includes(OPT_OUT_MARKER)) continue;
      const { line, col } = lineColAt(html, tok.start);
      violations.push({
        file: rel,
        line,
        col,
        ruleId: rule.id,
        message: `<${tok.tagName}> ${rule.label} (\`${m[1]}\`).`,
        fix: rule.fix,
        snippet: tok.text.length > 200 ? tok.text.slice(0, 197) + "…" : tok.text,
      });
    }
  }

  return violations;
}

function main() {
  const files = listHtmlFiles();
  if (files.length === 0) {
    console.log("✓ RTL physical-direction guardrail: no dashboard HTML files to scan.");
    process.exit(0);
  }

  const allViolations = [];
  for (const f of files) {
    try {
      allViolations.push(...scanFile(f));
    } catch (err) {
      console.error(
        `✗ Failed to scan ${path.relative(ROOT, f)}: ${err && err.message ? err.message : err}`,
      );
      process.exit(2);
    }
  }

  if (allViolations.length === 0) {
    console.log(
      `✓ RTL physical-direction guardrail PASS — scanned ${files.length} dashboard HTML file(s); no forbidden physical-direction classes found on <th>, stat-card borders, or <button> margins.`,
    );
    process.exit(0);
  }

  console.error("");
  console.error(
    `✗ RTL physical-direction guardrail FAIL — ${allViolations.length} violation(s):`,
  );
  console.error("");
  for (const v of allViolations) {
    console.error(`  ${v.file}:${v.line}:${v.col}  [${v.ruleId}]  ${v.message}`);
    console.error(`      → ${v.snippet.replace(/\s+/g, " ").trim()}`);
    console.error(`      Fix: ${v.fix}`);
  }
  console.error("");
  console.error("Why this matters:");
  console.error("  Dashboard pages are served to both English (LTR) and Arabic (RTL)");
  console.error("  users. Physical-direction Tailwind classes (`text-left`, `border-l-4`,");
  console.error("  `ml-*`, …) pin the layout to LTR and silently break the Arabic");
  console.error("  experience. See replit.md → \"RTL Layout Convention\" for the full list");
  console.error("  of logical-direction equivalents.");
  console.error("");
  console.error("Fix recipe:");
  console.error("  • <th class=\"… text-left …\">     →  <th class=\"… text-start …\">");
  console.error("  • <div class=\"… border-l-4 …\">   →  <div class=\"… border-s-4 …\">");
  console.error("  • <button class=\"… mr-2 …\">       →  <button class=\"… me-2 …\">");
  console.error("");
  console.error(
    "If a specific element genuinely must NOT mirror in RTL (rare!), add a trailing",
  );
  console.error(
    `HTML comment on the same line containing \`${OPT_OUT_MARKER}: <reason>\` and the`,
  );
  console.error("scanner will skip that line.");
  process.exit(1);
}

main();
