/**
 * Guardrail test for src/mastra/agents/promptVersionRegistry.ts.
 *
 * Why this exists
 * ---------------
 * The registry (`ACTIVE_AGENT_PROMPT_VERSIONS`) is the single source of truth
 * for "which prompt versions are currently live". Two background jobs depend
 * on it staying in sync with the agent source files:
 *
 *   1. promptVersionPurgeFunction (src/mastra/inngest/index.ts) uses it to
 *      decide which archived ai_call_metrics rows are safe to delete.
 *   2. /api/ai-ops/active-prompt-versions returns it to the AI Ops dashboard.
 *
 * If a future contributor adds a new agent file that exports a
 * `*_PROMPT_VERSION` constant but forgets to register it, archived rows for
 * that agent never get purged — silently. This test scans
 * `src/mastra/agents/` for every exported `*_PROMPT_VERSION` symbol, imports
 * its current value, and asserts the value is present in
 * `ACTIVE_AGENT_PROMPT_VERSIONS`. The test fails CI the moment someone adds
 * a new prompt-version constant without registering it.
 *
 * Run: npx tsx tests/promptVersionRegistry.test.ts
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { TestSuite } from "./_helpers/runner";
import { ACTIVE_AGENT_PROMPT_VERSIONS } from "../src/mastra/agents/promptVersionRegistry";

const suite = new TestSuite("promptVersionRegistry");
const AGENTS_DIR = path.resolve(
  new URL(".", import.meta.url).pathname,
  "..",
  "src",
  "mastra",
  "agents",
);

// Files we must not scan: the registry itself (it imports the constants —
// the regex would match its `import { FOO_PROMPT_VERSION }` lines on some
// formatters) and any auxiliary index/types file. We only care about agent
// definition files that actually *export* a `*_PROMPT_VERSION` constant.
const SKIP_FILES = new Set(["promptVersionRegistry.ts"]);

console.log("\n=== promptVersionRegistry guardrail tests ===\n");

interface DiscoveredConstant {
  /** Constant name, e.g. "QMS_CONSULTANT_PROMPT_VERSION". */
  symbol: string;
  /** Agent file basename, e.g. "qmsConsultantAgent.ts". */
  file: string;
}

/**
 * Statically scan every `.ts` file under src/mastra/agents/ for top-level
 * `export const <NAME>_PROMPT_VERSION` declarations. We use a filesystem
 * regex pass (rather than dynamic-importing every file just to enumerate
 * exports) because it's deterministic and lets us produce useful error
 * messages tied to a file path.
 */
async function discoverPromptVersionExports(): Promise<DiscoveredConstant[]> {
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  const found: DiscoveredConstant[] = [];

  // `export const FOO_PROMPT_VERSION` — possibly with a type annotation
  // (`: string =`) before the assignment. Anchored to the start of a line so
  // commented-out examples or imports don't match.
  const exportRe = /^\s*export\s+const\s+([A-Z][A-Z0-9_]*_PROMPT_VERSION)\b/gm;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (SKIP_FILES.has(entry.name)) continue;

    const full = path.join(AGENTS_DIR, entry.name);
    const src = await readFile(full, "utf8");
    let m: RegExpExecArray | null;
    exportRe.lastIndex = 0;
    while ((m = exportRe.exec(src)) !== null) {
      found.push({ symbol: m[1], file: entry.name });
    }
  }

  return found;
}

await suite.test(
  "every *_PROMPT_VERSION export under src/mastra/agents/ is registered in ACTIVE_AGENT_PROMPT_VERSIONS",
  async () => {
    const discovered = await discoverPromptVersionExports();

    suite.expect(
      discovered.length > 0,
      `filesystem scan found at least one *_PROMPT_VERSION export ` +
        `(scanned ${AGENTS_DIR}); got 0 — the regex or scan path is broken`,
    );

    // Build the set of live prompt_version *values* once. We compare values
    // (not symbol names) because the registry stores values; a contributor
    // could legitimately rename a constant without changing its value.
    const liveValues = new Set(
      ACTIVE_AGENT_PROMPT_VERSIONS.map((e) => e.prompt_version),
    );

    for (const { symbol, file } of discovered) {
      // Dynamic import gives us the actual runtime value of the constant,
      // which is what the purge job and the /active endpoint will compare
      // against in production.
      const mod = await import(
        pathToFileURL(path.join(AGENTS_DIR, file)).href
      );
      const value = (mod as Record<string, unknown>)[symbol];

      suite.expect(
        typeof value === "string" && value.length > 0,
        `${file} exports ${symbol} but its value is not a non-empty string ` +
          `(got ${JSON.stringify(value)}) — every prompt-version constant ` +
          `must resolve to a stable, non-empty hash`,
      );

      if (typeof value !== "string" || value.length === 0) continue;

      suite.expect(
        liveValues.has(value),
        `${file} exports ${symbol} (= ${JSON.stringify(value)}) but this ` +
          `value is NOT present in ACTIVE_AGENT_PROMPT_VERSIONS in ` +
          `src/mastra/agents/promptVersionRegistry.ts. Add an entry there ` +
          `with the agent's user-facing name, otherwise its archived ` +
          `ai_call_metrics rows will never be purged and the AI Ops ` +
          `/active endpoint will under-report.`,
      );
    }
  },
);

await suite.test(
  "every ACTIVE_AGENT_PROMPT_VERSIONS entry still corresponds to a live *_PROMPT_VERSION export",
  async () => {
    // Reverse direction of the first test: walk the registry and prove that
    // every entry's prompt_version value is still backed by a constant that
    // some agent file under src/mastra/agents/ currently exports. If an
    // agent file is deleted or its `*_PROMPT_VERSION` constant is renamed
    // (changing its hash), the registry will silently keep advertising the
    // old value — the purge job would then refuse to delete archived rows
    // for that obsolete version forever, and /api/ai-ops/active-prompt-versions
    // would tell operators a version is "live" when no agent uses it.
    const discovered = await discoverPromptVersionExports();

    suite.expect(
      discovered.length > 0,
      `filesystem scan found at least one *_PROMPT_VERSION export ` +
        `(scanned ${AGENTS_DIR}); got 0 — the regex or scan path is broken`,
    );

    // Resolve every discovered constant to its runtime value once so we can
    // build the set of values that *some* live agent file currently exports.
    const liveValues = new Set<string>();
    for (const { symbol, file } of discovered) {
      const mod = await import(
        pathToFileURL(path.join(AGENTS_DIR, file)).href
      );
      const value = (mod as Record<string, unknown>)[symbol];
      if (typeof value === "string" && value.length > 0) {
        liveValues.add(value);
      }
    }

    for (const entry of ACTIVE_AGENT_PROMPT_VERSIONS) {
      suite.expect(
        liveValues.has(entry.prompt_version),
        `ACTIVE_AGENT_PROMPT_VERSIONS contains a stale entry ` +
          `${JSON.stringify(entry)}: its prompt_version value is no longer ` +
          `exported by any *_PROMPT_VERSION constant under src/mastra/agents/. ` +
          `The matching agent file was likely deleted or its constant ` +
          `renamed. Remove this entry from ACTIVE_AGENT_PROMPT_VERSIONS in ` +
          `src/mastra/agents/promptVersionRegistry.ts, otherwise the purge ` +
          `cron will refuse to delete archived ai_call_metrics rows for this ` +
          `obsolete version and the AI Ops /active endpoint will advertise a ` +
          `version no live agent actually uses.`,
      );
    }
  },
);

await suite.test(
  "ACTIVE_AGENT_PROMPT_VERSIONS entries all resolve to non-empty unique agent names",
  async () => {
    // Defence-in-depth: the registry itself should not contain blank or
    // duplicated agent_name entries. Either would silently corrupt the AI
    // Ops dashboard (duplicate rows) or the purge guard (missing version).
    const seenAgents = new Set<string>();
    for (const entry of ACTIVE_AGENT_PROMPT_VERSIONS) {
      suite.expect(
        typeof entry.agent_name === "string" && entry.agent_name.length > 0,
        `registry entry has empty agent_name: ${JSON.stringify(entry)}`,
      );
      suite.expect(
        typeof entry.prompt_version === "string" && entry.prompt_version.length > 0,
        `registry entry has empty prompt_version: ${JSON.stringify(entry)}`,
      );
      suite.expect(
        !seenAgents.has(entry.agent_name),
        `registry has duplicate agent_name ${JSON.stringify(entry.agent_name)} ` +
          `— each agent should appear at most once`,
      );
      seenAgents.add(entry.agent_name);
    }
  },
);

suite.finishOrExit();
