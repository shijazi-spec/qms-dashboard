import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * ACTIVE-CLIENT DOMAINS — no churn (Sarah 2026-07-23).
 *
 * "Collect all the domains of existing clients with no churn." Returns the
 * CORPORATE current-client domains (listActiveClientDomains): CRM Deals whose
 * CS Phase is New Deal / Kickoff / Onboarding / Adoption / Renewal (NOT Termination, not
 * blank) AND that are not churned — Churn Date empty OR a Renewal Date later
 * than the Churn Date — taking the domain from the CS-section Company_Domain
 * field (Sarah 2026-07-26 final rule). Marketplace / WalaOne / Partner-Accounts
 * layouts are excluded. ACTIVE DOAM (HR-ministry) government clients are merged
 * in as an overlay. Domains are passed through a hygiene pass and de-duplicated.
 *
 * Read-only; same engine as GET /api/duplicates/preflight/active-client-domains
 * so the numbers always match the Preflight tab's download.
 */
export const activeClientDomainsTool = createTool({
  id: "active-client-domains",

  description:
    "List the DOMAINS of corporate current clients: CRM Deals whose CS Phase is New Deal / Kickoff / Onboarding / Adoption / Renewal (not Termination, not blank) and that are not churned (Churn Date empty, or a Renewal Date later than the Churn Date), using the CS-section Company_Domain field as the domain. Marketplace / WalaOne / merchant layouts are excluded, and ACTIVE DOAM (HR-ministry) government clients are merged in. Use whenever the user asks to collect / list / export the domains of current clients, active clients, no-churn clients, or a suppression / exclusion list for outreach or imports. Returns the total count and the sorted domains; for very large lists a preview is returned with a note to use the Preflight tab download or GET /api/duplicates/preflight/active-client-domains?format=csv for the full file.",

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
    walaplus_count: z.number().optional(),
    doam_count: z.number().optional(),
    returned: z.number(),
    truncated: z.boolean(),
    builtAtIso: z.string().optional(),
    rows: z
      .array(z.object({ domain: z.string(), product: z.string() }))
      .optional(),
    note: z.string().optional(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    try {
      const { listActiveClientDomains } = await import(
        "../../utils/duplicateRadarPreflight"
      );
      const { rows, total, walaplus_count, doam_count, built_at_iso } =
        await listActiveClientDomains({ fresh: context?.fresh === true });
      const limit =
        typeof context?.limit === "number" && context.limit > 0
          ? Math.floor(context.limit)
          : 1000;
      const returned = rows.slice(0, limit);
      const truncated = rows.length > returned.length;
      logger?.info("🔄 [activeClientDomainsTool] active client domains", {
        total,
        walaplus_count,
        doam_count,
        returned: returned.length,
      });
      return {
        success: true,
        total,
        walaplus_count,
        doam_count,
        returned: returned.length,
        truncated,
        builtAtIso: built_at_iso,
        rows: returned,
        note: truncated
          ? `Showing the first ${returned.length} of ${total} (WalaPlus ${walaplus_count} + DOAM ${doam_count}). For the full list, use the Preflight tab "⬇ Active-client domains" button or GET /api/duplicates/preflight/active-client-domains?format=csv.`
          : undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        total: 0,
        returned: 0,
        truncated: false,
        error: e?.message || String(e),
      };
    }
  },
});
