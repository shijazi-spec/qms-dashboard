/**
 * RTL guardrail (Task #315) — blocks new physical-direction Tailwind classes
 * (`text-left`, `text-right`, `border-l-4`, `border-r-4`, `ml-<n>`, `mr-<n>`)
 * from re-entering the highest-impact spots on `dashboard/*.html` pages:
 * `<th>` elements, stat-card accent borders, and `<button>` icon gutters.
 *
 * The dashboard supports Arabic via `html[dir="rtl"]` set by
 * `dashboard/js/i18n.js`. Per the "RTL Layout Convention" section of
 * `replit.md`, layout details that should mirror in RTL must be expressed
 * with CSS logical-direction utilities (`text-start`, `border-s-4`, `ms-2`,
 * `me-2`, …). Physical-direction classes silently pin the layout to LTR and
 * break the Arabic experience the next time a user loads the page. Without
 * a guardrail, a routine edit to a new dashboard page can reintroduce one.
 *
 * This test wraps `scripts/check-rtl-classes.cjs` so it runs on every
 * `npm test` invocation (which is also the CI test command). The Node.js
 * script is the source of truth for the rules + per-rule allowlist; this
 * file just makes sure the integration-test runner picks it up.
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
    "no forbidden physical-direction classes on <th>, border-l-4/r-4, or <button> ml-/mr- in dashboard/*.html",
  );
}

// ---------------------------------------------------------------------------
// Test 2 — negative test: synthesise four violation flavours in a temp
// dashboard tree (one per rule plus a sentinel for the opt-out marker and
// for `<script>` body skipping), copy the checker script next to it, and
// assert it fails with all three rule IDs reported. This proves the rule
// engine actually fires (not just that today's tree happens to be clean).
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
  // A brand-new (non-allowlisted) page that violates all three rules.
  writeFileSync(
    path.join(tmpDashboard, "synthetic-new-page.html"),
    [
      "<!doctype html><html><body>",
      // Rule 1: <th> with text-left
      '<table><thead><tr><th class="px-2 text-left">Name</th></tr></thead></table>',
      // Rule 2: any element with border-l-4
      '<div class="bg-white border-l-4 border-blue-500 p-4">card</div>',
      // Rule 3: <button> with mr-<n>
      '<button class="text-blue-600 mr-2">Edit</button>',
      // Rule 3 (keyword variant): <button> with ml-auto — must also fire.
      '<button class="text-blue-600 ml-auto">Save</button>',
      // Rule 3 (arbitrary value variant): <button> with mr-[3px] — must also fire.
      '<button class="text-blue-600 mr-[3px]">Pin</button>',
      // Sentinel: a JS string that mentions the patterns inside <script>',
      // must NOT trigger (tokeniser skips script bodies).
      "<script>const s = 'border-l-4 mr-2 text-left';</script>",
      // Sentinel: opt-out marker should suppress the violation.
      '<button class="text-red-600 ml-2">Cancel</button> <!-- rtl-safe-physical: docked in a fixed LTR utility row -->',
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
  // Confirm the buttonMlMr regex catches numeric, keyword, and arbitrary-value
  // Tailwind variants — not just `mr-<digits>`.
  const buttonViolationCount = (out.match(/\[buttonMlMr\]/g) ?? []).length;
  assert(
    buttonViolationCount >= 3,
    `buttonMlMr matches numeric (mr-2), keyword (ml-auto), and arbitrary (mr-[3px]) variants (saw ${buttonViolationCount}/3)`,
  );
  // The opt-out marker line MUST NOT appear in violations.
  assert(
    !out.includes("rtl-safe-physical: docked"),
    "rtl-safe-physical opt-out marker suppresses the violation on its line",
  );
  // Script bodies MUST NOT be scanned.
  assert(
    !/script.*\[(thTextAlign|borderLR4|buttonMlMr)\]/.test(out),
    "<script> body contents are not scanned",
  );
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n  Result: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
