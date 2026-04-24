/**
 * Prompt Regression Alert Cron
 *
 * Goal: proactively warn admins when a newer prompt version of an agent has a
 * thumbs-up feedback rate that has dropped meaningfully versus the best
 * version of the same agent in the rolling window. Today this regression is
 * only visible if someone opens the AI Operations dashboard. With this cron,
 * the same comparison runs every day and emits an `ai_alerts` row of type
 * `prompt_regression` so admins see it on the alerts feed even if nobody
 * happens to open the page.
 *
 * How it works:
 *   1. Calls `getFeedbackRateByPromptVersion(WINDOW_DAYS)` (default 30 days)
 *      — the same query the dashboard uses, so the rule applied here matches
 *      what an admin would see in the UI.
 *   2. Groups rows by agent. Only versions with at least MIN_FEEDBACK ratings
 *      are eligible to act as either "best" or "regressed" — a single
 *      thumbs-down against a brand-new version must not page someone.
 *   3. For each agent, picks the eligible version with the highest
 *      feedback_rate_pct as the "best". For every OTHER eligible version
 *      whose feedback_rate is at least DROP_PCT_POINTS percentage points
 *      lower, opens an `ai_alerts` row.
 *      Dedupe is keyed on (alert_type, related_record_id) where the related
 *      record id is `<agent>:<regressed_version>`, so the same regression
 *      doesn't spam the feed every day while it is still open. A new alert
 *      is only created once the previous one is resolved/dismissed or the
 *      regressed version recovers above the threshold.
 *
 * Configurable thresholds live in PROMPT_REGRESSION_THRESHOLDS below and can
 * be overridden via env vars.
 *
 * Reference task: #121 (Warn admins when a prompt change drops answer
 * quality).
 */

import { inngest } from "../inngest/client";
import {
  getFeedbackRateByPromptVersion,
  type PromptVersionAggregate,
} from "../../utils/aiTelemetry";
import {
  openAlertExistsByKey,
  createAIAlert,
  type AlertSeverity,
} from "../../utils/aiAlertsDatabase";

// ──────────────────────────────────────────────────────────────────────────────
// Single, env-overridable config block — thresholds live here so ops can
// tune without redeploying.
// ──────────────────────────────────────────────────────────────────────────────
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const PROMPT_REGRESSION_THRESHOLDS = {
  /** Rolling window (days) over which feedback is aggregated. */
  windowDays: envInt("PROMPT_REGRESSION_WINDOW_DAYS", 30),
  /**
   * Minimum number of recorded ratings (👍 + 👎) a prompt version must have
   * before it can either define the "best" baseline OR be reported as a
   * regression. Stops a brand-new version from triggering a page on a
   * single thumbs-down.
   */
  minFeedback: envInt("PROMPT_REGRESSION_MIN_FEEDBACK", 10),
  /**
   * Minimum drop in percentage points vs the best version for the same
   * agent before we open an alert. Matches the dashboard's existing 10pp
   * regression highlight.
   */
  dropPctPoints: envInt("PROMPT_REGRESSION_DROP_PCT_POINTS", 10),
  /** Cron expression — once a day at 06:30 UTC by default. */
  cron: process.env.PROMPT_REGRESSION_ALERT_CRON || "30 6 * * *",
  /** Where the alert links the admin to. */
  link: "/ai-ops?tab=prompts",
} as const;

function severityForDrop(dropPp: number): AlertSeverity {
  if (dropPp >= 30) return "critical";
  if (dropPp >= 20) return "high";
  // 10–19pp is the WARN tier we explicitly want surfaced (task #121).
  return "medium";
}

interface RegressionBreach {
  agent_name: string;
  regressed_version: string;
  best_version: string;
  regressed_rate_pct: number;
  best_rate_pct: number;
  drop_pp: number;
  regressed_feedback_count: number;
  best_feedback_count: number;
  severity: AlertSeverity;
}

export interface PromptRegressionCheckResult {
  agentsEvaluated: number;
  versionsEvaluated: number;
  alertsCreated: number;
  alertsSkippedDuplicate: number;
  breaches: RegressionBreach[];
}

/**
 * Dependency surface so the helper stays unit-testable in isolation: tests
 * can pass synthetic aggregates and capture the alerts that would have
 * been created without touching Postgres.
 */
export interface PromptRegressionDeps {
  fetchAggregates?: (days: number) => Promise<PromptVersionAggregate[]>;
  alertExists?: (relatedRecordId: string) => Promise<boolean>;
  createAlert?: (alert: {
    title: string;
    description: string;
    suggestion: string;
    severity: AlertSeverity;
    relatedRecordId: string;
  }) => Promise<void>;
}

const defaultDeps: Required<PromptRegressionDeps> = {
  fetchAggregates: (days) => getFeedbackRateByPromptVersion(days),
  alertExists: (relatedRecordId) =>
    openAlertExistsByKey("prompt_regression", relatedRecordId),
  createAlert: async ({
    title, description, suggestion, severity, relatedRecordId,
  }) => {
    await createAIAlert({
      alert_type: "prompt_regression",
      severity,
      title,
      description,
      suggestion,
      related_module: "ai_ops",
      related_record_id: relatedRecordId,
    });
  },
};

function toNumOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Evaluate per-(agent, prompt_version) feedback aggregates and emit
 * `ai_alerts` rows for any version that regressed by at least
 * DROP_PCT_POINTS vs the best eligible version for the same agent.
 *
 * Pure-ish: with the default deps it talks to Postgres; with stubbed deps
 * it is fully synchronous-IO-free and used by the unit test.
 */
export async function runPromptRegressionCheck(
  depsOverride: PromptRegressionDeps = {},
): Promise<PromptRegressionCheckResult> {
  const cfg = PROMPT_REGRESSION_THRESHOLDS;
  const deps = { ...defaultDeps, ...depsOverride };

  const out: PromptRegressionCheckResult = {
    agentsEvaluated: 0,
    versionsEvaluated: 0,
    alertsCreated: 0,
    alertsSkippedDuplicate: 0,
    breaches: [],
  };

  let aggregates: PromptVersionAggregate[];
  try {
    aggregates = await deps.fetchAggregates(cfg.windowDays);
  } catch (err) {
    console.error(
      "[PromptRegression] Failed to load prompt-version aggregates:",
      err,
    );
    return out;
  }

  // Group by agent. The aggregate query already buckets unknown versions as
  // "(unknown)"; we keep them so a regression away from a properly-versioned
  // baseline still surfaces, but we never let "(unknown)" *be* the baseline.
  const byAgent = new Map<string, PromptVersionAggregate[]>();
  for (const row of aggregates) {
    if (!row || !row.agent_name) continue;
    const list = byAgent.get(row.agent_name) ?? [];
    list.push(row);
    byAgent.set(row.agent_name, list);
  }
  out.agentsEvaluated = byAgent.size;
  out.versionsEvaluated = aggregates.length;

  for (const [agentName, rows] of byAgent.entries()) {
    // Eligible versions = enough feedback to be statistically meaningful
    // AND a real version label (not the "(unknown)" bucket). We still let
    // "(unknown)" rows be the *regressed* version so legacy traffic that
    // dropped after a known version shipped still pages.
    const eligibleForBaseline = rows.filter(
      (r) =>
        r.prompt_version !== "(unknown)" &&
        Number(r.total_feedback) >= cfg.minFeedback &&
        toNumOrNull(r.feedback_rate_pct) != null,
    );
    if (eligibleForBaseline.length < 2) {
      // Need at least two versions of the same agent to talk about a
      // regression at all.
      continue;
    }

    let best = eligibleForBaseline[0];
    let bestRate = toNumOrNull(best.feedback_rate_pct) ?? -Infinity;
    for (const r of eligibleForBaseline) {
      const rate = toNumOrNull(r.feedback_rate_pct);
      if (rate != null && rate > bestRate) {
        bestRate = rate;
        best = r;
      }
    }

    const eligibleForRegression = rows.filter(
      (r) => Number(r.total_feedback) >= cfg.minFeedback,
    );

    for (const r of eligibleForRegression) {
      if (r.prompt_version === best.prompt_version) continue;
      const rate = toNumOrNull(r.feedback_rate_pct);
      if (rate == null) continue;
      const drop = bestRate - rate;
      if (drop < cfg.dropPctPoints) continue;

      const severity = severityForDrop(drop);
      const relatedRecordId = `${agentName}:${r.prompt_version}`;
      const title =
        `Prompt regression: "${agentName}" version ` +
        `${r.prompt_version} feedback rate dropped vs best`;
      const description =
        `Agent "${agentName}" prompt version ${r.prompt_version} has a ` +
        `${rate.toFixed(0)}% thumbs-up rate over ${r.total_feedback} ` +
        `ratings (${r.thumbs_up}👍 / ${r.thumbs_down}👎) in the last ` +
        `${cfg.windowDays} days. The best-performing version for the same ` +
        `agent in the same window is ${best.prompt_version} at ` +
        `${bestRate.toFixed(0)}% (${best.thumbs_up}👍 / ${best.thumbs_down}👎 ` +
        `over ${best.total_feedback} ratings) — a ${drop.toFixed(0)}pp drop ` +
        `(threshold: ${cfg.dropPctPoints}pp; min sample: ${cfg.minFeedback}).`;
      const suggestion =
        `Open ${cfg.link} to compare the two prompt versions for ` +
        `"${agentName}". Review what changed in the agent's instructions ` +
        `between ${best.prompt_version} and ${r.prompt_version}; if the ` +
        `regression is intentional (e.g. stricter answers), dismiss the ` +
        `alert. Otherwise consider rolling the prompt back.`;

      try {
        const exists = await deps.alertExists(relatedRecordId);
        if (exists) {
          out.alertsSkippedDuplicate++;
          continue;
        }
        await deps.createAlert({
          title,
          description,
          suggestion,
          severity,
          relatedRecordId,
        });
        out.alertsCreated++;
        out.breaches.push({
          agent_name: agentName,
          regressed_version: r.prompt_version,
          best_version: best.prompt_version,
          regressed_rate_pct: rate,
          best_rate_pct: bestRate,
          drop_pp: drop,
          regressed_feedback_count: Number(r.total_feedback),
          best_feedback_count: Number(best.total_feedback),
          severity,
        });
      } catch (err) {
        console.error(
          `[PromptRegression] Failed to create alert for ` +
            `${agentName}:${r.prompt_version}:`,
          err,
        );
      }
    }
  }

  if (out.alertsCreated > 0) {
    console.log("[PromptRegression] Check complete:", {
      agentsEvaluated: out.agentsEvaluated,
      versionsEvaluated: out.versionsEvaluated,
      alertsCreated: out.alertsCreated,
      alertsSkippedDuplicate: out.alertsSkippedDuplicate,
      breaches: out.breaches.map((b) => ({
        agent: b.agent_name,
        regressed: b.regressed_version,
        best: b.best_version,
        drop_pp: Math.round(b.drop_pp),
        severity: b.severity,
      })),
    });
  } else {
    console.log(
      `[PromptRegression] Check complete — ${out.agentsEvaluated} agents, ` +
        `${out.versionsEvaluated} versions evaluated, 0 new alerts ` +
        `(skipped ${out.alertsSkippedDuplicate} duplicates).`,
    );
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Inngest cron — registered from src/mastra/inngest/index.ts.
// Kept here (not in inngest/index.ts) so the cron file lives next to the
// other workflow definitions, mirroring toolHealthAlertsCron.
// ──────────────────────────────────────────────────────────────────────────────
export const promptRegressionAlertsCronFunction = inngest.createFunction(
  { id: "prompt-regression-alerts" },
  { cron: PROMPT_REGRESSION_THRESHOLDS.cron },
  async ({ step }) => {
    return await step.run("evaluate-prompt-regressions", async () => {
      return await runPromptRegressionCheck();
    });
  },
);
