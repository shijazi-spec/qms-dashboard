#!/usr/bin/env node
/**
 * WalaPlus dashboard CSP guard.
 *
 * Scans `dashboard/*.html` and `public/*.html` for inline event-handler
 * attributes (`onclick=`, `onchange=`, `onsubmit=`, `oninput=`, …) that
 * would be silently blocked by the strict CSP (`script-src` no longer
 * allows `'unsafe-inline'`). Equivalent behaviour MUST go through
 * `dashboard/js/safe-actions.js` using the `data-on-{event}` pattern.
 *
 * The scan is HTML-tag aware: it tokenises the file into top-level tag
 * regions and explicitly skips `<script>` and `<style>` bodies, so JS
 * variable / property names like `onTrackKpis`, `addEventListener('click', …)`
 * or `props.onChange` are NEVER flagged. Only attributes that appear
 * inside a real opening tag are considered violations.
 *
 * Pass `--check-inline-scripts` to additionally flag bare `<script>...</script>`
 * blocks that lack a `nonce=` attribute. The CSP middleware auto-injects a
 * nonce on every served `<script>`, so pages legitimately served via that
 * middleware are listed in `INLINE_SCRIPT_NONCE_ALLOWLIST` below; any new
 * HTML page that adds an inline `<script>` and is NOT on the allowlist will
 * fail the check (catching pages that accidentally bypass the middleware
 * and would silently fail in production). The allowlist also fails on
 * stale entries so it cannot rot. Wired into `scripts/post-merge.sh`.
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
const SCAN_DIRS = ["dashboard", "public"];

const HANDLER_ATTR_RE = /\s(on[a-z]+)\s*=/i;
const TAG_OPEN_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\b/;

const args = new Set(process.argv.slice(2));
const checkInlineScripts = args.has("--check-inline-scripts");

// ---------------------------------------------------------------------------
// Inline-<script> nonce allowlist (Task #248)
//
// Every entry in this set is an HTML page that intentionally relies on the
// global CSP middleware (`src/mastra/middleware/index.ts` →
// `injectCspNonce`) to rewrite each `<script>` open tag into
// `<script nonce="…">` at request time. Because the nonce is per-request, it
// CANNOT live in the source HTML — so under `--check-inline-scripts` these
// pages would otherwise produce false positives.
//
// All 38 of the current dashboard pages are served by routes that flow
// through `globalMiddleware`, so they are listed here. The allowlist
// deliberately does NOT use a glob — adding a new HTML page is a conscious
// act and must be paired with a deliberate add here, which is exactly the
// signal we want: the author has confirmed the new route is wired through
// the nonce-injecting middleware (and not, for example, served via a custom
// handler that bypasses it).
//
// Stale entries (an allowlisted file with no inline <script> or no longer
// present on disk) are surfaced as a hard error so the list cannot rot.
// ---------------------------------------------------------------------------
const INLINE_SCRIPT_NONCE_ALLOWLIST = new Set([
  "dashboard/a11y.html",
  "dashboard/accept-invite.html",
  "dashboard/admin.html",
  "dashboard/ai-approvals.html",
  "dashboard/audits.html",
  "dashboard/calls.html",
  "dashboard/compliance.html",
  "dashboard/consultant.html",
  "dashboard/crm.html",
  "dashboard/duplicates.html",
  "dashboard/executive.html",
  "dashboard/external-audits.html",
  "dashboard/feedback.html",
  "dashboard/grc.html",
  "dashboard/guide.html",
  "dashboard/health.html",
  "dashboard/index.html",
  "dashboard/infographic.html",
  "dashboard/intake.html",
  "dashboard/kpis.html",
  "dashboard/login.html",
  "dashboard/logs.html",
  "dashboard/migration.html",
  "dashboard/onboarding.html",
  "dashboard/pdpl.html",
  "dashboard/policies.html",
  "dashboard/projects.html",
  "dashboard/qms-docs.html",
  "dashboard/qms.html",
  "dashboard/reviews.html",
  "dashboard/risks.html",
  "dashboard/roi.html",
  "dashboard/scorecard.html",
  "dashboard/sop.html",
  "dashboard/tablef.html",
  "dashboard/team.html",
  "dashboard/triggers.html",
  "dashboard/users.html",
  "dashboard/vendors.html",
  "dashboard/fraud-country-risk.html",
  "dashboard/fraud-dashboard.html",
  "dashboard/fraud-incidents.html",
  "dashboard/fraud-rules.html",
]);

function toRelKey(absPath) {
  // Normalise to forward slashes so the allowlist is portable.
  return path.relative(ROOT, absPath).split(path.sep).join("/");
}

function listHtmlFiles() {
  const out = [];
  for (const rel of SCAN_DIRS) {
    const dir = path.join(ROOT, rel);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) {
        out.push(path.join(dir, entry.name));
      }
    }
  }
  return out.sort();
}

/**
 * Walk the HTML linearly and yield { kind, start, end, text } regions.
 * kind is one of: 'tag' (opening or closing tag, including attributes),
 * 'script' (entire <script>...</script> body, attributes excluded),
 * 'style'  (entire <style>...</style> body, attributes excluded),
 * 'text'   (everything outside tags / scripts / styles).
 *
 * We only inspect 'tag' regions for inline handler attributes, which
 * keeps JS identifiers like onTrackKpis safely ignored.
 */
function tokenize(html) {
  const tokens = [];
  let i = 0;
  const len = html.length;

  while (i < len) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      tokens.push({ kind: "text", start: i, end: len, text: html.slice(i) });
      break;
    }
    if (lt > i) {
      tokens.push({ kind: "text", start: i, end: lt, text: html.slice(i, lt) });
    }
    // Comments
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      const end = close === -1 ? len : close + 3;
      tokens.push({ kind: "comment", start: lt, end, text: html.slice(lt, end) });
      i = end;
      continue;
    }
    // <!doctype …> and other declarations
    if (html.startsWith("<!", lt)) {
      const close = html.indexOf(">", lt + 2);
      const end = close === -1 ? len : close + 1;
      tokens.push({ kind: "decl", start: lt, end, text: html.slice(lt, end) });
      i = end;
      continue;
    }
    // Find end of opening tag
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) {
      tokens.push({ kind: "text", start: lt, end: len, text: html.slice(lt) });
      break;
    }
    const tagText = html.slice(lt, gt + 1);
    const m = tagText.match(TAG_OPEN_RE);
    if (!m) {
      tokens.push({ kind: "text", start: lt, end: gt + 1, text: tagText });
      i = gt + 1;
      continue;
    }
    const tagName = m[1].toLowerCase();
    tokens.push({
      kind: "tag",
      start: lt,
      end: gt + 1,
      text: tagText,
      tagName,
      isClose: tagText.startsWith("</"),
    });

    // For <script> / <style>, fast-forward past the body so its contents
    // are never scanned for inline-handler attributes.
    if (
      (tagName === "script" || tagName === "style") &&
      !tagText.startsWith("</") &&
      !tagText.endsWith("/>")
    ) {
      const closeRe = new RegExp(`</${tagName}\\s*>`, "i");
      const rest = html.slice(gt + 1);
      const closeMatch = rest.match(closeRe);
      const bodyEnd = closeMatch
        ? gt + 1 + closeMatch.index
        : len;
      tokens.push({
        kind: tagName,
        start: gt + 1,
        end: bodyEnd,
        text: html.slice(gt + 1, bodyEnd),
        openTag: tagText,
      });
      i = bodyEnd;
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

function scanFile(absPath) {
  const rel = toRelKey(absPath);
  const html = fs.readFileSync(absPath, "utf8");
  const tokens = tokenize(html);
  const violations = [];
  const allowlistedForInlineScripts = INLINE_SCRIPT_NONCE_ALLOWLIST.has(rel);
  let inlineScriptCount = 0;

  for (const tok of tokens) {
    if (tok.kind === "tag") {
      // Look for inline handler attribute inside the opening tag.
      // Match against tag text *excluding* the leading "<tagname" so we
      // don't match the tag name itself.
      const afterName = tok.text.replace(/^<\/?[a-zA-Z][a-zA-Z0-9-]*/, "");
      const m = afterName.match(HANDLER_ATTR_RE);
      if (m) {
        const attr = m[1].toLowerCase();
        const { line, col } = lineColAt(html, tok.start);
        violations.push({
          file: rel,
          line,
          col,
          kind: "inline-handler",
          message: `<${tok.tagName}> has inline ${attr}= attribute (blocked by CSP). Use dashboard/js/safe-actions.js with data-on-${attr.slice(2)}=… instead.`,
          snippet: tok.text.length > 200 ? tok.text.slice(0, 197) + "…" : tok.text,
        });
      }
    } else if (tok.kind === "script" && checkInlineScripts) {
      // Bare inline <script>…</script> without a nonce= attribute.
      const open = tok.openTag || "";
      const isExternal = /\ssrc\s*=/.test(open);
      const hasNonce = /\snonce\s*=/.test(open);
      if (!isExternal && !hasNonce && tok.text.trim() !== "") {
        inlineScriptCount++;
        if (!allowlistedForInlineScripts) {
          const { line, col } = lineColAt(html, tok.start);
          violations.push({
            file: rel,
            line,
            col,
            kind: "inline-script-no-nonce",
            message: "Inline <script> block without nonce= attribute. Either (a) load the JS from an external file under /js/ via <script src=…>, or (b) confirm this page is served via the global CSP middleware (src/mastra/middleware/index.ts) and add it to INLINE_SCRIPT_NONCE_ALLOWLIST in scripts/check-handlers.cjs.",
            snippet: open,
          });
        }
      }
    }
  }

  return { violations, inlineScriptCount, allowlistedForInlineScripts };
}

function main() {
  const files = listHtmlFiles();
  if (files.length === 0) {
    console.log("✓ Inline-handler guardrail: no dashboard/public HTML files to scan.");
    process.exit(0);
  }

  let total = 0;
  const allViolations = [];
  // Track which allowlisted files were actually exercised so we can flag
  // stale entries (file deleted, or all inline <script>s removed).
  const usedAllowlistEntries = new Set();
  for (const f of files) {
    try {
      const result = scanFile(f);
      allViolations.push(...result.violations);
      const rel = toRelKey(f);
      if (result.allowlistedForInlineScripts && result.inlineScriptCount > 0) {
        usedAllowlistEntries.add(rel);
      }
    } catch (err) {
      console.error(`✗ Failed to scan ${path.relative(ROOT, f)}: ${err && err.message ? err.message : err}`);
      process.exit(2);
    }
    total++;
  }

  // Stale-allowlist detection (only meaningful when --check-inline-scripts is on,
  // since otherwise we never visited any inline-script tokens).
  const staleAllowlist = [];
  if (checkInlineScripts) {
    for (const entry of INLINE_SCRIPT_NONCE_ALLOWLIST) {
      if (!usedAllowlistEntries.has(entry)) {
        staleAllowlist.push(entry);
      }
    }
  }

  if (allViolations.length === 0 && staleAllowlist.length === 0) {
    const allowedNote = checkInlineScripts
      ? ` (${INLINE_SCRIPT_NONCE_ALLOWLIST.size} page(s) on the middleware-nonce allowlist)`
      : "";
    console.log(
      `✓ Inline-handler CSP guardrail PASS — scanned ${total} HTML file(s); no inline on*= attributes${
        checkInlineScripts ? " or unnonced inline <script> blocks" : ""
      } found${allowedNote}.`
    );
    process.exit(0);
  }

  console.error("");
  console.error(
    `✗ Inline-handler CSP guardrail FAIL — ${allViolations.length} violation(s)${
      staleAllowlist.length > 0 ? `, ${staleAllowlist.length} stale allowlist entry/entries` : ""
    }:`
  );
  console.error("");
  for (const v of allViolations) {
    console.error(`  ${v.file}:${v.line}:${v.col}  [${v.kind}]  ${v.message}`);
    if (v.snippet) {
      console.error(`      → ${v.snippet.replace(/\s+/g, " ").trim()}`);
    }
  }
  if (staleAllowlist.length > 0) {
    console.error("");
    console.error("Stale INLINE_SCRIPT_NONCE_ALLOWLIST entries (file missing or no longer has any unnonced inline <script> blocks):");
    for (const entry of staleAllowlist) {
      console.error(`  • ${entry}`);
    }
    console.error("Remove these from scripts/check-handlers.cjs to keep the allowlist tight.");
  }
  console.error("");
  console.error("Fix recipe:");
  console.error("  • Replace inline `onclick=\"foo(event)\"` with `data-on-click=\"foo\"` and load");
  console.error("    `dashboard/js/safe-actions.js` from the page.");
  console.error("  • For <script> blocks without nonce=, prefer an external file under /js/. If");
  console.error("    the page is genuinely served via the global CSP middleware, add it to");
  console.error("    INLINE_SCRIPT_NONCE_ALLOWLIST in scripts/check-handlers.cjs.");
  process.exit(1);
}

main();
