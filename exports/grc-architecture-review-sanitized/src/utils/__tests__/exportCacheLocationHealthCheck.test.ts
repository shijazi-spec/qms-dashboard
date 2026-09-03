/**
 * Regression test — startup health check for the staged-export cache dir
 * (Task #770).
 *
 * Validates the scoped walk:
 *   - Silent when STREAMING_EXPORT_CACHE_DIR is unset (default `/tmp` path).
 *   - Silent when the operator-controlled portion of the path has a tight
 *     0o700 ancestor between the cache dir and the system boundary (no
 *     /tmp- or /-filtering shenanigans — the walk genuinely terminates at
 *     the tight barrier).
 *   - Reports a 0o755 parent created by `mkdir -p` with the default umask
 *     (the misconfig the task is designed to catch).
 *
 * Run:  npx tsx src/utils/__tests__/exportCacheLocationHealthCheck.test.ts
 */

import assert from "assert";
import { promises as fsPromises } from "fs";
import os from "os";
import path from "path";

const ENV_KEY = "STREAMING_EXPORT_CACHE_DIR";

function pickFreshTmpDir(suffix: string): string {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return path.join(os.tmpdir(), `ExampleOrg-export-loc-${suffix}-${stamp}`);
}

async function withEnv<T>(
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prev;
  }
}

async function testSilentWhenEnvUnset() {
  if (process.platform === "win32") {
    console.log("  ⏭  skipped (Windows)");
    return;
  }
  const { checkStagedExportCacheLocation } = await import("../excelExport");
  const result = await withEnv(undefined, () => checkStagedExportCacheLocation());
  assert.equal(result.checked, false, "must not check when env is unset");
  assert.equal(result.findings.length, 0, "no findings when not checked");
}

async function testTightBarrierStopsWalkSilently() {
  // The walk must terminate at the first owner-only (0o700) ancestor and
  // not report anything above it. Crucially this test asserts the *full*
  // findings array is empty — no /tmp- or /-filtering — proving the
  // tight-barrier rule actually short-circuits the walk before it reaches
  // any g/o-traversable system root.
  if (process.platform === "win32") {
    console.log("  ⏭  skipped (Windows)");
    return;
  }
  const root = pickFreshTmpDir("tight");
  const cache = path.join(root, "cache");
  try {
    await fsPromises.mkdir(root, { recursive: true, mode: 0o700 });
    await fsPromises.chmod(root, 0o700);
    await fsPromises.mkdir(cache, { recursive: true, mode: 0o700 });

    const { checkStagedExportCacheLocation } = await import("../excelExport");
    const result = await withEnv(cache, () => checkStagedExportCacheLocation());
    assert.equal(result.checked, true, "must check when env set");
    assert.deepEqual(
      result.findings,
      [],
      `tight 0o700 parent must yield zero findings (no /tmp / / leakage), got: ${JSON.stringify(result.findings)}`,
    );
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testPermissiveParentTriggersFinding() {
  // The misconfiguration the task targets: cache dir under a 0o755 parent
  // (e.g. one created by mkdir -p with the default 0o022 umask).
  if (process.platform === "win32") {
    console.log("  ⏭  skipped (Windows)");
    return;
  }
  const root = pickFreshTmpDir("loose");
  const cache = path.join(root, "exports");
  try {
    await fsPromises.mkdir(root, { recursive: true, mode: 0o755 });
    await fsPromises.chmod(root, 0o755);
    await fsPromises.mkdir(cache, { recursive: true, mode: 0o700 });

    const { checkStagedExportCacheLocation } = await import("../excelExport");
    const result = await withEnv(cache, () => checkStagedExportCacheLocation());
    assert.equal(result.checked, true);

    const hit = result.findings.find((f) => f.path === root);
    assert.ok(
      hit,
      `expected a finding for ${root}, got: ${JSON.stringify(result.findings)}`,
    );
    assert.equal(hit!.mode, 0o755, "stat'd mode mismatch");
    assert.equal(
      hit!.permissiveBits,
      0o055,
      "must flag g+o read+execute bits",
    );

    // os.tmpdir() (the parent of `root`) is a stop boundary — it must NOT
    // appear in findings even though it's universally 0o1777. This proves
    // the boundary list (not a post-hoc filter) suppresses system roots.
    assert.ok(
      !result.findings.some((f) => f.path === path.resolve(os.tmpdir())),
      `os.tmpdir() must not appear in findings: ${JSON.stringify(result.findings)}`,
    );
    assert.ok(
      !result.findings.some((f) => f.path === "/"),
      `'/' must not appear in findings: ${JSON.stringify(result.findings)}`,
    );
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testTightAncestorAboveLooseStaysSilent() {
  // Layout: <root 0o700>/loose-mid 0o755/cache. Walk hits /loose-mid first,
  // reports it, walks to <root>, sees 0o700 → tight barrier → stops. Above
  // <root> there are loose ancestors (/tmp, /), but they MUST NOT be
  // walked since the tight barrier protects everything above.
  //
  // This test would catch a regression where the tight-barrier short-circuit
  // is removed and the walk falls back to all-the-way-to-root.
  if (process.platform === "win32") {
    console.log("  ⏭  skipped (Windows)");
    return;
  }
  const root = pickFreshTmpDir("mixed");
  const mid = path.join(root, "loose-mid");
  const cache = path.join(mid, "cache");
  try {
    await fsPromises.mkdir(root, { recursive: true, mode: 0o700 });
    await fsPromises.chmod(root, 0o700);
    await fsPromises.mkdir(mid, { recursive: true, mode: 0o755 });
    await fsPromises.chmod(mid, 0o755);
    await fsPromises.mkdir(cache, { recursive: true, mode: 0o700 });

    const { checkStagedExportCacheLocation } = await import("../excelExport");
    const result = await withEnv(cache, () => checkStagedExportCacheLocation());
    assert.equal(result.checked, true);

    assert.equal(
      result.findings.length,
      1,
      `expected exactly 1 finding (the loose mid dir), got ${JSON.stringify(result.findings)}`,
    );
    assert.equal(result.findings[0].path, mid);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testMissingParentIsCreatedTightAndSilent() {
  // The boot probe calls ensureStagedExportDir() before scanning, which
  // does mkdir(recursive: true, mode: 0o700). Node applies that mode to
  // every newly-created intermediate, so when the worker is the one that
  // first realises the path the parent is created tight (0o700) and the
  // scan is correctly silent — the worker has hardened the operator's
  // path on its own behalf. This test pins that hardening behaviour so a
  // future regression that drops the explicit mode arg (and falls back to
  // umask-default 0o755) is caught immediately.
  if (process.platform === "win32") {
    console.log("  ⏭  skipped (Windows)");
    return;
  }

  const workspace = pickFreshTmpDir("missing-parent");
  const intermediate = path.join(workspace, "intermediate");
  const cache = path.join(intermediate, "cache");
  const prevUmask = process.umask(0o022);
  try {
    await fsPromises.mkdir(workspace, { recursive: true, mode: 0o700 });
    await fsPromises.chmod(workspace, 0o700);
    await assert.rejects(
      () => fsPromises.stat(intermediate),
      /ENOENT/,
      "fixture: intermediate dir must not pre-exist",
    );

    const { checkStagedExportCacheLocation } = await import("../excelExport");
    const result = await withEnv(cache, () => checkStagedExportCacheLocation());
    assert.equal(result.checked, true);

    // Probe must have materialised both segments tight.
    const intermediateMode = (await fsPromises.stat(intermediate)).mode & 0o777;
    assert.equal(
      intermediateMode,
      0o700,
      `boot probe must create missing parent at 0o700 (worker hardening), got 0o${intermediateMode.toString(8)}`,
    );
    const cacheMode = (await fsPromises.stat(cache)).mode & 0o777;
    assert.equal(cacheMode, 0o700, "cache dir must be 0o700");

    // Scan must be silent — every ancestor below the system boundary is
    // owner-only.
    assert.deepEqual(
      result.findings,
      [],
      `expected no findings (worker created tight parent), got: ${JSON.stringify(result.findings)}`,
    );
  } finally {
    process.umask(prevUmask);
    await fsPromises.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

async function testPreExistingLooseParentIsFlaggedAfterEnsure() {
  // The complementary case to the one above and the actual misconfig the
  // task targets: a parent that was created out-of-band (by ops, by a
  // previous build, by `install -d`, etc.) and left at 0o755. The boot
  // probe's ensureStagedExportDir() call must NOT silently widen or
  // narrow it — chmod on a pre-existing parent is intentionally out of
  // scope (the worker doesn't own it in the original failure mode) — and
  // the subsequent scan must flag it.
  if (process.platform === "win32") {
    console.log("  ⏭  skipped (Windows)");
    return;
  }
  const workspace = pickFreshTmpDir("preexisting-loose");
  const looseParent = path.join(workspace, "shared");
  const cache = path.join(looseParent, "exports");
  try {
    // Workspace: tight. Parent: deliberately loose (simulates an ops-
    // provisioned shared dir). Cache itself: not yet created — boot probe
    // must create it.
    await fsPromises.mkdir(workspace, { recursive: true, mode: 0o700 });
    await fsPromises.chmod(workspace, 0o700);
    await fsPromises.mkdir(looseParent, { recursive: true, mode: 0o755 });
    await fsPromises.chmod(looseParent, 0o755);

    const { checkStagedExportCacheLocation } = await import("../excelExport");
    const result = await withEnv(cache, () => checkStagedExportCacheLocation());
    assert.equal(result.checked, true);

    // Cache leaf must be created tight by ensureStagedExportDir.
    const cacheMode = (await fsPromises.stat(cache)).mode & 0o777;
    assert.equal(cacheMode, 0o700, "cache leaf must be 0o700");

    // Pre-existing loose parent must still be 0o755 (ensure does not
    // tighten foreign ancestors) and must appear in the findings.
    const parentMode = (await fsPromises.stat(looseParent)).mode & 0o777;
    assert.equal(
      parentMode,
      0o755,
      "pre-existing loose parent must not be widened or narrowed by ensure",
    );

    const hit = result.findings.find((f) => f.path === looseParent);
    assert.ok(
      hit,
      `expected a finding for the pre-existing loose parent ${looseParent}, got: ${JSON.stringify(result.findings)}`,
    );
    assert.equal(hit!.mode, 0o755);
    assert.equal(hit!.permissiveBits, 0o055);
  } finally {
    await fsPromises.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  try {
    console.log("— Staged export cache location health check —");
    await testSilentWhenEnvUnset();
    console.log("  ✓ silent when STREAMING_EXPORT_CACHE_DIR is unset");
    await testTightBarrierStopsWalkSilently();
    console.log("  ✓ tight 0o700 parent yields zero findings (no system-root noise)");
    await testPermissiveParentTriggersFinding();
    console.log("  ✓ flags 0o755 parent (g+o r+x) as a finding");
    await testTightAncestorAboveLooseStaysSilent();
    console.log("  ✓ tight ancestor above a loose mid stops the walk");
    await testMissingParentIsCreatedTightAndSilent();
    console.log("  ✓ missing parent is created tight by ensure → silent");
    await testPreExistingLooseParentIsFlaggedAfterEnsure();
    console.log("  ✓ pre-existing 0o755 parent is still flagged after ensure runs");
    console.log("\n✅  All cache-location health-check tests passed\n");
    process.exit(0);
  } catch (err: any) {
    console.error("\n❌  Test failed:", err?.message || err);
    if (err?.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
