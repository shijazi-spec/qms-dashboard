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
 *      forgets to call `ExampleOrgI18n.init().then(applyToDOM)`. Without that
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
 *   5. (Task #150) A static `ExampleOrgI18n.t('ns.key')` call in
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
 *   6. (Task #295) A new dynamic `ExampleOrgI18n.t(variable)` call site
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
import { fileURLToPath } from "node:url";

// `.pathname` returns `/D:/...` on Windows which `path.resolve` double-drives
// into `D:\D:\...` (ENOENT). fileURLToPath normalises POSIX + Windows.
const REPO_ROOT = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
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

// Pass --report-unused so Check 6 (Task #345 — orphan-key budget) is
// exercised on every `npm test` run. Pre-existing orphans are tracked in
// `scripts/i18n-unused-baseline.json`; any NEW orphan introduced by the
// current diff fails the assertion below.
const result = spawnSync("node", [SCRIPT, "--report-unused"], {
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
    "every dashboard/*.html page wires i18n, every data-i18n key resolves in en.json + ar.json, the two trees are identical, the SW dictionary is in sync, every static ExampleOrgI18n.t() key resolves in both JSON files, no new dynamic t(variable) call sites have been added without updating the baseline, and no NEW orphan keys have been added to en.json / ar.json (Task #345)",
  );

  // Either:
  //   (a) The baseline file still lists long-standing dynamic call sites, in
  //       which case the script must continue surfacing them as ⚠ warnings so
  //       reviewers don't lose visibility; OR
  //   (b) Task #752 has driven the baselined set to zero (baseline file
  //       deleted or `{ "entries": [] }`), in which case there is nothing to
  //       warn about and 100 % of `ExampleOrgI18n.t()` calls are statically
  //       verified.
  // (`console.warn` lands on stderr; check both streams to be safe.)
  const dynamicBaselinePath = path.resolve(REPO_ROOT, "scripts", "i18n-dynamic-baseline.json");
  let baselinedCount = 0;
  if (fs.existsSync(dynamicBaselinePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(dynamicBaselinePath, "utf8")) as {
        entries?: unknown[];
      };
      baselinedCount = Array.isArray(parsed.entries) ? parsed.entries.length : 0;
    } catch {
      baselinedCount = 0;
    }
  }
  if (baselinedCount > 0) {
    assert(
      /JS t\(\) dynamic keys \(baselined\) — \d+ long-standing/.test(stdout + stderr),
      "baselined dynamic ExampleOrgI18n.t(variable) call sites are still surfaced as ⚠ warnings",
    );
  } else {
    assert(
      !/JS t\(\) dynamic keys \(baselined\) — \d+ long-standing/.test(stdout + stderr),
      "no baselined dynamic call sites remain (Task #752) — every ExampleOrgI18n.t() call is statically verified",
    );
  }

  // Task #345 — the unused-key scan must be invoked when --report-unused is
  // passed, regardless of whether any orphans are found.
  assert(
    /Unused-key scan \(Task #345/.test(stdout + stderr),
    "unused-key scan (Task #345) is exercised on every `npm test` run",
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
 *   - print the "NEW ExampleOrgI18n.t(variable) call site(s)" diagnostic
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
    window.ExampleOrgI18n.init().then(() => window.ExampleOrgI18n.applyToDOM());
    var k = 'ns.static_key';
    // Static so Check 5 has at least one passing literal:
    window.ExampleOrgI18n.t('ns.static_key');
    // Brand-new dynamic call — should fail under Task #295.
    window.ExampleOrgI18n.t(k);
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
    /NEW ExampleOrgI18n\.t\(variable\) call site\(s\) not in scripts\/i18n-dynamic-baseline\.json/.test(
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

/* ---------------------------------------------------------------------------
 * Task #345 — new orphan keys in en.json / ar.json are flagged as ✗ errors
 *
 * Same isolated-tmp-tree pattern as the Task #295 block above. We synthesise
 * a minimal dashboard with two leaf keys: one that IS referenced by a
 * data-i18n attribute (so it must NOT show up as an orphan) and one that is
 * NOT referenced anywhere (so it MUST be flagged as a brand-new orphan when
 * the unused-key baseline is empty). The script must:
 *   - exit non-zero under --report-unused
 *   - print the "NEW orphan key(s)" diagnostic
 *   - name the offending key
 *   - point the operator at the --update-unused-baseline escape hatch
 *   - also describe the dynamic-prefix allowlist as an alternative
 *
 * After running with --update-unused-baseline the same scenario must pass.
 * ------------------------------------------------------------------------ */

console.log("\n▶ Task #345 — new orphan i18n key is flagged as an error\n");

const orphanRoot = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-orphan-baseline-"));
try {
  const tmpScripts = path.join(orphanRoot, "scripts");
  const tmpDashboard = path.join(orphanRoot, "dashboard");
  const tmpI18n = path.join(tmpDashboard, "i18n");
  fs.mkdirSync(tmpScripts, { recursive: true });
  fs.mkdirSync(tmpI18n, { recursive: true });

  fs.copyFileSync(SCRIPT, path.join(tmpScripts, "check-i18n.cjs"));

  // Tree includes a referenced leaf AND a brand-new orphan leaf.
  const tree = {
    ns: { used_key: "Used", brand_new_orphan: "Orphan" },
    downloads: {
      sw_expired_title: "Expired",
      sw_expired_heading: "Expired",
      sw_expired_body: "Body",
      sw_expired_retry_hint: "Hint",
    },
  };
  const treeAr = {
    ns: { used_key: "مستخدم", brand_new_orphan: "يتيم" },
    downloads: {
      sw_expired_title: "منتهي",
      sw_expired_heading: "منتهي",
      sw_expired_body: "نص",
      sw_expired_retry_hint: "تلميح",
    },
  };
  fs.writeFileSync(path.join(tmpI18n, "en.json"), JSON.stringify(tree));
  fs.writeFileSync(path.join(tmpI18n, "ar.json"), JSON.stringify(treeAr));

  // Allowlist the downloads.sw_* prefix so the SW dictionary keys are NOT
  // counted as orphans (they're consumed by the service worker, not the DOM).
  // Leaves ns.brand_new_orphan as the single, deterministic orphan.
  fs.writeFileSync(
    path.join(tmpI18n, ".referenced-dynamically.json"),
    JSON.stringify({ prefixes: ["downloads.sw_"] }),
  );
  fs.writeFileSync(
    path.join(tmpScripts, "i18n-dynamic-baseline.json"),
    JSON.stringify({ entries: [] }),
  );

  // SW dictionary mirroring the JSON tree so Check 4 passes.
  const swDict = {
    en: { title: "Expired", heading: "Expired", body: "Body", retry_hint: "Hint" },
    ar: { title: "منتهي", heading: "منتهي", body: "نص", retry_hint: "تلميح" },
  } as const;
  const renderLang = (lang: "en" | "ar") => {
    const fields = Object.entries(swDict[lang])
      .map(([k, v]) => `    ${k}: '${v}'`)
      .join(",\n");
    return `  ${lang}: {\n${fields}\n  }`;
  };
  fs.writeFileSync(
    path.join(tmpDashboard, "streaming-download-sw.js"),
    `var SW_STRINGS = {\n${renderLang("en")},\n${renderLang("ar")}\n};\n`,
  );

  // Dashboard page references ns.used_key but not ns.brand_new_orphan.
  const fakePage = `<!DOCTYPE html>
<html><head>
  <script src="/js/i18n.js?v=1"></script>
</head><body>
  <span data-i18n="ns.used_key">Used</span>
  <script>
    window.ExampleOrgI18n.init().then(() => window.ExampleOrgI18n.applyToDOM());
  </script>
</body></html>
`;
  fs.writeFileSync(path.join(tmpDashboard, "fake-page.html"), fakePage);

  // 1. Without --report-unused, orphan check is silent (legacy behaviour).
  const silentRun = spawnSync("node", [path.join(tmpScripts, "check-i18n.cjs")], {
    stdio: "pipe",
    encoding: "utf8",
  });
  const silentOut = (silentRun.stdout ?? "") + (silentRun.stderr ?? "");
  assert(
    silentRun.status === 0,
    "without --report-unused, an unreferenced orphan key does NOT block the gate (legacy behaviour preserved)",
  );
  assert(
    !/NEW orphan key\(s\)/.test(silentOut),
    "without --report-unused, the orphan diagnostic is NOT printed",
  );

  // 2. With --report-unused (and an empty baseline), the orphan blocks.
  const reportRun = spawnSync(
    "node",
    [path.join(tmpScripts, "check-i18n.cjs"), "--report-unused"],
    { stdio: "pipe", encoding: "utf8" },
  );
  const reportOut = (reportRun.stdout ?? "") + (reportRun.stderr ?? "");
  assert(
    reportRun.status !== 0,
    "with --report-unused, a NEW orphan key in en.json blocks the gate",
  );
  assert(
    /NEW orphan key\(s\) in dashboard\/i18n\/en\.json \+ ar\.json/.test(reportOut),
    "diagnostic explicitly labels the new orphan key(s) as NEW",
  );
  assert(
    /ns\.brand_new_orphan/.test(reportOut),
    "diagnostic names the offending orphan key",
  );
  assert(
    /--update-unused-baseline/.test(reportOut),
    "diagnostic points the operator at the --update-unused-baseline escape hatch",
  );
  assert(
    /\.referenced-dynamically\.json/.test(reportOut),
    "diagnostic also describes the dynamic-prefix allowlist as an alternative",
  );

  // 3. After --update-unused-baseline, the same orphan is now an attested
  //    pre-existing key and the gate passes (with a ⚠ warning).
  const updateRun = spawnSync(
    "node",
    [path.join(tmpScripts, "check-i18n.cjs"), "--update-unused-baseline"],
    { stdio: "pipe", encoding: "utf8" },
  );
  assert(
    updateRun.status === 0,
    "--update-unused-baseline writes the new orphan(s) and exits zero",
  );
  const orphanBaseline = JSON.parse(
    fs.readFileSync(path.join(tmpScripts, "i18n-unused-baseline.json"), "utf8"),
  );
  assert(
    Array.isArray(orphanBaseline.keys) &&
      orphanBaseline.keys.includes("ns.brand_new_orphan") &&
      !orphanBaseline.keys.includes("ns.used_key"),
    "--update-unused-baseline records exactly the orphan key (and not the referenced one)",
  );

  const reRun = spawnSync(
    "node",
    [path.join(tmpScripts, "check-i18n.cjs"), "--report-unused"],
    { stdio: "pipe", encoding: "utf8" },
  );
  const reRunOut = (reRun.stdout ?? "") + (reRun.stderr ?? "");
  assert(
    reRun.status === 0,
    "guardrail passes again once the new orphan is committed to the baseline",
  );
  assert(
    /Unused-key report \(baselined\) — 1 pre-existing orphan key/.test(reRunOut),
    "baselined orphan key continues to be surfaced as a ⚠ warning",
  );

  // 4. Removing the orphan from the JSON trees AND running the script under
  //    a baseline that still lists it must pass and surface the cleanup hint.
  const cleanedTree = { ns: { used_key: "Used" }, downloads: tree.downloads };
  const cleanedTreeAr = { ns: { used_key: "مستخدم" }, downloads: treeAr.downloads };
  fs.writeFileSync(path.join(tmpI18n, "en.json"), JSON.stringify(cleanedTree));
  fs.writeFileSync(path.join(tmpI18n, "ar.json"), JSON.stringify(cleanedTreeAr));

  const cleanedRun = spawnSync(
    "node",
    [path.join(tmpScripts, "check-i18n.cjs"), "--report-unused"],
    { stdio: "pipe", encoding: "utf8" },
  );
  const cleanedOut = (cleanedRun.stdout ?? "") + (cleanedRun.stderr ?? "");
  assert(
    cleanedRun.status === 0,
    "guardrail passes when a baselined orphan has been removed from en.json + ar.json",
  );
  assert(
    /no longer unused — re-run with --update-unused-baseline to prune/.test(cleanedOut),
    "operator is told to prune the baseline file once an orphan is cleaned up",
  );
} finally {
  fs.rmSync(orphanRoot, { recursive: true, force: true });
}

/* ---------------------------------------------------------------------------
 * Task #407 — `public/*.html` pages are also audited by Check 1 (page wiring)
 * and Check 2 (data-i18n reference coverage).
 *
 * `public/` is forward-looking — it doesn't exist in the repo today — so the
 * easiest way to assert the new coverage is to synthesise a tmp-tree with
 * BOTH `dashboard/` and `public/` and inject a `public/foo.html` page that
 * (a) lacks the i18n bootstrap and (b) references a bogus `data-i18n` key.
 * The script must:
 *   - exit non-zero
 *   - mention `public/foo.html` in the page-wiring diagnostic
 *   - mention `public/foo.html :: "ns.bogus_public_key"` in the reference
 *     coverage diagnostic
 *
 * Removing the temp file (or fixing it) restores a passing run.
 * ------------------------------------------------------------------------ */

console.log("\n▶ Task #407 — public/*.html pages are also audited by Check 1 and Check 2\n");

const publicRoot = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-public-coverage-"));
try {
  const tmpScripts = path.join(publicRoot, "scripts");
  const tmpDashboard = path.join(publicRoot, "dashboard");
  const tmpI18n = path.join(tmpDashboard, "i18n");
  const tmpPublic = path.join(publicRoot, "public");
  fs.mkdirSync(tmpScripts, { recursive: true });
  fs.mkdirSync(tmpI18n, { recursive: true });
  fs.mkdirSync(tmpPublic, { recursive: true });

  fs.copyFileSync(SCRIPT, path.join(tmpScripts, "check-i18n.cjs"));

  // Minimal JSON trees — `ns.static_key` exists, `ns.bogus_public_key` does NOT.
  const swStrings = {
    en: { title: "Expired", heading: "Expired", body: "Body", retry_hint: "Hint" },
    ar: { title: "منتهي", heading: "منتهي", body: "نص", retry_hint: "تلميح" },
  } as const;
  const tree = {
    ns: { static_key: "Static" },
    downloads: {
      sw_expired_title: swStrings.en.title,
      sw_expired_heading: swStrings.en.heading,
      sw_expired_body: swStrings.en.body,
      sw_expired_retry_hint: swStrings.en.retry_hint,
    },
  };
  const treeAr = {
    ns: { static_key: "ثابت" },
    downloads: {
      sw_expired_title: swStrings.ar.title,
      sw_expired_heading: swStrings.ar.heading,
      sw_expired_body: swStrings.ar.body,
      sw_expired_retry_hint: swStrings.ar.retry_hint,
    },
  };
  fs.writeFileSync(path.join(tmpI18n, "en.json"), JSON.stringify(tree));
  fs.writeFileSync(path.join(tmpI18n, "ar.json"), JSON.stringify(treeAr));

  const renderLang = (lang: "en" | "ar") => {
    const fields = Object.entries(swStrings[lang])
      .map(([k, v]) => `    ${k}: '${v}'`)
      .join(",\n");
    return `  ${lang}: {\n${fields}\n  }`;
  };
  fs.writeFileSync(
    path.join(tmpDashboard, "streaming-download-sw.js"),
    `var SW_STRINGS = {\n${renderLang("en")},\n${renderLang("ar")}\n};\n`,
  );

  fs.writeFileSync(
    path.join(tmpScripts, "i18n-dynamic-baseline.json"),
    JSON.stringify({ entries: [] }),
  );

  // A valid dashboard page so Check 1 / Check 2 have something legit to scan.
  const dashboardPage = `<!DOCTYPE html>
<html><head>
  <script src="/js/i18n.js?v=1"></script>
</head><body>
  <span data-i18n="ns.static_key">Static</span>
  <script>window.ExampleOrgI18n.init().then(() => window.ExampleOrgI18n.applyToDOM());</script>
</body></html>
`;
  fs.writeFileSync(path.join(tmpDashboard, "ok.html"), dashboardPage);

  // Sanity: with NO public/ pages, the gate passes.
  const baselineRun = spawnSync(
    "node",
    [path.join(tmpScripts, "check-i18n.cjs")],
    { stdio: "pipe", encoding: "utf8" },
  );
  assert(
    baselineRun.status === 0,
    "tmp tree without any public/ pages passes the gate (sanity check)",
  );

  // Now drop a bogus public/ page that (a) lacks the i18n bootstrap and (b)
  // references a key not present in either JSON tree.
  const bogusPublicPage = `<!DOCTYPE html>
<html><head><title>Status</title></head><body>
  <span data-i18n="ns.bogus_public_key">Status</span>
</body></html>
`;
  fs.writeFileSync(path.join(tmpPublic, "foo.html"), bogusPublicPage);

  const failingRun = spawnSync(
    "node",
    [path.join(tmpScripts, "check-i18n.cjs")],
    { stdio: "pipe", encoding: "utf8" },
  );
  const failingOut = (failingRun.stdout ?? "") + (failingRun.stderr ?? "");

  assert(
    failingRun.status !== 0,
    "guardrail exits non-zero when a public/*.html page references a missing data-i18n key",
  );
  assert(
    /Page wiring:[^\n]*do not load \/js\/i18n\.js[\s\S]*public\/foo\.html/.test(failingOut),
    "Check 1 (page wiring) flags public/foo.html for missing the i18n bootstrap",
  );
  assert(
    /public\/foo\.html :: "ns\.bogus_public_key"/.test(failingOut),
    "Check 2 (reference coverage) names the bogus key in public/foo.html for both en.json and ar.json",
  );

  // Removing the offending file restores a passing run — proves the new
  // public/ coverage is bounded by what's actually in the directory.
  fs.unlinkSync(path.join(tmpPublic, "foo.html"));
  const recoveryRun = spawnSync(
    "node",
    [path.join(tmpScripts, "check-i18n.cjs")],
    { stdio: "pipe", encoding: "utf8" },
  );
  assert(
    recoveryRun.status === 0,
    "removing the bogus public/ page restores a passing guardrail run",
  );
} finally {
  fs.rmSync(publicRoot, { recursive: true, force: true });
}

console.log(`\n  Result: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
