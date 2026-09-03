import {
  fetchAllCRMProviderRecords,
  searchCRMProviderRecords,
  searchCRMProviderRecordsByWord,
  type CRMProviderCRMRecord,
} from "./CRMProviderCRM";
import { normalizePhoneDigits } from "./callMcpReconciliation";
import {
  CRM_PHONE_MATCH_SCOPE,
  CRM_PHONE_MATCH_SCOPE_DESCRIPTION,
} from "./callMcpImportSources";

export { CRM_PHONE_MATCH_SCOPE, CRM_PHONE_MATCH_SCOPE_DESCRIPTION };

export interface AutoLinkLeadResult {
  linked: boolean;
  lead_id: string | null;
  // 2026-05-29: also surface a deal_id when the auto-linker walks
  // through a Contact and finds the Deal it belongs to (the common
  // post-conversion case where the original Lead is gone from CRMProvider).
  deal_id?: string | null;
  // Which CRMProvider module the linker actually matched against. "Leads" is
  // the original path; "Deals_via_Contact" is the new fallback.
  matched_via?: "Leads" | "Deals_via_Contact";
  matches_count: number;
  scanned: number;
  reason:
    | "linked"
    | "no_phone"
    | "no_match"
    | "ambiguous"
    | "already_linked"
    | "no_CRMProvider"
    | "persist_failed";
  match?: LeadPhoneMatch;
  // When matched via the Contact → Deal fallback, expose the underlying
  // Contact id/name so the operator can see WHY this Deal was picked.
  contact_match?: {
    id: string;
    full_name?: string;
    phone?: string;
    email?: string;
  };
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

// Minimum overlap length for a suffix phone match. Without this floor a
// junk Lead with Phone="11" (or any short value) matches every call
// whose number happens to end with those digits — producing CRM
// Compliance rows that link the call to a completely unrelated record
// (e.g. <REDACTED_PHONE> silently auto-linked to a Lead whose phone is
// "11" because "<REDACTED_PHONE>".endsWith("11")). Set to 9 per ops
// decision: KSA / GCC mobile subscriber numbers are 9 digits after the
// country code (e.g. <REDACTED_PHONE>, so requiring a 9-digit overlap means
// the whole subscriber number must agree — preventing area-code-only or
// junk-suffix collisions while still tolerating "+966" vs leading-0
// prefix differences between CRMProvider and the call provider.
export const MIN_PHONE_OVERLAP_DIGITS = 9;

/**
 * True when two phone strings refer to the same subscriber number.
 * Both are normalized to digits, then matched either exactly or by a
 * suffix overlap of at least MIN_PHONE_OVERLAP_DIGITS. Shared by the
 * Lead matcher and the link-audit sweep so they stay in lockstep.
 */
export function phonesShareSubscriberNumber(a: string, b: string): boolean {
  const x = normalizePhoneDigits(a || "");
  const y = normalizePhoneDigits(b || "");
  if (!x || !y) return false;
  // Exact-equality match must clear the 9-digit floor too — without this
  // gate, two short junk values that agree (Lead Phone="11" matched to a
  // call whose extracted phone normalised to the same "11", or any other
  // sub-9-digit duplicate) pass through as a false positive. Historical
  // root cause of "<REDACTED_PHONE>" linking to a Junk Lead whose Phone was
  // literally "11" — the suffix branch below correctly rejected the
  // match (2 < 9), but the equality branch inherited no floor and let it
  // through. Closed 2026-05-29 in lockstep with the audit sweep at
  // POST /api/calls/audit-crm-links which cleans up the stale survivors.
  if (x === y && x.length >= MIN_PHONE_OVERLAP_DIGITS) return true;
  // A suffix match only counts when the SHORTER side (the actual overlap
  // length) is ≥ the floor. Anything shorter is data noise.
  if (x.endsWith(y) && y.length >= MIN_PHONE_OVERLAP_DIGITS) return true;
  if (y.endsWith(x) && x.length >= MIN_PHONE_OVERLAP_DIGITS) return true;
  return false;
}

function readPhone(r: CRMProviderCRMRecord): string {
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
 * Best-effort: scan **all Leads fetched** from CRMProvider (bounded by `maxRecords`)
 * and return those whose Phone/Mobile normalizes to the same digit string as `phone`.
 * Product scope: **Leads module only** — no Contacts, Deals, or Activities.
 * See `CRM_PHONE_MATCH_SCOPE_DESCRIPTION`.
 */
export async function findLeadsByPhoneMatch(
  phone: string,
  options: { maxRecords?: number } = {},
): Promise<{
  normalized_query: string;
  matches: LeadPhoneMatch[];
  scanned: number;
  CRMProvider_connected?: boolean;
  note?: string;
}> {
  const normalized_query = normalizePhoneDigits(phone);
  if (!normalized_query) {
    return {
      normalized_query: "",
      matches: [],
      scanned: 0,
      note: "No digits found in the supplied phone value.",
    };
  }
  // A suffix match requires a MIN_PHONE_OVERLAP_DIGITS-long overlap, so a
  // query shorter than that floor can never match anything except an exact
  // junk value. Surface that explicitly instead of returning a misleading
  // empty "No matches" result.
  if (normalized_query.length < MIN_PHONE_OVERLAP_DIGITS) {
    return {
      normalized_query,
      matches: [],
      scanned: 0,
      note: `Phone must contain at least ${MIN_PHONE_OVERLAP_DIGITS} digits to match a subscriber number (got ${normalized_query.length}).`,
    };
  }

  const hasCRMProvider =
    process.env.CRMProvider_ACCESS_TOKEN ||
    (process.env.CRMProvider_CLIENT_ID &&
      process.env.CRMProvider_CLIENT_SECRET &&
      process.env.CRMProvider_REFRESH_TOKEN);
  if (!hasCRMProvider) {
    return {
      normalized_query,
      matches: [],
      scanned: 0,
      CRMProvider_connected: false,
      note: "CRMProvider CRM is not connected, so no Leads could be scanned.",
    };
  }

  const maxRecords = options.maxRecords ?? 2500;
  const leads = await fetchAllCRMProviderRecords("Leads", { maxRecords });
  const matches: LeadPhoneMatch[] = [];
  for (const r of leads) {
    const leadPhone = readPhone(r);
    if (phonesShareSubscriberNumber(leadPhone, normalized_query)) {
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
 * Attempt to auto-link a call record to a CRMProvider Lead by phone match.
 * Tries each candidate phone in order and uses the first one that:
 *   • Normalizes to ≥ 7 digits, AND
 *   • Returns exactly one lead match.
 *
 * On success, persists `lead_id` on the call_records row via the supplied
 * updater callback (kept as a callback so this util doesn't import the
 * DB layer directly — `callIntelligenceRoutes` injects it).
 *
 * Never throws on CRMProvider/network errors — returns a structured reason.
 */
export async function autoLinkLeadByPhone(
  callRecordId: number,
  phoneCandidates: Array<string | undefined | null>,
  persistLeadId: (callRecordId: number, leadId: string) => Promise<unknown>,
  options: {
    maxRecords?: number;
    // 2026-05-29: optional Deal persister + linked_via setter so the
    // matcher can record a Contact → Deal fallback link. When omitted,
    // the matcher reverts to the legacy Leads-only behaviour so existing
    // callers (e.g. tests) keep their original semantics.
    persistDealId?: (callRecordId: number, dealId: string) => Promise<unknown>;
    persistLinkedVia?: (
      callRecordId: number,
      via: "phone" | "phone_via_contact",
    ) => Promise<unknown>;
  } = {},
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
    // Must be at least a full subscriber number; anything shorter can only
    // collide with junk values (see MIN_PHONE_OVERLAP_DIGITS rationale).
    if (!normalized || normalized.length < MIN_PHONE_OVERLAP_DIGITS) continue;
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
      // Likely no CRMProvider creds — bail with clear reason.
      return {
        linked: false,
        lead_id: null,
        matches_count: 0,
        scanned: 0,
        reason: "no_CRMProvider",
        attempted_phone: phone,
      };
    }
    if (result.matches.length === 1) {
      const match = result.matches[0];
      try {
        await persistLeadId(callRecordId, match.id);
        if (options.persistLinkedVia) {
          await options.persistLinkedVia(callRecordId, "phone").catch(() => undefined);
        }
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
          matched_via: "Leads",
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
        matched_via: "Leads",
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
        matched_via: "Leads",
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Contact → Deal fallback (2026-05-29).
  //
  // The Leads-only matcher misses every call whose Lead has already
  // been converted in CRMProvider. Conversion moves the phone from Leads to
  // Contact + Deal + Account and removes the Lead row from the Leads
  // module entirely, so the historical scan returns 0 matches and the
  // call shows "Auto-link could not match this call to any CRMProvider Lead/
  // Deal (no_match)" — even though the same phone number is alive on
  // the converted Deal.
  //
  // Strategy: only run this fallback when a deal persister is supplied
  // (so legacy callers stay on the old behaviour), and only when the
  // Leads pass returned a no-match (not ambiguous and not a CRMProvider-cred
  // failure). For each phone candidate, ask CRMProvider's word-search index
  // for Contacts whose phone field matches, filter to those whose
  // normalised phone truly overlaps by MIN_PHONE_OVERLAP_DIGITS, then
  // look up the Deals related to each matching Contact via the
  // structured criteria search `(Contact_Name:equals:<contactId>)`.
  //
  // If exactly one Deal is found, link the call to it. Multiple Deals
  // for the same Contact → ambiguous (the operator picks via the
  // existing Search CRM by phone widget in the call-details modal).
  //
  // Cost: at most one word search + one criteria search per phone
  // candidate per Contact. Word search is the indexed CRMProvider global
  // lookup the UI uses, so it's much cheaper than the bulk
  // fetchAllCRMProviderRecords scan the Leads path performs.
  if (options.persistDealId && !ambiguousFallback) {
    for (const phone of phones) {
      const normalized = normalizePhoneDigits(phone);
      if (!normalized || normalized.length < MIN_PHONE_OVERLAP_DIGITS) continue;
      let contactsRaw: CRMProviderCRMRecord[] = [];
      try {
        contactsRaw = await searchCRMProviderRecordsByWord("Contacts", normalized);
      } catch {
        continue;
      }
      // Word search is fuzzy — verify the phone actually overlaps so
      // we don't link a call to a Contact whose name *coincidentally*
      // contains the digits (unlikely but possible in transliterated
      // Arabic names with digits).
      const realContactMatches = contactsRaw.filter((c) =>
        phonesShareSubscriberNumber(readPhone(c), normalized),
      );
      if (realContactMatches.length === 0) continue;

      // Iterate Contact matches; first to resolve to exactly one Deal wins.
      // If every contact has 0 or multiple deals, defer to ambiguous /
      // no_match below.
      let dealAmbig: AutoLinkLeadResult | null = null;
      for (const c of realContactMatches) {
        let deals: CRMProviderCRMRecord[] = [];
        try {
          deals = await searchCRMProviderRecords(
            "Deals",
            `(Contact_Name:equals:${c.id})`,
          );
        } catch {
          continue;
        }
        if (deals.length === 1) {
          const dealId = deals[0].id;
          const cData = c.data || {};
          const contactSummary = {
            id: c.id,
            full_name:
              (typeof cData.Full_Name === "object"
                ? cData.Full_Name?.name
                : cData.Full_Name) || cData.Last_Name || undefined,
            phone: readPhone(c),
            email:
              typeof cData.Email === "object"
                ? cData.Email?.name
                : cData.Email,
          };
          try {
            await options.persistDealId(callRecordId, dealId);
            if (options.persistLinkedVia) {
              await options
                .persistLinkedVia(callRecordId, "phone_via_contact")
                .catch(() => undefined);
            }
          } catch {
            return {
              linked: false,
              lead_id: null,
              deal_id: dealId,
              matches_count: 1,
              scanned: lastResult?.scanned ?? 0,
              reason: "persist_failed",
              attempted_phone: phone,
              matched_via: "Deals_via_Contact",
              contact_match: contactSummary,
            };
          }
          return {
            linked: true,
            lead_id: null,
            deal_id: dealId,
            matches_count: 1,
            scanned: lastResult?.scanned ?? 0,
            reason: "linked",
            attempted_phone: phone,
            matched_via: "Deals_via_Contact",
            contact_match: contactSummary,
          };
        }
        if (deals.length > 1 && !dealAmbig) {
          dealAmbig = {
            linked: false,
            lead_id: null,
            deal_id: null,
            matches_count: deals.length,
            scanned: lastResult?.scanned ?? 0,
            reason: "ambiguous",
            attempted_phone: phone,
            matched_via: "Deals_via_Contact",
          };
        }
      }
      if (dealAmbig) return dealAmbig;
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
