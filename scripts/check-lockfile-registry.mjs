#!/usr/bin/env node
/**
 * Guardrail: every `resolved` URL in package-lock.json must point at a PUBLIC
 * registry.
 *
 * WHY THIS EXISTS
 * ---------------
 * Running `npm install` inside a Replit workspace rewrites the `resolved` URL
 * of every package it touches to Replit's internal package proxy:
 *
 *   "resolved": "http://package-firewall.replit.local/npm/<pkg>/-/<pkg>-<ver>.tgz"
 *
 * That host resolves ONLY inside a Replit workspace. Anywhere else — a GitHub
 * Actions runner, a local checkout — npm cannot fetch the tarball, leaves the
 * package directory EMPTY, and **does not fail the install**. The breakage
 * surfaces much later as something unrelated:
 *
 *   - `node_modules/vite/` empty        -> every tests/vitest/** suite dead
 *   - `node_modules/.bin/` 0 entries    -> `npx tsx` => "tsx: not found", exit 127
 *   - MODULE_NOT_FOUND for axios from @slack/web-api
 *   - Typecheck workflow red across commits by DIFFERENT authors
 *
 * None of those error messages point anywhere near the lockfile, which is what
 * made the first three occurrences expensive to diagnose. This has now happened
 * FOUR times (162 URLs, 171, 7 for `qs`, 1 for `openai`), every single time a
 * dependency change was made inside Replit. It is structural, not carelessness,
 * so it needs a mechanical check rather than vigilance.
 *
 * THE FIX when this fails is a pure host rewrite — versions and `integrity`
 * hashes stay untouched, because npmjs serves byte-identical tarballs:
 *
 *   http://package-firewall.replit.local/npm/  ->  https://registry.npmjs.org/
 *
 * Exit 0 = clean. Exit 1 = at least one non-public URL (prints each one).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Hosts a `resolved` URL is allowed to point at. */
const ALLOWED_HOSTS = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
]);

const lockPath = resolve(process.cwd(), "package-lock.json");

let lock;
try {
  lock = JSON.parse(readFileSync(lockPath, "utf8"));
} catch (err) {
  console.error(`✗ check-lockfile-registry: cannot read package-lock.json — ${err.message}`);
  process.exit(1);
}

const packages = lock.packages || {};
const offenders = [];
let checked = 0;

for (const [name, meta] of Object.entries(packages)) {
  const resolvedUrl = meta && meta.resolved;
  // Entries legitimately without `resolved`: the root package (""), workspace
  // links, and `link: true` local references. Skip rather than flag.
  if (!resolvedUrl || typeof resolvedUrl !== "string") continue;
  // `file:` / `link:` specifiers are local paths, not registry fetches.
  if (resolvedUrl.startsWith("file:") || resolvedUrl.startsWith("link:")) continue;

  checked++;
  let host;
  try {
    host = new URL(resolvedUrl).host;
  } catch {
    offenders.push({ name, resolvedUrl, reason: "unparseable URL" });
    continue;
  }
  if (!ALLOWED_HOSTS.has(host)) {
    offenders.push({ name, resolvedUrl, reason: `host "${host}" is not a public registry` });
  }
}

if (offenders.length === 0) {
  console.log(
    `✓ check-lockfile-registry: ${checked} resolved URL(s) all point at a public registry.`,
  );
  process.exit(0);
}

console.error(
  `\n✗ check-lockfile-registry: ${offenders.length} of ${checked} resolved URL(s) point at a NON-PUBLIC registry.\n`,
);
for (const o of offenders) {
  console.error(`  ${o.name}`);
  console.error(`     ${o.resolvedUrl}`);
  console.error(`     ${o.reason}\n`);
}

const replitCount = offenders.filter((o) =>
  o.resolvedUrl.includes("package-firewall.replit.local"),
).length;

if (replitCount > 0) {
  console.error(
    `${replitCount} of these are Replit's internal package proxy — this happens when\n` +
      `\`npm install\` is run inside a Replit workspace. The host resolves there and\n` +
      `NOWHERE else, so CI silently installs EMPTY package directories.\n\n` +
      `Fix (host rewrite only — versions and integrity hashes are unaffected):\n\n` +
      `  node -e "const f='package-lock.json',fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').split('http://package-firewall.replit.local/npm/').join('https://registry.npmjs.org/'))"\n\n` +
      `Then re-run:  npm run check:lockfile\n`,
  );
}

process.exit(1);
