import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { searchCRMProviderRecordsByWord } from "../../utils/CRMProviderCRM";
import { searchClustersByText } from "../../utils/duplicateRadarDatabase";

/**
 * Entity lookup — "show me everything we have on <X>".
 *
 * Given ANY identifier (company name, person name, domain, email, or phone
 * number) this searches all four CRMProvider modules at once via CRMProvider's indexed
 * global search (searchCRMProviderRecordsByWord — the same lookup the CRM's top
 * search box uses, so it matches phone/email/name even where structured
 * `criteria` search misses) and also surfaces any matching duplicate clusters.
 *
 * Read-only. Returns a compact per-module summary the agent can narrate; it
 * does NOT dump full records. Contact PII (email/phone) is included because
 * that's the point of the lookup — only senior roles reach this tool (web is
 * RBAC-gated by login; ChatProvider runs Adam at head_of_operations_quality).
 */

const ALL_MODULES = ["Accounts", "Deals", "Contacts", "Leads"] as const;
type ZModule = (typeof ALL_MODULES)[number];

/**
 * Build the CRMProvider CRM *UI* deep-link for a record so Adam can hand the user a
 * clickable "open this in the CRM" link. The API host (CRMProviderapis.<tld>) maps to
 * the CRM web host (crm.CRMProvider.<tld>); the org is resolved by CRMProvider from the
 * logged-in session, so the org-less /crm/tab/<Module>/<id> form redirects to
 * the right org. Returns null if we have no record id.
 */
function CRMProviderRecordUrl(module: ZModule, id?: string | null): string | null {
  if (!id) return null;
  const apiDomain = process.env.CRMProvider_API_DOMAIN || "<REDACTED_URL>";
  // ".com", ".eu", ".in", ".com.au", ".com.cn", ".jp" …
  const m = apiDomain.match(/CRMProviderapis(\.[a-z.]+)/i);
  const tld = m ? m[1] : ".com";
  return `<REDACTED_URL>`;
}

/**
 * Race a promise against a timeout so a single hanging CRMProvider call can never
 * stall the whole lookup. Without this, one slow module search leaves the
 * Promise.all pending forever → the agent waits → the user gets a blank reply
 * / endless spinner. On timeout we reject so the caller's try/catch records it
 * as a per-module error and still returns a usable answer.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const SEARCH_TIMEOUT_MS = 12_000;

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
  const base = {
    id: rec.id,
    owner: rec.owner || nameOf(d.Owner) || null,
    crmLink: CRMProviderRecordUrl(module, rec.id),
  };
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
    "Searches CRMProvider Accounts, Deals, Contacts and Leads using CRMProvider's indexed global search and surfaces any matching " +
    "duplicate clusters. Use this whenever the user asks 'show me everything on <X>', 'what do we have for <company>', " +
    "or gives a domain / email / phone / client name to look up across the CRM.",

  inputSchema: z.object({
    query: z
      .string()
      .describe("Company name, person name, domain, email, or phone number to look up"),
    modules: z
      .array(z.enum(ALL_MODULES))
      .optional()
      .describe("Limit to specific CRMProvider modules; defaults to all four (Accounts, Deals, Contacts, Leads)"),
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
    // Normalize the search term. Users paste domains as "@<REDACTED_HOST>" — the
    // leading "@" breaks CRMProvider's indexed word search, so strip it (and any
    // surrounding angle brackets/whitespace). A real email like
    // "user@example.invalid" keeps its mid-string "@" (CRMProvider matches emails).
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
          const recs = await withTimeout(
            searchCRMProviderRecordsByWord(m, query),
            SEARCH_TIMEOUT_MS,
            `${m} search`,
          );
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
      clusters = await withTimeout(
        searchClustersByText(query, 10),
        SEARCH_TIMEOUT_MS,
        "cluster search",
      );
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
