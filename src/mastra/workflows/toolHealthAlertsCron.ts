/**
 * Per-Tool Health Alert Cron
 *
 * Goal: surface a tool whose error_rate or p95 latency has degraded over a
 * rolling window so ops doesn't have to babysit the AI Operations dashboard.
 *
 * How it works:
 *   1. Aggregates `ai_call_metrics` rows for the last `WINDOW_MINUTES` per
 *      tool_name (see getToolWindowAggregates() in ../../utils/aiTelemetry).
 *   2. For tools with at least `MIN_CALLS` samples, evaluates two breach
 *      conditions:
 *         • error_rate_pct  ≥ ERROR_RATE_PCT
 *         • p95_latency_ms  ≥ P95_LATENCY_MS
 *   3. Inserts an `ai_alerts` row (alert_type='tool_health') for each breach.
 *      Dedupe is keyed on (alert_type, related_record_id) via
 *      `openAlertExistsByKey()` so we don't spam the feed every time the
 *      cron runs while the breach is still open. The composite key is
 *      stable (`<tool_name>:<reason>`), so fluctuating metric values in
 *      the title/description never produce a second open alert. A fresh
 *      alert is only created once the existing one moves to
 *      resolved/dismissed.
 *
 * Configurable thresholds live in TOOL_HEALTH_THRESHOLDS below and can be
 * overridden via env vars without code changes.
 *
 * The Inngest function is constructed in src/mastra/inngest/index.ts using
 * `runToolHealthCheck` so the helper stays unit-testable in isolation.
 */

import { inngest } from "../inngest/client";
import {
  getToolWindowAggregates,
  type ToolWindowAggregate,
} from "../../utils/aiTelemetry";
import {
  openAlertExistsByKey,
  createAIAlert,
  getOpenAlertsByKey,
  resolveAlert,
  type AlertSeverity,
} from "../../utils/aiAlertsDatabase";

// ──────────────────────────────────────────────────────────────────────────────
// Single, env-overridable config block — no hard-coded thresholds elsewhere.
// ──────────────────────────────────────────────────────────────────────────────
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const TOOL_HEALTH_THRESHOLDS = {
  /** Rolling window (minutes) over which metrics are aggregated. */
  windowMinutes: envInt("TOOL_HEALTH_WINDOW_MIN", 60),
  /** Minimum sample size before a tool can trigger an alert. */
  minCalls: envInt("TOOL_HEALTH_MIN_CALLS", 5),
  /** Error-rate (%) at or above which a tool is considered failing. */
  errorRatePct: envInt("TOOL_HEALTH_ERROR_RATE_PCT", 25),
  /** p95 latency (ms) at or above which a tool is considered slow. */
  p95LatencyMs: envInt("TOOL_HEALTH_P95_LATENCY_MS", 15000),
  /**
   * Severity-band cutoffs — at or above which a breach escalates from
   * 'medium' → 'high' or 'high' → 'critical'. Defaults match the
   * historic hard-coded constants so behavior is unchanged unless an
   * operator opts in. Operators tightening the breach floor (e.g.
   * errorRatePct=10) typically want to drop these too so the
   * 'high'/'critical' rungs stay proportional.
   */
  errorRateHighPct: envInt("TOOL_HEALTH_ERROR_RATE_HIGH_PCT", 50),
  errorRateCriticalPct: envInt("TOOL_HEALTH_ERROR_RATE_CRITICAL_PCT", 75),
  latencyHighMs: envInt("TOOL_HEALTH_P95_LATENCY_HIGH_MS", 30_000),
  latencyCriticalMs: envInt("TOOL_HEALTH_P95_LATENCY_CRITICAL_MS", 60_000),
  /** Cron expression — every 15 min by default. */
  cron: process.env.TOOL_HEALTH_ALERT_CRON || "*/15 * * * *",
} as const;

function severityForErrorRate(pct: number): AlertSeverity {
  if (pct >= TOOL_HEALTH_THRESHOLDS.errorRateCriticalPct) return "critical";
  if (pct >= TOOL_HEALTH_THRESHOLDS.errorRateHighPct) return "high";
  return "medium";
}

function severityForLatency(p95Ms: number): AlertSeverity {
  if (p95Ms >= TOOL_HEALTH_THRESHOLDS.latencyCriticalMs) return "critical";
  if (p95Ms >= TOOL_HEALTH_THRESHOLDS.latencyHighMs) return "high";
  return "medium";
}

export type ToolHealthReason = "error_rate" | "p95_latency";

export interface ToolHealthCheckResult {
  toolsEvaluated: number;
  alertsCreated: number;
  alertsSkippedDuplicate: number;
  alertsAutoResolved: number;
  breaches: Array<{
    tool_name: string;
    reason: ToolHealthReason;
    severity: AlertSeverity;
    detail: string;
  }>;
  recoveries: Array<{
    tool_name: string;
    reason: ToolHealthReason;
    alert_id: number;
    detail: string;
  }>;
}

/**
 * Pluggable IO surface for `runToolHealthCheck()`. Lets unit tests stub the
 * DB-backed dependencies without standing up a real Postgres instance.
 * Production callers pass nothing and get the real implementations.
 */
export interface ToolHealthDeps {
  getToolWindowAggregates: typeof getToolWindowAggregates;
  openAlertExistsByKey: typeof openAlertExistsByKey;
  createAIAlert: typeof createAIAlert;
  getOpenAlertsByKey: typeof getOpenAlertsByKey;
  resolveAlert: typeof resolveAlert;
}

const DEFAULT_DEPS: ToolHealthDeps = {
  getToolWindowAggregates,
  openAlertExistsByKey,
  createAIAlert,
  getOpenAlertsByKey,
  resolveAlert,
};

/**
 * Builds an alert row for a breach. Returns whether a new alert was
 * inserted (false means a matching open/acknowledged alert already exists
 * for the same (tool_name, reason) — keyed on `related_record_id`, NOT
 * on `title`, because titles intentionally stay free of live metric
 * values to keep dedupe stable across runs).
 */
async function maybeCreateBreachAlert(
  deps: ToolHealthDeps,
  agg: ToolWindowAggregate,
  reason: ToolHealthReason,
  severity: AlertSeverity,
  title: string,
  description: string,
  suggestion: string,
): Promise<boolean> {
  const relatedRecordId = `${agg.tool_name}:${reason}`;
  const exists = await deps.openAlertExistsByKey("tool_health", relatedRecordId);
  if (exists) return false;
  await deps.createAIAlert({
    alert_type: "tool_health",
    severity,
    title,
    description,
    suggestion,
    related_module: "ai_ops",
    related_record_id: relatedRecordId,
  });
  return true;
}

/**
 * Auto-resolves any open `tool_health` alert keyed on
 * `<tool_name>:<reason>` once the matching metric has dropped back below
 * its threshold. Returns the number of alerts closed (0 when none match
 * or all matches are still inside the cooldown window).
 *
 * Cooldown: only alerts whose `created_at` is at least `cfg.windowMinutes`
 * old are considered, so the entire current rolling window of metrics is
 * post-recovery. This prevents a single low-traffic minute from flapping
 * an alert closed.
 */
async function maybeResolveRecoveredAlert(
  deps: ToolHealthDeps,
  agg: ToolWindowAggregate,
  reason: ToolHealthReason,
  out: ToolHealthCheckResult,
): Promise<void> {
  const cfg = TOOL_HEALTH_THRESHOLDS;
  const relatedRecordId = `${agg.tool_name}:${reason}`;
  let openAlerts;
  try {
    openAlerts = await deps.getOpenAlertsByKey(
      "tool_health",
      relatedRecordId,
      { olderThanMinutes: cfg.windowMinutes },
    );
  } catch (err) {
    console.error(
      `[ToolHealth] Failed to look up open alerts for ${relatedRecordId}:`,
      err,
    );
    return;
  }
  if (openAlerts.length === 0) return;

  const note =
    reason === "error_rate"
      ? `auto-resolved: error rate back below threshold ` +
        `(${agg.error_rate_pct}% < ${cfg.errorRatePct}% over ` +
        `${cfg.windowMinutes}m, ${agg.call_count} calls)`
      : `auto-resolved: p95 latency back below threshold ` +
        `(${agg.p95_latency_ms}ms < ${cfg.p95LatencyMs}ms over ` +
        `${cfg.windowMinutes}m, ${agg.call_count} calls)`;

  for (const alert of openAlerts) {
    if (alert.id == null) continue;
    try {
      const resolved = await deps.resolveAlert(alert.id, note);
      if (resolved) {
        out.alertsAutoResolved++;
        out.recoveries.push({
          tool_name: agg.tool_name,
          reason,
          alert_id: alert.id,
          detail: note,
        });
      }
    } catch (err) {
      console.error(
        `[ToolHealth] Failed to auto-resolve alert ${alert.id} (${relatedRecordId}):`,
        err,
      );
    }
  }
}

/**
 * Evaluate per-tool aggregates against TOOL_HEALTH_THRESHOLDS and emit
 * `ai_alerts` rows for any breaches. Safe to call from a cron, an HTTP
 * route, or a unit test — no I/O beyond the database.
 *
 * After the breach pass, runs a recovery pass that auto-resolves any open
 * `tool_health` alert whose tool's current windowed metric has dropped
 * back below the threshold (subject to a windowMinutes cooldown to keep
 * borderline tools from flapping).
 */
export async function runToolHealthCheck(
  depsOverride?: Partial<ToolHealthDeps>,
): Promise<ToolHealthCheckResult> {
  const deps: ToolHealthDeps = { ...DEFAULT_DEPS, ...(depsOverride ?? {}) };
  const cfg = TOOL_HEALTH_THRESHOLDS;
  const out: ToolHealthCheckResult = {
    toolsEvaluated: 0,
    alertsCreated: 0,
    alertsSkippedDuplicate: 0,
    alertsAutoResolved: 0,
    breaches: [],
    recoveries: [],
  };

  let aggregates: ToolWindowAggregate[];
  try {
    aggregates = await deps.getToolWindowAggregates(cfg.windowMinutes, cfg.minCalls);
  } catch (err) {
    console.error("[ToolHealth] Failed to load per-tool aggregates:", err);
    return out;
  }

  out.toolsEvaluated = aggregates.length;

  for (const agg of aggregates) {
    // Error-rate breach
    if (agg.error_rate_pct >= cfg.errorRatePct) {
      const severity = severityForErrorRate(agg.error_rate_pct);
      // Title intentionally OMITS live metric values so dedupe via
      // related_record_id stays meaningful across cron runs while the
      // breach is ongoing. Live values live in `description`.
      const title =
        `Tool "${agg.tool_name}" error rate above threshold ` +
        `over last ${cfg.windowMinutes} min`;
      const description =
        `Tool "${agg.tool_name}"` +
        (agg.agent_name ? ` (agent: ${agg.agent_name})` : "") +
        ` had ${agg.error_count}/${agg.call_count} failed calls ` +
        `(${agg.error_rate_pct}%) in the last ${cfg.windowMinutes} minutes. ` +
        `Threshold is ${cfg.errorRatePct}% with at least ${cfg.minCalls} calls. ` +
        `Avg latency ${agg.avg_latency_ms} ms, p95 ${agg.p95_latency_ms} ms.`;
      const suggestion =
        `Open the AI Operations panel and inspect the recent failures for ` +
        `"${agg.tool_name}". Check for upstream service errors, schema ` +
        `validation failures, or rate-limit responses before the next cron ` +
        `evaluation.`;
      try {
        const created = await maybeCreateBreachAlert(
          deps, agg, "error_rate", severity, title, description, suggestion,
        );
        if (created) {
          out.alertsCreated++;
          out.breaches.push({
            tool_name: agg.tool_name,
            reason: "error_rate",
            severity,
            detail: `${agg.error_rate_pct}% over ${cfg.windowMinutes}m`,
          });
        } else {
          out.alertsSkippedDuplicate++;
        }
      } catch (err) {
        console.error(
          `[ToolHealth] Failed to create error-rate alert for ${agg.tool_name}:`,
          err,
        );
      }
    } else {
      // Error-rate is back below threshold for this tool's window —
      // close any matching open alert (subject to cooldown).
      await maybeResolveRecoveredAlert(deps, agg, "error_rate", out);
    }

    // p95 latency breach
    if (agg.p95_latency_ms >= cfg.p95LatencyMs) {
      const severity = severityForLatency(agg.p95_latency_ms);
      // Title intentionally OMITS the live p95 value so dedupe via
      // related_record_id stays stable across cron runs while the breach
      // is ongoing. Live values live in `description`.
      const title =
        `Tool "${agg.tool_name}" p95 latency above threshold ` +
        `over last ${cfg.windowMinutes} min`;
      const description =
        `Tool "${agg.tool_name}"` +
        (agg.agent_name ? ` (agent: ${agg.agent_name})` : "") +
        ` p95 latency is ${agg.p95_latency_ms} ms over ${agg.call_count} ` +
        `calls in the last ${cfg.windowMinutes} minutes ` +
        `(threshold: ${cfg.p95LatencyMs} ms; avg ${agg.avg_latency_ms} ms, ` +
        `max ${agg.max_latency_ms} ms, errors ${agg.error_count}).`;
      const suggestion =
        `Investigate the slow path for "${agg.tool_name}" — check the ` +
        `upstream API/SQL latency and recent traffic spikes in the AI ` +
        `Operations panel. Consider raising timeouts or adding back-pressure ` +
        `if this is a recurring breach.`;
      try {
        const created = await maybeCreateBreachAlert(
          deps, agg, "p95_latency", severity, title, description, suggestion,
        );
        if (created) {
          out.alertsCreated++;
          out.breaches.push({
            tool_name: agg.tool_name,
            reason: "p95_latency",
            severity,
            detail: `${agg.p95_latency_ms}ms over ${cfg.windowMinutes}m`,
          });
        } else {
          out.alertsSkippedDuplicate++;
        }
      } catch (err) {
        console.error(
          `[ToolHealth] Failed to create latency alert for ${agg.tool_name}:`,
          err,
        );
      }
    } else {
      // p95 latency is back below threshold for this tool's window —
      // close any matching open alert (subject to cooldown).
      await maybeResolveRecoveredAlert(deps, agg, "p95_latency", out);
    }
  }

  if (
    out.alertsCreated > 0 ||
    out.breaches.length > 0 ||
    out.alertsAutoResolved > 0
  ) {
    console.log("[ToolHealth] Check complete:", out);
  } else {
    console.log(
      `[ToolHealth] Check complete — ${out.toolsEvaluated} tools evaluated, ` +
      `0 new alerts (skipped ${out.alertsSkippedDuplicate} duplicates, ` +
      `0 auto-resolved).`,
    );
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Inngest cron — registered from src/mastra/inngest/index.ts.
// Kept here (not in inngest/index.ts) so the cron file lives next to the
// other workflow definitions per the task spec.
// ──────────────────────────────────────────────────────────────────────────────
export const toolHealthAlertsCronFunction = inngest.createFunction(
  { id: "tool-health-alerts" },
  { cron: TOOL_HEALTH_THRESHOLDS.cron },
  async ({ step }) => {
    return await step.run("evaluate-tool-health", async () => {
      return await runToolHealthCheck();
    });
  },
);
