#!/usr/bin/env node
/**
 * Patches @mastra/core's auto-generated provider-types.generated.d.ts so that
 * its `readonly 302ai:` property name (which begins with a digit and is therefore
 * a TypeScript *parse* error) is quoted as `readonly '302ai':`.
 *
 * Why this exists
 * ---------------
 * `@mastra/core@0.24.9` ships an invalid `.d.ts` file. `skipLibCheck` only
 * suppresses *type checking* of declaration files — it does NOT skip *parsing*,
 * so this single bad property cascades into 200+ TS errors and makes
 * `npm run check` (and therefore the CI typecheck job and the pre-commit hook)
 * fail on every clean install. See task #641.
 *
 * This script:
 *   - Is idempotent: running twice is a no-op.
 *   - Is safe if the file is missing (e.g. before `npm install`): it just exits 0.
 *   - Only rewrites the single offending line, so if upstream ever fixes the
 *     bug or renames the property, this script becomes a harmless no-op and
 *     can be deleted along with the postinstall entry in package.json.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const TARGET = resolve(
  process.cwd(),
  "node_modules/@mastra/core/dist/llm/model/provider-types.generated.d.ts",
);

if (!existsSync(TARGET)) {
  // @mastra/core not installed yet (or path changed). Nothing to patch.
  process.exit(0);
}

const original = readFileSync(TARGET, "utf8");

// Match the offending unquoted-numeric-prefix property declaration. We only
// touch the exact pattern; any already-quoted form is left alone so reruns
// (and a future upstream fix) are no-ops.
const BAD = /^(\s*)readonly\s+302ai\s*:/m;
const GOOD = "$1readonly '302ai':";

if (!BAD.test(original)) {
  // Already patched, or upstream fixed it. Nothing to do.
  process.exit(0);
}

const patched = original.replace(BAD, GOOD);

if (patched === original) {
  // Defensive: replacement somehow produced no change. Don't touch the file.
  process.exit(0);
}

writeFileSync(TARGET, patched, "utf8");
console.log(
  "[patch-mastra-core] Quoted '302ai' property in provider-types.generated.d.ts",
);
