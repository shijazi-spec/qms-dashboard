#!/usr/bin/env node
/**
 * check-mastra-provider-regeneration.mjs
 *
 * Replaces check-mastra-version.mjs, which tested the wrong property.
 *
 * The problem it was written for
 * -----------------------------
 * `npm run check` kept failing with ~77 TS1128/TS1109 parse errors inside
 *   node_modules/@mastra/core/dist/llm/model/provider-types.generated.d.ts
 * even though scripts/patch-mastra-provider-types.mjs had already stubbed that
 * file. Stubbing it never stuck, and the file kept coming back BIGGER:
 * 212454 -> 213092 -> 213344 -> 213591 -> 213853 bytes, while
 * @mastra/core/package.json read 0.24.9 the whole time.
 *
 * The first diagnosis - version drift, a 1.x tree under a 0.24.9 manifest - was
 * WRONG, and check-mastra-version.mjs was built on it. It compared declared vs
 * installed versions, they always agreed, and it passed silently every time
 * while the actual fault sailed through underneath it.
 *
 * The real cause
 * --------------
 * @mastra/core ships a GatewayRegistry (src/llm/model/provider-registry.ts)
 * that refreshes the provider/model list over the network and writes the
 * regenerated .d.ts straight back into node_modules:
 *
 *   const distTypesPath = path.join(packageRoot, "dist", "llm", "model",
 *                                   "provider-types.generated.d.ts");
 *   await writeRegistryFiles(distJsonPath, distTypesPath, providers, models);
 *
 * It also mirrors a copy in ~/.cache/mastra/ and restores it into node_modules
 * via syncGlobalCacheToLocal(). Both paths are gated on dev mode:
 *
 *   const isDev = process.env.MASTRA_DEV === "true" || process.env.MASTRA_DEV === "1";
 *   const autoRefreshEnabled =
 *     process.env.MASTRA_AUTO_REFRESH_PROVIDERS === "true" ||
 *     (process.env.MASTRA_AUTO_REFRESH_PROVIDERS !== "false" && isDev);
 *
 * Replit sets MASTRA_DEV, so auto-refresh is ON by default there. That explains
 * every observation: the running app rewrites the file, it grows because the
 * upstream model list grows, a fresh `npm ci` is small (36369 bytes) because
 * nothing has refreshed yet, and the version never changes because the package
 * never changed - only a file inside it did.
 *
 * The permanent fix is MASTRA_AUTO_REFRESH_PROVIDERS=false in the environment.
 * Our agents construct providers explicitly via createOpenAI() from
 * @ai-sdk/openai-v5 rather than Mastra's model-router strings, so the dynamic
 * registry is not on our path and disabling it costs us nothing.
 *
 * What this script does
 * ---------------------
 * Reports when the file has been regenerated, and names the fix. It does NOT
 * fail the build: patch-mastra-provider-types.mjs runs immediately after and
 * makes the tree compile anyway, so failing here would block a build that is
 * about to be fine. Silence means nothing regenerated it since the last patch.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DTS = join(
  root,
  "node_modules",
  "@mastra",
  "core",
  "dist",
  "llm",
  "model",
  "provider-types.generated.d.ts",
);

// The stub patch-mastra-provider-types.mjs writes is ~607 bytes; the pristine
// 0.24.9 file is ~36KB. Anything far above that was written by the gateway
// refresh, not by npm.
const REGENERATED_MIN_BYTES = 60_000;

if (!existsSync(DTS)) process.exit(0); // not installed yet - nothing to say

let size = 0;
try {
  size = statSync(DTS).size;
} catch {
  process.exit(0);
}

if (size < REGENERATED_MIN_BYTES) process.exit(0); // stub or pristine - fine

let isStub = false;
try {
  isStub = readFileSync(DTS, "utf-8").includes(
    "patched-by-patch-mastra-provider-types",
  );
} catch {
  /* unreadable - fall through and report on size alone */
}
if (isStub) process.exit(0);

const autoRefresh = process.env.MASTRA_AUTO_REFRESH_PROVIDERS;
const mastraDev = process.env.MASTRA_DEV;

console.warn(
  `[check-mastra-provider-regeneration] provider-types.generated.d.ts is ${size.toLocaleString()} bytes ` +
    `(pristine 0.24.9 is ~36KB, our stub is ~607B).`,
);
console.warn(
  "  @mastra/core's GatewayRegistry regenerated it from the network and wrote it back into node_modules.",
);
console.warn(
  `  MASTRA_DEV=${mastraDev ?? "(unset)"}  MASTRA_AUTO_REFRESH_PROVIDERS=${autoRefresh ?? "(unset)"}`,
);
if (autoRefresh !== "false") {
  console.warn(
    "  Fix: set MASTRA_AUTO_REFRESH_PROVIDERS=false in the environment (Replit Secrets),",
  );
  console.warn(
    "  and clear ~/.cache/mastra/ once so the cached copy is not restored.",
  );
}
console.warn(
  "  Not fatal: the patch runs next and the build will compile. See this file's header for the full trace.",
);
process.exit(0);
