/**
 * Unit tests for the prompt-regression alert cron (Task #121).
 *
 * Covers the pure evaluation helper `runPromptRegressionCheck()` in
 * `src/mastra/workflows/promptRegressionAlertsCron.ts`. Uses dependency
 * injection — the helper is fed synthetic aggregate rows and stub
 * alert-store callbacks so the test exercises the full decision logic
 * without touching Postgres or Inngest.
 *
 * Run:  npx tsx tests/promptRegressionAlertsCron.test.ts
 */

import {
  runPromptRegressionCheck,
  sendPromptRegressionNotifications,
  sendPromptRegressionRecoveryNotifications,
  PROMPT_REGRESSION_THRESHOLDS,
  PROMPT_REGRESSION_DEFAULTS,
  PROMPT_REGRESSION_BOUNDS,
  PROMPT_REGRESSION_ENV_BASELINE,
  mergePromptRegressionOverrides,
  type RegressionBreach,
  type RegressionRecovery,
} from "../src/mastra/workflows/promptRegressionAlertsCron";
import type { PromptVersionAggregate } from "../src/utils/aiTelemetry";
import type { AIAlert, AlertSeverity } from "../src/utils/aiAlertsDatabase";

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

interface CapturedAlert {
  title: string;
  description: string;
  suggestion: string;
  severity: AlertSeverity;
  relatedRecordId: string;
}

interface CapturedResolve {
  id: number;
  note: string;
}

interface CapturedRecoveryNotification {
  alert_id: number;
  related_record_id: string;
  agent_name: string;
  prompt_version: string;
  note: string;
}

// Pinned "now" used by every test so the "last seen X days ago" clause
// renders deterministically. Picked far enough in the future of the
// `last_seen_at` defaults below that ordinary cases land at exactly 5
// days ago — easy to assert without floating-point fuzz.
const FIXED_NOW_ISO = "2026-04-25T12:00:00Z";
const FIXED_NOW = new Date(FIXED_NOW_ISO);

function makeStub(opts: {
  rows: PromptVersionAggregate[];
  existingKeys?: Set<string>;
  openAlerts?: AIAlert[];
  /** Override the cron's "now" for last-seen-days-ago math. */
  now?: () => Date;
}) {
  const created: CapturedAlert[] = [];
  const resolved: CapturedResolve[] = [];
  const recoveryCalls: CapturedRecoveryNotification[][] = [];
  const seenExists = new Set(opts.existingKeys ?? []);
  const openAlertsList: AIAlert[] = opts.openAlerts ?? [];
  return {
    created,
    resolved,
    recoveryCalls,
    deps: {
      fetchAggregates: async (_days: number) => opts.rows,
      alertExists: async (relatedRecordId: string) =>
        seenExists.has(relatedRecordId),
      createAlert: async (alert: CapturedAlert) => {
        created.push(alert);
      },
      listOpenRegressionAlerts: async () => openAlertsList,
      resolveAlert: async (id: number, note: string): Promise<AIAlert | null> => {
        resolved.push({ id, note });
        return { id, alert_type: "prompt_regression", severity: "medium", title: "", description: "", status: "resolved" };
      },
      // Stub the recovery notifier so tests never touch ChatProvider/email or
      // process.env.ChatProvider_WEBHOOK_URL — mirrors `notifyToolHealthRecovery`
      // dep injection on the tool-health cron.
      notifyRecovery: async (recoveries: CapturedRecoveryNotification[]) => {
        recoveryCalls.push(recoveries);
      },
      now: opts.now ?? (() => FIXED_NOW),
    },
  };
}

function makeRow(over: Partial<PromptVersionAggregate>): PromptVersionAggregate {
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
    // Unbounded all-time last seen (added to the aggregate by Task #173).
    // Defaulted to exactly 5 days before FIXED_NOW so the regression cron's
    // "last seen X days ago" clause renders deterministically as
    // "Last seen 5 days ago." for the common case. Tests that want to
    // exercise other recencies override this in `over`.
    last_seen_at: "2026-04-20T12:00:00Z",
    // The aggregate now echoes the small-sample floor and per-row
    // eligibility flag so the dashboard can hide best/regression badges
    // for brand-new versions. Default to "comparable" here so existing
    // cron tests keep their semantics; tests that want to exercise the
    // small-sample path can override these in `over`.
    min_feedback: 5,
    meets_min_feedback: true,
    client_surfaces: {},
    rating_sources: {},
  };
  const merged = { ...base, ...over };
  // Keep meets_min_feedback consistent with whatever total_feedback the
  // caller specified unless they explicitly overrode the flag.
  if (over.meets_min_feedback === undefined) {
    merged.meets_min_feedback = Number(merged.total_feedback) >= merged.min_feedback;
  }
  return merged;
}

async function run(): Promise<void> {
  const cfg = PROMPT_REGRESSION_THRESHOLDS;

  // ──────────────────────────────────────────────────────────────────────
  // Case 1: clear regression — best is 90%, regressed is 70%, both have
  // enough samples → exactly one alert with severity 'medium' (the WARN
  // tier the task explicitly calls out).
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n1. Clear 20pp regression with adequate samples");
  {
    const stub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 90, total_feedback: 20, thumbs_up: 18, thumbs_down: 2 }),
        makeRow({ prompt_version: "v2", feedback_rate_pct: 70, total_feedback: 20, thumbs_up: 14, thumbs_down: 6 }),
      ],
    });
    const out = await runPromptRegressionCheck(stub.deps);
    assert(out.alertsCreated === 1, "creates exactly 1 alert");
    assert(out.alertsSkippedDuplicate === 0, "no duplicates skipped");
    assert(stub.created.length === 1, "stub captured 1 alert");
    const a = stub.created[0];
    assert(
      a.relatedRecordId === "TestAgent:v2",
      `related id is "TestAgent:v2" (got "${a.relatedRecordId}")`,
    );
    assert(a.severity === "high", `severity for 20pp drop is "high" (got "${a.severity}")`);
    assert(
      a.title.includes("TestAgent") && a.title.includes("v2"),
      "title names the agent and the regressed version",
    );
    assert(
      a.suggestion.includes("/ai-ops?tab=prompts"),
      "suggestion contains the /ai-ops?tab=prompts deep link",
    );
    assert(
      a.description.includes("v1") && a.description.includes("v2") &&
        a.description.includes("70%") && a.description.includes("90%"),
      "description names both versions and both rates",
    );
    // Task #331: description must also tell the on-call reviewer how
    // recently the regressed version was last used so they can tell an
    // active production regression from a dormant archived version.
    // makeRow defaults regressed v2 to last_seen_at = 5 days before
    // FIXED_NOW, so the clause renders as exactly "Last seen 5 days ago."
    assert(
      a.description.includes("Last seen 5 days ago."),
      `description includes "last seen X days ago" clause (got: "${a.description}")`,
    );
    const breach = out.breaches[0];
    assert(
      breach.regressed_version === "v2" && breach.best_version === "v1",
      "breach record points at v2 regressed vs v1 best",
    );
    assert(
      Math.abs(breach.drop_pp - 20) < 0.001,
      `drop_pp is ~20 (got ${breach.drop_pp})`,
    );
    assert(
      breach.regressed_last_seen_days_ago === 5,
      `breach carries regressed_last_seen_days_ago=5 (got ${breach.regressed_last_seen_days_ago})`,
    );
    assert(
      breach.regressed_last_seen_at === "2026-04-20T12:00:00Z",
      `breach carries the source ISO timestamp (got "${breach.regressed_last_seen_at}")`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 2: drop is below threshold → no alert.
  // 90% → 85% is only 5pp, well under the 10pp warn line.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n2. Sub-threshold drop (5pp) — no alert");
  {
    const stub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 90 }),
        makeRow({ prompt_version: "v2", feedback_rate_pct: 85 }),
      ],
    });
    const out = await runPromptRegressionCheck(stub.deps);
    assert(out.alertsCreated === 0, "no alerts created");
    assert(stub.created.length === 0, "stub captured no alerts");
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 3: regressed version has too few ratings → suppressed even
  // though the rate is much lower. A single thumbs-down on day 1 must
  // not page anyone.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n3. Regressed version with too few samples — no alert");
  {
    const stub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 95, total_feedback: 50, thumbs_up: 47, thumbs_down: 3 }),
        makeRow({ prompt_version: "v2", feedback_rate_pct: 0,  total_feedback: 1,  thumbs_up: 0,  thumbs_down: 1 }),
      ],
    });
    const out = await runPromptRegressionCheck(stub.deps);
    assert(out.alertsCreated === 0, "tiny-sample regression is suppressed");
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 4: dedupe — when an open alert already exists for this
  // (alert_type, agent:version) key, we must NOT create a second one.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n4. Dedupe — existing open alert blocks a new one");
  {
    const stub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 92, total_feedback: 25, thumbs_up: 23, thumbs_down: 2 }),
        makeRow({ prompt_version: "v2", feedback_rate_pct: 60, total_feedback: 20, thumbs_up: 12, thumbs_down: 8 }),
      ],
      existingKeys: new Set(["TestAgent:v2"]),
    });
    const out = await runPromptRegressionCheck(stub.deps);
    assert(out.alertsCreated === 0, "no new alert created on duplicate");
    assert(out.alertsSkippedDuplicate === 1, "dedupe counter incremented");
    assert(stub.created.length === 0, "stub captured no alerts");
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 5: severity ladder — a 35pp drop is critical.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n5. Severe regression (35pp) escalates to critical");
  {
    const stub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 95, total_feedback: 40, thumbs_up: 38, thumbs_down: 2 }),
        makeRow({ prompt_version: "v2", feedback_rate_pct: 60, total_feedback: 20, thumbs_up: 12, thumbs_down: 8 }),
      ],
    });
    const out = await runPromptRegressionCheck(stub.deps);
    assert(out.alertsCreated === 1, "creates 1 alert");
    assert(stub.created[0].severity === "critical", `35pp drop is critical (got "${stub.created[0].severity}")`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 6: only one eligible version → no comparison possible, no alert.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n6. Single eligible version — no baseline, no alert");
  {
    const stub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 50, total_feedback: 30, thumbs_up: 15, thumbs_down: 15 }),
      ],
    });
    const out = await runPromptRegressionCheck(stub.deps);
    assert(out.alertsCreated === 0, "no alerts with only one version");
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 7: "(unknown)" version is never used as the baseline. A real
  // regression away from a known version must still surface even when
  // there's an "(unknown)" bucket sitting at 100%.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n7. (unknown) bucket is ignored as baseline");
  {
    const stub = makeStub({
      rows: [
        makeRow({ prompt_version: "(unknown)", feedback_rate_pct: 100, total_feedback: 30, thumbs_up: 30, thumbs_down: 0 }),
        makeRow({ prompt_version: "v1",        feedback_rate_pct: 90,  total_feedback: 20, thumbs_up: 18, thumbs_down: 2 }),
        makeRow({ prompt_version: "v2",        feedback_rate_pct: 70,  total_feedback: 20, thumbs_up: 14, thumbs_down: 6 }),
      ],
    });
    const out = await runPromptRegressionCheck(stub.deps);
    assert(out.alertsCreated === 1, "creates 1 alert (v1 best, v2 regressed)");
    assert(
      stub.created[0].relatedRecordId === "TestAgent:v2",
      "baseline ignored (unknown), regression vs v1 surfaced",
    );
    assert(
      stub.created[0].description.includes("v1"),
      "description references v1 as best (not (unknown))",
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 8: per-agent isolation. Two different agents — a regression in
  // one must NOT use the other's versions as baseline.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n8. Per-agent isolation");
  {
    const stub = makeStub({
      rows: [
        makeRow({ agent_name: "Alpha", prompt_version: "v1", feedback_rate_pct: 95, total_feedback: 20, thumbs_up: 19, thumbs_down: 1 }),
        makeRow({ agent_name: "Alpha", prompt_version: "v2", feedback_rate_pct: 95, total_feedback: 20, thumbs_up: 19, thumbs_down: 1 }),
        makeRow({ agent_name: "Beta",  prompt_version: "v1", feedback_rate_pct: 90, total_feedback: 20, thumbs_up: 18, thumbs_down: 2 }),
        makeRow({ agent_name: "Beta",  prompt_version: "v2", feedback_rate_pct: 70, total_feedback: 20, thumbs_up: 14, thumbs_down: 6 }),
      ],
    });
    const out = await runPromptRegressionCheck(stub.deps);
    assert(out.alertsCreated === 1, "exactly one alert (Beta:v2)");
    assert(
      stub.created[0].relatedRecordId === "Beta:v2",
      `alert is for Beta:v2 (got "${stub.created[0].relatedRecordId}")`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 9: fetchAggregates throws — helper degrades gracefully and
  // returns zeroes instead of crashing the cron.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n9. fetchAggregates throws — graceful zero result");
  {
    const out = await runPromptRegressionCheck({
      fetchAggregates: async () => {
        throw new Error("simulated DB outage");
      },
      alertExists: async () => false,
      createAlert: async () => {},
    });
    assert(out.alertsCreated === 0, "no alerts when source query fails");
    assert(out.agentsEvaluated === 0, "agents counter is zero");
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 10: thresholds match the dashboard's behaviour (10pp warn line,
  // 30-day window). Locking these down so silent drift gets caught.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n10. Default thresholds match the dashboard contract");
  {
    assert(cfg.dropPctPoints === 10, "default drop threshold is 10pp (matches dashboard)");
    assert(cfg.windowDays === 30, "default window is 30 days");
    assert(cfg.minFeedback >= 1, "min-feedback default is positive");
    assert(cfg.link === "/ai-ops?tab=prompts", "link points at the prompts tab");
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 11: Recovery — an open alert exists for TestAgent:v2, but v2 is
  // now back within the threshold vs v1. The cron must auto-resolve it.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n11. Recovery — open alert auto-resolved when version recovers");
  {
    const openAlert: AIAlert = {
      id: 42,
      alert_type: "prompt_regression",
      severity: "high",
      title: "Prompt regression: TestAgent v2",
      description: "...",
      status: "open",
      related_record_id: "TestAgent:v2",
    };
    const stub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 90, total_feedback: 20, thumbs_up: 18, thumbs_down: 2 }),
        makeRow({ prompt_version: "v2", feedback_rate_pct: 85, total_feedback: 20, thumbs_up: 17, thumbs_down: 3 }),
      ],
      openAlerts: [openAlert],
    });
    const out = await runPromptRegressionCheck(stub.deps);
    assert(out.alertsCreated === 0, "no new alert (5pp drop is below threshold)");
    assert(out.alertsAutoResolved === 1, "one alert auto-resolved");
    assert(stub.resolved.length === 1, "stub captured one resolve call");
    assert(stub.resolved[0].id === 42, `resolved alert id is 42 (got ${stub.resolved[0].id})`);
    assert(
      stub.resolved[0].note.includes("TestAgent:v2"),
      "resolution note identifies the recovered key",
    );
    assert(out.recoveries.length === 1, "recoveries list has one entry");
    assert(
      out.recoveries[0].related_record_id === "TestAgent:v2",
      "recovery record identifies TestAgent:v2",
    );
    assert(
      out.recoveries[0].agent_name === "TestAgent",
      `recovery agent_name parsed (got "${out.recoveries[0].agent_name}")`,
    );
    assert(
      out.recoveries[0].prompt_version === "v2",
      `recovery prompt_version parsed (got "${out.recoveries[0].prompt_version}")`,
    );
    assert(
      stub.recoveryCalls.length === 1 &&
        stub.recoveryCalls[0].length === 1 &&
        stub.recoveryCalls[0][0].related_record_id === "TestAgent:v2",
      "recovery notifier dep was called once with the recovered alert",
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 12: Still-breaching alert is NOT auto-resolved. If a version is
  // still below the threshold vs best, an existing open alert stays open.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n12. Still-breaching alert is not auto-resolved");
  {
    const openAlert: AIAlert = {
      id: 99,
      alert_type: "prompt_regression",
      severity: "high",
      title: "Prompt regression: TestAgent v2",
      description: "...",
      status: "open",
      related_record_id: "TestAgent:v2",
    };
    const stub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 90, total_feedback: 20, thumbs_up: 18, thumbs_down: 2 }),
        makeRow({ prompt_version: "v2", feedback_rate_pct: 70, total_feedback: 20, thumbs_up: 14, thumbs_down: 6 }),
      ],
      existingKeys: new Set(["TestAgent:v2"]),
      openAlerts: [openAlert],
    });
    const out = await runPromptRegressionCheck(stub.deps);
    assert(out.alertsSkippedDuplicate === 1, "duplicate skip (alert already open)");
    assert(out.alertsAutoResolved === 0, "still-breaching alert is not auto-resolved");
    assert(stub.resolved.length === 0, "resolve was not called");
    assert(
      stub.recoveryCalls.length === 0,
      "recovery notifier is NOT called when nothing recovered",
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 13: Recovery when version drops below the minimum sample count.
  // An open alert for a version that now has too few samples should also
  // be auto-resolved (no longer evaluable, feed should not stay cluttered).
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n13. Recovery when regressed version drops below min-sample threshold");
  {
    const openAlert: AIAlert = {
      id: 77,
      alert_type: "prompt_regression",
      severity: "medium",
      title: "Prompt regression: TestAgent v2",
      description: "...",
      status: "acknowledged",
      related_record_id: "TestAgent:v2",
    };
    const stub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 90, total_feedback: 20, thumbs_up: 18, thumbs_down: 2 }),
        makeRow({ prompt_version: "v2", feedback_rate_pct: 0,  total_feedback: 1,  thumbs_up: 0,  thumbs_down: 1 }),
      ],
      openAlerts: [openAlert],
    });
    const out = await runPromptRegressionCheck(stub.deps);
    assert(out.alertsCreated === 0, "tiny-sample version creates no new alert");
    assert(out.alertsAutoResolved === 1, "alert auto-resolved (version lost enough samples)");
    assert(stub.resolved[0].id === 77, `resolved alert id is 77 (got ${stub.resolved[0]?.id})`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 14: Multiple open alerts — only recovered ones are resolved, live
  // breaches remain open.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n14. Selective recovery — only recovered alerts are resolved");
  {
    const openAlerts: AIAlert[] = [
      {
        id: 10,
        alert_type: "prompt_regression",
        severity: "high",
        title: "",
        description: "",
        status: "open",
        related_record_id: "TestAgent:v2",
      },
      {
        id: 11,
        alert_type: "prompt_regression",
        severity: "critical",
        title: "",
        description: "",
        status: "open",
        related_record_id: "TestAgent:v3",
      },
    ];
    const stub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 90, total_feedback: 20, thumbs_up: 18, thumbs_down: 2 }),
        makeRow({ prompt_version: "v2", feedback_rate_pct: 85, total_feedback: 20, thumbs_up: 17, thumbs_down: 3 }),
        makeRow({ prompt_version: "v3", feedback_rate_pct: 55, total_feedback: 20, thumbs_up: 11, thumbs_down: 9 }),
      ],
      existingKeys: new Set(["TestAgent:v3"]),
      openAlerts,
    });
    const out = await runPromptRegressionCheck(stub.deps);
    assert(out.alertsAutoResolved === 1, "only v2 (recovered) is auto-resolved");
    assert(
      stub.resolved.length === 1 && stub.resolved[0].id === 10,
      "only alert 10 (v2) resolved, alert 11 (v3) left open",
    );
    assert(out.alertsCreated === 0, "v3 alert already exists — not duplicated");
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 15: Recovery notifier batches multiple recoveries in a single
  // call so admins get one summary on ChatProvider/email per cron tick instead
  // of N pages.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n15. Recovery notifier batches multiple recoveries into one call");
  {
    const openAlerts: AIAlert[] = [
      {
        id: 201,
        alert_type: "prompt_regression",
        severity: "high",
        title: "",
        description: "",
        status: "open",
        related_record_id: "Alpha:v2",
      },
      {
        id: 202,
        alert_type: "prompt_regression",
        severity: "medium",
        title: "",
        description: "",
        status: "acknowledged",
        related_record_id: "Beta:v9",
      },
    ];
    const stub = makeStub({
      rows: [
        // Alpha v1/v2 within 5pp → v2 recovered.
        makeRow({ agent_name: "Alpha", prompt_version: "v1", feedback_rate_pct: 90, total_feedback: 20, thumbs_up: 18, thumbs_down: 2 }),
        makeRow({ agent_name: "Alpha", prompt_version: "v2", feedback_rate_pct: 88, total_feedback: 20, thumbs_up: 18, thumbs_down: 2 }),
        // Beta v9 only has 2 samples now → no longer evaluable → recovered.
        makeRow({ agent_name: "Beta",  prompt_version: "v8", feedback_rate_pct: 95, total_feedback: 30, thumbs_up: 29, thumbs_down: 1 }),
        makeRow({ agent_name: "Beta",  prompt_version: "v9", feedback_rate_pct: 0,  total_feedback: 2,  thumbs_up: 0,  thumbs_down: 2 }),
      ],
      openAlerts,
    });
    const out = await runPromptRegressionCheck(stub.deps);
    assert(out.alertsAutoResolved === 2, "both alerts auto-resolved");
    assert(
      stub.recoveryCalls.length === 1,
      `notifier called exactly once per cron tick (got ${stub.recoveryCalls.length})`,
    );
    const batch = stub.recoveryCalls[0];
    assert(batch.length === 2, `batch contains both recoveries (got ${batch.length})`);
    const ids = batch.map((r) => r.alert_id).sort((a, b) => a - b);
    assert(
      ids[0] === 201 && ids[1] === 202,
      `batch carries alert ids 201,202 (got ${ids.join(",")})`,
    );
    const alpha = batch.find((r) => r.alert_id === 201)!;
    assert(alpha.agent_name === "Alpha", `alpha agent parsed (got "${alpha.agent_name}")`);
    assert(alpha.prompt_version === "v2", `alpha version parsed (got "${alpha.prompt_version}")`);
    const beta = batch.find((r) => r.alert_id === 202)!;
    assert(beta.agent_name === "Beta", `beta agent parsed (got "${beta.agent_name}")`);
    assert(beta.prompt_version === "v9", `beta version parsed (got "${beta.prompt_version}")`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 16: Recovery notifier is best-effort. If the dep throws, the
  // helper still returns the recoveries it processed and reports them
  // in `alertsAutoResolved` — the alert is already resolved in the DB.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n16. Recovery notifier failure does not crash the cron");
  {
    const openAlert: AIAlert = {
      id: 301,
      alert_type: "prompt_regression",
      severity: "high",
      title: "",
      description: "",
      status: "open",
      related_record_id: "TestAgent:v2",
    };
    const stub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 90, total_feedback: 20, thumbs_up: 18, thumbs_down: 2 }),
        makeRow({ prompt_version: "v2", feedback_rate_pct: 88, total_feedback: 20, thumbs_up: 18, thumbs_down: 2 }),
      ],
      openAlerts: [openAlert],
    });
    const out = await runPromptRegressionCheck({
      ...stub.deps,
      notifyRecovery: async () => {
        throw new Error("simulated ChatProvider outage");
      },
    });
    assert(out.alertsAutoResolved === 1, "alert still reported as auto-resolved");
    assert(stub.resolved.length === 1, "DB resolve was still called");
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 17 (Task #331): "Last seen X days ago" clause renders sensible
  // wording for the day=0, day=1, and missing-timestamp edge cases. These
  // are the three branches `formatLastSeenClause` handles, and the alert
  // description is the only place the on-call reviewer sees them — getting
  // the phrasing wrong (e.g. "−1 days ago" or "0 days ago") would be
  // visible in the live alerts feed.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n17. last-seen clause covers day=0, day=1 and missing timestamp");
  {
    // Same-day usage → "Last seen today."
    const todayStub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 95, total_feedback: 30, thumbs_up: 28, thumbs_down: 2 }),
        makeRow({
          prompt_version: "v2",
          feedback_rate_pct: 70,
          total_feedback: 20,
          thumbs_up: 14,
          thumbs_down: 6,
          // 30 minutes before FIXED_NOW — still the same UTC day.
          last_seen_at: "2026-04-25T11:30:00Z",
        }),
      ],
    });
    const todayOut = await runPromptRegressionCheck(todayStub.deps);
    assert(todayOut.alertsCreated === 1, "today: 1 alert created");
    assert(
      todayStub.created[0].description.includes("Last seen today."),
      `today: description renders "Last seen today." (got: "${todayStub.created[0].description}")`,
    );
    assert(
      todayOut.breaches[0].regressed_last_seen_days_ago === 0,
      `today: breach.regressed_last_seen_days_ago === 0 (got ${todayOut.breaches[0].regressed_last_seen_days_ago})`,
    );

    // Exactly one day old → "Last seen 1 day ago." (singular, not "1 days").
    const yesterdayStub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 95, total_feedback: 30, thumbs_up: 28, thumbs_down: 2 }),
        makeRow({
          prompt_version: "v2",
          feedback_rate_pct: 70,
          total_feedback: 20,
          thumbs_up: 14,
          thumbs_down: 6,
          last_seen_at: "2026-04-24T12:00:00Z",
        }),
      ],
    });
    const yesterdayOut = await runPromptRegressionCheck(yesterdayStub.deps);
    assert(yesterdayOut.alertsCreated === 1, "yesterday: 1 alert created");
    assert(
      yesterdayStub.created[0].description.includes("Last seen 1 day ago."),
      `yesterday: singular phrasing (got: "${yesterdayStub.created[0].description}")`,
    );
    assert(
      !yesterdayStub.created[0].description.includes("1 days ago"),
      "yesterday: never says \"1 days ago\" (plural would be wrong)",
    );

    // Missing/empty last_seen_at → "Last seen: unknown..."
    const unknownStub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 95, total_feedback: 30, thumbs_up: 28, thumbs_down: 2 }),
        makeRow({
          prompt_version: "v2",
          feedback_rate_pct: 70,
          total_feedback: 20,
          thumbs_up: 14,
          thumbs_down: 6,
          last_seen_at: "",
        }),
      ],
    });
    const unknownOut = await runPromptRegressionCheck(unknownStub.deps);
    assert(unknownOut.alertsCreated === 1, "unknown: 1 alert created");
    assert(
      unknownStub.created[0].description.includes("Last seen: unknown"),
      `unknown: description falls back to "Last seen: unknown ..." (got: "${unknownStub.created[0].description}")`,
    );
    assert(
      unknownOut.breaches[0].regressed_last_seen_days_ago === null,
      "unknown: breach.regressed_last_seen_days_ago is null when ts missing",
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 18 (Task #331): the "(unknown)" prompt version bucket — which
  // can be the regressed version even though it's never the baseline —
  // must still get a last-seen clause attached. This guards against the
  // refactor accidentally short-circuiting the clause for legacy traffic.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n18. last-seen clause attaches to (unknown)-version regressions too");
  {
    // Two known versions are required so the (unknown) bucket can be
    // compared against the best baseline (the cron rejects (unknown) as
    // a baseline candidate, so we need v1 + v2 to clear the
    // `eligibleForBaseline.length >= 2` gate before the (unknown) bucket
    // can be reported as a regressed version).
    const stub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 95, total_feedback: 30, thumbs_up: 28, thumbs_down: 2 }),
        makeRow({ prompt_version: "v2", feedback_rate_pct: 92, total_feedback: 30, thumbs_up: 28, thumbs_down: 2 }),
        makeRow({
          prompt_version: "(unknown)",
          feedback_rate_pct: 60,
          total_feedback: 20,
          thumbs_up: 12,
          thumbs_down: 8,
          last_seen_at: "2026-04-23T12:00:00Z", // 2 days before FIXED_NOW
        }),
      ],
    });
    const out = await runPromptRegressionCheck(stub.deps);
    assert(out.alertsCreated === 1, "1 alert for the (unknown) regression");
    assert(
      stub.created[0].relatedRecordId === "TestAgent:(unknown)",
      `alert is for TestAgent:(unknown) (got "${stub.created[0].relatedRecordId}")`,
    );
    assert(
      stub.created[0].description.includes("Last seen 2 days ago."),
      `description carries 2-day clause for the (unknown) bucket (got: "${stub.created[0].description}")`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Notification fan-out tests (Task #247)
  //
  // The next four cases exercise the breach-side ChatProvider + email fan-out
  // (`sendPromptRegressionNotifications`). The recovery-side fan-out is
  // already covered by Cases 15–16 via the `notifyRecovery` dep. Here we:
  //
  //   • Stub `fetch` (ChatProvider) and `sendEmail` (EmailProvider) on the helper's
  //     injected deps so no real network or email goes out from CI.
  //   • Set `ChatProvider_WEBHOOK_URL` and `AI_PROMPT_REGRESSION_ALERT_EMAIL`
  //     so the helper's per-channel guards open. Every block restores
  //     the previous values in a finally so the test file stays
  //     idempotent regardless of which env was set when CI invoked it.
  //   • Verify the contract from the task: both channels fire on a new
  //     alert, neither fires when every alert was a duplicate, and a
  //     failure on one channel never silences the other.
  // ──────────────────────────────────────────────────────────────────────

  function withRegressionEnv<T>(
    fn: () => Promise<T>,
    overrides: { ChatProvider?: string | null; email?: string | null } = {},
  ): Promise<T> {
    const prevChatProvider = process.env.ChatProvider_WEBHOOK_URL;
    const prevEmail = process.env.AI_PROMPT_REGRESSION_ALERT_EMAIL;
    if (overrides.ChatProvider === null) {
      delete process.env.ChatProvider_WEBHOOK_URL;
    } else {
      process.env.ChatProvider_WEBHOOK_URL =
        overrides.ChatProvider ?? "<REDACTED_URL>";
    }
    if (overrides.email === null) {
      delete process.env.AI_PROMPT_REGRESSION_ALERT_EMAIL;
    } else {
      process.env.AI_PROMPT_REGRESSION_ALERT_EMAIL =
        overrides.email ?? "user@example.invalid";
    }
    return fn().finally(() => {
      if (prevChatProvider === undefined) delete process.env.ChatProvider_WEBHOOK_URL;
      else process.env.ChatProvider_WEBHOOK_URL = prevChatProvider;
      if (prevEmail === undefined) {
        delete process.env.AI_PROMPT_REGRESSION_ALERT_EMAIL;
      } else {
        process.env.AI_PROMPT_REGRESSION_ALERT_EMAIL = prevEmail;
      }
    });
  }

  function makeBreach(over: Partial<RegressionBreach> = {}): RegressionBreach {
    return {
      agent_name: "TestAgent",
      regressed_version: "v2",
      best_version: "v1",
      regressed_rate_pct: 70,
      best_rate_pct: 90,
      drop_pp: 20,
      regressed_feedback_count: 20,
      best_feedback_count: 20,
      severity: "high",
      regressed_last_seen_at: "2026-04-20T12:00:00Z",
      regressed_last_seen_days_ago: 5,
      ...over,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 19 (Task #247): ChatProvider + email each fire exactly once when the
  // cron creates a new alert. Stubs both channels at the dep level so
  // the assertions live or die on the actual fan-out path executed by
  // production code, not on a parallel codepath in the test.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n19. ChatProvider and email each fire once when an alert is created");
  await withRegressionEnv(async () => {
    const fetchCalls: Array<{ url: string; body: string }> = [];
    const emailCalls: Array<{
      to: string | string[];
      subject: string;
      html?: string;
    }> = [];
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({
        url: String(url),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const sendEmailStub = async (opts: {
      to: string | string[];
      subject: string;
      html?: string;
      text?: string;
    }) => {
      emailCalls.push(opts);
      return { success: true };
    };

    const stub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 92, total_feedback: 25, thumbs_up: 23, thumbs_down: 2 }),
        makeRow({ prompt_version: "v2", feedback_rate_pct: 60, total_feedback: 20, thumbs_up: 12, thumbs_down: 8 }),
      ],
    });
    const out = await runPromptRegressionCheck({
      ...stub.deps,
      notifyBreaches: (breaches) =>
        sendPromptRegressionNotifications(breaches, {
          fetchFn: fetchStub,
          sendEmail: sendEmailStub,
          // Bypass the per-(agent, version) cooldown introduced by Task
          // #754 — this case asserts the happy-path ChatProvider/email fan-out
          // and runs against a test DB with no notification ledger row.
          claimDb: async () => true,
        }),
    });

    assert(out.alertsCreated === 1, "1 alert created (precondition for fan-out)");
    assert(fetchCalls.length === 1, `ChatProvider fetch called once (got ${fetchCalls.length})`);
    assert(
      fetchCalls[0]?.url === process.env.ChatProvider_WEBHOOK_URL,
      `ChatProvider POST targets the configured webhook (got "${fetchCalls[0]?.url}")`,
    );
    assert(
      fetchCalls[0]?.body.includes("TestAgent") &&
        fetchCalls[0]?.body.includes("v2"),
      "ChatProvider body names the agent and the regressed version",
    );
    assert(emailCalls.length === 1, `Email sent once (got ${emailCalls.length})`);
    const emailTo = emailCalls[0]?.to;
    const recipients = Array.isArray(emailTo) ? emailTo : [emailTo];
    assert(
      recipients.includes("user@example.invalid"),
      `Email targets the configured recipient (got ${JSON.stringify(emailTo)})`,
    );
    assert(
      typeof emailCalls[0]?.subject === "string" &&
        emailCalls[0]!.subject.includes("Prompt Regression"),
      `Email subject mentions the regression (got "${emailCalls[0]?.subject}")`,
    );
    assert(
      (emailCalls[0]?.html ?? "").includes("TestAgent") &&
        (emailCalls[0]?.html ?? "").includes("v2"),
      "Email HTML body includes the agent + regressed version",
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 20 (Task #247): when every breach is a dedupe-skip, neither
  // channel must fire. This protects against re-paging on every cron
  // tick while a still-open regression is being investigated — the
  // exact concern called out in the cron's preamble comment.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n20. Neither channel fires when all alerts are dedupe-skipped");
  await withRegressionEnv(async () => {
    let fetchCalls = 0;
    let emailCalls = 0;
    let notifyBreachesCalls = 0;
    const fetchStub = (async () => {
      fetchCalls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const sendEmailStub = async () => {
      emailCalls++;
      return { success: true };
    };

    const stub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 92, total_feedback: 25, thumbs_up: 23, thumbs_down: 2 }),
        makeRow({ prompt_version: "v2", feedback_rate_pct: 60, total_feedback: 20, thumbs_up: 12, thumbs_down: 8 }),
      ],
      // Pre-existing open alert for the only regressed key — runPromptRegressionCheck
      // must classify it as a duplicate skip and never invoke the breach notifier.
      existingKeys: new Set(["TestAgent:v2"]),
    });
    const out = await runPromptRegressionCheck({
      ...stub.deps,
      notifyBreaches: async (breaches) => {
        notifyBreachesCalls++;
        await sendPromptRegressionNotifications(breaches, {
          fetchFn: fetchStub,
          sendEmail: sendEmailStub,
        });
      },
    });

    assert(out.alertsCreated === 0, "no new alerts when all are duplicates");
    assert(out.alertsSkippedDuplicate === 1, "the one breach was skipped as a duplicate");
    assert(out.breaches.length === 0, "out.breaches stays empty on the dedupe path");
    assert(
      notifyBreachesCalls === 0,
      `breach notifier dep is not invoked at all (got ${notifyBreachesCalls})`,
    );
    assert(fetchCalls === 0, `ChatProvider fetch never fires (got ${fetchCalls})`);
    assert(emailCalls === 0, `Email never fires (got ${emailCalls})`);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 21 (Task #247): a ChatProvider outage must not silence the email
  // channel. The cron explicitly catches each channel independently so
  // ops still get the email summary even when the ChatProvider webhook is
  // returning 5xx or refusing connections.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n21. ChatProvider failure does not prevent the email from being attempted");
  await withRegressionEnv(async () => {
    let emailCalls = 0;
    const fetchStub = (async () => {
      throw new Error("simulated ChatProvider 503");
    }) as typeof fetch;
    const sendEmailStub = async () => {
      emailCalls++;
      return { success: true };
    };

    await sendPromptRegressionNotifications([makeBreach()], {
      fetchFn: fetchStub,
      sendEmail: sendEmailStub,
      // Skip the cooldown gate (Task #754) for this isolation test —
      // we're asserting ChatProvider-failure does not silence email, not the
      // throttle behaviour (separately covered by case 27/28).
      claimDb: async () => true,
    });

    assert(emailCalls === 1, `Email was still attempted (got ${emailCalls})`);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 22 (Task #247): symmetrically — if EmailProvider (email) throws, the
  // ChatProvider post must already have happened. The ChatProvider block runs first
  // and is wrapped in its own try/catch, so an email failure cannot
  // retroactively cancel the ChatProvider notification.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n22. Email failure does not prevent the ChatProvider post");
  await withRegressionEnv(async () => {
    let fetchCalls = 0;
    const fetchStub = (async () => {
      fetchCalls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const sendEmailStub = async () => {
      throw new Error("simulated EmailProvider 500");
    };

    await sendPromptRegressionNotifications([makeBreach()], {
      fetchFn: fetchStub,
      sendEmail: sendEmailStub,
      // Skip the cooldown gate (Task #754) for this isolation test —
      // we're asserting email-failure does not silence ChatProvider, not the
      // throttle behaviour (separately covered by case 27/28).
      claimDb: async () => true,
    });

    assert(fetchCalls === 1, `ChatProvider fetch was still attempted (got ${fetchCalls})`);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Recovery-side notification fan-out (Task #640).
  //
  // Mirrors cases 19, 21 and 22 above but exercises
  // `sendPromptRegressionRecoveryNotifications` — the symmetric helper
  // called via the `notifyRecovery` dep when the recovery sweep
  // auto-resolves ≥1 prompt-regression alert. Until #640 the recovery
  // helper was only checked at the dep boundary (cases 11 / 14 verify
  // `notifyRecovery` *is invoked*), so a regression in the recovery
  // wording, recipient parsing, or per-channel error handling would not
  // have been caught.
  // ────────────────────────────────────────────────────────────────────────

  function makeRecovery(over: Partial<RegressionRecovery> = {}): RegressionRecovery {
    return {
      alert_id: 42,
      related_record_id: "TestAgent:v2",
      agent_name: "TestAgent",
      prompt_version: "v2",
      note: "auto-resolved: prompt regression for \"TestAgent:v2\" is no longer detected.",
      ...over,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 23 (Task #640): ChatProvider + email each fire exactly once when an
  // open prompt-regression alert auto-resolves. Drives the recovery
  // path end-to-end through `runPromptRegressionCheck` so the
  // assertions live or die on the production wiring (cron → recovery
  // sweep → `notifyRecovery` → `sendPromptRegressionRecoveryNotifications`),
  // not on a parallel codepath in the test.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n23. Recovery — ChatProvider and email each fire once when an alert auto-resolves");
  await withRegressionEnv(async () => {
    const fetchCalls: Array<{ url: string; body: string }> = [];
    const emailCalls: Array<{
      to: string | string[];
      subject: string;
      html?: string;
    }> = [];
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({
        url: String(url),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const sendEmailStub = async (opts: {
      to: string | string[];
      subject: string;
      html?: string;
      text?: string;
    }) => {
      emailCalls.push(opts);
      return { success: true };
    };

    const openAlert: AIAlert = {
      id: 42,
      alert_type: "prompt_regression",
      severity: "high",
      title: "Prompt regression: TestAgent v2",
      description: "...",
      status: "open",
      related_record_id: "TestAgent:v2",
    };
    // Two versions of the same agent within 5pp of each other → no new
    // breach is opened, but the previously-open alert for v2 is below
    // threshold now and must auto-resolve.
    const stub = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: 90, total_feedback: 20, thumbs_up: 18, thumbs_down: 2 }),
        makeRow({ prompt_version: "v2", feedback_rate_pct: 85, total_feedback: 20, thumbs_up: 17, thumbs_down: 3 }),
      ],
      openAlerts: [openAlert],
    });
    const out = await runPromptRegressionCheck({
      ...stub.deps,
      notifyRecovery: (recoveries) =>
        sendPromptRegressionRecoveryNotifications(recoveries, {
          fetchFn: fetchStub,
          sendEmail: sendEmailStub,
        }),
    });

    assert(out.alertsAutoResolved === 1, "1 alert auto-resolved (precondition for fan-out)");
    assert(fetchCalls.length === 1, `ChatProvider fetch called once (got ${fetchCalls.length})`);
    assert(
      fetchCalls[0]?.url === process.env.ChatProvider_WEBHOOK_URL,
      `ChatProvider POST targets the configured webhook (got "${fetchCalls[0]?.url}")`,
    );
    assert(
      fetchCalls[0]?.body.includes("Recovered") &&
        fetchCalls[0]?.body.includes("TestAgent") &&
        fetchCalls[0]?.body.includes("v2") &&
        fetchCalls[0]?.body.includes("#42"),
      "ChatProvider body announces a recovery and names the agent, version and alert id",
    );
    assert(emailCalls.length === 1, `Recovery email sent once (got ${emailCalls.length})`);
    const emailTo = emailCalls[0]?.to;
    const recipients = Array.isArray(emailTo) ? emailTo : [emailTo];
    assert(
      recipients.includes("user@example.invalid"),
      `Recovery email targets the configured recipient (got ${JSON.stringify(emailTo)})`,
    );
    assert(
      typeof emailCalls[0]?.subject === "string" &&
        emailCalls[0]!.subject.includes("Recovered"),
      `Recovery email subject mentions the recovery (got "${emailCalls[0]?.subject}")`,
    );
    assert(
      (emailCalls[0]?.html ?? "").includes("TestAgent") &&
        (emailCalls[0]?.html ?? "").includes("v2") &&
        (emailCalls[0]?.html ?? "").includes("#42"),
      "Recovery email HTML body includes the agent, recovered version, and alert id",
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 24 (Task #640): a ChatProvider outage on the recovery path must not
  // silence the recovery email. Mirrors case 21 on the breach side —
  // each channel is wrapped in its own try/catch so ops still get the
  // recovery email even when the ChatProvider webhook is returning 5xx.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n24. Recovery — ChatProvider failure does not prevent the email from being attempted");
  await withRegressionEnv(async () => {
    let emailCalls = 0;
    const fetchStub = (async () => {
      throw new Error("simulated ChatProvider 503");
    }) as typeof fetch;
    const sendEmailStub = async () => {
      emailCalls++;
      return { success: true };
    };

    await sendPromptRegressionRecoveryNotifications([makeRecovery()], {
      fetchFn: fetchStub,
      sendEmail: sendEmailStub,
    });

    assert(emailCalls === 1, `Recovery email was still attempted (got ${emailCalls})`);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 25 (Task #640): symmetrically — if EmailProvider (email) throws on the
  // recovery path, the ChatProvider post must already have happened. Mirrors
  // case 22 on the breach side.
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n25. Recovery — email failure does not prevent the ChatProvider post");
  await withRegressionEnv(async () => {
    let fetchCalls = 0;
    const fetchStub = (async () => {
      fetchCalls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const sendEmailStub = async () => {
      throw new Error("simulated EmailProvider 500");
    };

    await sendPromptRegressionRecoveryNotifications([makeRecovery()], {
      fetchFn: fetchStub,
      sendEmail: sendEmailStub,
    });

    assert(fetchCalls === 1, `Recovery ChatProvider fetch was still attempted (got ${fetchCalls})`);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Admin-tunable thresholds (Task #754).
  //
  // The cron used to read its sensitivity exclusively from env vars, so the
  // only way to relax/tighten alerting was a redeploy. #754 added a DB-
  // backed override row that's edited from the AI-Ops dashboard and merged
  // in at runtime via the `loadOverrides` dep. The case below proves that
  // a smaller `dropPctPoints` from the DB:
  //   • flows through the full check (not just the merge helper), and
  //   • flips a previously-quiet two-version pair into an actual alert.
  // We pick a delta that's BELOW the env baseline but ABOVE the override
  // so the env path emits 0 alerts and the override path emits 1 — making
  // the assertion immune to drift in the env baseline value itself.
  // ────────────────────────────────────────────────────────────────────────
  console.log(
    "\n26. Admin override from loadOverrides() lowers the drop threshold and opens an alert env baseline would have skipped",
  );
  await withRegressionEnv(async () => {
    const baseline = PROMPT_REGRESSION_ENV_BASELINE.dropPctPoints;
    const overrideDrop = Math.max(
      PROMPT_REGRESSION_BOUNDS.dropPctPoints.min,
      baseline - 5,
    );
    // Pick a measured drop strictly between override and baseline so the
    // sole observable difference is which threshold is in effect.
    const measuredDrop = (baseline + overrideDrop) / 2;
    assert(
      measuredDrop < baseline && measuredDrop > overrideDrop,
      `precondition: measured drop ${measuredDrop} sits strictly between override ${overrideDrop} and baseline ${baseline}`,
    );

    const bestRate = 95;
    const regressedRate = bestRate - measuredDrop;

    // Run #1: NO override → env baseline applies → no alert.
    const stubBaseline = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: bestRate, total_feedback: 25, thumbs_up: 24, thumbs_down: 1 }),
        makeRow({ prompt_version: "v2", feedback_rate_pct: regressedRate, total_feedback: 25, thumbs_up: Math.round((regressedRate / 100) * 25), thumbs_down: 25 - Math.round((regressedRate / 100) * 25) }),
      ],
    });
    const baselineOut = await runPromptRegressionCheck({
      ...stubBaseline.deps,
      loadOverrides: async () => ({}),
      // Skip ChatProvider/email side-effects entirely — only the alert-create
      // path is under test here.
      notifyBreaches: async () => {},
    });
    assert(
      baselineOut.alertsCreated === 0,
      `with empty overrides the env baseline (${baseline} pp) keeps the cron quiet (got ${baselineOut.alertsCreated})`,
    );
    assert(
      baselineOut.breaches.length === 0,
      "no breach surfaces when the measured drop is below the env baseline",
    );

    // Run #2: DB override → smaller threshold applies → 1 alert.
    const stubOverride = makeStub({
      rows: [
        makeRow({ prompt_version: "v1", feedback_rate_pct: bestRate, total_feedback: 25, thumbs_up: 24, thumbs_down: 1 }),
        makeRow({ prompt_version: "v2", feedback_rate_pct: regressedRate, total_feedback: 25, thumbs_up: Math.round((regressedRate / 100) * 25), thumbs_down: 25 - Math.round((regressedRate / 100) * 25) }),
      ],
    });
    const overrideOut = await runPromptRegressionCheck({
      ...stubOverride.deps,
      loadOverrides: async () => ({ dropPctPoints: overrideDrop }),
      notifyBreaches: async () => {},
    });
    assert(
      overrideOut.alertsCreated === 1,
      `with dropPctPoints override ${overrideDrop} pp the same data triggers 1 alert (got ${overrideOut.alertsCreated})`,
    );
    assert(
      overrideOut.breaches.length === 1 &&
        overrideOut.breaches[0]?.regressed_version === "v2",
      "the override-induced breach correctly flags v2 as the regressed version",
    );

    // And confirm the merge helper itself folds the override into the
    // shape the rest of the cron consumes. Guards against future
    // refactors that bypass mergePromptRegressionOverrides.
    const merged = mergePromptRegressionOverrides({ dropPctPoints: overrideDrop });
    assert(
      merged.dropPctPoints === overrideDrop,
      `mergePromptRegressionOverrides honours the DB override (got ${merged.dropPctPoints})`,
    );
    assert(
      merged.minFeedback === PROMPT_REGRESSION_ENV_BASELINE.minFeedback &&
        merged.windowDays === PROMPT_REGRESSION_ENV_BASELINE.windowDays &&
        merged.notifyThrottleMin === PROMPT_REGRESSION_ENV_BASELINE.notifyThrottleMin,
      "untouched fields fall through to the env baseline (no accidental wipe)",
    );
  });

  // ────────────────────────────────────────────────────────────────────────
  // Notification cooldown via tool_health_notifications (Task #754).
  //
  // The breach notifier now takes a `claimDb` dep that mirrors the tool-
  // health alerter's per-key throttle. When the DB returns `false` for a
  // given `(agent, version)` key the breach must NOT reach ChatProvider or email
  // this cycle — even though `runPromptRegressionCheck` already opened an
  // AIAlert row. This case feeds two breaches, lets only one through the
  // throttle, and asserts:
  //   • the throttle key shape is `prompt_regression:<agent>:<version>`,
  //   • the throttle is consulted exactly once per breach,
  //   • only the sendable breach is surfaced in the ChatProvider body and the
  //     single email summary (i.e. throttled breaches are filtered, not
  //     just dimmed),
  //   • the configured `notifyThrottleMin` is forwarded as the cooldown
  //     window so the DB-side TTL matches the admin's setting.
  // ────────────────────────────────────────────────────────────────────────
  console.log(
    "\n27. Throttle gate via claimDb filters breaches and forwards the configured cooldown",
  );
  await withRegressionEnv(async () => {
    const claimCalls: Array<{ key: string; nowMs: number; ttlMs: number }> = [];
    // Seed: first key (TestAgent:v2) is fresh → claim succeeds. Second
    // key (OtherAgent:v9) is still cooling down → claim returns false.
    const claimDbStub = async (key: string, nowMs: number, ttlMs: number) => {
      claimCalls.push({ key, nowMs, ttlMs });
      return key === "prompt_regression:TestAgent:v2";
    };
    const fetchCalls: Array<{ url: string; body: string }> = [];
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({
        url: String(url),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const emailCalls: Array<{ to: string | string[]; subject: string; html?: string }> = [];
    const sendEmailStub = async (opts: {
      to: string | string[];
      subject: string;
      html?: string;
      text?: string;
    }) => {
      emailCalls.push(opts);
      return { success: true };
    };

    const cfg = {
      ...PROMPT_REGRESSION_DEFAULTS,
      notifyThrottleMin: 17, // distinctive value to assert TTL forwarding
    };

    await sendPromptRegressionNotifications(
      [
        makeBreach({ agent_name: "TestAgent", regressed_version: "v2" }),
        makeBreach({ agent_name: "OtherAgent", regressed_version: "v9" }),
      ],
      {
        fetchFn: fetchStub,
        sendEmail: sendEmailStub,
        claimDb: claimDbStub,
        effectiveConfig: cfg,
      },
    );

    // 1. Throttle is consulted once per breach with the documented key shape.
    assert(
      claimCalls.length === 2,
      `claimDb called once per breach (got ${claimCalls.length})`,
    );
    const claimedKeys = claimCalls.map((c) => c.key).sort();
    assert(
      claimedKeys[0] === "prompt_regression:OtherAgent:v9" &&
        claimedKeys[1] === "prompt_regression:TestAgent:v2",
      `throttle keys use the prompt_regression:<agent>:<version> shape (got ${JSON.stringify(claimedKeys)})`,
    );

    // 2. The cooldown TTL forwarded to the DB matches notifyThrottleMin
    //    (17 minutes → 17 * 60_000 ms). This is the contract the dashboard
    //    promises operators when they tune the slider.
    const expectedTtlMs = cfg.notifyThrottleMin * 60_000;
    assert(
      claimCalls.every((c) => c.ttlMs === expectedTtlMs),
      `claimDb is called with TTL ${expectedTtlMs} ms (got ${JSON.stringify(claimCalls.map((c) => c.ttlMs))})`,
    );

    // 3. ChatProvider fires once and the body mentions only the un-throttled
    //    breach. The throttled one must not leak into the channel — that
    //    would defeat the cooldown entirely.
    assert(
      fetchCalls.length === 1,
      `ChatProvider POST happens exactly once for the sendable subset (got ${fetchCalls.length})`,
    );
    assert(
      fetchCalls[0]!.body.includes("TestAgent") &&
        fetchCalls[0]!.body.includes("v2"),
      "ChatProvider body names the un-throttled (TestAgent / v2) breach",
    );
    assert(
      !fetchCalls[0]!.body.includes("OtherAgent") &&
        !fetchCalls[0]!.body.includes("v9"),
      "ChatProvider body omits the throttled (OtherAgent / v9) breach",
    );

    // 4. Email behaves the same — throttled breach absent from the HTML body.
    assert(
      emailCalls.length === 1,
      `Email summary sent exactly once (got ${emailCalls.length})`,
    );
    const html = emailCalls[0]?.html ?? "";
    assert(
      html.includes("TestAgent") && html.includes("v2"),
      "Email HTML body names the un-throttled breach",
    );
    assert(
      !html.includes("OtherAgent") && !html.includes("v9"),
      "Email HTML body omits the throttled breach",
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // Throttle bypass — when an admin sets notifyThrottleMin to 0 from the
  // dashboard the cron must skip claimDb entirely and fan-out every
  // breach. This is the documented "disable the cooldown" affordance, so
  // a future refactor that always calls claimDb (e.g. with a 0-ms TTL)
  // would silently fail open and would NOT be caught by case 27. This
  // case nails that contract by failing if claimDb is touched at all.
  // ──────────────────────────────────────────────────────────────────────
  console.log(
    "\n28. notifyThrottleMin=0 disables the throttle entirely and every breach fans out",
  );
  await withRegressionEnv(async () => {
    let claimCalls = 0;
    const claimDbStub = async () => {
      claimCalls++;
      return false; // would suppress everything if it were ever called
    };
    let fetchCalls = 0;
    const fetchStub = (async () => {
      fetchCalls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    let emailCalls = 0;
    const sendEmailStub = async () => {
      emailCalls++;
      return { success: true };
    };

    await sendPromptRegressionNotifications(
      [
        makeBreach({ agent_name: "A1", regressed_version: "v1" }),
        makeBreach({ agent_name: "A2", regressed_version: "v2" }),
      ],
      {
        fetchFn: fetchStub,
        sendEmail: sendEmailStub,
        claimDb: claimDbStub,
        effectiveConfig: { ...PROMPT_REGRESSION_DEFAULTS, notifyThrottleMin: 0 },
      },
    );

    assert(
      claimCalls === 0,
      `claimDb is bypassed entirely when cooldown is 0 (got ${claimCalls} calls)`,
    );
    assert(fetchCalls === 1, `ChatProvider still fires (got ${fetchCalls})`);
    assert(emailCalls === 1, `Email still fires (got ${emailCalls})`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
