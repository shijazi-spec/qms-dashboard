import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * CS OWNER ROSTER (Sarah 2026-07-20).
 *
 * Sarah asked Adam "who are the CS owners in the platform?" and Adam could not
 * answer — its only CS tool (cs-lifecycle-status) returns COUNTS, and no tool
 * exposed the owner NAMES. The platform stores no CS team list either: the
 * owner lives per-deal in Zoho's "CS Owner Name" field.
 *
 * This tool derives the roster from the data via getCsOwners() — the distinct
 * CS Owner Name values across Deal records with how many deals/accounts each
 * owns, plus how many CS deals have NO owner (the missing_cs_owner gap).
 * Read-only; same engine as GET /api/duplicates/cs-lifecycle/owners so the
 * numbers always match the dashboard.
 */
export const csOwnersTool = createTool({
  id: "cs-owners",

  description:
    "List the Customer Success (CS) owners — the actual PEOPLE on the CS team — with how many deals and accounts each one owns, plus how many CS deals have no owner assigned. Names are derived from the 'CS Owner Name' field on Zoho deals (the platform keeps no separate CS roster). Use whenever the user asks who the CS owners/CS team are, who owns a CS book, who has the most CS deals, or how many CS deals are unassigned.",

  inputSchema: z.object({
    segment: z
      .enum(["all", "marketplace", "walaplus", "walaone"])
      .optional()
      .describe("Filter by Zoho Layout segment. Defaults to all."),
    limit: z.number().optional().describe("Max owners to return (default 200)."),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    totalOwners: z.number(),
    totalCsDeals: z.number(),
    dealsWithoutOwner: z.number(),
    owners: z.array(
      z.object({
        owner: z.string(),
        deals: z.number(),
        accounts: z.number(),
      }),
    ),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    try {
      const { getCsOwners } = await import(
        "../../utils/duplicateRadarDatabase"
      );
      const segment =
        context?.segment && context.segment !== "all" ? context.segment : undefined;
      const r = await getCsOwners({
        segment: segment as any,
        limit: context?.limit,
      });
      logger?.info("🔄 [csOwnersTool] CS owner roster", {
        totalOwners: r.totalOwners,
        dealsWithoutOwner: r.dealsWithoutOwner,
      });
      return {
        success: true,
        totalOwners: r.totalOwners,
        totalCsDeals: r.totalCsDeals,
        dealsWithoutOwner: r.dealsWithoutOwner,
        owners: r.owners,
      };
    } catch (e: any) {
      return {
        success: false,
        totalOwners: 0,
        totalCsDeals: 0,
        dealsWithoutOwner: 0,
        owners: [],
        error: e?.message || String(e),
      };
    }
  },
});
