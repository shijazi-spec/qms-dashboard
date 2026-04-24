/**
 * Unit tests for the per-tool health alert cron's auto-resolve sweep
 * (Task #111).
 *
 * Covers `runToolHealthCheck()` in
 * `src/mastra/workflows/toolHealthAlertsCron.ts` with all DB-backed
 * dependencies stubbed out via the `ToolHealthDeps` injection point. No
 * Postgres required.
 *
 * What we verify:
 *   - A healthy tool with an open `tool_health` alert older than the
 *     window is auto-resolved with a descriptive note and counted in
 *     `alertsAutoResolved` / `recoveries`.
 *   - The cooldown is honoured: alerts younger than `windowMinutes` are
 *     not closed (the stubbed `getOpenAlertsByKey` receives the
 *     `olderThanMinutes` filter and returns nothing).
 *   - A tool with both metrics still breaching does NOT auto-resolve.
 *   - A tool with one metric breaching and the other healthy creates a
 *     fresh alert for the breach AND auto-resolves the recovered side.
 *   - The recovery sweep works for both `error_rate` and `p95_latency`
 *     reasons independently.
 *
 * Run:  npx tsx tests/toolHealthAlertsCron.test.ts
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

function makeDeps(opts: {
  aggregates: ToolWindowAggregate[];
  openAlertsByKey?: Record<string, AIAlert[]>;
  /**
   * If true, alerts in `openAlertsByKey` are returned regardless of the
   * cooldown. If false (default), `getOpenAlertsByKey` returns [] when
   * the caller supplies `olderThanMinutes` to simulate "alert too young
   * to auto-resolve".
   */
  pastCooldown?: boolean;
}): {
  deps: ToolHealthDeps;
  resolves: ResolveCall[];
  lookups: OpenLookupCall[];
  creates: CreateCall[];
} {
  const resolves: ResolveCall[] = [];
  const lookups: OpenLookupCall[] = [];
  const creates: CreateCall[] = [];
  const openByKey = opts.openAlertsByKey ?? {};
  const pastCooldown = opts.pastCooldown !== false;

  const deps: ToolHealthDeps = {
    getToolWindowAggregates: async () => opts.aggregates,
    openAlertExistsByKey: async () => false,
    createAIAlert: async (alert) => {
      creates.push({ alert });
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

  return { deps, resolves, lookups, creates };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────
const suite = new TestSuite("toolHealthAlertsCron — auto-resolve sweep");
console.log("\n=== toolHealthAlertsCron auto-resolve tests ===\n");

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
  // No lookups should happen for the breach side because we only look up
  // open alerts when the metric is BELOW threshold.
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
