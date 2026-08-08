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
    if (!feedCode) return { kind: "none" };
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
