import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { searchZohoRecordsByWord } from "../../utils/zohoCRM";
import { searchClustersByText } from "../../utils/duplicateRadarDatabase";

/**
 * Entity lookup — "show me everything we have on <X>".
 *
 * Given ANY identifier (company name, person name, domain, email, or phone
 * number) this searches all four Zoho modules at once via Zoho's indexed
 * global search (searchZohoRecordsByWord — the same lookup the CRM's top
 * search box uses, so it matches phone/email/name even where structured
 * `criteria` search misses) and also surfaces any matching duplicate clusters.
 *
 * Read-only. Returns a compact per-module summary the agent can narrate; it
 * does NOT dump full records. Contact PII (email/phone) is included because
 * that's the point of the lookup — only senior roles reach this tool (web is
 * RBAC-gated by login; Slack runs Adam at head_of_operations_quality).
 */

const ALL_MODULES = ["Accounts", "Deals", "Contacts", "Leads"] as const;
type ZModule = (typeof ALL_MODULES)[number];

function nameOf(v: any): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object") return v.name || v.id || null;
  return null;
}

function joinName(first?: string, last?: string): string | null {
  const n = [first, last].filter(Boolean).join(" ").trim();
  return n || null;
}

function summarize(module: ZModule, rec: any): Record<string, any> {
  const d = rec.data || {};
  const base = { id: rec.id, owner: rec.owner || nameOf(d.Owner) || null };
  switch (module) {
    case "Accounts":
      return { ...base, name: d.Account_Name || null, phone: d.Phone || null, website: d.Website || null };
    case "Deals":
      return {
        ...base,
        name: d.Deal_Name || null,
        stage: d.Stage || null,
        amount: d.Amount ?? null,
        account: nameOf(d.Account_Name),
        closeDate: d.Closing_Date || null,
      };
    case "Contacts":
      return {
        ...base,
        name: d.Full_Name || joinName(d.First_Name, d.Last_Name),
        email: d.Email || null,
        phone: d.Phone || d.Mobile || null,
        account: nameOf(d.Account_Name),
      };
    case "Leads":
      return {
        ...base,
        name: d.Full_Name || joinName(d.First_Name, d.Last_Name),
        company: d.Company || null,
        email: d.Email || null,
        phone: d.Phone || d.Mobile || null,
        status: d.Lead_Status || null,
      };
    default:
      return base;
  }
}

export const lookupEntityTool = createTool({
  id: "lookup-entity",

  description:
    "Look up EVERYTHING the CRM has on a company, person, domain, email, or phone number in one go. " +
    "Searches Zoho Accounts, Deals, Contacts and Leads using Zoho's indexed global search and surfaces any matching " +
    "duplicate clusters. Use this whenever the user asks 'show me everything on <X>', 'what do we have for <company>', " +
    "or gives a domain / email / phone / client name to look up across the CRM.",

  inputSchema: z.object({
    query: z
      .string()
      .describe("Company name, person name, domain, email, or phone number to look up"),
    modules: z
      .array(z.enum(ALL_MODULES))
      .optional()
      .describe("Limit to specific Zoho modules; defaults to all four (Accounts, Deals, Contacts, Leads)"),
    limitPerModule: z
      .number()
      .optional()
      .describe("Max records returned per module (default 20, max 50)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    query: z.string(),
    counts: z.record(z.number()),
    totalFound: z.number(),
    records: z.record(z.array(z.record(z.any()))),
    clusters: z.array(z.record(z.any())),
    errors: z.array(z.string()).optional(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    // Normalize the search term. Users paste domains as "@nozomtechs.com" — the
    // leading "@" breaks Zoho's indexed word search, so strip it (and any
    // surrounding angle brackets/whitespace). A real email like
    // "x@nozomtechs.com" keeps its mid-string "@" (Zoho matches emails).
    const raw = (context.query || "").trim();
    const query = raw.replace(/^[<@\s]+/, "").replace(/[>\s]+$/, "").trim();
    if (!query) {
      return {
        success: false,
        query: "",
        counts: {},
        totalFound: 0,
        records: {},
        clusters: [],
        error: "A search term (company, person, domain, email, or phone) is required.",
      };
    }

    const wanted: ZModule[] =
      context.modules && context.modules.length ? context.modules : [...ALL_MODULES];
    const cap = Math.max(1, Math.min(context.limitPerModule ?? 20, 50));

    const counts: Record<string, number> = {};
    const records: Record<string, any[]> = {};
    const errors: string[] = [];

    await Promise.all(
      wanted.map(async (m) => {
        try {
          const recs = await searchZohoRecordsByWord(m, query);
          counts[m] = recs.length;
          records[m] = recs.slice(0, cap).map((r) => summarize(m, r));
        } catch (e: any) {
          counts[m] = 0;
          records[m] = [];
          errors.push(`${m}: ${e?.message || String(e)}`);
        }
      }),
    );

    let clusters: any[] = [];
    try {
      clusters = await searchClustersByText(query, 10);
    } catch (e: any) {
      errors.push(`clusters: ${e?.message || String(e)}`);
    }

    const totalFound = Object.values(counts).reduce((a, b) => a + b, 0);
    logger?.info("🔎 [lookupEntityTool] entity lookup", {
      query,
      totalFound,
      counts,
      clusters: clusters.length,
    });

    return {
      success: true,
      query,
      counts,
      totalFound,
      records,
      clusters,
      errors: errors.length ? errors : undefined,
    };
  },
});
