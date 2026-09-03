/**
 * CRMProvider Calls module → call_records import.
 *
 * Until now the platform only ingested calls uploaded directly to it
 * (ContactCenterProvider / manual / API). Calls logged only in CRMProvider's Calls module —
 * which is most of the SDR team's day-to-day activity — never made it
 * into call_records, so they couldn't be QA-scored, evaluated against
 * scorecards, or surfaced in the dashboard.
 *
 * This module fetches CRMProvider Calls and upserts them into call_records via
 * the existing createCallRecord() (which is idempotent on call_id, so
 * re-running the import is safe). Recording URLs are passed through when
 * CRMProvider has them; otherwise the call is created in status='pending' with
 * just the metadata, ready for the user to attach audio or run scorecard
 * checks based on the CRMProvider-stored description.
 *
 * Per-call linkage (lead/deal) is preserved from CRMProvider's Who_Id/What_Id
 * fields. The existing autoLinkCallToCrm helper (Phase 2 SDR work) will
 * not re-run for imported calls since they already have a lead/deal.
 */

import { fetchAllCRMProviderRecords, getCRMProviderConnectionStatus, type CRMProviderCRMRecord } from "./CRMProviderCRM";
import { createCallRecord } from "./callIntelligenceDb";
import { logger } from "./logger";

export interface CRMProviderCallsImportOptions {
  /** Maximum records to import in one run. Defaults to 500. */
  maxRecords?: number;
  /** Only import calls created/started after this date (ISO). Defaults to last 30 days. */
  sinceIso?: string;
  /** Filter by Owner email if set (matches against CRMProvider Owner.email). */
  ownerEmailFilter?: string;
  /** Force direction filter (CRMProvider returns mixed). */
  directionFilter?: "inbound" | "outbound";
}

export interface CRMProviderCallsImportResult {
  scanned: number;
  imported_new: number;
  updated_existing: number;
  <REDACTED_TOKEN>: number;
  <REDACTED_TOKEN>: number;
  errors: number;
  error_samples: string[];
  duration_ms: number;
  filters_applied: {
    since: string;
    max_records: number;
    owner_email?: string;
    direction?: string;
  };
}

/**
 * Map a CRMProvider Calls module record's Call_Type field to our normalised
 * "inbound" / "outbound". CRMProvider values seen in the wild: "Outbound Call",
 * "Inbound Call", "Missed Call" (treat as inbound — caller initiated).
 */
function normaliseDirection(CRMProviderCallType: unknown): "inbound" | "outbound" {
  const v = String(CRMProviderCallType ?? "").toLowerCase();
  if (v.includes("outbound")) return "outbound";
  return "inbound";
}

/**
 * Coerce CRMProvider's Call_Duration to seconds. CRMProvider exposes two related
 * fields: Call_Duration_in_seconds (numeric, preferred) and
 * Call_Duration (string in either "5" minutes or "mm:ss" form).
 * Tolerant of both.
 */
function durationToSeconds(raw: any): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "number") return raw;
  const s = String(raw).trim();
  if (!s) return undefined;
  if (s.includes(":")) {
    const [mins, secs] = s.split(":").map((p) => Number.parseInt(p, 10));
    if (Number.isFinite(mins) && Number.isFinite(secs)) {
      return mins * 60 + secs;
    }
  }
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n)) return undefined;
  // If the value is small (< 600), CRMProvider is likely reporting minutes.
  // If it's larger, assume seconds. Heuristic — Call_Duration_in_seconds
  // is the authoritative numeric field, this branch handles the legacy
  // string form.
  return n < 600 ? n * 60 : n;
}

function extractLinkedIds(raw: any): {
  lead_id?: string;
  deal_id?: string;
  contact_name?: string;
} {
  const who = raw?.Who_Id;
  const what = raw?.What_Id;
  const out: { lead_id?: string; deal_id?: string; contact_name?: string } =
    {};
  // CRMProvider returns Who_Id / What_Id as { id, name } lookups OR as $se_module
  // hints. Without a definitive module marker we treat Who_Id as either a
  // contact (preferred for contact_name) and What_Id as the
  // account/deal pointer. The auto-link helper can refine post-import by
  // walking phone matches if needed.
  if (who && typeof who === "object" && who.id) {
    // CRMProvider sometimes includes a `$se_module` discriminator at parent level.
    const seModule = raw.$se_module || raw.SE_Module || "";
    if (String(seModule).toLowerCase().includes("lead")) {
      out.lead_id = String(who.id);
    }
    out.contact_name = who.name ? String(who.name) : undefined;
  }
  if (what && typeof what === "object" && what.id) {
    // What_Id maps to Deals OR Accounts. We tag as deal_id when unsure —
    // the compliance check and auto-link helpers handle either case.
    out.deal_id = String(what.id);
  }
  return out;
}

function pickOwner(raw: any): { email: string; name?: string } {
  const owner = raw?.Owner;
  if (owner && typeof owner === "object") {
    return {
      email: String(owner.email || owner.id || "<REDACTED_EMAIL>"),
      name: owner.name ? String(owner.name) : undefined,
    };
  }
  return { email: "<REDACTED_EMAIL>" };
}

export async function runCRMProviderCallsImport(
  options: CRMProviderCallsImportOptions = {},
): Promise<CRMProviderCallsImportResult> {
  const t0 = Date.now();
  const maxRecords = options.maxRecords ?? 500;
  const sinceIso =
    options.sinceIso ??
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const ownerEmail = options.ownerEmailFilter?.toLowerCase().trim();
  const direction = options.directionFilter;

  const conn = getCRMProviderConnectionStatus();
  const result: CRMProviderCallsImportResult = {
    scanned: 0,
    imported_new: 0,
    updated_existing: 0,
    <REDACTED_TOKEN>: 0,
    <REDACTED_TOKEN>: 0,
    errors: 0,
    error_samples: [],
    duration_ms: 0,
    filters_applied: {
      since: sinceIso,
      max_records: maxRecords,
      owner_email: ownerEmail,
      direction,
    },
  };

  // Gate on CONFIGURED, not CONNECTED.
  //
  // `connected` is `!!cachedAccessToken && !isTokenExpired()` — i.e. "a token
  // is already warm IN THIS PROCESS". It says nothing about whether CRMProvider is
  // usable: getValidAccessToken() refreshes on demand (CRMProviderCRM.ts:306), so the
  // fetch below succeeds from a cold cache on its own.
  //
  // Gating on `connected` therefore made the FIRST import after every server
  // restart fail with "CRMProvider is not connected" even though OAuth was working —
  // and a republish restarts the server, so this fired on exactly the run an
  // operator was most likely to make. Observed live 2026-08-17: the import
  // returned "Scanned 0 / Errors: 1 / CRMProvider is not connected" while the
  // Duplicate Radar was syncing from CRMProvider perfectly.
  //
  // `configured` is the real precondition (OAuth config present, or a static
  // CRMProvider_ACCESS_TOKEN). A genuine auth failure still surfaces — it just comes
  // from the API call below, with CRMProvider's actual error, instead of a
  // misleading blanket message.
  if (!conn.configured) {
    result.errors = 1;
    result.error_samples.push(
      "CRMProvider is not configured — set the CRMProvider OAuth credentials (or CRMProvider_ACCESS_TOKEN) before importing calls.",
    );
    result.duration_ms = Date.now() - t0;
    return result;
  }
  if (conn.rateLimited) {
    result.errors = 1;
    result.error_samples.push(conn.message);
    result.duration_ms = Date.now() - t0;
    return result;
  }

  // Pull recent calls, time-windowed by the If-Modified-Since HEADER on the
  // LIST endpoint — NOT by a criteria filter.
  //
  // This used to pass `(Created_Time:greater_than:<since>)`. That filter never
  // worked: criteria sent to the list endpoint is silently ignored by CRMProvider, so
  // the import was really pulling "the most recent N calls" and the window was
  // decorative. Once criteria was correctly routed to /search, CRMProvider rejected it
  // outright with "400 - Invalid query formed" (its search criteria does not
  // accept a greater_than on Created_Time in this form), which is how the
  // long-standing breakage finally became visible.
  //
  // If-Modified-Since is the mechanism that actually works here, and it is what
  // CRMProviderCRM.ts documents as the reliable incremental filter. It also keeps the
  // list endpoint, so sort_by/sort_order still apply — /search cannot sort, so
  // the "newest first" guarantee this import relies on would otherwise be lost.
  //
  // Semantics shift slightly and deliberately: modified-since rather than
  // created-since, so a call edited after the fact is re-imported. That is
  // desirable — the upsert is keyed on call_id, so re-importing refreshes it.
  // PAGINATED. This used to call fetchCRMProviderRecords, which fetches ONE page —
  // CRMProvider caps a page at 200, so the import silently stopped at 200 calls no
  // matter what `max` was set to. Measured live 2026-08-17: requesting max=2000
  // still returned "scanned: 200". The 30-day window looked like it was working
  // because each run happened to return a slightly different 200 (ordering
  // shifts as records are modified), so the total crept up run over run and
  // masked the cap.
  //
  // fetchAllCRMProviderRecords walks the pages and honours maxRecords, the same way the
  // Tasks sync does.
  let calls: CRMProviderCRMRecord[] = [];
  try {
    calls = await fetchAllCRMProviderRecords("Calls", {
      ifModifiedSince: sinceIso,
      maxRecords,
      sortBy: "Created_Time",
      sortOrder: "desc",
    });
  } catch (err: any) {
    result.errors++;
    result.error_samples.push(
      `CRMProvider fetch failed: ${err?.message || String(err)}`,
    );
    result.duration_ms = Date.now() - t0;
    return result;
  }

  for (const c of calls) {
    if (result.scanned >= maxRecords) break;
    result.scanned++;
    const raw = c.data || {};

    try {
      const callDirection = normaliseDirection(raw.Call_Type);
      if (direction && callDirection !== direction) {
        // Mismatch on direction filter — skipped silently (not an error).
        continue;
      }

      const owner = pickOwner(raw);
      if (ownerEmail && owner.email.toLowerCase() !== ownerEmail) {
        result.<REDACTED_TOKEN>++;
        continue;
      }

      const linkage = extractLinkedIds(raw);
      // Calls that don't link to ANY CRM entity are kept (they can still
      // be scorecard-evaluated) but we count them so the operator can
      // gauge how clean their CRMProvider Call logging is.
      if (!linkage.lead_id && !linkage.deal_id) {
        result.<REDACTED_TOKEN>++;
      }

      const recordingUrl =
        typeof raw.Recording_URL === "string"
          ? raw.Recording_URL
          : typeof raw.Call_Recording_URL === "string"
            ? raw.Call_Recording_URL
            : undefined;

      const callDate = raw.Call_Start_Time || raw.Created_Time;
      const created = await createCallRecord({
        call_id: `CRMProvider-${c.id}`,
        source: "CRMProvider_calls",
        lead_id: linkage.lead_id,
        deal_id: linkage.deal_id,
        contact_name: linkage.contact_name,
        agent_email: owner.email,
        agent_name: owner.name,
        direction: callDirection,
        duration_seconds: durationToSeconds(
          raw.Call_Duration_in_seconds ?? raw.Call_Duration,
        ),
        recording_url: recordingUrl,
        call_date: callDate ? new Date(callDate) : new Date(),
        // CRMProvider-imported calls land in `uploaded` when we have a
        // recording_url to transcribe later, or `evaluated` when CRMProvider
        // already supplies the analysis fields and there's no audio
        // to download. Same semantic split as the legacy pending/
        // analyzed pair, just in the new 8-state enum.
        status: recordingUrl ? "uploaded" : "evaluated",
        metadata: {
          CRMProvider_id: c.id,
          CRMProvider_subject: raw.Subject || null,
          CRMProvider_description: raw.Description || null,
          CRMProvider_call_purpose: raw.Call_Purpose || null,
          CRMProvider_se_module: raw.$se_module || raw.SE_Module || null,
          CRMProvider_created_time: c.createdTime,
          CRMProvider_modified_time: c.modifiedTime,
          CRMProvider_owner_id: raw.Owner?.id || null,
          // If there's no recording we mark the call analyzed-but-empty
          // so the dashboard's "Analyzed" KPI counts it (operator chose
          // to log this call without audio; scorecard runs against the
          // Description text instead of a transcript).
          imported_without_recording: !recordingUrl,
        },
      });

      // createCallRecord's ON CONFLICT (call_id) only touches status +
      // updated_at — so the upsert path silently keeps the rest of the
      // row intact. For our purposes that's a no-op refresh. We approximate
      // "is this an insert" by checking if the returned row's created_at
      // is within 5 seconds of `now`.
      const isFresh =
        created.created_at &&
        Date.now() - new Date(created.created_at as any).getTime() < 5000;
      if (isFresh) result.imported_new++;
      else result.updated_existing++;
    } catch (err: any) {
      result.errors++;
      if (result.error_samples.length < 5) {
        result.error_samples.push(
          `${c.id}: ${err?.message || String(err)}`.slice(0, 200),
        );
      }
    }
  }

  result.duration_ms = Date.now() - t0;
  logger.info("[CRMProviderCallsImport] complete", result);
  return result;
}
