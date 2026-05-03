/**
 * <th scope> accessibility guardrail (Task #757, hardening Task #46 / #263).
 *
 * Wraps `scripts/check-th-scope.cjs` so every `npm test` run (and therefore
 * the CI test suite via `tests/runIntegrationTests.ts`) executes both
 * passes:
 *
 *   • HTML pass — every static `<th …>` in `dashboard/*.html` carries a
 *     valid `scope="col|row|colgroup|rowgroup"`.
 *   • JS-string pass — every `<th …>` rendered from an inline `<script>`
 *     template string carries the same.
 *
 * Test 1 — current dashboard tree must pass the guardrail (regression
 *          baseline: Task #46 / #263 finished the migration).
 * Test 2 — a synthesised dashboard page that drops `scope` (in static
 *          HTML, in a JS template string, with an invalid scope value,
 *          and inside a `<thead>` false-friend) must FAIL with the
 *          right rule IDs reported, and the per-line opt-out marker
 *          must suppress its line.
 *
 * Run:  npx tsx tests/thScopeAccessibility.test.ts
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(
  new URL(".", import.meta.url).pathname,
  "..",
  "scripts",
  "check-th-scope.cjs",
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

console.log("\n▶ <th scope> accessibility guardrail (scripts/check-th-scope.cjs)\n");

// ---------------------------------------------------------------------------
// Test 1 — current dashboard/ tree must pass.
// ---------------------------------------------------------------------------
const result = spawnSync("node", [SCRIPT], { stdio: "pipe", encoding: "utf8" });
if (result.error) {
  console.error(`  ✗ Failed to execute guardrail script: ${result.error.message}`);
  failed++;
} else {
  if (result.status !== 0) {
    if ((result.stdout ?? "").trim()) console.log(result.stdout!.trimEnd());
    if ((result.stderr ?? "").trim()) console.error(result.stderr!.trimEnd());
  }
  assert(
    result.status === 0,
    "every <th> in dashboard/*.html (static HTML + inline <script> template strings) carries a valid scope attribute",
  );
}

// ---------------------------------------------------------------------------
// Test 2 — negative test: synthesise a fresh dashboard page that violates
// the rule in every detection path.
// ---------------------------------------------------------------------------
const tmpRoot = mkdtempSync(path.join(tmpdir(), "th-scope-guard-"));
try {
  const tmpScripts = path.join(tmpRoot, "scripts");
  const tmpDashboard = path.join(tmpRoot, "dashboard");
  mkdirSync(tmpScripts);
  mkdirSync(tmpDashboard);
  copyFileSync(SCRIPT, path.join(tmpScripts, "check-th-scope.cjs"));

  writeFileSync(
    path.join(tmpDashboard, "synthetic-th-page.html"),
    [
      "<!doctype html><html><body>",
      // HTML rule: <th> with no scope attribute at all.
      '<table><thead><tr><th class="px-2">Name</th></tr></thead></table>',
      // HTML rule: <th> with an invalid scope value.
      '<table><thead><tr><th scope="banana">Bad scope</th></tr></thead></table>',
      // Per-line opt-out: same violation but suppressed by the marker.
      '<table><tr><th>Opted out</th></tr></table> <!-- th-scope-safe: presentational layout cell -->',
      // <thead> must NEVER match the th regex (boundary check).
      "<table><thead><tr><th scope=\"col\">OK</th></tr></thead></table>",
      // <th-custom> custom element must NEVER match the th regex.
      "<th-custom>not a real th</th-custom>",
      // JS-string rule: <th> in a string literal with no scope.
      "<script>",
      "  function row(label) {",
      "    return `<tr><th class=\"px-2\">${label}</th><td>${label}</td></tr>`;",
      "  }",
      "</script>",
      // JS-string rule: <th> in a string with invalid scope value.
      "<script>",
      "  const bad = '<th scope=\"banana\">x</th>';",
      "</script>",
      // JSON <script> body must NOT be scanned.
      "<script type=\"application/json\" id=\"data\">",
      "  {\"copy\": \"<th>this lives in a JSON blob and must not be flagged</th>\"}",
      "</script>",
      // External script must NOT be scanned (no body anyway, defensive).
      "<script src=\"/js/safe-actions.js\"></script>",
      "</body></html>",
    ].join("\n"),
  );

  const negative = spawnSync(
    "node",
    [path.join(tmpScripts, "check-th-scope.cjs")],
    { stdio: "pipe", encoding: "utf8", cwd: tmpRoot },
  );
  const out = `${negative.stdout ?? ""}\n${negative.stderr ?? ""}`;

  assert(
    negative.status === 1,
    "guardrail exits 1 when a fresh dashboard page introduces <th> violations",
  );
  assert(
    out.includes("[thMissingScope]"),
    "negative test surfaces the static-HTML thMissingScope rule",
  );
  assert(
    out.includes("[thMissingScopeInJsString]"),
    "negative test surfaces the JS-string thMissingScopeInJsString rule",
  );
  // Both the missing-attr case AND the invalid-value case must fire.
  const htmlCount = (out.match(/\[thMissingScope\]/g) ?? []).length;
  assert(
    htmlCount >= 2,
    `static-HTML rule fires for both missing scope and invalid scope value (saw ${htmlCount}/2)`,
  );
  const jsCount = (out.match(/\[thMissingScopeInJsString\]/g) ?? []).length;
  assert(
    jsCount >= 2,
    `JS-string rule fires for both missing scope and invalid scope value in JS strings (saw ${jsCount}/2)`,
  );
  // Opt-out marker on the line must suppress the violation.
  assert(
    !/presentational layout cell/.test(out),
    "th-scope-safe opt-out marker suppresses the violation on its line",
  );
  // <thead> tag is the most common false-friend — must not be flagged.
  // The static-HTML rule fires exactly twice (the two synthesised
  // violations); if `<thead>` were misclassified we'd see at least three
  // hits. Also assert no violation snippet starts with `<thead`.
  assert(
    htmlCount === 2,
    `static-HTML rule fires only on the two synthesised <th> violations, not on <thead> (saw ${htmlCount}/2)`,
  );
  assert(
    !/\[thMissingScope\][^\n]*\n\s*→\s*<thead/.test(out),
    "<thead> opening tag is NOT misclassified as a missing-scope <th>",
  );
  // <th-custom> custom element must not match either.
  assert(
    !/th-custom/.test(out),
    "<th-custom> custom element is NOT misclassified as a <th>",
  );
  // JSON <script> body must not be scanned by the JS-string pass.
  assert(
    !/JSON blob/.test(out),
    "<script type=\"application/json\"> body is NOT scanned by the JS-string pass",
  );
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n  Result: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
