/**
 * One-shot, idempotent backfill for legacy `call_records` rows that
 * predate the auto-link + whisper-duration fixes.
 *
 * Three independent passes — each one is a no-op for rows that already
 * have the data, so re-running on every boot is safe:
 *
 *   1. Phone backfill — bulk-upload filenames like
 *      `call_<ts>_+966537600548 by n.alasmi@walaplus.com on …wav`
 *      carry the customer phone right in the name. The original
 *      ingest path only set `metadata.contact_phone` when the
 *      operator pasted a phone into the lead-id field, so the 196
 *      production rows ended up with no phone metadata and the
 *      auto-link matcher had nothing to feed into Zoho. This pass
 *      pulls the first `+?\d{10,15}` substring out of the recording
 *      filename and parks it under `metadata.contact_phone`.
 *
 *   2. Duration backfill — historical rows were transcribed with the
 *      old `gpt-4o-mini-transcribe` model, which does not return
 *      audio duration, so `duration_seconds` is NULL and the
 *      Call Records / SDR Evaluation header both display "--". The
 *      audio file is still on disk under `uploads/calls/`; we run
 *      `ffprobe` against it and persist the rounded seconds.
 *
 *   3. Auto-link backfill — once (1) has populated phones, run
 *      `autoLinkCallToCrm` on still-unlinked rows. Capped per boot
 *      so a 196-row backlog can't flood Zoho's API quota on a single
 *      cold start; the rest gets picked up on subsequent boots.
 *
 * Designed to be called as `void backfillUnpopulatedCallData()` from
 * the route module's bootstrap so it never blocks server startup and
 * never throws into the init chain.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "./logger";
import {
  callIntelligencePool as pool,
  updateCallRecord,
  updateCallRecordLeadId,
  updateCallRecordDealId,
} from "./callIntelligenceDb";
import { autoLinkCallToCrm } from "./sdrCallLinking";
import { extractCallPhoneCandidates } from "./callLeadPhoneMatch";

const PHONE_RX = /\+?\d[\d\s\-()]{8,18}\d/;

/** First plausible phone substring in the given text, or "" if none. */
export function extractPhoneFromText(s: string | null | undefined): string {
  if (!s) return "";
  const m = String(s).match(PHONE_RX);
  if (!m) return "";
  // Keep the +country prefix when present; strip whitespace/punctuation.
  const cleaned = m[0].replace(/[\s\-()]/g, "");
  // Reject runs that don't have at least 9 digits (too short to be a real
  // mobile and would just produce false matches in Zoho).
  const digits = cleaned.replace(/\D/g, "");
  return digits.length >= 9 ? cleaned : "";
}

/** Pass 1 — pull phone from recording_url/original_filename. */
async function backfillPhonesFromFilenames(): Promise<{ updated: number; scanned: number }> {
  const res = await pool.query(`
    SELECT id, recording_url, metadata
      FROM call_records
     WHERE (metadata->>'contact_phone') IS NULL
       AND (
            recording_url ~ '\\+?[0-9][0-9 \\-()]{8,}'
         OR (metadata->>'original_filename') ~ '\\+?[0-9][0-9 \\-()]{8,}'
       )
     LIMIT 500
  `);
  let updated = 0;
  for (const row of res.rows) {
    const fname =
      (row.metadata && row.metadata.original_filename) ||
      row.recording_url ||
      "";
    const phone = extractPhoneFromText(fname);
    if (!phone) continue;
    try {
      await pool.query(
        `UPDATE call_records
            SET metadata = COALESCE(metadata, '{}'::jsonb)
                          || jsonb_build_object('contact_phone', $2::text)
          WHERE id = $1`,
        [row.id, phone],
      );
      updated++;
    } catch (err: any) {
      logger.warn("[CallBackfill] phone update failed", {
        id: row.id,
        error: err?.message || String(err),
      });
    }
  }
  return { updated, scanned: res.rows.length };
}

function runFfprobe(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    proc.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      const n = parseFloat(out.trim());
      resolve(Number.isFinite(n) && n > 0 ? Math.round(n) : null);
    });
  });
}

/** Pass 2 — ffprobe local audio file for rows with NULL duration. */
async function backfillDurationsFromAudio(): Promise<{ updated: number; scanned: number; missing: number }> {
  const res = await pool.query(`
    SELECT id, recording_url
      FROM call_records
     WHERE (duration_seconds IS NULL OR duration_seconds = 0)
       AND recording_url IS NOT NULL
       AND recording_url LIKE '/uploads/calls/%'
     LIMIT 200
  `);
  let updated = 0;
  let missing = 0;
  for (const row of res.rows) {
    // recording_url is the URL path "/uploads/calls/<name>"; the file
    // lives at "<cwd>/uploads/calls/<name>" (see callIntelligenceRoutes
    // bulk-audio upload path).
    const rel = String(row.recording_url).replace(/^\//, "");
    const abs = path.resolve(rel);
    if (!fs.existsSync(abs)) {
      missing++;
      continue;
    }
    const seconds = await runFfprobe(abs);
    if (!seconds) continue;
    try {
      await updateCallRecord(row.id, { duration_seconds: seconds });
      updated++;
    } catch (err: any) {
      logger.warn("[CallBackfill] duration update failed", {
        id: row.id,
        error: err?.message || String(err),
      });
    }
  }
  return { updated, scanned: res.rows.length, missing };
}

/** Pass 3 — try auto-linking unlinked calls now that phones are present. */
async function backfillAutoLinks(perBootCap: number): Promise<{
  attempted: number;
  linked: number;
  ambiguous: number;
  no_match: number;
  no_phone: number;
  no_zoho: boolean;
}> {
  const hasZoho =
    process.env.ZOHO_ACCESS_TOKEN ||
    (process.env.ZOHO_CLIENT_ID &&
      process.env.ZOHO_CLIENT_SECRET &&
      process.env.ZOHO_REFRESH_TOKEN);
  if (!hasZoho) {
    return { attempted: 0, linked: 0, ambiguous: 0, no_match: 0, no_phone: 0, no_zoho: true };
  }
  const res = await pool.query(
    `
    SELECT id, agent_email, agent_name, call_date, created_at, metadata,
           recording_url, contact_phone
      FROM call_records
     WHERE lead_id IS NULL
       AND deal_id IS NULL
       AND (
            (metadata->>'contact_phone') IS NOT NULL
         OR contact_phone IS NOT NULL
       )
     ORDER BY id DESC
     LIMIT $1
  `,
    [perBootCap],
  );
  let attempted = 0;
  let linked = 0;
  let ambiguous = 0;
  let no_match = 0;
  let no_phone = 0;
  for (const row of res.rows) {
    attempted++;
    const phones = extractCallPhoneCandidates(row);
    if (phones.length === 0) {
      no_phone++;
      continue;
    }
    try {
      const result = await autoLinkCallToCrm(
        row.id,
        phones,
        updateCallRecordLeadId,
        updateCallRecordDealId,
        {
          agentEmail: row.agent_email || undefined,
          agentName: row.agent_name || null,
          callDate: row.call_date
            ? new Date(row.call_date)
            : row.created_at
              ? new Date(row.created_at)
              : null,
        },
      );
      if (result.linked) linked++;
      else if (result.reason === "ambiguous") ambiguous++;
      else if (result.reason === "no_phone") no_phone++;
      else no_match++;
    } catch (err: any) {
      logger.warn("[CallBackfill] auto-link failed", {
        id: row.id,
        error: err?.message || String(err),
      });
    }
  }
  return { attempted, linked, ambiguous, no_match, no_phone, no_zoho: false };
}

/**
 * Pass 4 — re-validate every linked call against Zoho's current phone.
 *
 * Why: even after the 9-digit floor (MIN_PHONE_OVERLAP_DIGITS) was
 * applied symmetrically in commit ed95616, the EXISTING bad
 * `call_records.lead_id` values written by old code (or before the
 * floor existed) survive in the DB. They show up on the dashboard as
 * "Non-Compliant" compliance rows pointing at junk Zoho Leads whose
 * Phone field is literally "11" (or some other sub-9-digit junk).
 * The user has to know about the "Audit CRM Links" button to clean
 * them up.
 *
 * Strategy: same algorithm as POST /api/calls/audit-crm-links, just
 * bounded per boot so it can run on every cold start without exhausting
 * the Zoho daily API budget. Already-correct links are read once and
 * left alone (free verification); confirmed mismatches are cleared so
 * `backfillAutoLinks` (Pass 3, runs BEFORE this — see ordering note in
 * backfillUnpopulatedCallData) re-links them on the next boot via the
 * new Leads + Contact→Deal walk in `findCrmRecordByPhone`.
 *
 * Skipped:
 *   - linked_via='activity' rows (those weren't claimed-via-phone, so
 *     a phone mismatch isn't a defect — the activity matcher chose
 *     them for a different reason).
 *   - Rows where the Zoho parent record can't be read (deleted /
 *     permission / temporary Zoho failure) — keep conservatively to
 *     avoid clearing a still-valid link on a transient error.
 *   - Rows where the call has no extractable phone — can't prove a
 *     mismatch, leave alone.
 *
 * Per-boot cap defaults to 50 (≈ 50 Zoho reads / cold start) to stay
 * well under the daily limit even after the other passes have run.
 */
async function cleanupMismatchedLinks(perBootCap: number): Promise<{
  scanned: number;
  cleared: number;
  kept: number;
  unreadable: number;
  no_phone: number;
  no_zoho: boolean;
}> {
  const hasZoho =
    process.env.ZOHO_ACCESS_TOKEN ||
    (process.env.ZOHO_CLIENT_ID &&
      process.env.ZOHO_CLIENT_SECRET &&
      process.env.ZOHO_REFRESH_TOKEN);
  if (!hasZoho) {
    return {
      scanned: 0,
      cleared: 0,
      kept: 0,
      unreadable: 0,
      no_phone: 0,
      no_zoho: true,
    };
  }

  const { fetchZohoRecords } = await import("./zohoCRM");
  const { phonesShareSubscriberNumber } = await import("./callLeadPhoneMatch");
  const { clearCallRecordCrmLink } = await import("./callIntelligenceDb");

  // Order by id ASC so the cap is deterministic and successive boots
  // make forward progress through the table even if Zoho's daily
  // quota interrupts the sweep mid-pass.
  const candidatesRes = await pool.query(
    `
    SELECT id, call_id, lead_id, deal_id, linked_via, metadata,
           agent_email, agent_name, call_date, contact_phone
      FROM call_records
     WHERE (lead_id IS NOT NULL OR deal_id IS NOT NULL)
       AND linked_via IS DISTINCT FROM 'activity'
     ORDER BY id ASC
     LIMIT $1
    `,
    [perBootCap],
  );

  let cleared = 0;
  let kept = 0;
  let unreadable = 0;
  let no_phone = 0;

  for (const rec of candidatesRes.rows) {
    const callPhones = extractCallPhoneCandidates(rec) || [];
    if (callPhones.length === 0) {
      no_phone++;
      continue;
    }
    const module: "Leads" | "Deals" = rec.lead_id ? "Leads" : "Deals";
    const recordId = String(rec.lead_id || rec.deal_id);
    let zohoPhone: string | null = null;
    try {
      const rows = await fetchZohoRecords(module, {
        criteria: `id:equals:${recordId}`,
        perPage: 1,
      });
      const r: any = rows[0];
      if (!r) {
        unreadable++;
        continue;
      }
      const d = r.data || {};
      const raw =
        (typeof d.Phone === "object" && d.Phone?.name) ||
        d.Phone ||
        (typeof d.Mobile === "object" && d.Mobile?.name) ||
        d.Mobile ||
        "";
      zohoPhone = String(raw || "").trim() || null;
    } catch {
      unreadable++;
      continue;
    }
    if (!zohoPhone) {
      // Deal/Lead exists but has no phone field at all — can't prove a
      // mismatch from the phone side, defer to the audit button.
      unreadable++;
      continue;
    }

    const overlaps = callPhones.some((p: string) =>
      phonesShareSubscriberNumber(zohoPhone as string, p),
    );
    if (overlaps) {
      kept++;
      continue;
    }

    // Confirmed mismatch under the 9-digit-floor rule. Clear the link;
    // the next boot's Pass 3 (backfillAutoLinks) will re-link via the
    // new Lead → Contact→Deal walk if a real match exists.
    try {
      await clearCallRecordCrmLink(rec.id);
      cleared++;
      logger.warn(
        `[CallBackfill] cleared mismatched ${module} link on call ${rec.id} — Zoho phone "${zohoPhone}" does not match any call phone (call_phones=${JSON.stringify(callPhones)})`,
      );
    } catch (err: any) {
      // Cleared++ deferred so the count reflects actual DB writes.
      logger.warn("[CallBackfill] clear failed", {
        callId: rec.id,
        error: err?.message || String(err),
      });
    }

    // Cooperative throttle so we stay polite under Zoho's per-second
    // RPS cap when the sweep is at its busiest.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    scanned: candidatesRes.rows.length,
    cleared,
    kept,
    unreadable,
    no_phone,
    no_zoho: false,
  };
}

/**
 * Run all four passes. Logs a single summary line. Designed to be
 * fire-and-forget at process startup; any unexpected failure is
 * caught and logged without throwing.
 *
 * `perBootCap` bounds the Zoho-touching passes so cold starts with
 * hundreds of rows can't blow through the daily API quota in one go.
 * Remaining rows are picked up on later boots.
 *
 * Order matters:
 *   1. backfillPhonesFromFilenames — populates contact_phone metadata.
 *   2. backfillDurationsFromAudio   — populates duration_seconds where missing.
 *   3. backfillAutoLinks            — links UNLINKED calls now that phones exist.
 *   4. cleanupMismatchedLinks       — clears stale phone-mismatched links
 *                                      written by pre-fix code. Anything cleared
 *                                      here gets a fresh re-link attempt on the
 *                                      NEXT boot's Pass 3.
 */
let _ran = false;
export async function backfillUnpopulatedCallData(
  opts: { perBootCap?: number } = {},
): Promise<void> {
  if (_ran) return; // one shot per process
  _ran = true;
  const perBootCap = opts.perBootCap ?? 25;
  try {
    const phones = await backfillPhonesFromFilenames();
    const durations = await backfillDurationsFromAudio();
    const links = await backfillAutoLinks(perBootCap);
    // Same cap envelope as the auto-link pass — both touch Zoho per row.
    const mismatch = await cleanupMismatchedLinks(perBootCap * 2);
    logger.info("[CallBackfill] boot sweep complete", {
      phones,
      durations,
      links,
      mismatch,
    });
  } catch (err: any) {
    logger.warn("[CallBackfill] sweep failed", {
      error: err?.message || String(err),
    });
  }
}
