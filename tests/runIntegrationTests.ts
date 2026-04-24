/**
 * Discovers and runs every tests/*.test.ts file (excluding _helpers and
 * fixtures) using the same `npx tsx <file>` pattern each test was designed
 * for. Each test runs in its own subprocess so module-level side effects (DB
 * pools, env mutation) stay isolated. Aggregates pass/fail and exits non-zero
 * if any test file fails — designed to be invoked from `npm test` and from CI.
 *
 * After the tsx-based suites finish, this also invokes `npx vitest run` to
 * execute the vitest-based suites under `tests/vitest/**` which need real
 * module mocking (e.g. stubbing dynamic ESM imports of database modules).
 *
 * Usage:    npm test
 *           npx tsx tests/runIntegrationTests.ts
 */

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const TESTS_DIR = path.resolve(new URL(".", import.meta.url).pathname);

async function discoverTestFiles(): Promise<string[]> {
  const entries = await readdir(TESTS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
    .map((e) => path.join(TESTS_DIR, e.name))
    .sort();
}

function runOne(file: string): Promise<{ file: string; ok: boolean; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", file], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      resolve({ file, ok: code === 0, code: code ?? -1 });
    });
    child.on("error", (err) => {
      console.error(`Failed to spawn ${file}: ${(err as Error).message}`);
      resolve({ file, ok: false, code: -1 });
    });
  });
}

function runVitest(): Promise<{ file: string; ok: boolean; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["vitest", "run", "--reporter=default"], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      resolve({ file: "tests/vitest/** (vitest)", ok: code === 0, code: code ?? -1 });
    });
    child.on("error", (err) => {
      console.error(`Failed to spawn vitest: ${(err as Error).message}`);
      resolve({ file: "tests/vitest/** (vitest)", ok: false, code: -1 });
    });
  });
}

async function main(): Promise<void> {
  const files = await discoverTestFiles();
  if (files.length === 0) {
    console.error("No *.test.ts files discovered under tests/");
    process.exit(1);
  }

  console.log(`\n▶ Running ${files.length} integration test file(s) + vitest suite\n`);

  const results: Array<{ file: string; ok: boolean; code: number }> = [];
  for (const file of files) {
    console.log(`\n──── ${path.relative(process.cwd(), file)} ────`);
    const r = await runOne(file);
    results.push(r);
  }

  console.log(`\n──── tests/vitest/** (vitest run) ────`);
  results.push(await runVitest());

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;

  console.log("\n========== Integration test summary ==========");
  for (const r of results) {
    const tag = r.ok ? "PASS" : `FAIL (exit ${r.code})`;
    console.log(`  [${tag}] ${r.file.startsWith("tests/") ? r.file : path.relative(process.cwd(), r.file)}`);
  }
  console.log(`\n${passed}/${results.length} test files passed`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("runIntegrationTests crashed:", err);
  process.exit(1);
});
