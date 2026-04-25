/**
 * i18n guardrail (Task #125 / #150 / #295)
 * ----------------------------------------------------------------------------
 * Wraps `scripts/check-i18n.cjs` so it runs on every `npm test` invocation
 * (and therefore on every merge through `scripts/post-merge.sh`). The script
 * itself is the source of truth for the rules + allowlist; this file just
 * makes sure the integration-test runner picks it up.
 *
 * The guardrail blocks six classes of regression:
 *
 *   1. A new `dashboard/*.html` page that forgets to load `/js/i18n.js` or
 *      forgets to call `WalaPlusI18n.init().then(applyToDOM)`. Without that
 *      wiring, every `data-i18n` attribute on the page is silently ignored
 *      at runtime and the Arabic experience falls back to English.
 *
 *   2. A new `data-i18n="ns.key"` reference whose key is missing from
 *      `dashboard/i18n/en.json` or `dashboard/i18n/ar.json`. The runtime
 *      fallback prints the last segment of the key, which looks broken in
 *      Arabic and English alike.
 *
 *   3. A drift between `en.json` and `ar.json` key trees (orphans on either
 *      side, or a leaf turning into a sub-object on one side only).
 *
 *   4. A SW dictionary string in `dashboard/streaming-download-sw.js` that
 *      diverges from its mirror under `downloads.sw_expired_*` in the JSON
 *      files.
 *
 *   5. (Task #150) A static `WalaPlusI18n.t('ns.key')` call in
 *      `dashboard/js/*.js` or an inline <script> block whose key is missing
 *      from `en.json` or `ar.json`. Dynamic `t(variable)` calls split into
 *      two buckets (Task #295):
 *        - call sites listed in `scripts/i18n-dynamic-baseline.json` are
 *          surfaced as non-blocking ⚠ warnings (the long-standing
 *          `_t(k, v)` wrapper patterns); and
 *        - call sites NOT listed in the baseline are flagged as ✗ errors
 *          and BLOCK CI so a developer adding a new dynamic call site has
 *          to either rewrite it as a static `t('ns.key')` call or run
 *          `node scripts/check-i18n.cjs --update-baseline` to attest it.
 *
 *   6. (Task #295) A new dynamic `WalaPlusI18n.t(variable)` call site
 *      added to a dashboard JS file or inline <script> block without
 *      updating `scripts/i18n-dynamic-baseline.json`.
 *
 * Run:  npx tsx tests/i18nCoverage.test.ts
 *       node scripts/check-i18n.cjs              # equivalent
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(
  new URL(".", import.meta.url).pathname,
  "..",
);
const SCRIPT = path.resolve(REPO_ROOT, "scripts", "check-i18n.cjs");

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

console.log("\n▶ i18n guardrail (scripts/check-i18n.cjs)\n");

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
    // Surface the script's diagnostics so the failure is actionable in CI logs.
    if (stdout.trim()) console.log(stdout.trimEnd());
    if (stderr.trim()) console.error(stderr.trimEnd());
  }
  assert(
    result.status === 0,
    "every dashboard/*.html page wires i18n, every data-i18n key resolves in en.json + ar.json, the two trees are identical, the SW dictionary is in sync, every static WalaPlusI18n.t() key resolves in both JSON files, and no new dynamic t(variable) call sites have been added without updating the baseline",
  );

  // The baselined long-standing dynamic call sites must continue to be reported
  // as ⚠ warnings rather than disappear, so reviewers don't lose visibility.
  // (`console.warn` lands on stderr; check both streams to be safe.)
  assert(
    /JS t\(\) dynamic keys \(baselined\) — \d+ long-standing/.test(stdout + stderr),
    "baselined dynamic WalaPlusI18n.t(variable) call sites are still surfaced as ⚠ warnings",
  );
}

/* ---------------------------------------------------------------------------
 * Task #295 — new dynamic t(variable) call sites are flagged as ✗ errors
 *
 * We can't safely synthesise a dynamic call inside `dashboard/` (it would
 * change observable runtime behaviour and might be picked up by other
 * checks). Instead we run the script in a temporary working tree where
 * `dashboard/`, `dashboard/i18n/`, `dashboard/streaming-download-sw.js`,
 * and the (initially empty) baseline file all exist, and we inject a fake
 * dashboard page containing a brand-new dynamic call. The script must:
 *   - exit non-zero
 *   - print the "NEW WalaPlusI18n.t(variable) call site(s)" diagnostic
 *   - mention the offending source file
 *   - point the operator at the --update-baseline escape hatch
 * ------------------------------------------------------------------------ */

console.log("\n▶ Task #295 — new dynamic t(variable) is flagged as an error\n");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-dyn-baseline-"));
try {
  const tmpScripts = path.join(tmpRoot, "scripts");
  const tmpDashboard = path.join(tmpRoot, "dashboard");
  const tmpI18n = path.join(tmpDashboard, "i18n");
  fs.mkdirSync(tmpScripts, { recursive: true });
  fs.mkdirSync(tmpI18n, { recursive: true });

  // Copy the script verbatim so it resolves DASHBOARD_DIR / baseline paths
  // relative to the tmp tree (the script computes ROOT as `..` from
  // `__dirname`, which lands on `tmpRoot`).
  fs.copyFileSync(SCRIPT, path.join(tmpScripts, "check-i18n.cjs"));

  // Minimal en.json / ar.json trees — both have the static key our fake
  // page references so Check 5's static branch passes.
  const minimalTree = { ns: { static_key: "Static" } };
  fs.writeFileSync(path.join(tmpI18n, "en.json"), JSON.stringify(minimalTree));
  fs.writeFileSync(path.join(tmpI18n, "ar.json"), JSON.stringify(minimalTree));

  // SW file that satisfies Check 4 (we mirror only the SW strings, not the
  // i18n JSON keys — to keep the test isolated, the SW dictionary uses a
  // fresh `downloads.sw_expired_*` namespace and we add matching JSON
  // entries below).
  const swStrings: Record<string, Record<string, string>> = {
    en: {
      title: "Expired",
      heading: "Expired",
      body: "Body",
      retry_hint: "Hint",
    },
    ar: {
      title: "منتهي",
      heading: "منتهي",
      body: "نص",
      retry_hint: "تلميح",
    },
  };
  // Render the SW source in a shape `parseSwStrings()` accepts (single-quoted
  // string literals, anchored to `var SW_STRINGS = { ... };`).
  const renderLang = (lang: "en" | "ar") => {
    const fields = Object.entries(swStrings[lang])
      .map(([k, v]) => `    ${k}: '${v}'`)
      .join(",\n");
    return `  ${lang}: {\n${fields}\n  }`;
  };
  const swSource = `var SW_STRINGS = {\n${renderLang("en")},\n${renderLang("ar")}\n};\n`;
  fs.writeFileSync(path.join(tmpDashboard, "streaming-download-sw.js"), swSource);

  // Mirror the SW dictionary into the JSON trees so Check 4 passes.
  const trees: Record<"en" | "ar", { ns: { static_key: string }; downloads: Record<string, string> }> = {
    en: {
      ns: { static_key: "Static" },
      downloads: {
        sw_expired_title: swStrings.en.title,
        sw_expired_heading: swStrings.en.heading,
        sw_expired_body: swStrings.en.body,
        sw_expired_retry_hint: swStrings.en.retry_hint,
      },
    },
    ar: {
      ns: { static_key: "Static" },
      downloads: {
        sw_expired_title: swStrings.ar.title,
        sw_expired_heading: swStrings.ar.heading,
        sw_expired_body: swStrings.ar.body,
        sw_expired_retry_hint: swStrings.ar.retry_hint,
      },
    },
  };
  fs.writeFileSync(path.join(tmpI18n, "en.json"), JSON.stringify(trees.en));
  fs.writeFileSync(path.join(tmpI18n, "ar.json"), JSON.stringify(trees.ar));

  // A valid dashboard page wires i18n + uses ONE static key + ONE brand-new
  // dynamic call site that is NOT in the (empty) baseline.
  const fakePage = `<!DOCTYPE html>
<html><head>
  <script src="/js/i18n.js?v=1"></script>
</head><body>
  <span data-i18n="ns.static_key">Static</span>
  <script>
    window.WalaPlusI18n.init().then(() => window.WalaPlusI18n.applyToDOM());
    var k = 'ns.static_key';
    // Static so Check 5 has at least one passing literal:
    window.WalaPlusI18n.t('ns.static_key');
    // Brand-new dynamic call — should fail under Task #295.
    window.WalaPlusI18n.t(k);
  </script>
</body></html>
`;
  fs.writeFileSync(path.join(tmpDashboard, "fake-page.html"), fakePage);

  // Empty baseline so EVERY current dynamic call site (just the one above)
  // counts as "added".
  fs.writeFileSync(
    path.join(tmpScripts, "i18n-dynamic-baseline.json"),
    JSON.stringify({ entries: [] }),
  );

  const fakeRun = spawnSync("node", [path.join(tmpScripts, "check-i18n.cjs")], {
    stdio: "pipe",
    encoding: "utf8",
  });
  const combined = (fakeRun.stdout ?? "") + (fakeRun.stderr ?? "");

  assert(
    fakeRun.status !== 0,
    "guardrail exits non-zero when a NEW dynamic t(variable) call site is introduced",
  );
  assert(
    /NEW WalaPlusI18n\.t\(variable\) call site\(s\) not in scripts\/i18n-dynamic-baseline\.json/.test(
      combined,
    ),
    "diagnostic explicitly labels the new dynamic call site(s) as NEW",
  );
  assert(
    /fake-page\.html/.test(combined),
    "diagnostic names the offending source file",
  );
  assert(
    /--update-baseline/.test(combined),
    "diagnostic points the operator at the --update-baseline escape hatch",
  );

  // After running with --update-baseline the same scenario must pass
  // because the new call site is now an explicitly-attested entry.
  const updateRun = spawnSync(
    "node",
    [path.join(tmpScripts, "check-i18n.cjs"), "--update-baseline"],
    { stdio: "pipe", encoding: "utf8" },
  );
  assert(
    updateRun.status === 0,
    "--update-baseline writes the new call site and exits zero",
  );
  const baselineAfter = JSON.parse(
    fs.readFileSync(path.join(tmpScripts, "i18n-dynamic-baseline.json"), "utf8"),
  );
  assert(
    Array.isArray(baselineAfter.entries) && baselineAfter.entries.length === 1,
    "--update-baseline records exactly the one current dynamic call site",
  );

  const reRun = spawnSync("node", [path.join(tmpScripts, "check-i18n.cjs")], {
    stdio: "pipe",
    encoding: "utf8",
  });
  assert(
    reRun.status === 0,
    "guardrail passes again once the new dynamic call site is committed to the baseline",
  );
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n  Result: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
