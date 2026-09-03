/**
 * Programmatic MCP evaluation runner.
 *
 * Loads scenarios from tests/mcp-eval/scenarios/*.json, runs each transcript
 * through the SDR Governance 2.1 rules engine, and asserts that the resulting
 * issue codes match `must_include_codes` / `must_exclude_codes` / severity
 * thresholds. No LLM-as-judge — fast, deterministic, suitable for CI.
 *
 * Run:
 *   npx tsx tests/mcp-eval/runMcpEval.ts
 *   npx tsx tests/mcp-eval/runMcpEval.ts --scenario sdr-governance-baseline
 *
 * Exit code: 0 if all scenarios pass, 1 otherwise.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateLoadedGovernanceRules,
  resetGovernanceRulesetCache,
} from "../../src/utils/sdrGovernanceRulesEngine";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = join(__dirname, "scenarios");

interface ScenarioExpect {
  must_include_codes?: string[];
  must_exclude_codes?: string[];
  min_critical?: number;
  max_critical?: number;
  min_warning?: number;
  max_warning?: number;
}

interface Scenario {
  id: string;
  description?: string;
  transcript: string;
  expect: ScenarioExpect;
}

interface ScenarioFile {
  ruleset_under_test?: string;
  scenarios: Scenario[];
}

interface ScenarioResult {
  scenario_id: string;
  passed: boolean;
  failures: string[];
  rules_evaluated: number;
  ruleset_version: string | null;
  load_error: string | null;
  observed_codes: string[];
  critical_count: number;
  warning_count: number;
  info_count: number;
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function loadScenarioFiles(filterName?: string): Array<{ file: string; data: ScenarioFile }> {
  const entries = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".json"));
  const filtered = filterName
    ? entries.filter((f) => f.replace(/\.json$/, "") === filterName)
    : entries;
  return filtered.map((file) => ({
    file,
    data: JSON.parse(readFileSync(join(SCENARIOS_DIR, file), "utf8")) as ScenarioFile,
  }));
}

function runScenario(s: Scenario): ScenarioResult {
  resetGovernanceRulesetCache();
  const evaluation = evaluateLoadedGovernanceRules(s.transcript);
  const observed_codes = evaluation.issues.map((i) => i.code);
  let critical_count = 0;
  let warning_count = 0;
  let info_count = 0;
  for (const i of evaluation.issues) {
    if (i.severity === "critical") critical_count++;
    else if (i.severity === "warning") warning_count++;
    else info_count++;
  }

  const failures: string[] = [];
  for (const must of s.expect.must_include_codes ?? []) {
    if (!observed_codes.includes(must)) {
      failures.push(`missing_required_code: ${must}`);
    }
  }
  for (const must_not of s.expect.must_exclude_codes ?? []) {
    if (observed_codes.includes(must_not)) {
      failures.push(`unexpected_code: ${must_not}`);
    }
  }
  if (s.expect.min_critical !== undefined && critical_count < s.expect.min_critical) {
    failures.push(`critical_below_min: got=${critical_count} min=${s.expect.min_critical}`);
  }
  if (s.expect.max_critical !== undefined && critical_count > s.expect.max_critical) {
    failures.push(`critical_above_max: got=${critical_count} max=${s.expect.max_critical}`);
  }
  if (s.expect.min_warning !== undefined && warning_count < s.expect.min_warning) {
    failures.push(`warning_below_min: got=${warning_count} min=${s.expect.min_warning}`);
  }
  if (s.expect.max_warning !== undefined && warning_count > s.expect.max_warning) {
    failures.push(`warning_above_max: got=${warning_count} max=${s.expect.max_warning}`);
  }

  return {
    scenario_id: s.id,
    passed: failures.length === 0,
    failures,
    rules_evaluated: evaluation.rules_evaluated,
    ruleset_version: evaluation.ruleset_version,
    load_error: evaluation.load_error,
    observed_codes,
    critical_count,
    warning_count,
    info_count,
  };
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

async function main(): Promise<void> {
  const filter = parseArg("scenario");
  const files = loadScenarioFiles(filter);
  if (files.length === 0) {
    console.error(
      `[mcp-eval] no scenario files matched ${filter ? `name=${filter}` : "*.json"} in ${SCENARIOS_DIR}`,
    );
    process.exit(1);
  }

  let total = 0;
  let passed = 0;
  const failedRows: ScenarioResult[] = [];

  for (const { file, data } of files) {
    console.log(`\n=== ${file} ===`);
    if (data.ruleset_under_test) {
      console.log(`ruleset_under_test: ${data.ruleset_under_test}`);
    }
    for (const scenario of data.scenarios) {
      total++;
      const result = runScenario(scenario);
      if (result.passed) passed++;
      else failedRows.push(result);

      const status = result.passed ? "PASS" : "FAIL";
      console.log(
        `  ${pad(status, 5)} ${pad(scenario.id, 32)} ` +
          `rules=${result.rules_evaluated} codes=${result.observed_codes.length} ` +
          `crit=${result.critical_count} warn=${result.warning_count} info=${result.info_count}`,
      );
      if (!result.passed) {
        for (const f of result.failures) console.log(`         -> ${f}`);
        console.log(`         observed_codes=${JSON.stringify(result.observed_codes)}`);
      }
    }
  }

  console.log(`\nMCP eval summary: ${passed}/${total} scenarios passed`);
  if (failedRows.length > 0) {
    console.log(`Failed: ${failedRows.map((r) => r.scenario_id).join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[mcp-eval] runner crashed:", err);
  process.exit(1);
});
