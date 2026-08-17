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
  openStagePredicate,
} from "./duplicateRadarDatabase";
import { fetchDealStageHistory } from "./zohoCRM";
import { getAllFrameworkCoverage } from "./obligationDocumentsDatabase";

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
  } catch {
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
  } catch {
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
  } catch {
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
  } catch {
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
  } catch {
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
  // GRC — driven by the Document Mapping framework coverage
  "GRC-KPI-002": calcCertificationMilestones,
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
