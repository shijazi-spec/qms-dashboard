/**
 * Per-lead/per-phone call history query.
 *
 * Backs the new GET /api/calls/lead-history endpoint and the
 * dashboard/lead-history.html page. Per DMAIC Improve phase Solution #2
 * (scope item #4 in the strategic report): SDRs and managers need a
 * single view that shows EVERY call for a given phone number or Zoho
 * Lead/Deal — currently the dashboard only filters call_records by one
 * dimension at a time.
 *
 * Lookup modes:
 *   - lead_id  → match call_records.lead_id (Zoho ID, opaque string)
 *   - deal_id  → match call_records.deal_id
 *   - phone    → match digits-only suffix in metadata->>'from_number'
 *                or metadata->>'to_number' (normalized via regexp_replace)
 *
 * Phone matching uses the last 7 digits to avoid country-code mismatches
 * (Five9 sends +966..., Zoho often holds 05...; both end with the same
 * 7-digit subscriber number). 7-digit suffix is what
 * extractCallPhoneCandidates uses for its own matching, so the two stay
 * consistent — if auto-link found a match, lead-history will find it too.
 *
 * Includes a single LEFT JOIN to the most-recent sdr_call_evaluation row
 * per call so the timeline can show QA scores inline. call_analysis +
 * compliance + transcript come from separate fetches the caller can do
 * on-demand (avoids fanning out an expensive 3-way join for the list view).
 */

import { logger as safeLogger } from "./logger";

export type LeadHistoryLookupType = "lead_id" | "deal_id" | "phone";

export interface LeadHistoryQuery {
  /** One of these MUST be set; otherwise the route returns 400. */
  lead_id?: string;
  deal_id?: string;
  /** Phone in any format — will be digits-normalized. */
  phone?: string;
  /** Max calls to return. Default 200, clamp 1..500. */
  limit?: number;
}

export interface LeadHistoryCall {
  id: number;
  call_id: string;
  source: string;
  call_date: Date | null;
  agent_email: string | null;
  agent_name: string | null;
  contact_name: string | null;
  direction: string;
  duration_seconds: number | null;
  status: string;
  lead_id: string | null;
  deal_id: string | null;
  linked_via: string | null;
  recording_url: string | null;
  /** Latest SDR evaluation score (null if no eval). */
  overall_score: number | null;
  evaluation_status: string | null;
}

export interface LeadHistoryResult {
  identifier: string;
  identifier_type: LeadHistoryLookupType;
  call_count: number;
  unique_agents: number;
  date_range: { earliest: Date | null; latest: Date | null };
  /** Newest-first. */
  calls: LeadHistoryCall[];
}

/**
 * Normalize a phone number to its digits-only suffix.
 * Returns null if the input has fewer than PHONE_SUFFIX_DIGITS digits (too
 * ambiguous to match against — would explode the result set).
 */
// KSA / GCC subscriber numbers are 9 digits after the country code, so the
// phone lookup requires a full 9-digit subscriber number. A shorter suffix
// (e.g. 7 digits) collides across unrelated leads/calls — the same junk-match
// problem the Lead matcher's MIN_PHONE_OVERLAP_DIGITS floor guards against.
export const PHONE_SUFFIX_DIGITS = 9;

export function phoneToDigitSuffix(phone: string): string | null {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length < PHONE_SUFFIX_DIGITS) return null;
  return digits.slice(-PHONE_SUFFIX_DIGITS);
}

/**
 * Pick the lookup type from the query. Validates that exactly one
 * identifier is provided; returns an error string when invalid.
 */
export function resolveLookupType(
  q: LeadHistoryQuery,
):
  | { ok: true; type: LeadHistoryLookupType; identifier: string }
  | { ok: false; error: string } {
  const set = [
    ["lead_id", q.lead_id],
    ["deal_id", q.deal_id],
    ["phone", q.phone],
  ].filter(([, v]) => v && String(v).trim() !== "") as [string, string][];

  if (set.length === 0) {
    return {
      ok: false,
      error: "Provide one of lead_id, deal_id, or phone.",
    };
  }
  if (set.length > 1) {
    return {
      ok: false,
      error: "Provide exactly one of lead_id, deal_id, or phone (not multiple).",
    };
  }
  const [type, identifier] = set[0];
  return {
    ok: true,
    type: type as LeadHistoryLookupType,
    identifier: String(identifier).trim(),
  };
}

/**
 * Build the parameterized SQL + values array for a lookup. Exported
 * separately so it's easy to test in isolation (no DB needed).
 */
export function buildLookupSql(
  type: LeadHistoryLookupType,
  identifier: string,
  limit: number,
): { sql: string; values: any[] } | { sql: null; error: string } {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit || 200)), 500);

  // Common SELECT clause — call_records + latest sdr_call_evaluation
  // joined laterally so we get one eval per call (the most recent).
  const baseSelect = `
    SELECT
      cr.id, cr.call_id, cr.source, cr.call_date,
      cr.agent_email, cr.agent_name, cr.contact_name,
      cr.direction, cr.duration_seconds, cr.status,
      cr.lead_id, cr.deal_id, cr.linked_via, cr.recording_url,
      eval.overall_score, eval.status AS evaluation_status
    FROM call_records cr
    LEFT JOIN LATERAL (
      SELECT overall_score, status
      FROM sdr_call_evaluations
      WHERE call_record_id = cr.id
      ORDER BY created_at DESC NULLS LAST
      LIMIT 1
    ) eval ON TRUE
  `;

  if (type === "lead_id") {
    return {
      sql: `${baseSelect}
            WHERE cr.lead_id = $1
            ORDER BY cr.call_date DESC NULLS LAST
            LIMIT ${safeLimit}`,
      values: [identifier],
    };
  }

  if (type === "deal_id") {
    return {
      sql: `${baseSelect}
            WHERE cr.deal_id = $1
            ORDER BY cr.call_date DESC NULLS LAST
            LIMIT ${safeLimit}`,
      values: [identifier],
    };
  }

  if (type === "phone") {
    const suffix = phoneToDigitSuffix(identifier);
    if (!suffix) {
      return {
        sql: null,
        error: `Phone needs at least ${PHONE_SUFFIX_DIGITS} digits to be searchable.`,
      };
    }
    // Match digit-only suffix of from_number or to_number in metadata.
    // regexp_replace strips non-digits; the LIKE compares the last
    // PHONE_SUFFIX_DIGITS digits so country-code variation doesn't break the
    // match while still requiring a full subscriber-number overlap.
    return {
      sql: `${baseSelect}
            WHERE regexp_replace(COALESCE(cr.metadata->>'from_number',''), '\\D', '', 'g') LIKE $1
               OR regexp_replace(COALESCE(cr.metadata->>'to_number',''),   '\\D', '', 'g') LIKE $1
               OR regexp_replace(COALESCE(cr.metadata->>'phone',''),        '\\D', '', 'g') LIKE $1
            ORDER BY cr.call_date DESC NULLS LAST
            LIMIT ${safeLimit}`,
      values: [`%${suffix}`],
    };
  }

  // Defensive — never reached if resolveLookupType passed.
  return { sql: null, error: `Unknown lookup type: ${type}` };
}

/**
 * Aggregate a result set into the summary fields exposed alongside
 * the calls list.
 */
export function summarizeCalls(rows: LeadHistoryCall[]): {
  call_count: number;
  unique_agents: number;
  date_range: { earliest: Date | null; latest: Date | null };
} {
  if (rows.length === 0) {
    return {
      call_count: 0,
      unique_agents: 0,
      date_range: { earliest: null, latest: null },
    };
  }
  const agents = new Set(rows.map((r) => r.agent_email).filter(Boolean));
  const dates = rows
    .map((r) => (r.call_date ? new Date(r.call_date) : null))
    .filter((d): d is Date => d !== null && !Number.isNaN(d.getTime()));
  dates.sort((a, b) => a.getTime() - b.getTime());
  return {
    call_count: rows.length,
    unique_agents: agents.size,
    date_range: {
      earliest: dates[0] ?? null,
      latest: dates[dates.length - 1] ?? null,
    },
  };
}

/**
 * Run the query against the DB pool. The pool is passed in (rather
 * than imported here) so this module stays unit-testable with a mock.
 */
export async function fetchLeadHistory(
  pool: { query: (text: string, values: any[]) => Promise<{ rows: any[] }> },
  q: LeadHistoryQuery,
): Promise<LeadHistoryResult | { error: string; status: number }> {
  const lookup = resolveLookupType(q);
  if (!lookup.ok) return { error: lookup.error, status: 400 };

  const built = buildLookupSql(lookup.type, lookup.identifier, q.limit || 200);
  if (built.sql === null) {
    return { error: built.error, status: 400 };
  }

  try {
    const result = await pool.query(built.sql, built.values);
    const rows = result.rows as LeadHistoryCall[];
    const summary = summarizeCalls(rows);
    return {
      identifier: lookup.identifier,
      identifier_type: lookup.type,
      ...summary,
      calls: rows,
    };
  } catch (err: any) {
    safeLogger.error("[leadHistory] query failed", {
      type: lookup.type,
      error: err?.message || String(err),
    });
    return { error: "Query failed", status: 500 };
  }
}
