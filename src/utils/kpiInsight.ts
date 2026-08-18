/**
 * Per-KPI "what's inside / gaps" for the KPI detail page.
 *
 * Rather than export a dozen internal calculators, we reuse the two things that
 * already compute the breakdown: the checklist rate (for action-plan KPIs) and
 * the leadership feed (which returns a `details` object per KPI). This keeps one
 * source of truth for each number and avoids the canonical↔feed code drift
 * leaking into yet another place — the mapping lives here, in one small table.
 */
import { logger } from "./logger";

/** Canonical KPI code → leadership-feed code, for KPIs whose gaps come from the feed. */
const CANONICAL_TO_FEED: Record<string, string> = {
  "QM-KPI-002": "QM-KPI-002", // Audit Execution
  "GRC-KPI-008": "GRC-KPI-008", // Compliance Coverage
  "GRC-KPI-010": "GRC-KPI-009", // Risk Register Quality Index (feed calls it Risk Assessment Coverage)
  "GRC-KPI-002": "GRC-KPI-002", // Certification Milestones
  "GRC-KPI-003": "GRC-KPI-003", // Evidence Readiness
  "GRC-KPI-005": "GRC-KPI-005", // Risk Treatment On-Time
};

const CHECKLIST_CODES = ["QM-KPI-015", "QM-KPI-008", "QM-KPI-004"];

export interface KpiInsight {
  kind: "checklist" | "auto" | "manual" | "none";
  value?: number | null;
  data_available?: boolean;
  reason?: string | null;
  details?: Record<string, unknown> | null;
}

/**
 * KPIs whose value ACCUMULATES across the year, so "40% of target with 63% of
 * the year gone" is a meaningful statement. An average (ASP), a rate (Meeting
 * Conversion) and a point-in-time snapshot (Qualified Pipeline) do not
 * accumulate — quoting pace on them would invent a trend that isn't there.
 */
const YEAR_CUMULATIVE_CODES = new Set(["ADHOC-SALES-01"]);

/** Money in the BI portal's shorthand; other units keep their own suffix. */
function fmtUnit(n: number, unit: string | null | undefined): string {
  if (String(unit || "").toUpperCase() === "SAR") {
    const abs = Math.abs(n);
    if (abs >= 1e6) return `SAR ${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
    if (abs >= 1e3) return `SAR ${Math.round(n / 1e3)}K`;
    return `SAR ${Math.round(n)}`;
  }
  const v = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return unit === "days" ? `${v} days` : unit && unit !== "number" ? `${v}${unit}` : v;
}

/** Share of the calendar year already elapsed, as a percentage. */
function yearElapsedPct(now = new Date()): number {
  const start = Date.UTC(now.getUTCFullYear(), 0, 1);
  const end = Date.UTC(now.getUTCFullYear() + 1, 0, 1);
  return Math.round(((now.getTime() - start) / (end - start)) * 1000) / 10;
}

/**
 * Fallback breakdown for any KPI with no bespoke insight: how far the recorded
 * value sits from its target.
 *
 * The panel used to say "No live breakdown for this KPI type" for these, which
 * on the ad-hoc Sales KPIs was the whole panel -- a heading promising gaps,
 * followed by a sentence saying there are none to show.
 *
 * Deliberately reads the STORED value rather than re-running the calculator:
 * a detail-page render must not trigger a 22k-row scan (the Quality Reports 504
 * lesson), and reading what was recorded guarantees this panel agrees with the
 * number printed above it.
 */
async function gapToTarget(code: string): Promise<KpiInsight> {
  const { getKPIByCode, getLatestKPIValue } = await import("./kpiDatabase");
  const def: any = await getKPIByCode(code);
  const target = def?.target_value == null ? null : Number(def.target_value);
  // No target means no gap to state — fall back to the old empty panel rather
  // than inventing a comparison.
  if (!def?.id || target === null || !Number.isFinite(target) || target === 0) {
    return { kind: "none" };
  }
  const latest: any = await getLatestKPIValue(def.id);
  if (!latest || latest.actual_value == null) {
    return { kind: "auto", data_available: false, reason: "not calculated yet — run Recalculate" };
  }
  const actual = Number(latest.actual_value);
  if (!Number.isFinite(actual)) return { kind: "none" };

  const lowerIsBetter = def.threshold_direction === "lower_is_better";
  const gap = lowerIsBetter ? actual - target : target - actual;
  const details: Record<string, unknown> = {
    target: fmtUnit(target, def.unit),
    attainment_of_target: `${Math.round((actual / target) * 1000) / 10}%`,
    [gap > 0 ? "gap_to_target" : "ahead_of_target_by"]: fmtUnit(Math.abs(gap), def.unit),
    measured_period_ending: String(latest.period_end ?? "").slice(0, 10),
  };

  if (YEAR_CUMULATIVE_CODES.has(code)) {
    const elapsed = yearElapsedPct();
    const attained = (actual / target) * 100;
    details.year_elapsed = `${elapsed}%`;
    // Straight-line pace only. It ignores seasonality, so it is stated as a
    // comparison the reader can judge, not as a forecast.
    details.pace = attained >= elapsed
      ? `on or ahead of straight-line pace (${Math.round(attained * 10) / 10}% of target vs ${elapsed}% of the year)`
      : `behind straight-line pace (${Math.round(attained * 10) / 10}% of target vs ${elapsed}% of the year)`;
  }

  return { kind: "auto", value: actual, data_available: true, details };
}

export async function getKpiInsight(code: string): Promise<KpiInsight> {
  try {
    // 1) Action-plan / checklist KPIs — the page also embeds the full per-BU
    //    checklist; here we return the headline (# BUs complete of total).
    if (CHECKLIST_CODES.includes(code)) {
      const { actionPlanCompleteRate } = await import("./kpiChecklistDatabase");
      const r = await actionPlanCompleteRate(code);
      if (!r) return { kind: "checklist", data_available: false, reason: "no_checklist_items" };
      return {
        kind: "checklist",
        value: r.value,
        data_available: true,
        details: { bus_complete: r.complete, bus_total: r.total },
      };
    }

    // 2) Handoff Effectiveness — its own calculator with a rich breakdown.
    if (code === "GRQ-KPI-02") {
      const { calcHandoffEffectiveness } = await import("./handoffTasksDatabase");
      const r = await calcHandoffEffectiveness();
      return {
        kind: "auto",
        value: r.value,
        data_available: r.dataAvailable,
        reason: r.reason ?? null,
        details: r.details ?? null,
      };
    }

    // 3) Everything else with a feed calculator — pull the details from the feed.
    const feedCode = CANONICAL_TO_FEED[code];
    if (!feedCode) return gapToTarget(code);
    const { buildLeadershipKpiFeed } = await import("./leadershipKpiFeed");
    const feed = await buildLeadershipKpiFeed();
    const e = (feed.kpis || []).find((k: any) => k.code === feedCode);
    if (!e) return { kind: "none" };
    return {
      kind: "auto",
      value: e.value,
      data_available: e.data_available,
      reason: (e as any).unavailable_reason ?? null,
      details: e.details ?? null,
    };
  } catch (err) {
    logger.error(`[KpiInsight] ${code} failed: ${(err as Error).message}`);
    return { kind: "none", reason: "insight_unavailable" };
  }
}
