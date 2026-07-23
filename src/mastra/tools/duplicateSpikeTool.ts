import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * DUPLICATE SPIKE ROOT-CAUSE (Sarah 2026-07-23).
 *
 * The Executive Summary's Creation-Trend chart shows WHEN duplicates / pipeline
 * inflation are rising, but not WHY — Sarah could see the spike but not the
 * reason. This tool attributes it: NEW duplicate records (created in-window AND
 * part of a real duplicate cluster) in the RECENT window vs the equal PRIOR
 * window, broken down by Lead SOURCE, OWNER and MODULE, each sorted by the
 * biggest INCREASE. The top rows are the pain area — the channel / person /
 * record-type leaking the most new duplicates into Zoho. Read-only.
 */
export const duplicateSpikeTool = createTool({
  id: "duplicate-spike-root-cause",

  description:
    "Explain WHY duplicates or pipeline inflation are rising in the Duplicate Radar. Returns the count of NEW duplicate records in the recent window vs the prior equal window, broken down by Lead Source, by Owner, and by Module, sorted by the biggest increase — so you can name the source channel, the rep, or the record type driving the spike. Use whenever asked why duplicates went up, what caused the spike, where the duplicate leak is coming from, or which source/owner is creating the most new duplicates.",

  inputSchema: z.object({
    weeks: z
      .number()
      .optional()
      .describe("Length of each comparison window in weeks (default 3)."),
    segment: z
      .enum(["all", "marketplace", "walaplus", "walaone"])
      .optional()
      .describe("Filter by Zoho Layout segment. Defaults to all."),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    windowWeeks: z.number(),
    recentTotal: z.number(),
    priorTotal: z.number(),
    deltaTotal: z.number(),
    bySource: z.array(
      z.object({ label: z.string(), recent: z.number(), prior: z.number(), delta: z.number() }),
    ),
    byOwner: z.array(
      z.object({ label: z.string(), recent: z.number(), prior: z.number(), delta: z.number() }),
    ),
    byModule: z.array(
      z.object({ label: z.string(), recent: z.number(), prior: z.number(), delta: z.number() }),
    ),
    // Provenance: is the rise a real NEW leak (created in Zoho this window) or
    // re-detection of OLD records? createdInWindow/exposureNewSar are reliable
    // (by Zoho Created_Time); the synced-date figures come with a caveat flag.
    provenance: z.object({
      createdInWindow: z.number(),
      createdBeforeWindow: z.number(),
      exposureNewSar: z.number(),
      exposureOldSar: z.number(),
      firstSyncedInWindow: z.number(),
      backDetected: z.number(),
      lastSynced: z.string().nullable(),
      syncedViewUnreliable: z.boolean(),
    }),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    try {
      const { getDuplicateSpikeBreakdown } = await import(
        "../../utils/duplicateRadarDatabase"
      );
      const segment =
        context?.segment && context.segment !== "all" ? context.segment : undefined;
      const r = await getDuplicateSpikeBreakdown({
        weeks: context?.weeks,
        segment: segment as any,
      });
      logger?.info("🔄 [duplicateSpikeTool] spike root-cause", {
        windowWeeks: r.window_weeks,
        deltaTotal: r.delta_total,
      });
      return {
        success: true,
        windowWeeks: r.window_weeks,
        recentTotal: r.recent_total,
        priorTotal: r.prior_total,
        deltaTotal: r.delta_total,
        bySource: r.by_source,
        byOwner: r.by_owner,
        byModule: r.by_module,
        provenance: {
          createdInWindow: r.provenance.created_in_window,
          createdBeforeWindow: r.provenance.created_before_window,
          exposureNewSar: r.provenance.exposure_new_sar,
          exposureOldSar: r.provenance.exposure_old_sar,
          firstSyncedInWindow: r.provenance.first_synced_in_window,
          backDetected: r.provenance.back_detected,
          lastSynced: r.provenance.last_synced,
          syncedViewUnreliable: r.provenance.synced_view_unreliable,
        },
      };
    } catch (e: any) {
      return {
        success: false,
        windowWeeks: 0,
        recentTotal: 0,
        priorTotal: 0,
        deltaTotal: 0,
        bySource: [],
        byOwner: [],
        byModule: [],
        provenance: {
          createdInWindow: 0,
          createdBeforeWindow: 0,
          exposureNewSar: 0,
          exposureOldSar: 0,
          firstSyncedInWindow: 0,
          backDetected: 0,
          lastSynced: null,
          syncedViewUnreliable: false,
        },
        error: e?.message || String(e),
      };
    }
  },
});
