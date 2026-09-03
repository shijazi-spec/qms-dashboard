import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * DEAL STAGE AUDIT — READ-ONLY (Sample User 2026-07-21).
 *
 * A preflight run surfaced deals sitting on BOTH "On Hold" and "Hold", i.e. the
 * CRMProvider Stage picklist holds near-duplicate values. That sample covered only 41
 * rows, so it could not show the real scale. This tool reports every distinct
 * Stage value across ALL deals so the true variant picture is visible before
 * anyone edits the picklist.
 *
 * Writes nothing. Re-staging records and deleting a dead picklist option are
 * deliberate manual steps in CRMProvider — and in that order, because removing an
 * option still in use leaves those deals on an invalid stage.
 */
export const dealStageAuditTool = createTool({
  id: "deal-stage-audit",

  description:
    "Audit the CRMProvider Deal STAGE picklist: every distinct stage value with its deal count, a corporate vs marketplace split, the pipelines it appears on, and suspected near-duplicate values (e.g. 'Hold' vs 'On Hold' — the same stage stored two ways). Read-only, changes nothing. Use when asked which deal stages exist, how many deals are in a stage, whether the stage picklist has duplicates/typos, or before cleaning up stage values.",

  inputSchema: z.object({}),

  outputSchema: z.object({
    success: z.boolean(),
    totalDeals: z.number(),
    distinctStages: z.number(),
    stages: z.array(
      z.object({
        stage: z.string(),
        deals: z.number(),
        corporate: z.number(),
        marketplace: z.number(),
        pipelines: z.array(z.string()),
      }),
    ),
    suspectedVariants: z.array(
      z.object({ group: z.array(z.string()), note: z.string() }),
    ),
    error: z.string().optional(),
  }),

  execute: async ({ mastra }) => {
    const logger = mastra?.getLogger();
    try {
      const { getDealStageAudit } = await import(
        "../../utils/duplicateRadarDatabase"
      );
      const r = await getDealStageAudit();
      logger?.info("🔄 [dealStageAuditTool] stage audit", {
        distinctStages: r.distinct_stages,
        variants: r.suspected_variants.length,
      });
      return {
        success: true,
        totalDeals: r.total_deals,
        distinctStages: r.distinct_stages,
        stages: r.stages,
        suspectedVariants: r.suspected_variants,
      };
    } catch (e: any) {
      return {
        success: false,
        totalDeals: 0,
        distinctStages: 0,
        stages: [],
        suspectedVariants: [],
        error: e?.message || String(e),
      };
    }
  },
});
