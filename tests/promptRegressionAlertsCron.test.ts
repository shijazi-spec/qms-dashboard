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
  PROMPT_REGRESSION_THRESHOLDS,
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

function makeStub(opts: {
  rows: PromptVersionAggregate[];
  existingKeys?: Set<string>;
  openAlerts?: AIAlert[];
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
      // Stub the recovery notifier so tests never touch Slack/email or
      // process.env.SLACK_WEBHOOK_URL — mirrors `notifyToolHealthRecovery`
      // dep injection on the tool-health cron.
      notifyRecovery: async (recoveries: CapturedRecoveryNotification[]) => {
        recoveryCalls.push(recoveries);
      },
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
    // The aggregate now echoes the small-sample floor and per-row
    // eligibility flag so the dashboard can hide best/regression badges
    // for brand-new versions. Default to "comparable" here so existing
    // cron tests keep their semantics; tests that want to exercise the
    // small-sample path can override these in `over`.
    min_feedback: 5,
    meets_min_feedback: true,
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
    const breach = out.breaches[0];
    assert(
      breach.regressed_version === "v2" && breach.best_version === "v1",
      "breach record points at v2 regressed vs v1 best",
    );
    assert(
      Math.abs(breach.drop_pp - 20) < 0.001,
      `drop_pp is ~20 (got ${breach.drop_pp})`,
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
  // call so admins get one summary on Slack/email per cron tick instead
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
        throw new Error("simulated Slack outage");
      },
    });
    assert(out.alertsAutoResolved === 1, "alert still reported as auto-resolved");
    assert(stub.resolved.length === 1, "DB resolve was still called");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
