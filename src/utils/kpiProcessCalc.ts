/**
 * SDR + Sales KPI process calculators (Phase B + C).
 *
 * IMPORTANT — these read ONLY the Duplicate Radar's already-synced LOCAL tables
 * (`duplicate_records.raw_data` holds the full Zoho JSON per record, plus the
 * `deal_doc_compliance` scan table). They do NOT make live Zoho API calls, so a
 * recalc can never freeze the platform on a 50k-record pull (a recurring hazard).
 * Coverage is therefore whatever the Radar has synced.
 *
 * Each calculator returns { value, dataAvailable, details }. When the source is
 * empty we return dataAvailable:false so the KPI stays "--" rather than a fake 0.
 */
import { logger } from "./logger";
import {
  pool,
  getDealDocCompliance,
  scanDealStageAgingViolations,
  scanCsLifecycleViolations,
  openStagePredicate,
  buildSegmentPredicate,
} from "./duplicateRadarDatabase";
import { fetchDealStageHistory } from "./zohoCRM";
import { getAllFrameworkCoverage } from "./obligationDocumentsDatabase";
import { calcCertMilestoneDelivery } from "./northStarSources";

export interface ProcessKpiValue {
  value: number;
  dataAvailable: boolean;
  details?: Record<string, unknown>;
}

const EMPTY: ProcessKpiValue = { value: 0, dataAvailable: false };

/** Read a Zoho string-or-{name} field off a raw record. */
function readField(v: any): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "object" && typeof v.name === "string")
    return v.name.trim() || null;
  return null;
}

/** All locally-synced raw records for a module (full Zoho JSON each). */
async function localRawRecords(
  module: string,
  limit = 60000,
): Promise<any[]> {
  const res = await pool.query(
    `SELECT raw_data FROM duplicate_records WHERE zoho_module = $1 LIMIT $2`,
    [module, limit],
  );
  return res.rows.map((r: any) => r.raw_data || {});
}

/** True if a Zoho field (string or {name}) has a non-empty value on the record. */
function hasField(raw: any, field: string): boolean {
  const v = raw?.[field];
  if (v == null) return false;
  if (typeof v === "object") return String(v.name ?? "").trim() !== "";
  return String(v).trim() !== "";
}

// CRM Data Accuracy = share of records that carry their CORE operational fields.
// Deliberately NOT the full DEFAULT_GOVERNANCE_RULES (which require enrichment
// fields like City/Industry/Description that are essentially never filled →
// 0% clean and useless as a trend KPI). Full-governance compliance lives on the
// Quality Dashboard AI Audit. Core fields confirmed against the live data
// distribution (2026-06-16). Easy to extend if the team adds required fields.
const LEAD_CORE_REQUIRED = ["First_Name", "Lead_Source", "Lead_Status"];
const DEAL_CORE_REQUIRED = ["Stage", "Amount", "Account_Name", "Closing_Date"];

function leadIsClean(raw: any): boolean {
  // Contactable = phone OR email (requiring both is too strict for the data).
  const contactable = hasField(raw, "Phone") || hasField(raw, "Email");
  return contactable && LEAD_CORE_REQUIRED.every((f) => hasField(raw, f));
}

function dealIsClean(raw: any): boolean {
  return DEAL_CORE_REQUIRED.every((f) => hasField(raw, f));
}

/** Core-field "clean" share ÷ total. */
function cleanShare(rawRecords: any[], module: "Leads" | "Deals"): ProcessKpiValue {
  if (rawRecords.length === 0) return EMPTY;
  const isClean = module === "Leads" ? leadIsClean : dealIsClean;
  let clean = 0;
  for (const raw of rawRecords) if (isClean(raw)) clean++;
  const value = Math.round((clean / rawRecords.length) * 1000) / 10;
  return { value, dataAvailable: true, details: { clean, total: rawRecords.length } };
}

/** Days between an ISO date and now (calendar). */
function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 86400000;
}

// ─────────────────────────────── SDR ────────────────────────────────────────

/** SDR-KPI-09 Duplicate Rate — non-primary Leads in multi-record clusters ÷ all Leads. */
export async function calcSdrDuplicateRate(): Promise<ProcessKpiValue> {
  const res = await pool.query(
    `WITH lead_clusters AS (
       SELECT cluster_id FROM duplicate_records
        WHERE zoho_module = 'Leads' AND cluster_id IS NOT NULL
        GROUP BY cluster_id HAVING COUNT(*) > 1
     )
     SELECT
       (SELECT COUNT(*) FROM duplicate_records WHERE zoho_module = 'Leads')::int AS total,
       (SELECT COUNT(*) FROM duplicate_records r
          JOIN lead_clusters lc ON r.cluster_id = lc.cluster_id
         WHERE r.zoho_module = 'Leads' AND r.is_primary = false)::int AS dups`,
  );
  const total = Number(res.rows[0]?.total || 0);
  const dups = Number(res.rows[0]?.dups || 0);
  if (total === 0) return EMPTY;
  return {
    value: Math.round((dups / total) * 1000) / 10,
    dataAvailable: true,
    details: { duplicate_leads: dups, total_leads: total },
  };
}

/** SDR-KPI-08 CRM Data Accuracy (SDR) — clean Leads ÷ total Leads. */
export async function calcSdrCrmAccuracy(): Promise<ProcessKpiValue> {
  return cleanShare(await localRawRecords("Leads"), "Leads");
}

/** Classify a lead status into funnel buckets from its raw Lead_Status. */
function leadFunnel(raw: any): { contacted: boolean; qualified: boolean; junk: boolean } {
  const s = (readField(raw.Lead_Status) || "").toLowerCase();
  const junk = /junk|lost|invalid|not interested|unqualified|not qualified/.test(s);
  const qualified = !junk && /qualified|converted|opportunity|won/.test(s);
  // "contacted" = anything past the brand-new/untouched state.
  const isNew = s === "" || /new|untouched|not contacted|fresh/.test(s);
  const contacted = !isNew;
  return { contacted, qualified, junk };
}

/** SDR-KPI-07 Lead-to-Qualified Conversion — qualified ÷ all leads. */
export async function calcSdrLeadToQualified(): Promise<ProcessKpiValue> {
  const recs = await localRawRecords("Leads");
  if (recs.length === 0) return EMPTY;
  let qualified = 0;
  for (const r of recs) if (leadFunnel(r).qualified) qualified++;
  return {
    value: Math.round((qualified / recs.length) * 1000) / 10,
    dataAvailable: true,
    details: { qualified, total: recs.length },
  };
}

/** SDR-KPI-03 Qualification Rate — qualified ÷ contacted leads. */
export async function calcSdrQualificationRate(): Promise<ProcessKpiValue> {
  const recs = await localRawRecords("Leads");
  let contacted = 0;
  let qualified = 0;
  for (const r of recs) {
    const f = leadFunnel(r);
    if (f.contacted) contacted++;
    if (f.qualified) qualified++;
  }
  if (contacted === 0) return EMPTY;
  return {
    value: Math.round((qualified / contacted) * 1000) / 10,
    dataAvailable: true,
    details: { qualified, contacted },
  };
}

// ---------------------------------------------------------------------------
// Meeting KPIs (SDR-KPI-04 / SDR-KPI-05)
// ---------------------------------------------------------------------------
/**
 * Zoho has no Events/Meetings module synced into this platform (only Deals,
 * Leads and Calls are ever fetched), so these are derived from the two Deal
 * STAGES the Sales SOP defines for the meeting step — "Meeting" (§7.3) and
 * "Not Attend Meeting" (§7.2.8), see salesStageSlaSpec.ts.
 *
 * ORDER MATTERS BELOW: "Not Attend Meeting" also contains the substring
 * "meeting", so the no-show test must run FIRST. Reversing these two lines
 * silently scores every no-show as an attended meeting and pushes Show Rate
 * to 100%.
 */
function classifyMeetingStage(stage: string | null): "attended" | "no_show" | null {
  const s = (stage || "").toLowerCase().trim();
  if (!s) return null;
  if (s.includes("not attend")) return "no_show";
  if (s.includes("meeting")) return "attended";
  return null;
}

/** 4 weeks — the window SDR-KPI-04 averages over. */
const MEETING_WINDOW_DAYS = 28;

/**
 * SDR-KPI-04 Meetings Booked Per Week — deals that reached the meeting step
 * (attended or no-show; both were BOOKED) within the window, averaged per week.
 *
 * Uses Modified_Time as the stage-entry proxy. That is the same proxy the Deal
 * Stage Aging engine already uses platform-wide (Zoho exposes no stage-entry
 * date without a per-deal history call), so a deal edited for an unrelated
 * reason can re-enter the window. Documented rather than hidden: `details`
 * carries the raw count so the number can be sanity-checked.
 */
export async function calcSdrMeetingsBooked(): Promise<ProcessKpiValue> {
  const recs = await localRawRecords("Deals");
  let booked = 0;
  for (const r of recs) {
    if (!classifyMeetingStage(readField(r.Stage))) continue;
    const d = daysSince(r.Modified_Time || r.Created_Time);
    if (d === null || d > MEETING_WINDOW_DAYS) continue;
    booked++;
  }
  if (booked === 0) return EMPTY;
  const weeks = MEETING_WINDOW_DAYS / 7;
  return {
    value: Math.round((booked / weeks) * 10) / 10,
    dataAvailable: true,
    details: { booked, window_days: MEETING_WINDOW_DAYS, weeks },
  };
}

/**
 * SDR-KPI-05 Show Rate — attended ÷ booked across the deals currently AT the
 * meeting step.
 *
 * This is a snapshot of the current meeting cohort, not a historical rate: a
 * deal that attended and then progressed to Proposal has left both stages and
 * is no longer counted on either side. A true historical rate needs per-deal
 * stage history (the same expensive Zoho call the Sales cycle times make), so
 * the cheap cohort ratio is used here. Both sides move together, so the ratio
 * stays meaningful even though the denominator is a snapshot.
 */
export async function calcSdrShowRate(): Promise<ProcessKpiValue> {
  const recs = await localRawRecords("Deals");
  let attended = 0;
  let noShow = 0;
  for (const r of recs) {
    const c = classifyMeetingStage(readField(r.Stage));
    if (c === "attended") attended++;
    else if (c === "no_show") noShow++;
  }
  const booked = attended + noShow;
  if (booked === 0) return EMPTY;
  return {
    value: Math.round((attended / booked) * 1000) / 10,
    dataAvailable: true,
    details: { attended, no_show: noShow, booked },
  };
}

// ---------------------------------------------------------------------------
// Sales cycle times (SALES-KPI-03 / SALES-KPI-04) — LOCAL
// ---------------------------------------------------------------------------
/**
 * Average days deals have currently spent in a stage, read from the local
 * mirror. No Zoho call.
 *
 * WHY LOCAL: these were previously computable only from Zoho's per-deal
 * Stage_History, up to 40 sequential API calls, which is why they were excluded
 * from the interactive recalculate. That path does not work in this tenant —
 * verified live 2026-08-17: a full cycle-times run completed and reported "no
 * synced source data" for both, and /api/zoho/deals/:id/stage-aging returns
 * source:"created", meaning it fell back to the record's creation time because
 * no usable Stage_Duration came back. Retrying cannot fix that.
 *
 * The proxy is `modified_date` as stage-entry, which is what the Deal Stage
 * Aging engine already uses platform-wide, so this introduces no new
 * approximation.
 *
 * KNOWN BIAS, stated rather than hidden: this measures deals CURRENTLY in the
 * stage, so it cannot see deals that already moved through it. It therefore
 * skews toward slow and stuck deals and reads HIGHER than a true completed-
 * cycle average. It answers "how long are the deals sitting in Proposal right
 * now", which is the operational question the SOP escalation clause asks.
 */
async function avgStageDwellDays(stageMatch: string): Promise<ProcessKpiValue> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS deals,
            AVG(EXTRACT(EPOCH FROM (NOW() - COALESCE(r.modified_date, r.created_date))) / 86400.0) AS avg_days
       FROM duplicate_records r
      WHERE r.zoho_module = 'Deals'
        AND LOWER(COALESCE(NULLIF(r.stage,''), r.raw_data->>'Stage','')) LIKE $1
        AND COALESCE(r.modified_date, r.created_date) IS NOT NULL`,
    [stageMatch],
  );
  const deals = Number(res.rows[0]?.deals) || 0;
  const rawAvg = res.rows[0]?.avg_days;
  // Check for null BEFORE coercing: Number(null) is 0, which passes
  // Number.isFinite, so a null average would report a 0-day cycle time — a
  // nonsense value that reads as excellent against a 7-day target.
  if (deals === 0 || rawAvg === null || rawAvg === undefined) return EMPTY;
  const avg = Number(rawAvg);
  if (!Number.isFinite(avg)) return EMPTY;
  return {
    value: Math.round(avg * 10) / 10,
    dataAvailable: true,
    details: { deals_in_stage: deals, basis: "current dwell (modified_date proxy)" },
  };
}

/** SALES-KPI-03 Proposal Cycle Time — avg days deals have sat in Proposal. */
export async function calcSalesProposalCycleTime(): Promise<ProcessKpiValue> {
  return avgStageDwellDays("%proposal%");
}

/**
 * SALES-KPI-04 Agreement Cycle Time — avg days deals have sat in Agreement Sent.
 * Matches "agreement sent" specifically: "Agreement Signed" is a terminal stage
 * and must not be averaged in, or a won deal's age inflates the cycle time.
 */
export async function calcSalesAgreementCycleTime(): Promise<ProcessKpiValue> {
  return avgStageDwellDays("%agreement sent%");
}

// ---------------------------------------------------------------------------
// Follow-up KPIs (SDR-KPI-11 / SALES-KPI-07 / SALES-KPI-08)
// ---------------------------------------------------------------------------
/**
 * All three read the local `zoho_tasks` mirror (zohoTasksSync.ts), never Zoho
 * directly — a per-record activity fetch costs one API call per parent, which
 * is why the Sales cycle times are excluded from the interactive recalculate.
 *
 * Each returns EMPTY when its denominator is zero, so an unsynced or empty
 * mirror renders "--" rather than a confident 0% that reads as total failure.
 *
 * Zoho links a task through Who_Id (Lead/Contact) or What_Id (Deal/Account).
 * Rather than trusting the lookup alone, each query JOINS to duplicate_records
 * on the matching zoho_module, so a Contact-linked task cannot be counted as a
 * Lead one and an Account-linked task cannot be counted as a Deal one.
 */

/** First-contact SLA in hours. Env-tunable; 24h is the common desk default. */
const FIRST_CONTACT_SLA_HOURS = (() => {
  const n = parseInt(process.env.SALES_FIRST_CONTACT_SLA_HOURS ?? "24", 10);
  return Number.isFinite(n) && n > 0 ? n : 24;
})();

/** Window for "new" deals in SALES-KPI-08, in days. */
const FIRST_CONTACT_WINDOW_DAYS = 90;

/**
 * SDR-KPI-11 Follow-Up Compliance (SDR) — of the SDR follow-up tasks that have
 * been COMPLETED and carried a due date, the share closed on or before it.
 *
 * Denominator is completed-with-a-due-date, not all tasks: an open task is not
 * yet late-or-on-time, and a task with no due date has nothing to be measured
 * against. Counting either would move the number without anyone changing
 * behaviour.
 */
export async function calcSdrFollowUpCompliance(): Promise<ProcessKpiValue> {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS completed,
            COUNT(*) FILTER (
              WHERE t.closed_time::date <= t.due_date
            )::int AS on_time
       FROM zoho_tasks t
       JOIN duplicate_records r
         ON r.zoho_module = 'Leads' AND r.zoho_record_id = t.who_id
      WHERE t.status = 'Completed'
        AND t.due_date IS NOT NULL
        AND t.closed_time IS NOT NULL`,
  );
  const completed = Number(r.rows[0]?.completed) || 0;
  const onTime = Number(r.rows[0]?.on_time) || 0;
  if (completed === 0) return EMPTY;
  return {
    value: Math.round((onTime / completed) * 1000) / 10,
    dataAvailable: true,
    details: { on_time: onTime, completed },
  };
}

/**
 * SALES-KPI-07 Follow-Up Effectiveness — share of OPEN deals that have at least
 * one open task still due today or later.
 *
 * "Effectiveness" here is coverage: a live deal with no future follow-up booked
 * has been dropped, whether or not past tasks were done well. An overdue open
 * task does NOT count as covered — that is precisely the failure state.
 */
export async function calcSalesFollowUpEffectiveness(): Promise<ProcessKpiValue> {
  const r = await pool.query(
    `WITH open_deals AS (
       SELECT r.zoho_record_id
         FROM duplicate_records r
        WHERE r.zoho_module = 'Deals'
          AND r.zoho_record_id IS NOT NULL
          AND ${openStagePredicate("r")}
     )
     SELECT COUNT(*)::int AS deals,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM zoho_tasks t
               WHERE t.what_id = d.zoho_record_id
                 AND (t.status IS NULL OR t.status <> 'Completed')
                 AND t.due_date >= CURRENT_DATE
            ))::int AS covered
       FROM open_deals d`,
  );
  const deals = Number(r.rows[0]?.deals) || 0;
  const covered = Number(r.rows[0]?.covered) || 0;
  if (deals === 0) return EMPTY;
  return {
    value: Math.round((covered / deals) * 1000) / 10,
    dataAvailable: true,
    details: { covered, open_deals: deals },
  };
}

/**
 * SALES-KPI-08 First-Contact SLA — of deals created in the window, the share
 * whose FIRST logged task landed within FIRST_CONTACT_SLA_HOURS of creation.
 *
 * A deal with NO task at all counts as a miss, not as excluded: never being
 * contacted is the worst outcome, and dropping those would make the metric
 * improve as the team touched fewer deals.
 */
export async function calcSalesFirstContactSla(): Promise<ProcessKpiValue> {
  const r = await pool.query(
    `WITH new_deals AS (
       SELECT r.zoho_record_id,
              COALESCE(r.created_date, (r.raw_data->>'Created_Time')::timestamptz) AS created
         FROM duplicate_records r
        WHERE r.zoho_module = 'Deals'
          AND r.zoho_record_id IS NOT NULL
          AND COALESCE(r.created_date, (r.raw_data->>'Created_Time')::timestamptz)
              >= NOW() - INTERVAL '${FIRST_CONTACT_WINDOW_DAYS} days'
     ),
     first_touch AS (
       SELECT d.zoho_record_id, d.created,
              (SELECT MIN(t.created_time) FROM zoho_tasks t
                WHERE t.what_id = d.zoho_record_id) AS first_task
         FROM new_deals d
     )
     SELECT COUNT(*)::int AS deals,
            COUNT(*) FILTER (
              WHERE first_task IS NOT NULL
                AND first_task <= created + INTERVAL '${FIRST_CONTACT_SLA_HOURS} hours'
            )::int AS within_sla
       FROM first_touch`,
  );
  const deals = Number(r.rows[0]?.deals) || 0;
  const withinSla = Number(r.rows[0]?.within_sla) || 0;
  if (deals === 0) return EMPTY;
  return {
    value: Math.round((withinSla / deals) * 1000) / 10,
    dataAvailable: true,
    details: {
      within_sla: withinSla,
      new_deals: deals,
      sla_hours: FIRST_CONTACT_SLA_HOURS,
      window_days: FIRST_CONTACT_WINDOW_DAYS,
    },
  };
}

/** SDR-KPI-10 Pipeline Aging — avg days leads sit in Contacting/Contacted. */
export async function calcSdrPipelineAging(): Promise<ProcessKpiValue> {
  const recs = await localRawRecords("Leads");
  const ages: number[] = [];
  for (const r of recs) {
    const s = (readField(r.Lead_Status) || "").toLowerCase();
    if (!/contact/.test(s)) continue; // Contacting / Contacted
    const d = daysSince(r.Modified_Time || r.Created_Time);
    if (d !== null) ages.push(d);
  }
  if (ages.length === 0) return EMPTY;
  const avg = ages.reduce((a, b) => a + b, 0) / ages.length;
  return {
    value: Math.round(avg * 10) / 10,
    dataAvailable: true,
    details: { in_pipeline: ages.length },
  };
}

// ───────────────────────── SDR — Call Intelligence ──────────────────────────
// Per Sarah (2026-06-16): all SDR calls are captured in the platform's Call
// Intelligence logs (`call_records`). SDR activity = outbound calls tied to a
// Lead (SDRs work Leads; Sales works Deals). 30-day rolling window.

const CALL_WINDOW_DAYS = 30;

/** Business days (Mon–Fri) in the last N days — denominator for calls/day. */
function businessDaysInWindow(days: number): number {
  let count = 0;
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 86400000).getUTCDay();
    if (d !== 0 && d !== 6) count++;
  }
  return Math.max(1, count);
}

/** SDR-KPI-01 Calls Per Day — outbound lead calls ÷ (agents × business days). */
/**
 * "This call is attached to a CRM record", for the SDR call-volume KPIs.
 *
 * These used to require `lead_id IS NOT NULL`. That is a narrowing neither KPI's
 * definition asks for — SDR-KPI-01 is "total outbound calls per working day per
 * SDR agent" and SDR-KPI-02 is "percentage of calls that result in a live
 * conversation"; neither mentions leads.
 *
 * It also does not match how this team works. Measured on the live mirror
 * 2026-08-17, right after the first successful Zoho Calls import: of 236 calls,
 * 200 were linked to a DEAL and exactly 1 to a Lead. The lead-only filter
 * discarded 85% of the corpus and left both KPIs permanently "--".
 *
 * Accepting either linkage still excludes unlinked/junk rows, which is what the
 * filter was there to do. SDR-KPI-06 deliberately does NOT use this: "Average
 * Speed to Lead" measures lead-creation to first contact, so lead linkage is
 * intrinsic to it rather than incidental.
 *
 * Both callers also bound the window at `call_date <= NOW()`. Zoho's Calls
 * module holds SCHEDULED calls, and the same live check found rows dated into
 * the future. Counting those as work already done inflates calls-per-day and
 * would let the metric be raised by booking calls rather than making them.
 */
const CALL_LINKED_TO_CRM = "(lead_id IS NOT NULL OR deal_id IS NOT NULL)";

export async function calcSdrCallsPerDay(): Promise<ProcessKpiValue> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(DISTINCT agent_email)::int AS agents
       FROM call_records
      WHERE lower(coalesce(direction,'outbound')) = 'outbound' AND ${CALL_LINKED_TO_CRM}
        AND call_date >= NOW() - INTERVAL '${CALL_WINDOW_DAYS} days'
        AND call_date <= NOW()`,
  );
  const total = Number(res.rows[0]?.total || 0);
  const agents = Math.max(1, Number(res.rows[0]?.agents || 0));
  if (total === 0) return EMPTY;
  const perDay = total / (agents * businessDaysInWindow(CALL_WINDOW_DAYS));
  return {
    value: Math.round(perDay * 10) / 10,
    dataAvailable: true,
    details: { total_calls: total, agents, window_days: CALL_WINDOW_DAYS },
  };
}

/** SDR-KPI-02 Contact Rate — connected (duration>0) ÷ total outbound lead calls. */
export async function calcSdrContactRate(): Promise<ProcessKpiValue> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE duration_seconds > 0)::int AS connected
       FROM call_records
      WHERE lower(coalesce(direction,'outbound')) = 'outbound' AND ${CALL_LINKED_TO_CRM}
        AND call_date >= NOW() - INTERVAL '${CALL_WINDOW_DAYS} days'
        AND call_date <= NOW()`,
  );
  const total = Number(res.rows[0]?.total || 0);
  const connected = Number(res.rows[0]?.connected || 0);
  if (total === 0) return EMPTY;
  return {
    value: Math.round((connected / total) * 1000) / 10,
    dataAvailable: true,
    details: { connected, total },
  };
}

/** SDR-KPI-06 Average Speed to Lead — avg hours from lead creation to first call. */
export async function calcSdrSpeedToLead(): Promise<ProcessKpiValue> {
  const res = await pool.query(
    `WITH first_calls AS (
       SELECT lead_id, MIN(call_date) AS first_call
         FROM call_records
        WHERE lead_id IS NOT NULL AND call_date IS NOT NULL
        GROUP BY lead_id
     ),
     joined AS (
       SELECT fc.first_call,
              CASE WHEN dr.raw_data->>'Created_Time' ~ '^\\d{4}-\\d{2}-\\d{2}T'
                   THEN (dr.raw_data->>'Created_Time')::timestamptz END AS created
         FROM first_calls fc
         JOIN duplicate_records dr
           ON dr.zoho_module = 'Leads' AND dr.zoho_record_id = fc.lead_id
     )
     SELECT AVG(EXTRACT(EPOCH FROM (first_call - created)) / 3600.0) AS avg_hours,
            COUNT(*)::int AS n
       FROM joined
      WHERE created IS NOT NULL AND first_call >= created`,
  );
  const n = Number(res.rows[0]?.n || 0);
  const avgHours = res.rows[0]?.avg_hours;
  if (n === 0 || avgHours == null) return EMPTY;
  return {
    value: Math.round(Number(avgHours) * 10) / 10,
    dataAvailable: true,
    details: { leads_with_calls: n },
  };
}

// ────────────────────────────── SALES ───────────────────────────────────────

/** SALES-KPI-01 Deal Stage Aging Compliance — deals within SLA ÷ tracked deals. */
export async function calcSalesStageAgingCompliance(): Promise<ProcessKpiValue> {
  const scan = await scanDealStageAgingViolations({ limit: 50000 });
  const tracked = scan.summary.total_tracked_deals;
  const violations = scan.summary.total_violations;
  if (tracked === 0) return EMPTY;
  return {
    value: Math.round(((tracked - violations) / tracked) * 1000) / 10,
    dataAvailable: true,
    details: { tracked, violations, by_severity: scan.summary.by_severity },
  };
}

/** SALES-KPI-02 Conversion Rate (SQL→Signed) — signed ÷ (signed + lost). */
export async function calcSalesConversionRate(): Promise<ProcessKpiValue> {
  const recs = await localRawRecords("Deals");
  let signed = 0;
  let lost = 0;
  for (const r of recs) {
    const s = (readField(r.Stage) || "").toLowerCase();
    // Won = any "Signed" stage (covers "Signed" + "Agreement Signed"), Paid, Closed Won.
    if (/signed|paid|closed won/.test(s)) signed++;
    else if (/closed lost|junk/.test(s)) lost++;
  }
  const denom = signed + lost;
  if (denom === 0) return EMPTY;
  return {
    value: Math.round((signed / denom) * 1000) / 10,
    dataAvailable: true,
    details: { signed, lost },
  };
}

/** SALES-KPI-05 Deal Document Compliance — compliant ÷ scanned deals (deal_doc_compliance). */
export async function calcSalesDocCompliance(): Promise<ProcessKpiValue> {
  const rows = await getDealDocCompliance();
  if (rows.length === 0) return EMPTY;
  const compliant = rows.filter((r: any) => r.compliant).length;
  return {
    value: Math.round((compliant / rows.length) * 1000) / 10,
    dataAvailable: true,
    details: { compliant, checked: rows.length },
  };
}

/** SALES-KPI-06 CRM Data Accuracy (Deals) — clean Deals ÷ total Deals. */
export async function calcSalesCrmAccuracy(): Promise<ProcessKpiValue> {
  return cleanShare(await localRawRecords("Deals"), "Deals");
}

/** SALES-KPI-09 Duplicate Rate (Sales) — non-primary Deals in multi-record clusters ÷ all Deals. */
export async function calcSalesDuplicateRate(): Promise<ProcessKpiValue> {
  const res = await pool.query(
    `WITH deal_clusters AS (
       SELECT cluster_id FROM duplicate_records
        WHERE zoho_module = 'Deals' AND cluster_id IS NOT NULL
        GROUP BY cluster_id HAVING COUNT(*) > 1
     )
     SELECT
       (SELECT COUNT(*) FROM duplicate_records WHERE zoho_module = 'Deals')::int AS total,
       (SELECT COUNT(*) FROM duplicate_records r
          JOIN deal_clusters dc ON r.cluster_id = dc.cluster_id
         WHERE r.zoho_module = 'Deals' AND r.is_primary = false)::int AS dups`,
  );
  const total = Number(res.rows[0]?.total || 0);
  const dups = Number(res.rows[0]?.dups || 0);
  if (total === 0) return EMPTY;
  return {
    value: Math.round((dups / total) * 1000) / 10,
    dataAvailable: true,
    details: { duplicate_deals: dups, total_deals: total },
  };
}

/**
 * SALES-KPI-03 Proposal Cycle Time + SALES-KPI-04 Agreement Cycle Time — from
 * Zoho Stage_History (per Sarah's choice). Zoho gives Stage_Duration (days spent
 * in each stage) directly, so no transition math. This is the ONE place that hits
 * the live Zoho API, so it is bounded to a sample of recently-modified deals that
 * have reached Proposal+; the sample size is logged (no silent truncation).
 */
const CYCLE_TIME_DEAL_CAP = 40;

export async function computeSalesCycleTimes(
  cap = CYCLE_TIME_DEAL_CAP,
): Promise<Record<string, ProcessKpiValue>> {
  const dealRows = await pool.query(
    `SELECT zoho_record_id
       FROM duplicate_records
      WHERE zoho_module = 'Deals' AND zoho_record_id IS NOT NULL
        AND lower(coalesce(raw_data->>'Stage','')) ~ '(proposal|agreement|paid|closed won)'
      ORDER BY modified_date DESC NULLS LAST
      LIMIT $1`,
    [cap],
  );
  const ids: string[] = dealRows.rows
    .map((r: any) => r.zoho_record_id)
    .filter(Boolean);

  if (ids.length === 0) {
    return { "SALES-KPI-03": EMPTY, "SALES-KPI-04": EMPTY };
  }

  const proposalDurations: number[] = [];
  const agreementDurations: number[] = [];
  let fetched = 0;

  for (const id of ids) {
    try {
      const history = await fetchDealStageHistory(id);
      fetched++;
      for (const row of history) {
        const stage = (row.Stage || "").toLowerCase();
        const dur =
          typeof row.Stage_Duration === "number"
            ? row.Stage_Duration
            : Number(row.Stage_Duration);
        if (!Number.isFinite(dur) || dur < 0) continue;
        if (stage.includes("proposal")) proposalDurations.push(dur);
        else if (stage.includes("agreement sent")) agreementDurations.push(dur);
      }
    } catch (e) {
      // One deal's history failing must not abort the sample.
      logger.error(
        `[KPIProcessCalc] stage history failed for deal ${id}: ${(e as Error).message}`,
      );
    }
  }

  logger.info(
    `[KPIProcessCalc] Sales cycle times sampled ${fetched}/${ids.length} deals ` +
      `(proposal n=${proposalDurations.length}, agreement n=${agreementDurations.length})`,
  );

  const avg = (xs: number[]): ProcessKpiValue =>
    xs.length === 0
      ? EMPTY
      : {
          value: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10,
          dataAvailable: true,
          details: { sample: xs.length },
        };

  return {
    "SALES-KPI-03": avg(proposalDurations),
    "SALES-KPI-04": avg(agreementDurations),
  };
}

// ──────────────── SALES — ad-hoc KPIs (BI-portal benchmarked) ───────────────
/**
 * ADHOC-SALES-01/02/03/04 — the four one-off Sales KPIs Sarah added from the BI
 * portal's sales-summary (2026-08-17). They were entered manually at first;
 * these calculators make QMS compute them from its own synced Zoho mirror.
 *
 * Scope decisions, all deliberate — they are what makes the numbers mean
 * something, so do not "simplify" them away:
 *
 * 1. CORPORATE (WalaPlus layout) ONLY. The Deals table also holds Marketplace
 *    partner records — "Partner Active", "Welcome Communications", "Whitelist",
 *    "Codes Receiving" — which are not the Sales team's pipeline at all and
 *    would swamp both money figures. (The older SALES-KPI-01..09 are
 *    unsegmented; that is a pre-existing inconsistency, not a precedent to
 *    copy. Flagged to Sarah separately.)
 *
 * 2. WON and OPEN are made DISJOINT. `openStagePredicate` excludes only
 *    'agreement signed'/'paid' by name, so the 784 deals sitting in the plain
 *    "Signed" stage read as open there while SALES-KPI-02 counts them as won.
 *    Left alone, those deals would be billed as revenue AND as pipeline. Won
 *    wins: subtracting it from open keeps the win-rate KPI's definition intact.
 *
 * 3. REVENUE and ASP are CALENDAR YEAR-TO-DATE (Sarah, 2026-08-18), windowed on
 *    each deal's Closing_Date. Their targets (SAR 41M, SAR 170k) are annual, and
 *    the KPI engine files every value against the current month
 *    (kpiAutoCalc.ts), so an all-time total read as a 3x beat when it was really
 *    a since-inception figure stamped "this month". Pipeline is deliberately NOT
 *    windowed — it is a point-in-time snapshot of what is open right now.
 *
 * 4. These will NOT tie out to the BI portal. Its agent filter and segment scope
 *    are unknown to us, so treat the BI figure as a benchmark to explain a gap
 *    against — never as an expected match.
 */
function wonStagePredicate(alias: string): string {
  // Same stage vocabulary as calcSalesConversionRate's /signed|paid|closed won/,
  // expressed in SQL. Keep the two in lockstep or win-rate and revenue will
  // disagree about which deals were won.
  const s = `LOWER(COALESCE(NULLIF(${alias}.stage,''), ${alias}.raw_data->>'Stage',''))`;
  return `${s} ~ '(signed|paid|closed won)'`;
}

/**
 * Deals that have reached the meeting step, and the subset that moved past it.
 * Zoho's Stage_History carries no usable duration in this tenant, so "reached"
 * is inferred from the CURRENT stage against the Sales SOP ladder. Closed
 * Lost/Junk therefore sit in NEITHER set — a lost deal's stage says nothing
 * about how far it got, and guessing would silently move the KPI.
 */
const AT_OR_PAST_MEETING_RE =
  "(meeting|meetings|on hold|^hold$|proposal|agreement sent|signed|paid|closed won)";
const PAST_MEETING_RE = "(proposal|agreement sent|signed|paid|closed won)";

/**
 * Calendar year-to-date on the deal's Closing_Date. Zoho sends it as a bare
 * 'YYYY-MM-DD' string inside raw_data, so the shape is checked BEFORE the cast —
 * an unparseable value must fall out of the window, never abort the whole query.
 * Future-dated closings are excluded too: a deal closing in November is not
 * year-TO-DATE revenue.
 */
const CLOSING_DATE_SQL =
  "CASE WHEN r.raw_data->>'Closing_Date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'" +
  " THEN (LEFT(r.raw_data->>'Closing_Date', 10))::date END";
const YTD_SQL =
  `${CLOSING_DATE_SQL} >= date_trunc('year', CURRENT_DATE)::date` +
  ` AND ${CLOSING_DATE_SQL} <= CURRENT_DATE`;

interface AdhocSalesAggregates {
  /** Won deals closing THIS calendar year — the revenue/ASP population. */
  wonYtdCount: number;
  wonYtdValue: number;
  wonYtdWithAmount: number;
  /** Won deals of any vintage, and how many carry no usable Closing_Date. */
  wonAllCount: number;
  wonNoCloseDate: number;
  openCount: number;
  openValue: number;
  reachedMeeting: number;
  pastMeeting: number;
}

const ADHOC_CACHE_TTL_MS = 60_000;
let adhocCache: { at: number; data: AdhocSalesAggregates } | null = null;
let adhocInFlight: Promise<AdhocSalesAggregates> | null = null;

/**
 * One scan, four KPIs. Memoised for a minute so a single recalc pass (which
 * calls all four in a row) does one full non-sargable segment scan of ~22k
 * deals instead of four, and so ASP can never disagree with the revenue figure
 * it is derived from.
 */
export async function adhocSalesAggregates(): Promise<AdhocSalesAggregates> {
  if (adhocCache && Date.now() - adhocCache.at < ADHOC_CACHE_TTL_MS) {
    return adhocCache.data;
  }
  if (adhocInFlight) return adhocInFlight;
  adhocInFlight = (async () => {
    const seg = buildSegmentPredicate("walaplus", 1);
    const won = wonStagePredicate("r");
    const open = `(${openStagePredicate("r")}) AND NOT (${won})`;
    const stage = `LOWER(COALESCE(NULLIF(r.stage,''), r.raw_data->>'Stage',''))`;
    const wonYtd = `${won} AND ${YTD_SQL}`;
    const res = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE ${wonYtd})::int                                    AS won_ytd_count,
         COALESCE(SUM(COALESCE(r.deal_value,0)) FILTER (WHERE ${wonYtd}), 0)       AS won_ytd_value,
         COUNT(*) FILTER (WHERE ${wonYtd} AND COALESCE(r.deal_value,0) > 0)::int   AS won_ytd_with_amount,
         COUNT(*) FILTER (WHERE ${won})::int                                       AS won_all_count,
         COUNT(*) FILTER (WHERE ${won} AND ${CLOSING_DATE_SQL} IS NULL)::int       AS won_no_close_date,
         COUNT(*) FILTER (WHERE ${open})::int                                      AS open_count,
         COALESCE(SUM(COALESCE(r.deal_value,0)) FILTER (WHERE ${open}), 0)         AS open_value,
         COUNT(*) FILTER (WHERE ${stage} ~ '${AT_OR_PAST_MEETING_RE}')::int        AS reached_meeting,
         COUNT(*) FILTER (WHERE ${stage} ~ '${PAST_MEETING_RE}')::int              AS past_meeting
       FROM duplicate_records r
      WHERE r.zoho_module = 'Deals'${seg.condition ? ` AND ${seg.condition}` : ""}`,
      seg.params,
    );
    const row = res.rows[0] || {};
    const data: AdhocSalesAggregates = {
      wonYtdCount: Number(row.won_ytd_count || 0),
      wonYtdValue: Number(row.won_ytd_value || 0),
      wonYtdWithAmount: Number(row.won_ytd_with_amount || 0),
      wonAllCount: Number(row.won_all_count || 0),
      wonNoCloseDate: Number(row.won_no_close_date || 0),
      openCount: Number(row.open_count || 0),
      openValue: Number(row.open_value || 0),
      reachedMeeting: Number(row.reached_meeting || 0),
      pastMeeting: Number(row.past_meeting || 0),
    };
    adhocCache = { at: Date.now(), data };
    return data;
  })().finally(() => {
    adhocInFlight = null;
  });
  return adhocInFlight;
}

/** Test seam — drop the memo so a test (or a forced recalc) re-reads the DB. */
export function resetAdhocSalesCache(): void {
  adhocCache = null;
}

/** ADHOC-SALES-01 Closed-Won Revenue — SAR won this calendar year (corporate). */
export async function calcAdhocSalesWonRevenue(): Promise<ProcessKpiValue> {
  const a = await adhocSalesAggregates();
  if (a.wonYtdCount === 0) return EMPTY;
  return {
    value: Math.round(a.wonYtdValue),
    dataAvailable: true,
    details: {
      window: "calendar YTD on Closing_Date",
      won_deals_ytd: a.wonYtdCount,
      won_deals_ytd_with_amount: a.wonYtdWithAmount,
      // Surfaced, not hidden: a won deal with no parseable Closing_Date cannot
      // be placed in any year, so it is out of the window. If this climbs, the
      // KPI is under-reporting for a data reason, not a commercial one.
      won_deals_all_time: a.wonAllCount,
      won_deals_without_closing_date: a.wonNoCloseDate,
      segment: "walaplus",
    },
  };
}

/** ADHOC-SALES-02 Qualified Pipeline — SAR value of OPEN corporate deals. */
export async function calcAdhocSalesQualifiedPipeline(): Promise<ProcessKpiValue> {
  const a = await adhocSalesAggregates();
  if (a.openCount === 0) return EMPTY;
  return {
    value: Math.round(a.openValue),
    dataAvailable: true,
    details: { open_deals: a.openCount, segment: "walaplus" },
  };
}

/** ADHOC-SALES-03 Avg Deal Value (ASP) — YTD won revenue ÷ YTD won deals CARRYING a value. */
export async function calcAdhocSalesAvgDealValue(): Promise<ProcessKpiValue> {
  const a = await adhocSalesAggregates();
  // Divide by the deals that actually carry an Amount, not by every won deal:
  // a won deal with a blank Amount contributes 0 to the numerator, so counting
  // it in the denominator would drag the average down by a data-entry gap
  // rather than by anything commercial. SALES-KPI-06 already tracks that gap.
  if (a.wonYtdWithAmount === 0) return EMPTY;
  return {
    value: Math.round(a.wonYtdValue / a.wonYtdWithAmount),
    dataAvailable: true,
    details: {
      window: "calendar YTD on Closing_Date",
      won_value_ytd: Math.round(a.wonYtdValue),
      won_deals_ytd_with_amount: a.wonYtdWithAmount,
      won_deals_ytd_missing_amount: a.wonYtdCount - a.wonYtdWithAmount,
      segment: "walaplus",
    },
  };
}

/** ADHOC-SALES-04 Meeting Conversion — deals past the meeting ÷ deals that reached it. */
export async function calcAdhocSalesMeetingConversion(): Promise<ProcessKpiValue> {
  const a = await adhocSalesAggregates();
  if (a.reachedMeeting === 0) return EMPTY;
  return {
    value: Math.round((a.pastMeeting / a.reachedMeeting) * 1000) / 10,
    dataAvailable: true,
    details: {
      reached_meeting: a.reachedMeeting,
      past_meeting: a.pastMeeting,
      excluded_closed_lost: "current stage cannot show how far a lost deal got",
      segment: "walaplus",
    },
  };
}

/**
 * SDR-KPI-12 Booking Conversion Rate — the governed meeting-conversion metric.
 *
 * Source: SDR Governance Document (WalaPlus_SDR v2.2, 08.12.2025), Individual
 * KPIs table: "(# of Booked meetings / Total leads answered) x 100", target
 * >=40%, benchmark 35-45%. This REPLACED ADHOC-SALES-04, whose 20% target came
 * from a BI-portal screenshot and appears in no controlled document.
 *
 * "Answered" is taken from the SOP's own lead-stage vocabulary (New Lead,
 * Contacting, No Answer, Qualified Lead, Not Qualified, On Hold, Potential,
 * Closed Lost): every stage EXCEPT New Lead and No Answer, which are precisely
 * the two that mean nobody replied. A blank status is not answered either.
 *
 * Both sides use ONE window on record creation, so this is a cohort measure:
 * of the leads received and answered in the period, how many meetings were
 * booked in that same period. Mixing an all-time denominator with a windowed
 * numerator is what made the ad-hoc churn and revenue KPIs meaningless.
 *
 * A booked meeting includes "Not Attend Meeting" — the meeting WAS booked, the
 * client did not show. Show-rate is SDR-KPI-05's job, and double-counting it
 * here would punish the SDR twice for one no-show.
 */
const LEAD_UNANSWERED_RE = /^(new lead|new|no answer)$/;

export async function calcSdrBookingConversionRate(): Promise<ProcessKpiValue> {
  const [leads, deals] = await Promise.all([
    localRawRecords("Leads"),
    localRawRecords("Deals"),
  ]);

  let answered = 0;
  for (const r of leads) {
    const d = daysSince(readField(r.Created_Time));
    if (d === null || d > MEETING_WINDOW_DAYS) continue;
    const s = (readField(r.Lead_Status) || "").toLowerCase().trim();
    if (!s || LEAD_UNANSWERED_RE.test(s)) continue;
    answered++;
  }

  let booked = 0;
  for (const r of deals) {
    const d = daysSince(readField(r.Created_Time));
    if (d === null || d > MEETING_WINDOW_DAYS) continue;
    if (classifyMeetingStage(readField(r.Stage))) booked++;
  }

  if (answered === 0) return EMPTY;

  // Guard. More meetings booked than leads answered in the same window means
  // the two populations are not the cohort this KPI assumes — most likely
  // meetings booked against leads received in an EARLIER period. Publishing a
  // >100% conversion rate would look like a triumph rather than a data problem,
  // so report nothing and let the detail page say why.
  if (booked > answered) {
    logger.warn(
      `[KPIProcessCalc] SDR-KPI-12 suppressed: ${booked} booked > ${answered} answered in ${MEETING_WINDOW_DAYS}d`,
    );
    return EMPTY;
  }

  return {
    value: Math.round((booked / answered) * 1000) / 10,
    dataAvailable: true,
    details: {
      source: "SDR SOP v2.2 Individual KPIs table — booked / answered",
      window_days: MEETING_WINDOW_DAYS,
      booked_meetings: booked,
      leads_answered: answered,
      answered_excludes: "New Lead and No Answer stages, and blank status",
      booked_includes:
        "Not Attend Meeting — the meeting was booked; show-rate is SDR-KPI-05",
    },
  };
}

// ─────────── CUSTOMER SUCCESS (B2B) — WP-BU-CS-SOP-003 KPI framework ────────
/**
 * The CS SOP defines 33 KPIs (§8.1 Individual, §8.2 Process, §8.3 Governance).
 * Most name Client-Hub, Jira, the Admin/BI Portal or QA sampling as their
 * system of record, and QMS mirrors Zoho — so they stay manual until those
 * feeds exist. Four are computable TODAY from the CS lifecycle engine, which
 * already evaluates every synced CS deal against the SOP's own phase rules.
 *
 * These are Zoho-side measures of a Client-Hub KPI. They are not a substitute
 * for the SOP's stated source, and each KPI's description says so — the point
 * is to give CS a live signal now rather than four permanently blank rows.
 */
const CS_SLA_CODES = new Set([
  "onboarding_overdue",
  "renewal_overdue",
  "phase_transition_stalled",
]);
/** The mandatory client-data fields the lifecycle engine checks per deal. */
const CS_DATA_GAP_CODES = new Set([
  "missing_company_domain",
  "missing_cs_owner",
  "missing_customer_since",
  "missing_renewal_date",
  "missing_health_score",
  "missing_arr_value",
]);
const CS_CHURN_RECORD_CODES = new Set([
  "termination_missing_churn_date",
  "termination_missing_churn_reason",
]);

interface CsKpiAggregates {
  csDeals: number;
  slaBreachDeals: number;
  dataGapDeals: number;
  terminationDeals: number;
  churnRecordGapDeals: number;
}

const CS_CACHE_TTL_MS = 60_000;
let csCache: { at: number; data: CsKpiAggregates } | null = null;
let csInFlight: Promise<CsKpiAggregates> | null = null;

/**
 * One CS lifecycle scan, four KPIs. Counts DISTINCT DEALS per violation family,
 * not violation rows: a deal can breach several rules at once, and dividing raw
 * violation counts by deal counts can exceed 100% (or push adherence negative).
 */
export async function csKpiAggregates(): Promise<CsKpiAggregates> {
  if (csCache && Date.now() - csCache.at < CS_CACHE_TTL_MS) return csCache.data;
  if (csInFlight) return csInFlight;
  csInFlight = (async () => {
    // Full (non-summaryOnly) scan: the summary counts violations, and these
    // KPIs need per-deal grouping, which only the rows carry.
    const scan = await scanCsLifecycleViolations({ limit: 50000 });
    const sla = new Set<number>();
    const gap = new Set<number>();
    const churnGap = new Set<number>();
    for (const row of scan.violations as any[]) {
      const code = String(row?.violation?.code || "");
      if (CS_SLA_CODES.has(code)) sla.add(row.record_id);
      if (CS_DATA_GAP_CODES.has(code)) gap.add(row.record_id);
      if (CS_CHURN_RECORD_CODES.has(code)) churnGap.add(row.record_id);
    }
    let termination = 0;
    for (const [phase, n] of Object.entries(scan.summary.by_phase || {})) {
      if (/termin|churn/i.test(phase)) termination += Number(n) || 0;
    }
    const data: CsKpiAggregates = {
      csDeals: Number(scan.summary.total_cs_deals || 0),
      slaBreachDeals: sla.size,
      dataGapDeals: gap.size,
      terminationDeals: termination,
      churnRecordGapDeals: churnGap.size,
    };
    csCache = { at: Date.now(), data };
    return data;
  })().finally(() => {
    csInFlight = null;
  });
  return csInFlight;
}

/** Test seam — drop the memo so a test (or a forced recalc) re-reads the scan. */
export function resetCsKpiCache(): void {
  csCache = null;
}

/** CS-KPI-25 SLA / Milestone Adherence — CS deals with no overdue lifecycle step. */
export async function calcCsSlaAdherence(): Promise<ProcessKpiValue> {
  const a = await csKpiAggregates();
  if (a.csDeals === 0) return EMPTY;
  const onTime = Math.max(0, a.csDeals - a.slaBreachDeals);
  return {
    value: Math.round((onTime / a.csDeals) * 1000) / 10,
    dataAvailable: true,
    details: {
      source: "Zoho CS lifecycle scan (SOP names Client-Hub / Dashboard)",
      cs_deals: a.csDeals,
      deals_with_an_overdue_step: a.slaBreachDeals,
      rules_counted: "onboarding overdue, renewal overdue, phase transition stalled",
    },
  };
}

/** CS-KPI-23 Client-Hub Data Accuracy Score — CS deals carrying every mandatory field. */
export async function calcCsDataAccuracy(): Promise<ProcessKpiValue> {
  const a = await csKpiAggregates();
  if (a.csDeals === 0) return EMPTY;
  const clean = Math.max(0, a.csDeals - a.dataGapDeals);
  return {
    value: Math.round((clean / a.csDeals) * 1000) / 10,
    dataAvailable: true,
    details: {
      source: "Zoho CS section (SOP names Client-Hub / QA Records)",
      cs_deals: a.csDeals,
      deals_missing_a_mandatory_field: a.dataGapDeals,
      fields_checked:
        "company domain, CS owner, customer since, renewal date, health score, ARR value",
    },
  };
}

/** CS-KPI-30 Churn Classification Accuracy — churned deals carrying date AND reason. */
export async function calcCsChurnClassificationAccuracy(): Promise<ProcessKpiValue> {
  const a = await csKpiAggregates();
  // Denominator is churned deals, not all CS deals — with no terminations there
  // is nothing to classify, so the KPI stays "--" rather than reporting 100%.
  if (a.terminationDeals === 0) return EMPTY;
  const accurate = Math.max(0, a.terminationDeals - a.churnRecordGapDeals);
  return {
    value: Math.round((accurate / a.terminationDeals) * 1000) / 10,
    dataAvailable: true,
    details: {
      source: "Zoho CS lifecycle scan (SOP names Client-Hub / QA Records)",
      churned_deals: a.terminationDeals,
      missing_churn_date_or_reason: a.churnRecordGapDeals,
    },
  };
}

/**
 * CS-KPI-21 Client Churn Rate — DELIBERATELY NOT COMPUTED. Left manual.
 *
 * I wired this and it produced 61% against a 15% ceiling (567 churned / 930 CS
 * deals, 2026-08-19). That number is not the SOP's KPI and never could be:
 *
 * - The SOP formula is "Confirmed Churned Accounts / Applicable Active Client
 *   Population". My denominator was the ENTIRE historical CS book, active and
 *   churned together, so the figure only ever climbs — every client that has
 *   ever churned stays counted forever while the active side turns over.
 * - The target is "<=15% PER YEAR". Windowing needs a churn DATE per deal, and
 *   the lifecycle scan only carries churn_date on rows it flags as violations,
 *   not across the whole book. There is no date to window by.
 *
 * Swapping the denominator does not rescue it either: churned / non-churned is
 * 567/363 = 156%. The measure is unavailable from this data, not merely
 * mis-scaled, so it stays out of PROCESS_CALCULATORS with the other 29
 * Client-Hub KPIs rather than publishing a confident wrong red.
 *
 * To build it properly: a per-deal churn date across all CS records (Client-Hub,
 * or a Zoho churn-date field synced onto duplicate_records), then
 * churned-in-trailing-12-months / active-at-period-start.
 */

// ───────────────────────── GRC — Certification Milestones ───────────────────
/**
 * GRC-KPI-002 Certification Milestones On-Track — driven by the Document Mapping
 * "Coverage by Framework" data (per Sarah, 2026-06-16). Each certification /
 * compliance framework (COPC, ISO-27001, ISO-9001, NCA-DCC/ECC, PCI-DSS, PDPL,
 * SAMA-CSF) is a milestone; progress = clauses with ≥1 linked document. The KPI
 * = overall coverage across all frameworks (mirrors the page's "Overall
 * Document-Mapping Coverage" headline). Details carry per-framework breakdown.
 */
export async function calcCertificationMilestones(): Promise<ProcessKpiValue> {
  let frameworks;
  try {
    frameworks = await getAllFrameworkCoverage();
  } catch (e: any) {
    // Logged, not swallowed: a broken source renders identically to "nothing
    // recorded yet", so without this a failing query can sit undiagnosed
    // indefinitely (same flaw fixed in ratioKpi on 2026-08-23).
    logger.warn(
      `[kpiProcessCalc] calcCertificationMilestones source failed — KPI will report no data: ${e?.message || e}`,
    );
    return EMPTY;
  }
  if (!frameworks || frameworks.length === 0) return EMPTY;
  let total = 0;
  let mapped = 0;
  const byFramework: Record<string, number> = {};
  for (const f of frameworks) {
    total += Number(f.total_obligations) || 0;
    mapped += Number(f.with_evidence) || 0;
    byFramework[f.regulation_code] = Number(f.coverage_pct) || 0;
  }
  if (total === 0) return EMPTY;
  return {
    value: Math.round((mapped / total) * 1000) / 10,
    dataAvailable: true,
    details: { frameworks: frameworks.length, total_clauses: total, mapped, byFramework },
  };
}

// ──────────── GRC / Specialist "auto-ready" — fill once their data exists ─────
// Each reads an existing platform table and returns "--" (dataAvailable:false)
// until rows are added, so they auto-fill the moment the register is populated.
// Wrapped in try/catch so a schema mismatch degrades to "--" rather than erroring.

async function ratioKpi(
  sql: string,
  totalKey = "total",
  goodKey = "good",
): Promise<ProcessKpiValue> {
  let res;
  try {
    res = await pool.query(sql);
  } catch (e: any) {
    // A swallowed error made a BROKEN KPI look exactly like an EMPTY one: both
    // render "no data", so a query against a renamed or missing table (the
    // `risks` vs `enterprise_risks` class of bug) could sit undiagnosed
    // indefinitely. The KPI still degrades to EMPTY rather than breaking the
    // page, but the reason is now recoverable from the logs.
    logger.warn(
      `[kpiProcessCalc] ratioKpi query failed — KPI will report no data: ${e?.message || e}`,
      { sql: sql.replace(/\s+/g, " ").slice(0, 160) },
    );
    return EMPTY;
  }
  const total = Number(res.rows[0]?.[totalKey] || 0);
  const good = Number(res.rows[0]?.[goodKey] || 0);
  if (total === 0) return EMPTY;
  return { value: Math.round((good / total) * 1000) / 10, dataAvailable: true, details: { good, total } };
}

/** GRC-KPI-017 Risk Register Hygiene — risks with owner + department + treatment ÷ total. */
export const calcRiskRegisterHygiene = () =>
  ratioKpi(
    `SELECT COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE risk_owner IS NOT NULL AND trim(risk_owner) <> ''
         AND owner_department IS NOT NULL AND trim(owner_department) <> ''
         AND treatment_strategy IS NOT NULL)::int AS good
     FROM enterprise_risks`,
  );

/** GRC-KPI-019 TPRA SLA — vendor assessments completed ÷ total assessments. */
export const calcTpraSla = () =>
  ratioKpi(
    `SELECT COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status IN ('approved','completed','reviewed','submitted'))::int AS good
     FROM vendor_assessments`,
  );

/** GRC-KPI-018 Vendor Risk Posture — critical vendors with acceptable status ÷ critical. */
export const calcVendorRiskPosture = () =>
  ratioKpi(
    `SELECT COUNT(*) FILTER (WHERE criticality = 'critical')::int AS total,
       COUNT(*) FILTER (WHERE criticality = 'critical' AND status IN ('approved','active'))::int AS good
     FROM vendors`,
  );

/** SPEC-KPI-02 Compliance Obligation Tracking — applicable obligations with a responsible dept ÷ applicable. */
export const calcComplianceObligationTracking = () =>
  ratioKpi(
    `SELECT COUNT(*) FILTER (WHERE status = 'applicable')::int AS total,
       COUNT(*) FILTER (WHERE status = 'applicable' AND responsible_department IS NOT NULL
         AND trim(responsible_department) <> '')::int AS good
     FROM obligations`,
  );

/** SPEC-KPI-04 Quality→GRC Handoff Effectiveness — accepted/processed handoffs ÷ total. */
export const calcHandoffEffectiveness = () =>
  ratioKpi(
    `SELECT COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status IN ('processed','accepted','completed') OR processed_at IS NOT NULL)::int AS good
     FROM handoff_events`,
  );

/** SPEC-KPI-06 CAPA Follow-Up Compliance — treatment actions completed on/before due date ÷ non-cancelled. */
export const calcCapaFollowUp = () =>
  ratioKpi(
    `SELECT COUNT(*) FILTER (WHERE status <> 'cancelled')::int AS total,
       COUNT(*) FILTER (WHERE status = 'completed' AND completion_date IS NOT NULL
         AND completion_date <= due_date)::int AS good
     FROM risk_treatment_actions`,
  );

/** SPEC-KPI-07 Regulatory Evidence Availability — ready evidence packs ÷ total. */
export const calcRegulatoryEvidenceAvailability = () =>
  ratioKpi(
    `SELECT COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status IN ('compiled','reviewed','submitted'))::int AS good
     FROM evidence_packs`,
  );

// ───────────────────── Quality — BU Coverage (per-BU tracker) ────────────────
/** QM-KPI-008 BU Coverage Rate — average coverage % across the per-BU tracker. */
export async function calcBuCoverageTracked(): Promise<ProcessKpiValue> {
  try {
    const { buCoverageRateForFeed } = await import("./kpiBuCoverageDatabase");
    const v = await buCoverageRateForFeed();
    if (v === null) return EMPTY;
    return { value: v, dataAvailable: true };
  } catch (e: any) {
    // QM-KPI-008 is PUSHED TO LEADERSHIP, so a silent failure here means the
    // recorded value keeps going outward with no signal that the live
    // computation stopped working.
    logger.warn(
      `[kpiProcessCalc] calcBuCoverageTracked failed — QM-KPI-008 will report no data: ${e?.message || e}`,
    );
    return EMPTY;
  }
}

// ───────────────────── Quality — Quality→GRC Handoff SLA ─────────────────────
/**
 * QM-KPI-006 Quality→GRC Handoff SLA — % of handoffs PROCESSED WITHIN the SLA
 * window (NOT the average cycle time the leadership feed computes). Excel formula
 * = "Handoffs Within SLA ÷ Total Handoffs × 100". SLA window = 5 calendar days
 * (Quality SOP). Reads handoff_events (created_at → processed_at).
 */
const HANDOFF_SLA_DAYS = 5;
export async function calcHandoffSlaCompliance(): Promise<ProcessKpiValue> {
  let res;
  try {
    res = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE processed_at IS NOT NULL)::int AS total,
         COUNT(*) FILTER (WHERE processed_at IS NOT NULL
           AND EXTRACT(EPOCH FROM (processed_at - created_at)) / 86400.0 <= ${HANDOFF_SLA_DAYS})::int AS within_sla
       FROM handoff_events`,
    );
  } catch (e: any) {
    logger.warn(
      `[kpiProcessCalc] calcHandoffSlaCompliance query failed — KPI will report no data: ${e?.message || e}`,
    );
    return EMPTY;
  }
  const total = Number(res.rows[0]?.total || 0);
  const within = Number(res.rows[0]?.within_sla || 0);
  if (total === 0) return EMPTY;
  return {
    value: Math.round((within / total) * 1000) / 10,
    dataAvailable: true,
    details: { within_sla: within, total_handoffs: total, sla_days: HANDOFF_SLA_DAYS },
  };
}

// ───────────────────── Quality — Documentation Lifecycle ────────────────────
/**
 * QM-KPI-010 Documentation Lifecycle Compliance — driven by the Integrated QMS
 * document register (`policies` table, the /policies "Document Lifecycle" page)
 * per Sarah (2026-06-16). NOTE: this is the document REVIEW CYCLE (Draft → Review
 * → Approval → Published → Annual Review), NOT the AI Approvals Queue. Value =
 * controlled documents that completed the lifecycle (Published) AND are current
 * (review not overdue) ÷ active controlled documents.
 */
export async function calcDocumentationLifecycle(): Promise<ProcessKpiValue> {
  let res;
  try {
    res = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status NOT IN ('archived','retired'))::int AS active_total,
         COUNT(*) FILTER (WHERE status = 'published')::int AS published,
         COUNT(*) FILTER (WHERE status = 'published' AND review_date < NOW())::int AS overdue
       FROM policies`,
    );
  } catch (e: any) {
    logger.warn(
      `[kpiProcessCalc] calcDocumentationLifecycle query failed — KPI will report no data: ${e?.message || e}`,
    );
    return EMPTY;
  }
  const activeTotal = Number(res.rows[0]?.active_total || 0);
  const published = Number(res.rows[0]?.published || 0);
  const overdue = Number(res.rows[0]?.overdue || 0);
  if (activeTotal === 0) return EMPTY;
  const compliant = Math.max(0, published - overdue);
  return {
    value: Math.round((compliant / activeTotal) * 1000) / 10,
    dataAvailable: true,
    details: { active_total: activeTotal, published, overdue_reviews: overdue, compliant },
  };
}

/**
 * Map of canonical SDR/Sales KPI code → LOCAL-only calculator (no Zoho calls).
 * Cycle-time KPIs (SALES-KPI-03/04) are handled separately via
 * computeSalesCycleTimes() because they hit the live Zoho API. Codes not covered
 * anywhere have no source yet and stay "--".
 */
export const PROCESS_CALCULATORS: Record<
  string,
  () => Promise<ProcessKpiValue>
> = {
  // SDR
  "SDR-KPI-01": calcSdrCallsPerDay,
  "SDR-KPI-02": calcSdrContactRate,
  "SDR-KPI-03": calcSdrQualificationRate,
  "SDR-KPI-04": calcSdrMeetingsBooked,
  "SDR-KPI-05": calcSdrShowRate,
  "SDR-KPI-06": calcSdrSpeedToLead,
  "SDR-KPI-07": calcSdrLeadToQualified,
  "SDR-KPI-08": calcSdrCrmAccuracy,
  "SDR-KPI-09": calcSdrDuplicateRate,
  "SDR-KPI-10": calcSdrPipelineAging,
  "SDR-KPI-11": calcSdrFollowUpCompliance,
  // The governed meeting-conversion metric (SDR SOP v2.2). Replaced
  // ADHOC-SALES-04, which was built from a BI-portal screenshot.
  "SDR-KPI-12": calcSdrBookingConversionRate,
  // Sales
  "SALES-KPI-01": calcSalesStageAgingCompliance,
  "SALES-KPI-02": calcSalesConversionRate,
  "SALES-KPI-03": calcSalesProposalCycleTime,
  "SALES-KPI-04": calcSalesAgreementCycleTime,
  "SALES-KPI-05": calcSalesDocCompliance,
  "SALES-KPI-06": calcSalesCrmAccuracy,
  "SALES-KPI-07": calcSalesFollowUpEffectiveness,
  "SALES-KPI-08": calcSalesFirstContactSla,
  "SALES-KPI-09": calcSalesDuplicateRate,
  // Sales — ad-hoc (added from the BI portal, now QMS-computed)
  "ADHOC-SALES-01": calcAdhocSalesWonRevenue,
  "ADHOC-SALES-02": calcAdhocSalesQualifiedPipeline,
  "ADHOC-SALES-03": calcAdhocSalesAvgDealValue,
  "ADHOC-SALES-04": calcAdhocSalesMeetingConversion,
  // Customer Success (B2B) — the four KPIs of WP-BU-CS-SOP-003 that QMS can
  // measure from the Zoho mirror. The other 29 name Client-Hub / Jira / the
  // Admin-BI Portal / QA sampling and stay manual until those feeds exist.
  // CS-KPI-21 Client Churn Rate is intentionally absent — see the note above
  // calcCsDataAccuracy. It cannot be sourced correctly from Zoho.
  "CS-KPI-23": calcCsDataAccuracy,
  "CS-KPI-25": calcCsSlaAdherence,
  "CS-KPI-30": calcCsChurnClassificationAccuracy,
  // GRC-KPI-002 measures on-time delivery of Certification Milestone Plan
  // milestones. It previously reported document-mapping clause coverage via
  // calcCertificationMilestones — kept below but no longer wired here, since
  // coverage is a useful metric that is simply not this KPI.
  "GRC-KPI-002": async () => {
    const r = await calcCertMilestoneDelivery();
    return r.dataAvailable
      ? { value: r.value, dataAvailable: true, details: r.details }
      : EMPTY;
  },
  // Quality — driven by the Integrated QMS document lifecycle
  "QM-KPI-010": calcDocumentationLifecycle,
  // Quality — % of handoffs processed within the SLA window
  "QM-KPI-006": calcHandoffSlaCompliance,
  // Quality — BU Coverage Rate from the per-BU coverage tracker
  "QM-KPI-008": calcBuCoverageTracked,
  // GRC / Specialist "auto-ready" — fill once their registers carry data
  "GRC-KPI-017": calcRiskRegisterHygiene,
  "GRC-KPI-019": calcTpraSla,
  "GRC-KPI-018": calcVendorRiskPosture,
  "SPEC-KPI-02": calcComplianceObligationTracking,
  "SPEC-KPI-04": calcHandoffEffectiveness,
  "SPEC-KPI-06": calcCapaFollowUp,
  "SPEC-KPI-07": calcRegulatoryEvidenceAvailability,
};

/**
 * Run every process calculator and return code → result. Each is isolated so one
 * failure (or empty source) can't abort the rest.
 */
export async function computeProcessKPIs(
  includeCycleTimes = false,
): Promise<Record<string, ProcessKpiValue>> {
  const out: Record<string, ProcessKpiValue> = {};
  for (const [code, fn] of Object.entries(PROCESS_CALCULATORS)) {
    try {
      out[code] = await fn();
    } catch (e) {
      logger.error(`[KPIProcessCalc] ${code} failed: ${(e as Error).message}`);
      out[code] = EMPTY;
    }
  }

  // Sales cycle times = the ONLY Zoho-API step (up to 40 sequential per-deal
  // history calls). Run it only in the background daily job (includeCycleTimes),
  // NOT on the interactive Recalculate button, so the button can't hang / time out.
  if (includeCycleTimes) {
    try {
      // MERGE, don't clobber. SALES-KPI-03/04 now have LOCAL calculators in the
      // registry above that always produce a value. The Zoho stage-history
      // sample is a refinement on top — it measures completed dwell per stage
      // transition, which the local proxy cannot see.
      //
      // A blind Object.assign would overwrite good local values with EMPTY
      // whenever Zoho returns nothing, which is this tenant's normal state:
      // Stage_History yields no usable Stage_Duration here (the aging endpoint
      // reports source:"created", i.e. it fell back to the record's creation
      // time), so the run reports "no synced source data" rather than failing.
      const zoho = await computeSalesCycleTimes();
      for (const [code, value] of Object.entries(zoho)) {
        if (value?.dataAvailable) out[code] = value;
      }
    } catch (e) {
      // Leave the local values in place — a Zoho outage must not blank a KPI
      // that was computed successfully from our own mirror.
      logger.error(`[KPIProcessCalc] cycle-times failed: ${(e as Error).message}`);
    }
  }

  return out;
}
