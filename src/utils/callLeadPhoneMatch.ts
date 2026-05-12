import { fetchAllZohoRecords, type ZohoCRMRecord } from "./zohoCRM";
import { normalizePhoneDigits } from "./callMcpReconciliation";
import {
  CRM_PHONE_MATCH_SCOPE,
  CRM_PHONE_MATCH_SCOPE_DESCRIPTION,
} from "./callMcpImportSources";

export { CRM_PHONE_MATCH_SCOPE, CRM_PHONE_MATCH_SCOPE_DESCRIPTION };

export interface LeadPhoneMatch {
  id: string;
  module: "Leads";
  full_name?: string;
  phone?: string;
  email?: string;
  owner?: string;
}

function readPhone(r: ZohoCRMRecord): string {
  const d = r.data || {};
  const raw =
    (typeof d.Phone === "object" && d.Phone?.name) ||
    d.Phone ||
    d.Mobile ||
    (typeof d.Mobile === "object" && d.Mobile?.name) ||
    "";
  return String(raw || "");
}

/**
 * Best-effort: scan **all Leads fetched** from Zoho (bounded by `maxRecords`)
 * and return those whose Phone/Mobile normalizes to the same digit string as `phone`.
 * Product scope: **Leads module only** — no Contacts, Deals, or Activities.
 * See `CRM_PHONE_MATCH_SCOPE_DESCRIPTION`.
 */
export async function findLeadsByPhoneMatch(
  phone: string,
  options: { maxRecords?: number } = {},
): Promise<{ normalized_query: string; matches: LeadPhoneMatch[]; scanned: number }> {
  const normalized_query = normalizePhoneDigits(phone);
  if (!normalized_query) {
    return { normalized_query: "", matches: [], scanned: 0 };
  }

  const hasZoho =
    process.env.ZOHO_ACCESS_TOKEN ||
    (process.env.ZOHO_CLIENT_ID &&
      process.env.ZOHO_CLIENT_SECRET &&
      process.env.ZOHO_REFRESH_TOKEN);
  if (!hasZoho) {
    return { normalized_query, matches: [], scanned: 0 };
  }

  const maxRecords = options.maxRecords ?? 2500;
  const leads = await fetchAllZohoRecords("Leads", { maxRecords });
  const matches: LeadPhoneMatch[] = [];
  for (const r of leads) {
    const p = normalizePhoneDigits(readPhone(r));
    if (!p) continue;
    if (p === normalized_query || p.endsWith(normalized_query) || normalized_query.endsWith(p)) {
      const d = r.data || {};
      matches.push({
        id: r.id,
        module: "Leads",
        full_name: d.Full_Name || d.Last_Name || undefined,
        phone: readPhone(r),
        email: typeof d.Email === "object" ? d.Email?.name : d.Email,
        owner: r.owner,
      });
    }
  }
  return { normalized_query, matches, scanned: leads.length };
}
