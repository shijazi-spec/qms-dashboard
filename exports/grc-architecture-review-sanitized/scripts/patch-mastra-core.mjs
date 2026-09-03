#!/usr/bin/env node
/**
 * Vendored-dependency post-install patches.
 *
 * This script applies a small number of surgical, idempotent patches to files
 * inside `node_modules/`. Each patch is scoped to a single file and a single
 * line, and each one becomes a no-op if upstream ever ships a fix or the
 * target file is missing. Documented in `docs/Security_Operations_SOP.md`
 * §5.13 (Vendored Dependency Patches).
 *
 * Patches applied
 * ---------------
 * 1. `@mastra/core/dist/llm/model/provider-types.generated.d.ts`
 *    Quotes the `readonly 302ai:` property name (digit-prefixed → not a valid
 *    TypeScript identifier). Without this, `npm run check` and the pre-commit
 *    typecheck fail on every clean install. See task #641.
 *
 * 2. `lazystream/lib/lazystream.js`
 *    Rewrites `require('readable-stream/passthrough')` (a subpath that only
 *    existed in `readable-stream@2.x`) to `require('readable-stream').PassThrough`.
 *    Without this, `mastra build`'s deployed bundle crashes on startup with
 *    `ERR_MODULE_NOT_FOUND` because production de-dupes `readable-stream`
 *    to the top-level `@3.x`, which has no `passthrough` file at the root.
 *    The public `PassThrough` named export works identically on both v2 and v3.
 *
 * Each patch:
 *   - Is idempotent: running twice is a no-op.
 *   - Is safe if its target file is missing: it just skips that patch.
 *   - Touches only the exact offending pattern, so an upstream fix or rename
 *     turns this patch into a harmless no-op and the entry can be removed.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function patch({ name, target, find, replace }) {
  const path = resolve(process.cwd(), target);
  if (!existsSync(path)) {
    // Target package not installed yet (or path changed). Skip this patch.
    return;
  }
  const original = readFileSync(path, "utf8");
  if (!find.test(original)) {
    // Already patched, or upstream fixed it. Nothing to do.
    return;
  }
  const patched = original.replace(find, replace);
  if (patched === original) {
    // Defensive: replacement somehow produced no change. Don't touch the file.
    return;
  }
  writeFileSync(path, patched, "utf8");
  console.log(`[patch-mastra-core] ${name}`);
}

// Patch 1: @mastra/core invalid TS identifier (`302ai:` → `'302ai':`)
patch({
  name: "Quoted '302ai' property in provider-types.generated.d.ts",
  target: "node_modules/@mastra/core/dist/llm/model/provider-types.generated.d.ts",
  find: /^(\s*)readonly\s+302ai\s*:/m,
  replace: "$1readonly '302ai':",
});

// Patch 2: lazystream → use public PassThrough export from readable-stream
patch({
  name: "Rewrote lazystream's readable-stream/passthrough require to use public PassThrough export",
  target: "node_modules/lazystream/lib/lazystream.js",
  find: /^var\s+PassThrough\s*=\s*require\(\s*['"]readable-stream\/passthrough['"]\s*\)\s*;\s*$/m,
  replace: "var PassThrough = require('readable-stream').PassThrough;",
});
