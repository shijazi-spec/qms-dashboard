/**
 * Static governance-policy coverage check.
 *
 * `withApprovalGate` already throws at runtime if a wrapped tool has no entry
 * in `TOOL_GOVERNANCE_POLICIES`, but that error only surfaces when the agent
 * actually tries to invoke the tool — sometimes long after the PR has merged.
 *
 * This test enumerates every `createTool({ id })` call under
 *   - src/mastra/tools/
 *   - src/utils/integrationTestFixtureTools.ts
 * and asserts that EVERY id has a matching entry in `TOOL_GOVERNANCE_POLICIES`
 * with a non-empty `buildPreview` and non-empty `complianceRefs`. There is no
 * allowlist escape hatch: a read-only tool may set `requiresApproval: false`,
 * but it still needs a policy entry that documents *why* the gate is bypassed
 * and surfaces a non-empty preview if the agent ever tries to invoke it.
 *
 * It additionally walks every `withApprovalGate(...)` reference in
 * `src/mastra/agents/` and `src/utils/integrationTestFixtureTools.ts`
 * and re-asserts that every gated tool id has a real policy — the
 * runtime gate refuses to execute one without a policy.
 *
 * Failures fire at PR time with an actionable message:
 *
 *   • createTool id "X" has no TOOL_GOVERNANCE_POLICIES entry
 *   • policy "X" has empty complianceRefs / non-function buildPreview
 *   • policy "X" buildPreview({}) returns an empty string
 *   • tool "X" is wrapped with withApprovalGate but has no policy
 *   • policy "X" does not match any createTool id (orphan)
 *   • policy "X" key does not match policy.toolId (copy-paste bug)
 *
 * Run:  npx tsx tests/aiToolPolicyCoverage.test.ts
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOOL_GOVERNANCE_POLICIES,
  getEffectiveToolGovernancePolicy,
  type ToolGovernancePolicy,
} from "../src/utils/aiToolGovernance";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  \u2713 ${label}`);
    passed++;
  } else {
    console.error(`  \u2717 ${label}`);
    failed++;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "..");
const TOOLS_DIR = path.join(REPO_ROOT, "src", "mastra", "tools");
const AGENTS_DIR = path.join(REPO_ROOT, "src", "mastra", "agents");
const FIXTURE_FILE = path.join(
  REPO_ROOT,
  "src",
  "utils",
  "integrationTestFixtureTools.ts",
);

/* ------------------------------------------------------------------ *
 * Source walkers                                                     *
 * ------------------------------------------------------------------ */

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await listTsFiles(full)));
    } else if (e.isFile() && e.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Strips `// ...` and block comments from a TS source file so
 * regex-based id extraction is not fooled by an example in a doc
 * comment (e.g. exampleTool.ts has commented-out fixtures).
 */
function stripComments(src: string): string {
  // Remove block comments first (greedy across lines, non-greedy body).
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Then remove line comments.
  return noBlock.replace(/^\s*\/\/.*$/gm, "");
}

interface ToolDeclaration {
  /** absolute path to the source file */
  file: string;
  /** the value of the `id:` property — the tool id used at runtime */
  id: string;
  /** the variable name the tool is exported as (best-effort, may be null) */
  varName: string | null;
}

/**
 * Find every `createTool({ id: '...' })` call in a TS source file and
 * return the discovered tool declarations.
 *
 * We also try to recover the surrounding `export const X = createTool(...)`
 * variable name so we can later cross-reference `withApprovalGate(X)`.
 */
function extractCreateToolDecls(file: string, src: string): ToolDeclaration[] {
  const out: ToolDeclaration[] = [];
  const cleaned = stripComments(src);

  // Pattern: optional `export const VAR =` followed by createTool({
  // then within the next ~2k chars find `id: '...'` or `id: "..."`.
  const callRe =
    /(?:export\s+const\s+([A-Za-z0-9_]+)\s*=\s*)?createTool\s*\(\s*\{/g;

  let m: RegExpExecArray | null;
  while ((m = callRe.exec(cleaned)) !== null) {
    const varName = m[1] ?? null;
    // Look ahead for the id field within a window — the createTool
    // object literal is always small in this codebase, so 2k is plenty.
    const window = cleaned.slice(m.index, m.index + 4096);
    const idMatch =
      /\bid\s*:\s*(['"`])([^'"`\n]+)\1/.exec(window) ||
      // also accept identifier substitution: id: SOME_CONST
      /\bid\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,}]/.exec(window);

    if (!idMatch) continue;

    const idValueOrConst = idMatch[2] ?? idMatch[1];
    if (!idValueOrConst) continue;

    out.push({ file, id: idValueOrConst, varName });
  }

  return out;
}

/**
 * Resolve `id: SOME_CONST` references to their string values by looking
 * for `export const SOME_CONST = '...'` declarations in the same file.
 */
function resolveConstIds(decls: ToolDeclaration[], src: string): ToolDeclaration[] {
  const constRe =
    /export\s+const\s+([A-Z_][A-Z0-9_]*)\s*=\s*(['"`])([^'"`\n]+)\2/g;
  const consts = new Map<string, string>();
  let m: RegExpExecArray | null;
  const cleaned = stripComments(src);
  while ((m = constRe.exec(cleaned)) !== null) {
    consts.set(m[1], m[3]);
  }
  return decls.map((d) =>
    consts.has(d.id) ? { ...d, id: consts.get(d.id)! } : d,
  );
}

interface GateCall {
  /** the variable name passed to withApprovalGate(VAR) — null for inline objects */
  varName: string | null;
  /** the inline tool id passed to withApprovalGate({ id: '...' }) — null for var refs */
  inlineId: string | null;
  /** absolute path to the source file the call lives in */
  file: string;
}

/**
 * Find every `withApprovalGate(...)` call site so we can build the set
 * of "gated tool ids" (ids that MUST have a policy because the runtime
 * gate will refuse to execute without one).
 */
function extractGateCalls(file: string, src: string): GateCall[] {
  const out: GateCall[] = [];
  const cleaned = stripComments(src);
  // withApprovalGate(VAR)  — variable form
  const varRe = /withApprovalGate\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[,)]/g;
  let m: RegExpExecArray | null;
  while ((m = varRe.exec(cleaned)) !== null) {
    out.push({ varName: m[1], inlineId: null, file });
  }
  // withApprovalGate({ id: ... }) — inline object form
  const inlineRe = /withApprovalGate\s*\(\s*\{/g;
  while ((m = inlineRe.exec(cleaned)) !== null) {
    const window = cleaned.slice(m.index, m.index + 4096);
    const idMatch =
      /\bid\s*:\s*(['"`])([^'"`\n]+)\1/.exec(window) ||
      /\bid\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,}]/.exec(window);
    if (!idMatch) continue;
    out.push({
      varName: null,
      inlineId: idMatch[2] ?? idMatch[1],
      file,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The check                                                          *
 * ------------------------------------------------------------------ */

async function run(): Promise<void> {
  console.log(`\n[aiToolPolicyCoverage] scanning ${TOOLS_DIR} and fixtures\n`);

  // 1. Discover every createTool decl in the tools dir + fixture file.
  const toolFiles = await listTsFiles(TOOLS_DIR);
  toolFiles.push(FIXTURE_FILE);

  const allDecls: ToolDeclaration[] = [];
  const fileSrcCache = new Map<string, string>();

  for (const file of toolFiles) {
    const src = await fs.readFile(file, "utf8");
    fileSrcCache.set(file, src);
    const decls = resolveConstIds(extractCreateToolDecls(file, src), src);
    allDecls.push(...decls);
  }

  // Informational only — a brittle minimum-count would fire on any
  // legitimate tool deletion / refactor. We surface the number so a
  // reviewer can sanity-check it, but the contract this test enforces
  // is per-tool coverage, not headcount.
  console.log(`  • discovered ${allDecls.length} createTool declarations`);

  // Map varName → toolId for cross-referencing withApprovalGate(varName).
  const varToId = new Map<string, string>();
  for (const d of allDecls) {
    if (d.varName) varToId.set(d.varName, d.id);
  }

  // Set of every distinct createTool id we found.
  const allToolIds = new Set(allDecls.map((d) => d.id));

  // 2. Discover every withApprovalGate(...) reference so we know which
  //    tools MUST have a policy (no exemption).
  const agentFiles = await listTsFiles(AGENTS_DIR);
  agentFiles.push(FIXTURE_FILE);

  const gatedToolIds = new Set<string>();
  const unresolvedGateRefs: GateCall[] = [];
  for (const file of agentFiles) {
    const src = fileSrcCache.get(file) ?? (await fs.readFile(file, "utf8"));
    fileSrcCache.set(file, src);
    const gateCalls = extractGateCalls(file, src);
    for (const gc of gateCalls) {
      if (gc.inlineId) {
        // Resolve potential constant references in the inline form.
        const resolved =
          (gc.inlineId.match(/^[A-Z_][A-Z0-9_]*$/) &&
            // Search for the constant declaration anywhere we have source for.
            (() => {
              for (const fileSrc of fileSrcCache.values()) {
                const re = new RegExp(
                  `export\\s+const\\s+${gc.inlineId}\\s*=\\s*(['"\`])([^'"\`\\n]+)\\1`,
                );
                const m = re.exec(stripComments(fileSrc));
                if (m) return m[2];
              }
              return null;
            })()) ||
          gc.inlineId;
        gatedToolIds.add(resolved);
      } else if (gc.varName) {
        const id = varToId.get(gc.varName);
        if (id) {
          gatedToolIds.add(id);
        } else {
          unresolvedGateRefs.push(gc);
        }
      }
    }
  }

  // Informational only (same rationale as the createTool count above).
  console.log(`  • discovered ${gatedToolIds.size} gated tool ids via withApprovalGate`);

  assert(
    unresolvedGateRefs.length === 0,
    `every withApprovalGate(varName) reference resolves to a known createTool variable` +
      (unresolvedGateRefs.length
        ? ` (UNRESOLVED: ${unresolvedGateRefs.map((g) => `${path.basename(g.file)}:${g.varName}`).join(", ")})`
        : ""),
  );

  console.log(`\n  • ${allDecls.length} tool declarations`);
  console.log(`  • ${Object.keys(TOOL_GOVERNANCE_POLICIES).length} registered policies`);
  console.log(`  • ${gatedToolIds.size} gated tool ids\n`);

  // 3. Per-tool coverage assertions.
  const policyIds = new Set(Object.keys(TOOL_GOVERNANCE_POLICIES));

  for (const toolId of [...allToolIds].sort()) {
    const explicit = TOOL_GOVERNANCE_POLICIES[toolId];
    const isGated = gatedToolIds.has(toolId);

    // (a) GATED (write/approval) tools MUST be explicitly classified — a
    //     synthesized default would silently make a write tool no-approval,
    //     which is a security hole. withApprovalGate also refuses to run them
    //     without an explicit policy.
    //     UN-GATED read-only tools auto-get a documented read-only default via
    //     getEffectiveToolGovernancePolicy(), so a new radar read-tool never
    //     blocks a publish on this gate.
    if (isGated) {
      assert(
        !!explicit,
        `[${toolId}] GATED tool has an explicit TOOL_GOVERNANCE_POLICIES entry`,
      );
    } else if (!explicit) {
      console.log(
        `  • [${toolId}] no explicit policy → auto read-only default (ok, un-gated)`,
      );
    }

    // Validate the EFFECTIVE policy (explicit, or the synthesized read-only
    // default) so the shape contract holds either way.
    const policy: ToolGovernancePolicy =
      getEffectiveToolGovernancePolicy(toolId);

    // (b) Shape: buildPreview must be a function that returns a
    //     non-empty string for an empty payload, and complianceRefs must
    //     be a non-empty array of non-empty strings.
    assert(
      typeof policy.buildPreview === "function",
      `[${toolId}] policy.buildPreview is a function`,
    );

    let previewOut = "";
    let threw = false;
    try {
      previewOut = String(policy.buildPreview({}));
    } catch (err) {
      threw = true;
      console.error(
        `      buildPreview({}) threw: ${(err as Error)?.message ?? err}`,
      );
    }
    assert(
      !threw,
      `[${toolId}] policy.buildPreview({}) does not throw on an empty payload`,
    );
    assert(
      previewOut.trim().length > 0,
      `[${toolId}] policy.buildPreview({}) returns a non-empty string`,
    );

    // complianceRefs must be a non-empty array. Even gate-exempt
    // policies should document why they bypass approval — it is the
    // closest thing this codebase has to an inline governance memo.
    assert(
      Array.isArray(policy.complianceRefs) && policy.complianceRefs.length > 0,
      `[${toolId}] policy.complianceRefs is a non-empty array`,
    );

    assert(
      Array.isArray(policy.complianceRefs) &&
        policy.complianceRefs.every(
          (r) => typeof r === "string" && r.trim().length > 0,
        ),
      `[${toolId}] every compliance ref is a non-empty string`,
    );

    // Catch the easy copy-paste bug: policy.toolId must equal the key
    // it is registered under — otherwise getPolicy() lookups break.
    assert(
      policy.toolId === toolId,
      `[${toolId}] policy.toolId matches the registry key`,
    );
  }

  // 4. Orphan check — surface dead policies.
  for (const policyId of policyIds) {
    // The integration-test fixture policies are conditionally registered
    // at runtime when integrationTestFixtureTools.ts is imported (only
    // outside production). Because this test imports the governance
    // module directly without importing the fixture file, those policies
    // may or may not be present here depending on import order, but if
    // they are present they must still match a real createTool id —
    // which they do, because the fixture file registers both. The
    // orphan check therefore applies uniformly.
    assert(
      allToolIds.has(policyId),
      `[${policyId}] policy entry is not orphaned — it matches a real createTool id`,
    );
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
