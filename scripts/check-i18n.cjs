#!/usr/bin/env node
/**
 * WalaPlus i18n guardrail (Task #125)
 * ----------------------------------------------------------------------------
 * Prevents new dashboard pages or new `data-i18n` references from silently
 * regressing the Arabic experience. Three independent checks:
 *
 *   1. Page wiring         — every `dashboard/*.html` page (excluding the
 *                            allowlist below) must:
 *                              a. Load `/js/i18n.js` (any query string).
 *                              b. Call `WalaPlusI18n.init().then(...)` with
 *                                 `applyToDOM(...)` somewhere inside the
 *                                 .then() chain so the DOM is actually
 *                                 translated.
 *
 *   2. Reference coverage  — every `data-i18n="ns.key"` (and the related
 *                            `data-i18n-placeholder` / `data-i18n-title`
 *                            attributes) referenced from any HTML page must
 *                            resolve to a STRING value in BOTH
 *                            `dashboard/i18n/en.json` and
 *                            `dashboard/i18n/ar.json`.
 *
 *   3. Tree parity         — `en.json` and `ar.json` must have IDENTICAL key
 *                            trees (no orphans on either side, and the leaves
 *                            must line up — adding a sub-object on one side
 *                            and a string on the other also fails).
 *
 * Exit code:
 *   0 — all three checks pass.
 *   1 — at least one check failed (script prints actionable diagnostics).
 *   2 — internal error (file read / parse failure).
 *
 * Usage:
 *   node scripts/check-i18n.cjs
 *   npm run check:i18n
 *
 * CI wiring:
 *   `tests/i18nCoverage.test.ts` runs this script as part of `npm test`
 *   (which is what `scripts/post-merge.sh` invokes for every merge).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DASHBOARD_DIR = path.join(ROOT, 'dashboard');
const EN_PATH = path.join(DASHBOARD_DIR, 'i18n', 'en.json');
const AR_PATH = path.join(DASHBOARD_DIR, 'i18n', 'ar.json');

// HTML files in dashboard/ that are NOT user-facing dashboard pages and so
// do not need the i18n wiring. Keep this list tiny and explicit; every entry
// must be a basename, not a full path.
//
// (Currently empty — every existing dashboard/*.html page IS user-facing and
// already wires i18n. The mechanism exists so that future fragments / email
// previews / standalone snippets can opt out without weakening the rule for
// real pages.)
const PAGE_WIRING_ALLOWLIST = new Set([]);

// Accept both `data-i18n="key"` and `data-i18n='key'` quoting. HTML allows
// either, and a future edit could mix them; missing a single-quoted reference
// would silently weaken the coverage check.
const I18N_ATTR_RE = /data-i18n(?:-[a-z]+)?=(?:"([^"]+)"|'([^']+)')/g;
const I18N_SCRIPT_RE = /<script[^>]+src=["'][^"']*\/js\/i18n\.js(?:\?[^"']*)?["'][^>]*>/i;
// Locator for the start of the i18n bootstrap chain. The body of `.then(...)`
// is then extracted with a balanced-paren scan so nested calls like
// `() => window.WalaPlusI18n.applyToDOM()` are captured correctly.
const INIT_THEN_RE = /WalaPlusI18n\s*\.\s*init\s*\([^)]*\)\s*\.\s*then\s*\(/g;

/**
 * Starting at `openIdx` (which must point at an opening `(`), return the body
 * of the parenthesised expression (string between the matching parens, NOT
 * including the parens themselves). Returns null if the parens are unbalanced.
 */
function extractBalanced(src, openIdx) {
  if (src[openIdx] !== '(') return null;
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

function fail(label, details) {
  console.error(`\n✗ ${label}`);
  for (const line of details) console.error(`    ${line}`);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`ERROR: failed to read/parse ${path.relative(ROOT, p)}: ${err.message}`);
    process.exit(2);
  }
}

function listHtmlPages() {
  return fs
    .readdirSync(DASHBOARD_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => e.name)
    .sort();
}

/**
 * Recursively flatten a JSON object into `dotted.path -> "string"|"<branch>"`
 * entries. The marker `<branch>` is used for non-leaf nodes so callers can
 * detect type-mismatches (e.g. EN has a string at "x.y" but AR has an object).
 */
function flatten(obj, prefix = '', out = new Map()) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    out.set(prefix, typeof obj === 'string' ? '<leaf>' : `<${typeof obj}>`);
    return out;
  }
  if (Object.keys(obj).length === 0) {
    out.set(prefix, '<branch>');
    return out;
  }
  for (const k of Object.keys(obj)) {
    flatten(obj[k], prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

function getDeep(obj, dottedKey) {
  const parts = dottedKey.split('.');
  let cur = obj;
  for (const k of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/* ---------------------------------------------------------------------------
 * Check 1 — page wiring
 * ------------------------------------------------------------------------ */

function checkPageWiring(pages) {
  const missingScript = [];
  const missingInitApply = [];
  for (const page of pages) {
    if (PAGE_WIRING_ALLOWLIST.has(page)) continue;
    const html = fs.readFileSync(path.join(DASHBOARD_DIR, page), 'utf8');

    if (!I18N_SCRIPT_RE.test(html)) {
      missingScript.push(page);
      continue;
    }

    // Find every `WalaPlusI18n.init(...).then(` occurrence and balanced-extract
    // the body of `.then(...)`. The page passes if at least one of those bodies
    // contains `applyToDOM(...)`.
    INIT_THEN_RE.lastIndex = 0;
    let wired = false;
    let m;
    while ((m = INIT_THEN_RE.exec(html))) {
      const openIdx = m.index + m[0].length - 1;
      const body = extractBalanced(html, openIdx);
      if (body && /applyToDOM\s*\(/.test(body)) {
        wired = true;
        break;
      }
    }
    if (!wired) missingInitApply.push(page);
  }

  if (missingScript.length === 0 && missingInitApply.length === 0) {
    console.log(`✓ Page wiring (${pages.length - PAGE_WIRING_ALLOWLIST.size} page(s)) — every page loads /js/i18n.js and calls WalaPlusI18n.init().then(applyToDOM)`);
    return true;
  }

  if (missingScript.length) {
    fail(
      `Page wiring: ${missingScript.length} dashboard page(s) do not load /js/i18n.js`,
      [
        ...missingScript.map((f) => `dashboard/${f}`),
        '',
        'Fix: add `<script src="/js/i18n.js?v=1.0"></script>` to the <head> of each page.',
        'If the file is genuinely not a user-facing dashboard page (fragment, email preview, …),',
        'add its basename to PAGE_WIRING_ALLOWLIST in scripts/check-i18n.cjs with a one-line reason.',
      ],
    );
  }
  if (missingInitApply.length) {
    fail(
      `Page wiring: ${missingInitApply.length} dashboard page(s) load i18n.js but never run init().then(applyToDOM)`,
      [
        ...missingInitApply.map((f) => `dashboard/${f}`),
        '',
        'Fix: include this snippet in the page bootstrap script:',
        '    window.WalaPlusI18n.init().then(() => window.WalaPlusI18n.applyToDOM());',
        'Without it, every `data-i18n="..."` attribute on the page is ignored at runtime.',
      ],
    );
  }
  return false;
}

/* ---------------------------------------------------------------------------
 * Check 2 — reference coverage
 * ------------------------------------------------------------------------ */

function checkReferenceCoverage(pages, en, ar) {
  const missingEn = []; // [{page, key}]
  const missingAr = [];
  let totalRefs = 0;

  for (const page of pages) {
    const html = fs.readFileSync(path.join(DASHBOARD_DIR, page), 'utf8');
    let m;
    I18N_ATTR_RE.lastIndex = 0;
    while ((m = I18N_ATTR_RE.exec(html))) {
      totalRefs++;
      const key = m[1] || m[2]; // group 1 = double-quoted, group 2 = single-quoted
      if (typeof getDeep(en, key) !== 'string') missingEn.push({ page, key });
      if (typeof getDeep(ar, key) !== 'string') missingAr.push({ page, key });
    }
  }

  if (missingEn.length === 0 && missingAr.length === 0) {
    console.log(`✓ Reference coverage (${totalRefs} data-i18n reference(s)) — every key resolves to a string in en.json and ar.json`);
    return true;
  }

  if (missingEn.length) {
    fail(
      `Reference coverage: ${missingEn.length} data-i18n reference(s) missing from dashboard/i18n/en.json`,
      [
        ...missingEn.slice(0, 50).map(({ page, key }) => `dashboard/${page} :: "${key}"`),
        ...(missingEn.length > 50 ? [`... and ${missingEn.length - 50} more`] : []),
        '',
        'Fix: add the missing key under the appropriate namespace in dashboard/i18n/en.json',
        '(then add the matching Arabic translation in dashboard/i18n/ar.json — see Check 3).',
      ],
    );
  }
  if (missingAr.length) {
    fail(
      `Reference coverage: ${missingAr.length} data-i18n reference(s) missing from dashboard/i18n/ar.json`,
      [
        ...missingAr.slice(0, 50).map(({ page, key }) => `dashboard/${page} :: "${key}"`),
        ...(missingAr.length > 50 ? [`... and ${missingAr.length - 50} more`] : []),
        '',
        'Fix: add the Arabic translation for each key in dashboard/i18n/ar.json.',
        'The Arabic experience falls back to the last segment of the key when a translation is',
        'missing, which silently regresses the page for ar-locale users.',
      ],
    );
  }
  return false;
}

/* ---------------------------------------------------------------------------
 * Check 3 — tree parity (en.json ⇄ ar.json)
 * ------------------------------------------------------------------------ */

function checkTreeParity(en, ar) {
  const enFlat = flatten(en);
  const arFlat = flatten(ar);

  const onlyInEn = [];
  const onlyInAr = [];
  const typeMismatch = []; // {key, enType, arType}

  for (const [k, t] of enFlat) {
    if (!arFlat.has(k)) onlyInEn.push(k);
    else if (arFlat.get(k) !== t) typeMismatch.push({ key: k, enType: t, arType: arFlat.get(k) });
  }
  for (const k of arFlat.keys()) {
    if (!enFlat.has(k)) onlyInAr.push(k);
  }

  if (onlyInEn.length === 0 && onlyInAr.length === 0 && typeMismatch.length === 0) {
    console.log(`✓ Tree parity (${enFlat.size} key(s)) — en.json and ar.json have identical key trees`);
    return true;
  }

  if (onlyInEn.length) {
    fail(
      `Tree parity: ${onlyInEn.length} key(s) exist in en.json but NOT in ar.json`,
      [
        ...onlyInEn.slice(0, 50),
        ...(onlyInEn.length > 50 ? [`... and ${onlyInEn.length - 50} more`] : []),
        '',
        'Fix: add the matching Arabic translation for each key in dashboard/i18n/ar.json.',
      ],
    );
  }
  if (onlyInAr.length) {
    fail(
      `Tree parity: ${onlyInAr.length} key(s) exist in ar.json but NOT in en.json (orphans)`,
      [
        ...onlyInAr.slice(0, 50),
        ...(onlyInAr.length > 50 ? [`... and ${onlyInAr.length - 50} more`] : []),
        '',
        'Fix: either remove the orphan from dashboard/i18n/ar.json or add the missing English',
        'string to dashboard/i18n/en.json so the two trees stay in lockstep.',
      ],
    );
  }
  if (typeMismatch.length) {
    fail(
      `Tree parity: ${typeMismatch.length} key(s) have different shapes in en.json vs ar.json`,
      [
        ...typeMismatch
          .slice(0, 50)
          .map(({ key, enType, arType }) => `${key}  (en=${enType}, ar=${arType})`),
        ...(typeMismatch.length > 50 ? [`... and ${typeMismatch.length - 50} more`] : []),
        '',
        'Fix: ensure every leaf path resolves to a string on BOTH sides — e.g. if en.json has',
        '`{ status: "Active" }` then ar.json must also have a string at that path, not a sub-object.',
      ],
    );
  }
  return false;
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------ */

function main() {
  console.log('▶ WalaPlus i18n guardrail (scripts/check-i18n.cjs)\n');

  const pages = listHtmlPages();
  if (pages.length === 0) {
    console.error('ERROR: no HTML pages found under dashboard/');
    process.exit(2);
  }
  const en = readJson(EN_PATH);
  const ar = readJson(AR_PATH);

  const ok1 = checkPageWiring(pages);
  const ok2 = checkReferenceCoverage(pages, en, ar);
  const ok3 = checkTreeParity(en, ar);

  if (ok1 && ok2 && ok3) {
    console.log('\n✓ i18n guardrail PASS — dashboard pages, data-i18n references, and en/ar key trees are all in sync.');
    process.exit(0);
  }
  console.error('\n✗ i18n guardrail FAILED — see diagnostics above. Re-run with `npm run check:i18n` after fixing.');
  process.exit(1);
}

main();
