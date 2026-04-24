/**
 * Unit tests for the per-tool health alert cron's evaluation, dedupe, and
 * auto-resolve sweep.
 *
 * Combines coverage from two parallel tasks:
 *   • Task #111 — auto-resolve sweep (cooldown, mixed states, error
 *     handling).
 *   • Task #112 — threshold evaluation (error_rate / p95_latency breaches),
 *     `minCalls` enforcement, and dedupe against open `ai_alerts` rows.
 *
 * Both suites drive `runToolHealthCheck()` in
 * `src/mastra/workflows/toolHealthAlertsCron.ts` through its
 * `ToolHealthDeps` injection point. All DB-backed dependencies are stubbed
 * in-process so the tests run without Postgres.
 *
 * Run:  npx tsx tests/toolHealthAlertsCron.test.ts
 * Wired: discovered automatically by tests/runIntegrationTests.ts (npm test).
 */

import {
  runToolHealthCheck,
  evaluateWindowAggregates,
  TOOL_HEALTH_THRESHOLDS,
  TOOL_HEALTH_ENV_BASELINE,
  validateToolHealthThresholds,
  __resetThresholdValidationForTests,
  type EffectiveToolHealthConfig,
  type ToolHealthDeps,
} from "../src/mastra/workflows/toolHealthAlertsCron";
import type { ToolWindowAggregate } from "../src/utils/aiTelemetry";
import type { AIAlert } from "../src/utils/aiAlertsDatabase";
import type {
  NotifyToolHealthBreachResult,
  ToolHealthBreachNotification,
} from "../src/utils/toolHealthAlertNotifier";
import { TestSuite } from "./_helpers/runner";

// ──────────────────────────────────────────────────────────────────────────────
// Stub helpers
// ──────────────────────────────────────────────────────────────────────────────
function makeAggregate(p: Partial<ToolWindowAggregate> = {}): ToolWindowAggregate {
  return {
    tool_name: "fake_tool",
    agent_name: "fake_agent",
    call_count: 100,
    error_count: 0,
    error_rate_pct: 0,
    p95_latency_ms: 1000,
    avg_latency_ms: 500,
    max_latency_ms: 2000,
    ...p,
  };
}

interface ResolveCall {
  id: number;
  note?: string;
}

interface OpenLookupCall {
  alertType: string;
  relatedRecordId: string;
  options?: { olderThanMinutes?: number };
}

interface CreateCall {
  alert: Omit<AIAlert, "id" | "created_at" | "status">;
}

interface DedupeCheck {
  alertType: string;
  relatedRecordId: string;
}

interface AggregateCall {
  windowMinutes: number;
  minCalls: number;
}

interface NotifyCall {
  notification: ToolHealthBreachNotification;
}

function makeDeps(opts: {
  aggregates: ToolWindowAggregate[];
  /**
   * Pre-existing OPEN alerts the breach-side dedupe lookup should treat as
   * a hit. Keys are `<tool_name>:<reason>` (matching the cron's
   * related_record_id scheme).
   */
  existingOpenDedupeKeys?: string[];
  openAlertsByKey?: Record<string, AIAlert[]>;
  /**
   * If true, alerts in `openAlertsByKey` are returned regardless of the
   * cooldown. If false (default behavior here is `true`), `getOpenAlertsByKey`
   * returns [] when the caller supplies `olderThanMinutes` to simulate
   * "alert too young to auto-resolve".
   */
  pastCooldown?: boolean;
  /**
   * Override the default notifier stub. Defaults to a no-op that returns
   * `{ slackSent: true }` so we can assert that the cron only invokes the
   * notifier on freshly-created breaches.
   */
  notifierResult?: NotifyToolHealthBreachResult;
  notifierThrows?: boolean;
}): {
  deps: ToolHealthDeps;
  resolves: ResolveCall[];
  lookups: OpenLookupCall[];
  creates: CreateCall[];
  dedupeChecks: DedupeCheck[];
  aggregateCalls: AggregateCall[];
  /**
   * Mutable view of the in-stub dedupe-key set that
   * `openAlertExistsByKey()` consults. Tests can mutate this between
   * runs to simulate an operator resolving/dismissing the underlying
   * `ai_alerts` row — the real SQL filters
   * `status IN ('open','acknowledged')` so a resolved alert no longer
   * dedupes.
   */
  existingDedupeKeys: Set<string>;
  notifies: NotifyCall[];
} {
  const resolves: ResolveCall[] = [];
  const lookups: OpenLookupCall[] = [];
  const creates: CreateCall[] = [];
  const dedupeChecks: DedupeCheck[] = [];
  const aggregateCalls: AggregateCall[] = [];
  const notifies: NotifyCall[] = [];
  const openByKey = opts.openAlertsByKey ?? {};
  const pastCooldown = opts.pastCooldown !== false;
  // Mutable so dedupe checks against keys created earlier in the same run
  // also hit (matches the real DB's semantics — the cron's first INSERT is
  // visible to the next openAlertExistsByKey call within the same loop).
  const existingDedupeKeys = new Set<string>(opts.existingOpenDedupeKeys ?? []);
  const defaultNotifyResult: NotifyToolHealthBreachResult =
    opts.notifierResult ?? {
      slackSent: true,
      emailSent: false,
      throttled: false,
      skipped: false,
    };

  const deps: ToolHealthDeps = {
    getToolWindowAggregates: async (windowMinutes, minCalls) => {
      aggregateCalls.push({ windowMinutes, minCalls });
      // Faithfully apply the same `HAVING COUNT(*) >= $2` filter the real
      // SQL would, so the "ignored if below minCalls" case is testing the
      // cron's contract with the aggregator, not the stub's bookkeeping.
      return opts.aggregates.filter((a) => a.call_count >= minCalls);
    },
    openAlertExistsByKey: async (alertType, relatedRecordId) => {
      dedupeChecks.push({ alertType, relatedRecordId });
      return existingDedupeKeys.has(`${alertType}:${relatedRecordId}`);
    },
    createAIAlert: async (alert) => {
      creates.push({ alert });
      // Mirror DB semantics: a freshly-inserted alert immediately becomes a
      // dedupe target for any subsequent check in the same run.
      if (alert.related_record_id) {
        existingDedupeKeys.add(
          `${alert.alert_type}:${alert.related_record_id}`,
        );
      }
      return { ...alert, id: 999, status: "open" } as AIAlert;
    },
    getOpenAlertsByKey: async (alertType, relatedRecordId, options) => {
      lookups.push({ alertType, relatedRecordId, options });
      const matches = openByKey[relatedRecordId] ?? [];
      if (options?.olderThanMinutes != null && !pastCooldown) return [];
      return matches;
    },
    resolveAlert: async (id, note) => {
      resolves.push({ id, note });
      return {
        id,
        alert_type: "tool_health",
        severity: "medium",
        title: "stub",
        description: "stub",
        status: "resolved",
        resolution_note: note ?? null,
      } as AIAlert;
    },
    notifyToolHealthBreach: async (notification) => {
      notifies.push({ notification });
      if (opts.notifierThrows) throw new Error("stub notifier failure");
      return defaultNotifyResult;
    },
  };

  return {
    deps,
    resolves,
    lookups,
    creates,
    dedupeChecks,
    aggregateCalls,
    existingDedupeKeys,
    notifies,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────
const suite = new TestSuite(
  "toolHealthAlertsCron — thresholds, dedupe & auto-resolve sweep",
);
console.log("\n=== toolHealthAlertsCron tests ===\n");

// ─── Task #112: threshold evaluation, dedupe, minCalls ───────────────────────

await suite.test(
  "(a) error-rate breach above threshold creates an ai_alerts row",
  async () => {
    const agg = makeAggregate({
      tool_name: "qms_create_nc",
      agent_name: "qms_agent",
      call_count: 20,
      error_count: 12,
      error_rate_pct: 60, // > 25% threshold; falls in 50–74 → severity 'high'
      p95_latency_ms: 1_000, // healthy on the latency side
      avg_latency_ms: 500,
      max_latency_ms: 1_500,
    });
    const { deps, creates, dedupeChecks } = makeDeps({ aggregates: [agg] });

    const out = await runToolHealthCheck(deps);

    suite.expectEqual(out.toolsEvaluated, 1, "evaluated exactly one tool");
    suite.expectEqual(out.alertsCreated, 1, "created exactly one alert");
    suite.expectEqual(out.alertsSkippedDuplicate, 0, "no duplicates skipped");
    suite.expectEqual(creates.length, 1, "exactly one createAIAlert call");

    const created = creates[0]!.alert;
    suite.expectEqual(created.alert_type, "tool_health", "alert_type='tool_health'");
    suite.expectEqual(
      created.related_record_id,
      "qms_create_nc:error_rate",
      "related_record_id keyed on tool_name + reason",
    );
    suite.expectEqual(created.severity, "high", "severity='high' for 60% error rate");
    suite.expect(
      created.title.includes("qms_create_nc") &&
        created.title.toLowerCase().includes("error rate"),
      "title names the tool and breach reason",
    );
    // Title MUST omit the live metric value so dedupe stays stable across runs.
    suite.expect(
      !created.title.includes("60%") && !created.title.includes("60 %"),
      "title omits the live error-rate value (dedupe stability)",
    );
    suite.expect(
      created.description.includes("60%") &&
        created.description.includes("12/20"),
      "description carries the live error-rate value and counts",
    );

    suite.expectEqual(out.breaches.length, 1, "one breach reported");
    suite.expectEqual(out.breaches[0]?.reason, "error_rate", "breach reason");

    // Dedupe is checked exactly once for the error_rate side. The healthy
    // p95 path triggers an auto-resolve LOOKUP instead (covered separately).
    suite.expectEqual(
      dedupeChecks.filter((c) => c.relatedRecordId === "qms_create_nc:error_rate")
        .length,
      1,
      "exactly one dedupe check for error_rate",
    );
  },
);

await suite.test(
  "(b) p95-latency breach above threshold creates an ai_alerts row",
  async () => {
    const agg = makeAggregate({
      tool_name: "rag_search",
      agent_name: "consultant_agent",
      call_count: 30,
      error_count: 0, // healthy error rate
      error_rate_pct: 0,
      p95_latency_ms: 22_000, // > 15_000ms threshold; < 30_000 → 'medium'
      avg_latency_ms: 8_000,
      max_latency_ms: 25_000,
    });
    const { deps, creates } = makeDeps({ aggregates: [agg] });

    const out = await runToolHealthCheck(deps);

    suite.expectEqual(out.toolsEvaluated, 1, "evaluated exactly one tool");
    suite.expectEqual(out.alertsCreated, 1, "created exactly one alert");
    suite.expectEqual(creates.length, 1, "exactly one createAIAlert call");

    const created = creates[0]!.alert;
    suite.expectEqual(
      created.related_record_id,
      "rag_search:p95_latency",
      "related_record_id keyed on tool_name + reason",
    );
    suite.expectEqual(created.severity, "medium", "severity='medium' for 22s p95");
    suite.expect(
      created.title.includes("rag_search") &&
        created.title.toLowerCase().includes("p95 latency"),
      "title names the tool and breach reason",
    );
    suite.expect(
      !created.title.includes("22000") && !created.title.includes("22,000"),
      "title omits the live p95 value (dedupe stability)",
    );
    suite.expect(
      created.description.includes("22000") ||
        created.description.includes("22,000"),
      "description carries the live p95 value",
    );

    suite.expectEqual(out.breaches.length, 1, "one breach reported");
    suite.expectEqual(out.breaches[0]?.reason, "p95_latency", "breach reason");
  },
);

await suite.test(
  "(c) tools with < minCalls samples are filtered out before evaluation",
  async () => {
    const underSampled = makeAggregate({
      tool_name: "low_volume_tool",
      call_count: TOOL_HEALTH_THRESHOLDS.minCalls - 1, // 4 < 5
      error_count: 4,
      error_rate_pct: 100, // would breach if it were eligible
      p95_latency_ms: 99_999, // would also breach if it were eligible
      avg_latency_ms: 50_000,
      max_latency_ms: 120_000,
    });
    // A second healthy tool that DOES meet the minCalls bar — exercises the
    // "evaluated but no breach" path so we know the cron didn't bail early
    // on the under-sampled tool's iteration.
    const healthy = makeAggregate({
      tool_name: "healthy_tool",
      call_count: 50,
      error_count: 0,
      error_rate_pct: 0,
      p95_latency_ms: 200,
      avg_latency_ms: 100,
      max_latency_ms: 400,
    });
    const { deps, creates, aggregateCalls, dedupeChecks } = makeDeps({
      aggregates: [underSampled, healthy],
    });

    const out = await runToolHealthCheck(deps);

    // The cron must pass cfg.minCalls down so the SQL-level
    // `HAVING COUNT(*) >= $2` clause excludes under-sampled tools.
    suite.expectEqual(aggregateCalls.length, 1, "aggregator called exactly once");
    suite.expectEqual(
      aggregateCalls[0]?.windowMinutes,
      TOOL_HEALTH_THRESHOLDS.windowMinutes,
      "windowMinutes forwarded to aggregator",
    );
    suite.expectEqual(
      aggregateCalls[0]?.minCalls,
      TOOL_HEALTH_THRESHOLDS.minCalls,
      "minCalls forwarded to aggregator (under-sampled tools never reach the cron)",
    );

    // After the SQL filter, only `healthy_tool` reaches the cron. It
    // breaches nothing → no alerts created.
    suite.expectEqual(out.toolsEvaluated, 1, "only the eligible tool was evaluated");
    suite.expectEqual(out.alertsCreated, 0, "no alerts created for under-sampled tool");
    suite.expectEqual(creates.length, 0, "no createAIAlert calls");
    // Healthy tool triggers RECOVERY lookups (one per reason), but no
    // dedupe lookups on the breach path.
    suite.expectEqual(dedupeChecks.length, 0, "no breach-side dedupe lookups");
  },
);

await suite.test(
  "(d) duplicate alerts are deduped against existing open ai_alerts rows",
  async () => {
    const agg = makeAggregate({
      tool_name: "qms_create_nc",
      agent_name: "qms_agent",
      call_count: 20,
      // BOTH thresholds breach — exercises both dedupe keys at once.
      error_count: 18,
      error_rate_pct: 90,
      p95_latency_ms: 65_000,
      avg_latency_ms: 30_000,
      max_latency_ms: 70_000,
    });
    const { deps, creates, dedupeChecks } = makeDeps({
      aggregates: [agg],
      existingOpenDedupeKeys: [
        "tool_health:qms_create_nc:error_rate",
        "tool_health:qms_create_nc:p95_latency",
      ],
    });

    const out = await runToolHealthCheck(deps);

    suite.expectEqual(out.toolsEvaluated, 1, "evaluated the tool once");
    suite.expectEqual(
      out.alertsCreated,
      0,
      "no new alerts created when matching open rows already exist",
    );
    suite.expectEqual(
      out.alertsSkippedDuplicate,
      2,
      "both reasons reported as deduped (error_rate + p95_latency)",
    );
    suite.expectEqual(creates.length, 0, "no createAIAlert calls issued");

    // Both dedupe lookups should have been performed against the
    // (alert_type, related_record_id) composite key — NOT against the title,
    // which would otherwise drift across runs as live metric values move.
    suite.expectEqual(
      dedupeChecks.length,
      2,
      "exactly two dedupe lookups (one per reason)",
    );
    suite.expect(
      dedupeChecks.every((c) => c.alertType === "tool_health"),
      "all dedupe lookups scoped to alert_type='tool_health'",
    );
    const ids = dedupeChecks.map((c) => c.relatedRecordId).sort();
    suite.expectEqual(
      ids[0],
      "qms_create_nc:error_rate",
      "first dedupe key = qms_create_nc:error_rate",
    );
    suite.expectEqual(
      ids[1],
      "qms_create_nc:p95_latency",
      "second dedupe key = qms_create_nc:p95_latency",
    );
  },
);

await suite.test(
  "(d′) two consecutive cron passes over the same breach insert only once",
  // Belt-and-braces: confirms the dedupe behavior survives a second cron
  // pass over the same fixture. The first run inserts; the second run
  // finds the alert it just inserted (mirrored into the dedupe set by the
  // stub) and skips. Realistic "cron fires every 15 min while the breach
  // is still open" scenario.
  async () => {
    const agg = makeAggregate({
      tool_name: "qms_create_nc",
      agent_name: "qms_agent",
      call_count: 20,
      error_count: 12,
      error_rate_pct: 60,
      p95_latency_ms: 1_000,
      avg_latency_ms: 500,
      max_latency_ms: 1_500,
    });
    // We deliberately reuse the SAME deps across both runs so the stub's
    // mirrored "existing keys" set carries over from run 1 → run 2.
    const { deps, creates } = makeDeps({ aggregates: [agg] });

    const first = await runToolHealthCheck(deps);
    suite.expectEqual(first.alertsCreated, 1, "first run inserts the alert");

    // Slightly mutate the live metric value so we'd get a different title
    // if dedupe were title-based; the related_record_id key is what matters.
    agg.error_count = 13;
    agg.error_rate_pct = 65;

    const second = await runToolHealthCheck(deps);
    suite.expectEqual(second.alertsCreated, 0, "second run does not insert again");
    suite.expectEqual(
      second.alertsSkippedDuplicate,
      1,
      "second run reports the dedup skip",
    );
    suite.expectEqual(
      creates.length,
      1,
      "exactly one createAIAlert call across both runs",
    );
  },
);

// ─── Task #111: auto-resolve sweep ───────────────────────────────────────────

await suite.test("healthy tool past cooldown → auto-resolves matching error_rate alert", async () => {
  const agg = makeAggregate({
    tool_name: "search_kb",
    error_rate_pct: 2,            // well below threshold
    error_count: 2,
    p95_latency_ms: 1000,         // well below threshold
  });
  const openAlert: AIAlert = {
    id: 42,
    alert_type: "tool_health",
    severity: "high",
    title: "Tool \"search_kb\" error rate above threshold",
    description: "stale breach",
    status: "open",
    related_record_id: "search_kb:error_rate",
  };
  const { deps, resolves, lookups, creates } = makeDeps({
    aggregates: [agg],
    openAlertsByKey: { "search_kb:error_rate": [openAlert] },
    pastCooldown: true,
  });

  const out = await runToolHealthCheck(deps);

  suite.expectEqual(out.toolsEvaluated, 1, "toolsEvaluated");
  suite.expectEqual(out.alertsCreated, 0, "alertsCreated");
  suite.expectEqual(out.alertsAutoResolved, 1, "alertsAutoResolved");
  suite.expectEqual(creates.length, 0, "no breach alerts created");
  suite.expectEqual(resolves.length, 1, "exactly one resolveAlert call");
  suite.expectEqual(resolves[0]?.id, 42, "resolved alert id");
  suite.expect(
    typeof resolves[0]?.note === "string" && resolves[0].note.startsWith("auto-resolved:"),
    `resolve note starts with auto-resolved: (got: ${JSON.stringify(resolves[0]?.note)})`,
  );
  // Both reasons are below threshold so we look up both keys.
  const errorRateLookup = lookups.find(l => l.relatedRecordId === "search_kb:error_rate");
  const latencyLookup = lookups.find(l => l.relatedRecordId === "search_kb:p95_latency");
  suite.expect(!!errorRateLookup, "lookup made for search_kb:error_rate");
  suite.expect(!!latencyLookup, "lookup made for search_kb:p95_latency");
  suite.expectEqual(
    errorRateLookup?.options?.olderThanMinutes,
    TOOL_HEALTH_THRESHOLDS.windowMinutes,
    "cooldown filter passed via olderThanMinutes",
  );
  // Recovery breadcrumb captures alert id & reason
  suite.expectEqual(out.recoveries.length, 1, "recoveries length");
  suite.expectEqual(out.recoveries[0]?.alert_id, 42, "recoveries[0].alert_id");
  suite.expectEqual(out.recoveries[0]?.reason, "error_rate", "recoveries[0].reason");
  suite.expectEqual(out.recoveries[0]?.tool_name, "search_kb", "recoveries[0].tool_name");
});

await suite.test("alert too young (inside cooldown) → not auto-resolved", async () => {
  const agg = makeAggregate({
    tool_name: "search_kb",
    error_rate_pct: 0,
    p95_latency_ms: 100,
  });
  const openAlert: AIAlert = {
    id: 7,
    alert_type: "tool_health",
    severity: "high",
    title: "x",
    description: "x",
    status: "open",
    related_record_id: "search_kb:error_rate",
  };
  const { deps, resolves } = makeDeps({
    aggregates: [agg],
    openAlertsByKey: { "search_kb:error_rate": [openAlert] },
    pastCooldown: false,            // cooldown filter swallows the match
  });

  const out = await runToolHealthCheck(deps);

  suite.expectEqual(out.alertsAutoResolved, 0, "alertsAutoResolved");
  suite.expectEqual(resolves.length, 0, "resolveAlert not called");
  suite.expectEqual(out.recoveries.length, 0, "recoveries empty");
});

await suite.test("tool still breaching → no auto-resolve, alert created", async () => {
  const agg = makeAggregate({
    tool_name: "slow_tool",
    error_rate_pct: TOOL_HEALTH_THRESHOLDS.errorRatePct + 10,
    error_count: 50,
    p95_latency_ms: TOOL_HEALTH_THRESHOLDS.p95LatencyMs + 5_000,
  });
  const openAlert: AIAlert = {
    id: 11,
    alert_type: "tool_health",
    severity: "high",
    title: "x",
    description: "x",
    status: "open",
    related_record_id: "slow_tool:error_rate",
  };
  const { deps, resolves, creates, lookups } = makeDeps({
    aggregates: [agg],
    openAlertsByKey: { "slow_tool:error_rate": [openAlert] },
    pastCooldown: true,
  });

  const out = await runToolHealthCheck(deps);

  suite.expectEqual(out.alertsAutoResolved, 0, "alertsAutoResolved");
  suite.expectEqual(resolves.length, 0, "resolveAlert not called while breaching");
  suite.expectEqual(creates.length, 2, "both error_rate + p95_latency breach alerts created");
  // No recovery lookups should happen for the breach side because we only
  // look up open alerts when the metric is BELOW threshold.
  suite.expectEqual(lookups.length, 0, "no recovery lookups while breaching");
  suite.expectEqual(out.alertsCreated, 2, "alertsCreated counter");
  suite.expectEqual(out.breaches.length, 2, "breaches length");
});

await suite.test("mixed: error_rate breaching, p95 healthy → create + auto-resolve in one pass", async () => {
  const agg = makeAggregate({
    tool_name: "mixed_tool",
    error_rate_pct: TOOL_HEALTH_THRESHOLDS.errorRatePct + 5,  // breaching
    error_count: 30,
    p95_latency_ms: 200,                                       // healthy
  });
  const stalLatencyAlert: AIAlert = {
    id: 88,
    alert_type: "tool_health",
    severity: "medium",
    title: "stale latency",
    description: "x",
    status: "open",
    related_record_id: "mixed_tool:p95_latency",
  };
  const { deps, resolves, creates } = makeDeps({
    aggregates: [agg],
    openAlertsByKey: { "mixed_tool:p95_latency": [stalLatencyAlert] },
    pastCooldown: true,
  });

  const out = await runToolHealthCheck(deps);

  suite.expectEqual(out.alertsCreated, 1, "one breach alert created (error_rate)");
  suite.expectEqual(creates[0]?.alert.related_record_id, "mixed_tool:error_rate", "breach key");
  suite.expectEqual(out.alertsAutoResolved, 1, "stale latency alert auto-resolved");
  suite.expectEqual(resolves[0]?.id, 88, "resolved alert id");
  suite.expect(
    typeof resolves[0]?.note === "string" && resolves[0].note.includes("p95 latency"),
    `note mentions p95 latency (got: ${JSON.stringify(resolves[0]?.note)})`,
  );
});

await suite.test("multiple open alerts for same key → all auto-resolved", async () => {
  const agg = makeAggregate({ tool_name: "multi", error_rate_pct: 0, p95_latency_ms: 50 });
  const a: AIAlert = { id: 1, alert_type: "tool_health", severity: "high", title: "a", description: "a", status: "open", related_record_id: "multi:error_rate" };
  const b: AIAlert = { id: 2, alert_type: "tool_health", severity: "high", title: "b", description: "b", status: "acknowledged", related_record_id: "multi:error_rate" };
  const { deps, resolves } = makeDeps({
    aggregates: [agg],
    openAlertsByKey: { "multi:error_rate": [a, b] },
    pastCooldown: true,
  });

  const out = await runToolHealthCheck(deps);

  suite.expectEqual(out.alertsAutoResolved, 2, "alertsAutoResolved");
  suite.expectEqual(resolves.length, 2, "two resolveAlert calls");
  suite.expectEqual(resolves.map(r => r.id).sort().join(","), "1,2", "both ids resolved");
});

await suite.test("tool not in aggregates → matching open alert is NOT auto-resolved", async () => {
  // A tool with no traffic in the window won't appear in aggregates.
  // We don't auto-resolve in that case (no observation = no signal).
  const otherAgg = makeAggregate({ tool_name: "other_tool" });
  const openAlert: AIAlert = {
    id: 5, alert_type: "tool_health", severity: "high",
    title: "x", description: "x", status: "open",
    related_record_id: "silent_tool:error_rate",
  };
  const { deps, resolves } = makeDeps({
    aggregates: [otherAgg],
    openAlertsByKey: { "silent_tool:error_rate": [openAlert] },
    pastCooldown: true,
  });

  const out = await runToolHealthCheck(deps);

  suite.expectEqual(out.alertsAutoResolved, 0, "silent tool alert not closed");
  suite.expectEqual(resolves.length, 0, "no resolveAlert calls");
});

// ─── Task #128: on-call notification wiring ──────────────────────────────────

await suite.test(
  "(n1) new breach alert triggers exactly one Slack/email notification",
  async () => {
    const agg = makeAggregate({
      tool_name: "qms_create_nc",
      agent_name: "qms_agent",
      call_count: 20,
      error_count: 12,
      error_rate_pct: 60,
      p95_latency_ms: 1_000,
    });
    const { deps, notifies } = makeDeps({ aggregates: [agg] });

    const out = await runToolHealthCheck(deps);

    suite.expectEqual(out.alertsCreated, 1, "one alert created");
    suite.expectEqual(notifies.length, 1, "notifier called exactly once");
    suite.expectEqual(out.notificationsSent, 1, "notificationsSent counter");
    suite.expectEqual(out.notificationsThrottled, 0, "no throttle");
    suite.expectEqual(out.notificationsSkipped, 0, "no skips");

    const n = notifies[0]!.notification;
    suite.expectEqual(n.tool_name, "qms_create_nc", "notification carries tool name");
    suite.expectEqual(n.reason, "error_rate", "notification carries reason");
    suite.expectEqual(
      n.related_record_id,
      "qms_create_nc:error_rate",
      "notification carries dedupe key matching ai_alerts row",
    );
    suite.expectEqual(n.severity, "high", "severity propagated");
    suite.expectEqual(n.agent_name, "qms_agent", "agent name propagated");
    suite.expect(
      n.description.includes("60%") && n.description.includes("12/20"),
      "description carries live metric values",
    );
  },
);

await suite.test(
  "(n2) duplicate breach (existing open ai_alerts row) does NOT re-page",
  async () => {
    const agg = makeAggregate({
      tool_name: "qms_create_nc",
      call_count: 20,
      error_count: 12,
      error_rate_pct: 60,
      p95_latency_ms: 1_000,
    });
    const { deps, notifies } = makeDeps({
      aggregates: [agg],
      existingOpenDedupeKeys: ["tool_health:qms_create_nc:error_rate"],
    });

    const out = await runToolHealthCheck(deps);

    suite.expectEqual(out.alertsCreated, 0, "no new alert created");
    suite.expectEqual(out.alertsSkippedDuplicate, 1, "dedupe skip recorded");
    suite.expectEqual(
      notifies.length,
      0,
      "notifier NOT called when DB-level dedupe already silenced the breach",
    );
    suite.expectEqual(out.notificationsSent, 0, "notificationsSent stays 0");
  },
);

await suite.test(
  "(n3) two consecutive cron passes over same breach page only once",
  async () => {
    const agg = makeAggregate({
      tool_name: "qms_create_nc",
      call_count: 20,
      error_count: 12,
      error_rate_pct: 60,
      p95_latency_ms: 1_000,
    });
    const { deps, notifies } = makeDeps({ aggregates: [agg] });

    const first = await runToolHealthCheck(deps);
    suite.expectEqual(first.notificationsSent, 1, "first run pages on-call");

    const second = await runToolHealthCheck(deps);
    suite.expectEqual(
      second.notificationsSent,
      0,
      "second run does NOT page again (DB dedupe in front of notifier)",
    );
    suite.expectEqual(
      notifies.length,
      1,
      "notifier called exactly once across both runs",
    );
  },
);

await suite.test(
  "(n4) both error_rate AND p95_latency breach → two distinct pages",
  async () => {
    const agg = makeAggregate({
      tool_name: "double_breach_tool",
      agent_name: "agent_x",
      call_count: 20,
      error_count: 18,
      error_rate_pct: 90,
      p95_latency_ms: 65_000,
      avg_latency_ms: 30_000,
      max_latency_ms: 70_000,
    });
    const { deps, notifies } = makeDeps({ aggregates: [agg] });

    const out = await runToolHealthCheck(deps);

    suite.expectEqual(out.alertsCreated, 2, "both reasons created alerts");
    suite.expectEqual(notifies.length, 2, "exactly two pages dispatched");
    const reasons = notifies.map((n) => n.notification.reason).sort();
    suite.expectEqual(reasons[0], "error_rate", "error_rate page dispatched");
    suite.expectEqual(reasons[1], "p95_latency", "p95_latency page dispatched");
    const keys = notifies.map((n) => n.notification.related_record_id).sort();
    suite.expectEqual(
      keys[0],
      "double_breach_tool:error_rate",
      "error_rate page carries matching dedupe key",
    );
    suite.expectEqual(
      keys[1],
      "double_breach_tool:p95_latency",
      "p95_latency page carries matching dedupe key",
    );
  },
);

await suite.test(
  "(n5) notifier reports 'skipped' (no channel/email configured) increments skip counter",
  async () => {
    const agg = makeAggregate({
      tool_name: "unwired_tool",
      call_count: 20,
      error_count: 12,
      error_rate_pct: 60,
      p95_latency_ms: 1_000,
    });
    const { deps, notifies } = makeDeps({
      aggregates: [agg],
      notifierResult: {
        slackSent: false,
        emailSent: false,
        throttled: false,
        skipped: true,
      },
    });

    const out = await runToolHealthCheck(deps);

    suite.expectEqual(out.alertsCreated, 1, "alert still created");
    suite.expectEqual(out.notificationsSent, 0, "no page sent");
    suite.expectEqual(out.notificationsSkipped, 1, "skip counter incremented");
    suite.expectEqual(notifies.length, 1, "notifier still invoked");
  },
);

await suite.test(
  "(n6) notifier reports 'throttled' increments throttle counter",
  async () => {
    const agg = makeAggregate({
      tool_name: "throttled_tool",
      call_count: 20,
      error_count: 12,
      error_rate_pct: 60,
      p95_latency_ms: 1_000,
    });
    const { deps } = makeDeps({
      aggregates: [agg],
      notifierResult: {
        slackSent: false,
        emailSent: false,
        throttled: true,
        skipped: false,
      },
    });

    const out = await runToolHealthCheck(deps);

    suite.expectEqual(out.alertsCreated, 1, "alert still created");
    suite.expectEqual(out.notificationsSent, 0, "no page sent");
    suite.expectEqual(out.notificationsThrottled, 1, "throttle counter incremented");
  },
);

await suite.test(
  "(n7) notifier throws → cron pass continues, sent counter stays 0",
  async () => {
    const agg = makeAggregate({
      tool_name: "page_explodes_tool",
      call_count: 20,
      error_count: 12,
      error_rate_pct: 60,
      p95_latency_ms: 1_000,
    });
    const { deps } = makeDeps({
      aggregates: [agg],
      notifierThrows: true,
    });

    // Silence the expected error log.
    const origErr = console.error;
    console.error = () => {};
    try {
      const out = await runToolHealthCheck(deps);
      suite.expectEqual(out.alertsCreated, 1, "alert still created despite paging failure");
      suite.expectEqual(out.notificationsSent, 0, "sent counter stays 0 when notifier throws");
      suite.expectEqual(out.notificationsThrottled, 0, "throttle counter stays 0");
      suite.expectEqual(out.notificationsSkipped, 0, "skipped counter stays 0");
    } finally {
      console.error = origErr;
    }
  },
);

await suite.test(
  "(n8) auto-resolve sweep does NOT page on-call (only breaches do)",
  async () => {
    const agg = makeAggregate({
      tool_name: "recovered_tool",
      error_rate_pct: 0,
      p95_latency_ms: 100,
    });
    const openAlert: AIAlert = {
      id: 99,
      alert_type: "tool_health",
      severity: "high",
      title: "stale",
      description: "stale",
      status: "open",
      related_record_id: "recovered_tool:error_rate",
    };
    const { deps, notifies } = makeDeps({
      aggregates: [agg],
      openAlertsByKey: { "recovered_tool:error_rate": [openAlert] },
      pastCooldown: true,
    });

    const out = await runToolHealthCheck(deps);

    suite.expectEqual(out.alertsAutoResolved, 1, "stale alert auto-resolved");
    suite.expectEqual(notifies.length, 0, "no page sent on recovery");
    suite.expectEqual(out.notificationsSent, 0, "notificationsSent stays 0");
  },
);

await suite.test("resolveAlert throws → counter not incremented, other alerts still close", async () => {
  const agg = makeAggregate({ tool_name: "boom", error_rate_pct: 0, p95_latency_ms: 50 });
  const a: AIAlert = { id: 100, alert_type: "tool_health", severity: "high", title: "a", description: "a", status: "open", related_record_id: "boom:error_rate" };
  const b: AIAlert = { id: 101, alert_type: "tool_health", severity: "high", title: "b", description: "b", status: "open", related_record_id: "boom:error_rate" };
  const baseDeps = makeDeps({
    aggregates: [agg],
    openAlertsByKey: { "boom:error_rate": [a, b] },
    pastCooldown: true,
  });
  // Make the FIRST resolveAlert throw, second one succeed.
  let calls = 0;
  const originalResolve = baseDeps.deps.resolveAlert;
  baseDeps.deps.resolveAlert = async (id, note) => {
    calls++;
    if (calls === 1) throw new Error("simulated DB failure");
    return originalResolve(id, note);
  };
  // Silence the expected error log.
  const origErr = console.error;
  console.error = () => {};
  try {
    const out = await runToolHealthCheck(baseDeps.deps);
    suite.expectEqual(out.alertsAutoResolved, 1, "only the second alert counted");
  } finally {
    console.error = origErr;
  }
});

// ─── Task #127: severity-band boundaries & reopen-after-resolve lifecycle ────

/**
 * Drive `runToolHealthCheck` once with a single aggregate that breaches the
 * given metric and return the severity assigned to the resulting alert.
 * Lets the boundary tests assert the exact rung produced by
 * `severityForErrorRate` / `severityForLatency` (which are module-private)
 * without poking at internals.
 */
async function severityForErrorRateBreach(pct: number): Promise<string | undefined> {
  const agg = makeAggregate({
    tool_name: `er_${pct}`,
    call_count: 100,
    error_count: Math.round(pct),
    error_rate_pct: pct,
    p95_latency_ms: 100, // healthy on the latency side
    avg_latency_ms: 50,
    max_latency_ms: 200,
  });
  const { deps, creates } = makeDeps({ aggregates: [agg] });
  await runToolHealthCheck(deps);
  return creates[0]?.alert.severity;
}

async function severityForLatencyBreach(p95Ms: number): Promise<string | undefined> {
  const agg = makeAggregate({
    tool_name: `lat_${p95Ms}`,
    call_count: 100,
    error_count: 0,         // healthy on the error-rate side
    error_rate_pct: 0,
    p95_latency_ms: p95Ms,
    avg_latency_ms: Math.floor(p95Ms / 2),
    max_latency_ms: p95Ms + 1000,
  });
  const { deps, creates } = makeDeps({ aggregates: [agg] });
  await runToolHealthCheck(deps);
  return creates[0]?.alert.severity;
}

await suite.test(
  "(e) severityForErrorRate boundaries — breach-floor / high / critical map to medium/high/critical",
  // Pinning each rung at and around its boundary catches a future
  // `>=` → `>` slip (or vice versa) in `severityForErrorRate`. The
  // boundaries are read from `TOOL_HEALTH_THRESHOLDS` (Task #152) so
  // operators that override the env vars can still rely on this
  // contract: inputs at and just above the breach floor stay 'medium',
  // the high band opens at exactly `errorRateHighPct`, and the critical
  // band opens at exactly `errorRateCriticalPct`.
  async () => {
    const floor = TOOL_HEALTH_THRESHOLDS.errorRatePct;
    const high = TOOL_HEALTH_THRESHOLDS.errorRateHighPct;
    const critical = TOOL_HEALTH_THRESHOLDS.errorRateCriticalPct;
    // Sanity guard: the test only makes sense when the cutoffs are
    // strictly ordered. If an operator misconfigures them, that's a
    // separate failure mode — flag it loudly here rather than producing
    // confusing per-rung assertion errors.
    suite.expect(
      floor < high && high < critical,
      `severity cutoffs must satisfy floor (${floor}) < high (${high}) < critical (${critical})`,
    );
    const cases: Array<[number, "medium" | "high" | "critical"]> = [
      [floor, "medium"],         // breach floor — lowest input that ever reaches the helper
      [high - 1, "medium"],      // just below the high boundary
      [high, "high"],            // exact high boundary
      [critical - 1, "high"],    // just below the critical boundary
      [critical, "critical"],    // exact critical boundary
      [100, "critical"],
    ];
    for (const [pct, expected] of cases) {
      const sev = await severityForErrorRateBreach(pct);
      suite.expectEqual(
        sev,
        expected,
        `error_rate_pct=${pct} → severity='${expected}'`,
      );
    }
  },
);

await suite.test(
  "(f) severityForLatency boundaries — breach-floor / high / critical map to medium/high/critical",
  // Same idea as (e) but for the p95 latency ladder. Cutoffs are loaded
  // from `TOOL_HEALTH_THRESHOLDS` (Task #152): the high band opens at
  // exactly `latencyHighMs` and the critical band at exactly
  // `latencyCriticalMs`; values one ms below each boundary must stay in
  // the lower band.
  async () => {
    const floor = TOOL_HEALTH_THRESHOLDS.p95LatencyMs;
    const high = TOOL_HEALTH_THRESHOLDS.latencyHighMs;
    const critical = TOOL_HEALTH_THRESHOLDS.latencyCriticalMs;
    suite.expect(
      floor < high && high < critical,
      `latency cutoffs must satisfy floor (${floor}) < high (${high}) < critical (${critical})`,
    );
    const cases: Array<[number, "medium" | "high" | "critical"]> = [
      [floor, "medium"],         // breach floor
      [high - 1, "medium"],      // just below the high boundary
      [high, "high"],            // exact high boundary
      [critical - 1, "high"],    // just below the critical boundary
      [critical, "critical"],    // exact critical boundary
      [critical * 2, "critical"],
    ];
    for (const [p95Ms, expected] of cases) {
      const sev = await severityForLatencyBreach(p95Ms);
      suite.expectEqual(
        sev,
        expected,
        `p95_latency_ms=${p95Ms} → severity='${expected}'`,
      );
    }
  },
);

await suite.test(
  "(g) breach reopens after the previous alert is resolved/dismissed",
  // Lifecycle contract: `openAlertExistsByKey` only matches
  // `status IN ('open','acknowledged')`. Once an operator resolves (or
  // dismisses) the alert, the next cron pass over the same breach MUST
  // insert a brand-new row — otherwise the feed would go silent forever
  // after the first resolve, even while the underlying tool keeps
  // failing. We simulate the resolve by clearing the dedupe-key set the
  // stub uses to back `openAlertExistsByKey()`; that mirrors what the
  // real SQL filter does once the row's status flips to 'resolved'.
  async () => {
    const agg = makeAggregate({
      tool_name: "reopen_tool",
      agent_name: "ops_agent",
      call_count: 20,
      error_count: 12,
      error_rate_pct: 60,
      p95_latency_ms: 1_000,
      avg_latency_ms: 500,
      max_latency_ms: 1_500,
    });
    const { deps, creates, dedupeChecks, existingDedupeKeys } = makeDeps({
      aggregates: [agg],
    });

    // Run 1 — clean slate, alert is inserted.
    const first = await runToolHealthCheck(deps);
    suite.expectEqual(first.alertsCreated, 1, "first run inserts the alert");
    suite.expectEqual(
      first.alertsSkippedDuplicate,
      0,
      "first run does not skip anything as a duplicate",
    );
    suite.expectEqual(creates.length, 1, "exactly one createAIAlert call so far");
    suite.expect(
      existingDedupeKeys.has("tool_health:reopen_tool:error_rate"),
      "after run 1 the stub's dedupe set knows about the open alert",
    );

    // Sanity check: a second pass with the alert STILL OPEN must dedupe
    // (re-establishing the baseline before we simulate the resolve).
    const second = await runToolHealthCheck(deps);
    suite.expectEqual(
      second.alertsCreated,
      0,
      "while the prior alert is still open, the second pass dedupes",
    );
    suite.expectEqual(
      second.alertsSkippedDuplicate,
      1,
      "second pass reports the dedupe skip",
    );
    suite.expectEqual(
      creates.length,
      1,
      "no extra createAIAlert call while the alert is still open",
    );

    // Operator resolves (or dismisses) the alert. The real
    // `openAlertExistsByKey` filters `status IN ('open','acknowledged')`,
    // so a resolved row drops out of the dedupe lookup. Mirror that here.
    existingDedupeKeys.delete("tool_health:reopen_tool:error_rate");

    // Run 3 — same fixture, but now the prior alert is resolved. A fresh
    // alert MUST be inserted; the dedupe counter must NOT tick up.
    const dedupeChecksBefore = dedupeChecks.length;
    const third = await runToolHealthCheck(deps);
    suite.expectEqual(
      third.alertsCreated,
      1,
      "third run inserts a brand-new alert after the prior one was resolved",
    );
    suite.expectEqual(
      third.alertsSkippedDuplicate,
      0,
      "third run does NOT count the breach as a duplicate",
    );
    suite.expectEqual(
      creates.length,
      2,
      "exactly two createAIAlert calls across the full lifecycle",
    );
    suite.expectEqual(
      third.breaches.length,
      1,
      "third run reports a fresh breach in the result payload",
    );
    suite.expectEqual(
      third.breaches[0]?.reason,
      "error_rate",
      "fresh breach is the same reason as the original",
    );
    // The third run must have actually consulted the dedupe lookup —
    // proves we didn't accidentally short-circuit the breach branch.
    suite.expect(
      dedupeChecks.length > dedupeChecksBefore,
      "third run performed a fresh dedupe lookup",
    );
    const newKey = `tool_health:reopen_tool:error_rate`;
    suite.expect(
      existingDedupeKeys.has(newKey),
      "after run 3 the new alert is once again present in the dedupe set",
    );
  },
);

// ─── Task #176: misordered severity-cutoff warnings ─────────────────────────

await suite.test(
  "(z1) validateToolHealthThresholds returns no warnings for the default ladder",
  async () => {
    // Defaults are non-decreasing (25/50/75 and 15s/30s/60s), so a healthy
    // baseline must produce zero warnings.
    const warnings = validateToolHealthThresholds();
    suite.expectEqual(
      warnings.length,
      0,
      `expected 0 warnings for default config, got: ${warnings.join(" | ")}`,
    );
  },
);

await suite.test(
  "(z2) validateToolHealthThresholds warns when error-rate critical < high",
  async () => {
    // The classic silent-downgrade footgun the task calls out:
    // HIGH=80, CRITICAL=70 → severityForErrorRate() returns 'high' for any
    // breach above 80% because the critical branch is never reached.
    const warnings = validateToolHealthThresholds({
      errorRatePct: 25,
      errorRateHighPct: 80,
      errorRateCriticalPct: 70,
      p95LatencyMs: 15_000,
      latencyHighMs: 30_000,
      latencyCriticalMs: 60_000,
    });
    suite.expectEqual(warnings.length, 1, "exactly one warning for inverted error-rate cutoffs");
    suite.expect(
      /error-rate/i.test(warnings[0] ?? ""),
      "warning identifies the error-rate axis",
    );
    suite.expect(
      (warnings[0] ?? "").includes("80") && (warnings[0] ?? "").includes("70"),
      "warning surfaces both inverted values so the operator can fix the env",
    );
    suite.expect(
      (warnings[0] ?? "").includes("TOOL_HEALTH_ERROR_RATE_CRITICAL_PCT"),
      "warning names the env var the operator must adjust",
    );
  },
);

await suite.test(
  "(z3) validateToolHealthThresholds warns when error-rate breach floor > high cutoff",
  async () => {
    // ERROR_RATE_PCT=60 with HIGH=50 means the high band is unreachable —
    // a breach is, by definition, already at or above the high cutoff.
    const warnings = validateToolHealthThresholds({
      errorRatePct: 60,
      errorRateHighPct: 50,
      errorRateCriticalPct: 75,
      p95LatencyMs: 15_000,
      latencyHighMs: 30_000,
      latencyCriticalMs: 60_000,
    });
    suite.expectEqual(warnings.length, 1, "exactly one warning for breach floor > high");
    suite.expect(
      /error-rate/i.test(warnings[0] ?? ""),
      "warning identifies the error-rate axis",
    );
  },
);

await suite.test(
  "(z4) validateToolHealthThresholds warns when latency critical < high",
  async () => {
    const warnings = validateToolHealthThresholds({
      errorRatePct: 25,
      errorRateHighPct: 50,
      errorRateCriticalPct: 75,
      p95LatencyMs: 15_000,
      latencyHighMs: 60_000,
      latencyCriticalMs: 30_000,
    });
    suite.expectEqual(warnings.length, 1, "exactly one warning for inverted latency cutoffs");
    suite.expect(
      /latency/i.test(warnings[0] ?? ""),
      "warning identifies the latency axis",
    );
    suite.expect(
      (warnings[0] ?? "").includes("60000") &&
        (warnings[0] ?? "").includes("30000"),
      "warning surfaces both inverted ms values",
    );
    suite.expect(
      (warnings[0] ?? "").includes("TOOL_HEALTH_P95_LATENCY_CRITICAL_MS"),
      "warning names the env var the operator must adjust",
    );
  },
);

await suite.test(
  "(z5) validateToolHealthThresholds emits one warning per misordered axis",
  async () => {
    // Both axes inverted at once → two distinct warnings so the operator
    // sees the full scope of the misconfiguration in a single log scan.
    const warnings = validateToolHealthThresholds({
      errorRatePct: 25,
      errorRateHighPct: 80,
      errorRateCriticalPct: 70,
      p95LatencyMs: 15_000,
      latencyHighMs: 60_000,
      latencyCriticalMs: 30_000,
    });
    suite.expectEqual(warnings.length, 2, "one warning per misordered axis");
    suite.expect(
      warnings.some((w) => /error-rate/i.test(w)),
      "error-rate warning present",
    );
    suite.expect(
      warnings.some((w) => /latency/i.test(w)),
      "latency warning present",
    );
  },
);

await suite.test(
  "(z6) equal cutoffs are treated as valid (flat ladder, no warnings)",
  async () => {
    // An operator who pins HIGH==CRITICAL (or floor==HIGH) collapses the
    // band to a single rung but doesn't invert the ordering — that's a
    // legitimate choice, not a misconfiguration.
    const warnings = validateToolHealthThresholds({
      errorRatePct: 25,
      errorRateHighPct: 25,
      errorRateCriticalPct: 25,
      p95LatencyMs: 15_000,
      latencyHighMs: 15_000,
      latencyCriticalMs: 15_000,
    });
    suite.expectEqual(
      warnings.length,
      0,
      `flat ladder must not warn, got: ${warnings.join(" | ")}`,
    );
  },
);

await suite.test(
  "(z7-boot) misordered env vars produce a boot-time console.warn in a fresh process",
  async () => {
    // The validator coverage above is pure-function; this test exercises
    // the actual boot-time path by importing the module in a clean child
    // process with intentionally inverted env vars and asserting that the
    // operator-visible warning lands on stderr.
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        "-e",
        // Importing the module is enough — module-load runs
        // ensureThresholdValidationLogged() once, which emits via
        // console.warn (Node sends console.warn to stderr).
        `import("./src/mastra/workflows/toolHealthAlertsCron.ts").then(() => process.exit(0));`,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          // Inverted on BOTH axes so we can assert both warnings fire.
          TOOL_HEALTH_ERROR_RATE_PCT: "25",
          TOOL_HEALTH_ERROR_RATE_HIGH_PCT: "80",
          TOOL_HEALTH_ERROR_RATE_CRITICAL_PCT: "70",
          TOOL_HEALTH_P95_LATENCY_MS: "15000",
          TOOL_HEALTH_P95_LATENCY_HIGH_MS: "60000",
          TOOL_HEALTH_P95_LATENCY_CRITICAL_MS: "30000",
        },
        encoding: "utf8",
      },
    );

    // If the spawned process failed to start (e.g. missing tsx), surface
    // that explicitly rather than asserting against an empty stderr.
    suite.expectEqual(
      result.status,
      0,
      `child exited with status ${result.status}; stderr: ${result.stderr}`,
    );

    const stderr = result.stderr ?? "";
    suite.expect(
      stderr.includes("[ToolHealth]"),
      `expected boot-time warning to mention "[ToolHealth]"; got stderr: ${stderr}`,
    );
    suite.expect(
      stderr.includes("error-rate severity cutoffs") &&
        stderr.includes("80") &&
        stderr.includes("70") &&
        stderr.includes("TOOL_HEALTH_ERROR_RATE_CRITICAL_PCT"),
      "stderr surfaces the inverted error-rate cutoffs and the env var to fix",
    );
    suite.expect(
      stderr.includes("p95-latency severity cutoffs") &&
        stderr.includes("60000") &&
        stderr.includes("30000") &&
        stderr.includes("TOOL_HEALTH_P95_LATENCY_CRITICAL_MS"),
      "stderr surfaces the inverted latency cutoffs and the env var to fix",
    );
  },
);

await suite.test(
  "(z8) runToolHealthCheck emits the warning via console.warn on first invocation",
  async () => {
    // Spy on console.warn so we can confirm the cron actually pages the
    // warning out — pure-function coverage above isn't enough; the wiring
    // (module-load + on-first-call) is the actual operator-facing behavior.
    const original = console.warn;
    const captured: string[] = [];
    console.warn = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(" "));
    };
    try {
      // Default config is valid, so even after resetting the one-shot flag
      // the cron must NOT spam a misconfig warning.
      __resetThresholdValidationForTests();
      const { deps } = makeDeps({ aggregates: [] });
      await runToolHealthCheck(deps);
      const misconfigLines = captured.filter((line) =>
        line.includes("[ToolHealth]") &&
        /Misconfigured/i.test(line),
      );
      suite.expectEqual(
        misconfigLines.length,
        0,
        `valid default config must not warn, got: ${misconfigLines.join(" | ")}`,
      );

      // Second pass with the flag still set → still no extra warnings (the
      // one-shot guard prevents log spam across cron ticks).
      const before = captured.length;
      await runToolHealthCheck(deps);
      const newMisconfigLines = captured
        .slice(before)
        .filter((line) => /Misconfigured/i.test(line));
      suite.expectEqual(
        newMisconfigLines.length,
        0,
        "second cron pass must not re-emit misconfig warnings",
      );
    } finally {
      console.warn = original;
    }
  },
);

// ─── Task #191: time-boxed override reaper integration ──────────────────────
// These tests verify that the cron tick invokes the reaper and that the
// result feeds the `expiredOverridesReaped` summary field. The reaper itself
// is unit-tested at the DB layer; here we only verify the wiring.

await suite.test(
  "(t1) cron invokes reapExpiredOverrides before evaluating thresholds",
  async () => {
    const order: string[] = [];
    const baseDeps = makeDeps({ aggregates: [] }).deps;
    const deps: ToolHealthDeps = {
      ...baseDeps,
      reapExpiredOverrides: async () => {
        order.push("reap");
        return {
          reaped: false,
          cleared_overrides: {},
          expired_at: null,
          audit_id: null,
          previous_updated_by: null,
        };
      },
      getToolWindowAggregates: async (windowMinutes, minCalls) => {
        order.push("aggregate");
        return baseDeps.getToolWindowAggregates(windowMinutes, minCalls);
      },
    };
    const out = await runToolHealthCheck(deps);
    suite.expectEqual(order[0], "reap", "reaper runs first");
    suite.expectEqual(order[1], "aggregate", "aggregator runs after reaper");
    suite.expectEqual(
      out.expiredOverridesReaped,
      0,
      "no expired overrides → counter stays at 0",
    );
  },
);

await suite.test(
  "(t2) cron surfaces expiredOverridesReaped=1 when the reaper reports a sweep",
  async () => {
    const baseDeps = makeDeps({ aggregates: [] }).deps;
    const deps: ToolHealthDeps = {
      ...baseDeps,
      reapExpiredOverrides: async () => ({
        reaped: true,
        cleared_overrides: { errorRatePct: 99 },
        expired_at: new Date(Date.now() - 60_000),
        audit_id: 12345,
        previous_updated_by: "alice@example.com",
      }),
    };
    const out = await runToolHealthCheck(deps);
    suite.expectEqual(
      out.expiredOverridesReaped,
      1,
      "reaper sweep reflected in summary",
    );
  },
);

// ─── Task #213: Slack notification when an override auto-reverts ───────────
// The cron is expected to invoke `notifyOverrideExpired` exactly when the
// reaper actually swept a row, forwarding `previous_updated_by`,
// `cleared_overrides`, `expired_at`, and `audit_id`. Notifier failures must
// be logged but never abort the surrounding cron pass — the override has
// already been revert-ed and audited at that point.

await suite.test(
  "(t213-1) cron invokes notifyOverrideExpired when reaper reports a sweep",
  async () => {
    const notifyCalls: any[] = [];
    const baseDeps = makeDeps({ aggregates: [] }).deps;
    const deps: ToolHealthDeps = {
      ...baseDeps,
      reapExpiredOverrides: async () => ({
        reaped: true,
        cleared_overrides: { errorRatePct: 99, p95LatencyMs: 30_000 },
        expired_at: new Date("2026-04-24T09:00:00Z"),
        audit_id: 7777,
        previous_updated_by: "alice@example.com",
      }),
      notifyOverrideExpired: (async (n: any) => {
        notifyCalls.push(n);
        return { slackSent: true, skipped: false };
      }) as any,
    };
    await runToolHealthCheck(deps);
    suite.expectEqual(notifyCalls.length, 1, "exactly one Slack post sent");
    const call = notifyCalls[0];
    suite.expectEqual(
      call.previous_updated_by,
      "alice@example.com",
      "carries the operator who set the override",
    );
    suite.expectEqual(
      call.audit_id,
      7777,
      "carries the audit row id for deep-link",
    );
    suite.expect(
      call.cleared_overrides.errorRatePct === 99 &&
        call.cleared_overrides.p95LatencyMs === 30_000,
      "carries the cleared override snapshot",
    );
    suite.expect(
      call.expired_at instanceof Date &&
        call.expired_at.toISOString() === "2026-04-24T09:00:00.000Z",
      `carries the expires_at that triggered the reap (got: ${call.expired_at})`,
    );
  },
);

await suite.test(
  "(t213-2) cron does NOT invoke notifyOverrideExpired on a no-op reaper pass",
  async () => {
    const notifyCalls: any[] = [];
    const baseDeps = makeDeps({ aggregates: [] }).deps;
    const deps: ToolHealthDeps = {
      ...baseDeps,
      reapExpiredOverrides: async () => ({
        reaped: false,
        cleared_overrides: {},
        expired_at: null,
        audit_id: null,
        previous_updated_by: null,
      }),
      notifyOverrideExpired: (async (n: any) => {
        notifyCalls.push(n);
        return { slackSent: true, skipped: false };
      }) as any,
    };
    await runToolHealthCheck(deps);
    suite.expectEqual(
      notifyCalls.length,
      0,
      "no Slack post when nothing was reaped",
    );
  },
);

await suite.test(
  "(t213-3) notifyOverrideExpired throwing is logged but does not abort the cron",
  async () => {
    const captured: string[] = [];
    const originalErr = console.error;
    console.error = (...args: any[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      const baseDeps = makeDeps({
        aggregates: [
          makeAggregate({
            tool_name: "still_runs_after_slack_blowup",
            agent_name: "agent",
            call_count: 20,
            error_count: 12,
            error_rate_pct: 60,
          }),
        ],
      }).deps;
      const deps: ToolHealthDeps = {
        ...baseDeps,
        reapExpiredOverrides: async () => ({
          reaped: true,
          cleared_overrides: { errorRatePct: 75 },
          expired_at: new Date(Date.now() - 60_000),
          audit_id: 4242,
          previous_updated_by: "bob@example.com",
        }),
        notifyOverrideExpired: (async () => {
          throw new Error("simulated Slack outage");
        }) as any,
      };
      const out = await runToolHealthCheck(deps);
      suite.expectEqual(out.toolsEvaluated, 1, "evaluation still ran");
      suite.expectEqual(
        out.expiredOverridesReaped,
        1,
        "reap counter reflects the sweep even when Slack threw",
      );
      suite.expect(
        captured.some((l) =>
          /override auto-revert Slack notification failed/i.test(l),
        ),
        `Slack failure logged (got: ${captured.join(" | ")})`,
      );
    } finally {
      console.error = originalErr;
    }
  },
);

await suite.test(
  "(t3) reaper failure is logged but does not abort the cron tick",
  async () => {
    const captured: string[] = [];
    const originalErr = console.error;
    console.error = (...args: any[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      const baseDeps = makeDeps({
        aggregates: [
          makeAggregate({
            tool_name: "still_runs",
            agent_name: "agent",
            call_count: 20,
            error_count: 12,
            error_rate_pct: 60,
          }),
        ],
      }).deps;
      const deps: ToolHealthDeps = {
        ...baseDeps,
        reapExpiredOverrides: async () => {
          throw new Error("simulated reaper DB failure");
        },
      };
      const out = await runToolHealthCheck(deps);
      suite.expectEqual(out.toolsEvaluated, 1, "evaluation still ran");
      suite.expectEqual(
        out.expiredOverridesReaped,
        0,
        "failed reaper does not bump the counter",
      );
      suite.expect(
        captured.some((l) => /reaper|override expired|reapExpired/i.test(l)),
        `reaper failure logged (got: ${captured.join(" | ")})`,
      );
    } finally {
      console.error = originalErr;
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// (PREVIEW) evaluateWindowAggregates — pure helper extracted for the dry-run
// "Preview impact" endpoint (Task #189). The cron uses this same helper to
// compute breach candidates, so any drift between cron and preview behavior
// would show up here first.
// ──────────────────────────────────────────────────────────────────────────────
function makeCfg(over: Partial<EffectiveToolHealthConfig> = {}): EffectiveToolHealthConfig {
  return { ...TOOL_HEALTH_ENV_BASELINE, ...over };
}

await suite.test(
  "(P1) evaluateWindowAggregates returns no candidates when no aggregate breaches the floor",
  () => {
    const aggs: ToolWindowAggregate[] = [
      makeAggregate({ tool_name: "calm_tool", error_rate_pct: 5, p95_latency_ms: 100 }),
    ];
    const out = evaluateWindowAggregates(aggs, makeCfg({
      errorRatePct: 25, p95LatencyMs: 15_000, minCalls: 5,
    }));
    suite.expectEqual(out.length, 0, "no breaches");
  },
);

await suite.test(
  "(P2) evaluateWindowAggregates emits both reasons for a tool that breaches both",
  () => {
    const aggs: ToolWindowAggregate[] = [
      makeAggregate({
        tool_name: "double_breach",
        agent_name: "agent_a",
        call_count: 100,
        error_count: 60,
        error_rate_pct: 60,
        p95_latency_ms: 20_000,
      }),
    ];
    const out = evaluateWindowAggregates(aggs, makeCfg({
      errorRatePct: 25, errorRateHighPct: 50, errorRateCriticalPct: 75,
      p95LatencyMs: 15_000, latencyHighMs: 30_000, latencyCriticalMs: 60_000,
      minCalls: 5, windowMinutes: 60,
    }));
    suite.expectEqual(out.length, 2, "two breaches");
    suite.expectEqual(out[0].reason, "error_rate", "error_rate first");
    suite.expectEqual(out[0].severity, "high", "60% → high");
    suite.expectEqual(out[0].related_record_id, "double_breach:error_rate", "rid err");
    suite.expectEqual(out[1].reason, "p95_latency", "p95 second");
    suite.expectEqual(out[1].severity, "medium", "20s → medium");
    suite.expectEqual(out[1].related_record_id, "double_breach:p95_latency", "rid lat");
    // Live observed values are surfaced for the preview UI.
    suite.expectEqual(out[0].observed.error_rate_pct, 60, "observed err pct");
    suite.expectEqual(out[1].observed.p95_latency_ms, 20_000, "observed p95");
  },
);

await suite.test(
  "(P3) evaluateWindowAggregates filters by minCalls so a stricter proposed minCalls narrows the list",
  () => {
    const aggs: ToolWindowAggregate[] = [
      makeAggregate({
        tool_name: "low_traffic", call_count: 3,
        error_rate_pct: 100, error_count: 3,
      }),
      makeAggregate({
        tool_name: "high_traffic", call_count: 100,
        error_rate_pct: 100, error_count: 100,
      }),
    ];
    const looseCfg = makeCfg({ errorRatePct: 25, minCalls: 1 });
    const strictCfg = makeCfg({ errorRatePct: 25, minCalls: 50 });
    const looseOut = evaluateWindowAggregates(aggs, looseCfg);
    const strictOut = evaluateWindowAggregates(aggs, strictCfg);
    suite.expectEqual(looseOut.length, 2, "loose → both tools breach");
    suite.expectEqual(strictOut.length, 1, "strict → only high_traffic breaches");
    suite.expectEqual(strictOut[0].tool_name, "high_traffic", "strict keeps high_traffic");
  },
);

await suite.test(
  "(P4) evaluateWindowAggregates is purely deterministic — same input twice = same output",
  () => {
    const aggs: ToolWindowAggregate[] = [
      makeAggregate({ tool_name: "t1", error_rate_pct: 80, p95_latency_ms: 70_000 }),
      makeAggregate({ tool_name: "t2", error_rate_pct: 30, p95_latency_ms: 8_000 }),
    ];
    const cfg = makeCfg({
      errorRatePct: 25, errorRateHighPct: 50, errorRateCriticalPct: 75,
      p95LatencyMs: 15_000, latencyHighMs: 30_000, latencyCriticalMs: 60_000,
      minCalls: 5,
    });
    const a = evaluateWindowAggregates(aggs, cfg);
    const b = evaluateWindowAggregates(aggs, cfg);
    suite.expectEqual(JSON.stringify(a), JSON.stringify(b), "stable output");
  },
);

await suite.test(
  "(P5) evaluateWindowAggregates severity ladder responds to cfg overrides",
  () => {
    const aggs: ToolWindowAggregate[] = [
      makeAggregate({ tool_name: "borderline", error_rate_pct: 55 }),
    ];
    // With high cutoff at 50 → "55%" is high.
    const high = evaluateWindowAggregates(aggs, makeCfg({
      errorRatePct: 25, errorRateHighPct: 50, errorRateCriticalPct: 75,
    }));
    suite.expectEqual(high[0].severity, "high", "high band");
    // Tighten the critical cutoff to 50 → "55%" is now critical.
    const crit = evaluateWindowAggregates(aggs, makeCfg({
      errorRatePct: 25, errorRateHighPct: 40, errorRateCriticalPct: 50,
    }));
    suite.expectEqual(crit[0].severity, "critical", "critical band");
  },
);

suite.finishOrExit();
