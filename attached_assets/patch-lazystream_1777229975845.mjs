#!/usr/bin/env node
/**
 * patch-lazystream.mjs
 *
 * Idempotent post-install patcher for `node_modules/lazystream/lib/lazystream.js`.
 *
 * Background
 * ----------
 * `lazystream` (transitive dep of zip-stream / archiver) imports PassThrough as:
 *   var PassThrough = require('stream').PassThrough;
 *
 * Under the esbuild bundler used by `mastra build`, that reference resolves to
 * `undefined` at runtime and the deploy crashes during startup with:
 *   TypeError: PassThrough is not a constructor
 *
 * Replacing the require with `require('readable-stream').PassThrough` uses the
 * userland copy of readable-stream (already present as a transitive dep of pg,
 * pino, etc.) which bundles cleanly.
 *
 * Guarantees
 * ----------
 *   - Idempotent: running twice leaves the file byte-identical the second time.
 *   - Bounded: only writes under `node_modules/lazystream/**`; refuses otherwise.
 *   - Safe-no-op: if lazystream isn't installed, or the file has already been
 *     patched, or the expected `require('stream').PassThrough` pattern is not
 *     found, the script logs a reason and exits 0 so `npm install` never fails.
 *
 * Remove this script when lazystream ships a fix upstream OR when the
 * dependency chain that pulls it in is removed.
 */

import { readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET_REL = 'node_modules/lazystream/lib/lazystream.js';
const BOUND_PREFIX = 'node_modules' + sep + 'lazystream' + sep;

const ORIGINAL = `require('stream').PassThrough`;
const PATCHED  = `require('readable-stream').PassThrough`;

// Also handle double-quoted and `require("stream")` variants defensively.
const ORIGINAL_VARIANTS = [
  `require('stream').PassThrough`,
  `require("stream").PassThrough`,
];

async function fileExists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

async function main() {
  const cwd = process.cwd();
  const target = resolve(cwd, TARGET_REL);

  // Bounded-scope guard: refuse to write outside node_modules/lazystream/
  const rel = target.substring(cwd.length + 1);
  if (!rel.startsWith(BOUND_PREFIX)) {
    console.error(`[patch-lazystream] refusing to write outside ${BOUND_PREFIX}; got ${rel}`);
    process.exit(0);
  }

  if (!(await fileExists(target))) {
    console.log('[patch-lazystream] lazystream not installed in node_modules — skipping (exit 0)');
    return;
  }

  const before = await readFile(target, 'utf8');

  if (before.includes(PATCHED)) {
    console.log('[patch-lazystream] already patched — no-op (exit 0)');
    return;
  }

  let after = before;
  let hits = 0;
  for (const variant of ORIGINAL_VARIANTS) {
    while (after.includes(variant)) {
      after = after.replace(variant, PATCHED);
      hits += 1;
    }
  }

  if (hits === 0) {
    console.warn(
      '[patch-lazystream] neither the original pattern nor the patched pattern was found. ' +
      'lazystream may have changed upstream — inspect ' + TARGET_REL + ' manually. (exit 0)'
    );
    return;
  }

  await writeFile(target, after, 'utf8');
  console.log(`[patch-lazystream] patched ${hits} occurrence(s) in ${TARGET_REL}`);
}

main().catch(err => {
  // Never fail npm install because of the patcher; log and exit 0.
  console.error('[patch-lazystream] unexpected error (continuing):', err?.message || err);
  process.exit(0);
});
