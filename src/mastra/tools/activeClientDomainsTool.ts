import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * ACTIVE-CLIENT DOMAINS — no churn (Sarah 2026-07-23).
 *
 * "Collect all the domains of existing clients with no churn." Reads the
 * corporate-scoped CS client directory (listActiveClientDomains) and returns
 * the domains whose status is ACTIVE — a customer-stage deal (Agreement Signed
 * / Paid) or a live CS phase with NO churn date. Marketplace / WalaOne /
 * Partner-Accounts layouts are already excluded by the directory, so this is a
 * clean corporate do-not-cold-contact suppression list.
 *
 * Read-only; same engine as GET /api/duplicates/preflight/active-client-domains
 * so the numbers always match the Preflight tab's download.
 */
export const activeClientDomainsTool = createTool({
  id: "active-client-domains",

  description:
    "List the DOMAINS of existing corporate clients with NO churn — companies with a customer-stage deal (Agreement Signed / Paid) or a live CS phase and no churn date. This is the do-not-cold-contact suppression list (Marketplace / WalaOne / merchant layouts are excluded). Use whenever the user asks to collect / list / export the domains of current clients, active clients, no-churn clients, or a suppression / exclusion list for outreach or imports. Returns the total count and the sorted domains; for very large lists a preview is returned with a note to use the Preflight tab download or GET /api/duplicates/preflight/active-client-domains?format=csv for the full file.",

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
