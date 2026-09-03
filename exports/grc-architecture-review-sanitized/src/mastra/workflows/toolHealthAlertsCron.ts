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
import { logger } from "../../utils/logger";
import {
  getToolWindowAggregates,
  getToolsWithCallsInWindow,
  type ToolWindowAggregate,
} from "../../utils/aiTelemetry";
import {
  openAlertExistsByKey,
  createAIAlert,
  getOpenAlertsByKey,
  getOpenAlertsByType,
  recordToolHealthNotifyDeadLetter,
  resolveAlert,
  type AlertSeverity,
} from "../../utils/aiAlertsDatabase";
import {
  notifyToolHealthBreach,
  notifyToolHealthOverrideExpired,
  notifyToolHealthOverrideExpiringSoon,
  notifyToolHealthRecovery,
  type NotifyToolHealthBreachResult,
} from "../../utils/toolHealthAlertNotifier";
import {
  getToolHealthConfigOverrides,
  getToolHealthOverrideExpiringSoon,
  reapExpiredToolHealthOverrides,
  type ReapExpiredToolHealthOverridesResult,
  type ToolHealthConfigOverrides,
  type ToolHealthConfigValues,
} from "../../utils/toolHealthConfigDatabase";

// ──────────────────────────────────────────────────────────────────────────────
// Env-overridable baseline. Operators can also tune these from the AI
// Operations panel without a redeploy — see getEffectiveToolHealthConfig()
// below for the merge order (DB override > env > built-in default).
// ──────────────────────────────────────────────────────────────────────────────
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Compile-time defaults applied when the env doesn't override and the DB
 * override row is absent. Kept in one place so the AI Ops panel can show
 * "default = X" next to every tunable.
 */
export const TOOL_HEALTH_DEFAULTS: ToolHealthConfigValues = {
  windowMinutes: 60,
  minCalls: 5,
  errorRatePct: 25,
  errorRateHighPct: 50,
  errorRateCriticalPct: 75,
  p95LatencyMs: 15_000,
  latencyHighMs: 30_000,
  latencyCriticalMs: 60_000,
};

/**
 * Env-only baseline. This is the floor of the merge stack — what the
 * cron used to read directly before per-instance DB overrides existed.
 * Persisted overrides from the AI Ops panel sit on top of this; see
 * `getEffectiveToolHealthConfig()`.
 *
 * NOTE: This object is computed at module-load time (env vars are read
 * once). The DB override layer, by contrast, is read on every cron pass
 * so live edits take effect at the next tick.
 */
export const TOOL_HEALTH_ENV_BASELINE: ToolHealthConfigValues = {
  windowMinutes: envInt(
    "TOOL_HEALTH_WINDOW_MIN",
    TOOL_HEALTH_DEFAULTS.windowMinutes,
  ),
  minCalls: envInt("TOOL_HEALTH_MIN_CALLS", TOOL_HEALTH_DEFAULTS.minCalls),
  errorRatePct: envInt(
    "TOOL_HEALTH_ERROR_RATE_PCT",
    TOOL_HEALTH_DEFAULTS.errorRatePct,
  ),
  errorRateHighPct: envInt(
    "TOOL_HEALTH_ERROR_RATE_HIGH_PCT",
    TOOL_HEALTH_DEFAULTS.errorRateHighPct,
  ),
  errorRateCriticalPct: envInt(
    "TOOL_HEALTH_ERROR_RATE_CRITICAL_PCT",
    TOOL_HEALTH_DEFAULTS.errorRateCriticalPct,
  ),
  p95LatencyMs: envInt(
    "TOOL_HEALTH_P95_LATENCY_MS",
    TOOL_HEALTH_DEFAULTS.p95LatencyMs,
  ),
  latencyHighMs: envInt(
    "TOOL_HEALTH_P95_LATENCY_HIGH_MS",
    TOOL_HEALTH_DEFAULTS.latencyHighMs,
  ),
  latencyCriticalMs: envInt(
    "TOOL_HEALTH_P95_LATENCY_CRITICAL_MS",
    TOOL_HEALTH_DEFAULTS.latencyCriticalMs,
  ),
};

/**
 * @deprecated Use {@link TOOL_HEALTH_ENV_BASELINE} for the env-only floor
 * or {@link getEffectiveToolHealthConfig} for the merged live config.
 * Kept as an alias so existing tests/imports continue to compile. The
 * `cron` field is retained here because it doesn't have a per-instance
 * override (changing the cron schedule still requires a redeploy).
 */
export const TOOL_HEALTH_THRESHOLDS = {
  ...TOOL_HEALTH_ENV_BASELINE,
  /** Cron expression — every 15 min by default. */
  cron: process.env.TOOL_HEALTH_ALERT_CRON || "*/15 * * * *",
} as const;

/**
 * Multiplier applied to `windowMinutes` to compute the silence cooldown.
 * A tool must have had zero calls for at least
 * `TOOL_HEALTH_SILENT_COOLDOWN_MULT × windowMinutes` minutes before its
 * open `tool_health` alerts are auto-resolved.
 *
 * Default 4 (i.e. 4× the rolling window — 4 h at the 60-minute default).
 * Override via `TOOL_HEALTH_SILENT_COOLDOWN_MULT` env var.
 */
export const TOOL_HEALTH_SILENT_COOLDOWN_MULT: number = envInt(
  "TOOL_HEALTH_SILENT_COOLDOWN_MULT",
  4,
);

/**
 * Final, merged config used by `runToolHealthCheck` on each pass. Identical
 * shape to the env baseline but reflects any operator overrides currently
 * persisted in `tool_health_config_overrides`.
 */
export type EffectiveToolHealthConfig = ToolHealthConfigValues;

/**
 * Merges the env baseline with the persisted overrides loaded via
 * `loadOverrides()` (defaulting to the DB-backed loader). Per-field merge:
 * a defined override wins; an undefined override falls through to the
 * env baseline. Failures inside `loadOverrides` are not handled here —
 * the default loader logs and resolves to `{}` so production never
 * crashes a cron pass over a transient DB issue.
 */
export async function getEffectiveToolHealthConfig(
  loadOverrides: () => Promise<ToolHealthConfigOverrides> = getToolHealthConfigOverrides,
): Promise<EffectiveToolHealthConfig> {
  const overrides = await loadOverrides();
  return {
    windowMinutes:
      overrides.windowMinutes ?? TOOL_HEALTH_ENV_BASELINE.windowMinutes,
    minCalls: overrides.minCalls ?? TOOL_HEALTH_ENV_BASELINE.minCalls,
    errorRatePct:
      overrides.errorRatePct ?? TOOL_HEALTH_ENV_BASELINE.errorRatePct,
    errorRateHighPct:
      overrides.errorRateHighPct ?? TOOL_HEALTH_ENV_BASELINE.errorRateHighPct,
    errorRateCriticalPct:
      overrides.errorRateCriticalPct ??
      TOOL_HEALTH_ENV_BASELINE.errorRateCriticalPct,
    p95LatencyMs:
      overrides.p95LatencyMs ?? TOOL_HEALTH_ENV_BASELINE.p95LatencyMs,
    latencyHighMs:
      overrides.latencyHighMs ?? TOOL_HEALTH_ENV_BASELINE.latencyHighMs,
    latencyCriticalMs:
      overrides.latencyCriticalMs ?? TOOL_HEALTH_ENV_BASELINE.latencyCriticalMs,
  };
}

/**
 * Cutoffs for error-rate / p95-latency must form a non-decreasing ladder:
 *   breach floor ≤ high cutoff ≤ critical cutoff
 *
 * If an operator inverts these (e.g. `HIGH_PCT=80` and `CRITICAL_PCT=70`),
 * `severityForErrorRate()` will short-circuit on the first `>=` test and
 * silently downgrade every breach — the "critical" rung becomes
 * unreachable. This validator surfaces that misconfiguration as a warning
 * so an on-call engineer can fix it before the next paging window, instead
 * of discovering the downgrade after a real incident is undercalled.
 *
 * Pure function; consumers wire the warnings into a structured logger.warn
 * call. Equal
 * values are allowed (a flat ladder still preserves correct ordering).
 *
 * Operates on the merged `EffectiveToolHealthConfig` so it catches both
 * env-var misconfiguration AND a bad override pushed through the AI Ops
 * panel. (The PUT endpoint also enforces this server-side, but we keep
 * the runtime check as a defense in depth.)
 */
export function validateToolHealthThresholds(
  cfg: Pick<
    EffectiveToolHealthConfig,
    | "errorRatePct"
    | "errorRateHighPct"
    | "errorRateCriticalPct"
    | "p95LatencyMs"
    | "latencyHighMs"
    | "latencyCriticalMs"
  > = TOOL_HEALTH_ENV_BASELINE,
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
        `TOOL_HEALTH_ERROR_RATE_CRITICAL_PCT (or the matching AI Ops ` +
        `overrides) so they are non-decreasing.`,
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
        `TOOL_HEALTH_P95_LATENCY_CRITICAL_MS (or the matching AI Ops ` +
        `overrides) so they are non-decreasing.`,
    );
  }
  return warnings;
}

/**
 * Emits the misconfiguration warnings (if any) via the structured
 * logger.warn channel.
 * Idempotent — only fires the first time per process for a given config so
 * repeated cron passes don't spam the log. The dedupe is keyed on the
 * stringified warnings, so a *new* misconfiguration introduced via an
 * AI Ops override during the same process lifetime will still surface
 * exactly once. Use `__resetThresholdValidationForTests()` to clear the
 * cache from a unit test.
 */
const _thresholdValidationLogged = new Set<string>();
function ensureThresholdValidationLogged(
  cfg: Pick<
    EffectiveToolHealthConfig,
    | "errorRatePct"
    | "errorRateHighPct"
    | "errorRateCriticalPct"
    | "p95LatencyMs"
    | "latencyHighMs"
    | "latencyCriticalMs"
  > = TOOL_HEALTH_ENV_BASELINE,
): void {
  const warnings = validateToolHealthThresholds(cfg);
  if (warnings.length === 0) return;
  const key = warnings.join("\n");
  if (_thresholdValidationLogged.has(key)) return;
  _thresholdValidationLogged.add(key);
  for (const w of warnings) {
    logger.warn(w);
  }
}

/** @internal Test-only: reset the one-shot validation cache. */
export function __resetThresholdValidationForTests(): void {
  _thresholdValidationLogged.clear();
}

// Validate the env baseline at module load so misconfiguration is visible
// at boot — even before the first cron tick fires. `runToolHealthCheck`
// re-runs the check against the merged effective config (env + DB
// overrides) so a bad override pushed through the AI Ops panel also gets
// surfaced on the next pass.
ensureThresholdValidationLogged();

function severityForErrorRate(
  cfg: EffectiveToolHealthConfig,
  pct: number,
): AlertSeverity {
  if (pct >= cfg.errorRateCriticalPct) return "critical";
  if (pct >= cfg.errorRateHighPct) return "high";
  return "medium";
}

function severityForLatency(
  cfg: EffectiveToolHealthConfig,
  p95Ms: number,
): AlertSeverity {
  if (p95Ms >= cfg.latencyCriticalMs) return "critical";
  if (p95Ms >= cfg.latencyHighMs) return "high";
  return "medium";
}

export type ToolHealthReason = "error_rate" | "p95_latency";

/**
 * A would-be alert as produced by the pure {@link evaluateWindowAggregates}
 * helper. Carries everything the cron's side-effecting layer needs to write
 * an `ai_alerts` row AND everything the AI Ops "Preview impact" UI needs to
 * render the breach inline (tool name, agent, severity, human-readable
 * description). The cron path adds DB write + paging on top; the preview
 * route just JSON-serializes this and returns it.
 */
export interface ToolHealthBreachCandidate {
  tool_name: string;
  agent_name: string | null;
  reason: ToolHealthReason;
  severity: AlertSeverity;
  /** Stable composite used for `ai_alerts.related_record_id` dedupe. */
  related_record_id: string;
  /** Title used by `createAIAlert` and the notifier. Excludes live metrics. */
  title: string;
  /** Verbose breach description with live metric values. */
  description: string;
  /** Suggested next step shown next to the breach. */
  suggestion: string;
  /** Compact one-liner (e.g. "42% over 60m") suitable for table rendering. */
  detail: string;
  /** Live metric values that drove the breach — useful for tooltips/tests. */
  observed: {
    call_count: number;
    error_count: number;
    error_rate_pct: number;
    p95_latency_ms: number;
    avg_latency_ms: number;
    max_latency_ms: number;
  };
}

/**
 * Pure breach-evaluator extracted from {@link runToolHealthCheck} so the
 * dry-run "Preview impact" endpoint (POST /api/ai-ops/tool-health-config/
 * preview) can re-use the exact same severity ladder, threshold comparison,
 * and human-readable strings the live cron uses — without writing any
 * `ai_alerts` rows or paging on-call.
 *
 * Contract:
 *   • No I/O. Given the same inputs, returns the same output.
 *   • A tool can produce 0, 1, or 2 candidates (one per breach reason).
 *   • Order matches the input aggregate order; for a single tool the
 *     "error_rate" candidate is emitted before "p95_latency" so the cron
 *     loop and the preview UI agree on rendering order.
 *   • Aggregates whose `call_count < cfg.minCalls` should be filtered out
 *     by the caller (the SQL aggregator already does this for the cron;
 *     the preview endpoint applies the same filter explicitly so a
 *     stricter `minCalls` in a proposed override actually narrows the
 *     would-be breach list).
 */
export function evaluateWindowAggregates(
  aggregates: ToolWindowAggregate[],
  cfg: EffectiveToolHealthConfig,
): ToolHealthBreachCandidate[] {
  const out: ToolHealthBreachCandidate[] = [];
  for (const agg of aggregates) {
    if (agg.call_count < cfg.minCalls) continue;

    if (agg.error_rate_pct >= cfg.errorRatePct) {
      const severity = severityForErrorRate(cfg, agg.error_rate_pct);
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
      out.push({
        tool_name: agg.tool_name,
        agent_name: agg.agent_name,
        reason: "error_rate",
        severity,
        related_record_id: `${agg.tool_name}:error_rate`,
        title,
        description,
        suggestion,
        detail: `${agg.error_rate_pct}% over ${cfg.windowMinutes}m`,
        observed: {
          call_count: agg.call_count,
          error_count: agg.error_count,
          error_rate_pct: agg.error_rate_pct,
          p95_latency_ms: agg.p95_latency_ms,
          avg_latency_ms: agg.avg_latency_ms,
          max_latency_ms: agg.max_latency_ms,
        },
      });
    }

    if (agg.p95_latency_ms >= cfg.p95LatencyMs) {
      const severity = severityForLatency(cfg, agg.p95_latency_ms);
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
      out.push({
        tool_name: agg.tool_name,
        agent_name: agg.agent_name,
        reason: "p95_latency",
        severity,
        related_record_id: `${agg.tool_name}:p95_latency`,
        title,
        description,
        suggestion,
        detail: `${agg.p95_latency_ms}ms over ${cfg.windowMinutes}m`,
        observed: {
          call_count: agg.call_count,
          error_count: agg.error_count,
          error_rate_pct: agg.error_rate_pct,
          p95_latency_ms: agg.p95_latency_ms,
          avg_latency_ms: agg.avg_latency_ms,
          max_latency_ms: agg.max_latency_ms,
        },
      });
    }
  }
  return out;
}

export interface ToolHealthCheckResult {
  toolsEvaluated: number;
  alertsCreated: number;
  alertsSkippedDuplicate: number;
  alertsAutoResolved: number;
  /**
   * 1 when this pass auto-cleared a time-boxed override row whose
   * `expires_at` had passed (Task #191). 0 otherwise. Distinct from
   * `alertsAutoResolved` so dashboards can break out the two sources of
   * "automatic" cron activity.
   */
  expiredOverridesReaped: number;
  /**
   * 1 when a pre-warning ChatProvider message was dispatched this pass because
   * an override row's `expires_at` falls within the look-ahead window
   * (Task #219). 0 when the pass produced no pre-warning (not in window,
   * already deduped, no channel configured, or ChatProvider failure).
   */
  overrideExpirySoonWarningSent: number;
  /** Counts on-call pages dispatched for newly-created breach alerts. */
  notificationsSent: number;
  /**
   * Counts breaches where the notifier short-circuited because nothing
   * is configured (no ChatProvider channel, no email recipient). Useful to spot
   * environments where the alert pipeline is not actually wired up.
   */
  notificationsSkipped: number;
  /**
   * Counts breaches where the notifier was throttled by its in-process
   * dedupe window. Distinct from `alertsSkippedDuplicate` (which is the
   * DB-row dedupe).
   */
  notificationsThrottled: number;
  /**
   * Counts breaches where the notifier returned without delivering on any
   * configured channel (or threw outright) and a dead-letter `ai_alerts`
   * row was written so on-call can see the missed page in the AI Operations
   * panel (Task #288). Counts attempted writes, not just successful ones —
   * a DB failure during the dead-letter write itself is logged but does
   * not increment this counter (see `dispatchBreachNotification`).
   */
  notificationsDeadLettered: number;
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
  /**
   * Fetches all open / acknowledged `tool_health` alerts. Used by the
   * "silent tool" sweep to find alerts for tools that have had zero calls
   * in the cooldown window and can therefore be auto-resolved.
   */
  getOpenAlertsByType: typeof getOpenAlertsByType;
  /**
   * Returns the set of tool names with at least one call in the last N
   * minutes. Used by the silent-tool sweep to distinguish active tools from
   * deprecated / idle ones.
   */
  getToolsWithCallsInWindow: typeof getToolsWithCallsInWindow;
  resolveAlert: typeof resolveAlert;
  /**
   * Pages on-call about a freshly-opened `tool_health` alert. Defaults to
   * the production ChatProvider/email pipeline; tests stub this to capture pages
   * without touching real services.
   */
  notifyToolHealthBreach: typeof notifyToolHealthBreach;
  /**
   * Loads the per-instance threshold overrides set from the AI Operations
   * panel. Optional so legacy stubs (which only care about breach plumbing)
   * stay backwards-compatible — the cron falls back to the DB-backed loader
   * when this is omitted, and that loader resolves to `{}` on failure so a
   * missing overrides table can never crash the run.
   */
  loadOverrides?: () => Promise<ToolHealthConfigOverrides>;
  /**
   * Clears any time-boxed override row whose `expires_at` has passed and
   * writes a "system: override expired" audit entry (Task #191). Optional so
   * existing stubs need no churn — the production default delegates to
   * {@link reapExpiredToolHealthOverrides}, and a test that doesn't care
   * about the auto-revert path can leave it unstubbed.
   */
  reapExpiredOverrides?: () => Promise<ReapExpiredToolHealthOverridesResult>;
  /**
   * Posts a ChatProvider message announcing the auto-revert when the reaper
   * clears an expired override (Task #213). Optional so existing stubs
   * stay backwards-compatible — the production default delegates to
   * {@link notifyToolHealthOverrideExpired}, and tests can stub it to
   * capture the call without touching real ChatProvider.
   */
  notifyOverrideExpired?: typeof notifyToolHealthOverrideExpired;
  /**
   * Pages on-call when a `tool_health` alert auto-resolves (Task #167).
   * Optional so existing stubs need no churn — the production default
   * delegates to {@link notifyToolHealthRecovery}, and tests can stub
   * it to capture recovery pages without touching real ChatProvider/email.
   */
  notifyToolHealthRecovery?: typeof notifyToolHealthRecovery;
  /**
   * Posts a ChatProvider pre-warning when an override row's `expires_at` is
   * within the look-ahead window (Task #219). Optional so existing stubs
   * stay backwards-compatible — the production default delegates to
   * {@link notifyToolHealthOverrideExpiringSoon}, and tests can stub it
   * to capture the call without touching real ChatProvider.
   */
  notifyOverrideExpiringSoon?: typeof notifyToolHealthOverrideExpiringSoon;
  /**
   * Checks whether the live override row is expiring within the look-ahead
   * window (Task #219). Optional; the production default delegates to
   * {@link getToolHealthOverrideExpiringSoon}. Tests can stub it to
   * simulate an imminent expiry without touching the DB.
   */
  checkOverrideExpiringSoon?: (
    windowMs: number,
  ) => ReturnType<typeof getToolHealthOverrideExpiringSoon>;
  /**
   * Writes a dead-letter `ai_alerts` row when the breach notifier fails
   * to deliver on any channel (Task #288). Optional so existing stubs need
   * no churn — the production default delegates to
   * {@link recordToolHealthNotifyDeadLetter}, and tests can stub it to
   * capture the dead-letter call without touching the DB.
   */
  recordNotifyDeadLetter?: typeof recordToolHealthNotifyDeadLetter;
}

const DEFAULT_DEPS: Required<ToolHealthDeps> = {
  getToolWindowAggregates,
  openAlertExistsByKey,
  createAIAlert,
  getOpenAlertsByKey,
  getOpenAlertsByType,
  getToolsWithCallsInWindow,
  resolveAlert,
  notifyToolHealthBreach,
  loadOverrides: getToolHealthConfigOverrides,
  reapExpiredOverrides: reapExpiredToolHealthOverrides,
  notifyOverrideExpired: notifyToolHealthOverrideExpired,
  notifyToolHealthRecovery,
  notifyOverrideExpiringSoon: notifyToolHealthOverrideExpiringSoon,
  checkOverrideExpiringSoon: getToolHealthOverrideExpiringSoon,
  recordNotifyDeadLetter: recordToolHealthNotifyDeadLetter,
};

/**
 * Builds an alert row for a breach. Returns the freshly-created alert when
 * a new row was inserted, or `null` when a matching open/acknowledged alert
 * already exists for the same (tool_name, reason) — keyed on
 * `related_record_id`, NOT on `title`, because titles intentionally stay
 * free of live metric values to keep dedupe stable across runs.
 *
 * The returned id (when present) is forwarded into the ChatProvider/email page so
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
): Promise<
  { created: true; alertId: number | undefined } | { created: false }
> {
  const relatedRecordId = `${agg.tool_name}:${reason}`;
  const exists = await deps.openAlertExistsByKey(
    "tool_health",
    relatedRecordId,
  );
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
 * abort the surrounding cron pass — a ChatProvider outage must not stop us
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
    // Notifier itself crashed (not a per-channel failure it could swallow).
    // Log first so the stack survives even if the dead-letter write also
    // fails, then attempt the dead-letter so on-call sees the missed page
    // in the AI Operations panel (Task #288).
    logger.error(`[ToolHealth] Notifier threw for ${relatedRecordId}:`, err);
    await writeNotifyDeadLetter(
      deps,
      {
        relatedRecordId,
        tool_name: agg.tool_name,
        reason,
        severity,
        title,
        alertId,
        failureReason: `notifier threw: ${err instanceof Error ? err.message : String(err)}`,
      },
      out,
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
  if (result.ChatProviderSent || result.emailSent) {
    out.notificationsSent++;
    return;
  }
  // Notifier ran to completion but neither ChatProvider nor email actually
  // delivered the page. Either every configured channel returned a
  // soft-fail (ChatProvider `chat.postMessage` returned `ok:false`, EmailProvider
  // returned `success:false`, etc.) or the channels we did try all
  // threw and the notifier swallowed the error. Either way the page
  // was missed — write a dead-letter row so ops can see it.
  await writeNotifyDeadLetter(
    deps,
    {
      relatedRecordId,
      tool_name: agg.tool_name,
      reason,
      severity,
      title,
      alertId,
      failureReason:
        "ChatProvider/email delivery returned success=false on every configured channel",
    },
    out,
  );
}

/**
 * Writes a dead-letter `ai_alerts` row capturing a missed on-call page
 * (Task #288). Wrapped in its own try/catch so a transient DB issue cannot
 * abort the surrounding cron pass — the structured log line ensures the
 * miss is still discoverable via the log sink even when the row write
 * itself fails.
 *
 * Increments `out.notificationsDeadLettered` only on a successful row
 * write so the counter reflects what's actually queryable from the AI
 * Operations panel; a failed write surfaces only via the structured log.
 */
async function writeNotifyDeadLetter(
  deps: ToolHealthDeps,
  args: {
    relatedRecordId: string;
    tool_name: string;
    reason: ToolHealthReason;
    severity: AlertSeverity;
    title: string;
    alertId: number | undefined;
    failureReason: string;
  },
  out: ToolHealthCheckResult,
): Promise<void> {
  // Structured log line so ops/log-sink users can also count missed pages
  // without querying the DB. Tag is grep-friendly and stable.
  logger.error(
    `[ToolHealth][DEAD_LETTER] On-call page not delivered for ` +
      `${args.relatedRecordId}` +
      (args.alertId != null ? ` (alert #${args.alertId})` : "") +
      `: ${args.failureReason}`,
  );
  const writer =
    deps.recordNotifyDeadLetter ?? recordToolHealthNotifyDeadLetter;
  try {
    await writer({
      related_record_id: args.relatedRecordId,
      tool_name: args.tool_name,
      reason: args.reason,
      breach_severity: args.severity,
      breach_title: args.title,
      breach_alert_id: args.alertId,
      failure_reason: args.failureReason,
    });
    out.notificationsDeadLettered++;
  } catch (err) {
    logger.error(
      `[ToolHealth][DEAD_LETTER] Failed to persist dead-letter row for ` +
        `${args.relatedRecordId}:`,
      err,
    );
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
 *
 * After each successful resolution, pages on-call via
 * `deps.notifyToolHealthRecovery` so the on-call team learns the incident
 * is over without having to poll the dashboard (Task #167).
 */
async function maybeResolveRecoveredAlert(
  deps: Required<ToolHealthDeps>,
  cfg: EffectiveToolHealthConfig,
  agg: ToolWindowAggregate,
  reason: ToolHealthReason,
  out: ToolHealthCheckResult,
): Promise<void> {
  const relatedRecordId = `${agg.tool_name}:${reason}`;
  let openAlerts;
  try {
    openAlerts = await deps.getOpenAlertsByKey("tool_health", relatedRecordId, {
      olderThanMinutes: cfg.windowMinutes,
    });
  } catch (err) {
    logger.error(
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
        // Task #167: page on-call about the recovery. Best-effort — a
        // ChatProvider/email outage must not stop us processing remaining tools.
        try {
          await deps.notifyToolHealthRecovery({
            tool_name: agg.tool_name,
            agent_name: agg.agent_name ?? null,
            reason,
            alert_id: alert.id,
            detail: note,
            // Pass `created_at` so the recovery message can render the
            // "Open for: …" duration. Optional — omitted when the column
            // is null on legacy rows so the renderer just hides the field.
            alert_created_at: alert.created_at ?? null,
          });
        } catch (notifyErr) {
          logger.error(
            `[ToolHealth] Recovery notifier threw for alert ${alert.id} (${relatedRecordId}):`,
            notifyErr,
          );
        }
      }
    } catch (err) {
      logger.error(
        `[ToolHealth] Failed to auto-resolve alert ${alert.id} (${relatedRecordId}):`,
        err,
      );
    }
  }
}

/**
 * Auto-resolves open `tool_health` alerts for tools that have "gone silent"
 * — i.e. had zero calls in the last `silentCooldownMinutes`. This handles
 * the case where a tool is deprecated or simply stopped being called: the
 * normal recovery sweep never fires because the tool never appears in the
 * per-tool aggregates again, so without this sweep those alerts stay open
 * forever.
 *
 * The `silentCooldownMinutes` floor prevents closing a brand-new alert
 * immediately after a tool restarts — the alert must be old enough that the
 * entire cooldown window is post-silence.
 *
 * Only alerts whose `related_record_id` contains a tool name NOT present in
 * `activeTools` are candidates. The resolution note clearly states "tool
 * went silent" so it is distinguishable from the "metric back below
 * threshold" note written by `maybeResolveRecoveredAlert`.
 */
export async function runSilentToolSweep(
  deps: ToolHealthDeps,
  silentCooldownMinutes: number,
  out: ToolHealthCheckResult,
): Promise<void> {
  let openAlerts: Awaited<ReturnType<typeof getOpenAlertsByType>>;
  let activeTools: Set<string>;
  try {
    [openAlerts, activeTools] = await Promise.all([
      deps.getOpenAlertsByType("tool_health", {
        olderThanMinutes: silentCooldownMinutes,
      }),
      deps.getToolsWithCallsInWindow(silentCooldownMinutes),
    ]);
  } catch (err) {
    logger.error("[ToolHealth] Silent-tool sweep: failed to load data:", err);
    return;
  }

  for (const alert of openAlerts) {
    if (alert.id == null || !alert.related_record_id) continue;

    // related_record_id is "<tool_name>:<reason>" (e.g. "myTool:error_rate")
    const colonIdx = alert.related_record_id.indexOf(":");
    if (colonIdx === -1) continue;
    const toolName = alert.related_record_id.slice(0, colonIdx);

    // Skip if the tool is still active within the cooldown window.
    if (activeTools.has(toolName)) continue;

    const note =
      `auto-resolved: tool went silent — no calls recorded in the last ` +
      `${silentCooldownMinutes} minutes (cooldown window)`;
    try {
      const resolved = await deps.resolveAlert(alert.id, note);
      if (resolved) {
        out.alertsAutoResolved++;
        out.recoveries.push({
          tool_name: toolName,
          reason: alert.related_record_id.slice(
            colonIdx + 1,
          ) as ToolHealthReason,
          alert_id: alert.id,
          detail: note,
        });
        logger.info(
          `[ToolHealth] Silent-tool sweep: closed alert ${alert.id} ` +
            `for "${alert.related_record_id}" (silent for ≥${silentCooldownMinutes}m).`,
        );
      }
    } catch (err) {
      logger.error(
        `[ToolHealth] Silent-tool sweep: failed to resolve alert ${alert.id}:`,
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
 *
 * Additionally runs a "silent tool" sweep that closes any open alert whose
 * tool has had zero calls in the last `TOOL_HEALTH_SILENT_COOLDOWN_MULT ×
 * windowMinutes` minutes, so deprecated or retired tools don't leave their
 * alerts open forever.
 */
export async function runToolHealthCheck(
  depsOverride?: Partial<ToolHealthDeps>,
): Promise<ToolHealthCheckResult> {
  const deps: Required<ToolHealthDeps> = {
    ...DEFAULT_DEPS,
    ...(depsOverride ?? {}),
    loadOverrides: depsOverride?.loadOverrides ?? DEFAULT_DEPS.loadOverrides,
    reapExpiredOverrides:
      depsOverride?.reapExpiredOverrides ?? DEFAULT_DEPS.reapExpiredOverrides,
    notifyOverrideExpired:
      depsOverride?.notifyOverrideExpired ?? DEFAULT_DEPS.notifyOverrideExpired,
    notifyToolHealthRecovery:
      depsOverride?.notifyToolHealthRecovery ??
      DEFAULT_DEPS.notifyToolHealthRecovery,
    notifyOverrideExpiringSoon:
      depsOverride?.notifyOverrideExpiringSoon ??
      DEFAULT_DEPS.notifyOverrideExpiringSoon,
    checkOverrideExpiringSoon:
      depsOverride?.checkOverrideExpiringSoon ??
      DEFAULT_DEPS.checkOverrideExpiringSoon,
  };

  // Task #219: check for an override that is about to expire and, if found,
  // send one ChatProvider pre-warning so admins can extend it before the reaper
  // fires. This runs BEFORE the reaper so the row is still present. The
  // notifier dedupes on the expires_at ISO key — only one post per expiry
  // per process lifetime, no matter how many ticks fall inside the window.
  // Best-effort: failure is logged but never blocks the surrounding pass.
  const warnWindowMs = envInt("TOOL_HEALTH_OVERRIDE_WARN_MIN", 30) * 60_000;
  let overrideExpirySoonWarningSent = 0;
  if (warnWindowMs > 0) {
    try {
      const expiringSoon = await deps.checkOverrideExpiringSoon(warnWindowMs);
      if (expiringSoon) {
        const warnResult = await deps.notifyOverrideExpiringSoon({
          expires_at: expiringSoon.expires_at,
          previous_updated_by: expiringSoon.updated_by,
          overrides: expiringSoon.overrides as Record<
            string,
            number | undefined
          >,
          minutes_remaining: expiringSoon.minutes_remaining,
        });
        if (warnResult.ChatProviderSent) {
          overrideExpirySoonWarningSent = 1;
          logger.info(
            `[ToolHealth] Sent override expiry pre-warning: expires_at=` +
              `${expiringSoon.expires_at.toISOString()}, ` +
              `~${expiringSoon.minutes_remaining}m remaining.`,
          );
        } else if (!warnResult.deduped && !warnResult.skipped) {
          logger.info(
            `[ToolHealth] Override expiry pre-warning: ChatProvider send returned false ` +
              `(expires_at=${expiringSoon.expires_at.toISOString()}).`,
          );
        }
      }
    } catch (warnErr) {
      logger.error("[ToolHealth] Override expiry pre-warning failed:", warnErr);
    }
  }

  // Reap any expired override rows BEFORE loading the merged config so
  // (a) the audit trail records the auto-revert at the precise moment the
  // cron tick noticed it, and (b) the merge below sees the cleared values
  // without relying on the read-path's defensive expired-filter. A reaper
  // failure is logged but never blocks the pass — the read path will still
  // hide expired values, so worst case the audit row gets written on the
  // next tick.
  let reaperResult: ReapExpiredToolHealthOverridesResult | null = null;
  try {
    reaperResult = await deps.reapExpiredOverrides();
    if (reaperResult.reaped) {
      logger.info(
        `[ToolHealth] Reaped expired override row (audit_id=${reaperResult.audit_id}, ` +
          `expired_at=${reaperResult.expired_at?.toISOString?.() ?? reaperResult.expired_at}). ` +
          `Cleared keys: ${Object.keys(reaperResult.cleared_overrides).join(", ") || "(none)"}.`,
      );
    }
  } catch (err) {
    logger.error("[ToolHealth] Override reaper failed:", err);
  }

  // Task #213: when the reaper actually swept a row, push a ChatProvider post to
  // the tool-health channel so on-call notices that the override silencing
  // alerts has just lifted. This is strictly best-effort: the override
  // and audit row have already been written to the database — a ChatProvider
  // outage must not abort the surrounding cron tick or undo the revert.
  if (reaperResult?.reaped) {
    try {
      await deps.notifyOverrideExpired({
        cleared_overrides: reaperResult.cleared_overrides,
        previous_updated_by: reaperResult.previous_updated_by,
        expired_at: reaperResult.expired_at,
        audit_id: reaperResult.audit_id,
      });
    } catch (err) {
      logger.error(
        "[ToolHealth] Override auto-revert ChatProvider notification failed:",
        err,
      );
    }
  }

  // Re-read overrides on every pass so live edits from the AI Ops panel
  // take effect at the next tick without a worker restart.
  const cfg: EffectiveToolHealthConfig = await getEffectiveToolHealthConfig(
    deps.loadOverrides,
  );
  // Validate the *merged* config (env + DB overrides). This catches both
  // env-var misconfiguration that was suppressed at module load (e.g. tests
  // that mutate env after import) and a bad override pushed through the
  // AI Ops panel. Idempotent: only logs new misconfigurations once per
  // process to avoid log spam.
  ensureThresholdValidationLogged(cfg);
  const out: ToolHealthCheckResult = {
    toolsEvaluated: 0,
    alertsCreated: 0,
    alertsSkippedDuplicate: 0,
    alertsAutoResolved: 0,
    expiredOverridesReaped: reaperResult?.reaped ? 1 : 0,
    overrideExpirySoonWarningSent,
    notificationsSent: 0,
    notificationsSkipped: 0,
    notificationsThrottled: 0,
    notificationsDeadLettered: 0,
    breaches: [],
    recoveries: [],
  };

  let aggregates: ToolWindowAggregate[];
  try {
    aggregates = await deps.getToolWindowAggregates(
      cfg.windowMinutes,
      cfg.minCalls,
    );
  } catch (err) {
    logger.error("[ToolHealth] Failed to load per-tool aggregates:", err);
    return out;
  }

  out.toolsEvaluated = aggregates.length;

  // Evaluate breaches via the pure helper. The cron path then layers on
  // DB writes (createAIAlert) and on-call paging (notifyToolHealthBreach);
  // the dry-run preview endpoint just JSON-serializes the same candidates.
  const candidates = evaluateWindowAggregates(aggregates, cfg);
  const candidatesByKey = new Map<string, ToolHealthBreachCandidate>();
  for (const cand of candidates) {
    candidatesByKey.set(cand.related_record_id, cand);
  }

  for (const agg of aggregates) {
    // Error-rate: breach → write+page; otherwise → recovery sweep.
    const errCand = candidatesByKey.get(`${agg.tool_name}:error_rate`);
    if (errCand) {
      try {
        const result = await maybeCreateBreachAlert(
          deps,
          agg,
          "error_rate",
          errCand.severity,
          errCand.title,
          errCand.description,
          errCand.suggestion,
        );
        if (result.created) {
          out.alertsCreated++;
          out.breaches.push({
            tool_name: errCand.tool_name,
            reason: "error_rate",
            severity: errCand.severity,
            detail: errCand.detail,
          });
          // Page on-call now that we know this is a brand-new alert. The
          // notifier inherits the (alert_type, related_record_id) dedupe
          // semantics for free because we only call it on `created=true`.
          await dispatchBreachNotification(
            deps,
            agg,
            "error_rate",
            errCand.severity,
            errCand.title,
            errCand.description,
            errCand.suggestion,
            result.alertId,
            out,
          );
        } else {
          out.alertsSkippedDuplicate++;
        }
      } catch (err) {
        logger.error(
          `[ToolHealth] Failed to create error-rate alert for ${agg.tool_name}:`,
          err,
        );
      }
    } else {
      // Error-rate is back below threshold for this tool's window —
      // close any matching open alert (subject to cooldown).
      await maybeResolveRecoveredAlert(deps, cfg, agg, "error_rate", out);
    }

    // p95 latency: breach → write+page; otherwise → recovery sweep.
    const latCand = candidatesByKey.get(`${agg.tool_name}:p95_latency`);
    if (latCand) {
      try {
        const result = await maybeCreateBreachAlert(
          deps,
          agg,
          "p95_latency",
          latCand.severity,
          latCand.title,
          latCand.description,
          latCand.suggestion,
        );
        if (result.created) {
          out.alertsCreated++;
          out.breaches.push({
            tool_name: latCand.tool_name,
            reason: "p95_latency",
            severity: latCand.severity,
            detail: latCand.detail,
          });
          await dispatchBreachNotification(
            deps,
            agg,
            "p95_latency",
            latCand.severity,
            latCand.title,
            latCand.description,
            latCand.suggestion,
            result.alertId,
            out,
          );
        } else {
          out.alertsSkippedDuplicate++;
        }
      } catch (err) {
        logger.error(
          `[ToolHealth] Failed to create latency alert for ${agg.tool_name}:`,
          err,
        );
      }
    } else {
      // p95 latency is back below threshold for this tool's window —
      // close any matching open alert (subject to cooldown).
      await maybeResolveRecoveredAlert(deps, cfg, agg, "p95_latency", out);
    }
  }

  // Silent-tool sweep: close any open tool_health alert whose tool has had
  // zero calls for at least silentCooldownMinutes. This handles deprecated or
  // retired tools that never appear in the per-tool aggregates again and
  // would otherwise keep their alerts open forever.
  const silentCooldownMinutes =
    TOOL_HEALTH_SILENT_COOLDOWN_MULT * cfg.windowMinutes;
  await runSilentToolSweep(deps, silentCooldownMinutes, out);

  // NOTE (Task #639): Unlike the sibling prompt-regression cron, this cron
  // has no batch breach-summary notifier call after the per-tool loop, so
  // there is nothing to gate on `out.breaches.length > 0` here. Pages are
  // dispatched per-breach inside `dispatchBreachNotification`, only from the
  // `if (result.created)` branches above — so on a recovery-only tick (every
  // would-be breach skipped as a duplicate, only auto-resolves happening)
  // the breach notifier is structurally never reached and admins do not get
  // an empty "0 new regressions detected" ChatProvider/email page. The recovery-
  // only-tick test in tests/toolHealthAlertsCron.test.ts locks this contract
  // in so a future refactor that adds a digest-style summary notifier here
  // cannot reintroduce that bug without first updating the test.

  if (
    out.alertsCreated > 0 ||
    out.breaches.length > 0 ||
    out.alertsAutoResolved > 0
  ) {
    logger.info("[ToolHealth] Check complete:", out);
  } else {
    logger.info(
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
      // Cooperative singleton guard via pg session-level advisory lock.
      // Two purposes:
      //  1. In multi-replica deploys, prevents two cron ticks firing
      //     simultaneously from racing on `tool_health_config_overrides`
      //     (id=1 singleton) and writing duplicate audit/notification rows.
      //  2. Lets `tests/toolHealthConfigDatabase.test.ts` and the auto-revert
      //     test in `tests/aiOpsRoutes.test.ts` serialize against the cron
      //     by holding the same lock — without this, the cron tick can
      //     reap the test's seeded expired row before the test's own
      //     assertions observe it (manifests as "got 0 reaped, got 2
      //     not_reaped" in the post-merge run).
      // Lock key matches both tests (see SINGLETON_LOCK_KEY there).
      const SINGLETON_LOCK_KEY = <REDACTED_PHONE>;
      const { sharedPool } = await import("../../utils/sharedPool");
      const lockClient = await sharedPool.connect();
      try {
        const got = await lockClient.query(
          "SELECT pg_try_advisory_lock($1) AS locked",
          [SINGLETON_LOCK_KEY],
        );
        if (!got.rows[0]?.locked) {
          logger.debug(
            "[ToolHealth] Cron pass skipped — advisory lock held by another worker or test.",
          );
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
        try {
          return await runToolHealthCheck();
        } finally {
          try {
            await lockClient.query("SELECT pg_advisory_unlock($1)", [
              SINGLETON_LOCK_KEY,
            ]);
          } catch (err) {
            logger.error(
              "[ToolHealth] Failed to release singleton advisory lock:",
              err,
            );
          }
        }
      } finally {
        lockClient.release();
      }
    });
  },
);
