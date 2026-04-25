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

interface DiscoveredAgentName {
  /** Agent file basename, e.g. "qmsConsultantAgent.ts". */
  file: string;
  /** Value passed to `new Agent({ name: ... })` in that file. */
  name: string;
}

/**
 * Statically scan every `.ts` file under src/mastra/agents/ for `new Agent({
 * name: "..." })` declarations and return the (file, name) pairs.
 *
 * Why this is a static text scan rather than a dynamic import: the goal is to
 * catch a contributor renaming the `name:` literal in an agent file while
 * leaving the registry's `agent_name` string stale. Reading the source text
 * directly is the most faithful representation of "what does the agent file
 * literally say its name is right now".
 *
 * The walker tracks balanced braces inside the `new Agent({ ... })` call so
 * that nested object literals (e.g. tool definitions with their own `name`
 * field) cannot fool the top-level `name:` lookup. Quoted strings are skipped
 * over so a `}` inside a string literal does not close the block early.
 */
async function discoverAgentNames(): Promise<DiscoveredAgentName[]> {
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  const found: DiscoveredAgentName[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (SKIP_FILES.has(entry.name)) continue;

    const full = path.join(AGENTS_DIR, entry.name);
    const src = await readFile(full, "utf8");

    const ctorRe = /new\s+Agent\s*\(\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = ctorRe.exec(src)) !== null) {
      const blockStart = m.index + m[0].length;
      let depth = 1;
      let i = blockStart;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === "{") {
          depth++;
          i++;
        } else if (c === "}") {
          depth--;
          i++;
        } else if (c === '"' || c === "'" || c === "`") {
          const quote = c;
          i++;
          while (i < src.length && src[i] !== quote) {
            if (src[i] === "\\") i++;
            i++;
          }
          if (i < src.length) i++; // consume closing quote
        } else if (c === "/" && src[i + 1] === "/") {
          // Line comment — skip to end of line so a `//` containing a `}`
          // doesn't perturb the depth count.
          while (i < src.length && src[i] !== "\n") i++;
        } else if (c === "/" && src[i + 1] === "*") {
          i += 2;
          while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/")) i++;
          i += 2;
        } else {
          i++;
        }
      }
      // Block is src[blockStart .. i-1] (exclusive of the matching `}`).
      // Find the first top-level `name: "..."` field in that slice. Because
      // we only scan the outermost block (nested object literals are stepped
      // over via the depth counter at `i`-walking time), but the regex below
      // still needs to ignore nested levels: do a second balanced-brace pass
      // that records only depth-0 occurrences of `name:`.
      const block = src.slice(blockStart, i - 1);
      const name = findTopLevelNameField(block);
      if (name !== null) {
        found.push({ file: entry.name, name });
      }
    }
  }

  return found;
}

/**
 * Find the first `name: "..."` (or `'...'`) field at depth 0 inside the
 * already-extracted `new Agent({ ... })` block. Returns null if absent.
 *
 * Walks the block character-by-character, tracking brace, bracket, and
 * paren depth, and skipping over string/template/comment runs so that a
 * `name:` inside a nested config object (e.g. a tool definition) is not
 * mistaken for the agent's own name.
 */
function findTopLevelNameField(block: string): string | null {
  let depth = 0;
  let i = 0;
  while (i < block.length) {
    const c = block[i];
    if (c === "{" || c === "[" || c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      depth--;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < block.length && block[i] !== quote) {
        if (block[i] === "\\") i++;
        i++;
      }
      if (i < block.length) i++;
      continue;
    }
    if (c === "/" && block[i + 1] === "/") {
      while (i < block.length && block[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && block[i + 1] === "*") {
      i += 2;
      while (i < block.length - 1 && !(block[i] === "*" && block[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (depth === 0 && (c === "n" || c === "N")) {
      // Try to match `name` at this position followed by optional ws + `:`.
      const slice = block.slice(i, i + 5);
      if (/^name\b/.test(slice)) {
        let j = i + 4;
        while (j < block.length && /\s/.test(block[j])) j++;
        if (block[j] === ":") {
          j++;
          while (j < block.length && /\s/.test(block[j])) j++;
          const q = block[j];
          if (q === '"' || q === "'") {
            let k = j + 1;
            let value = "";
            while (k < block.length && block[k] !== q) {
              if (block[k] === "\\" && k + 1 < block.length) {
                value += block[k + 1];
                k += 2;
              } else {
                value += block[k];
                k++;
              }
            }
            return value;
          }
        }
      }
    }
    i++;
  }
  return null;
}

await suite.test(
  "every ACTIVE_AGENT_PROMPT_VERSIONS agent_name matches a `new Agent({ name })` literal in some agent file",
  async () => {
    // If a contributor renames an agent at its source — e.g. changes
    // `new Agent({ name: "WalaPlus QMS Consultant" })` to a new wording —
    // without updating the registry, the AI Ops dashboard's /active endpoint
    // would silently keep advertising the obsolete display name forever.
    // This test scans every agent file for its `name:` argument and asserts
    // each registry entry's `agent_name` matches one of them exactly.
    const discovered = await discoverAgentNames();

    suite.expect(
      discovered.length > 0,
      `filesystem scan found at least one new Agent({ name }) declaration ` +
        `(scanned ${AGENTS_DIR}); got 0 — the regex or scan path is broken`,
    );

    const liveNames = new Set(discovered.map((d) => d.name));

    for (const entry of ACTIVE_AGENT_PROMPT_VERSIONS) {
      suite.expect(
        liveNames.has(entry.agent_name),
        `ACTIVE_AGENT_PROMPT_VERSIONS entry ${JSON.stringify(entry)} has ` +
          `agent_name ${JSON.stringify(entry.agent_name)} that does NOT match ` +
          `any \`new Agent({ name: ... })\` literal under src/mastra/agents/. ` +
          `Either update the registry's agent_name to match the agent file's ` +
          `current \`name:\` field, or update the agent file's \`name:\` to ` +
          `match the registry. Discovered live names: ` +
          `${JSON.stringify(Array.from(liveNames).sort())}.`,
      );
    }
  },
);

await suite.test(
  "each ACTIVE_AGENT_PROMPT_VERSIONS entry's agent_name matches the agent file that exports its prompt_version",
  async () => {
    // Stronger pairing check: the previous test only proves that an agent
    // file *somewhere* uses the registered name. If two registry entries got
    // their agent_name fields swapped, the previous test would still pass.
    // Here we link each registry entry to the specific agent file that
    // exports its `prompt_version` constant and assert that file's `name:`
    // literal equals the registry's `agent_name`. This catches both swaps
    // and the original "renamed in source but not in registry" bug per
    // entry, with a precise error message naming the offending file.
    const discoveredVersions = await discoverPromptVersionExports();
    const discoveredNames = await discoverAgentNames();

    // file -> name (every agent file should declare exactly one Agent ctor)
    const fileToName = new Map<string, string>();
    for (const { file, name } of discoveredNames) {
      fileToName.set(file, name);
    }

    // promptVersionValue -> file (resolved by importing each constant)
    const versionToFile = new Map<string, string>();
    for (const { symbol, file } of discoveredVersions) {
      const mod = await import(
        pathToFileURL(path.join(AGENTS_DIR, file)).href
      );
      const value = (mod as Record<string, unknown>)[symbol];
      if (typeof value === "string" && value.length > 0) {
        versionToFile.set(value, file);
      }
    }

    for (const entry of ACTIVE_AGENT_PROMPT_VERSIONS) {
      const file = versionToFile.get(entry.prompt_version);
      // The "stale registry entry" case is already covered by the earlier
      // test that walks the registry; skip here when we cannot link an
      // entry back to a file so this test reports only the name-mismatch
      // class of failure with a clean message.
      if (!file) continue;

      const expectedName = fileToName.get(file);
      suite.expect(
        expectedName !== undefined,
        `${file} exports a *_PROMPT_VERSION constant (registered as ` +
          `${JSON.stringify(entry.prompt_version)}) but no ` +
          `\`new Agent({ name: ... })\` declaration was found in that file. ` +
          `Either add the Agent constructor or remove the registry entry.`,
      );
      if (expectedName === undefined) continue;

      suite.expect(
        expectedName === entry.agent_name,
        `ACTIVE_AGENT_PROMPT_VERSIONS entry ${JSON.stringify(entry)} has ` +
          `agent_name ${JSON.stringify(entry.agent_name)}, but the agent ` +
          `file ${file} that exports its prompt_version declares ` +
          `\`name: ${JSON.stringify(expectedName)}\`. Either update the ` +
          `registry's agent_name to ${JSON.stringify(expectedName)} or ` +
          `change ${file}'s \`new Agent({ name })\` back to ` +
          `${JSON.stringify(entry.agent_name)}.`,
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
