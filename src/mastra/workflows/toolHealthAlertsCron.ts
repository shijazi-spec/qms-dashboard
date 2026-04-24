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
import {
  notifyToolHealthBreach,
  type NotifyToolHealthBreachResult,
} from "../../utils/toolHealthAlertNotifier";

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

/**
 * Cutoffs for error-rate / p95-latency must form a non-decreasing ladder:
 *   breach floor ≤ high cutoff ≤ critical cutoff
 *
 * If an operator inverts these (e.g. `HIGH_PCT=80` and `CRITICAL_PCT=70`),
 * `severityForErrorRate()` will short-circuit on the first
 * `>=` test and silently downgrade every breach — the "critical" rung
 * becomes unreachable. This validator surfaces that misconfiguration as a
 * warning at boot so an on-call engineer can fix the env vars before the
 * next paging window, instead of discovering the downgrade after a real
 * incident is undercalled.
 *
 * Pure function; consumers wire the warnings into `console.warn`. Equal
 * values are allowed (a flat ladder still preserves correct ordering).
 */
export function validateToolHealthThresholds(
  cfg: Pick<
    typeof TOOL_HEALTH_THRESHOLDS,
    | "errorRatePct"
    | "errorRateHighPct"
    | "errorRateCriticalPct"
    | "p95LatencyMs"
    | "latencyHighMs"
    | "latencyCriticalMs"
  > = TOOL_HEALTH_THRESHOLDS,
): string[] {
  const warnings: string[] = [];
  if (
    !(
      cfg.errorRatePct <= cfg.errorRateHighPct &&
      cfg.errorRateHighPct <= cfg.errorRateCriticalPct
    )
  ) {
    warnings.push(
      `[ToolHealth] Misconfigured error-rate severity cutoffs: expected ` +
        `breach floor (${cfg.errorRatePct}%) ≤ high (${cfg.errorRateHighPct}%) ` +
        `≤ critical (${cfg.errorRateCriticalPct}%). Severity will be silently ` +
        `downgraded for some breaches — adjust ` +
        `TOOL_HEALTH_ERROR_RATE_PCT / TOOL_HEALTH_ERROR_RATE_HIGH_PCT / ` +
        `TOOL_HEALTH_ERROR_RATE_CRITICAL_PCT so they are non-decreasing.`,
    );
  }
  if (
    !(
      cfg.p95LatencyMs <= cfg.latencyHighMs &&
      cfg.latencyHighMs <= cfg.latencyCriticalMs
    )
  ) {
    warnings.push(
      `[ToolHealth] Misconfigured p95-latency severity cutoffs: expected ` +
        `breach floor (${cfg.p95LatencyMs}ms) ≤ high (${cfg.latencyHighMs}ms) ` +
        `≤ critical (${cfg.latencyCriticalMs}ms). Severity will be silently ` +
        `downgraded for some breaches — adjust ` +
        `TOOL_HEALTH_P95_LATENCY_MS / TOOL_HEALTH_P95_LATENCY_HIGH_MS / ` +
        `TOOL_HEALTH_P95_LATENCY_CRITICAL_MS so they are non-decreasing.`,
    );
  }
  return warnings;
}

/**
 * Emits the misconfiguration warnings (if any) via `console.warn`.
 * Idempotent — only fires the first time per process so repeated cron
 * passes don't spam the log. Use `__resetThresholdValidationForTests()`
 * to clear the flag from a unit test.
 */
let _thresholdValidationLogged = false;
function ensureThresholdValidationLogged(): void {
  if (_thresholdValidationLogged) return;
  _thresholdValidationLogged = true;
  for (const w of validateToolHealthThresholds()) {
    console.warn(w);
  }
}

/** @internal Test-only: reset the one-shot validation flag. */
export function __resetThresholdValidationForTests(): void {
  _thresholdValidationLogged = false;
}

// Validate at module load so misconfiguration is visible at boot — even
// before the first cron tick fires. The in-process `runToolHealthCheck`
// re-checks via `ensureThresholdValidationLogged()` (no-op after this
// initial run) so tests that import the module after mutating env can
// still observe the warning by resetting the flag.
ensureThresholdValidationLogged();

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
  /** Counts on-call pages dispatched for newly-created breach alerts. */
  notificationsSent: number;
  /**
   * Counts breaches where the notifier short-circuited because nothing
   * is configured (no Slack channel, no email recipient). Useful to spot
   * environments where the alert pipeline is not actually wired up.
   */
  notificationsSkipped: number;
  /**
   * Counts breaches where the notifier was throttled by its in-process
   * dedupe window. Distinct from `alertsSkippedDuplicate` (which is the
   * DB-row dedupe).
   */
  notificationsThrottled: number;
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
  /**
   * Pages on-call about a freshly-opened `tool_health` alert. Defaults to
   * the production Slack/email pipeline; tests stub this to capture pages
   * without touching real services.
   */
  notifyToolHealthBreach: typeof notifyToolHealthBreach;
}

const DEFAULT_DEPS: ToolHealthDeps = {
  getToolWindowAggregates,
  openAlertExistsByKey,
  createAIAlert,
  getOpenAlertsByKey,
  resolveAlert,
  notifyToolHealthBreach,
};

/**
 * Builds an alert row for a breach. Returns the freshly-created alert when
 * a new row was inserted, or `null` when a matching open/acknowledged alert
 * already exists for the same (tool_name, reason) — keyed on
 * `related_record_id`, NOT on `title`, because titles intentionally stay
 * free of live metric values to keep dedupe stable across runs.
 *
 * The returned id (when present) is forwarded into the Slack/email page so
 * responders can correlate the message with the underlying `ai_alerts` row.
 */
async function maybeCreateBreachAlert(
  deps: ToolHealthDeps,
  agg: ToolWindowAggregate,
  reason: ToolHealthReason,
  severity: AlertSeverity,
  title: string,
  description: string,
  suggestion: string,
): Promise<{ created: true; alertId: number | undefined } | { created: false }> {
  const relatedRecordId = `${agg.tool_name}:${reason}`;
  const exists = await deps.openAlertExistsByKey("tool_health", relatedRecordId);
  if (exists) return { created: false };
  const inserted = await deps.createAIAlert({
    alert_type: "tool_health",
    severity,
    title,
    description,
    suggestion,
    related_module: "ai_ops",
    related_record_id: relatedRecordId,
  });
  return { created: true, alertId: inserted?.id };
}

/**
 * Page on-call for a freshly-opened breach alert and roll the result into
 * the cron's running counters. Notifier failures are logged but never
 * abort the surrounding cron pass — a Slack outage must not stop us
 * processing the remaining tools or running the auto-resolve sweep.
 */
async function dispatchBreachNotification(
  deps: ToolHealthDeps,
  agg: ToolWindowAggregate,
  reason: ToolHealthReason,
  severity: AlertSeverity,
  title: string,
  description: string,
  suggestion: string,
  alertId: number | undefined,
  out: ToolHealthCheckResult,
): Promise<void> {
  const relatedRecordId = `${agg.tool_name}:${reason}`;
  let result: NotifyToolHealthBreachResult;
  try {
    result = await deps.notifyToolHealthBreach({
      tool_name: agg.tool_name,
      agent_name: agg.agent_name ?? null,
      reason,
      severity,
      title,
      description,
      suggestion,
      related_record_id: relatedRecordId,
      alert_id: alertId,
    });
  } catch (err) {
    console.error(
      `[ToolHealth] Notifier threw for ${relatedRecordId}:`,
      err,
    );
    return;
  }
  if (result.skipped) {
    out.notificationsSkipped++;
    return;
  }
  if (result.throttled) {
    out.notificationsThrottled++;
    return;
  }
  if (result.slackSent || result.emailSent) {
    out.notificationsSent++;
  }
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
  // Re-check on first invocation in case the module-load validation was
  // suppressed (e.g. running under a test harness that resets the flag).
  ensureThresholdValidationLogged();
  const cfg = TOOL_HEALTH_THRESHOLDS;
  const out: ToolHealthCheckResult = {
    toolsEvaluated: 0,
    alertsCreated: 0,
    alertsSkippedDuplicate: 0,
    alertsAutoResolved: 0,
    notificationsSent: 0,
    notificationsSkipped: 0,
    notificationsThrottled: 0,
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
        const result = await maybeCreateBreachAlert(
          deps, agg, "error_rate", severity, title, description, suggestion,
        );
        if (result.created) {
          out.alertsCreated++;
          out.breaches.push({
            tool_name: agg.tool_name,
            reason: "error_rate",
            severity,
            detail: `${agg.error_rate_pct}% over ${cfg.windowMinutes}m`,
          });
          // Page on-call now that we know this is a brand-new alert. The
          // notifier inherits the (alert_type, related_record_id) dedupe
          // semantics for free because we only call it on `created=true`.
          await dispatchBreachNotification(
            deps, agg, "error_rate", severity, title, description, suggestion,
            result.alertId, out,
          );
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
        const result = await maybeCreateBreachAlert(
          deps, agg, "p95_latency", severity, title, description, suggestion,
        );
        if (result.created) {
          out.alertsCreated++;
          out.breaches.push({
            tool_name: agg.tool_name,
            reason: "p95_latency",
            severity,
            detail: `${agg.p95_latency_ms}ms over ${cfg.windowMinutes}m`,
          });
          await dispatchBreachNotification(
            deps, agg, "p95_latency", severity, title, description, suggestion,
            result.alertId, out,
          );
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
