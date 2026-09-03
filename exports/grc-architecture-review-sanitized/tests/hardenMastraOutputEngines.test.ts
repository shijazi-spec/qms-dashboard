/**
 * Negative-path tests for the Node-compatibility build gate in
 * `scripts/harden-mastra-output-dependencies.mjs` (Task #886).
 *
 * Feeds `assertEnginesSupportRuntimeNode()` synthetic package-lock.json
 * shapes and asserts:
 *   - an incompatible engines.node range throws, naming the package;
 *   - compatible ranges pass;
 *   - dev / devOptional packages are skipped;
 *   - unparseable or empty ranges are skipped;
 *   - the root "" entry is skipped.
 *
 * Run:  npx tsx tests/hardenMastraOutputEngines.test.ts
 */

// @ts-ignore - plain .mjs module without type declarations
import { assertEnginesSupportRuntimeNode } from "../scripts/harden-mastra-output-dependencies.mjs";

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

function throwsWith(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (error: any) {
    return String(error?.message ?? error);
  }
}

const RUNTIME = "20.11.1"; // pinned so the test is deterministic regardless of host Node

function lockfileWith(packages: Record<string, any>) {
  return { packages: { "": { name: "output-root" }, ...packages } };
}

console.log("incompatible production package fails and is named");
{
  const message = throwsWith(() =>
    assertEnginesSupportRuntimeNode(
      lockfileWith({
        "node_modules/needs-node-22": {
          version: "1.2.3",
          engines: { node: ">=22" },
        },
      }),
      RUNTIME,
    ),
  );
  assert(message !== null, "throws for engines.node '>=22' on Node 20");
  assert(
    message !== null && message.includes("<REDACTED_EMAIL>"),
    "error message names the offending package and version",
  );
  assert(
    message !== null && message.includes(">=22"),
    "error message includes the offending range",
  );
  assert(
    message !== null && message.includes(RUNTIME),
    "error message includes the runtime Node version",
  );
}

console.log("nested node_modules paths are reported by package name");
{
  const message = throwsWith(() =>
    assertEnginesSupportRuntimeNode(
      lockfileWith({
        "node_modules/parent/node_modules/@scope/deep-pkg": {
          version: "9.9.9",
          engines: { node: "^22.0.0" },
        },
      }),
      RUNTIME,
    ),
  );
  assert(
    message !== null && message.includes("@scope/<REDACTED_EMAIL>"),
    "nested path is stripped down to the package name",
  );
}

console.log("compatible ranges pass");
{
  const message = throwsWith(() =>
    assertEnginesSupportRuntimeNode(
      lockfileWith({
        "node_modules/ok-caret": { version: "1.0.0", engines: { node: ">=18" } },
        "node_modules/ok-range": { version: "2.0.0", engines: { node: "^20.0.0" } },
        "node_modules/no-engines": { version: "3.0.0" },
      }),
      RUNTIME,
    ),
  );
  assert(message === null, "does not throw when all ranges include Node 20");
}

console.log("dev and devOptional packages are skipped");
{
  const message = throwsWith(() =>
    assertEnginesSupportRuntimeNode(
      lockfileWith({
        "node_modules/dev-only": {
          version: "1.0.0",
          dev: true,
          engines: { node: ">=22" },
        },
        "node_modules/dev-optional": {
          version: "1.0.0",
          devOptional: true,
          engines: { node: ">=99" },
        },
      }),
      RUNTIME,
    ),
  );
  assert(message === null, "incompatible dev/devOptional packages do not fail the gate");
}

console.log("unparseable or empty ranges are skipped");
{
  const message = throwsWith(() =>
    assertEnginesSupportRuntimeNode(
      lockfileWith({
        "node_modules/garbage-range": {
          version: "1.0.0",
          engines: { node: "not-a-range!!" },
        },
        "node_modules/empty-range": { version: "1.0.0", engines: { node: "   " } },
        "node_modules/non-string-range": { version: "1.0.0", engines: { node: 22 } },
      }),
      RUNTIME,
    ),
  );
  assert(message === null, "invalid engines.node values are ignored");
}

console.log("root entry and missing packages map are tolerated");
{
  const rootOnly = throwsWith(() =>
    assertEnginesSupportRuntimeNode(
      { packages: { "": { engines: { node: ">=22" } } } },
      RUNTIME,
    ),
  );
  assert(rootOnly === null, "root '' entry is never checked");
  const empty = throwsWith(() => assertEnginesSupportRuntimeNode({}, RUNTIME));
  assert(empty === null, "lockfile without packages map passes");
}

console.log("only incompatible packages are listed when mixed");
{
  const message = throwsWith(() =>
    assertEnginesSupportRuntimeNode(
      lockfileWith({
        "node_modules/fine": { version: "1.0.0", engines: { node: ">=18" } },
        "node_modules/bad-a": { version: "1.0.0", engines: { node: ">=22" } },
        "node_modules/bad-b": { version: "2.0.0", engines: { node: ">=21" } },
      }),
      RUNTIME,
    ),
  );
  assert(message !== null && message.includes("<REDACTED_EMAIL>"), "lists bad-a");
  assert(message !== null && message.includes("<REDACTED_EMAIL>"), "lists bad-b");
  assert(message !== null && !message.includes("fine@"), "does not list compatible package");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
