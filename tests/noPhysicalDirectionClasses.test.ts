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

const SCRIPT = path.resolve(
  new URL(".", import.meta.url).pathname,
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
const result = spawnSync("node", [SCRIPT], { stdio: "pipe", encoding: "utf8" });

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
      // Sentinel A: same `text-left` on a <th> on its own MUST hit the
      // thTextAlign rule but MUST NOT *also* hit the textLRNonTh rule
      // (the rules are mutually exclusive on the tag axis).
      '<table><tr><th class="text-left">Header-only</th></tr></table>',
      // Sentinel B: a JS string that mentions the patterns inside <script>',
      // must NOT trigger (tokeniser skips script bodies).
      "<script>const s = 'border-l-4 mr-2 text-left space-x-2 rounded-l-lg';</script>",
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
    { stdio: "pipe", encoding: "utf8", cwd: tmpRoot },
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
  // Script bodies MUST NOT be scanned.
  assert(
    !/script.*\[(thTextAlign|borderLR4|buttonMlMr|spaceX|roundedLR|textLRNonTh)\]/.test(out),
    "<script> body contents are not scanned",
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
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n  Result: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
