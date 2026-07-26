import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * ACTIVE-CLIENT DOMAINS — no churn (Sarah 2026-07-23).
 *
 * "Collect all the domains of existing clients with no churn." Reads the
 * corporate-scoped CS client directory (listActiveClientDomains) and returns
 * the domains of clients in the ADOPTION or RENEWAL CS phase with NO churn date
 * (Sarah 2026-07-26): Adoption = finished onboarding, now a paying customer;
 * Renewal = renewed after a year. Onboarding, churned/terminated, and paid
 * deals with no recognised phase are EXCLUDED. Marketplace / WalaOne /
 * Partner-Accounts layouts are already excluded by the directory, so this is a
 * clean corporate list of established, retained clients. Domains are passed
 * through a hygiene pass (strip www., reduce sub-domains to the registrable
 * domain, drop free-mail / malformed) and de-duplicated.
 *
 * Read-only; same engine as GET /api/duplicates/preflight/active-client-domains
 * so the numbers always match the Preflight tab's download.
 */
export const activeClientDomainsTool = createTool({
  id: "active-client-domains",

  description:
    "List the DOMAINS of established corporate clients in the ADOPTION or RENEWAL CS phase with NO churn date — clients who finished onboarding and became paying customers (Adoption) or renewed after a year (Renewal). Onboarding-phase, churned/terminated, and paid deals with no recognised phase are excluded. Marketplace / WalaOne / merchant layouts are excluded. Use whenever the user asks to collect / list / export the domains of current clients, active clients, adoption/renewal clients, no-churn clients, or a suppression / exclusion list for outreach or imports. Returns the total count and the sorted domains; for very large lists a preview is returned with a note to use the Preflight tab download or GET /api/duplicates/preflight/active-client-domains?format=csv for the full file.",

  inputSchema: z.object({
    fresh: z
      .boolean()
      .optional()
      .describe(
        "Rebuild the client directory from the DB first (slower, authoritative). Defaults to false (uses the cached directory).",
      ),
    limit: z
      .number()
      .optional()
      .describe("Max domains to include inline (default 1000)."),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    total: z.number(),
    returned: z.number(),
    truncated: z.boolean(),
    builtAtIso: z.string().optional(),
    domains: z.array(z.string()),
    note: z.string().optional(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    try {
      const { listActiveClientDomains } = await import(
        "../../utils/duplicateRadarPreflight"
      );
      const { domains, total, built_at_iso } = await listActiveClientDomains({
        fresh: context?.fresh === true,
      });
      const limit =
        typeof context?.limit === "number" && context.limit > 0
          ? Math.floor(context.limit)
          : 1000;
      const returned = domains.slice(0, limit);
      const truncated = domains.length > returned.length;
      logger?.info("🔄 [activeClientDomainsTool] no-churn client domains", {
        total,
        returned: returned.length,
      });
      return {
        success: true,
        total,
        returned: returned.length,
        truncated,
        builtAtIso: built_at_iso,
        domains: returned,
        note: truncated
          ? `Showing the first ${returned.length} of ${total} domains. For the full list, use the Preflight tab "⬇ Active-client domains" button or GET /api/duplicates/preflight/active-client-domains?format=csv.`
          : undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        total: 0,
        returned: 0,
        truncated: false,
        domains: [],
        error: e?.message || String(e),
      };
    }
  },
});
