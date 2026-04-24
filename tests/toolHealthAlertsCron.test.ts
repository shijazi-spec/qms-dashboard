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
  TOOL_HEALTH_THRESHOLDS,
  type ToolHealthDeps,
} from "../src/mastra/workflows/toolHealthAlertsCron";
import type { ToolWindowAggregate } from "../src/utils/aiTelemetry";
import type { AIAlert } from "../src/utils/aiAlertsDatabase";
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
}): {
  deps: ToolHealthDeps;
  resolves: ResolveCall[];
  lookups: OpenLookupCall[];
  creates: CreateCall[];
  dedupeChecks: DedupeCheck[];
  aggregateCalls: AggregateCall[];
} {
  const resolves: ResolveCall[] = [];
  const lookups: OpenLookupCall[] = [];
  const creates: CreateCall[] = [];
  const dedupeChecks: DedupeCheck[] = [];
  const aggregateCalls: AggregateCall[] = [];
  const openByKey = opts.openAlertsByKey ?? {};
  const pastCooldown = opts.pastCooldown !== false;
  // Mutable so dedupe checks against keys created earlier in the same run
  // also hit (matches the real DB's semantics — the cron's first INSERT is
  // visible to the next openAlertExistsByKey call within the same loop).
  const existingDedupeKeys = new Set<string>(opts.existingOpenDedupeKeys ?? []);

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
  };

  return { deps, resolves, lookups, creates, dedupeChecks, aggregateCalls };
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

suite.finishOrExit();
