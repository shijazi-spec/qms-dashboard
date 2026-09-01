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
  _csFuzzyMatch,
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
  /** HOW this row was checked against the CRM — "domain" is the strongest,
   *  "name" means company/deal name only (weaker), "none" means nothing to
   *  match on (those BLOCK as unverifiable). Lets the operator see at a glance
   *  which PASS rows rest on softer evidence. */
  verified_via: "domain" | "name" | "none";
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

/**
 * Whole days between a date and now; null when absent/unparseable.
 *
 * Must survive THREE shapes, because ExcelJS hands back whatever the cell held:
 *   • a real Date object            → "Thu Aug 27 2026 00:00:00 GMT+0300 (…)"
 *   • the sheet's text form         → "2026-08-27 00:00:00"
 *   • an ISO string                 → "2026-08-27T00:00:00.000Z"
 * The original version only tried `s.replace(" ", "T")`, which replaces just the
 * FIRST space — correct for the text form but it mangles a Date's toString into
 * "ThuTAug 27 2026 …", so every row parsed as null and the lost-date cool-off
 * rule silently never fired (2026-09-01: 0 of 1,433 rows got a day count).
 */
function daysSince(value: string | Date | null | undefined): number | null {
  if (value instanceof Date) {
    return isNaN(value.getTime())
      ? null
      : Math.floor((Date.now() - value.getTime()) / 86400000);
  }
  const s = String(value ?? "").trim();
  if (!s) return null;
  let t = Date.parse(s); // handles ISO and a Date's toString directly
  if (isNaN(t)) t = Date.parse(s.replace(" ", "T")); // "YYYY-MM-DD HH:MM:SS"
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

/**
 * GOVERNMENT BY NAME (Sarah 2026-09-01 — "I need ZERO errors").
 *
 * detectSector reads the DOMAIN only, so a row with no domain always fell to the
 * 180-day PRIVATE window. The lost-deal sheet is full of exactly that case:
 * SDAIA (deal name "سدايا"), the Real Estate Development Fund, the Saudi Water
 * Authority, the National Housing Company and MODON all arrived with no domain
 * and were treated as private.
 *
 * Only UNAMBIGUOUS public-sector markers are listed. Deliberately excluded:
 *   • مؤسسة  — used by private establishments ("مؤسسة مطاعم ذوق البهارات")
 *   • شركة / جمعية / مدرسة — company / charity / school, not government
 *   • جامعة  — private universities exist (جامعة اليمامة); public ones are
 *              covered precisely by the govEduDomains list instead.
 * Erring toward "government" is the SAFE direction here: it lengthens the
 * cool-off (more likely to BLOCK), so a false positive costs a delayed
 * approach, never a wrong one. Env-extendable: REENGAGE_GOV_NAME_TOKENS.
 */
function govNameTokens(): string[] {
  const raw = process.env.REENGAGE_GOV_NAME_TOKENS;
  if (raw && raw.trim()) {
    return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return [
    "وزارة",
    "هيئة",
    "رئاسة",
    "أمانة",
    "امانة",
    "ديوان",
    "مصلحة",
    "صندوق",
    "المركز الوطني",
    "مركز المعلومات الوطني",
    "الهيئة العامة",
    "ministry",
    "authority",
    "commission",
    "general authority",
    "national center",
    "national centre",
    "royal commission",
  ];
}

/** True when a company/deal name carries an unambiguous public-sector marker. */
function looksGovernmentByName(...names: Array<string | null | undefined>): boolean {
  const toks = govNameTokens();
  for (const n of names) {
    const s = String(n ?? "").toLowerCase();
    if (!s) continue;
    if (toks.some((t) => s.includes(t))) return true;
  }
  return false;
}

const REASON_LABELS: Record<string, string> = {
  protected_account: "Protected / do-not-contact account",
  doam_client: "DOAM client (HR-gov subscription)",
  existing_active_client: "Existing active client — route to Customer Success",
  client_within_cooloff: "Churned client still inside the cool-off",
  live_open_deal: "Live open deal — coordinate with the deal owner",
  lost_within_cooloff: "Lost too recently — still inside the cool-off",
  unverifiable: "Cannot verify — no domain and no usable company name",
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
    const rawDeal = String(r.deal_name || "").trim();
    // Search BOTH the company name AND the deal name (Sarah 2026-09-01): they
    // often differ, and sometimes ONLY the deal name carries the real identity
    // — "مركز المعلومات الوطني" has deal name "سدايا" (SDAIA).
    const nameCandidates = Array.from(
      new Set(
        [rawName, rawDeal]
          .filter((s) => s && !isPlaceholderName(s))
          .map((s) => normalizeCompanyName(s))
          .filter((s) => s && s.length >= 4),
      ),
    );
    const dealId = stripZcrm(r.record_id);
    // Sector: the domain decides when there is one; otherwise fall back to an
    // unambiguous public-sector marker in the company OR deal name, so a
    // domain-less government entity still gets the 365-day window.
    const sector =
      detectSector({ domain }) ??
      (looksGovernmentByName(rawName, rawDeal) ? "government" : "private");
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
      verified_via: (domain
        ? "domain"
        : nameCandidates.length
          ? "name"
          : "none") as "domain" | "name" | "none",
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
    //    Every name candidate goes through the FULL ladder (exact → containment
    //    → fuzzy), not just the company name, so a client whose CRM name is
    //    spelled differently is still caught on a row with no domain.
    let cs: CsClientStatus | null = null;
    if (domain && csDir.byDomain.has(domain)) cs = csDir.byDomain.get(domain)!;
    if (!cs) {
      for (const cand of nameCandidates) {
        if (csDir.byName.has(cand)) { cs = csDir.byName.get(cand)!; break; }
        const contained = _csContainmentMatch(cand, csDir);
        if (contained) { cs = csDir.byName.get(contained) ?? null; if (cs) break; }
        const fz = _csFuzzyMatch(cand, csDir);
        if (fz) { cs = csDir.byName.get(fz) ?? null; if (cs) break; }
      }
    }
    if (cs) {
      // Sector + cool-off must agree on the row (Sarah 2026-09-01): when the
      // matched CLIENT record decides the window, report ITS sector too, so the
      // sheet never shows "government / 180".
      const csSectorVal = cs.sector ?? sector;
      const csCool = csSectorVal === "government" ? 365 : 180;
      const csSector = csSectorVal === "government" ? "Government" : "Private";
      if (cs.active) {
        emit(
          "block",
          "existing_active_client",
          `BLOCK — existing active client${cs.csOwner ? ` (CS owner: ${cs.csOwner})` : ""}. Route through Customer Success, do not re-approach as new business.`,
          { blocker_owner: cs.csOwner || null, sector: csSectorVal, cooloff_days: csCool },
        );
        continue;
      }
      if (cs.churnDays != null && cs.churnDays <= csCool) {
        emit(
          "block",
          "client_within_cooloff",
          `BLOCK — churned ${cs.churnDays}d ago, still inside the ${csCool}-day ${csSector} cool-off (${csCool - cs.churnDays}d remaining). CS sign-off required first.`,
          { blocker_owner: cs.csOwner || null, sector: csSectorVal, cooloff_days: csCool },
        );
        continue;
      }
    }

    // 5. A LIVE OPEN deal today — a colleague is already working this company.
    //    Surface the deal link + owner + stage, exactly as the Mawsool output.
    let live = domain ? openDealDir.byDomain.get(domain) ?? null : null;
    if (!live) {
      for (const cand of nameCandidates) {
        const hit = openDealDir.byName.get(cand);
        if (hit) { live = hit; break; }
      }
    }
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

    // 7. UNVERIFIABLE (Sarah 2026-09-01 — "ZERO errors"): no domain AND no name
    //    usable for matching means nothing was actually checked against the CRM.
    //    Passing that to Sales would be a guess, so it BLOCKS instead — still
    //    only two statuses, and a human can clear it manually.
    if (!domain && nameCandidates.length === 0) {
      emit(
        "block",
        "unverifiable",
        "BLOCK — cannot verify: the row has no domain and no company/deal name long enough to match against the CRM. Check this one by hand before approaching.",
      );
      continue;
    }

    // 8. Clear — safe to re-approach.
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
