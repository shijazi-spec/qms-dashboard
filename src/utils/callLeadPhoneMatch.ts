import { fetchAllZohoRecords, type ZohoCRMRecord } from "./zohoCRM";
import { normalizePhoneDigits } from "./callMcpReconciliation";
import {
  CRM_PHONE_MATCH_SCOPE,
  CRM_PHONE_MATCH_SCOPE_DESCRIPTION,
} from "./callMcpImportSources";

export { CRM_PHONE_MATCH_SCOPE, CRM_PHONE_MATCH_SCOPE_DESCRIPTION };

export interface AutoLinkLeadResult {
  linked: boolean;
  lead_id: string | null;
  matches_count: number;
  scanned: number;
  reason: "linked" | "no_phone" | "no_match" | "ambiguous" | "already_linked" | "no_zoho" | "persist_failed";
  match?: LeadPhoneMatch;
  attempted_phone?: string;
}

/** Pull plausible phone strings from a CallRecord row's known fields/metadata. */
export function extractCallPhoneCandidates(record: any): string[] {
  if (!record) return [];
  const out: string[] = [];
  const md = record.metadata || {};
  const candidates: any[] = [
    md.from_number,
    md.to_number,
    md.phone,
    md.mobile,
    md.caller_id,
    md.callerId,
    md.from,
    md.to,
    md.contact_phone,
    record.contact_phone,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) out.push(c.trim());
  }
  // De-dup preserving order
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
}

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
  // Minimum overlap length for a suffix match. Without this floor a junk
  // Lead with Phone="11" (or any short value) matches every call whose
  // number happens to end with those digits — producing CRM Compliance
  // rows that link the call to a completely unrelated record (e.g.
  // +966505896511 silently auto-linked to a Lead whose phone is "11"
  // because "966505896511".endsWith("11")). Set to 9 per ops decision:
  // KSA / GCC mobile subscriber numbers are 9 digits after the country
  // code (e.g. 50 589 6511), so requiring a 9-digit overlap means the
  // whole subscriber number must agree — preventing area-code-only or
  // junk-suffix collisions while still tolerating "+966" vs leading-0
  // prefix differences between Zoho and the call provider.
  const MIN_OVERLAP_DIGITS = 9;
  for (const r of leads) {
    const p = normalizePhoneDigits(readPhone(r));
    if (!p) continue;
    // Skip leads whose stored Phone is too short to be a real number —
    // they cannot anchor any reliable match.
    if (p.length < MIN_OVERLAP_DIGITS) continue;
    const exact = p === normalized_query;
    // For each suffix-match direction, require the SHORTER side (i.e. the
    // actual overlap length) to be ≥ MIN_OVERLAP_DIGITS. Comparing
    // `.length` of the two values is sufficient because the shorter
    // string is what determines how much of a tail actually matched.
    const leadEndsWithQuery =
      p.endsWith(normalized_query) &&
      normalized_query.length >= MIN_OVERLAP_DIGITS;
    const queryEndsWithLead =
      normalized_query.endsWith(p) && p.length >= MIN_OVERLAP_DIGITS;
    if (exact || leadEndsWithQuery || queryEndsWithLead) {
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


/**
 * Attempt to auto-link a call record to a Zoho Lead by phone match.
 * Tries each candidate phone in order and uses the first one that:
 *   • Normalizes to ≥ 7 digits, AND
 *   • Returns exactly one lead match.
 *
 * On success, persists `lead_id` on the call_records row via the supplied
 * updater callback (kept as a callback so this util doesn't import the
 * DB layer directly — `callIntelligenceRoutes` injects it).
 *
 * Never throws on Zoho/network errors — returns a structured reason.
 */
export async function autoLinkLeadByPhone(
  callRecordId: number,
  phoneCandidates: Array<string | undefined | null>,
  persistLeadId: (callRecordId: number, leadId: string) => Promise<unknown>,
  options: { maxRecords?: number } = {},
): Promise<AutoLinkLeadResult> {
  const phones = (phoneCandidates || []).filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  if (phones.length === 0) {
    return { linked: false, lead_id: null, matches_count: 0, scanned: 0, reason: "no_phone" };
  }

  let lastResult: { matches_count: number; scanned: number; attempted_phone: string } | null = null;
  // Defer ambiguous results — a later candidate may yield a unique match.
  let ambiguousFallback: AutoLinkLeadResult | null = null;
  for (const phone of phones) {
    const normalized = normalizePhoneDigits(phone);
    if (!normalized || normalized.length < 7) continue;
    let result;
    try {
      result = await findLeadsByPhoneMatch(phone, { maxRecords: options.maxRecords });
    } catch {
      // Treat as no-match for this candidate; continue.
      continue;
    }
    lastResult = {
      matches_count: result.matches.length,
      scanned: result.scanned,
      attempted_phone: phone,
    };
    if (result.scanned === 0 && result.matches.length === 0) {
      // Likely no Zoho creds — bail with clear reason.
      return {
        linked: false,
        lead_id: null,
        matches_count: 0,
        scanned: 0,
        reason: "no_zoho",
        attempted_phone: phone,
      };
    }
    if (result.matches.length === 1) {
      const match = result.matches[0];
      try {
        await persistLeadId(callRecordId, match.id);
      } catch {
        // Distinct reason so callers can distinguish "found-but-DB-failed"
        // from "no-match-found"; lead_id is surfaced for diagnostics.
        return {
          linked: false,
          lead_id: match.id,
          matches_count: 1,
          scanned: result.scanned,
          reason: "persist_failed",
          match,
          attempted_phone: phone,
        };
      }
      return {
        linked: true,
        lead_id: match.id,
        matches_count: 1,
        scanned: result.scanned,
        reason: "linked",
        match,
        attempted_phone: phone,
      };
    }
    if (result.matches.length > 1 && !ambiguousFallback) {
      // Remember the first ambiguous result; keep iterating in case a later
      // candidate phone yields a single deterministic match.
      ambiguousFallback = {
        linked: false,
        lead_id: null,
        matches_count: result.matches.length,
        scanned: result.scanned,
        reason: "ambiguous",
        attempted_phone: phone,
      };
    }
  }

  if (ambiguousFallback) return ambiguousFallback;

  return {
    linked: false,
    lead_id: null,
    matches_count: lastResult?.matches_count ?? 0,
    scanned: lastResult?.scanned ?? 0,
    reason: "no_match",
    attempted_phone: lastResult?.attempted_phone,
  };
}
