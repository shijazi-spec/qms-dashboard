import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * Bulk company-NAME lookup — the name equivalent of check-domains-batch.
 * Answers a pasted list of company names in ONE query against the synced CRM
 * mirror, so Adam no longer burns one tool call per company (which capped a
 * 56-company list at ~10 answers and looked like a permissions problem).
 */
export const checkCompaniesBatchTool = createTool({
  id: "check-companies-batch",

  description:
    "Check MANY company NAMES at once — 'are these companies already in the CRM / already clients?'. Pass an array of company names; it answers the WHOLE list in one fast batched query against the synced CRM data. Per company it returns matched (yes/no), match_type ('strict' = exact match on the normalized name, 'fuzzy' = name resemblance only, present these as 'possible match, verify' and never as a confirmed client), the CRM name matched, per-module counts (leads/deals/contacts/accounts) and the distinct deal stages. Use this for a pasted LIST of company names; for ONE company use lookup-entity, and if the user has DOMAINS prefer check-domains-batch. Read-only.",

  inputSchema: z.object({
    companies: z
      .array(z.string())
      .min(1)
      .max(300)
      .describe("Company names to check (max 300)"),
    segment: z
      .enum(["all", "marketplace", "walaplus", "walaone"])
      .optional()
      .describe("Optional CRM segment scope; defaults to all"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    checked: z.number(),
    matchedCount: z.number(),
    results: z.array(z.record(z.any())),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    try {
      const { getCompanyBatchRows } = await import("../../utils/duplicateRadarDatabase");
      const { matchCompanyNames } = await import("../../utils/companyNameBatch");
      const companies = (context?.companies || []).slice(0, 300);
      const rows = await getCompanyBatchRows((context?.segment as any) || "all");
      const results = matchCompanyNames(companies, rows);
      const matchedCount = results.filter((r) => r.matched).length;
      logger?.info("🔎 [checkCompaniesBatchTool] checked companies", {
        checked: results.length,
        matchedCount,
      });
      return { success: true, checked: results.length, matchedCount, results };
    } catch (e: any) {
      return {
        success: false,
        checked: 0,
        matchedCount: 0,
        results: [],
        error: e?.message || String(e),
      };
    }
  },
});
