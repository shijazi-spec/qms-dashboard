/**
 * LOST-DEAL RE-ENGAGEMENT CHECK (Sarah 2026-09-01).
 *
 * A DIFFERENT question from the Mawsool preflight. Mawsool asks "should I import
 * this NEW contact?", so its very first rule rejects anything already in the CRM.
 * Running a list of LOST DEALS through that returns "duplicate contact — already
 * in the CRM" for essentially every row, which is true BY DEFINITION and tells
 * Sales nothing (observed on the first attempt: 1,247 of 1,433 rows, plus 140
 * more rejected on the KSA-phone gate).
 *
 * Here the rows ARE existing CRM deals, and the question is:
 *     "can Sales approach this company AGAIN?"
 *
 * Exactly TWO verdicts, by Sarah's instruction — no REVIEW tier:
 *   BLOCK — off-limits right now, because ONE of:
 *             1. protected / do-not-contact account (Aramco group, Tree, Syarah)
 *             2. active DOAM client (HR-ministry subscription; may not look like
 *                a client in the CRM at all)
 *             3. current active client
 *             4. churned client still inside the sector cool-off
 *             5. a LIVE OPEN deal exists today — a colleague is already working
 *                the company; the deal LINK + owner + stage are surfaced, the
 *                same way the Mawsool output does it
 *             6. the lost deal itself is still inside the cool-off, measured
 *                from its Closing (lost) Date
 *   PASS  — none of the above; safe to re-approach.
 *
 * Cool-off windows are the agreed sector ones: 180d Private / 365d Government,
 * with the sector inferred from the domain (.gov.sa ⇒ Government).
 *
 * DELIBERATELY NOT APPLIED HERE: the contact-duplicate rule and the mandatory
 * KSA-phone gate. Both are import-time concerns and meaningless when the company
 * is already in the CRM — they are exactly what made the first attempt useless.
 */
import {
  getCsClientDirectory,
  getOpenDealDirectory,
  _csContainmentMatch,
  matchDoamClient,
  matchProtectedAccount,
  buildZohoRecordUrl,
  type CsClientStatus,
  type OpenDealDirectory,
} from "./duplicateRadarPreflight";
import { detectSector } from "./duplicateRadarCsOverlap";
import {
  extractDomain,
  normalizeDomain,
  normalizeCompanyName,
  isPlaceholderName,
} from "./duplicateRadarDatabase";
import { logger } from "./logger";

export interface ReengageInputRow {
  /** Zoho Deal id (the sheet's "Record Id"; a leading `zcrm_` is stripped). */
  record_id?: string | null;
  deal_name?: string | null;
  company_name?: string | null;
  /** Explicit domain column; falls back to the email's domain. */
  domain?: string | null;
  email?: string | null;
  owner?: string | null;
  /** Closing / lost date — the cool-off anchor for the lost deal itself. */
  closing_date?: string | null;
  lost_reason?: string | null;
  ref?: string | null;
}

export interface ReengageResultRow {
  row_index: number;
  record_id: string | null;
  deal_name: string | null;
  company_name: string | null;
  domain: string | null;
  owner: string | null;
  closing_date: string | null;
  lost_reason: string | null;
  verdict: "block" | "pass";
  /** Machine reason code. */
  reason: string;
  /** Operator-facing sentence. */
  comment: string;
  sector: "private" | "government" | null;
  cooloff_days: number;
  days_since_lost: number | null;
  /** Who blocks it (CS owner / deal owner) — null on PASS. */
  blocker_owner: string | null;
  /** The blocking LIVE deal, when that is the reason. */
  blocking_deal_url: string | null;
  blocking_deal_name: string | null;
  blocking_deal_stage: string | null;
  /** Link back to the lost deal itself. */
  deal_url: string | null;
}

export interface ReengageResponse {
  total_rows: number;
  examined: number;
  summary: { block: number; pass: number };
  reasons: Array<{ label: string; count: number; pct: number }>;
  rows: ReengageResultRow[];
  generated_at: string;
}

/** "zcrm_5146753000194563135" → "5146753000194563135". */
function stripZcrm(id: string | null | undefined): string | null {
  const s = String(id ?? "").trim();
  if (!s) return null;
  return s.replace(/^zcrm_/i, "") || null;
}

/** Whole days between a date and now; null when absent/unparseable. */
function daysSince(value: string | null | undefined): number | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const t = Date.parse(s.replace(" ", "T"));
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

const REASON_LABELS: Record<string, string> = {
  protected_account: "Protected / do-not-contact account",
  doam_client: "DOAM client (HR-gov subscription)",
  existing_active_client: "Existing active client — route to Customer Success",
  client_within_cooloff: "Churned client still inside the cool-off",
  live_open_deal: "Live open deal — coordinate with the deal owner",
  lost_within_cooloff: "Lost too recently — still inside the cool-off",
  safe_to_reengage: "Safe to re-approach",
};

export async function runLostDealReengagement(input: {
  rows: ReengageInputRow[];
  max_check?: number;
}): Promise<ReengageResponse> {
  const cap = Math.max(1, Math.min(input.max_check ?? 20000, 20000));
  const rows = input.rows ?? [];
  const examined = Math.min(rows.length, cap);
  const out: ReengageResultRow[] = [];
  const summary = { block: 0, pass: 0 };

  const csDir = await getCsClientDirectory(Date.now());
  // Mirror-based open-deal directory: one query for the whole batch. Safe to
  // trust now that the incremental sync windows correctly (a live Zoho check
  // would mean one round-trip per row — thousands on a list this size).
  let openDealDir: OpenDealDirectory = {
    byDomain: new Map(),
    byName: new Map(),
    builtAt: Date.now(),
    count: 0,
  };
  try {
    openDealDir = await getOpenDealDirectory();
  } catch (e: any) {
    logger.warn(
      `[reengage] open-deal directory unavailable, live-deal check skipped: ${e?.message || e}`,
    );
  }

  for (let i = 0; i < examined; i++) {
    const r = rows[i]!;
    const domain =
      normalizeDomain(String(r.domain || "")) ||
      extractDomain(String(r.email || "")) ||
      null;
    const rawName = String(r.company_name || r.deal_name || "").trim();
    const nm =
      rawName && !isPlaceholderName(rawName) ? normalizeCompanyName(rawName) : "";
    const dealId = stripZcrm(r.record_id);
    const sector = detectSector({ domain }) ?? "private";
    const coolOff = sector === "government" ? 365 : 180;
    const sectorLabel = sector === "government" ? "Government" : "Private";
    const lostDays = daysSince(r.closing_date);

    const base = {
      row_index: i,
      record_id: dealId,
      deal_name: (r.deal_name || "").toString().trim() || null,
      company_name: rawName || null,
      domain,
      owner: (r.owner || "").toString().trim() || null,
      closing_date: (r.closing_date || "").toString().trim() || null,
      lost_reason: (r.lost_reason || "").toString().trim() || null,
      sector,
      cooloff_days: coolOff,
      days_since_lost: lostDays,
      blocker_owner: null as string | null,
      blocking_deal_url: null as string | null,
      blocking_deal_name: null as string | null,
      blocking_deal_stage: null as string | null,
      deal_url: dealId ? buildZohoRecordUrl("Deals", dealId) : null,
    };
    const emit = (
      verdict: "block" | "pass",
      reason: string,
      comment: string,
      extra?: Partial<ReengageResultRow>,
    ) => {
      summary[verdict]++;
      // Cast: spreading a Partial<> after the full base widens each overridden
      // field to `| undefined` in TS's eyes, though every required field is
      // present on `base`.
      out.push({ ...base, verdict, reason, comment, ...(extra || {}) } as ReengageResultRow);
    };

    // 1. Protected / do-not-contact — always wins.
    const prot = matchProtectedAccount(domain, rawName);
    if (prot) {
      emit(
        "block",
        "protected_account",
        `BLOCK — protected account (${prot.label}): do-not-contact. Never re-approach.`,
      );
      continue;
    }

    // 2. DOAM — subscribed via the HR ministry, so it may not look like a client
    //    in the CRM at all, yet cold-contacting it is wrong.
    const doam = matchDoamClient({ domain, company_name: rawName });
    if (doam && doam.client.active) {
      emit(
        "block",
        "doam_client",
        `BLOCK — DOAM client "${doam.client.en}": subscribed through the HR ministry (auto-renewing). Do not re-approach.`,
      );
      continue;
    }

    // 3 / 4. Existing-client state — active now, or churned inside the cool-off.
    let cs: CsClientStatus | null = null;
    if (domain && csDir.byDomain.has(domain)) cs = csDir.byDomain.get(domain)!;
    else if (nm && csDir.byName.has(nm)) cs = csDir.byName.get(nm)!;
    else if (nm && nm.length >= 4) {
      const contained = _csContainmentMatch(nm, csDir);
      if (contained) cs = csDir.byName.get(contained) ?? null;
    }
    if (cs) {
      const csCool = cs.sector === "government" ? 365 : 180;
      const csSector = cs.sector === "government" ? "Government" : "Private";
      if (cs.active) {
        emit(
          "block",
          "existing_active_client",
          `BLOCK — existing active client${cs.csOwner ? ` (CS owner: ${cs.csOwner})` : ""}. Route through Customer Success, do not re-approach as new business.`,
          { blocker_owner: cs.csOwner || null, cooloff_days: csCool },
        );
        continue;
      }
      if (cs.churnDays != null && cs.churnDays <= csCool) {
        emit(
          "block",
          "client_within_cooloff",
          `BLOCK — churned ${cs.churnDays}d ago, still inside the ${csCool}-day ${csSector} cool-off (${csCool - cs.churnDays}d remaining). CS sign-off required first.`,
          { blocker_owner: cs.csOwner || null, cooloff_days: csCool },
        );
        continue;
      }
    }

    // 5. A LIVE OPEN deal today — a colleague is already working this company.
    //    Surface the deal link + owner + stage, exactly as the Mawsool output.
    const live =
      (domain ? openDealDir.byDomain.get(domain) : undefined) ??
      (nm ? openDealDir.byName.get(nm) : undefined) ??
      null;
    if (live) {
      emit(
        "block",
        "live_open_deal",
        `BLOCK — a live open deal already exists: "${live.dealName}"${live.stage ? ` (stage: ${live.stage})` : ""}${live.owner ? ` owned by ${live.owner}` : ""}. Coordinate with that owner instead of re-approaching.`,
        {
          blocker_owner: live.owner || null,
          blocking_deal_url: buildZohoRecordUrl("Deals", live.zohoId),
          blocking_deal_name: live.dealName,
          blocking_deal_stage: live.stage || null,
        },
      );
      continue;
    }

    // 6. The lost deal itself is still inside the cool-off.
    if (lostDays != null && lostDays < coolOff) {
      emit(
        "block",
        "lost_within_cooloff",
        `BLOCK — lost ${lostDays}d ago, still inside the ${coolOff}-day ${sectorLabel} cool-off (${coolOff - lostDays}d remaining).`,
      );
      continue;
    }

    // 7. Clear — safe to re-approach.
    emit(
      "pass",
      "safe_to_reengage",
      `PASS — safe to re-approach: not a current client, no live deal, ${
        lostDays != null
          ? `lost ${lostDays}d ago (past the ${coolOff}-day ${sectorLabel} cool-off)`
          : "no closing date on file"
      }.`,
    );
  }

  const buckets = new Map<string, number>();
  for (const r of out) {
    const label = REASON_LABELS[r.reason] || r.reason;
    buckets.set(label, (buckets.get(label) ?? 0) + 1);
  }
  const reasons = Array.from(buckets.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({
      label,
      count,
      pct: examined > 0 ? Math.round((count / examined) * 1000) / 10 : 0,
    }));

  return {
    total_rows: rows.length,
    examined,
    summary,
    reasons,
    rows: out,
    generated_at: new Date().toISOString(),
  };
}
