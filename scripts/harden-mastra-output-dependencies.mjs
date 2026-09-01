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
import { resolve } from 'node:path';

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

function assertNoLegacyProviderUtils(lockfile) {
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

async function main() {
  const rootPackage = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'));
  const outputPackage = JSON.parse(await readFile(outputPackagePath, 'utf8'));

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

  console.log('[harden-mastra-output] auditing generated production dependencies');
  runNpm(['audit', '--omit=dev']);
  console.log('[harden-mastra-output] deployment dependency tree is clean');
}

main().catch(error => {
  console.error('[harden-mastra-output] failed:', error.message);
  process.exit(1);
});