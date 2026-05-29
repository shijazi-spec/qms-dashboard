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

import {
  fetchAllZohoRecords,
  type ZohoCRMRecord,
  fetchZohoRecords,
  searchZohoRecords,
  searchZohoRecordsByWord,
} from "./zohoCRM";
import { normalizePhoneDigits } from "./callMcpReconciliation";
import {
  phonesShareSubscriberNumber,
  MIN_PHONE_OVERLAP_DIGITS,
} from "./callLeadPhoneMatch";
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

  // ─── Phase 4f: native Zoho search-by-phone (PRIMARY path). ─────────────
  //
  // Until this fix, the matcher fetched the first 2,500 Leads + 2,500 Deals
  // and compared phones in JavaScript. That worked for small CRMs but
  // SILENTLY missed any matching record sitting beyond the cutoff. The
  // 2026-05-28 root cause investigation found Dina Attia (Lead phone
  // 0500966554, owned by r.alsammak) sitting outside the top-2500 window
  // for one of the user's Sep 2025 calls — even though the normalized
  // forms (`500966554` ↔ `500966554`) were a perfect match. Zoho's CRM
  // had grown past 2,500 leads, the lead hadn't been modified recently,
  // and the scan never reached it.
  //
  // The fix: use Zoho's native /crm/v2/<module>/search endpoint with a
  // `Phone:contains:<9 digits>` criteria. Zoho indexes phone fields and
  // returns the matching record(s) regardless of how deep they sit in
  // the CRM, in a single round-trip with no maxRecords cap.
  //
  // We search BOTH Phone and Mobile (Zoho stores Saudi cellphones on
  // either, depending on layout). The OR'd criteria pulls both with
  // one API call per module.
  //
  // Defensive fallback: if the native search returns nothing AND zero
  // errors (so it's a clean "not found" not a transient failure), we
  // still run the legacy 2500-record scan as a safety net. Three
  // reasons we keep the fallback:
  //   1. Older Zoho instances without phone-field indexing skip the
  //      search but might still match via JS-side comparison.
  //   2. The legacy scan catches edge-cases where the phone is stored
  //      in a custom field the search criteria doesn't cover.
  //   3. Belt-and-braces — a regression that breaks native search
  //      degrades to the slower path instead of breaking auto-link.
  const matches: CrmPhoneMatch[] = [];
  let scanned_leads = 0;
  let scanned_deals = 0;
  let nativeSearchSucceeded = false;

  try {
    // CRITICAL: use Zoho's `word=` global search, NOT `criteria=contains`.
    //
    // The 2026-05-28 root-cause investigation found that
    // `Phone:contains:505523305` returns ZERO records even when a lead
    // exists with Phone=966505523305 (Drovox Co's القحطاني نوره) —
    // confirmed by performing the EXACT same query in Zoho's UI search
    // and getting an immediate hit. Zoho's phone fields are indexed for
    // the global `?word=` search but do NOT support the `contains`
    // operator on structured `?criteria=` search.
    //
    // The word-based search (which is what the Zoho UI's global search
    // box uses) does substring lookup across all indexed fields,
    // including phone, mobile, email, name, etc. — exactly what we
    // need. Pass the 9-digit normalized form so every Saudi format
    // (+966505523305, 00966505523305, 966505523305, 0505523305,
    // 505523305) matches the same query.
    const [leadHits, dealHits] = await Promise.allSettled([
      searchZohoRecordsByWord("Leads", normalized_query),
      searchZohoRecordsByWord("Deals", normalized_query),
    ]);

    if (leadHits.status === "fulfilled") {
      nativeSearchSucceeded = true;
      for (const r of leadHits.value) {
        // Re-verify the match on our side using the same normaliser as
        // the JS-fallback path, so a Zoho word-hit that doesn't actually
        // normalize to the same 9 digits (e.g. a 9-digit address suffix
        // that happens to collide with the query) is dropped before we
        // claim a match.
        if (phonesShareSubscriberNumber(readLeadPhone(r), normalized_query)) {
          matches.push(leadToMatch(r));
        }
      }
    } else {
      logger.warn("[sdrCallLinking] Native Leads word-search failed, will fall back to scan", {
        error: leadHits.reason?.message,
      });
    }

    if (dealHits.status === "fulfilled") {
      nativeSearchSucceeded = true;
      for (const r of dealHits.value) {
        if (phonesShareSubscriberNumber(readDealPhone(r), normalized_query)) {
          matches.push(dealToMatch(r));
        }
      }
    } else {
      logger.warn("[sdrCallLinking] Native Deals word-search failed, will fall back to scan", {
        error: dealHits.reason?.message,
      });
    }
  } catch (err: any) {
    logger.warn("[sdrCallLinking] Native word-search threw; falling back to JS scan", {
      error: err?.message || String(err),
    });
  }

  // ─── Native search worked AND found a match → done. ────────────────────
  if (nativeSearchSucceeded && matches.length > 0) {
    return {
      normalized_query,
      matches,
      // Scan counts are 0 here because we used the indexed search; we
      // return -1 sentinels could be confusing for the diagnostic UI.
      // Use 0 + the matches.length speaks for itself.
      scanned_leads: 0,
      scanned_deals: 0,
    };
  }

  // ─── Fallback (PHASE B): legacy 2500-record scan. ──────────────────────
  // Runs when:
  //   (a) Native search threw / partially failed, OR
  //   (b) Native search returned zero matches — possibly a CRM that
  //       stores phones in a custom field, or an indexing gap.
  // Same algorithm we shipped pre-Phase 4f.
  const maxRecords = options.maxRecordsPerModule ?? 2500;

  const [leadsResult, dealsResult] = await Promise.allSettled([
    fetchAllZohoRecords("Leads", { maxRecords }),
    fetchAllZohoRecords("Deals", { maxRecords }),
  ]);

  if (leadsResult.status === "fulfilled") {
    const leads = leadsResult.value;
    scanned_leads = leads.length;
    for (const r of leads) {
      if (phonesShareSubscriberNumber(readLeadPhone(r), normalized_query)) {
        // Avoid duplicate from native search.
        if (!matches.some((m) => m.module === "Leads" && m.id === r.id)) {
          matches.push(leadToMatch(r));
        }
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
      if (phonesShareSubscriberNumber(readDealPhone(r), normalized_query)) {
        if (!matches.some((m) => m.module === "Deals" && m.id === r.id)) {
          matches.push(dealToMatch(r));
        }
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
  scanned_activities?: number;
  /**
   * How the link was decided. "phone" = phone digit match against
   * Leads/Deals. "activity" = fallback heuristic that finds Leads/Deals
   * the same agent touched in CRM on the same day as the call.
   */
  linked_via?: "phone" | "activity" | null;
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

// ─── Activity-based fallback matcher ───────────────────────────────────
//
// Phone matching is the primary signal but misses real cases:
//   • The SDR called from a number not on file (mobile vs office).
//   • Zoho stores phone in a custom field we don't read.
//   • The lead was deduped/merged and the original phone moved.
//
// Fallback: every SDR call in CRM is typically followed by an activity
// (Note, Call log, Task, Event) on the parent Lead/Deal. If the same
// agent logged exactly one such activity on the same day as the
// recorded call, we link the recording to that parent. Same-agent
// same-day matching has a strong precision-vs-recall trade-off — we
// only auto-link when there is exactly one candidate parent.

interface ActivityParent {
  module: CrmModule;
  id: string;
  activities: number;
}

export function ymdInUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function activityFallsOnDay(
  ts: string | undefined | null,
  targetDay: string,
): boolean {
  if (!ts) return false;
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return false;
  return ymdInUTC(parsed) === targetDay;
}

export function ownerMatchesAgent(
  ownerName: string | undefined,
  agentEmail: string,
  agentName: string | null,
): boolean {
  if (!ownerName) return false;
  const ownerLower = ownerName.toLowerCase();
  // Zoho's `r.owner` is set to either Owner.name or Owner.id depending
  // on what came back. Match conservatively: exact case-insensitive
  // match against the agent's email local part OR full name.
  if (agentEmail) {
    const local = agentEmail.split("@")[0]?.toLowerCase();
    if (local && ownerLower === local) return true;
    if (ownerLower === agentEmail.toLowerCase()) return true;
  }
  if (agentName && ownerLower === agentName.toLowerCase()) return true;
  return false;
}

function pushParent(
  parents: Map<string, ActivityParent>,
  module: CrmModule,
  id: string | undefined,
): void {
  if (!id) return;
  const key = `${module}:${id}`;
  const existing = parents.get(key);
  if (existing) {
    existing.activities += 1;
  } else {
    parents.set(key, { module, id, activities: 1 });
  }
}

export interface ActivityMatchResult {
  matches: CrmPhoneMatch[];
  scanned_activities: number;
  errors: Record<string, string>;
}

/**
 * Find Leads/Deals the same agent touched in CRM on the same day as the
 * call. Used as a fallback when phone matching returns nothing.
 *
 * Strategy: pull recent Notes/Calls/Tasks/Events for the day window
 * (±24h to absorb timezone skew), filter to those owned by the agent,
 * collect every distinct Who_Id (→ Lead) and What_Id (→ Deal). Hydrate
 * each unique parent so the caller has full match metadata.
 */
export async function findCrmRecordsByAgentActivity(
  agentEmail: string,
  agentName: string | null,
  callDate: Date,
  options: { perPage?: number } = {},
): Promise<ActivityMatchResult> {
  const errors: Record<string, string> = {};
  if (!agentEmail && !agentName) {
    return { matches: [], scanned_activities: 0, errors };
  }
  const hasZoho =
    process.env.ZOHO_ACCESS_TOKEN ||
    (process.env.ZOHO_CLIENT_ID &&
      process.env.ZOHO_CLIENT_SECRET &&
      process.env.ZOHO_REFRESH_TOKEN);
  if (!hasZoho) {
    return { matches: [], scanned_activities: 0, errors };
  }

  const perPage = options.perPage ?? 200;
  // ±24h window absorbs UTC vs Asia/Riyadh skew without admitting cross-
  // day false positives. Activity must also fall on the call's own day
  // (in UTC) to be counted — the filter below enforces this.
  const from = new Date(callDate.getTime() - 24 * 60 * 60 * 1000);
  const to = new Date(callDate.getTime() + 24 * 60 * 60 * 1000);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const targetDay = ymdInUTC(callDate);

  const safeFetch = async (
    moduleName: "Notes" | "Calls" | "Tasks" | "Events",
    timeField: string,
  ): Promise<ZohoCRMRecord[]> => {
    try {
      return await fetchZohoRecords(moduleName, {
        criteria: `(${timeField}:greater_than:${fromIso})and(${timeField}:less_than:${toIso})`,
        perPage,
      });
    } catch (err: any) {
      errors[moduleName] = String(err?.message || err);
      return [];
    }
  };

  const [notes, calls, tasks, events] = await Promise.all([
    safeFetch("Notes", "Created_Time"),
    safeFetch("Calls", "Call_Start_Time"),
    safeFetch("Tasks", "Created_Time"),
    safeFetch("Events", "Start_DateTime"),
  ]);

  const parents = new Map<string, ActivityParent>();
  let scanned = 0;

  const ingest = (
    rows: ZohoCRMRecord[],
    timeFieldGetter: (d: any) => string | undefined,
  ): void => {
    for (const r of rows) {
      scanned += 1;
      const ts = timeFieldGetter(r.data || {}) || r.createdTime;
      if (!activityFallsOnDay(ts, targetDay)) continue;
      if (!ownerMatchesAgent(r.owner, agentEmail, agentName)) continue;
      const d: any = r.data || {};
      // Who_Id → Leads or Contacts; What_Id → Deals/Accounts. We only
      // claim Lead/Deal links here; Contact links would need a follow-up
      // resolve step (skipped for MVP — the phone matcher already covers
      // that path for converted-contact deals).
      const who = d.Who_Id;
      const what = d.What_Id;
      if (who?.module === "Leads" || (typeof who === "object" && who?.id && d.$se_module === "Leads")) {
        pushParent(parents, "Leads", who.id || who);
      } else if (typeof who === "string") {
        // Older Zoho payload — id only, module unknown. Skip.
      }
      if (what?.module === "Deals" || (typeof what === "object" && what?.id && d.$se_module === "Deals")) {
        pushParent(parents, "Deals", what.id || what);
      }
      // Newer Zoho payload shape: $se_module flags the parent module.
      if (d.$se_module === "Leads" && (who?.id || typeof who === "string")) {
        pushParent(parents, "Leads", who?.id || who);
      }
      if (d.$se_module === "Deals" && (what?.id || typeof what === "string")) {
        pushParent(parents, "Deals", what?.id || what);
      }
    }
  };

  ingest(notes, (d) => d?.Created_Time);
  ingest(calls, (d) => d?.Call_Start_Time);
  ingest(tasks, (d) => d?.Created_Time);
  ingest(events, (d) => d?.Start_DateTime);

  if (parents.size === 0) {
    return { matches: [], scanned_activities: scanned, errors };
  }

  // Hydrate each unique parent so the caller has full match metadata
  // (display name, owner, status). Fetches done in parallel; failures
  // are tolerated per-record so a single 404 doesn't drop the rest.
  const hydrated: CrmPhoneMatch[] = [];
  await Promise.all(
    Array.from(parents.values()).map(async (p) => {
      try {
        const rows = await fetchZohoRecords(p.module, {
          criteria: `(id:equals:${p.id})`,
          perPage: 1,
        });
        if (rows[0]) {
          hydrated.push(p.module === "Leads" ? leadToMatch(rows[0]) : dealToMatch(rows[0]));
        } else {
          // Fall back to a bare match so the caller still sees the id.
          hydrated.push({
            id: p.id,
            module: p.module,
            display_name: undefined,
          });
        }
      } catch (err: any) {
        errors[`hydrate_${p.module}_${p.id}`] = String(err?.message || err);
        hydrated.push({ id: p.id, module: p.module, display_name: undefined });
      }
    }),
  );

  return { matches: hydrated, scanned_activities: scanned, errors };
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
export interface AutoLinkOptions {
  maxRecordsPerModule?: number;
  /** Enables activity-based fallback when phone match is no_phone/no_match. */
  agentEmail?: string;
  agentName?: string | null;
  callDate?: Date | null;
}

export async function autoLinkCallToCrm(
  callRecordId: number,
  phoneCandidates: Array<string | undefined | null>,
  persistLeadId: (callRecordId: number, leadId: string) => Promise<unknown>,
  persistDealId: (callRecordId: number, dealId: string) => Promise<unknown>,
  options: AutoLinkOptions = {},
): Promise<AutoLinkResult> {
  const phones = (phoneCandidates || []).filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );

  let ambiguousFallback: AutoLinkResult | null = null;
  let phoneScannedLeads = 0;
  let phoneScannedDeals = 0;
  let lastAttemptedPhone: string | undefined;
  let noZohoBail = false;

  // Phase 1 — phone match (unchanged primary signal).
  for (const phone of phones) {
    const normalized = normalizePhoneDigits(phone);
    // Require a full subscriber number; a shorter overlap can only collide
    // with junk values (see MIN_PHONE_OVERLAP_DIGITS rationale).
    if (!normalized || normalized.length < MIN_PHONE_OVERLAP_DIGITS) continue;
    lastAttemptedPhone = phone;

    let result: CombinedPhoneMatchResult;
    try {
      result = await findCrmRecordByPhone(phone, {
        maxRecordsPerModule: options.maxRecordsPerModule,
      });
    } catch {
      continue;
    }
    phoneScannedLeads = Math.max(phoneScannedLeads, result.scanned_leads);
    phoneScannedDeals = Math.max(phoneScannedDeals, result.scanned_deals);

    if (
      result.scanned_leads === 0 &&
      result.scanned_deals === 0 &&
      result.matches.length === 0
    ) {
      noZohoBail = true;
      continue;
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
      } catch {
        return {
          linked: false,
          lead_id: match.module === "Leads" ? match.id : null,
          deal_id: match.module === "Deals" ? match.id : null,
          picked_module: match.module,
          picked_match: match,
          matches_count: 1,
          scanned_leads: result.scanned_leads,
          scanned_deals: result.scanned_deals,
          linked_via: "phone",
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
        linked_via: "phone",
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
        linked_via: null,
        reason: "ambiguous",
        attempted_phone: phone,
      };
    }
  }

  // Phase 2 — activity-based fallback. Runs when phone matching didn't
  // produce a unique winner: caller passed no phones, all phones came
  // up empty, or the phone matches were ambiguous. Single unique parent
  // wins; multiple parents stay ambiguous (returned for manual review).
  if (options.agentEmail && options.callDate) {
    const activityRes = await findCrmRecordsByAgentActivity(
      options.agentEmail,
      options.agentName ?? null,
      options.callDate,
    );
    if (activityRes.matches.length === 1) {
      const match = activityRes.matches[0];
      try {
        if (match.module === "Deals") {
          await persistDealId(callRecordId, match.id);
        } else {
          await persistLeadId(callRecordId, match.id);
        }
      } catch {
        return {
          linked: false,
          lead_id: match.module === "Leads" ? match.id : null,
          deal_id: match.module === "Deals" ? match.id : null,
          picked_module: match.module,
          picked_match: match,
          matches_count: 1,
          scanned_leads: phoneScannedLeads,
          scanned_deals: phoneScannedDeals,
          scanned_activities: activityRes.scanned_activities,
          linked_via: "activity",
          reason: "persist_failed",
          attempted_phone: lastAttemptedPhone,
        };
      }
      return {
        linked: true,
        lead_id: match.module === "Leads" ? match.id : null,
        deal_id: match.module === "Deals" ? match.id : null,
        picked_module: match.module,
        picked_match: match,
        matches_count: 1,
        scanned_leads: phoneScannedLeads,
        scanned_deals: phoneScannedDeals,
        scanned_activities: activityRes.scanned_activities,
        linked_via: "activity",
        reason: "linked",
        attempted_phone: lastAttemptedPhone,
      };
    }
    if (activityRes.matches.length > 1 && !ambiguousFallback) {
      ambiguousFallback = {
        linked: false,
        lead_id: null,
        deal_id: null,
        picked_module: null,
        matches_count: activityRes.matches.length,
        scanned_leads: phoneScannedLeads,
        scanned_deals: phoneScannedDeals,
        scanned_activities: activityRes.scanned_activities,
        linked_via: null,
        reason: "ambiguous",
        attempted_phone: lastAttemptedPhone,
      };
    }
  }

  if (ambiguousFallback) return ambiguousFallback;

  if (phones.length === 0 && !options.agentEmail) {
    return {
      linked: false,
      lead_id: null,
      deal_id: null,
      picked_module: null,
      matches_count: 0,
      scanned_leads: 0,
      scanned_deals: 0,
      linked_via: null,
      reason: "no_phone",
    };
  }

  if (noZohoBail) {
    return {
      linked: false,
      lead_id: null,
      deal_id: null,
      picked_module: null,
      matches_count: 0,
      scanned_leads: 0,
      scanned_deals: 0,
      linked_via: null,
      reason: "no_zoho",
      attempted_phone: lastAttemptedPhone,
    };
  }

  return {
    linked: false,
    lead_id: null,
    deal_id: null,
    picked_module: null,
    matches_count: 0,
    scanned_leads: phoneScannedLeads,
    scanned_deals: phoneScannedDeals,
    linked_via: null,
    reason: "no_match",
    attempted_phone: lastAttemptedPhone,
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
