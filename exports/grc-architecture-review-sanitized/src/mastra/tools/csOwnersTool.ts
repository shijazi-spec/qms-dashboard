import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * CS OWNER ROSTER (Sample User 2026-07-20).
 *
 * Sample User "who are the CS owners in the platform?" and AssistantPersona could not
 * answer — its only CS tool (cs-lifecycle-status) returns COUNTS, and no tool
 * exposed the owner NAMES. The platform stores no CS team list either: the
 * owner lives per-deal in CRMProvider's "CS Owner Name" field.
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
    "List the Customer Success (CS) team — the maintained roster of CS members (name + ExampleOrg email) cross-referenced with live CRMProvider data: how many deals and accounts each one owns, which roster members carry NO deals, which owner names on deals are NOT on the roster (typo / ex-employee / non-CS person), and how many CS deals have no owner at all. Use whenever the user asks who the CS owners or CS team are, who owns a CS book, who has the most CS deals, who is unassigned, or whether a CS Owner name in the CRM is valid.",

  inputSchema: z.object({
    segment: z
      .enum(["all", "marketplace", "ExampleOrg", "Example Organization"])
      .optional()
      .describe("Filter by CRMProvider Layout segment. Defaults to all."),
    limit: z.number().optional().describe("Max owners to return (default 200)."),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    rosterSize: z.number(),
    totalOwners: z.number(),
    totalCsDeals: z.number(),
    dealsWithoutOwner: z.number(),
    owners: z.array(
      z.object({
        owner: z.string(),
        deals: z.number(),
        accounts: z.number(),
        onRoster: z.boolean(),
        email: z.string().nullable(),
      }),
    ),
    rosterWithoutDeals: z.array(
      z.object({ name: z.string(), email: z.string() }),
    ),
    offRosterNames: z.array(z.string()),
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
        rosterSize: r.roster_size,
        totalOwners: r.totalOwners,
        totalCsDeals: r.totalCsDeals,
        dealsWithoutOwner: r.dealsWithoutOwner,
        owners: r.owners.map((o) => ({
          owner: o.owner,
          deals: o.deals,
          accounts: o.accounts,
          onRoster: o.on_roster,
          email: o.email,
        })),
        rosterWithoutDeals: r.roster_without_deals,
        offRosterNames: r.off_roster_names,
      };
    } catch (e: any) {
      return {
        success: false,
        rosterSize: 0,
        totalOwners: 0,
        totalCsDeals: 0,
        dealsWithoutOwner: 0,
        owners: [],
        rosterWithoutDeals: [],
        offRosterNames: [],
        error: e?.message || String(e),
      };
    }
  },
});
