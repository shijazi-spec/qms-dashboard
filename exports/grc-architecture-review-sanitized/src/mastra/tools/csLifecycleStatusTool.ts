import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * CS Lifecycle status — reads the Duplicate Radar's CS Lifecycle tab data so
 * AssistantPersona can answer "how many deals are in the renewal stage?", "what's the CS
 * team's lifecycle picture?", or "what CS data-hygiene issues are open?".
 *
 * Reuses scanCsLifecycleViolations (the same engine that powers the CS
 * Lifecycle tab), so the numbers always match the dashboard. Read-only.
 */
export const csLifecycleStatusTool = createTool({
  id: "cs-lifecycle-status",

  description:
    "Check the CS Lifecycle tab in the Duplicate Radar — how many Customer Success deals are in each lifecycle phase (onboarding, adoption, renewal, termination), specifically how many are in the RENEWAL stage, and the CS data-hygiene violations (e.g. missing renewal date, renewal overdue, missing CS owner). Use this whenever the user asks about the CS Lifecycle tab, the CS team's deals, renewal-stage counts, upcoming/overdue renewals, or CS data hygiene.",

  inputSchema: z.object({}),

  outputSchema: z.object({
    success: z.boolean(),
    totalCsDeals: z.number(),
    inRenewal: z.number(),
    byPhase: z.record(z.number()),
    violations: z.object({
      total: z.number(),
      missingRenewalDate: z.number(),
      renewalOverdue: z.number(),
      bySeverity: z.record(z.number()),
    }),
    error: z.string().optional(),
  }),

  execute: async ({ mastra }) => {
    const logger = mastra?.getLogger();
    try {
      const { scanCsLifecycleViolations } = await import(
        "../../utils/duplicateRadarDatabase"
      );
      const r = await scanCsLifecycleViolations({ limit: 50000 });
      const s = r.summary;
      logger?.info("🔄 [csLifecycleStatusTool] CS lifecycle status", {
        totalCsDeals: s.total_cs_deals,
        inRenewal: s.by_phase?.renewal || 0,
      });
      return {
        success: true,
        totalCsDeals: s.total_cs_deals,
        inRenewal: s.by_phase?.renewal || 0,
        byPhase: s.by_phase || {},
        violations: {
          total: s.total_violations,
          missingRenewalDate: s.by_code?.missing_renewal_date || 0,
          renewalOverdue: s.by_code?.renewal_overdue || 0,
          bySeverity: s.by_severity || {},
        },
      };
    } catch (e: any) {
      return {
        success: false,
        totalCsDeals: 0,
        inRenewal: 0,
        byPhase: {},
        violations: { total: 0, missingRenewalDate: 0, renewalOverdue: 0, bySeverity: {} },
        error: e?.message || String(e),
      };
    }
  },
});
