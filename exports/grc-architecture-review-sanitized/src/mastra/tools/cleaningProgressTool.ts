import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * Data Cleaning Progress — reads the Duplicate Radar's Cleaning Progress tab
 * data so Adam can answer "how much data have we cleaned?", cleanup reports,
 * or "what's the ExampleOrg Deals/Accounts progress?".
 *
 * Reuses getDataCleaningProgress (the same engine that powers the Cleaning
 * Progress tab and its export), so the numbers always match the dashboard.
 * Read-only.
 */
export const cleaningProgressTool = createTool({
  id: "cleaning-progress-status",

  description:
    "Data Cleaning Progress for Deals & Accounts — verified duplicate merges and verified empty-record deletions, plus how many duplicates are still outstanding, filterable by segment (all/marketplace/ExampleOrg/walaone). Use for 'how much data have we cleaned', cleanup reports, or ExampleOrg Deals/Accounts progress.",

  inputSchema: z.object({
    segment: z.enum(["all", "marketplace", "ExampleOrg", "walaone"]).optional(),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    segment: z.string(),
    deals: z.object({
      outstanding: z.number(),
      verifiedMerges: z.number(),
      estRecordsRemoved: z.number(),
      emptyDeleted: z.number(),
    }),
    accounts: z.object({
      outstanding: z.number(),
      verifiedMerges: z.number(),
      estRecordsRemoved: z.number(),
      emptyDeleted: z.number(),
    }),
    emptyDeletedAllSegments: z.boolean(),
    note: z.string(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    try {
      const { getDataCleaningProgress } = await import(
        "../../utils/duplicateRadarDatabase"
      );
      const d = await getDataCleaningProgress((context?.segment as any) || "all");
      const M = (x: any) => ({
        outstanding: x.outstanding,
        verifiedMerges: x.verified_merges,
        estRecordsRemoved: x.est_records_removed,
        emptyDeleted: x.empty_deleted,
      });
      logger?.info("🧹 [cleaningProgressTool] Cleaning Progress status", {
        segment: d.segment,
        dealsOutstanding: d.modules.Deals.outstanding,
        accountsOutstanding: d.modules.Accounts.outstanding,
      });
      return {
        success: true,
        segment: d.segment,
        deals: M(d.modules.Deals),
        accounts: M(d.modules.Accounts),
        emptyDeletedAllSegments: d.empty_deleted_all_segments,
        note:
          "Verified merges + verified Zoho deletions only; tagged-not-deleted excluded. Empty deletions are all-layers. Est. removed may undercount pre-tracking cleanup.",
      };
    } catch (e: any) {
      return {
        success: false,
        segment: "all",
        deals: { outstanding: 0, verifiedMerges: 0, estRecordsRemoved: 0, emptyDeleted: 0 },
        accounts: { outstanding: 0, verifiedMerges: 0, estRecordsRemoved: 0, emptyDeleted: 0 },
        emptyDeletedAllSegments: true,
        note: "",
        error: e?.message || String(e),
      };
    }
  },
});
