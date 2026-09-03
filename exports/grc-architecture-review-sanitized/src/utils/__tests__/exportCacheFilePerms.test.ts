/**
 * Regression test — Staged streaming-export files are owner-only (0o600).
 *
 * Background: streaming XLSX/CSV exports stage to a temp file under
 *   ${tmpdir}/ExampleOrg-export-cache (or STREAMING_EXPORT_CACHE_DIR) so
 * downloads can be paused/resumed. Those files contain sensitive data
 * (risk registers, audit findings, vendor records, PDPL data) and live
 * on disk for up to an hour. Without explicit modes Node defaults to
 * the process umask (typically 0o644), which means any other OS user on
 * the same host can read them. This test guards the hardening:
 *
 *   - cache directory created with mode 0o700
 *   - each staged file created with mode 0o600
 *
 * Run:  npx tsx src/utils/__tests__/exportCacheFilePerms.test.ts
 */

import assert from "assert";
import { promises as fsPromises } from "fs";
import os from "os";
import path from "path";

const ENV_KEY = "STREAMING_EXPORT_CACHE_DIR";

function pickFreshTmpDir(): string {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return path.join(os.tmpdir(), `ExampleOrg-export-cache-test-${stamp}`);
}

async function statMode(p: string): Promise<number> {
  const st = await fsPromises.stat(p);
  return st.mode & 0o777;
}

async function readDirRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const ents = await fsPromises.readdir(dir, { withFileTypes: true });
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await readDirRecursive(full)));
    else out.push(full);
  }
  return out;
}

async function testStagedDirAndFileAreOwnerOnly() {
  // POSIX-only check — Windows Node ignores fs modes.
  if (process.platform === "win32") {
    console.log("  ⏭  skipped (Windows — fs modes not enforced)");
    return;
  }

  const tmpDir = pickFreshTmpDir();
  const prevEnv = process.env[ENV_KEY];
  process.env[ENV_KEY] = tmpDir;

  try {
    const {
      stageAndServeStreamingExport,
      _resetStagedExportCacheForTests,
    } = await import("../excelExport");

    await _resetStagedExportCacheForTests();

    // Drive a real staging through the public entry point so the test
    // exercises the same mkdir + fsPromises.open path that production
    // uses. The build() callback returns a small CSV-flavoured Response.
    const csvBody = "id,name\n1,alpha\n2,beta\n";
    const response = await stageAndServeStreamingExport(
      { range: null, ifRange: null, ifNoneMatch: null },
      `perms-test-${Date.now()}-${Math.random()}`,
      () =>
        new Response(csvBody, {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="perms-test.csv"',
          },
        }),
    );

    assert.equal(response.status, 200, "staging must return 200");

    // Drain the response so the file flush is fully observable. The
    // server-side Range path uses fs.createReadStream — we just need the
    // promise to resolve so we know drainResponseBodyToFile has finished.
    const drained = await response.arrayBuffer();
    assert.ok(drained.byteLength > 0, "drained body must be non-empty");

    // Cache dir mode — must be 0o700.
    const dirMode = await statMode(tmpDir);
    assert.equal(
      dirMode,
      0o700,
      `cache dir mode must be 0o700, got 0o${dirMode.toString(8)}`,
    );

    // The staged file lives directly under the cache dir.
    const files = await readDirRecursive(tmpDir);
    assert.ok(
      files.length >= 1,
      `expected at least one staged file under ${tmpDir}, found ${files.length}`,
    );
    for (const f of files) {
      const m = await statMode(f);
      assert.equal(
        m,
        0o600,
        `staged file ${path.basename(f)} mode must be 0o600, got 0o${m.toString(8)}`,
      );
    }

    await _resetStagedExportCacheForTests();
  } finally {
    if (prevEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prevEnv;
    // Best-effort cleanup — leave the dir if rm fails (e.g. file in use).
    await fsPromises
      .rm(tmpDir, { recursive: true, force: true })
      .catch(() => {});
  }
}

async function testReusedDirIsTightenedOnNextEnsure() {
  if (process.platform === "win32") {
    console.log("  ⏭  skipped (Windows — fs modes not enforced)");
    return;
  }

  const tmpDir = pickFreshTmpDir();
  const prevEnv = process.env[ENV_KEY];

  try {
    // Pre-create the dir with loose 0o755 perms — simulates a directory
    // left over from a previous build that ran before this hardening.
    await fsPromises.mkdir(tmpDir, { recursive: true, mode: 0o755 });
    await fsPromises.chmod(tmpDir, 0o755);
    const initialMode = await statMode(tmpDir);
    assert.equal(initialMode, 0o755, "fixture: dir must start at 0o755");

    process.env[ENV_KEY] = tmpDir;
    const {
      stageAndServeStreamingExport,
      _resetStagedExportCacheForTests,
    } = await import("../excelExport");
    await _resetStagedExportCacheForTests();

    const response = await stageAndServeStreamingExport(
      { range: null, ifRange: null, ifNoneMatch: null },
      `perms-tighten-test-${Date.now()}-${Math.random()}`,
      () =>
        new Response("a,b\n1,2\n", {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="t.csv"',
          },
        }),
    );
    assert.equal(response.status, 200);
    await response.arrayBuffer();

    // After ensureStagedExportDir runs, the chmod fallback should have
    // tightened the pre-existing directory down to 0o700.
    const finalMode = await statMode(tmpDir);
    assert.equal(
      finalMode,
      0o700,
      `pre-existing cache dir must be tightened to 0o700, got 0o${finalMode.toString(8)}`,
    );

    await _resetStagedExportCacheForTests();
  } finally {
    if (prevEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prevEnv;
    await fsPromises
      .rm(tmpDir, { recursive: true, force: true })
      .catch(() => {});
  }
}

async function main() {
  try {
    console.log("— Staged export cache: file & dir perms —");
    await testStagedDirAndFileAreOwnerOnly();
    console.log("  ✓ fresh cache dir is 0o700, staged file is 0o600");

    console.log("— Pre-existing cache dir is tightened on next ensure —");
    await testReusedDirIsTightenedOnNextEnsure();
    console.log("  ✓ pre-existing 0o755 dir is chmod'd down to 0o700");

    console.log("\n✅  All export-cache file-perm tests passed\n");
    process.exit(0);
  } catch (err: any) {
    console.error("\n❌  Test failed:", err?.message || err);
    if (err?.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
