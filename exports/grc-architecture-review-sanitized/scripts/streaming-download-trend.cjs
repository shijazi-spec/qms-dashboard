#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Streaming-download latency trend reporter.
 *
 * Used by .SourceControlProvider/workflows/streaming-download-smoke.yml to turn the
 * per-run timing artifacts (test-results/streaming-download-timing/<browser>.json)
 * into a cross-build trend so creeping regressions become visible before
 * they breach the hard fail budget enforced in tests/streamingDownload.spec.ts.
 *
 * Persistence model
 * ─────────────────
 * History is kept on a dedicated orphan branch
 * (default: `ci-data/streaming-download`) that stores one JSON file per
 * (run, browser) under `data/<browser>/<runNumber>-<shortSha>.json`. The
 * workflow appends to that branch on every successful run on the default
 * branch (see `.SourceControlProvider/workflows/streaming-download-smoke.yml`). The
 * orphan branch has effectively unlimited retention — unlike the
 * `streaming-download-timing` SourceControlProvider Actions artifact, which SourceControlProvider
 * evicts after 90 days. That eviction would hide a slow creep that takes
 * 4–6 months to develop (precisely the regressions the static fail
 * budget would also miss), so the artifact is now only a fallback.
 *
 * Order of precedence when assembling history:
 *   1. Orphan branch history (preferred, unbounded retention) — read via
 *      `git fetch --depth=1 origin <branch>` + `git ls-tree`/`git show`,
 *      so no extra clone of the main tree is required.
 *   2. Artifact fallback (90-day window) — `gh run download` of the
 *      `streaming-download-timing` artifact from prior workflow runs.
 *      Records already covered by the branch are de-duplicated by
 *      (browser, runId).
 *   3. Current in-tree timing files written by this run.
 *
 * Steps performed by this script:
 *   1. Load history from the orphan branch (and, as fallback, prior
 *      workflow artifacts).
 *   2. Combine those records with the current in-tree timing files.
 *   3. Render a per-browser trend table (last N runs, rolling median,
 *      delta-vs-median, simple linear-trend slope).
 *   4. Detect "creeping regression": current run > 1.25 × median of the
 *      last 10 runs on that browser, even when still inside the hard
 *      LATENCY_FAIL_MS budget.
 *
 * Persisting this run's records back to the orphan branch is handled by
 * the workflow (a separate step that runs only on pushes to the default
 * branch, where `SourceControlProvider_TOKEN` has `contents: write`). That keeps fork
 * PRs — which only get a read-only token — from failing the trend step.
 *
 * Outputs
 * ───────
 *   - Writes a Markdown report to STREAMING_TREND_OUTPUT (default
 *     `test-results/streaming-trend-summary.md`).
 *   - Prints the same Markdown to stdout so it can be teed into
 *     `$SourceControlProvider_STEP_SUMMARY`.
 *   - Exit code is always 0; the hard-fail budget is enforced in the
 *     Playwright spec, not here. This script's job is to surface
 *     SLOW-CREEP regressions that the hard budget would miss.
 *
 * Environment
 * ───────────
 *   SourceControlProvider_REPOSITORY    — owner/repo (set by Actions automatically)
 *   SourceControlProvider_WORKFLOW_FILE — workflow filename (e.g. streaming-download-smoke.yml)
 *                          Falls back to SourceControlProvider_WORKFLOW_REF parsing.
 *   STREAMING_TREND_HISTORY_LIMIT — how many prior runs to fetch (default 20)
 *   STREAMING_TREND_OUTPUT — output Markdown path (default
 *                            test-results/streaming-trend-summary.md)
 *   STREAMING_TREND_DEFAULT_BRANCH — branch to read history from
 *                                    (default main)
 *   STREAMING_TREND_TIMING_DIR — where this run's timing JSONs live
 *                                (default test-results/streaming-download-timing)
 *   STREAMING_TREND_HISTORY_BRANCH — orphan branch holding the long-term
 *                                    history (default ci-data/streaming-download)
 *   STREAMING_TREND_SKIP_BRANCH — set to "1" to skip the branch-history
 *                                  fetch (used by tests / offline runs)
 *   STREAMING_TREND_SKIP_GH — set to "1" to skip the gh CLI artifact
 *                             fallback step (used by tests).
 *
 * Local usage
 * ───────────
 * The script is safe to run locally: if `git` cannot fetch the history
 * branch (e.g. no remote configured), if `gh` is not installed or not
 * authenticated, or if no prior runs exist (e.g. very first run on a
 * new repo), it falls back to "current run only" and writes a
 * single-row report rather than failing.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TIMING_DIR =
  process.env.STREAMING_TREND_TIMING_DIR ||
  'test-results/streaming-download-timing';
const OUTPUT_FILE =
  process.env.STREAMING_TREND_OUTPUT ||
  'test-results/streaming-trend-summary.md';
const HISTORY_LIMIT = Number(
  process.env.STREAMING_TREND_HISTORY_LIMIT || '20',
);
const DEFAULT_BRANCH =
  process.env.STREAMING_TREND_DEFAULT_BRANCH || 'main';
const SKIP_GH = process.env.STREAMING_TREND_SKIP_GH === '1';
const SKIP_BRANCH = process.env.STREAMING_TREND_SKIP_BRANCH === '1';
const HISTORY_BRANCH =
  process.env.STREAMING_TREND_HISTORY_BRANCH || 'ci-data/streaming-download';

// A run that is more than CREEP_THRESHOLD × the rolling median is flagged
// as a "creeping regression" candidate, even if it's still inside the hard
// LATENCY_FAIL_MS budget.
const CREEP_THRESHOLD = 1.25;
const CREEP_MIN_SAMPLES = 5; // need at least this much history before flagging
const CREEP_MEDIAN_WINDOW = 10;

function log(...args) {
  console.error('[streaming-trend]', ...args);
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    log(`skip ${file}: ${err.message}`);
    return null;
  }
}

function loadCurrentRun() {
  if (!fs.existsSync(TIMING_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(TIMING_DIR)) {
    if (!name.endsWith('.json')) continue;
    const rec = safeReadJson(path.join(TIMING_DIR, name));
    if (rec && rec.browser && typeof rec.durationMs === 'number') {
      out.push({
        ...rec,
        runId: process.env.SourceControlProvider_RUN_ID || 'local',
        runNumber: Number(process.env.SourceControlProvider_RUN_NUMBER || 0) || null,
        sha: process.env.SourceControlProvider_SHA || null,
        source: 'current',
      });
    }
  }
  return out;
}

function whichGh() {
  const r = spawnSync('gh', ['--version'], { encoding: 'utf-8' });
  return r.status === 0;
}

function resolveWorkflowFile() {
  if (process.env.SourceControlProvider_WORKFLOW_FILE) return process.env.SourceControlProvider_WORKFLOW_FILE;
  // SourceControlProvider_WORKFLOW_REF looks like:
  //   owner/repo/.SourceControlProvider/workflows/<REDACTED_EMAIL>/heads/main
  const ref = process.env.SourceControlProvider_WORKFLOW_REF;
  if (ref) {
    const m = ref.match(/\.SourceControlProvider\/workflows\/([^@]+)/);
    if (m) return m[1];
  }
  return 'streaming-download-smoke.yml';
}

function listRecentRuns(workflow) {
  // gh run list returns most-recent-first.
  const args = [
    'run',
    'list',
    '--workflow',
    workflow,
    '--branch',
    DEFAULT_BRANCH,
    '--status',
    'success',
    '--limit',
    String(HISTORY_LIMIT),
    '--json',
    'databaseId,headSha,createdAt,displayTitle,number',
  ];
  const r = spawnSync('gh', args, { encoding: 'utf-8' });
  if (r.status !== 0) {
    log(`gh run list failed: ${r.stderr.trim()}`);
    return [];
  }
  try {
    return JSON.parse(r.stdout);
  } catch (err) {
    log(`gh run list parse failed: ${err.message}`);
    return [];
  }
}

function downloadArtifact(runId, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync(
    'gh',
    ['run', 'download', String(runId), '-n', 'streaming-download-timing', '-D', destDir],
    { encoding: 'utf-8' },
  );
  if (r.status !== 0) {
    // Most common reason: artifact has expired (90-day retention) or this
    // particular run uploaded no timing files (e.g. the test crashed
    // before recording). Both are expected and non-fatal.
    return false;
  }
  return true;
}

function whichGit() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf-8' });
  return r.status === 0;
}

function fetchHistoryBranch() {
  // Fetch the orphan branch into FETCH_HEAD without checking it out.
  // `--depth=1` keeps things fast — we only need the latest tree, since
  // every prior run is a separate file already on that tree.
  const r = spawnSync(
    'git',
    ['fetch', '--depth=1', '--no-tags', 'origin', HISTORY_BRANCH],
    { encoding: 'utf-8' },
  );
  if (r.status !== 0) {
    // Most common reasons: branch doesn't exist yet (first run ever),
    // running outside CI without an `origin` remote, or transient
    // network issue. All non-fatal — we'll fall through to the
    // artifact fallback or current-run-only.
    log(`git fetch ${HISTORY_BRANCH} failed: ${(r.stderr || '').trim()}`);
    return false;
  }
  return true;
}

function loadHistoryFromBranch() {
  if (SKIP_BRANCH) {
    log('STREAMING_TREND_SKIP_BRANCH=1 — skipping branch history fetch');
    return [];
  }
  if (!whichGit()) {
    log('git not available — skipping branch history fetch');
    return [];
  }
  if (!fetchHistoryBranch()) return [];

  // Enumerate every JSON blob on the fetched tree and read its content
  // via `git show`. Avoids checking out / mutating the working tree.
  const lsTree = spawnSync(
    'git',
    ['ls-tree', '-r', '--name-only', 'FETCH_HEAD'],
    { encoding: 'utf-8' },
  );
  if (lsTree.status !== 0) {
    log(`git ls-tree failed: ${(lsTree.stderr || '').trim()}`);
    return [];
  }
  const files = lsTree.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.endsWith('.json'));

  const out = [];
  for (const file of files) {
    const show = spawnSync('git', ['show', `FETCH_HEAD:${file}`], {
      encoding: 'utf-8',
    });
    if (show.status !== 0) continue;
    let rec;
    try {
      rec = JSON.parse(show.stdout);
    } catch (err) {
      log(`skip ${file}: ${err.message}`);
      continue;
    }
    if (rec && rec.browser && typeof rec.durationMs === 'number') {
      // The timing JSONs themselves don't contain run identity (the
      // workflow writes raw per-browser files), so we recover
      // runNumber + shortSha from the file path the workflow chose:
      //   data/<browser>/<runNumber>-<shortSha>.json
      // This is what makes (browser, runNumber) a stable dedup key
      // against the artifact-fallback records (which carry runNumber
      // from `gh run list`).
      const base = path.basename(file, '.json');
      const m = base.match(/^(\d+)-([0-9a-f]{4,40})$/i);
      const runNumberFromPath = m ? Number(m[1]) : null;
      const shaFromPath = m ? m[2] : null;
      out.push({
        ...rec,
        runId: rec.runId != null ? String(rec.runId) : null,
        runNumber: rec.runNumber || runNumberFromPath,
        sha: rec.sha || shaFromPath || null,
        createdAt: rec.createdAt || rec.timestamp || null,
        source: 'branch',
      });
    }
  }
  log(`loaded ${out.length} historical record(s) from branch ${HISTORY_BRANCH}`);
  return out;
}

function loadHistoryFromArtifacts() {
  if (SKIP_GH) {
    log('STREAMING_TREND_SKIP_GH=1 — skipping artifact history fetch');
    return [];
  }
  if (!whichGh()) {
    log('gh CLI not available — skipping artifact history fetch');
    return [];
  }
  const workflow = resolveWorkflowFile();
  const runs = listRecentRuns(workflow);
  if (runs.length === 0) {
    log('no prior successful runs found in artifact fallback');
    return [];
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-trend-'));
  const out = [];
  for (const run of runs) {
    const dest = path.join(tmp, String(run.databaseId));
    const ok = downloadArtifact(run.databaseId, dest);
    if (!ok) continue;
    if (!fs.existsSync(dest)) continue;
    for (const name of fs.readdirSync(dest)) {
      if (!name.endsWith('.json')) continue;
      const rec = safeReadJson(path.join(dest, name));
      if (rec && rec.browser && typeof rec.durationMs === 'number') {
        out.push({
          ...rec,
          runId: String(run.databaseId),
          runNumber: run.number,
          sha: run.headSha,
          createdAt: run.createdAt,
          source: 'artifact',
        });
      }
    }
  }
  return out;
}

function loadHistory() {
  // Prefer the orphan branch (unbounded retention). Fill in any gaps
  // from the 90-day artifact fallback for runs the branch hasn't
  // captured yet (e.g. immediately after enabling the branch, or if a
  // run failed to push to it). Records are de-duplicated by
  // (browser, runId) — the branch copy wins on conflict because it has
  // the long-term identity.
  const branchRecords = loadHistoryFromBranch();
  const artifactRecords = loadHistoryFromArtifacts();

  // Dedup identity:
  //   • runNumber is stable across both sources — branch records carry
  //     it via the `<runNumber>-<shortSha>.json` filename convention
  //     and artifact records carry it from `gh run list`.
  //   • sha is the secondary key (covers any older branch files that
  //     predate the filename convention).
  //   • createdAt is the last-resort key for hand-seeded local data.
  // Branch records take precedence on conflict because they're the
  // long-term source of truth.
  const identity = (rec) =>
    `${rec.browser}::${
      rec.runNumber != null
        ? `n${rec.runNumber}`
        : rec.sha
          ? `s${rec.sha}`
          : `t${rec.createdAt || ''}`
    }`;
  const seen = new Set();
  const out = [];
  for (const rec of [...branchRecords, ...artifactRecords]) {
    const key = identity(rec);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out;
}

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function linearSlopeMsPerRun(durations) {
  // Simple least-squares slope of duration vs. index. Positive = getting
  // slower per run, negative = getting faster. Returns null if not enough
  // data (need ≥ 3 points).
  const n = durations.length;
  if (n < 3) return null;
  const xs = durations.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = durations.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (durations[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (den === 0) return null;
  return num / den;
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : '—';
}

function fmtDate(iso) {
  if (!iso) return '—';
  // Just YYYY-MM-DD HH:MM UTC, no library needed.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
}

function buildPerBrowser(allRecords) {
  // Group by browser, sort each group oldest → newest by timestamp/createdAt.
  const byBrowser = new Map();
  for (const rec of allRecords) {
    if (!byBrowser.has(rec.browser)) byBrowser.set(rec.browser, []);
    byBrowser.get(rec.browser).push(rec);
  }
  for (const arr of byBrowser.values()) {
    arr.sort((a, b) => {
      const ta = a.timestamp || a.createdAt || '';
      const tb = b.timestamp || b.createdAt || '';
      return ta.localeCompare(tb);
    });
  }
  return byBrowser;
}

function renderReport(byBrowser, currentRun) {
  const lines = [];
  lines.push('## Streaming-download latency trend');
  lines.push('');
  if (currentRun.length === 0) {
    lines.push(
      '_No timing files were produced by this run — the smoke test may ' +
        'have crashed before recording. See the Playwright report._',
    );
    return lines.join('\n');
  }
  lines.push(
    `Last ${HISTORY_LIMIT} successful runs on \`${DEFAULT_BRANCH}\` plus ` +
      'this run, per browser. Numbers are wall-clock milliseconds for the ' +
      `~80-byte CSV download driven by \`tests/streamingDownload.spec.ts\`. ` +
      `A run flagged 🐢 means it is more than ${Math.round((CREEP_THRESHOLD - 1) * 100)}% ` +
      `slower than the rolling median of the last ${CREEP_MEDIAN_WINDOW} ` +
      'runs on that browser — a creeping regression that the hard ' +
      '`LATENCY_FAIL_MS` budget would not catch.',
  );
  lines.push('');

  let creepDetected = false;

  const browsers = [...byBrowser.keys()].sort();
  for (const browser of browsers) {
    const records = byBrowser.get(browser);
    const durations = records.map((r) => r.durationMs);
    const med = median(durations);
    const recentWindow = durations.slice(-CREEP_MEDIAN_WINDOW - 1, -1); // exclude current
    const recentMed = median(recentWindow);
    const slope = linearSlopeMsPerRun(durations);

    const current = records[records.length - 1];
    const isCurrent = current.source === 'current';
    let creepFlag = '';
    if (
      isCurrent &&
      recentMed != null &&
      recentWindow.length >= CREEP_MIN_SAMPLES &&
      current.durationMs > recentMed * CREEP_THRESHOLD
    ) {
      creepFlag = ' 🐢';
      creepDetected = true;
    }

    lines.push(`### ${browser}${creepFlag}`);
    lines.push('');
    const headerBits = [
      `samples: **${durations.length}**`,
      `median (all): **${med != null ? Math.round(med) + ' ms' : '—'}**`,
      recentMed != null
        ? `median (last ${recentWindow.length}): **${Math.round(recentMed)} ms**`
        : null,
      `current: **${current.durationMs} ms**`,
      slope != null
        ? `trend: **${slope >= 0 ? '+' : ''}${slope.toFixed(1)} ms/run**`
        : null,
    ].filter(Boolean);
    lines.push(headerBits.join(' · '));
    lines.push('');

    if (creepFlag) {
      lines.push(
        `> 🐢 **Creeping regression suspected.** Current run is ` +
          `${((current.durationMs / recentMed - 1) * 100).toFixed(0)}% above ` +
          `the rolling median of the last ${recentWindow.length} runs ` +
          `(${Math.round(recentMed)} ms). This is still within the hard ` +
          `\`LATENCY_FAIL_MS\` budget, but the slow-creep guard fired. ` +
          `Investigate before this reaches users.`,
      );
      lines.push('');
    }

    // Show the most recent N rows in a table, newest first.
    lines.push('| When (UTC) | Run | SHA | Duration | Δ vs. median | Status |');
    lines.push('|---|---|---|---:|---:|:---:|');
    const newestFirst = [...records].reverse().slice(0, HISTORY_LIMIT + 1);
    for (const r of newestFirst) {
      const delta =
        med != null
          ? `${r.durationMs >= med ? '+' : ''}${(r.durationMs - med).toFixed(0)} ms`
          : '—';
      const tag = r.source === 'current' ? ' **(this run)**' : '';
      const statusEmoji =
        r.status === 'fail' ? '❌' : r.status === 'warn' ? '⚠️' : '✅';
      lines.push(
        `| ${fmtDate(r.timestamp || r.createdAt)} | ${
          r.runNumber ? '#' + r.runNumber : (r.runId || '—')
        }${tag} | \`${shortSha(r.sha)}\` | ${r.durationMs} ms | ${delta} | ${statusEmoji} |`,
      );
    }
    lines.push('');
  }

  if (!creepDetected) {
    lines.push(
      `_No creeping regression detected on any browser (threshold: ` +
        `> ${CREEP_THRESHOLD}× rolling median of last ${CREEP_MEDIAN_WINDOW} runs)._`,
    );
  }

  lines.push('');
  lines.push(
    '<sub>Source data: `' + HISTORY_BRANCH + '` orphan branch (unbounded ' +
      'retention) with `streaming-download-timing` artifact fallback ' +
      '(90-day retention) for runs not yet on the branch, plus this run. ' +
      'Generated by `scripts/streaming-download-trend.cjs`.</sub>',
  );
  lines.push('<!-- streaming-download-trend -->');
  return lines.join('\n');
}

function main() {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  const current = loadCurrentRun();
  const history = loadHistory();
  const all = [...history, ...current];
  const byBrowser = buildPerBrowser(all);
  const report = renderReport(byBrowser, current);
  fs.writeFileSync(OUTPUT_FILE, report + '\n', 'utf-8');
  process.stdout.write(report + '\n');
  log(`wrote ${OUTPUT_FILE} (${current.length} current, ${history.length} historical records)`);
}

main();
