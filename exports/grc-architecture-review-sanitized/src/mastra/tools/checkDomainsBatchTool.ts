import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { runPreflight } from "../../utils/duplicateRadarPreflight";

/**
 * Batch domain check — "do we have CRM data for these <many> domains?"
 *
 * The single-record lookupEntityTool hits live CRMProvider per entity, so checking a
 * pasted list of 50–500 domains one-by-one is painfully slow (hundreds of CRMProvider
 * calls → blank-then-late replies). This wraps runPreflight, which answers the
 * SAME question for the whole list in ONE batched SQL query against the synced
 * Duplicate Radar data — fast and reliable. Read-only.
 *
 * Use this whenever the user pastes MANY domains / URLs and asks whether the CRM
 * has data on them (or which are new). For a single company/domain, use
 * lookupEntityTool instead (it hits live CRMProvider and returns the actual records).
 */

function cleanDomain(s: string): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/^@+/, "")
    .replace(/[/\s].*$/, "") // drop path / query / anything after the first slash or space
    .trim();
}

export const checkDomainsBatchTool = createTool({
  id: "check-domains-batch",

  description:
    "Check MANY domains at once — 'do we have CRM data for these domains?' Pass an array of domains/URLs (the tool strips <REDACTED_URL_SCHEME> and paths). It answers the whole list in one fast batched query against the synced CRM data and returns, per domain, whether we have records and the per-module counts (leads/deals/contacts/accounts). Use this for a pasted LIST of domains; for a single company/domain use lookup-entity instead. Read-only.",

  inputSchema: z.object({
    domains: z
      .array(z.string())
      .min(1)
      .describe("Domains or URLs to check (e.g. ['<REDACTED_HOST>', '<REDACTED_URL>']) — the tool normalizes them"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    totalDomains: z.number(),
    withData: z.number(),
    clean: z.number(),
    results: z.array(z.record(z.any())),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const cleaned = Array.from(
      new Set((context.domains || []).map(cleanDomain).filter(Boolean)),
    );
    if (!cleaned.length) {
      return {
        success: false,
        totalDomains: 0,
        withData: 0,
        clean: 0,
        results: [],
        error: "No valid domains provided.",
      };
    }
    try {
      const resp = await runPreflight({
        rows: cleaned.map((d) => ({ domain: d, ref: d })),
        refresh_overlap: false,
      });
      const results = (resp.rows || []).map((r) => {
        const mc = r.module_counts || null;
        return {
          domain: r.input?.domain || r.ref || "",
          hasData: r.verdict !== "pass",
          verdict: r.verdict,
          matched_via: r.matched_via || null,
          leads: mc?.leads ?? 0,
          deals: mc?.deals ?? 0,
          contacts: mc?.contacts ?? 0,
          accounts: mc?.accounts ?? 0,
          total: mc?.total ?? 0,
        };
      });
      const withData = results.filter((r) => r.hasData).length;
      logger?.info("🔎 [checkDomainsBatchTool] batch domain check", {
        totalDomains: cleaned.length,
        withData,
      });
      return {
        success: true,
        totalDomains: cleaned.length,
        withData,
        clean: cleaned.length - withData,
        results,
      };
    } catch (e: any) {
      return {
        success: false,
        totalDomains: cleaned.length,
        withData: 0,
        clean: 0,
        results: [],
        error: e?.message || String(e),
      };
    }
  },
});
