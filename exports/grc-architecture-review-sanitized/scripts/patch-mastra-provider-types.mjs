#!/usr/bin/env node
/**
 * patch-mastra-provider-types.mjs
 *
 * Idempotent post-install patcher for
 *   node_modules/@mastra/core/dist/llm/model/provider-types.generated.d.ts
 *
 * Background
 * ----------
 * Some versions of `@mastra/core` (≥ 0.24.x on at least the Replit production
 * lockfile we saw) ship an auto-generated `.d.ts` file that lists every
 * provider model name as a raw object key. A subset of those identifiers —
 * specifically the Anthropic Claude model strings like
 *   claude-3.5-sonnet-20241022
 * — start with a numeric prefix (`3.5`) that TypeScript's parser tokenises
 * as a numeric literal, then fails on the trailing `-sonnet-...` with a
 * cascade of TS1131 / TS1434 / TS1005 / TS1351 / TS1109 / TS1128 parse
 * errors (60+ errors across 30+ lines).
 *
 * These are *parse* errors, not type errors, so `skipLibCheck: true` in
 * tsconfig.json does NOT silence them — skipLibCheck only suppresses
 * semantic checks. Parse errors in any `.d.ts` that ends up in the program
 * (transitively, via the main `@mastra/core` barrel) will fail
 * `npm run check` and CI alike.
 *
 * The file is generated for autocomplete on model-name string literals;
 * nothing in src/ imports it by name (grep confirmed). Replacing it with
 * an empty declaration restores the build with no observable behaviour
 * change beyond losing a sliver of editor autocomplete for model strings
 * — code that types those strings as plain `string` already works fine.
 *
 * Strategy
 * --------
 *   - If the file doesn't exist (different mastra version): no-op, exit 0.
 *   - If the file exists with our stub sentinel comment: no-op, exit 0.
 *   - Otherwise: overwrite with an empty `export {}` stub and log the
 *     replacement.
 *
 * Guarantees
 * ----------
 *   - Idempotent.
 *   - Bounded: only writes under `node_modules/@mastra/core/**`.
 *   - Safe-no-op: never fails `npm install`.
 *
 * Remove this script when @mastra/core ships a fix upstream (the generated
 * file needs to quote those model identifiers).
 */

import { readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, sep } from 'node:path';

const TARGET_REL = 'node_modules/@mastra/core/dist/llm/model/provider-types.generated.d.ts';
const BOUND_PREFIX = 'node_modules' + sep + '@mastra' + sep + 'core' + sep;

// Sentinel comment we write into the stub so subsequent runs detect their
// own previous work and short-circuit to a no-op.
const STUB_SENTINEL = '// patched-by-patch-mastra-provider-types.mjs';

const STUB_CONTENT = [
  STUB_SENTINEL,
  '// This file is intentionally emptied at postinstall time. The upstream',
  '// auto-generated version ships unquoted model identifiers like',
  "// 'claude-3.5-sonnet-...' that TypeScript's parser cannot tokenise (the",
  "// '3.5' becomes a numeric literal followed by an invalid identifier),",
  '// producing 60+ parse errors that skipLibCheck cannot silence. None of',
  "// the platform's src/ code imports symbols from this file, so stubbing",
  '// it out is a safe no-op for our use of @mastra/core. See',
  '// scripts/patch-mastra-provider-types.mjs for the full rationale.',
  'export {};',
  '',
].join('\n');

async function fileExists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

async function main() {
  const cwd = process.cwd();
  const target = resolve(cwd, TARGET_REL);

  // Bounded-scope guard: refuse to write outside node_modules/@mastra/core/
  const rel = target.substring(cwd.length + 1);
  if (!rel.startsWith(BOUND_PREFIX)) {
    console.error(`[patch-mastra-provider-types] refusing to write outside ${BOUND_PREFIX}; got ${rel}`);
    process.exit(0);
  }

  if (!(await fileExists(target))) {
    // Different @mastra/core version, or `node_modules` hasn't been
    // populated yet — nothing to patch.
    console.log('[patch-mastra-provider-types] target file not present — skipping (exit 0)');
    return;
  }

  const before = await readFile(target, 'utf8');
  if (before.includes(STUB_SENTINEL)) {
    console.log('[patch-mastra-provider-types] already stubbed — no-op (exit 0)');
    return;
  }

  await writeFile(target, STUB_CONTENT, 'utf8');
  console.log(
    `[patch-mastra-provider-types] replaced ${TARGET_REL} ` +
    `(was ${before.length} bytes; now ${STUB_CONTENT.length} bytes stub)`,
  );
}

main().catch(err => {
  // Never fail npm install because of the patcher; log and exit 0.
  console.error('[patch-mastra-provider-types] unexpected error (continuing):', err?.message || err);
  process.exit(0);
});
