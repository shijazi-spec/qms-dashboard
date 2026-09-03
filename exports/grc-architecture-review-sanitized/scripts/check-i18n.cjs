#!/usr/bin/env node
/**
 * ExampleOrg i18n guardrail (Task #125)
 * ----------------------------------------------------------------------------
 * Prevents new dashboard pages or new `data-i18n` references from silently
 * regressing the Arabic experience. Three independent checks:
 *
 *   1. Page wiring         — every `dashboard/*.html` page (excluding the
 *                            allowlist below) must:
 *                              a. Load `/js/i18n.js` (any query string).
 *                              b. Call `ExampleOrgI18n.init().then(...)` with
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
const PUBLIC_DIR = path.join(ROOT, 'public');
const EN_PATH = path.join(DASHBOARD_DIR, 'i18n', 'en.json');
const AR_PATH = path.join(DASHBOARD_DIR, 'i18n', 'ar.json');

// Baseline file capturing the dynamic `ExampleOrgI18n.t(variable)` call sites
// that already existed when Task #295 introduced this gate. New dynamic call
// sites that are NOT listed in this baseline are flagged as a hard error so
// they can't slip in unnoticed amongst the long-standing wrappers (which
// remain ⚠ warnings). To intentionally accept a new dynamic call site, run
// `node scripts/check-i18n.cjs --update-baseline` and commit the diff.
const DYNAMIC_BASELINE_PATH = path.join(__dirname, 'i18n-dynamic-baseline.json');

// CLI flags
const CLI_ARGS = new Set(process.argv.slice(2));
const UPDATE_BASELINE = CLI_ARGS.has('--update-baseline');
// `--update-unused-baseline` regenerates `scripts/i18n-unused-baseline.json`
// (the orphan-key allow-list used by Check 6). Implies `--report-unused`.
const UPDATE_UNUSED_BASELINE = CLI_ARGS.has('--update-unused-baseline');

// HTML files in dashboard/ that are NOT user-facing dashboard pages and so
// do not need the i18n wiring. Keep this list tiny and explicit; every entry
// must be a basename, not a full path.
//
// (Currently empty — every existing dashboard/*.html page IS user-facing and
// already wires i18n. The mechanism exists so that future fragments / email
// previews / standalone snippets can opt out without weakening the rule for
// real pages.)
const PAGE_WIRING_ALLOWLIST = new Set([]);

// Same idea as `PAGE_WIRING_ALLOWLIST` but for `public/*.html` pages. Pages
// here legitimately do not need the i18n bootstrap (e.g. a static status page
// served before the JS bundle loads, or a server-rendered marketing page that
// is translated server-side). Keep this list tiny and explicit; every entry
// must be a basename, not a full path.
const PUBLIC_PAGE_WIRING_ALLOWLIST = new Set([]);

// Accept both `data-i18n="key"` and `data-i18n='key'` quoting. HTML allows
// either, and a future edit could mix them; missing a single-quoted reference
// would silently weaken the coverage check.
const I18N_ATTR_RE = /data-i18n(?:-[a-z]+)?=(?:"([^"]+)"|'([^']+)')/g;
const I18N_SCRIPT_RE = /<script[^>]+src=["'][^"']*\/js\/i18n\.js(?:\?[^"']*)?["'][^>]*>/i;
// Locator for the start of the i18n bootstrap chain. The body of `.then(...)`
// is then extracted with a balanced-paren scan so nested calls like
// `() => window.ExampleOrgI18n.applyToDOM()` are captured correctly.
const INIT_THEN_RE = /ExampleOrgI18n\s*\.\s*init\s*\([^)]*\)\s*\.\s*then\s*\(/g;

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
 * List `*.html` files directly under `public/`. Returns an empty array if
 * the directory does not exist — `public/` is optional in this project, so
 * its absence must NOT make the guardrail fail.
 */
function listPublicHtmlPages() {
  if (!fs.existsSync(PUBLIC_DIR)) return [];
  return fs
    .readdirSync(PUBLIC_DIR, { withFileTypes: true })
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

function checkPageWiring(pages, publicPages) {
  const missingScript = []; // {dir, page}
  const missingInitApply = [];

  // Build a unified work list so dashboard/ and public/ pages share the same
  // logic. `public/` is forward-looking — `listPublicHtmlPages()` returns []
  // when the directory does not exist, so this loop is a no-op today.
  const allPages = [
    ...pages.map((page) => ({
      dir: DASHBOARD_DIR,
      dirLabel: 'dashboard',
      page,
      allowlist: PAGE_WIRING_ALLOWLIST,
    })),
    ...publicPages.map((page) => ({
      dir: PUBLIC_DIR,
      dirLabel: 'public',
      page,
      allowlist: PUBLIC_PAGE_WIRING_ALLOWLIST,
    })),
  ];

  let auditedCount = 0;
  for (const { dir, dirLabel, page, allowlist } of allPages) {
    if (allowlist.has(page)) continue;
    auditedCount++;
    const html = fs.readFileSync(path.join(dir, page), 'utf8');

    if (!I18N_SCRIPT_RE.test(html)) {
      missingScript.push({ dirLabel, page });
      continue;
    }

    // Find every `ExampleOrgI18n.init(...).then(` occurrence and balanced-extract
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
    if (!wired) missingInitApply.push({ dirLabel, page });
  }

  if (missingScript.length === 0 && missingInitApply.length === 0) {
    console.log(`✓ Page wiring (${auditedCount} page(s)) — every page loads /js/i18n.js and calls ExampleOrgI18n.init().then(applyToDOM)`);
    return true;
  }

  if (missingScript.length) {
    fail(
      `Page wiring: ${missingScript.length} page(s) do not load /js/i18n.js`,
      [
        ...missingScript.map(({ dirLabel, page }) => `${dirLabel}/${page}`),
        '',
        'Fix: add `<script src="/js/i18n.js?v=1.0"></script>` to the <head> of each page.',
        'If the file is genuinely not a user-facing page (fragment, email preview, server-rendered',
        'marketing page, …), add its basename to PAGE_WIRING_ALLOWLIST (dashboard/) or',
        'PUBLIC_PAGE_WIRING_ALLOWLIST (public/) in scripts/check-i18n.cjs with a one-line reason.',
      ],
    );
  }
  if (missingInitApply.length) {
    fail(
      `Page wiring: ${missingInitApply.length} page(s) load i18n.js but never run init().then(applyToDOM)`,
      [
        ...missingInitApply.map(({ dirLabel, page }) => `${dirLabel}/${page}`),
        '',
        'Fix: include this snippet in the page bootstrap script:',
        '    window.ExampleOrgI18n.init().then(() => window.ExampleOrgI18n.applyToDOM());',
        'Without it, every `data-i18n="..."` attribute on the page is ignored at runtime.',
      ],
    );
  }
  return false;
}

/* ---------------------------------------------------------------------------
 * Check 2 — reference coverage
 * ------------------------------------------------------------------------ */

function checkReferenceCoverage(pages, publicPages, en, ar) {
  const missingEn = []; // [{dirLabel, page, key}]
  const missingAr = [];
  let totalRefs = 0;

  // Combine dashboard/ and public/ pages so a future `public/foo.html` with a
  // `data-i18n="ns.bogus"` attribute is caught by the same gate. `public/`
  // is optional — `listPublicHtmlPages()` returns [] when missing.
  const allPages = [
    ...pages.map((page) => ({ dir: DASHBOARD_DIR, dirLabel: 'dashboard', page })),
    ...publicPages.map((page) => ({ dir: PUBLIC_DIR, dirLabel: 'public', page })),
  ];

  for (const { dir, dirLabel, page } of allPages) {
    const html = fs.readFileSync(path.join(dir, page), 'utf8');
    let m;
    I18N_ATTR_RE.lastIndex = 0;
    while ((m = I18N_ATTR_RE.exec(html))) {
      totalRefs++;
      const key = m[1] || m[2]; // group 1 = double-quoted, group 2 = single-quoted
      if (typeof getDeep(en, key) !== 'string') missingEn.push({ dirLabel, page, key });
      if (typeof getDeep(ar, key) !== 'string') missingAr.push({ dirLabel, page, key });
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
        ...missingEn.slice(0, 50).map(({ dirLabel, page, key }) => `${dirLabel}/${page} :: "${key}"`),
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
        ...missingAr.slice(0, 50).map(({ dirLabel, page, key }) => `${dirLabel}/${page} :: "${key}"`),
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
 * Check 4 — Streaming-download SW dictionary parity (Task #200)
 *
 * `dashboard/streaming-download-sw.js` carries its own EN/AR string dictionary
 * because service workers can't easily fetch i18n JSON at runtime. To prevent
 * silent drift, we mirror those strings under `downloads.sw_expired_*` in
 * en.json / ar.json and require:
 *   - every (lang, key) the SW dictionary defines also exists as a string in
 *     the matching i18n JSON file, and
 *   - the SW string and the JSON string match exactly.
 *
 * The SW file is parsed structurally (not eval'd) to keep this guardrail safe
 * to run in CI without a service-worker runtime.
 * ------------------------------------------------------------------------ */

const SW_PATH = path.join(DASHBOARD_DIR, 'streaming-download-sw.js');
// Map of SW dictionary key -> i18n JSON key. Translator-facing names live
// under `downloads.sw_expired_*`; `dir` is layout metadata, not a string the
// translator needs to localise, so it's intentionally excluded.
const SW_KEY_TO_I18N_KEY = {
  title: 'downloads.sw_expired_title',
  heading: 'downloads.sw_expired_heading',
  body: 'downloads.sw_expired_body',
  retry_hint: 'downloads.sw_expired_retry_hint',
};

function parseSwStrings(swSource) {
  // SW_STRINGS = { en: { dir: 'ltr', title: '...', ... }, ar: { ... } }
  // We extract each lang block and then each `key: '<REDACTED_SECRET>'` pair. The values
  // are single-quoted strings without embedded single-quotes in this file —
  // if that ever stops being true, this parser will throw and the guardrail
  // will fail loudly, which is the desired behaviour.
  const out = {};
  const langRe = /(en|ar)\s*:\s*\{([\s\S]*?)\}\s*[,}]/g;
  // Anchor the search to the SW_STRINGS declaration so we don't pick up
  // unrelated object literals that happen to have an `en:` / `ar:` key.
  const startIdx = swSource.indexOf('var SW_STRINGS');
  if (startIdx === -1) {
    throw new Error('Could not find `var SW_STRINGS` in ' + SW_PATH);
  }
  const region = swSource.slice(startIdx, swSource.indexOf('};', startIdx) + 2);
  let match;
  while ((match = langRe.exec(region)) !== null) {
    const lang = match[1];
    const body = match[2];
    const fields = {};
    const fieldRe = /(\w+)\s*:\s*'((?:[^'\\]|\\.)*)'/g;
    let f;
    while ((f = fieldRe.exec(body)) !== null) {
      fields[f[1]] = f[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    }
    out[lang] = fields;
  }
  if (!out.en || !out.ar) {
    throw new Error('SW_STRINGS must define both `en` and `ar` blocks');
  }
  return out;
}

function lookupKey(tree, dotted) {
  return dotted.split('.').reduce(function (node, segment) {
    return node && typeof node === 'object' ? node[segment] : undefined;
  }, tree);
}

function checkSwDictionaryParity(en, ar) {
  console.log('\nStreaming-download SW dictionary parity:');
  let swSource;
  try {
    swSource = fs.readFileSync(SW_PATH, 'utf8');
  } catch (err) {
    console.error(`  ✗ Could not read ${path.relative(ROOT, SW_PATH)}: ${err.message}`);
    return false;
  }
  let swStrings;
  try {
    swStrings = parseSwStrings(swSource);
  } catch (err) {
    console.error(`  ✗ Could not parse SW_STRINGS in ${path.relative(ROOT, SW_PATH)}: ${err.message}`);
    return false;
  }
  const trees = { en, ar };
  const problems = [];
  ['en', 'ar'].forEach(function (lang) {
    Object.keys(SW_KEY_TO_I18N_KEY).forEach(function (swKey) {
      const i18nKey = SW_KEY_TO_I18N_KEY[swKey];
      const swValue = swStrings[lang][swKey];
      if (typeof swValue !== 'string') {
        problems.push(`SW dictionary missing string for ${lang}.${swKey} (expected to mirror ${i18nKey})`);
        return;
      }
      const jsonValue = lookupKey(trees[lang], i18nKey);
      if (typeof jsonValue !== 'string') {
        problems.push(`${lang === 'en' ? 'en.json' : 'ar.json'} is missing string at \`${i18nKey}\` (mirrors SW ${lang}.${swKey})`);
        return;
      }
      if (jsonValue !== swValue) {
        problems.push(`${lang === 'en' ? 'en.json' : 'ar.json'} \`${i18nKey}\` does not match SW ${lang}.${swKey}\n        SW:   ${JSON.stringify(swValue)}\n        JSON: ${JSON.stringify(jsonValue)}`);
      }
    });
  });
  if (problems.length === 0) {
    console.log(`  ✓ SW_STRINGS in streaming-download-sw.js matches downloads.sw_expired_* in en.json + ar.json`);
    return true;
  }
  console.error(`  ✗ SW dictionary drift detected (${problems.length} issue${problems.length === 1 ? '' : 's'}):`);
  problems.forEach(function (p) { console.error('      • ' + p); });
  console.error('');
  console.error('    Fix: keep SW_STRINGS in dashboard/streaming-download-sw.js byte-identical');
  console.error('    to the matching downloads.sw_expired_* keys in dashboard/i18n/{en,ar}.json.');
  return false;
}

/* ---------------------------------------------------------------------------
 * Check 5 — ExampleOrgI18n.t() key coverage in JS files and inline scripts
 * (Task #150, expanded in Task #296)
 *
 * Static string-literal calls like `ExampleOrgI18n.t('ns.key')` are extracted
 * from:
 *   - `dashboard/js/**\/*.js`  (recursive — subdirectories included)
 *   - inline <script> blocks in every `dashboard/*.html` page
 *   - inline <script> blocks in every `public/*.html` page (if present)
 *
 * Each key is then asserted to resolve to a string in BOTH en.json and
 * ar.json — the same guarantee the HTML attribute check (Check 2) provides
 * for `data-i18n` attributes.
 *
 * Dynamic key construction (e.g. `t('foo.' + bar)` or `t(variable)`) cannot
 * be statically verified and is surfaced as a non-blocking ⚠ warning so
 * reviewers know those branches need manual care.
 * ------------------------------------------------------------------------ */

/**
 * Return the concatenated text of every inline <script> block (i.e. <script>
 * tags WITHOUT a `src` attribute) found in an HTML string.
 */
/**
 * Given `src` whose first character is expected to be `open` (or pass an
 * earlier index via the regex match length), find the index of the matching
 * `close` character. Returns -1 if unbalanced or open not found at start.
 * Used to detect whether `WRAPPER(args)` is followed by `{` (method
 * shorthand declaration) versus a call expression.
 */
function findMatchingClose(src, open, close, _unused) {
  // Caller passes `src` already positioned right after the wrapper name,
  // i.e. starting with `(`. Walk forward tracking depth.
  if (src[0] !== open) return -1;
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractInlineScripts(html) {
  const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi;
  const blocks = [];
  let m;
  while ((m = INLINE_SCRIPT_RE.exec(html)) !== null) {
    blocks.push(m[1]);
  }
  return blocks.join('\n');
}

/**
 * Scan `source` for every `(window.)ExampleOrgI18n.t(...)` call and classify:
 *   - static  : first argument is a single- or double-quoted string literal
 *               (any content, no unescaped matching quote inside) — the key
 *               is extracted verbatim and validated against the JSON trees.
 *   - dynamic : anything else (variable, concatenation, template literal …)
 *               → cannot be statically verified; surface as a warning.
 *
 * Returns { staticKeys: [{key, source}], dynamicRefs: [{snippet, source}] }
 */
function extractTCalls(source, sourceName) {
  const staticKeys = [];
  const dynamicSnippets = new Set();
  // Wrapper aliases are local helpers that forward their first argument to
  // `ExampleOrgI18n.t(...)` (or are produced by `ExampleOrgI18n.t.bind(...)`).
  // Once we discover a wrapper name, every `WRAPPER('literal')` call site is
  // treated as if it were a direct `ExampleOrgI18n.t('literal')` call so the
  // guardrail can statically verify the key. Pre-Task #752, those call sites
  // were invisible because the script only looked for `ExampleOrgI18n.t(`.
  const wrapperNames = new Set();

  // 1. Detect `.t.bind(...)` aliases first — they are unambiguous forwarders.
  const BIND_RE = /(?:const|let|var)\s+(\w+)\s*=\s*[^;]*?(?:window\.)?ExampleOrgI18n\.t\.bind\s*\(/g;
  let bm;
  while ((bm = BIND_RE.exec(source)) !== null) {
    wrapperNames.add(bm[1]);
  }

  const T_CALL_RE = /(?:window\.)?ExampleOrgI18n\.t\s*\(\s*/g;
  let m;
  while ((m = T_CALL_RE.exec(source)) !== null) {
    const rest = source.slice(m.index + m[0].length);
    // Static: first argument is a complete quoted string literal — nothing
    // follows the closing quote except optional whitespace then `,` or `)`.
    // This correctly rejects concatenations like t('foo.' + bar) and template
    // literals, classifying them as dynamic instead.
    const staticMatch = /^(["'])((?:[^\\]|\\.)*?)\1/.exec(rest);
    if (staticMatch) {
      const afterStr = rest.slice(staticMatch[0].length).trimStart();
      if (afterStr.startsWith(',') || afterStr.startsWith(')')) {
        // True static literal: the key is fully known at authoring time.
        staticKeys.push({ key: staticMatch[2], source: sourceName });
        continue;
      }
      // Fall through to dynamic detection — the leading token was a string
      // but the full argument is an expression like t('foo.' + bar).
    }

    // Before flagging as dynamic, check whether this call is the body of a
    // local wrapper that simply forwards its parameter to ExampleOrgI18n.t.
    // If so, capture the wrapper name and skip — actual key verification
    // happens via the wrapper-call rescan below.
    const identMatch = /^([a-zA-Z_$][\w$]*)\s*[,)]/.exec(rest);
    if (identMatch) {
      const wrapperName = findEnclosingWrapper(source, m.index, identMatch[1]);
      if (wrapperName) {
        wrapperNames.add(wrapperName);
        continue;
      }
    }

    // Genuinely dynamic call (e.g. concatenation, template literal, or
    // a wrapper we couldn't statically associate with a name).
    const snippet = rest.slice(0, 60).split('\n')[0].trimEnd();
    dynamicSnippets.add(`t(${snippet}`);
  }

  // 2. Rescan for calls to any discovered wrapper alias and validate their
  //    first-argument key the same way as direct ExampleOrgI18n.t() calls.
  for (const wrapperName of wrapperNames) {
    const escaped = wrapperName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match `WRAPPER(`, `this.WRAPPER(`, or `obj.WRAPPER(` — but skip the
    // wrapper's own declaration (preceded by `const|let|var|function`).
    const wrapperCallRe = new RegExp(
      '(?:^|[^\\w$])([\\w$]+\\.)?(' + escaped + ')\\s*(\\()\\s*',
      'g',
    );
    let wm;
    while ((wm = wrapperCallRe.exec(source)) !== null) {
      // Skip declarations: `const _t = ...`, `function _t(...)`, etc.
      const tokenIdx = wm.index + wm[0].search(/\S/);
      const before = source.slice(Math.max(0, tokenIdx - 40), tokenIdx);
      if (/(?:const|let|var|function)\s+$/.test(before)) continue;

      const argStart = wm.index + wm[0].length;
      const rest = source.slice(argStart);
      // Skip method-shorthand declarations like `_t(key) {` — the parens
      // are the parameter list, not a call expression. We start the
      // balanced scan from the `(` (captured as group 3 in the regex).
      const openParenIdx = wm.index + wm[0].lastIndexOf('(');
      const fromOpen = source.slice(openParenIdx);
      const closeParenIdx = findMatchingClose(fromOpen, '(', ')');
      if (closeParenIdx >= 0) {
        const afterParen = fromOpen.slice(closeParenIdx + 1).trimStart();
        if (afterParen.startsWith('{')) continue;
      }
      const sm = /^(["'])((?:[^\\]|\\.)*?)\1/.exec(rest);
      if (sm) {
        const afterStr = rest.slice(sm[0].length).trimStart();
        if (afterStr.startsWith(',') || afterStr.startsWith(')')) {
          staticKeys.push({ key: sm[2], source: sourceName });
          continue;
        }
      }
      // Dynamic wrapper-alias call: still surface so it can be refactored
      // into a static lookup.
      const snippet = rest.slice(0, 60).split('\n')[0].trimEnd();
      dynamicSnippets.add(`${wrapperName}(${snippet}`);
    }
  }

  const dynamicRefs = [...dynamicSnippets].map((snippet) => ({ snippet, source: sourceName }));
  return { staticKeys, dynamicRefs };
}

/**
 * Given a `ExampleOrgI18n.t(<paramName>, ...)` call at `callIdx`, look back up
 * to ~600 characters in `source` for the enclosing function/arrow/method
 * declaration whose parameter list contains `paramName`. Returns the
 * declared name (so the call site can be classified as a wrapper forwarder)
 * or null if no enclosing declaration matches.
 */
function findEnclosingWrapper(source, callIdx, paramName) {
  const start = Math.max(0, callIdx - 600);
  const ctx = source.slice(start, callIdx);
  const escaped = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const paramInList = '(?:[^)]*?\\b' + escaped + '\\b[^)]*?)';

  const patterns = [
    // const/let/var NAME = ... (params with paramName) =>
    new RegExp(
      '(?:const|let|var)\\s+(\\w+)\\s*=\\s*[^;\\n]*?\\(' + paramInList + '\\)\\s*=>',
      'g',
    ),
    // const/let/var NAME = ... function (params with paramName) {
    new RegExp(
      '(?:const|let|var)\\s+(\\w+)\\s*=\\s*[^;]*?\\bfunction\\b[^(]*\\(' + paramInList + '\\)\\s*\\{',
      'g',
    ),
    // function NAME(params with paramName) {
    new RegExp(
      'function\\s+(\\w+)\\s*\\(' + paramInList + '\\)\\s*\\{',
      'g',
    ),
    // Method shorthand inside an object literal: NAME(params) {
    new RegExp(
      '(?:^|[\\s,{])(\\w+)\\s*\\(' + paramInList + '\\)\\s*\\{',
      'gm',
    ),
  ];

  // Reserved JS keywords that must not be misclassified as wrapper names
  // (the method-shorthand pattern would otherwise match things like
  // `function(k) {` and capture `function` as the wrapper alias).
  const RESERVED = new Set([
    'function', 'if', 'for', 'while', 'switch', 'do', 'return', 'throw',
    'try', 'catch', 'else', 'case', 'with', 'new', 'typeof', 'instanceof',
    'in', 'of', 'var', 'let', 'const', 'class', 'async', 'await', 'yield',
    'delete', 'void', 'this', 'super',
  ]);

  let bestName = null;
  let bestIdx = -1;
  for (const re of patterns) {
    let m;
    while ((m = re.exec(ctx)) !== null) {
      if (RESERVED.has(m[1])) continue;
      if (m.index > bestIdx) {
        bestIdx = m.index;
        bestName = m[1];
      }
    }
  }
  return bestName;
}

/**
 * Recursively collect all *.js file paths under `dir`, returning them as
 * paths relative to `DASHBOARD_DIR` (e.g. "js/navigation.js").
 */
function collectJsFiles(dir, base) {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const relPath = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results = results.concat(collectJsFiles(path.join(dir, entry.name), relPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(relPath);
    }
  }
  return results.sort();
}

function checkJsKeyCoverage(pages, publicPages, en, ar) {
  const allStatic = []; // [{key, source}]
  const allDynamic = []; // [{snippet, source}]

  // 1. Scan dashboard/js/**/*.js (recursively — `collectJsFiles` walks every
  //    subdirectory so a future `dashboard/js/qms/foo.js` is covered too).
  const jsDir = path.join(DASHBOARD_DIR, 'js');
  for (const relPath of collectJsFiles(jsDir, '')) {
    const src = fs.readFileSync(path.join(jsDir, relPath), 'utf8');
    const { staticKeys, dynamicRefs } = extractTCalls(src, `dashboard/js/${relPath}`);
    allStatic.push(...staticKeys);
    allDynamic.push(...dynamicRefs);
  }

  // 2. Scan inline <script> blocks in dashboard/*.html
  for (const page of pages) {
    const html = fs.readFileSync(path.join(DASHBOARD_DIR, page), 'utf8');
    const inlineJs = extractInlineScripts(html);
    if (!inlineJs.trim()) continue;
    const { staticKeys, dynamicRefs } = extractTCalls(inlineJs, `dashboard/${page} (inline <script>)`);
    allStatic.push(...staticKeys);
    allDynamic.push(...dynamicRefs);
  }

  // 3. Scan inline <script> blocks in public/*.html (Task #296). The public/
  //    directory is optional — `listPublicHtmlPages()` returns [] when it is
  //    absent, so this loop is a no-op in that case.
  for (const page of publicPages) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8');
    const inlineJs = extractInlineScripts(html);
    if (!inlineJs.trim()) continue;
    const { staticKeys, dynamicRefs } = extractTCalls(inlineJs, `public/${page} (inline <script>)`);
    allStatic.push(...staticKeys);
    allDynamic.push(...dynamicRefs);
  }

  // 4. Validate static keys against both JSON trees.
  const missingEn = [];
  const missingAr = [];
  const seen = new Set();

  for (const { key, source } of allStatic) {
    const dedupKey = `<REDACTED_SECRET>`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    if (typeof getDeep(en, key) !== 'string') missingEn.push({ source, key });
    if (typeof getDeep(ar, key) !== 'string') missingAr.push({ source, key });
  }

  const passed = missingEn.length === 0 && missingAr.length === 0;

  if (passed) {
    console.log(
      `✓ JS t() key coverage (${seen.size} unique static key reference(s)) — every ExampleOrgI18n.t() key resolves in en.json and ar.json`,
    );
  } else {
    if (missingEn.length) {
      fail(
        `JS t() key coverage: ${missingEn.length} ExampleOrgI18n.t() call(s) reference keys missing from dashboard/i18n/en.json`,
        [
          ...missingEn.slice(0, 50).map(({ source, key }) => `${source} :: "${key}"`),
          ...(missingEn.length > 50 ? [`... and ${missingEn.length - 50} more`] : []),
          '',
          'Fix: add the missing key in dashboard/i18n/en.json (and the matching ar.json entry).',
        ],
      );
    }
    if (missingAr.length) {
      fail(
        `JS t() key coverage: ${missingAr.length} ExampleOrgI18n.t() call(s) reference keys missing from dashboard/i18n/ar.json`,
        [
          ...missingAr.slice(0, 50).map(({ source, key }) => `${source} :: "${key}"`),
          ...(missingAr.length > 50 ? [`... and ${missingAr.length - 50} more`] : []),
          '',
          'Fix: add the Arabic translation for each key in dashboard/i18n/ar.json.',
          'The page silently falls back to the last key segment when the translation is missing.',
        ],
      );
    }
  }

  // 5. Surface dynamic key warnings.
  //
  //    Pre-existing dynamic call sites are tracked in
  //    `scripts/i18n-dynamic-baseline.json`; those remain non-blocking ⚠
  //    warnings so the long-standing `_t(k, v)` wrapper patterns don't drown
  //    out genuinely new entries. Dynamic call sites NOT in the baseline are
  //    treated as a hard error (✗) so a developer adding a new dynamic
  //    `t(variable)` call to a page must either:
  //       - rewrite it as a static `t('ns.key')` call (preferred), or
  //       - run `node scripts/check-i18n.cjs --update-baseline` to attest
  //         that the new dynamic call site is intentional and commit the
  //         updated baseline file.
  const dynamicResult = evaluateDynamicAgainstBaseline(allDynamic);

  if (UPDATE_BASELINE) {
    writeDynamicBaseline(dynamicResult.uniqueCurrent);
    console.log(
      `\n↻  Wrote ${path.relative(ROOT, DYNAMIC_BASELINE_PATH)} with ${dynamicResult.uniqueCurrent.length} dynamic call site(s).`,
    );
    return passed;
  }

  if (dynamicResult.known.length) {
    console.warn(
      `\n⚠  JS t() dynamic keys (baselined) — ${dynamicResult.known.length} long-standing ExampleOrgI18n.t() call(s) use non-literal keys and cannot be statically verified:`,
    );
    for (const { snippet, source } of dynamicResult.known) {
      console.warn(`    ${source}  →  ${snippet}`);
    }
    console.warn('    Review these manually when the surrounding key set changes.');
  }

  if (dynamicResult.added.length) {
    fail(
      `JS t() dynamic keys: ${dynamicResult.added.length} NEW ExampleOrgI18n.t(variable) call site(s) not in scripts/i18n-dynamic-baseline.json`,
      [
        ...dynamicResult.added.map(({ source, snippet }) => `${source}  →  ${snippet}`),
        '',
        'These dynamic keys cannot be statically verified, so they cannot be checked',
        'against en.json / ar.json. Prefer rewriting them as a static',
        '    ExampleOrgI18n.t("ns.exact_key")',
        'call so the guardrail can confirm the key resolves in both translation files.',
        '',
        'If the dynamic call is genuinely required (e.g. it bridges existing data-i18n',
        'attributes), accept it explicitly by running:',
        '    node scripts/check-i18n.cjs --update-baseline',
        'and committing the updated scripts/i18n-dynamic-baseline.json.',
      ],
    );
    return false;
  }

  if (dynamicResult.removed.length) {
    console.log(
      `\nℹ  ${dynamicResult.removed.length} baselined dynamic call site(s) no longer present — re-run with --update-baseline to prune scripts/i18n-dynamic-baseline.json:`,
    );
    for (const { source, snippet } of dynamicResult.removed) {
      console.log(`    ${source}  →  ${snippet}`);
    }
  }

  return passed;
}

/**
 * Load the dynamic-call baseline file. Returns an array of {source, snippet}
 * entries (possibly empty if the baseline doesn't exist yet). Throws on
 * malformed JSON so a corrupted baseline can't silently weaken the gate.
 */
function loadDynamicBaseline() {
  if (!fs.existsSync(DYNAMIC_BASELINE_PATH)) return [];
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(DYNAMIC_BASELINE_PATH, 'utf8'));
  } catch (err) {
    console.error(
      `ERROR: failed to parse ${path.relative(ROOT, DYNAMIC_BASELINE_PATH)}: ${err.message}`,
    );
    process.exit(2);
  }
  const entries = Array.isArray(raw && raw.entries) ? raw.entries : [];
  return entries
    .filter((e) => e && typeof e.source === 'string' && typeof e.snippet === 'string')
    .map((e) => ({ source: e.source, snippet: e.snippet }));
}

/**
 * Compare the dynamic call sites discovered in this run against the baseline
 * and bucket them into:
 *   - known   : present in both baseline and current scan (still ⚠ warnings)
 *   - added   : in current scan but NOT in baseline (✗ — block CI)
 *   - removed : in baseline but NOT in current scan (informational only)
 *
 * Also returns `uniqueCurrent` (deduped current scan) so --update-baseline
 * can write it back to disk.
 */
function evaluateDynamicAgainstBaseline(allDynamic) {
  const baseline = loadDynamicBaseline();
  const baselineIds = new Set(baseline.map((e) => `${e.source}::${e.snippet}`));

  const currentIds = new Set();
  const uniqueCurrent = [];
  for (const ref of allDynamic) {
    const id = `${ref.source}::${ref.snippet}`;
    if (currentIds.has(id)) continue;
    currentIds.add(id);
    uniqueCurrent.push(ref);
  }

  const known = uniqueCurrent.filter((ref) =>
    baselineIds.has(`${ref.source}::${ref.snippet}`),
  );
  const added = uniqueCurrent.filter(
    (ref) => !baselineIds.has(`${ref.source}::${ref.snippet}`),
  );
  const removed = baseline.filter((b) => !currentIds.has(`${b.source}::${b.snippet}`));

  return { known, added, removed, uniqueCurrent };
}

/**
 * Write the dynamic-call baseline file, sorted for stable diffs.
 */
function writeDynamicBaseline(uniqueCurrent) {
  const sorted = [...uniqueCurrent].sort((a, b) => {
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.snippet < b.snippet ? -1 : a.snippet > b.snippet ? 1 : 0;
  });
  const payload = {
    _comment:
      'Pre-existing dynamic ExampleOrgI18n.t(variable) call sites tracked by Task #295. ' +
      'Adding a new call site here is an explicit attestation that the dynamic key cannot ' +
      'be made static. Regenerate with: node scripts/check-i18n.cjs --update-baseline',
    entries: sorted,
  };
  fs.writeFileSync(DYNAMIC_BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

/* ---------------------------------------------------------------------------
 * Check 6 — unused keys (BLOCKING when --report-unused is passed; Task #345)
 *
 * Finds keys that exist in en.json / ar.json but are never referenced from:
 *   a. any `data-i18n*` attribute in a dashboard/*.html page, or
 *   b. any static string-literal `t('...')` call in dashboard/*.html or
 *      dashboard/js/*.js.
 *
 * Keys whose dotted path starts with a prefix listed in
 * `dashboard/i18n/.referenced-dynamically.json` are excluded from the report
 * because they are intentionally looked up at runtime via computed keys (e.g.
 * `t('dyn.risks.status.' + row.status)`).
 *
 * Pre-existing orphans (the long backlog the cleanup task is working through)
 * are tracked in `scripts/i18n-unused-baseline.json`. Each run buckets the
 * current orphans into:
 *   - known   : in baseline AND still unused           — ⚠ warning only
 *   - added   : NOT in baseline (i.e. brand new)       — ✗ blocks the gate
 *   - removed : in baseline but no longer unused/exist — informational note
 *               (re-run with --update-unused-baseline to prune the file)
 *
 * The check runs only when explicitly requested:
 *   node scripts/check-i18n.cjs --report-unused
 *   node scripts/check-i18n.cjs --update-unused-baseline
 *
 * `npm test` and `scripts/post-merge.sh` both pass `--report-unused`, so any
 * NEW orphan key fails the build. To intentionally accept a new orphan (e.g.
 * a key being staged for an in-flight feature), run --update-unused-baseline
 * and commit the diff.
 *
 * To register a new dynamic-lookup prefix instead, edit
 * `dashboard/i18n/.referenced-dynamically.json` (see the file header for the
 * dot-prefix convention). Keys covered by a dynamic prefix never appear in
 * the orphan report, so the baseline does not need to track them.
 * ------------------------------------------------------------------------ */

const DYNAMIC_ALLOWLIST_PATH = path.join(DASHBOARD_DIR, 'i18n', '.referenced-dynamically.json');
const UNUSED_BASELINE_PATH = path.join(__dirname, 'i18n-unused-baseline.json');
const JS_DIR = path.join(DASHBOARD_DIR, 'js');

// Captures every quoted string in source that looks like an i18n key: two or
// more lower-case / underscore segments joined by dots (e.g. `nav.brand`,
// `login.errors.auth_denied`). The match does not require the string to be
// the first argument of a t() call — keys are sometimes stored in config maps
// (e.g. `{ key: '<REDACTED_SECRET>', fallback: '...' }`) or passed as
// a second argument (e.g. `showLoginError(msg, 'login.errors.invalid_admin_key', ...)`).
//
// Keeping the pattern broad is intentional: false positives (non-i18n dotted
// strings that happen to match) only reduce the reported unused count, which
// is the conservative/safe direction for an advisory check.
const JS_STATIC_KEY_RE = /(?:'([a-z]\w*(?:\.[a-z]\w*)+(?:\.\w+)*)'|"([a-z]\w*(?:\.[a-z]\w*)+(?:\.\w+)*)")/g;

function listJsFiles() {
  try {
    return fs
      .readdirSync(JS_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.js'))
      .map((e) => path.join(JS_DIR, e.name))
      .sort();
  } catch {
    return [];
  }
}

function collectReferencedKeys(pages, publicPages) {
  const keys = new Set();

  // a0. Strings consumed by the streaming-download Service Worker. These
  //     keys are NOT referenced via data-i18n / static t() because the SW
  //     reads them out of its own SW_STRINGS dictionary (which Check 5
  //     enforces is byte-identical to the matching i18n keys). Without
  //     this seed they would be falsely flagged as orphans by Check 6.
  for (const i18nKey of Object.values(SW_KEY_TO_I18N_KEY)) {
    keys.add(i18nKey);
  }

  // a. data-i18n* attributes from all HTML pages (dashboard/ AND public/).
  //    `public/` is optional — `publicPages` is [] when the directory does
  //    not exist, so this is a no-op today.
  const allPages = [
    ...(pages || []).map((page) => ({ dir: DASHBOARD_DIR, page })),
    ...(publicPages || []).map((page) => ({ dir: PUBLIC_DIR, page })),
  ];
  for (const { dir, page } of allPages) {
    const html = fs.readFileSync(path.join(dir, page), 'utf8');
    let m;
    I18N_ATTR_RE.lastIndex = 0;
    while ((m = I18N_ATTR_RE.exec(html))) {
      keys.add(m[1] || m[2]);
    }
    // b. static t('key') calls inside the HTML <script> blocks
    JS_STATIC_KEY_RE.lastIndex = 0;
    while ((m = JS_STATIC_KEY_RE.exec(html))) {
      keys.add(m[1] || m[2]);
    }
  }

  // c. static t('key') calls AND data-i18n attributes in dashboard/js/*.js files
  //    (navigation.js and similar files generate HTML markup with data-i18n
  //    attributes inside template strings, so we must scan JS files too.)
  for (const jsPath of listJsFiles()) {
    const src = fs.readFileSync(jsPath, 'utf8');
    let m;
    JS_STATIC_KEY_RE.lastIndex = 0;
    while ((m = JS_STATIC_KEY_RE.exec(src))) {
      keys.add(m[1] || m[2]);
    }
    I18N_ATTR_RE.lastIndex = 0;
    while ((m = I18N_ATTR_RE.exec(src))) {
      keys.add(m[1] || m[2]);
    }
  }

  return keys;
}

function loadDynamicPrefixes() {
  try {
    const raw = JSON.parse(fs.readFileSync(DYNAMIC_ALLOWLIST_PATH, 'utf8'));
    if (!Array.isArray(raw.prefixes)) {
      console.error(
        `ERROR: ${path.relative(ROOT, DYNAMIC_ALLOWLIST_PATH)} must have a "prefixes" array.`,
      );
      process.exit(2);
    }
    return raw.prefixes;
  } catch (err) {
    // If the file is missing, proceed with an empty allowlist (more noisy but safe).
    if (err.code === 'ENOENT') return [];
    console.error(
      `ERROR: failed to read/parse ${path.relative(ROOT, DYNAMIC_ALLOWLIST_PATH)}: ${err.message}`,
    );
    process.exit(2);
  }
}

function isDynamicPrefix(key, prefixes) {
  return prefixes.some((p) => key === p || key.startsWith(p));
}

/**
 * Load the orphan-key baseline. Returns a Set of dotted keys (possibly empty
 * if the file does not yet exist). Throws on malformed JSON so a corrupted
 * baseline can't silently weaken the gate.
 */
function loadUnusedBaseline() {
  if (!fs.existsSync(UNUSED_BASELINE_PATH)) return new Set();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(UNUSED_BASELINE_PATH, 'utf8'));
  } catch (err) {
    console.error(
      `ERROR: failed to parse ${path.relative(ROOT, UNUSED_BASELINE_PATH)}: ${err.message}`,
    );
    process.exit(2);
  }
  const keys = Array.isArray(raw && raw.keys) ? raw.keys : [];
  return new Set(keys.filter((k) => typeof k === 'string'));
}

/**
 * Write the orphan-key baseline file, sorted for stable diffs.
 */
function writeUnusedBaseline(unusedKeys) {
  const sorted = [...unusedKeys].sort();
  const payload = {
    _comment:
      'Pre-existing orphan i18n keys tracked by Task #345 — keys present in ' +
      'dashboard/i18n/{en,ar}.json that are NOT referenced by any data-i18n ' +
      'attribute or static ExampleOrgI18n.t("...") call. Adding a key here is an ' +
      'explicit attestation that the orphan is intentional (e.g. staged for an ' +
      'in-flight feature). Prefer deleting the orphan from en.json + ar.json, or ' +
      'registering a new dynamic-lookup prefix in ' +
      'dashboard/i18n/.referenced-dynamically.json. Regenerate this file with: ' +
      'node scripts/check-i18n.cjs --update-unused-baseline',
    keys: sorted,
  };
  fs.writeFileSync(UNUSED_BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function checkUnusedKeys(pages, publicPages, en) {
  const referencedKeys = collectReferencedKeys(pages, publicPages);
  const dynamicPrefixes = loadDynamicPrefixes();
  const enFlat = flatten(en);

  const unused = [];
  for (const [key, type] of enFlat) {
    if (type !== '<leaf>') continue; // only report leaf strings, not branch markers
    if (referencedKeys.has(key)) continue;
    if (isDynamicPrefix(key, dynamicPrefixes)) continue;
    unused.push(key);
  }

  if (UPDATE_UNUSED_BASELINE) {
    writeUnusedBaseline(unused);
    console.log(
      `\n↻  Wrote ${path.relative(ROOT, UNUSED_BASELINE_PATH)} with ${unused.length} orphan key(s).`,
    );
    return true;
  }

  const baseline = loadUnusedBaseline();
  const added = unused.filter((k) => !baseline.has(k));
  const known = unused.filter((k) => baseline.has(k));
  const removed = [...baseline].filter((k) => !unused.includes(k)).sort();

  if (unused.length === 0) {
    console.log(
      `✓ Unused-key scan — every leaf in en.json is referenced by a data-i18n attribute or a static t('...') call`,
    );
    if (removed.length) {
      console.log(
        `\nℹ  ${removed.length} baselined orphan key(s) are no longer unused — re-run with --update-unused-baseline to prune ${path.relative(ROOT, UNUSED_BASELINE_PATH)}.`,
      );
    }
    return true;
  }

  if (known.length) {
    console.log(
      `\n⚠  Unused-key report (baselined) — ${known.length} pre-existing orphan key(s) in en.json with no detected reference:`,
    );
    console.log(
      '   These are tracked in scripts/i18n-unused-baseline.json and do NOT block CI.',
    );
    console.log(
      '   Cleanup task: delete the orphan from en.json + ar.json (or register a',
    );
    console.log(
      `   new dynamic-lookup prefix in ${path.relative(ROOT, DYNAMIC_ALLOWLIST_PATH)}),`,
    );
    console.log('   then run `node scripts/check-i18n.cjs --update-unused-baseline`.');
    console.log('');
    for (const k of known.slice(0, 100)) {
      console.log(`   ⚠  ${k}`);
    }
    if (known.length > 100) {
      console.log(`   … and ${known.length - 100} more`);
    }
  }

  if (removed.length) {
    console.log(
      `\nℹ  ${removed.length} baselined orphan key(s) are no longer unused — re-run with --update-unused-baseline to prune ${path.relative(ROOT, UNUSED_BASELINE_PATH)}:`,
    );
    for (const k of removed.slice(0, 20)) {
      console.log(`   ${k}`);
    }
    if (removed.length > 20) {
      console.log(`   … and ${removed.length - 20} more`);
    }
  }

  if (added.length === 0) {
    return true;
  }

  fail(
    `Unused-key scan: ${added.length} NEW orphan key(s) in dashboard/i18n/en.json + ar.json (Task #345)`,
    [
      ...added.slice(0, 50),
      ...(added.length > 50 ? [`... and ${added.length - 50} more`] : []),
      '',
      'These keys exist in en.json / ar.json but are NOT referenced by any',
      'data-i18n attribute or static ExampleOrgI18n.t("...") call.',
      '',
      'Fix one of:',
      '  1. Delete the unused key(s) from dashboard/i18n/en.json AND',
      '     dashboard/i18n/ar.json (preferred — keeps the dictionary lean).',
      '  2. If the key is looked up at runtime via a computed key like',
      `     t('foo.' + bar), register the prefix in`,
      `     ${path.relative(ROOT, DYNAMIC_ALLOWLIST_PATH)}`,
      '     so future orphan scans skip it.',
      '  3. If the key is genuinely staged for an in-flight feature and must',
      '     ship before the wiring lands, attest to it explicitly by running:',
      '         node scripts/check-i18n.cjs --update-unused-baseline',
      `     and committing the updated ${path.relative(ROOT, UNUSED_BASELINE_PATH)}.`,
    ],
  );
  return false;
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------ */

function main() {
  console.log('▶ ExampleOrg i18n guardrail (scripts/check-i18n.cjs)\n');

  // --update-unused-baseline implies --report-unused (we can't write a fresh
  // baseline without first computing the orphan set).
  const reportUnused = CLI_ARGS.has('--report-unused') || UPDATE_UNUSED_BASELINE;

  const pages = listHtmlPages();
  if (pages.length === 0) {
    console.error('ERROR: no HTML pages found under dashboard/');
    process.exit(2);
  }
  const publicPages = listPublicHtmlPages();
  const en = readJson(EN_PATH);
  const ar = readJson(AR_PATH);

  const ok1 = checkPageWiring(pages, publicPages);
  const ok2 = checkReferenceCoverage(pages, publicPages, en, ar);
  const ok3 = checkTreeParity(en, ar);
  const ok4 = checkSwDictionaryParity(en, ar);
  const ok5 = checkJsKeyCoverage(pages, publicPages, en, ar);

  let ok6 = true;
  if (reportUnused) {
    console.log('\n--- Unused-key scan (Task #345 — blocks on NEW orphans) ---');
    ok6 = checkUnusedKeys(pages, publicPages, en);
  }

  if (ok1 && ok2 && ok3 && ok4 && ok5 && ok6) {
    console.log(
      '\n✓ i18n guardrail PASS — dashboard pages, data-i18n references, en/ar key trees, SW dictionary, JS t() calls' +
        (reportUnused ? ', and orphan-key budget' : '') +
        ' are all in sync.',
    );
    process.exit(0);
  }
  console.error('\n✗ i18n guardrail FAILED — see diagnostics above. Re-run with `node scripts/check-i18n.cjs` after fixing.');
  process.exit(1);
}

main();
