/**
 * Negative-path tests for the legacy provider-utils build gate in
 * `scripts/harden-mastra-output-dependencies.mjs` (Task #887).
 *
 * Feeds `assertNoLegacyProviderUtils()` synthetic package-lock.json
 * shapes and asserts:
 *   - a 2.x/3.x @ai-sdk/provider-utils entry throws, naming the path and version;
 *   - a 4.x entry passes;
 *   - unrelated packages are ignored;
 *   - nested node_modules paths are still caught;
 *   - empty / missing packages maps are tolerated.
 *
 * Run:  npx tsx tests/hardenMastraOutputLegacyProviderUtils.test.ts
 */

// @ts-ignore - plain .mjs module without type declarations
import { assertNoLegacyProviderUtils } from "../scripts/harden-mastra-output-dependencies.mjs";

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

function lockfileWith(packages: Record<string, any>) {
  return { packages: { "": { name: "output-root" }, ...packages } };
}

console.log("legacy 2.x provider-utils fails and is named");
{
  const message = throwsWith(() =>
    assertNoLegacyProviderUtils(
      lockfileWith({
        "node_modules/@ai-sdk/provider-utils": { version: "2.2.8" },
      }),
    ),
  );
  assert(message !== null, "throws for provider-utils 2.x");
  assert(
    message !== null &&
      message.includes("node_modules/@ai-sdk/<REDACTED_EMAIL>"),
    "error message names the offending path and version",
  );
}

console.log("legacy 3.x provider-utils fails too");
{
  const message = throwsWith(() =>
    assertNoLegacyProviderUtils(
      lockfileWith({
        "node_modules/@ai-sdk/provider-utils": { version: "3.0.1" },
      }),
    ),
  );
  assert(
    message !== null && message.includes("@3.0.1"),
    "throws for provider-utils 3.x with version in message",
  );
}

console.log("nested node_modules copies are caught");
{
  const message = throwsWith(() =>
    assertNoLegacyProviderUtils(
      lockfileWith({
        "node_modules/@ai-sdk/provider-utils": { version: "4.0.2" },
        "node_modules/some-lib/node_modules/@ai-sdk/provider-utils": {
          version: "3.5.0",
        },
      }),
    ),
  );
  assert(
    message !== null &&
      message.includes(
        "node_modules/some-lib/node_modules/@ai-sdk/<REDACTED_EMAIL>",
      ),
    "nested legacy copy is reported with its full path",
  );
  assert(
    message !== null && !message.includes("@4.0.2"),
    "the healthy 4.x copy is not listed",
  );
}

console.log("multiple legacy copies are all listed");
{
  const message = throwsWith(() =>
    assertNoLegacyProviderUtils(
      lockfileWith({
        "node_modules/@ai-sdk/provider-utils": { version: "2.0.0" },
        "node_modules/lib-a/node_modules/@ai-sdk/provider-utils": {
          version: "3.1.0",
        },
      }),
    ),
  );
  assert(message !== null && message.includes("@2.0.0"), "lists the 2.x copy");
  assert(message !== null && message.includes("@3.1.0"), "lists the 3.x copy");
}

console.log("a 4.x provider-utils passes");
{
  const message = throwsWith(() =>
    assertNoLegacyProviderUtils(
      lockfileWith({
        "node_modules/@ai-sdk/provider-utils": { version: "4.1.0" },
      }),
    ),
  );
  assert(message === null, "does not throw for provider-utils 4.x");
}

console.log("unrelated packages are ignored");
{
  const message = throwsWith(() =>
    assertNoLegacyProviderUtils(
      lockfileWith({
        "node_modules/lodash": { version: "3.10.1" },
        "node_modules/@ai-sdk/provider": { version: "2.0.0" },
        "node_modules/provider-utils": { version: "2.0.0" },
      }),
    ),
  );
  assert(
    message === null,
    "old versions of unrelated packages do not trip the gate",
  );
}

console.log("empty or missing packages maps are tolerated");
{
  const emptyPackages = throwsWith(() =>
    assertNoLegacyProviderUtils({ packages: {} }),
  );
  assert(emptyPackages === null, "empty packages map passes");
  const noPackages = throwsWith(() => assertNoLegacyProviderUtils({}));
  assert(noPackages === null, "lockfile without packages map passes");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
