/**
 * RTL guardrail (Tasks #315 / #628) — blocks new physical-direction Tailwind
 * classes from re-entering the highest-impact spots on `dashboard/*.html`
 * pages:
 *
 *   • `<th>` text-align (`text-left`, `text-right`)
 *   • Stat-card accent borders (`border-l-4`, `border-r-4`)
 *   • `<button>` icon-gutter margins (`ml-<n>`, `mr-<n>`)
 *   • Flex / grid item spacing (`space-x-<n>`)
 *   • Corner radii (`rounded-l-*`, `rounded-r-*`)
 *   • Non-`<th>` text-align on layout elements (`<td>`, `<div>`, `<p>`,
 *     `<li>`, `<span>`, …)
 *   • Inline padding (`pl-*`, `pr-*`) on any element (Task #687)
 *   • Inline margin (`ml-*`, `mr-*`) on any non-`<button>` element
 *     (`<button>` is owned by `buttonMlMr`) (Task #687)
 *   • Inline border width (`border-l-*`, `border-r-*`, bare
 *     `border-l` / `border-r`) other than `-4` (which `borderLR4`
 *     owns) on any element (Task #687)
 *   • Positional insets (`left-*`, `right-*`) on any element
 *     (Task #687)
 *
 * The dashboard supports Arabic via `html[dir="rtl"]` set by
 * `dashboard/js/i18n.js`. Per the "RTL Layout Convention" section of
 * `replit.md`, layout details that should mirror in RTL must be expressed
 * with CSS logical-direction utilities (`text-start`, `border-s-4`, `ms-2`,
 * `me-2`, `gap-2`, `rounded-s-lg`, …). Physical-direction classes silently
 * pin the layout to LTR and break the Arabic experience the next time a
 * user loads the page. Without a guardrail, a routine edit to a new
 * dashboard page can reintroduce one.
 *
 * This test wraps `scripts/check-rtl-classes.cjs` so it runs on every
 * `npm test` invocation (which is also the CI test command). The Node.js
 * script is the source of truth for the rules + per-rule allowlist; this
 * file just makes sure the integration-test runner picks it up and that
 * every rule actually fires when its pattern lands in a fresh,
 * non-allowlisted page.
 *
 * Run:  npx tsx tests/noPhysicalDirectionClasses.test.ts
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `new URL(".", import.meta.url).pathname` returns `/D:/...` on Windows,
// which `path.resolve` then double-drives into `D:\D:\...` (ENOENT).
// fileURLToPath normalises both POSIX and Windows. Same fix that was
// applied to tests/runIntegrationTests.ts.
const TESTS_DIR_URL = new URL(".", import.meta.url);
const SCRIPT = path.resolve(
  fileURLToPath(TESTS_DIR_URL),
  "..",
  "scripts",
  "check-rtl-classes.cjs",
);

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

console.log("\n▶ RTL physical-direction guardrail (scripts/check-rtl-classes.cjs)\n");

// ---------------------------------------------------------------------------
// Test 1 — current dashboard/ tree must pass the guardrail.
// ---------------------------------------------------------------------------
const result = spawnSync("node", [SCRIPT], {
  stdio: "pipe",
  encoding: "utf8",
});

if (result.error) {
  console.error(`  ✗ Failed to execute guardrail script: ${result.error.message}`);
  failed++;
} else {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    if (stdout.trim()) console.log(stdout.trimEnd());
    if (stderr.trim()) console.error(stderr.trimEnd());
  }
  assert(
    result.status === 0,
    "no forbidden physical-direction classes (text-left/right, border-l-4/r-4, <button> ml-/mr-, space-x-, rounded-l-/r-) in dashboard/*.html",
  );
}

// ---------------------------------------------------------------------------
// Test 2 — negative test: synthesise one violation flavour per rule in a
// temp dashboard tree, copy the checker script next to it, and assert it
// fails with every rule ID reported. This proves the rule engine actually
// fires (not just that today's tree happens to be clean) and that the
// per-line opt-out + <script>-skip behaviour still hold.
//
// The script computes its scan root from `__dirname/..` so copying it into
// `<tmp>/scripts/` makes it scan `<tmp>/dashboard/` automatically — no env
// override or CLI flag needed.
// ---------------------------------------------------------------------------
const tmpRoot = mkdtempSync(path.join(tmpdir(), "rtl-guard-"));
// The script `require("acorn")`s for the JS-string pass (Task #743). When
// the script is copied to a tmp dir, Node's normal `node_modules`
// resolution can't find acorn — point it back at the real repo's
// `node_modules` via NODE_PATH so the copied script behaves like the
// in-repo one.
const REPO_NODE_MODULES = path.resolve(
  fileURLToPath(TESTS_DIR_URL),
  "..",
  "node_modules",
);
const TMP_RUN_ENV = { ...process.env, NODE_PATH: REPO_NODE_MODULES };
try {
  const tmpScripts = path.join(tmpRoot, "scripts");
  const tmpDashboard = path.join(tmpRoot, "dashboard");
  // Mirror the on-disk layout the script expects: scripts/ sits next to
  // dashboard/, and __dirname/.. resolves to the temp root.
  const fs = await import("node:fs");
  fs.mkdirSync(tmpScripts);
  fs.mkdirSync(tmpDashboard);
  fs.copyFileSync(SCRIPT, path.join(tmpScripts, "check-rtl-classes.cjs"));
  // A brand-new (non-allowlisted) page that violates every rule.
  writeFileSync(
    path.join(tmpDashboard, "synthetic-new-page.html"),
    [
      "<!doctype html><html><body>",
      // Rule 1 (thTextAlign): <th> with text-left
      '<table><thead><tr><th class="px-2 text-left">Name</th></tr></thead></table>',
      // Rule 2 (borderLR4): any element with border-l-4
      '<div class="bg-white border-l-4 border-blue-500 p-4">card</div>',
      // Rule 3 (buttonMlMr): <button> with mr-<n>
      '<button class="text-blue-600 mr-2">Edit</button>',
      // Rule 3 (keyword variant): <button> with ml-auto — must also fire.
      '<button class="text-blue-600 ml-auto">Save</button>',
      // Rule 3 (arbitrary value variant): <button> with mr-[3px] — must also fire.
      '<button class="text-blue-600 mr-[3px]">Pin</button>',
      // Rule 4 (spaceX): any element with space-x-<n> on a flex container.
      '<div class="flex space-x-2">a b</div>',
      // Rule 4 (keyword variant): space-x-px must also fire.
      '<div class="flex space-x-px">a b</div>',
      // Rule 4 (arbitrary value variant): space-x-[5px] must also fire.
      '<div class="flex space-x-[5px]">a b</div>',
      // Rule 5 (roundedLR): rounded-l-<value>
      '<img class="rounded-l-lg" alt="left" />',
      // Rule 5 (numeric variant): rounded-r-2 must also fire.
      '<div class="rounded-r-2 bg-white">card</div>',
      // Rule 5 (bare shorthand): rounded-l (no value) must also fire.
      '<div class="rounded-l bg-white">card</div>',
      // Rule 6 (textLRNonTh): non-<th> elements with text-left / text-right.
      '<td class="px-2 text-left">Cell</td>',
      '<div class="text-right">Total: $0</div>',
      // Rule 7 (plPr, Task #687): pl-/pr- padding on any element.
      '<div class="pl-4 bg-white">left-padded</div>',
      // pl/pr keyword + arbitrary variants must also fire.
      '<input class="pr-px border" />',
      '<span class="pl-[3px]">tight</span>',
      // Rule 8 (mlMrAll, Task #687): ml-/mr- on a non-<button> element
      // (a <span> here). Must fire under mlMrAll, NOT buttonMlMr.
      '<span class="ml-3 text-sm">label</span>',
      '<div class="mr-auto">push-end</div>',
      '<label class="mr-[6px]">checkbox</label>',
      // Rule 9 (borderLR, Task #687): border-l-/border-r- with widths
      // OTHER than 4 (which borderLR4 owns), and the bare 1px shorthand.
      '<aside class="border-r bg-white">sidebar</aside>',
      '<div class="border-l-2 border-blue-500">card</div>',
      '<section class="border-r-8">heavy</section>',
      // Rule 10 (insetLR, Task #687): left-/right- positional inset on
      // an absolutely / fixed positioned element.
      '<div class="absolute right-4 top-2">badge</div>',
      '<svg class="absolute left-3 top-1/2"></svg>',
      '<button class="fixed right-[12px] bottom-2">Help</button>',
      // Sentinel A: same `text-left` on a <th> on its own MUST hit the
      // thTextAlign rule but MUST NOT *also* hit the textLRNonTh rule
      // (the rules are mutually exclusive on the tag axis).
      '<table><tr><th class="text-left">Header-only</th></tr></table>',
      // Sentinel B: a JS string that mentions the patterns inside <script>',
      // must NOT trigger any of the static-HTML rule IDs (the tokeniser
      // skips script bodies on the static-HTML pass). Per Task #742 the
      // companion script-block pass DOES inspect this body and reports
      // its findings as warnings under the `script*` rule IDs, which is
      // verified separately below.
      "<script>const s = 'border-l-4 mr-2 text-left space-x-2 rounded-l-lg';</script>",
      // Sentinel B2 (Task #742): a JS template string with physical-
      // direction Tailwind tokens — must trigger the companion script-
      // block pass (warnings only, exit code unchanged).
      "<script>",
      "  function row(label) {",
      "    return `<tr><td class=\"py-1 pr-4 text-right\">${label}</td>` +",
      "           `<td class=\"border-l-4 ml-2\"><button class=\"mr-2 rounded-l-lg\">x</button></td>` +",
      "           `<td class=\"flex space-x-2 left-0 right-0 float-left\"></td></tr>`;",
      "  }",
      "</script>",
      // Sentinel C: opt-out marker should suppress the violation on its line.
      '<button class="text-red-600 ml-2">Cancel</button> <!-- rtl-safe-physical: docked in a fixed LTR utility row -->',
      // Sentinel D: `rounded-lg` (radius-large, NOT a directional class)
      // MUST NOT trigger the roundedLR rule.
      '<div class="rounded-lg bg-white">round-large card</div>',
      "</body></html>",
    ].join("\n"),
  );

  const negative = spawnSync(
    "node",
    [path.join(tmpScripts, "check-rtl-classes.cjs")],
    { stdio: "pipe", encoding: "utf8", cwd: tmpRoot, env: TMP_RUN_ENV },
  );

  const out = `${negative.stdout ?? ""}\n${negative.stderr ?? ""}`;
  assert(
    negative.status === 1,
    "guardrail exits 1 when a fresh dashboard page introduces violations",
  );
  assert(out.includes("[thTextAlign]"), "negative test surfaces the thTextAlign rule");
  assert(out.includes("[borderLR4]"), "negative test surfaces the borderLR4 rule");
  assert(out.includes("[buttonMlMr]"), "negative test surfaces the buttonMlMr rule");
  assert(out.includes("[spaceX]"), "negative test surfaces the spaceX rule");
  assert(out.includes("[roundedLR]"), "negative test surfaces the roundedLR rule");
  assert(out.includes("[textLRNonTh]"), "negative test surfaces the textLRNonTh rule");
  // Task #687 — four new rule families.
  assert(out.includes("[plPr]"), "negative test surfaces the plPr rule");
  assert(out.includes("[mlMrAll]"), "negative test surfaces the mlMrAll rule");
  assert(out.includes("[borderLR]"), "negative test surfaces the borderLR rule");
  assert(out.includes("[insetLR]"), "negative test surfaces the insetLR rule");
  // plPr must catch numeric, keyword (`px`), and arbitrary-value variants.
  const plPrCount = (out.match(/\[plPr\]/g) ?? []).length;
  assert(
    plPrCount >= 3,
    `plPr matches numeric (pl-4), keyword (pr-px), and arbitrary (pl-[3px]) variants (saw ${plPrCount}/3)`,
  );
  // mlMrAll must catch numeric, keyword (`auto`), and arbitrary-value variants.
  const mlMrAllCount = (out.match(/\[mlMrAll\]/g) ?? []).length;
  assert(
    mlMrAllCount >= 3,
    `mlMrAll matches numeric (ml-3), keyword (mr-auto), and arbitrary (mr-[6px]) variants (saw ${mlMrAllCount}/3)`,
  );
  // borderLR must catch bare shorthand, numeric < 4, and numeric > 4.
  const borderLRCount = (out.match(/\[borderLR\]/g) ?? []).length;
  assert(
    borderLRCount >= 3,
    `borderLR matches bare (border-r), small numeric (border-l-2), and large numeric (border-r-8) variants (saw ${borderLRCount}/3)`,
  );
  // insetLR must catch numeric, fractional (none here — using arbitrary),
  // and arbitrary-value variants. We use right-4, left-3, right-[12px].
  const insetLRCount = (out.match(/\[insetLR\]/g) ?? []).length;
  assert(
    insetLRCount >= 3,
    `insetLR matches numeric (right-4), numeric (left-3), and arbitrary (right-[12px]) variants (saw ${insetLRCount}/3)`,
  );
  // mlMrAll and buttonMlMr must be tag-disjoint: a <button class="ml-2">
  // hits buttonMlMr only and never also fires under mlMrAll.
  assert(
    !/Cancel.*\[mlMrAll\]/s.test(out),
    "mlMrAll does NOT double-fire on <button> elements (buttonMlMr owns those)",
  );
  // borderLR must NOT misfire on `border-l-4` / `border-r-4` (borderLR4
  // owns those). The negative-test page contains a `border-l-4` element
  // for the borderLR4 rule; verify the borderLR rule never reports a
  // matched token equal to `border-l-4` / `border-r-4`. Each violation
  // formats the matched token in backticks (`...`) on the message line.
  const borderLRMessageLines = out
    .split("\n")
    .filter((l) => l.includes("[borderLR]") && !l.includes("[borderLR4]"));
  assert(
    !borderLRMessageLines.some((l) => /`border-[lr]-4`/.test(l)),
    "borderLR does NOT misfire on `border-l-4` / `border-r-4` (borderLR4 owns those)",
  );
  // borderLR must NOT misfire on `border-blue-500` (color, not
  // direction). The matched token is in backticks on the message line;
  // colour utilities should never appear there.
  assert(
    !borderLRMessageLines.some((l) => /`border-(?:blue|red|green|gray|slate|zinc|neutral|stone|orange|amber|yellow|lime|emerald|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose)-/.test(l)),
    "borderLR does NOT misfire on color utilities like `border-blue-500`",
  );
  // Confirm the buttonMlMr regex catches numeric, keyword, and arbitrary-value
  // Tailwind variants — not just `mr-<digits>`.
  const buttonViolationCount = (out.match(/\[buttonMlMr\]/g) ?? []).length;
  assert(
    buttonViolationCount >= 3,
    `buttonMlMr matches numeric (mr-2), keyword (ml-auto), and arbitrary (mr-[3px]) variants (saw ${buttonViolationCount}/3)`,
  );
  // Same coverage promise for spaceX: numeric, keyword (`px`), arbitrary.
  const spaceXViolationCount = (out.match(/\[spaceX\]/g) ?? []).length;
  assert(
    spaceXViolationCount >= 3,
    `spaceX matches numeric (space-x-2), keyword (space-x-px), and arbitrary (space-x-[5px]) variants (saw ${spaceXViolationCount}/3)`,
  );
  // Same coverage promise for roundedLR: keyword (`lg`), numeric, bare.
  const roundedLRViolationCount = (out.match(/\[roundedLR\]/g) ?? []).length;
  assert(
    roundedLRViolationCount >= 3,
    `roundedLR matches keyword (rounded-l-lg), numeric (rounded-r-2), and bare (rounded-l) variants (saw ${roundedLRViolationCount}/3)`,
  );
  // Same coverage promise for textLRNonTh: <td> and <div>.
  const textLRNonThCount = (out.match(/\[textLRNonTh\]/g) ?? []).length;
  assert(
    textLRNonThCount >= 2,
    `textLRNonTh matches <td> and <div> with text-left / text-right (saw ${textLRNonThCount}/2)`,
  );
  // The opt-out marker line MUST NOT appear in violations.
  assert(
    !out.includes("rtl-safe-physical: docked"),
    "rtl-safe-physical opt-out marker suppresses the violation on its line",
  );
  // Script bodies MUST NOT be scanned by any of the STATIC-HTML rule IDs
  // (the tokeniser still skips them on that pass — only the companion
  // script-block pass added in Task #742 inspects them).
  assert(
    !/script.*\[(thTextAlign|borderLR4|buttonMlMr|spaceX|roundedLR|textLRNonTh)\]/.test(out),
    "<script> body contents are not scanned by the static-HTML rule pass",
  );
  // Companion script-block pass (Task #742) MUST report findings for the
  // physical-direction tokens inside Sentinel B2's JS template strings.
  // These appear under the `script*` rule IDs and are warnings only —
  // they do not affect the exit code (which is still 1, driven by the
  // static-HTML violations above).
  assert(
    out.includes("[scriptTextLR]"),
    "script-block companion pass surfaces text-left/text-right inside JS templates",
  );
  assert(
    out.includes("[scriptMlMr]"),
    "script-block companion pass surfaces ml-/mr- inside JS templates",
  );
  assert(
    out.includes("[scriptPlPr]"),
    "script-block companion pass surfaces pl-/pr- inside JS templates",
  );
  assert(
    out.includes("[scriptBorderLR]"),
    "script-block companion pass surfaces border-l-/border-r- inside JS templates",
  );
  assert(
    out.includes("[scriptSpaceX]"),
    "script-block companion pass surfaces space-x- inside JS templates",
  );
  assert(
    out.includes("[scriptRoundedLR]"),
    "script-block companion pass surfaces rounded-l-/rounded-r- inside JS templates",
  );
  assert(
    out.includes("[scriptInsetLR]"),
    "script-block companion pass surfaces left-/right- positional insets inside JS templates",
  );
  assert(
    out.includes("[scriptFloatLR]"),
    "script-block companion pass surfaces float-left/float-right inside JS templates",
  );
  // `rounded-lg` (radius-large) MUST NOT be flagged as a directional class.
  assert(
    !/round-large card/.test(out),
    "roundedLR rule does NOT misfire on `rounded-lg` (size, not direction)",
  );
  // The two text-align rules are tag-disjoint: a `<th>` with `text-left`
  // hits thTextAlign exactly once and never also hits textLRNonTh.
  assert(
    !/Header-only.*\[textLRNonTh\]/s.test(out) &&
      !/\[textLRNonTh\].*Header-only/s.test(out),
    "textLRNonTh does NOT double-fire on <th> elements (thTextAlign owns those)",
  );

  // -------------------------------------------------------------------------
  // Test 3 (Task #743) — JS-string pass: synthesise a fresh page whose ONLY
  // violations live inside `<script>` template strings (not in static HTML
  // tags), and assert the new pass surfaces every JS-rule ID. Also asserts
  // the negative cases that distinguish the JS pass from the HTML pass:
  //   • literals inside JS comments don't fire (acorn strips comments)
  //   • the per-line opt-out marker still works on JS strings
  //   • non-JS <script type="application/json"> bodies are NOT scanned
  //   • bare identifiers / regex literals / numbers don't trip rules
  //   • unparseable JS still gets a regex-fallback sweep (no silent drop)
  // -------------------------------------------------------------------------
  const fs2 = await import("node:fs");
  fs2.writeFileSync(
    path.join(tmpDashboard, "synthetic-js-page.html"),
    [
      "<!doctype html><html><body>",
      "<div id=\"root\"></div>",
      "<script>",
      // jsTextLR — `text-right` inside a string literal (rendered as a <td>).
      "  const cell = '<td class=\"px-4 text-right\">Total</td>';",
      // jsBorderLR4 — `border-l-4` inside a template-literal quasi.
      "  const card = `<div class=\"border-l-4 border-blue-500 p-4\">card</div>`;",
      // jsMlMr — `mr-2` inside a string literal building a <button>.
      "  const btn = '<button class=\"text-blue-600 mr-2\">Edit</button>';",
      // jsMlMr (keyword + arbitrary variants) — must also fire.
      "  const btn2 = '<button class=\"ml-auto\">Save</button>';",
      "  const btn3 = '<button class=\"mr-[3px]\">Pin</button>';",
      // jsSpaceX — `space-x-2` inside a flex container template string.
      "  const flex = `<div class=\"flex space-x-2\">a b</div>`;",
      // jsRoundedLR — `rounded-l-lg` inside a string literal.
      "  const img = '<img class=\"rounded-l-lg\" alt=\"left\" />';",
      // jsPlPr (Task #687) — `pl-4` / `pr-px` / arbitrary inside JS strings.
      "  const pad = '<div class=\"pl-4\">left-padded</div>';",
      "  const pad2 = `<input class=\"pr-px\" />`;",
      "  const pad3 = '<span class=\"pl-[3px]\">tight</span>';",
      // jsBorderLR (Task #687) — bare shorthand + non-`-4` widths.
      "  const aside = '<aside class=\"border-r bg-white\">sidebar</aside>';",
      "  const card = `<div class=\"border-l-2 border-blue-500\">card</div>`;",
      "  const heavy = '<section class=\"border-r-8\">heavy</section>';",
      // jsInsetLR (Task #687) — left-/right- positional insets.
      "  const badge = '<div class=\"absolute right-4 top-2\">badge</div>';",
      "  const ico = `<svg class=\"absolute left-3 top-1/2\"></svg>`;",
      "  const help = '<button class=\"fixed right-[12px] bottom-2\">Help</button>';",
      // Per-line opt-out: same `mr-2` in a string MUST be skipped because of
      // the trailing `rtl-safe-physical:` marker on the same line.
      "  const docked = '<button class=\"mr-2\">Cancel</button>'; // rtl-safe-physical: docked in fixed LTR utility row",
      // Negative: a comment containing a forbidden token must NOT fire,
      // because acorn strips comments before string extraction.
      "  // legacy class names like text-right and border-l-4 documented in comment",
      "  /* block comment also mentions rounded-l-lg and space-x-2 */",
      // Negative: bare identifier `text_left` (underscore, not hyphen) must
      // NOT match because the rule regex is anchored to the hyphenated form.
      "  const ident = 'no_violation_here';",
      // Negative: a number / regex / boolean must NOT trigger.",
      "  const n = 42; const re = /text-right/; const b = true;",
      "</script>",
      // Non-JS script body — JSON contents must NOT be scanned by the JS pass.
      "<script type=\"application/json\" id=\"data\">",
      "  {\"copy\": \"This text-left text-right border-l-4 mr-2 string lives in a JSON blob\"}",
      "</script>",
      "</body></html>",
    ].join("\n"),
  );

  const jsPass = spawnSync(
    "node",
    [path.join(tmpScripts, "check-rtl-classes.cjs")],
    { stdio: "pipe", encoding: "utf8", cwd: tmpRoot, env: TMP_RUN_ENV },
  );
  const jsOut = `${jsPass.stdout ?? ""}\n${jsPass.stderr ?? ""}`;

  assert(
    jsPass.status === 1,
    "JS-string pass exits 1 when a fresh page has violations only inside <script> strings",
  );
  assert(
    jsOut.includes("[jsTextLR]"),
    "JS-string pass surfaces the jsTextLR rule",
  );
  assert(
    jsOut.includes("[jsBorderLR4]"),
    "JS-string pass surfaces the jsBorderLR4 rule",
  );
  assert(
    jsOut.includes("[jsMlMr]"),
    "JS-string pass surfaces the jsMlMr rule",
  );
  assert(
    jsOut.includes("[jsSpaceX]"),
    "JS-string pass surfaces the jsSpaceX rule",
  );
  assert(
    jsOut.includes("[jsRoundedLR]"),
    "JS-string pass surfaces the jsRoundedLR rule",
  );
  // Task #687 — JS-pass parity with the new HTML rules.
  assert(jsOut.includes("[jsPlPr]"), "JS-string pass surfaces the jsPlPr rule");
  assert(jsOut.includes("[jsBorderLR]"), "JS-string pass surfaces the jsBorderLR rule");
  assert(jsOut.includes("[jsInsetLR]"), "JS-string pass surfaces the jsInsetLR rule");
  // Variant coverage promises for each new JS rule.
  const jsPlPrCount = (jsOut.match(/\[jsPlPr\]/g) ?? []).length;
  assert(
    jsPlPrCount >= 3,
    `jsPlPr matches numeric (pl-4), keyword (pr-px), and arbitrary (pl-[3px]) variants in JS strings (saw ${jsPlPrCount}/3)`,
  );
  const jsBorderLRCount = (jsOut.match(/\[jsBorderLR\]/g) ?? []).length;
  assert(
    jsBorderLRCount >= 3,
    `jsBorderLR matches bare (border-r), small numeric (border-l-2), and large numeric (border-r-8) variants in JS strings (saw ${jsBorderLRCount}/3)`,
  );
  const jsInsetLRCount = (jsOut.match(/\[jsInsetLR\]/g) ?? []).length;
  assert(
    jsInsetLRCount >= 3,
    `jsInsetLR matches numeric (right-4 / left-3) and arbitrary (right-[12px]) variants in JS strings (saw ${jsInsetLRCount}/3)`,
  );
  // jsBorderLR must NOT misfire on `border-l-4` / `border-r-4`
  // (jsBorderLR4 owns those) or on colour utilities (`border-blue-500`).
  const jsBorderLRMessageLines = jsOut
    .split("\n")
    .filter((l) => l.includes("[jsBorderLR]") && !l.includes("[jsBorderLR4]"));
  assert(
    !jsBorderLRMessageLines.some((l) => /`border-[lr]-4`/.test(l)),
    "jsBorderLR does NOT misfire on `border-l-4` / `border-r-4` (jsBorderLR4 owns those)",
  );
  assert(
    !jsBorderLRMessageLines.some((l) => /`border-(?:blue|red|green|gray|slate|zinc|neutral|stone|orange|amber|yellow|lime|emerald|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose)-/.test(l)),
    "jsBorderLR does NOT misfire on color utilities like `border-blue-500` in JS strings",
  );
  // jsMlMr must catch numeric, keyword, and arbitrary-value variants.
  const jsMlMrCount = (jsOut.match(/\[jsMlMr\]/g) ?? []).length;
  assert(
    jsMlMrCount >= 3,
    `jsMlMr matches numeric (mr-2), keyword (ml-auto), and arbitrary (mr-[3px]) variants in JS strings (saw ${jsMlMrCount}/3)`,
  );
  // The opt-out marker on the JS line must suppress the violation.
  assert(
    !/docked in fixed LTR utility row/.test(jsOut),
    "rtl-safe-physical opt-out marker suppresses the violation on JS-string lines",
  );
  // Comments must NOT be scanned (acorn drops them before string extraction).
  assert(
    !/legacy class names like text-right/.test(jsOut),
    "JS line comments are NOT scanned by the JS-string pass",
  );
  assert(
    !/block comment also mentions/.test(jsOut),
    "JS block comments are NOT scanned by the JS-string pass",
  );
  // JSON `<script type="application/json">` bodies must NOT be scanned.
  assert(
    !/JSON blob/.test(jsOut),
    "non-JS <script> bodies (e.g. type=\"application/json\") are NOT scanned",
  );

  // -------------------------------------------------------------------------
  // Test 4 (Task #743) — JS-string pass acorn fallback: a script with a
  // syntax error MUST still be scanned (regex fallback) so a typo can't
  // smuggle in an RTL violation by crashing the parser.
  // -------------------------------------------------------------------------
  fs2.writeFileSync(
    path.join(tmpDashboard, "synthetic-js-broken.html"),
    [
      "<!doctype html><html><body>",
      "<script>",
      // Deliberate syntax error (unclosed function), then a violation.
      "  function broken( {",
      "  const html = '<div class=\"text-right\">fallback ok</div>';",
      "</script>",
      "</body></html>",
    ].join("\n"),
  );

  const jsBroken = spawnSync(
    "node",
    [path.join(tmpScripts, "check-rtl-classes.cjs")],
    { stdio: "pipe", encoding: "utf8", cwd: tmpRoot, env: TMP_RUN_ENV },
  );
  const jsBrokenOut = `${jsBroken.stdout ?? ""}\n${jsBroken.stderr ?? ""}`;
  assert(
    jsBroken.status === 1,
    "JS-string pass still flags violations when acorn cannot parse the script (regex fallback)",
  );
  assert(
    /synthetic-js-broken\.html.*\[jsTextLR\]/s.test(jsBrokenOut),
    "regex-fallback sweep catches `text-right` inside an unparseable <script> body",
  );
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n  Result: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
