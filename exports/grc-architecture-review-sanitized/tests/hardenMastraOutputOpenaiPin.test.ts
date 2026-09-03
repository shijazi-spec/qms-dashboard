/**
 * Tests for the manifest-rewrite helper in
 * `scripts/harden-mastra-output-dependencies.mjs` (Task #888).
 *
 * Feeds `applyRootDependencyPins()` synthetic generated manifests and asserts:
 *   - openai pinned to "latest" is replaced with the exact root pin;
 *   - an already-pinned openai entry is normalized to the root pin;
 *   - manifests without openai pass through untouched;
 *   - root overrides win when there is no root dependency;
 *   - root overrides are copied onto the output manifest wholesale;
 *   - the real root package.json still declares an exact openai version.
 *
 * Run:  npx tsx tests/hardenMastraOutputOpenaiPin.test.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// @ts-ignore - plain .mjs module without type declarations
import { applyRootDependencyPins } from "../scripts/harden-mastra-output-dependencies.mjs";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

console.log('openai "latest" is replaced with the exact root pin');
{
  const output = applyRootDependencyPins(
    { dependencies: { openai: "latest", "left-pad": "^1.0.0" } },
    { dependencies: { openai: "6.49.0" }, overrides: {} },
  );
  assert(output.dependencies.openai === "6.49.0", 'openai "latest" becomes the root pin');
  assert(
    output.dependencies["left-pad"] === "^1.0.0",
    "dependencies without a root pin pass through untouched",
  );
}

console.log("an already-pinned openai entry is normalized to the root pin");
{
  const output = applyRootDependencyPins(
    { dependencies: { openai: "5.0.0" } },
    { dependencies: { openai: "6.49.0" }, overrides: {} },
  );
  assert(
    output.dependencies.openai === "6.49.0",
    "stale exact pin is rewritten to the audited root version",
  );
}

console.log("manifests without openai pass through untouched");
{
  const output = applyRootDependencyPins(
    { dependencies: { express: "^4.18.0" } },
    { dependencies: { openai: "6.49.0" }, overrides: {} },
  );
  assert(!("openai" in output.dependencies), "openai is not injected");
  assert(output.dependencies.express === "^4.18.0", "existing entries untouched");

  const noDeps = applyRootDependencyPins(
    {},
    { dependencies: { openai: "6.49.0" }, overrides: {} },
  );
  assert(
    (noDeps as any).dependencies === undefined,
    "manifest without a dependencies map is tolerated",
  );
}

console.log("root dependency wins over root override; override used as fallback");
{
  const output = applyRootDependencyPins(
    { dependencies: { openai: "latest", zod: "latest" } },
    {
      dependencies: { openai: "6.49.0" },
      overrides: { openai: "1.0.0", zod: "3.23.8" },
    },
  );
  assert(output.dependencies.openai === "6.49.0", "root dependency takes precedence");
  assert(output.dependencies.zod === "3.23.8", "root override applies when no root dependency");
}

console.log("root overrides are copied onto the output manifest");
{
  const overrides = { "@ai-sdk/provider-utils": "4.0.2" };
  const output = applyRootDependencyPins(
    { dependencies: {} },
    { dependencies: {}, overrides },
  );
  assert(output.overrides === overrides, "overrides copied wholesale");
}

console.log("real root package.json still declares an exact openai version");
{
  const rootPackage = JSON.parse(
    readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
  );
  const spec = rootPackage.dependencies?.openai;
  assert(typeof spec === "string", "root package.json has an openai dependency");
  assert(
    typeof spec === "string" && /^\d+\.\d+\.\d+$/.test(spec),
    `root openai spec is an exact version (got ${JSON.stringify(spec)})`,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
