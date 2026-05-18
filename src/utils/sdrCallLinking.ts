/**
 * SDR Call ↔ CRM linking (pre-qualification stage).
 *
 * All calls in the platform belong to the SDR team — pre-qualification is
 * the SDR's stage. Each incoming call needs to find its way to a Zoho
 * Lead OR a Deal so the rest of the pipeline (compliance check, activity
 * timeline, QA scoring) can run with real CRM context.
 *
 * What the existing callLeadPhoneMatch module did: phone-match against
 * the Zoho **Leads module only**. That misses two real scenarios:
 *   1. Lead already converted to a Deal — phone still on the Deal record
 *      but the call has nowhere to attach.
 *   2. Direct-deal SDR calls (rare but happens) where the prospect skipped
 *      the Lead stage.
 *
 * This module extends matching to BOTH modules, picks the best candidate
 * across them, and exposes:
 *   - findCrmRecordByPhone(phone)        — combined match (Leads + Deals)
 *   - autoLinkCallToCrm(callRecord, ...) — wraps the matcher + persists
 *     lead_id OR deal_id back onto call_records
 *   - getSdrActivityTimeline(...)        — returns recent Notes / Tasks /
 *     Events / Calls so the dashboard can show "what the SDR did with
 *     this lead/deal after the call"
 */

import { fetchAllZohoRecords, type ZohoCRMRecord, fetchZohoRecords } from "./zohoCRM";
import { normalizePhoneDigits } from "./callMcpReconciliation";
import { logger } from "./logger";

export type CrmModule = "Leads" | "Deals";

export interface CrmPhoneMatch {
  id: string;
  module: CrmModule;
  full_name?: string;
  phone?: string;
  email?: string;
  owner?: string;
  /** For Deals: the Deal name. For Leads: same as full_name. */
  display_name?: string;
  /** For Deals: current Stage. For Leads: Lead_Status. */
  status?: string;
}

function readLeadPhone(r: ZohoCRMRecord): string {
  const d = r.data || {};
  const raw =
    (typeof d.Phone === "object" && d.Phone?.name) ||
    d.Phone ||
    d.Mobile ||
    (typeof d.Mobile === "object" && d.Mobile?.name) ||
    "";
  return String(raw || "");
}

function readDealPhone(r: ZohoCRMRecord): string {
  // Deals don't have their own Phone field typically — it's on the linked
  // Contact_Name or Account_Name. But many tenants denormalize a Phone
  // field onto the Deal during conversion. Try both.
  const d = r.data || {};
  const fromDealFields =
    (typeof d.Phone === "object" && d.Phone?.name) ||
    d.Phone ||
    d.Mobile ||
    d.Contact_Phone ||
    "";
  if (fromDealFields) return String(fromDealFields);
  // Fall back to the linked Contact's display name (rare to have phone
  // here) — keep this thin and rely on tenants populating a Phone field.
  return "";
}

function leadToMatch(r: ZohoCRMRecord): CrmPhoneMatch {
  const d = r.data || {};
  return {
    id: r.id,
    module: "Leads",
    full_name: d.Full_Name || d.Last_Name || undefined,
    display_name: d.Full_Name || d.Last_Name || undefined,
    phone: readLeadPhone(r),
    email: typeof d.Email === "object" ? d.Email?.name : d.Email,
    owner: r.owner,
    status: d.Lead_Status || undefined,
  };
}

function dealToMatch(r: ZohoCRMRecord): CrmPhoneMatch {
  const d = r.data || {};
  return {
    id: r.id,
    module: "Deals",
    full_name:
      (typeof d.Contact_Name === "object" && d.Contact_Name?.name) ||
      d.Deal_Name ||
      undefined,
    display_name: d.Deal_Name || undefined,
    phone: readDealPhone(r),
    email: undefined,
    owner: r.owner,
    status: d.Stage || undefined,
  };
}

export interface CombinedPhoneMatchResult {
  normalized_query: string;
  matches: CrmPhoneMatch[];
  scanned_leads: number;
  scanned_deals: number;
}

/**
 * Combined phone match across Leads AND Deals. Returns every match across
 * both modules. Callers decide which to pick (the auto-link helper below
 * applies a preference: Deals win over Leads when both match, because a
 * conversion to Deal supersedes the original Lead).
 */
export async function findCrmRecordByPhone(
  phone: string,
  options: { maxRecordsPerModule?: number } = {},
): Promise<CombinedPhoneMatchResult> {
  const normalized_query = normalizePhoneDigits(phone);
  if (!normalized_query) {
    return { normalized_query: "", matches: [], scanned_leads: 0, scanned_deals: 0 };
  }

  const hasZoho =
    process.env.ZOHO_ACCESS_TOKEN ||
    (process.env.ZOHO_CLIENT_ID &&
      process.env.ZOHO_CLIENT_SECRET &&
      process.env.ZOHO_REFRESH_TOKEN);
  if (!hasZoho) {
    return { normalized_query, matches: [], scanned_leads: 0, scanned_deals: 0 };
  }

  const maxRecords = options.maxRecordsPerModule ?? 2500;

  // Run both fetches in parallel. Each failure is local — partial result
  // is still useful (e.g. Leads worked, Deals timed out → return Leads).
  const [leadsResult, dealsResult] = await Promise.allSettled([
    fetchAllZohoRecords("Leads", { maxRecords }),
    fetchAllZohoRecords("Deals", { maxRecords }),
  ]);

  const matches: CrmPhoneMatch[] = [];
  let scanned_leads = 0;
  let scanned_deals = 0;

  if (leadsResult.status === "fulfilled") {
    const leads = leadsResult.value;
    scanned_leads = leads.length;
    for (const r of leads) {
      const p = normalizePhoneDigits(readLeadPhone(r));
      if (!p) continue;
      if (
        p === normalized_query ||
        p.endsWith(normalized_query) ||
        normalized_query.endsWith(p)
      ) {
        matches.push(leadToMatch(r));
      }
    }
  } else {
    logger.warn("[sdrCallLinking] Leads fetch failed", {
      error: leadsResult.reason?.message,
    });
  }

  if (dealsResult.status === "fulfilled") {
    const deals = dealsResult.value;
    scanned_deals = deals.length;
    for (const r of deals) {
      const p = normalizePhoneDigits(readDealPhone(r));
      if (!p) continue;
      if (
        p === normalized_query ||
        p.endsWith(normalized_query) ||
        normalized_query.endsWith(p)
      ) {
        matches.push(dealToMatch(r));
      }
    }
  } else {
    logger.warn("[sdrCallLinking] Deals fetch failed", {
      error: dealsResult.reason?.message,
    });
  }

  return { normalized_query, matches, scanned_leads, scanned_deals };
}

export interface AutoLinkResult {
  linked: boolean;
  lead_id: string | null;
  deal_id: string | null;
  picked_module: CrmModule | null;
  picked_match?: CrmPhoneMatch;
  matches_count: number;
  scanned_leads: number;
  scanned_deals: number;
  reason:
    | "linked"
    | "no_phone"
    | "no_match"
    | "ambiguous"
    | "already_linked"
    | "no_zoho"
    | "persist_failed";
  attempted_phone?: string;
}

/**
 * Attempt to auto-link a call to a CRM record by phone. Tries Leads AND
 * Deals; prefers Deals when both contain a unique match because a Deal
 * supersedes its source Lead (the SDR's call probably continues an
 * already-converted opportunity).
 *
 * Persistence is split into two callbacks so callers don't need to import
 * the DB layer here.
 */
export async function autoLinkCallToCrm(
  callRecordId: number,
  phoneCandidates: Array<string | undefined | null>,
  persistLeadId: (callRecordId: number, leadId: string) => Promise<unknown>,
  persistDealId: (callRecordId: number, dealId: string) => Promise<unknown>,
  options: { maxRecordsPerModule?: number } = {},
): Promise<AutoLinkResult> {
  const phones = (phoneCandidates || []).filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  if (phones.length === 0) {
    return {
      linked: false,
      lead_id: null,
      deal_id: null,
      picked_module: null,
      matches_count: 0,
      scanned_leads: 0,
      scanned_deals: 0,
      reason: "no_phone",
    };
  }

  let ambiguousFallback: AutoLinkResult | null = null;

  for (const phone of phones) {
    const normalized = normalizePhoneDigits(phone);
    if (!normalized || normalized.length < 7) continue;

    let result: CombinedPhoneMatchResult;
    try {
      result = await findCrmRecordByPhone(phone, {
        maxRecordsPerModule: options.maxRecordsPerModule,
      });
    } catch {
      continue;
    }

    if (
      result.scanned_leads === 0 &&
      result.scanned_deals === 0 &&
      result.matches.length === 0
    ) {
      // Both fetches returned nothing — likely no Zoho creds.
      return {
        linked: false,
        lead_id: null,
        deal_id: null,
        picked_module: null,
        matches_count: 0,
        scanned_leads: 0,
        scanned_deals: 0,
        reason: "no_zoho",
        attempted_phone: phone,
      };
    }

    // Prefer Deals when at least one Deal matched — a converted Deal
    // supersedes the original Lead for SDR follow-up.
    const dealMatches = result.matches.filter((m) => m.module === "Deals");
    const leadMatches = result.matches.filter((m) => m.module === "Leads");
    const preferred = dealMatches.length > 0 ? dealMatches : leadMatches;

    if (preferred.length === 1) {
      const match = preferred[0];
      try {
        if (match.module === "Deals") {
          await persistDealId(callRecordId, match.id);
        } else {
          await persistLeadId(callRecordId, match.id);
        }
      } catch (err: any) {
        return {
          linked: false,
          lead_id: match.module === "Leads" ? match.id : null,
          deal_id: match.module === "Deals" ? match.id : null,
          picked_module: match.module,
          picked_match: match,
          matches_count: 1,
          scanned_leads: result.scanned_leads,
          scanned_deals: result.scanned_deals,
          reason: "persist_failed",
          attempted_phone: phone,
        };
      }
      return {
        linked: true,
        lead_id: match.module === "Leads" ? match.id : null,
        deal_id: match.module === "Deals" ? match.id : null,
        picked_module: match.module,
        picked_match: match,
        matches_count: 1,
        scanned_leads: result.scanned_leads,
        scanned_deals: result.scanned_deals,
        reason: "linked",
        attempted_phone: phone,
      };
    }

    if (preferred.length > 1 && !ambiguousFallback) {
      ambiguousFallback = {
        linked: false,
        lead_id: null,
        deal_id: null,
        picked_module: null,
        matches_count: preferred.length,
        scanned_leads: result.scanned_leads,
        scanned_deals: result.scanned_deals,
        reason: "ambiguous",
        attempted_phone: phone,
      };
    }
  }

  if (ambiguousFallback) return ambiguousFallback;

  return {
    linked: false,
    lead_id: null,
    deal_id: null,
    picked_module: null,
    matches_count: 0,
    scanned_leads: 0,
    scanned_deals: 0,
    reason: "no_match",
  };
}

// ─── Activity Timeline ──────────────────────────────────────────────────

export interface ActivityItem {
  module: "Notes" | "Calls" | "Tasks" | "Events";
  id: string;
  title?: string;
  body?: string;
  timestamp?: string;
  status?: string;
  owner?: string;
}

export interface ActivityTimeline {
  record_id: string;
  module: CrmModule;
  since: string;
  counts: {
    notes: number;
    calls: number;
    tasks: number;
    events: number;
  };
  items: ActivityItem[];
  errors: Record<string, string>;
}

/**
 * Fetch the SDR Agent's CRM activities on a linked Lead/Deal since a
 * given date (typically the call_date). Returns counts and a flat list
 * sorted newest-first for the dashboard's "what did the SDR do after
 * this call" view.
 */
export async function getSdrActivityTimeline(
  recordId: string,
  module: CrmModule,
  since: Date | string,
  options: { perPage?: number } = {},
): Promise<ActivityTimeline> {
  const sinceDate = since instanceof Date ? since : new Date(since);
  const sinceIso = isNaN(sinceDate.getTime())
    ? new Date(0).toISOString()
    : sinceDate.toISOString();
  const perPage = options.perPage ?? 10;
  const linkField = module === "Leads" ? "Who_Id" : "What_Id";

  const errors: Record<string, string> = {};
  const items: ActivityItem[] = [];

  const safeFetch = async (
    moduleName: ActivityItem["module"],
    criteria: string,
  ): Promise<ZohoCRMRecord[]> => {
    try {
      return await fetchZohoRecords(moduleName, { criteria, perPage });
    } catch (err: any) {
      errors[moduleName] = String(err?.message || err);
      return [];
    }
  };

  const [notes, calls, tasks, events] = await Promise.all([
    safeFetch(
      "Notes",
      `(Parent_Id:equals:${recordId})and(Created_Time:greater_than:${sinceIso})`,
    ),
    safeFetch(
      "Calls",
      `(${linkField}:equals:${recordId})and(Call_Start_Time:greater_than:${sinceIso})`,
    ),
    safeFetch(
      "Tasks",
      `(${linkField}:equals:${recordId})and(Created_Time:greater_than:${sinceIso})`,
    ),
    safeFetch(
      "Events",
      `(${linkField}:equals:${recordId})and(Start_DateTime:greater_than:${sinceIso})`,
    ),
  ]);

  for (const n of notes) {
    items.push({
      module: "Notes",
      id: n.id,
      title: (n.data as any)?.Note_Title || "Note",
      body: (n.data as any)?.Note_Content || "",
      timestamp: n.createdTime,
      owner: n.owner,
    });
  }
  for (const c of calls) {
    items.push({
      module: "Calls",
      id: c.id,
      title: (c.data as any)?.Subject || "Call",
      body: (c.data as any)?.Description || "",
      timestamp:
        (c.data as any)?.Call_Start_Time || c.modifiedTime || c.createdTime,
      status: (c.data as any)?.Call_Status || undefined,
      owner: c.owner,
    });
  }
  for (const t of tasks) {
    items.push({
      module: "Tasks",
      id: t.id,
      title: (t.data as any)?.Subject || "Task",
      body: (t.data as any)?.Description || "",
      timestamp: t.createdTime,
      status: (t.data as any)?.Status || undefined,
      owner: t.owner,
    });
  }
  for (const e of events) {
    items.push({
      module: "Events",
      id: e.id,
      title: (e.data as any)?.Event_Title || "Event",
      body: (e.data as any)?.Description || "",
      timestamp:
        (e.data as any)?.Start_DateTime || e.modifiedTime || e.createdTime,
      owner: e.owner,
    });
  }

  // Newest first
  items.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return tb - ta;
  });

  return {
    record_id: recordId,
    module,
    since: sinceIso,
    counts: {
      notes: notes.length,
      calls: calls.length,
      tasks: tasks.length,
      events: events.length,
    },
    items,
    errors,
  };
}
