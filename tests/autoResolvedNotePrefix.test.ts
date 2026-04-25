/**
 * Backend prefix-contract tests for the auto-resolved alert badge
 * (Task #554 — follow-up to Task #325's UI E2E spec).
 *
 * Background:
 *   The dashboard's `isAutoResolved()` check in `dashboard/ai-ops.html` and
 *   `dashboard/consultant.html` decides whether a resolved `ai_alerts` row
 *   gets the "Auto-resolved" pill or the "Manually resolved" / "Manual"
 *   pill purely from a string-prefix test on `resolution_note`:
 *
 *     return note.indexOf('auto-resolved') === 0;
 *
 *   Both server-side cron paths that close alerts automatically — the
 *   tool-health auto-resolve sweep (in-window recovery + silent-tool
 *   sweep) and the prompt-regression auto-resolve sweep — stamp
 *   `resolution_note` with the literal lowercase prefix `auto-resolved:`.
 *
 *   Task #325 added `tests/autoResolvedAlertBadge.spec.ts`, which proves
 *   the *frontend* renders the right pill given a hand-seeded note that
 *   already starts with `auto-resolved:`. It does NOT prove that the
 *   crons actually write that exact prefix — any drift in casing,
 *   punctuation, or wording on the cron side would silently flip every
 *   auto-closed alert back to the "Manually resolved" pill without a
 *   test alarm.
 *
 * What this spec asserts (Task #554's "done looks like"):
 *   • The tool-health in-window error-rate recovery sweep writes a note
 *     that starts with the literal lowercase prefix `auto-resolved:`.
 *   • The tool-health in-window p95-latency recovery sweep does the same.
 *   • The tool-health silent-tool sweep does the same.
 *   • The prompt-regression auto-resolve sweep does the same.
 *   • The dashboards' `isAutoResolved()` substring check still matches
 *     that prefix — read straight out of the HTML files so the test
 *     fails if either side of the contract drifts.
 *
 * If a future refactor changes the cron-side prefix (e.g. capitalises it,
 * drops the colon, or moves to "auto-closed:"), each of the four cron
 * assertions below breaks. If the dashboard-side substring drifts, the
 * extracted-prefix assertions break. Either way, the badge contract can
 * no longer regress silently.
 *
 * Run:  npx tsx tests/autoResolvedNotePrefix.test.ts
 * Wired: discovered automatically by tests/runIntegrationTests.ts (npm test).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  runToolHealthCheck,
  runSilentToolSweep,
  type ToolHealthCheckResult,
  type ToolHealthDeps,
} from "../src/mastra/workflows/toolHealthAlertsCron";
import {
  runPromptRegressionCheck,
  type PromptRegressionDeps,
} from "../src/mastra/workflows/promptRegressionAlertsCron";
import type {
  ToolWindowAggregate,
  PromptVersionAggregate,
} from "../src/utils/aiTelemetry";
import type { AIAlert, AlertSeverity } from "../src/utils/aiAlertsDatabase";
import { TestSuite } from "./_helpers/runner";

// ──────────────────────────────────────────────────────────────────────────────
// Canonical prefix the cron paths MUST stamp on `resolution_note`. Locked
// here as a single literal so a refactor of any one cron path that drifts
// from the others is caught by this test even if the dashboard check
// hasn't changed yet.
// ──────────────────────────────────────────────────────────────────────────────
const AUTO_RESOLVED_PREFIX = "auto-resolved:";

// ──────────────────────────────────────────────────────────────────────────────
// Read the literal substring the dashboards' isAutoResolved() function
// passes to `String.prototype.indexOf(...) === 0`. We extract it from the
// HTML rather than hardcoding it so the test is bound to whatever the UI
// actually checks for — if a future refactor changes the dashboard
// substring (e.g. to 'Auto-resolved' or 'auto-closed'), the assertions
// below catch the drift before the badge silently mislabels alerts.
// ──────────────────────────────────────────────────────────────────────────────
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TESTS_DIR, "..");

function extractIsAutoResolvedSubstring(htmlPath: string): string {
  const html = readFileSync(resolve(REPO_ROOT, htmlPath), "utf8");
  // Matches the body of:
  //   return note.indexOf('auto-resolved') === 0;
  // tolerating either single or double quotes and arbitrary whitespace
  // around the `===` so the regex doesn't break on a benign reformat.
  const m = html.match(
    /note\.indexOf\(\s*['"]([^'"]+)['"]\s*\)\s*===\s*0/,
  );
  if (!m) {
    throw new Error(
      `Could not locate isAutoResolved() prefix check in ${htmlPath} — ` +
      `looked for note.indexOf('…') === 0`,
    );
  }
  return m[1];
}

const AI_OPS_PREFIX = extractIsAutoResolvedSubstring("dashboard/ai-ops.html");
const CONSULTANT_PREFIX = extractIsAutoResolvedSubstring(
  "dashboard/consultant.html",
);

// ──────────────────────────────────────────────────────────────────────────────
// Tool-health stubs — minimal `ToolHealthDeps` that capture every
// resolveAlert(id, note) call so the prefix can be asserted. Anything the
// recovery/silent-sweep paths don't touch throws so an accidental change
// to the cron's I/O surface produces a clear failure.
// ──────────────────────────────────────────────────────────────────────────────

interface ToolHealthCapturedResolve {
  id: number;
  note: string | undefined;
}

function makeToolHealthDeps(opts: {
  aggregates: ToolWindowAggregate[];
  /** Open alerts the in-window recovery lookup should return, keyed by `<tool>:<reason>`. */
  openAlertsByKey?: Record<string, AIAlert[]>;
  /** Open `tool_health` alerts the silent-sweep lookup should return. */
  openAlertsByType?: AIAlert[];
  /** Tool names that are "active" within the cooldown window. */
  activeTools?: Iterable<string>;
}): { deps: ToolHealthDeps; resolves: ToolHealthCapturedResolve[] } {
  const resolves: ToolHealthCapturedResolve[] = [];
  const openByKey = opts.openAlertsByKey ?? {};
  const activeTools = new Set<string>(opts.activeTools ?? []);

  const deps: ToolHealthDeps = {
    getToolWindowAggregates: async () => opts.aggregates,
    openAlertExistsByKey: async () => false,
    createAIAlert: async (alert) =>
      ({ ...alert, id: 999, status: "open" }) as AIAlert,
    getOpenAlertsByKey: async (_alertType, relatedRecordId) =>
      openByKey[relatedRecordId] ?? [],
    getOpenAlertsByType: async () => opts.openAlertsByType ?? [],
    getToolsWithCallsInWindow: async () => activeTools,
    resolveAlert: async (id, note) => {
      resolves.push({ id, note });
      return {
        id,
        alert_type: "tool_health",
        severity: "high",
        title: "stub",
        description: "stub",
        status: "resolved",
        resolution_note: note ?? null,
      } as AIAlert;
    },
    notifyToolHealthBreach: async () => ({
      slackSent: true,
      emailSent: false,
      throttled: false,
      skipped: false,
    }),
    notifyToolHealthRecovery: async () => ({
      slackSent: true,
      emailSent: false,
      skipped: false,
    }),
    recordNotifyDeadLetter: async () =>
      ({
        id: 12345,
        alert_type: "tool_health",
        severity: "critical",
        title: "stub",
        description: "stub",
        status: "open",
      }) as AIAlert,
  };
  return { deps, resolves };
}

function makeToolHealthAggregate(
  p: Partial<ToolWindowAggregate> = {},
): ToolWindowAggregate {
  return {
    tool_name: "fake_tool",
    agent_name: "fake_agent",
    call_count: 100,
    error_count: 0,
    error_rate_pct: 0,
    p95_latency_ms: 100,
    avg_latency_ms: 50,
    max_latency_ms: 200,
    ...p,
  };
}

function makeOpenToolHealthAlert(
  id: number,
  relatedRecordId: string,
): AIAlert {
  return {
    id,
    alert_type: "tool_health",
    severity: "high",
    title: `stub alert ${id}`,
    description: "stub",
    status: "open",
    related_record_id: relatedRecordId,
    // Old enough to be past any cooldown window the cron applies to the
    // SQL-side filter so the recovery path sees the alert.
    created_at: new Date(Date.now() - 24 * 60 * 60_000),
  };
}

function makeEmptyToolHealthResult(): ToolHealthCheckResult {
  return {
    toolsEvaluated: 0,
    alertsCreated: 0,
    alertsSkippedDuplicate: 0,
    alertsAutoResolved: 0,
    expiredOverridesReaped: 0,
    overrideExpirySoonWarningSent: 0,
    notificationsSent: 0,
    notificationsSkipped: 0,
    notificationsThrottled: 0,
    notificationsDeadLettered: 0,
    breaches: [],
    recoveries: [],
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Prompt-regression stubs — minimal `PromptRegressionDeps` that drive the
// recovery sweep deterministically. Mirrors the shape used in
// tests/promptRegressionAlertsCron.test.ts so the assertions here are
// against the same code path the existing recovery tests exercise.
// ──────────────────────────────────────────────────────────────────────────────

interface PromptCapturedResolve {
  id: number;
  note: string;
}

function makePromptRegressionRow(
  over: Partial<PromptVersionAggregate> = {},
): PromptVersionAggregate {
  const base: PromptVersionAggregate = {
    agent_name: "TestAgent",
    prompt_version: "v1",
    call_count: 100,
    total_feedback: 20,
    thumbs_up: 18,
    thumbs_down: 2,
    feedback_rate_pct: 90,
    p50_ms: 500,
    avg_ms: 600,
    error_rate_pct: 0,
    first_seen: "2026-04-01T00:00:00Z",
    last_seen: "2026-04-20T00:00:00Z",
    last_seen_at: "2026-04-20T12:00:00Z",
    min_feedback: 5,
    meets_min_feedback: true,
  };
  return { ...base, ...over };
}

function makePromptRegressionDeps(opts: {
  rows: PromptVersionAggregate[];
  openAlerts: AIAlert[];
}): { deps: PromptRegressionDeps; resolved: PromptCapturedResolve[] } {
  const resolved: PromptCapturedResolve[] = [];
  const deps: PromptRegressionDeps = {
    fetchAggregates: async () => opts.rows,
    alertExists: async () => false,
    createAlert: async () => {},
    listOpenRegressionAlerts: async () => opts.openAlerts,
    resolveAlert: async (id, note) => {
      resolved.push({ id, note });
      return {
        id,
        alert_type: "prompt_regression",
        severity: "medium" as AlertSeverity,
        title: "stub",
        description: "stub",
        status: "resolved",
        resolution_note: note,
      } as AIAlert;
    },
    notifyRecovery: async () => {},
    now: () => new Date("2026-04-25T12:00:00Z"),
  };
  return { deps, resolved };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

const suite = new TestSuite(
  "auto-resolved resolution_note prefix contract (Task #554)",
);
console.log("\n=== autoResolvedNotePrefix tests ===\n");

await suite.test(
  "tool-health in-window ERROR_RATE recovery sweep writes a note that starts with the literal lowercase 'auto-resolved:' prefix",
  async () => {
    const agg = makeToolHealthAggregate({
      tool_name: "search_kb",
      // Healthy on both reasons → recovery sweep fires for both keys.
      error_rate_pct: 0,
      error_count: 0,
      p95_latency_ms: 100,
    });
    const openAlert = makeOpenToolHealthAlert(101, "search_kb:error_rate");
    const { deps, resolves } = makeToolHealthDeps({
      aggregates: [agg],
      openAlertsByKey: { "search_kb:error_rate": [openAlert] },
    });

    const out = await runToolHealthCheck(deps);

    // Surface useful failure info: the cron may have closed alerts via
    // either the in-window sweep or the silent-tool sweep. Both must use
    // the same prefix.
    suite.expect(
      resolves.length >= 1,
      `expected at least one resolveAlert call, got ${resolves.length}`,
    );
    const errorRateResolve = resolves.find((r) => r.id === 101);
    suite.expect(
      errorRateResolve != null,
      `expected resolveAlert to fire for the seeded error_rate alert id 101 (got ids: ${resolves.map((r) => r.id).join(",")})`,
    );
    suite.expect(
      typeof errorRateResolve?.note === "string" &&
        errorRateResolve.note.startsWith(AUTO_RESOLVED_PREFIX),
      `note must start with the literal "${AUTO_RESOLVED_PREFIX}" prefix (got: ${JSON.stringify(errorRateResolve?.note)})`,
    );
    // Self-describing detail — the rest of the note must mention what
    // recovered, so the audit trail is useful even without the prefix.
    suite.expect(
      typeof errorRateResolve?.note === "string" &&
        errorRateResolve.note.toLowerCase().includes("error rate"),
      `error_rate recovery note should mention "error rate" (got: ${JSON.stringify(errorRateResolve?.note)})`,
    );
    suite.expectEqual(
      out.alertsAutoResolved >= 1,
      true,
      "alertsAutoResolved counter incremented",
    );
  },
);

await suite.test(
  "tool-health in-window P95_LATENCY recovery sweep writes a note that starts with the literal lowercase 'auto-resolved:' prefix",
  async () => {
    const agg = makeToolHealthAggregate({
      tool_name: "rag_search",
      error_rate_pct: 0,
      error_count: 0,
      // Healthy latency, well below threshold → recovery path fires.
      p95_latency_ms: 200,
    });
    const openAlert = makeOpenToolHealthAlert(202, "rag_search:p95_latency");
    const { deps, resolves } = makeToolHealthDeps({
      aggregates: [agg],
      openAlertsByKey: { "rag_search:p95_latency": [openAlert] },
    });

    const out = await runToolHealthCheck(deps);

    const latencyResolve = resolves.find((r) => r.id === 202);
    suite.expect(
      latencyResolve != null,
      `expected resolveAlert to fire for the seeded p95_latency alert id 202 (got ids: ${resolves.map((r) => r.id).join(",")})`,
    );
    suite.expect(
      typeof latencyResolve?.note === "string" &&
        latencyResolve.note.startsWith(AUTO_RESOLVED_PREFIX),
      `note must start with the literal "${AUTO_RESOLVED_PREFIX}" prefix (got: ${JSON.stringify(latencyResolve?.note)})`,
    );
    suite.expect(
      typeof latencyResolve?.note === "string" &&
        latencyResolve.note.toLowerCase().includes("p95 latency"),
      `p95_latency recovery note should mention "p95 latency" (got: ${JSON.stringify(latencyResolve?.note)})`,
    );
    suite.expectEqual(
      out.alertsAutoResolved >= 1,
      true,
      "alertsAutoResolved counter incremented",
    );
  },
);

await suite.test(
  "tool-health SILENT-TOOL sweep writes a note that starts with the literal lowercase 'auto-resolved:' prefix",
  async () => {
    const openAlert = makeOpenToolHealthAlert(303, "deprecated_tool:error_rate");
    const { deps, resolves } = makeToolHealthDeps({
      aggregates: [],
      openAlertsByType: [openAlert],
      activeTools: [], // deprecated_tool is silent → sweep auto-resolves it
    });
    const out = makeEmptyToolHealthResult();

    // 240m matches the production default (TOOL_HEALTH_SILENT_COOLDOWN_MULT
    // × windowMinutes = 4 × 60). The exact value doesn't affect the
    // prefix, only the trailing detail wording.
    await runSilentToolSweep(deps, 240, out);

    suite.expectEqual(resolves.length, 1, "silent-sweep called resolveAlert exactly once");
    suite.expectEqual(resolves[0]?.id, 303, "resolved the seeded silent-tool alert");
    suite.expect(
      typeof resolves[0]?.note === "string" &&
        resolves[0].note.startsWith(AUTO_RESOLVED_PREFIX),
      `silent-sweep note must start with the literal "${AUTO_RESOLVED_PREFIX}" prefix (got: ${JSON.stringify(resolves[0]?.note)})`,
    );
    suite.expect(
      typeof resolves[0]?.note === "string" &&
        resolves[0].note.toLowerCase().includes("tool went silent"),
      `silent-sweep note should mention "tool went silent" (got: ${JSON.stringify(resolves[0]?.note)})`,
    );
    suite.expectEqual(out.alertsAutoResolved, 1, "alertsAutoResolved counter incremented");
  },
);

await suite.test(
  "prompt-regression auto-resolve sweep writes a note that starts with the literal lowercase 'auto-resolved:' prefix",
  async () => {
    // Open alert keyed on TestAgent:v2; the aggregates show both versions
    // healthy (only 5pp drop, below the 10pp threshold) so the recovery
    // sweep fires for the TestAgent:v2 key.
    const openAlert: AIAlert = {
      id: 404,
      alert_type: "prompt_regression",
      severity: "high",
      title: "Prompt regression: TestAgent v2",
      description: "stub",
      status: "open",
      related_record_id: "TestAgent:v2",
    };
    const { deps, resolved } = makePromptRegressionDeps({
      rows: [
        makePromptRegressionRow({
          prompt_version: "v1",
          feedback_rate_pct: 90,
          total_feedback: 20,
          thumbs_up: 18,
          thumbs_down: 2,
        }),
        makePromptRegressionRow({
          prompt_version: "v2",
          feedback_rate_pct: 85,
          total_feedback: 20,
          thumbs_up: 17,
          thumbs_down: 3,
        }),
      ],
      openAlerts: [openAlert],
    });

    const out = await runPromptRegressionCheck(deps);

    suite.expectEqual(out.alertsAutoResolved, 1, "exactly one alert auto-resolved");
    suite.expectEqual(resolved.length, 1, "resolveAlert called exactly once");
    suite.expectEqual(resolved[0]?.id, 404, "resolved the seeded prompt_regression alert");
    suite.expect(
      typeof resolved[0]?.note === "string" &&
        resolved[0].note.startsWith(AUTO_RESOLVED_PREFIX),
      `prompt-regression note must start with the literal "${AUTO_RESOLVED_PREFIX}" prefix (got: ${JSON.stringify(resolved[0]?.note)})`,
    );
    // Self-describing detail: the rest of the note should identify the
    // recovered key so the audit trail is useful at a glance.
    suite.expect(
      typeof resolved[0]?.note === "string" &&
        resolved[0].note.includes("TestAgent:v2"),
      `prompt-regression note should identify the recovered key (got: ${JSON.stringify(resolved[0]?.note)})`,
    );
  },
);

await suite.test(
  "dashboards' isAutoResolved() substring still matches the cron-side 'auto-resolved:' prefix (read straight out of dashboard/ai-ops.html and dashboard/consultant.html)",
  async () => {
    // Both dashboards must look for a substring that is itself a prefix
    // of (or equal to) the canonical `auto-resolved:` literal — i.e. any
    // note that starts with `auto-resolved:` must also satisfy
    // `note.indexOf(<dashboard substring>) === 0`. If a future refactor
    // changes the dashboard substring (e.g. capitalises it, drops the
    // hyphen, or moves to "auto-closed"), this assertion breaks before
    // the badge can silently mislabel alerts.
    suite.expect(
      AUTO_RESOLVED_PREFIX.startsWith(AI_OPS_PREFIX),
      `dashboard/ai-ops.html isAutoResolved() looks for ${JSON.stringify(AI_OPS_PREFIX)}, which is not a prefix of the cron-side ${JSON.stringify(AUTO_RESOLVED_PREFIX)}`,
    );
    suite.expect(
      AUTO_RESOLVED_PREFIX.startsWith(CONSULTANT_PREFIX),
      `dashboard/consultant.html isAutoResolved() looks for ${JSON.stringify(CONSULTANT_PREFIX)}, which is not a prefix of the cron-side ${JSON.stringify(AUTO_RESOLVED_PREFIX)}`,
    );
    // Belt-and-braces: the two dashboards must agree with each other so
    // an alert can never render as "auto" on one panel and "manual" on
    // the other.
    suite.expectEqual(
      AI_OPS_PREFIX,
      CONSULTANT_PREFIX,
      "ai-ops.html and consultant.html must agree on the isAutoResolved() substring",
    );
    // Lock the substring itself so a refactor that changes both
    // dashboards in lockstep but drops the contract (e.g. switches to a
    // markedly different word that still happens to be the same on both
    // panels) still produces a clear failure here.
    suite.expectEqual(
      AI_OPS_PREFIX,
      "auto-resolved",
      "dashboard isAutoResolved() must look for the literal 'auto-resolved' substring",
    );
  },
);

suite.finishOrExit();
