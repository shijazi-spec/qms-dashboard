/**
 * Discovers and runs every tests/*.test.ts and src/**\/*.test.ts file
 * (excluding _helpers and fixtures) using the same `npx tsx <file>` pattern
 * each test was designed for. Each test runs in its own subprocess so
 * module-level side effects (DB pools, env mutation) stay isolated. Aggregates
 * pass/fail and exits non-zero if any test file fails — designed to be invoked
 * from `npm test` and from CI.
 *
 * After the tsx-based suites finish, this also invokes `npx vitest run` to
 * execute the vitest-based suites under `tests/vitest/**` which need real
 * module mocking (e.g. stubbing dynamic ESM imports of database modules).
 *
 * Concurrency
 * -----------
 * The tsx test files are dispatched through a worker pool (default 4
 * concurrent subprocesses) so the fixed tsx + module-init cost (DB pool
 * bootstrap, schema seeding) is paid in parallel rather than serially. Each
 * subprocess still gets its own pg Pool / module graph, preserving the
 * per-file isolation the existing tests rely on (no cookie/role bleed-through
 * between suites). The vitest suite runs concurrently with the tsx workers
 * and is bounded by its own internal `pool: "forks"` config.
 *
 * Output from each subprocess is buffered and printed as a single labelled
 * block once the file finishes, so parallel runs do not produce interleaved
 * unreadable logs.
 *
 * Override the worker count with TEST_CONCURRENCY (e.g. TEST_CONCURRENCY=1
 * for fully serial debugging).
 *
 * Cross-browser Playwright smoke (streaming downloads): if the env var
 * `RUN_STREAMING_DOWNLOAD_E2E=1` is set we additionally run the streaming
 * download spec across Chromium/Firefox/WebKit. This needs the dev server
 * running and the requested browsers installed (`npx playwright install`).
 * The dedicated CI workflow `.github/workflows/streaming-download-smoke.yml`
 * sets that env after standing up the prerequisites, so a regression in
 * any browser engine fails CI for that workflow.
 *
 * Streaming-export latency HTTP integration test: if the env var
 * `RUN_STREAMING_EXPORT_LATENCY_E2E=1` is set we additionally run
 * `tests/streamingExportLatency.integration.ts` against a running dev
 * server. It hits every export endpoint that goes through
 * `stageStreamingExportFromHono` and asserts the `X-Stream-TTFB-Ms`
 * header is present and within `EXPORT_TTFB_BUDGET_MS` — catching
 * server-side buffering regressions the browser smoke test cannot see.
 * The dedicated CI workflow `.github/workflows/streaming-download-smoke.yml`
 * sets the env after standing up the dev server, so a regression in any
 * single export endpoint fails CI for that workflow.
 *
 * Review-filter partial-index EXPLAIN test: if `RUN_REVIEW_FILTER_INDEX_E2E=1`
 * is set we additionally run `tests/aiApprovalReviewFilterIndex.integration.ts`
 * which seeds ≥100k synthetic event_logs rows and asserts that the AI
 * approval queue's `reviewFilter` NOT EXISTS sub-query uses the
 * `idx_event_logs_view_audit` partial index rather than seq-scanning a
 * partition. The test validates `DATABASE_URL` itself and exits with a
 * clear error if it's missing. Wired so a future schema change that
 * accidentally drops or renames the index fails CI.
 *
 * RBAC HTTP integration tests: if the env var `RUN_RBAC_INTEGRATION_E2E=1`
 * is set we additionally run `tests/rbacRouteLockdown.integration.ts` and
 * `tests/rbacReportRoutes.integration.ts` against a running dev server.
 * Both files validate `DATABASE_URL` and `SESSION_SECRET` themselves and
 * exit with a clear error if either is missing. The dedicated CI workflow
 * `.github/workflows/rbac-integration-tests.yml` boots the dev server with
 * those env vars set, so a regression in the route-lockdown middleware
 * fails CI in the same run as the unit tests.
 *
 * Usage:    npm test
 *           npx tsx tests/runIntegrationTests.ts
 *           TEST_CONCURRENCY=1 npx tsx tests/runIntegrationTests.ts
 */

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pLimit from "p-limit";

const TESTS_DIR = path.resolve(new URL(".", import.meta.url).pathname);
const ROOT_DIR = path.resolve(TESTS_DIR, "..");

interface RunResult {
  file: string;
  ok: boolean;
  code: number;
  durationMs: number;
}

/**
 * Recursively collect all *.test.ts files under a given directory.
 * Skips __tests__ subdirectories — those are vitest-managed and discovered
 * via `npx vitest run` rather than the tsx subprocess runner.
 */
async function collectTestFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "__tests__") {
      results.push(...(await collectTestFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

async function discoverTestFiles(): Promise<string[]> {
  // tests/*.test.ts (top-level only, preserving existing behaviour)
  const testsEntries = await readdir(TESTS_DIR, { withFileTypes: true });
  const testsFiles = testsEntries
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
    .map((e) => path.join(TESTS_DIR, e.name));

  // src/**/*.test.ts (recursive — picks up e.g. redactSensitiveFields.test.ts)
  const srcDir = path.join(ROOT_DIR, "src");
  const srcFiles = await collectTestFiles(srcDir).catch((err: unknown) => {
    console.error(`Failed to discover src/**/*.test.ts: ${(err as Error).message}`);
    process.exit(1);
  }) as string[];

  return [...testsFiles, ...srcFiles].sort();
}

/**
 * Spawn one tsx subprocess. Captures stdout+stderr into a single buffer so
 * parallel runs don't interleave. The buffered output is flushed as a single
 * labelled block once the child exits.
 */
function runOne(file: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const rel = path.relative(process.cwd(), file);
    const child = spawn("npx", ["tsx", file], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const chunks: Buffer[] = [];
    child.stdout?.on("data", (b: Buffer) => chunks.push(b));
    child.stderr?.on("data", (b: Buffer) => chunks.push(b));

    let finished = false;
    const finish = (code: number) => {
      // A child can emit both `error` and `exit` (e.g. spawn failure followed
      // by the synthetic exit event). Guard against double-resolving.
      if (finished) return;
      finished = true;
      const durationMs = Date.now() - started;
      const output = Buffer.concat(chunks).toString("utf8");
      // Print as one coherent block so parallel runs stay readable.
      process.stdout.write(
        `\n──── ${rel}  (${(durationMs / 1000).toFixed(1)}s, exit ${code}) ────\n` +
          (output.endsWith("\n") || output.length === 0 ? output : output + "\n"),
      );
      resolve({ file, ok: code === 0, code, durationMs });
    };

    child.on("exit", (code) => finish(code ?? -1));
    child.on("error", (err) => {
      chunks.push(Buffer.from(`Failed to spawn ${rel}: ${(err as Error).message}\n`));
      finish(-1);
    });
  });
}

function runVitest(): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const label = "tests/vitest/** (vitest)";
    const child = spawn("npx", ["vitest", "run", "--reporter=default"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const chunks: Buffer[] = [];
    child.stdout?.on("data", (b: Buffer) => chunks.push(b));
    child.stderr?.on("data", (b: Buffer) => chunks.push(b));

    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      const durationMs = Date.now() - started;
      const output = Buffer.concat(chunks).toString("utf8");
      process.stdout.write(
        `\n──── ${label}  (${(durationMs / 1000).toFixed(1)}s, exit ${code}) ────\n` +
          (output.endsWith("\n") || output.length === 0 ? output : output + "\n"),
      );
      resolve({ file: label, ok: code === 0, code, durationMs });
    };

    child.on("exit", (code) => finish(code ?? -1));
    child.on("error", (err) => {
      chunks.push(Buffer.from(`Failed to spawn vitest: ${(err as Error).message}\n`));
      finish(-1);
    });
  });
}

function resolveConcurrency(fileCount: number): number {
  const raw = process.env.TEST_CONCURRENCY;
  if (raw && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.min(parsed, Math.max(1, fileCount));
    }
  }
  // Default: 4 workers, but never more than file count or available CPUs.
  const cpus = Math.max(1, os.cpus().length);
  return Math.max(1, Math.min(4, cpus, Math.max(1, fileCount)));
}

function runRbacIntegrationSuite(): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const label =
      "tests/rbacRouteLockdown.integration.ts + tests/rbacReportRoutes.integration.ts";
    const child = spawn("bash", ["scripts/run-rbac-integration-tests.sh"], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      resolve({
        file: label,
        ok: code === 0,
        code: code ?? -1,
        durationMs: Date.now() - started,
      });
    });
    child.on("error", (err) => {
      console.error(
        `Failed to spawn rbac integration suite: ${(err as Error).message}`,
      );
      resolve({
        file: label,
        ok: false,
        code: -1,
        durationMs: Date.now() - started,
      });
    });
  });
}

function runReviewFilterIndex(): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const label = "tests/aiApprovalReviewFilterIndex.integration.ts";
    const child = spawn(
      "npx",
      ["tsx", "tests/aiApprovalReviewFilterIndex.integration.ts"],
      { stdio: "inherit", env: process.env },
    );
    child.on("exit", (code) => {
      resolve({
        file: label,
        ok: code === 0,
        code: code ?? -1,
        durationMs: Date.now() - started,
      });
    });
    child.on("error", (err) => {
      console.error(
        `Failed to spawn review-filter index suite: ${(err as Error).message}`,
      );
      resolve({
        file: label,
        ok: false,
        code: -1,
        durationMs: Date.now() - started,
      });
    });
  });
}

function runStreamingExportLatency(): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const label = "tests/streamingExportLatency.integration.ts";
    const child = spawn(
      "npx",
      ["tsx", "tests/streamingExportLatency.integration.ts"],
      { stdio: "inherit", env: process.env },
    );
    child.on("exit", (code) => {
      resolve({
        file: label,
        ok: code === 0,
        code: code ?? -1,
        durationMs: Date.now() - started,
      });
    });
    child.on("error", (err) => {
      console.error(
        `Failed to spawn streaming-export latency suite: ${(err as Error).message}`,
      );
      resolve({
        file: label,
        ok: false,
        code: -1,
        durationMs: Date.now() - started,
      });
    });
  });
}

function runStreamingDownloadSmoke(): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const label = "tests/streamingDownload.spec.ts (chromium+firefox+webkit)";
    const child = spawn(
      "npx",
      ["playwright", "test", "tests/streamingDownload.spec.ts", "--reporter=list"],
      { stdio: "inherit", env: process.env },
    );
    child.on("exit", (code) => {
      resolve({
        file: label,
        ok: code === 0,
        code: code ?? -1,
        durationMs: Date.now() - started,
      });
    });
    child.on("error", (err) => {
      console.error(`Failed to spawn playwright: ${(err as Error).message}`);
      resolve({
        file: label,
        ok: false,
        code: -1,
        durationMs: Date.now() - started,
      });
    });
  });
}

async function main(): Promise<void> {
  const overallStart = Date.now();
  const files = await discoverTestFiles();
  if (files.length === 0) {
    console.error("No *.test.ts files discovered under tests/ or src/");
    process.exit(1);
  }

  const concurrency = resolveConcurrency(files.length);
  console.log(
    `\n▶ Running ${files.length} integration test file(s) + vitest suite ` +
      `(concurrency=${concurrency})\n`,
  );

  const limit = pLimit(concurrency);

  // Dispatch all tsx test files through the worker pool, plus the vitest
  // suite, all in parallel. Vitest manages its own internal worker pool
  // (`pool: "forks"`) so it composes cleanly with the tsx workers.
  const tsxPromises = files.map((file) => limit(() => runOne(file)));
  const vitestPromise = runVitest();

  const tsxResults = await Promise.all(tsxPromises);
  const vitestResult = await vitestPromise;

  const results: RunResult[] = [...tsxResults, vitestResult];

  if (process.env.RUN_STREAMING_DOWNLOAD_E2E === "1") {
    console.log(`\n──── tests/streamingDownload.spec.ts (playwright, all engines) ────`);
    results.push(await runStreamingDownloadSmoke());
  } else {
    console.log(
      `\n[skip] streamingDownload.spec.ts — set RUN_STREAMING_DOWNLOAD_E2E=1 with the dev server running and Playwright browsers installed to include it.`,
    );
  }

  if (process.env.RUN_STREAMING_EXPORT_LATENCY_E2E === "1") {
    console.log(
      `\n──── Streaming-export latency HTTP integration tests ────`,
    );
    results.push(await runStreamingExportLatency());
  } else {
    console.log(
      `\n[skip] streaming-export latency HTTP integration tests — set RUN_STREAMING_EXPORT_LATENCY_E2E=1 with DATABASE_URL, SESSION_SECRET, and the dev server running to include them.`,
    );
  }

  if (process.env.RUN_REVIEW_FILTER_INDEX_E2E === "1") {
    console.log(
      `\n──── Review-filter partial-index EXPLAIN integration test ────`,
    );
    results.push(await runReviewFilterIndex());
  } else {
    console.log(
      `\n[skip] review-filter partial-index EXPLAIN test — set RUN_REVIEW_FILTER_INDEX_E2E=1 with DATABASE_URL to seed ≥100k rows and verify idx_event_logs_view_audit is used.`,
    );
  }

  if (process.env.RUN_RBAC_INTEGRATION_E2E === "1") {
    console.log(
      `\n──── RBAC HTTP integration tests (rbacRouteLockdown + rbacReportRoutes) ────`,
    );
    results.push(await runRbacIntegrationSuite());
  } else {
    console.log(
      `\n[skip] RBAC HTTP integration tests — set RUN_RBAC_INTEGRATION_E2E=1 with DATABASE_URL, SESSION_SECRET, and the dev server running to include them.`,
    );
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;

  // Sort summary by duration (slowest first) so future tuning is obvious.
  const summary = [...results].sort((a, b) => b.durationMs - a.durationMs);

  console.log("\n========== Integration test summary ==========");
  for (const r of summary) {
    const tag = r.ok ? "PASS" : `FAIL (exit ${r.code})`;
    const rel = r.file.startsWith("tests/")
      ? r.file
      : path.relative(process.cwd(), r.file);
    console.log(`  [${tag}] ${(r.durationMs / 1000).toFixed(1)}s  ${rel}`);
  }
  const wallClock = ((Date.now() - overallStart) / 1000).toFixed(1);
  console.log(
    `\n${passed}/${results.length} test files passed in ${wallClock}s wall clock`,
  );

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("runIntegrationTests crashed:", err);
  process.exit(1);
});
