import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * Deals Lifecycle (Sales SOP Stage Aging) — reads the Deals Lifecycle tab so
 * Adam can answer "how many deals are stuck in Proposal past SLA?", "which
 * stage is bleeding pipeline?", or "who owns the most overdue deals?".
 *
 * Reuses scanDealStageAgingViolations (the same engine that powers the
 * Deals Lifecycle tab), so the numbers always match the dashboard. Read-only.
 */
export const dealStageAgingStatusTool = createTool({
  id: "deal-stage-aging-status",

  description:
    "Check the Deals Lifecycle tab in the Duplicate Radar — how many Sales-pipeline deals have aged past the WalaPlus Sales SOP stage SLAs (Not Attend Meeting ≤5 BD §7.2.8, Meeting ≤10 BD §7.3, On Hold 3-6 months §7.3.11, Proposal 3 months §7.4.2, Agreement Sent 3 months §7.5.1). Returns counts by severity (critical/warning), breakdown by stage, breakdown by owner, the top overdue deals, and the SOP spec itself. Use this whenever the user asks about stuck deals, stage aging, pipeline velocity, Sales SOP compliance, or which deals are past the per-stage allowance.",

  inputSchema: z.object({}),

  outputSchema: z.object({
    success: z.boolean(),
    totalDealsScanned: z.number(),
    totalTrackedStageDeals: z.number(),
    totalViolations: z.number(),
    bySeverity: z.record(z.number()),
    byStage: z.record(z.number()),
    byClause: z.record(z.number()),
    byOwner: z.array(
      z.object({
        ownerName: z.string().nullable(),
        ownerEmail: z.string().nullable(),
        violations: z.number(),
        critical: z.number(),
        warning: z.number(),
      }),
    ),
    topOverdue: z.array(
      z.object({
        dealName: z.string().nullable(),
        accountName: z.string().nullable(),
        stage: z.string(),
        ownerName: z.string().nullable(),
        agingUnits: z.number(),
        unit: z.string(),
        agingCalendarDays: z.number(),
        slaUnits: z.number(),
        severity: z.string(),
        clauseRef: z.string(),
      }),
    ),
    spec: z.array(
      z.object({
        stage: z.string(),
        unit: z.string(),
        sla: z.number(),
        clauseRef: z.string(),
      }),
    ),
    error: z.string().optional(),
  }),

  execute: async ({ mastra }) => {
    const logger = mastra?.getLogger();
    try {
      const { scanDealStageAgingViolations } = await import(
        "../../utils/duplicateRadarDatabase"
      );
      const { SALES_STAGE_SLA_SPEC } = await import(
        "../../utils/salesStageSlaSpec"
      );
      const r = await scanDealStageAgingViolations({ limit: 50000 });
      const s = r.summary;

      const ownerAgg = new Map<
        string,
        {
          ownerName: string | null;
          ownerEmail: string | null;
          violations: number;
          critical: number;
          warning: number;
        }
      >();
      for (const v of r.violations) {
        const key = (v.owner_email || v.owner_name || "(unassigned)").toLowerCase();
        const cur =
          ownerAgg.get(key) ?? {
            ownerName: v.owner_name ?? null,
            ownerEmail: v.owner_email ?? null,
            violations: 0,
            critical: 0,
            warning: 0,
          };
        cur.violations++;
        if (v.violation.severity === "critical") cur.critical++;
        if (v.violation.severity === "warning") cur.warning++;
        ownerAgg.set(key, cur);
      }
      const byOwner = Array.from(ownerAgg.values())
        .sort((a, b) => b.critical - a.critical || b.violations - a.violations)
        .slice(0, 10);

      const topOverdue = r.violations.slice(0, 10).map((v) => ({
        dealName: v.deal_name,
        accountName: v.account_name,
        stage: v.stage,
        ownerName: v.owner_name,
        agingUnits: v.violation.aging_units,
        unit: v.violation.unit,
        agingCalendarDays: v.violation.aging_calendar_days,
        slaUnits: v.violation.sla_units,
        severity: v.violation.severity,
        clauseRef: v.violation.clause_ref,
      }));

      logger?.info("📐 [dealStageAgingStatusTool] Deals Lifecycle scan", {
        totalTrackedStageDeals: s.total_tracked_deals,
        totalViolations: s.total_violations,
        critical: s.by_severity.critical,
        warning: s.by_severity.warning,
      });

      return {
        success: true,
        totalDealsScanned: s.total_evaluated,
        totalTrackedStageDeals: s.total_tracked_deals,
        totalViolations: s.total_violations,
        bySeverity: s.by_severity,
        byStage: s.by_stage,
        byClause: s.by_clause,
        byOwner,
        topOverdue,
        spec: SALES_STAGE_SLA_SPEC.map((spec) => ({
          stage: spec.stage,
          unit: spec.unit,
          sla: spec.sla,
          clauseRef: spec.clauseRef,
        })),
      };
    } catch (e: any) {
      return {
        success: false,
        totalDealsScanned: 0,
        totalTrackedStageDeals: 0,
        totalViolations: 0,
        bySeverity: {},
        byStage: {},
        byClause: {},
        byOwner: [],
        topOverdue: [],
        spec: [],
        error: e?.message || String(e),
      };
    }
  },
});
