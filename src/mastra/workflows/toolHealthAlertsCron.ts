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
  /** Cron expression — every 15 min by default. */
  cron: process.env.TOOL_HEALTH_ALERT_CRON || "*/15 * * * *",
} as const;

function severityForErrorRate(pct: number): AlertSeverity {
  if (pct >= 75) return "critical";
  if (pct >= 50) return "high";
  return "medium";
}

function severityForLatency(p95Ms: number): AlertSeverity {
  if (p95Ms >= 60_000) return "critical";
  if (p95Ms >= 30_000) return "high";
  return "medium";
}

export interface ToolHealthCheckResult {
  toolsEvaluated: number;
  alertsCreated: number;
  alertsSkippedDuplicate: number;
  breaches: Array<{
    tool_name: string;
    reason: "error_rate" | "p95_latency";
    severity: AlertSeverity;
    detail: string;
  }>;
}

/**
 * Builds an alert row for a breach. Returns whether a new alert was
 * inserted (false means a matching open/acknowledged alert already exists
 * for the same (tool_name, reason) — keyed on `related_record_id`, NOT
 * on `title`, because titles intentionally stay free of live metric
 * values to keep dedupe stable across runs).
 */
async function maybeCreateBreachAlert(
  agg: ToolWindowAggregate,
  reason: "error_rate" | "p95_latency",
  severity: AlertSeverity,
  title: string,
  description: string,
  suggestion: string,
): Promise<boolean> {
  const relatedRecordId = `${agg.tool_name}:${reason}`;
  const exists = await openAlertExistsByKey("tool_health", relatedRecordId);
  if (exists) return false;
  await createAIAlert({
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
 * Evaluate per-tool aggregates against TOOL_HEALTH_THRESHOLDS and emit
 * `ai_alerts` rows for any breaches. Safe to call from a cron, an HTTP
 * route, or a unit test — no I/O beyond the database.
 */
export async function runToolHealthCheck(): Promise<ToolHealthCheckResult> {
  const cfg = TOOL_HEALTH_THRESHOLDS;
  const out: ToolHealthCheckResult = {
    toolsEvaluated: 0,
    alertsCreated: 0,
    alertsSkippedDuplicate: 0,
    breaches: [],
  };

  let aggregates: ToolWindowAggregate[];
  try {
    aggregates = await getToolWindowAggregates(cfg.windowMinutes, cfg.minCalls);
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
          agg, "error_rate", severity, title, description, suggestion,
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
          agg, "p95_latency", severity, title, description, suggestion,
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
    }
  }

  if (out.alertsCreated > 0 || out.breaches.length > 0) {
    console.log("[ToolHealth] Check complete:", out);
  } else {
    console.log(
      `[ToolHealth] Check complete — ${out.toolsEvaluated} tools evaluated, ` +
      `0 new alerts (skipped ${out.alertsSkippedDuplicate} duplicates).`,
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
