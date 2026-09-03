#!/usr/bin/env node
/**
 * Mastra generates a standalone deployment package.json and installs it before
 * returning from `mastra build`. The generated manifest intentionally omits the
 * root npm overrides, which would otherwise reintroduce vulnerable transitive
 * releases in the deployable artifact.
 *
 * This build step copies the audited root overrides and provider-utils
 * compatibility patch into the generated artifact, reinstalls that production
 * tree, and fails unless the artifact audit is clean.
 */

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const semver = require('semver');

const cwd = process.cwd();
const outputDir = resolve(cwd, '.mastra/output');
const outputPackagePath = resolve(outputDir, 'package.json');
const outputCompatScript = resolve(outputDir, 'scripts/patch-provider-utils-v3-compat.mjs');

function runNpm(args) {
  const result = spawnSync('npm', args, {
    cwd: outputDir,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

export function assertNoLegacyProviderUtils(lockfile) {
  const legacy = Object.entries(lockfile.packages ?? {})
    .filter(([path, metadata]) =>
      path.endsWith('node_modules/@ai-sdk/provider-utils') &&
      /^[23]\./.test(String(metadata.version)),
    )
    .map(([path, metadata]) => `${path}@${metadata.version}`);
  if (legacy.length > 0) {
    throw new Error(`legacy provider-utils remains in deployment tree: ${legacy.join(', ')}`);
  }
}

export function assertEnginesSupportRuntimeNode(lockfile, runtimeNodeVersion = process.versions.node) {
  const incompatible = Object.entries(lockfile.packages ?? {})
    .filter(([path]) => path !== '')
    .filter(([, metadata]) => !<REDACTED_HOST> && !metadata.devOptional)
    .filter(([, metadata]) => {
      const range = metadata.engines?.node;
      if (typeof range !== 'string' || range.trim() === '') return false;
      if (!semver.validRange(range)) return false;
      return !semver.satisfies(runtimeNodeVersion, range);
    })
    .map(([path, metadata]) =>
      `${path.replace(/^.*node_modules\//, '')}@${metadata.version} requires node ${metadata.engines.node}`,
    );
  if (incompatible.length > 0) {
    throw new Error(
      `deployment tree contains packages incompatible with runtime Node ${runtimeNodeVersion} ` +
      `(pin them to a compatible major in root package.json dependencies/overrides):\n  - ` +
      incompatible.join('\n  - '),
    );
  }
}

/**
 * Rewrites the generated Mastra output manifest so every dependency the root
 * package.json audits (dependencies first, then overrides) replaces whatever
 * spec the generator emitted — most importantly the `LLMProvider: "latest"` pin,
 * which must become the exact Node-compatible version declared at the root.
 * Dependencies without a root pin pass through untouched. Root overrides are
 * copied wholesale. Returns the same (mutated) manifest for convenience.
 */
export function applyRootDependencyPins(outputPackage, rootPackage) {
  for (const dependencyName of Object.keys(outputPackage.dependencies ?? {})) {
    const rootDependency = rootPackage.dependencies?.[dependencyName];
    const rootOverride = rootPackage.overrides?.[dependencyName];
    if (typeof rootDependency === 'string') {
      outputPackage.dependencies[dependencyName] = rootDependency;
    } else if (typeof rootOverride === 'string') {
      outputPackage.dependencies[dependencyName] = rootOverride;
    }
  }
  outputPackage.overrides = rootPackage.overrides;
  return outputPackage;
}

async function main() {
  const rootPackage = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'));
  const outputPackage = JSON.parse(await readFile(outputPackagePath, 'utf8'));

  applyRootDependencyPins(outputPackage, rootPackage);
  outputPackage.scripts = {
    ...outputPackage.scripts,
    postinstall: 'node scripts/patch-provider-utils-v3-compat.mjs',
  };

  await mkdir(resolve(outputDir, 'scripts'), { recursive: true });
  await cp(
    resolve(cwd, 'scripts/patch-provider-utils-v3-compat.mjs'),
    outputCompatScript,
  );
  await writeFile(outputPackagePath, `${JSON.stringify(outputPackage, null, 2)}\n`, 'utf8');

  console.log('[harden-mastra-output] reinstalling generated production dependencies');
  runNpm(['install', '--omit=dev', '--no-audit']);

  const lockfile = JSON.parse(
    await readFile(resolve(outputDir, 'package-lock.json'), 'utf8'),
  );
  assertNoLegacyProviderUtils(lockfile);
  assertEnginesSupportRuntimeNode(lockfile);

  console.log('[harden-mastra-output] auditing generated production dependencies');
  runNpm(['audit', '--omit=dev']);
  console.log('[harden-mastra-output] deployment dependency tree is clean');
}

// Only run the full harden pipeline when executed directly (not when the
// engines-check helper is imported by tests).
if (process.argv[1] && import.meta.url === new URL(`<REDACTED_URL>`).href) {
  main().catch(error => {
    console.error('[harden-mastra-output] failed:', error.message);
    process.exit(1);
  });
}