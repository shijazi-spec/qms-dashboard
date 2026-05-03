#!/usr/bin/env node
/**
 * WalaPlus dashboard — RTL physical-direction class guardrail
 * (Tasks #315 / #628).
 *
 * The dashboard supports Arabic (RTL) via `html[dir="rtl"]` set by
 * `dashboard/js/i18n.js`. Per the "RTL Layout Convention" section of
 * `replit.md`, layout details that should mirror in RTL must be expressed
 * with CSS logical-direction utilities (`text-start`, `border-s-4`, `ms-2`,
 * `me-2`, `rounded-s-lg`, `gap-2`, …) — NOT physical-direction Tailwind
 * classes (`text-left`, `text-right`, `border-l-4`, `border-r-4`, `ml-*`,
 * `mr-*`, `space-x-*`, `rounded-l-*`, `rounded-r-*`, …). Physical classes
 * pin the layout to LTR and silently break the Arabic experience.
 *
 * This guard scans `dashboard/*.html` and fails (exit 1) when it spots any
 * of the high-impact patterns developers most commonly reintroduce on new
 * pages:
 *
 *   1. `<th>` elements whose `class="…"` contains `text-left` or `text-right`
 *      → use `text-start` / `text-end` instead (table headers must mirror).
 *   2. Any element whose `class="…"` contains `border-l-4` or `border-r-4`
 *      → use `border-s-4` / `border-e-4` instead (stat-card accent borders
 *      must appear on the inline-start edge in both LTR and RTL).
 *   3. `<button>` elements whose `class="…"` contains `ml-<n>` or `mr-<n>`
 *      → use `ms-<n>` / `me-<n>` instead (icon gutters / button margins
 *      must flip with writing direction).
 *   4. Any element whose `class="…"` contains `space-x-<n>`
 *      → use `gap-<n>` instead. Tailwind's `space-x-*` compiles to a
 *      physical `margin-left` on the children's `> * + *` selector and
 *      does not flip in RTL; `gap-*` is direction-neutral.
 *   5. Any element whose `class="…"` contains `rounded-l-*` or `rounded-r-*`
 *      → use `rounded-s-*` / `rounded-e-*` instead (so the rounded edge
 *      lands on the inline-start / inline-end side in both writing
 *      directions). Bare `rounded-l` / `rounded-r` (no value) are also
 *      flagged.
 *   6. Any non-`<th>` element whose `class="…"` contains `text-left` or
 *      `text-right` (e.g. `<td>`, `<div>`, `<p>`, `<li>`, `<span>`) →
 *      use `text-start` / `text-end` instead (so cell values, headings,
 *      and inline labels mirror in Arabic). Rule 1 still owns `<th>`.
 *
 * The scan is HTML-tag aware (the same tokeniser used by
 * `scripts/check-handlers.cjs`): only attributes inside real opening tags
 * are inspected by the HTML pass, so a `text-left` inside an inline
 * `<style>` block will never be flagged. A separate **JS-string pass**
 * (Task #743) handles `<script>` bodies — see below.
 *
 * JS-string pass (Task #743)
 * --------------------------
 * The dashboard renders most of its row-level UI from JS template strings
 * inside `<script>` blocks (e.g. a button HTML built up with backticks and
 * `${…}` interpolation). If a developer drops `mr-2` into one of those
 * template strings, the HTML pass — which deliberately skips `<script>`
 * bodies — would never see it, and the RTL regression would ship.
 *
 * To close that gap, every inline `<script>` block (no `src=`, JS type) is
 * additionally parsed with `acorn`. Every string literal and template-
 * literal quasi is extracted from the AST and re-checked against tag-
 * agnostic versions of the same forbidden-class regexes (`JS_RULES`).
 * Acorn parse failures fall back to a regex-only literal sweep so we never
 * silently lose coverage. Per-rule allowlists (`JS_ALLOWLISTS`)
 * grandfather the pages that violate today; new dashboard files land
 * under the full rule.
 *
 * Companion script-block scan (Task #742)
 * --------------------------------------
 * Many dashboard pages render their tables, action buttons, and stat
 * cards from JavaScript template strings (e.g. ``return `<button class="…
 * mr-2">…`;``). The static-HTML scanner above deliberately skips
 * `<script>` bodies, so physical-direction classes living inside those
 * template strings would silently break the Arabic experience without
 * tripping the gate.
 *
 * To plug that hole, this script also runs a SECOND pass that scans the
 * body of every `<script>` block for the same Tailwind physical-direction
 * tokens (`text-left`, `text-right`, `ml-*`, `mr-*`, `pl-*`, `pr-*`,
 * `border-l-*`, `border-r-*`, `space-x-*`, `rounded-l-*`, `rounded-r-*`,
 * `left-*`, `right-*`, `float-left`, `float-right`). Findings from this
 * pass are reported as **warnings** and do NOT change the exit code.
 * Per Task #742's "out of scope" clause, CI enforcement of the JS rule is
 * tracked separately as Task #686; flipping the warnings into hard
 * failures is a one-line change there.
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
 * still blocked from picking up a new `border-l-4` accent card or a new
 * `space-x-2` flex group.
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
const acorn = require("acorn");

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
  // Drained to empty by Task #688 — all legacy `space-x-*` usages were
  // migrated to `gap-*` on their flex containers so the layout mirrors
  // correctly in Arabic RTL. Any new `space-x-*` will fail CI immediately.
  spaceX: new Set([]),
  // No legacy violators today — left intentionally empty so the very
  // first new `rounded-l-*` / `rounded-r-*` to land in `dashboard/` is
  // caught by CI.
  roundedLR: new Set([]),
  // Drained to empty by Task #688 — all legacy non-`<th>` `text-left` /
  // `text-right` usages were migrated to `text-start` / `text-end` so
  // text alignment mirrors correctly in Arabic RTL. Any new violation
  // will fail CI immediately.
  textLRNonTh: new Set([]),
};

/**
 * Per-rule allowlist for the JS-string pass (Task #743). The dashboard
 * renders a great deal of its row-level UI from JS template strings inside
 * `<script>` blocks (and from `dashboard/js/*.js` modules), so a forbidden
 * physical-direction class can ship without ever appearing in static HTML.
 * The HTML pass deliberately skips `<script>` bodies to avoid false
 * positives on real JS code (variables named `text-left`, regexes, …); the
 * JS pass instead extracts string literals + template-literal quasis from
 * each script body and applies the same forbidden-class rules to those
 * extracted strings.
 *
 * The current dashboard tree already contains many such violations — they
 * are tracked separately in Task #685. The per-rule allowlists below
 * grandfather every file that ships violations today, so the new pass can
 * land green and act as a hard gate against NEW JS-string violations.
 * Removing a file from an allowlist (or adding a new file to dashboard/)
 * applies the full rule.
 *
 * NOTE: each entry below is paired with Task #685 (the cleanup task) and
 * should be drained as that task migrates the page off physical-direction
 * classes. When a page is fully migrated, delete it from the allowlist.
 */
const JS_ALLOWLISTS = {
  // TODO(Task #685): drain as the cleanup task migrates each page off
  // physical-direction classes inside JS template strings. The pages below
  // are the baseline captured at the time Task #743 landed the JS-string
  // pass — every NEW dashboard file (or any file removed from these
  // allowlists) is subject to the full rule.
  jsTextLR: new Set([
    "dashboard/admin.html",
    "dashboard/ai-ops.html",
    "dashboard/calls.html",
    "dashboard/consultant.html",
    "dashboard/crm.html",
    "dashboard/duplicates.html",
    "dashboard/executive.html",
    "dashboard/external-audits.html",
    "dashboard/feedback.html",
    "dashboard/grc.html",
    "dashboard/index.html",
    "dashboard/intake.html",
    "dashboard/logs.html",
    "dashboard/migration.html",
    "dashboard/qms-docs.html",
    "dashboard/qms.html",
    "dashboard/reviews.html",
    "dashboard/roi.html",
    "dashboard/scorecard.html",
    "dashboard/tablef.html",
    "dashboard/team.html",
    "dashboard/users.html",
  ]),
  jsBorderLR4: new Set([
    "dashboard/index.html",
    "dashboard/intake.html",
    "dashboard/scorecard.html",
    "dashboard/tablef.html",
  ]),
  jsMlMr: new Set([
    "dashboard/admin.html",
    "dashboard/ai-approvals.html",
    "dashboard/ai-ops.html",
    "dashboard/consultant.html",
    "dashboard/duplicates.html",
    "dashboard/projects.html",
    "dashboard/qms-docs.html",
    "dashboard/qms.html",
    "dashboard/reviews.html",
    "dashboard/roi.html",
    "dashboard/scorecard.html",
    "dashboard/tablef.html",
    "dashboard/team.html",
    "dashboard/triggers.html",
    "dashboard/users.html",
  ]),
  jsSpaceX: new Set([
    "dashboard/admin.html",
    "dashboard/executive.html",
    "dashboard/feedback.html",
    "dashboard/index.html",
    "dashboard/qms.html",
    "dashboard/roi.html",
    "dashboard/scorecard.html",
    "dashboard/team.html",
  ]),
  // No legacy violators today — left intentionally empty so the very
  // first new `rounded-l-*` / `rounded-r-*` to land in a JS template string
  // is caught by CI.
  jsRoundedLR: new Set([]),
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
  {
    id: "spaceX",
    // Matches every Tailwind variant of space-x-: numeric (`space-x-2`,
    // `space-x-1.5`), keyword (`space-x-px`, `space-x-reverse`), and
    // arbitrary value (`space-x-[3px]`). Deliberately does NOT match
    // `space-y-*` (already direction-neutral) or the `gap-x-*` family
    // (logical-friendly). Lookarounds match how Tailwind tokens sit inside
    // the class attribute (whitespace boundaries, not `\b`, since `\b`
    // misbehaves after `]`).
    label: "uses physical space-x- (margin-left between children)",
    appliesToTag: () => true,
    classRegex: /(?<=^|\s)(space-x-(?:[0-9]+(?:\.[0-9]+)?|px|reverse|\[[^\]]+\]))(?=\s|$)/,
    fix: "Use `gap-…` on a `flex` / `grid` container instead — `space-x-*` compiles to physical `margin-left` between children and does not flip in RTL.",
  },
  {
    id: "roundedLR",
    // Matches `rounded-l-<value>` / `rounded-r-<value>` for every value
    // Tailwind exposes (`none`, `sm`, `md`, `lg`, `xl`, `2xl`, `3xl`,
    // `full`, numeric, arbitrary `[...]`) AND the bare `rounded-l` /
    // `rounded-r` shorthand. Carefully excludes the much-more-common
    // `rounded-lg` (left-radius shorthand vs. radius-large) by requiring
    // the next char after `l`/`r` to be a token boundary or `-`.
    label: "uses physical rounded-l-/rounded-r- corner radius",
    appliesToTag: () => true,
    classRegex: /(?<=^|\s)(rounded-[lr](?:-(?:none|sm|md|lg|xl|2xl|3xl|full|[0-9]+(?:\.[0-9]+)?|\[[^\]]+\]))?)(?=\s|$)/,
    fix: "Use `rounded-s-…` / `rounded-e-…` (logical) so the rounded edge lands on the inline-start / inline-end side in Arabic RTL.",
  },
  {
    id: "textLRNonTh",
    // Mirror of `thTextAlign` but for everything OTHER than `<th>`. The
    // two rules together cover the full "no `text-left` / `text-right`
    // anywhere in dashboard HTML" policy without losing the per-file
    // grandfathering granularity we need to land green.
    label: "uses physical text-left/text-right",
    appliesToTag: (tag) => tag !== "th",
    classRegex: /\b(text-left|text-right)\b/,
    fix: "Use `text-start` / `text-end` (logical) so the text alignment mirrors in Arabic RTL.",
  },
];

/**
 * JS-string rules (Task #743). Applied to string literals + template-
 * literal quasis extracted from `<script>` bodies. We can't observe a
 * destination DOM tag from inside a JS string, so the JS pass uses tag-
 * agnostic versions of the HTML rules:
 *
 *   • `jsTextLR` collapses `thTextAlign` + `textLRNonTh` (no tag axis).
 *   • `jsMlMr` covers ml-/mr- regardless of the eventual element (the
 *     HTML rule scopes it to `<button>` to bound false positives, but
 *     dashboard JS strings build buttons, badges, links, and table cells
 *     interchangeably — flagging them all is the safer default).
 *
 * The class regex bodies match the HTML rules exactly so a developer
 * cannot bypass the gate by promoting a static class into a JS template
 * string.
 */
const JS_RULES = [
  {
    id: "jsTextLR",
    label: "JS string literal contains physical text-left/text-right",
    classRegex: /\b(text-left|text-right)\b/,
    fix: "Use `text-start` / `text-end` (logical) so the text alignment mirrors in Arabic RTL.",
  },
  {
    id: "jsBorderLR4",
    label: "JS string literal contains physical border-l-4/border-r-4",
    classRegex: /\b(border-l-4|border-r-4)\b/,
    fix: "Use `border-s-4` / `border-e-4` (logical) so the accent border appears on the correct edge in Arabic RTL.",
  },
  // The HTML rules apply to a `class="..."` attribute value where Tailwind
  // tokens are guaranteed to be separated by whitespace; whitespace
  // boundaries are sufficient. The JS rules instead apply to the WHOLE
  // string literal, which usually contains a fragment of HTML markup
  // (`'<button class="… mr-2">Edit</button>'`). The forbidden token can
  // therefore be flanked by quote / angle-bracket characters when it sits
  // at the end of a class attribute, so the boundary lookarounds must
  // accept those characters too.
  {
    id: "jsMlMr",
    label: "JS string literal contains physical ml-/mr- margin",
    classRegex: /(?<=^|[\s"'>])(m[lr]-(?:[0-9]+(?:\.[0-9]+)?(?:\/[0-9]+)?|px|auto|full|reverse|\[[^\]]+\]))(?=[\s"'<]|$)/,
    fix: "Use `ms-…` / `me-…` (logical) so the margin flips with writing direction.",
  },
  {
    id: "jsSpaceX",
    label: "JS string literal contains physical space-x- (margin-left between children)",
    classRegex: /(?<=^|[\s"'>])(space-x-(?:[0-9]+(?:\.[0-9]+)?|px|reverse|\[[^\]]+\]))(?=[\s"'<]|$)/,
    fix: "Use `gap-…` on a `flex` / `grid` container instead — `space-x-*` compiles to physical `margin-left` between children and does not flip in RTL.",
  },
  {
    id: "jsRoundedLR",
    label: "JS string literal contains physical rounded-l-/rounded-r- corner radius",
    classRegex: /(?<=^|[\s"'>])(rounded-[lr](?:-(?:none|sm|md|lg|xl|2xl|3xl|full|[0-9]+(?:\.[0-9]+)?|\[[^\]]+\]))?)(?=[\s"'<]|$)/,
    fix: "Use `rounded-s-…` / `rounded-e-…` (logical) so the rounded edge lands on the inline-start / inline-end side in Arabic RTL.",
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
 * inspected by the HTML rule engine; `<script>` and `<style>` bodies are
 * fast-forwarded so JS / CSS that mentions a forbidden class string is
 * never flagged by the HTML pass.
 *
 * In addition to `tag` tokens, `tokenize()` emits a `scriptBody` token for
 * every inline `<script>` block (no `src=`, not self-closing, not a non-JS
 * type). The JS-string pass (Task #743) consumes those tokens to extract
 * string literals + template-literal quasis from the script body and
 * re-runs the forbidden-class rules against the extracted strings — so a
 * `text-left` that lives inside a JS template string is still caught at
 * CI time.
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
      const bodyEnd = closeMatch ? gt + 1 + closeMatch.index : len;

      // Emit a `scriptBody` token for inline JS script blocks so the JS-
      // string pass can scan them. Skip external scripts (`src=...`) and
      // non-JS types (`type="application/json"`, `text/template`, …).
      if (tagName === "script" && isInlineJsScript(tagText)) {
        tokens.push({
          kind: "scriptBody",
          start: gt + 1,
          end: bodyEnd,
          openTag: tagText,
        });
      }

      i = closeMatch ? bodyEnd + closeMatch[0].length : len;
      continue;
    }

    i = gt + 1;
  }
  return tokens;
}

/**
 * Returns true if the `<script …>` opening tag is an inline JS script
 * (no `src=` attribute, no non-JS `type=` attribute). External scripts
 * have nothing to scan; non-JS types (JSON, HTML templates, etc.) would
 * crash acorn and produce noisy false positives if scanned as JS.
 */
function isInlineJsScript(openTag) {
  if (/\ssrc\s*=/i.test(openTag)) return false;
  const typeMatch = openTag.match(/\stype\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (typeMatch) {
    const value = (typeMatch[2] || typeMatch[3] || typeMatch[4] || "").trim().toLowerCase();
    if (value === "" || value === "module") return true;
    if (
      value === "text/javascript" ||
      value === "application/javascript" ||
      value === "application/ecmascript" ||
      value === "text/ecmascript"
    ) {
      return true;
    }
    return false;
  }
  return true;
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

/**
 * Walk an acorn AST visiting every node. Returns nothing — the visitor is
 * called for its side effects (collecting string literals).
 */
function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkAst(item, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
    const child = node[key];
    if (child && typeof child === "object") walkAst(child, visit);
  }
}

/**
 * Fallback string-literal extractor used when acorn can't parse a script
 * (rare — usually a syntax error introduced by a copy/paste mistake).
 * We must NOT silently lose RTL coverage on those files, so we sweep the
 * raw script body for quoted/template-literal contents with a tolerant
 * regex. Comments inside the script body are stripped first so a class
 * name that only appears in `// rounded-l-2 (legacy)` doesn't fire.
 *
 * Limitations vs. acorn: this fallback can't follow `${...}` interpolation
 * boundaries inside template literals, so a `${expr}` containing a quote
 * will desynchronise the scanner. We accept that in exchange for never
 * dropping a violation on un-parseable files.
 */
function regexExtractStrings(scriptBody, bodyStart) {
  const stripped = scriptBody
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
  const out = [];
  const re = /'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\])*)`/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const content = m[1] != null ? m[1] : m[2] != null ? m[2] : m[3];
    if (content == null) continue;
    out.push({
      content,
      start: bodyStart + m.index + 1, // skip opening quote
    });
  }
  return out;
}

/**
 * Extract every string literal + template-literal quasi from a `<script>`
 * body. Each result has the literal's text and its absolute character
 * offset in the source HTML file (used for line/col reporting and for the
 * per-line opt-out marker).
 */
function extractScriptStrings(scriptBody, bodyStart) {
  let ast;
  // Try `module` first — it's a strict superset for our purposes (we only
  // care about literal nodes and modules support top-level await /
  // `import` / `export`). Fall back to `script` for the rare file where
  // module-only constructs throw.
  try {
    ast = acorn.parse(scriptBody, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: false,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowHashBang: true,
    });
  } catch (_err) {
    try {
      ast = acorn.parse(scriptBody, {
        ecmaVersion: "latest",
        sourceType: "script",
        locations: false,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        allowImportExportEverywhere: true,
        allowHashBang: true,
      });
    } catch (_err2) {
      // Acorn can't parse this script body — fall back to regex sweep so
      // we don't silently drop coverage.
      return regexExtractStrings(scriptBody, bodyStart);
    }
  }

  const out = [];
  walkAst(ast, (node) => {
    if (node.type === "Literal" && typeof node.value === "string") {
      // node.start points at the opening quote; +1 to land on the first
      // character of the string body (mirrors regexExtractStrings()).
      out.push({ content: node.value, start: bodyStart + node.start + 1 });
    } else if (node.type === "TemplateElement") {
      const cooked = node.value && typeof node.value.cooked === "string"
        ? node.value.cooked
        : (node.value && node.value.raw) || "";
      out.push({ content: cooked, start: bodyStart + node.start });
    }
  });
  return out;
}

function scanScriptStrings(html, scriptToken, rel) {
  const violations = [];
  const body = html.slice(scriptToken.start, scriptToken.end);
  const literals = extractScriptStrings(body, scriptToken.start);

  for (const lit of literals) {
    if (!lit.content) continue;
    for (const rule of JS_RULES) {
      const allowlist = JS_ALLOWLISTS[rule.id];
      if (allowlist && allowlist.has(rel)) continue;
      const m = lit.content.match(rule.classRegex);
      if (!m) continue;
      const lineText = lineTextAt(html, lit.start);
      if (lineText.includes(OPT_OUT_MARKER)) continue;
      const { line, col } = lineColAt(html, lit.start);
      const snippet = lit.content.length > 200
        ? lit.content.slice(0, 197) + "…"
        : lit.content;
      violations.push({
        file: rel,
        line,
        col,
        ruleId: rule.id,
        message: `${rule.label} (\`${m[1]}\`).`,
        fix: rule.fix,
        snippet,
      });
    }
  }
  return violations;
}

function scanFile(absPath) {
  const rel = path.relative(ROOT, absPath).split(path.sep).join("/");
  const html = fs.readFileSync(absPath, "utf8");
  const tokens = tokenize(html);
  const violations = [];

  for (const tok of tokens) {
    if (tok.kind === "scriptBody") {
      violations.push(...scanScriptStrings(html, tok, rel));
      continue;
    }
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

// ---------------------------------------------------------------------------
// Companion pass: scan inside <script> bodies for the same Tailwind
// physical-direction tokens as the static-HTML rules. Findings here are
// reported as WARNINGS only — the exit code is not affected. See the
// "Companion script-block scan (Task #742)" section in the file header
// for the full motivation.
// ---------------------------------------------------------------------------

const SCRIPT_RULES = [
  {
    id: "scriptTextLR",
    label: "physical text-left/text-right in JS template",
    regex: /(?<=^|[\s"'`])(text-(?:left|right))(?=[\s"'`]|$)/g,
    fix: "Use `text-start` / `text-end` so the text alignment mirrors in Arabic RTL.",
  },
  {
    id: "scriptFloatLR",
    label: "physical float-left/float-right in JS template",
    regex: /(?<=^|[\s"'`])(float-(?:left|right))(?=[\s"'`]|$)/g,
    fix: "Use `float-start` / `float-end` so the float side mirrors in Arabic RTL.",
  },
  {
    id: "scriptMlMr",
    label: "physical ml-/mr- margin in JS template",
    regex: /(?<=^|[\s"'`])(m[lr]-(?:[0-9]+(?:\.[0-9]+)?(?:\/[0-9]+)?|px|auto|full|reverse|\[[^\]]+\]))(?=[\s"'`]|$)/g,
    fix: "Use `ms-…` / `me-…` so the margin flips with writing direction.",
  },
  {
    id: "scriptPlPr",
    label: "physical pl-/pr- padding in JS template",
    regex: /(?<=^|[\s"'`])(p[lr]-(?:[0-9]+(?:\.[0-9]+)?(?:\/[0-9]+)?|px|auto|full|\[[^\]]+\]))(?=[\s"'`]|$)/g,
    fix: "Use `ps-…` / `pe-…` so the padding flips with writing direction.",
  },
  {
    id: "scriptBorderLR",
    label: "physical border-l-/border-r- in JS template",
    regex: /(?<=^|[\s"'`])(border-[lr]-(?:[0-9]+|none|sm|md|lg|xl|2xl|3xl|4xl|\[[^\]]+\]))(?=[\s"'`]|$)/g,
    fix: "Use `border-s-…` / `border-e-…` so the accent border lands on the inline-start / inline-end edge in Arabic RTL.",
  },
  {
    id: "scriptSpaceX",
    label: "physical space-x- (margin-left between children) in JS template",
    regex: /(?<=^|[\s"'`])(space-x-(?:[0-9]+(?:\.[0-9]+)?|px|reverse|\[[^\]]+\]))(?=[\s"'`]|$)/g,
    fix: "Use `gap-…` on a flex/grid container — `space-x-*` compiles to physical `margin-left` and does not flip in RTL.",
  },
  {
    id: "scriptRoundedLR",
    label: "physical rounded-l-/rounded-r- corner radius in JS template",
    regex: /(?<=^|[\s"'`])(rounded-[lr](?:-(?:none|sm|md|lg|xl|2xl|3xl|full|[0-9]+(?:\.[0-9]+)?|\[[^\]]+\]))?)(?=[\s"'`]|$)/g,
    fix: "Use `rounded-s-…` / `rounded-e-…` so the rounded edge lands on the inline-start / inline-end side in Arabic RTL.",
  },
  {
    id: "scriptInsetLR",
    label: "physical left-/right- positional inset in JS template",
    regex: /(?<=^|[\s"'`])((?:left|right)-(?:[0-9]+(?:\.[0-9]+)?(?:\/[0-9]+)?|px|auto|full|\[[^\]]+\]))(?=[\s"'`]|$)/g,
    fix: "Use `start-…` / `end-…` so the absolute/fixed offset mirrors in Arabic RTL.",
  },
];

const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Replace every JS line comment (`// …`) and block comment (`/* … *\/`) in
 * `body` with same-length whitespace (preserving newlines) so byte offsets
 * downstream — used by `lineColAt` / `lineTextAt` to point at the original
 * source — stay correct. Quoted strings and template literals are walked
 * literally so a `//` or `/*` *inside* a string isn't mistaken for a comment
 * marker; this is the same shape acorn uses internally.
 *
 * Why this exists: the companion regex pass below would otherwise surface
 * forbidden tokens that live ONLY inside comments (e.g. a `// text-right
 * deprecated` annotation), even though acorn's JS-string pass correctly
 * strips them. Without this helper the two passes disagree and the gate
 * leaks comment-only false positives.
 */
function blankCommentsPreservingOffsets(body) {
  const out = body.split("");
  const n = out.length;
  let i = 0;
  while (i < n) {
    const ch = out[i];
    const next = i + 1 < n ? out[i + 1] : "";

    // Single-line comment — blank to end of line.
    if (ch === "/" && next === "/") {
      out[i] = " ";
      out[i + 1] = " ";
      let j = i + 2;
      while (j < n && out[j] !== "\n") {
        out[j] = " ";
        j++;
      }
      i = j;
      continue;
    }

    // Block comment — blank everything except embedded newlines.
    if (ch === "/" && next === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      let j = i + 2;
      while (j < n - 1 && !(out[j] === "*" && out[j + 1] === "/")) {
        if (out[j] !== "\n") out[j] = " ";
        j++;
      }
      if (j < n - 1) {
        out[j] = " ";
        out[j + 1] = " ";
        j += 2;
      } else {
        // Unterminated block comment — blank to EOF.
        j = n;
      }
      i = j;
      continue;
    }

    // String / template literal — walk literally so an embedded "//" or
    // "/*" doesn't get treated as a comment marker. Handles backslash
    // escapes; gives up on the quote-mode at the end of the line so a
    // syntax error (unclosed string) cannot blank out half the file.
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (out[j] === "\\") {
          j += 2;
          continue;
        }
        if (out[j] === quote) {
          j++;
          break;
        }
        if (quote !== "`" && out[j] === "\n") break; // unterminated, abort
        j++;
      }
      i = j;
      continue;
    }

    i++;
  }
  return out.join("");
}

function scanFileScripts(absPath) {
  const rel = path.relative(ROOT, absPath).split(path.sep).join("/");
  const html = fs.readFileSync(absPath, "utf8");
  const warnings = [];

  let blockMatch;
  while ((blockMatch = SCRIPT_BLOCK_RE.exec(html)) !== null) {
    const openTag = blockMatch[0].slice(0, blockMatch[0].indexOf(">") + 1);

    // Skip external scripts (no body to scan) and non-JS scripts
    // (`type="application/json"`, `text/template`, …) — those bodies are
    // not Tailwind class strings and would produce noisy false positives.
    // The acorn-based JS-string pass uses the same predicate; without it,
    // this companion pass would disagree and re-surface JSON-blob copy.
    if (!isInlineJsScript(openTag)) continue;

    const rawBody = blockMatch[1];
    // Strip JS comments before regex-scanning so a comment containing a
    // forbidden Tailwind token (e.g. `// legacy text-right`) does not
    // produce a warning. Offsets are preserved (whitespace fill) so the
    // line/col reports below still match the original source.
    const body = blankCommentsPreservingOffsets(rawBody);
    const bodyOffset = blockMatch.index + blockMatch[0].indexOf(">") + 1;
    for (const rule of SCRIPT_RULES) {
      // Reset regex state for safety (we use /g)
      rule.regex.lastIndex = 0;
      let m;
      while ((m = rule.regex.exec(body)) !== null) {
        const absOffset = bodyOffset + m.index;
        const lineText = lineTextAt(html, absOffset);
        if (lineText.includes(OPT_OUT_MARKER)) continue;
        const { line, col } = lineColAt(html, absOffset);
        warnings.push({
          file: rel,
          line,
          col,
          ruleId: rule.id,
          message: `<script> body ${rule.label} (\`${m[1]}\`).`,
          fix: rule.fix,
          snippet: lineText.trim().length > 200 ? lineText.trim().slice(0, 197) + "…" : lineText.trim(),
        });
      }
    }
  }

  return warnings;
}

function main() {
  const files = listHtmlFiles();
  if (files.length === 0) {
    console.log("✓ RTL physical-direction guardrail: no dashboard HTML files to scan.");
    process.exit(0);
  }

  const allViolations = [];
  const allScriptWarnings = [];
  for (const f of files) {
    try {
      allViolations.push(...scanFile(f));
      allScriptWarnings.push(...scanFileScripts(f));
    } catch (err) {
      console.error(
        `✗ Failed to scan ${path.relative(ROOT, f)}: ${err && err.message ? err.message : err}`,
      );
      process.exit(2);
    }
  }

  // Emit script-block findings as warnings (do not affect exit code).
  // Per Task #742 / Task #686, CI enforcement is intentionally separate
  // from detection; flipping this to a hard fail is a one-line change.
  if (allScriptWarnings.length > 0) {
    console.error("");
    console.error(
      `⚠ RTL physical-direction guardrail (script-block companion) — ${allScriptWarnings.length} warning(s):`,
    );
    console.error("");
    for (const w of allScriptWarnings) {
      console.error(`  ${w.file}:${w.line}:${w.col}  [${w.ruleId}]  ${w.message}`);
      console.error(`      → ${w.snippet.replace(/\s+/g, " ").trim()}`);
      console.error(`      Fix: ${w.fix}`);
    }
    console.error("");
    console.error(
      "These are reported as warnings only — CI enforcement of the JS scanning",
    );
    console.error(
      "rule is tracked separately as Task #686 and does not affect this exit code.",
    );
    console.error("");
  }

  if (allViolations.length === 0) {
    console.log(
      `✓ RTL physical-direction guardrail PASS — scanned ${files.length} dashboard HTML file(s) (HTML tags + JS template strings inside <script> bodies); no forbidden physical-direction classes found (text-left/right on <th> or other tags, border-l-4/r-4, <button> ml-/mr-, space-x-, or rounded-l-/r-).`,
    );
    if (allScriptWarnings.length === 0) {
      console.log(
        `✓ RTL script-block companion scan: clean — no physical-direction classes found in any <script> body across ${files.length} dashboard HTML file(s).`,
      );
    } else {
      console.log(
        `  (Script-block companion scan reported ${allScriptWarnings.length} warning(s); see above. Exit code unaffected per Task #686.)`,
      );
    }
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
  console.error("  `ml-*`, `space-x-*`, `rounded-l-*`, …) pin the layout to LTR and silently");
  console.error("  break the Arabic experience. See replit.md → \"RTL Layout Convention\"");
  console.error("  for the full list of logical-direction equivalents.");
  console.error("");
  console.error("Fix recipe:");
  console.error("  • <th class=\"… text-left …\">     →  <th class=\"… text-start …\">");
  console.error("  • <td class=\"… text-right …\">    →  <td class=\"… text-end …\">");
  console.error("  • <div class=\"… border-l-4 …\">   →  <div class=\"… border-s-4 …\">");
  console.error("  • <button class=\"… mr-2 …\">       →  <button class=\"… me-2 …\">");
  console.error("  • <div class=\"… space-x-2 …\">    →  <div class=\"… gap-2 …\">  (on flex/grid)");
  console.error("  • <div class=\"… rounded-l-lg …\"> →  <div class=\"… rounded-s-lg …\">");
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
