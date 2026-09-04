#!/usr/bin/env node
/**
 * check-mastra-version.mjs
 *
 * Fails loudly when the INSTALLED @mastra/core does not match the version this
 * repo declares, instead of letting the mismatch surface as ~77 unrelated
 * TypeScript parse errors deep inside node_modules.
 *
 * Why this exists
 * ---------------
 * `npm run check:all` failed repeatedly with a wall of TS1128/TS1109 parse
 * errors in
 *   node_modules/@mastra/core/dist/llm/model/provider-types.generated.d.ts
 * and the working assumption was "postinstall did not run, so the stub patch is
 * missing". That was the wrong diagnosis. The evidence:
 *
 *   - package-lock.json pins @mastra/core 0.24.9, whose generated file is
 *     36,369 bytes / 1,205 lines and parses cleanly (its hyphenated provider
 *     keys are correctly quoted: 'moonshotai-cn', 'zai-coding-plan').
 *   - The failing file was ~213,000 bytes and tsc reported errors "starting
 *     at line 6115". A 1,205-line file has no line 6115.
 *   - @mastra/core 1.x ships a ~211KB / 7,285-line version of that same file.
 *
 * So the failures came from a @mastra/core 1.x being present while the lockfile
 * said 0.24.9 - a version-drift problem. The patch script hid it by stubbing
 * whatever it found, which is why the file came back a DIFFERENT size each
 * time it was "fixed".
 *
 * Drift matters well beyond the parse errors: 0.24 -> 1.x is a major-version
 * jump across the framework the whole platform is built on. Silently building
 * against an unpinned major is the actual risk here; the parse errors were only
 * its most visible symptom.
 *
 * Behaviour
 * ---------
 *   - No node_modules/@mastra/core yet (fresh clone): no-op, exit 0.
 *   - Installed major.minor matches the declared range: exit 0, silent.
 *   - Mismatch: print what is installed, what is expected, and how to fix it,
 *     then exit 1.
 *
 * Set MASTRA_VERSION_GUARD=off to bypass (e.g. during a deliberate upgrade).
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.MASTRA_VERSION_GUARD === "off") {
  process.exit(0);
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

const pkg = readJson(join(root, "package.json"));
const declared = pkg?.dependencies?.["@mastra/core"];
if (!declared) process.exit(0);

const installedPath = join(root, "node_modules", "@mastra", "core", "package.json");
if (!existsSync(installedPath)) process.exit(0); // not installed yet
const installed = readJson(installedPath)?.version;
if (!installed) process.exit(0);

// Compare on major.minor only. Patch bumps inside the declared range are
// exactly what the caret is for; a major or minor jump is the thing that
// changes the generated file's shape and the framework's API surface.
const wanted = String(declared).replace(/^[\^~>=<\s]+/, "");
const [wMajor, wMinor] = wanted.split(".");
const [iMajor, iMinor] = String(installed).split(".");

const drifted =
  wMajor !== iMajor || (wMajor === "0" && wMinor !== iMinor);

if (!drifted) process.exit(0);

console.error(`
==========================================================================
  @mastra/core VERSION DRIFT

    declared in package.json : ${declared}
    actually installed       : ${installed}

  This is very likely the real cause of any wall of TypeScript parse errors
  in node_modules/@mastra/core/dist/llm/model/provider-types.generated.d.ts.
  Those errors are a SYMPTOM of the wrong version being installed - stubbing
  that file out treats the symptom and lets the drift persist.

  0.24.x and 1.x are different majors of the framework this platform is
  built on. Building against an unintended major is the actual risk.

  To fix - reinstall exactly what the lockfile pins:

    rm -rf node_modules && npm ci

  Use 'npm ci', not 'npm install': ci installs the locked tree verbatim and
  fails if package.json and package-lock.json disagree, which is precisely
  the condition this guard detects.

  If the upgrade IS intended, update package.json + package-lock.json
  together and re-run. To bypass this check for one command:

    MASTRA_VERSION_GUARD=off npm run check
==========================================================================
`);
process.exit(1);
