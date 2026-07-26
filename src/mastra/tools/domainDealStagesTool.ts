import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * GROUND-TRUTH DEAL-STAGE CHECK (Sarah 2026-07-26).
 *
 * "Check if there are any Agreement Signed or Paid stage deals for these
 * domains." Given a list of domains, returns for each the deals the CRM holds
 * and their Stage, and flags whether any is at a customer stage (Agreement
 * Signed / Paid). Form-agnostic matching (deal domain, Company_Domain, and the
 * linked Account domain all reduced to the registrable form), so raw ClientHub
 * sub-domains and our normalised forms both resolve. Read-only; same engine as
 * POST /api/duplicates/preflight/domain-deal-stages.
 */
export const domainDealStagesTool = createTool({
  id: "domain-deal-stages",

  description:
    "For a list of domains, look up in the CRM whether each has any Deal at Agreement Signed or Paid stage, and list every deal + its stage. Use whenever the user wants to check/verify, for specific domains or companies, whether a signed/paid deal exists, what stage their deal is in, or whether a domain is in the CRM at all. Returns per-domain: in_crm, has_signed_or_paid, the distinct stages, and the deals (name, stage, owner, churn date, layout). Read-only.",

  inputSchema: z.object({
    domains: z
      .array(z.string())
      .describe("Domains to check (e.g. ['acwapower.com','riyadbank.com'])."),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    summary: z
      .object({
        total: z.number(),
        with_signed_or_paid: z.number(),
        in_crm_other_stage: z.number(),
        not_in_crm: z.number(),
      })
      .optional(),
    results: z
      .array(
        z.object({
          input: z.string(),
          in_crm: z.boolean(),
          has_signed_or_paid: z.boolean(),
          stages: z.array(z.string()),
          deals: z.array(
            z.object({
              name: z.string(),
              stage: z.string(),
              owner: z.string().nullable(),
              churn_date: z.string().nullable(),
              layout: z.string().nullable(),
            }),
          ),
        }),
      )
      .optional(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    try {
      const domains = Array.isArray(context?.domains) ? context.domains : [];
      if (!domains.length) {
        return { success: false, error: "Provide domains: string[]." };
      }
      const { checkDomainsForClientDeals } = await import(
        "../../utils/duplicateRadarPreflight"
      );
      const { results } = await checkDomainsForClientDeals(domains);
      const summary = {
        total: results.length,
        with_signed_or_paid: results.filter((r) => r.has_signed_or_paid).length,
        in_crm_other_stage: results.filter(
          (r) => r.in_crm && !r.has_signed_or_paid,
        ).length,
        not_in_crm: results.filter((r) => !r.in_crm).length,
      };
      logger?.info("🔄 [domainDealStagesTool] checked domains", summary);
      return {
        success: true,
        summary,
        results: results.map((r) => ({
          input: r.input,
          in_crm: r.in_crm,
          has_signed_or_paid: r.has_signed_or_paid,
          stages: r.stages,
          deals: r.deals,
        })),
      };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  },
});
