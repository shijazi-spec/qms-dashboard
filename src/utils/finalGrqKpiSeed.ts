/**
 * FINAL canonical GRQ KPI set — source: "GRQ Final KPIs_2.xlsx" (Sarah, 2026-06-16).
 * 5 owner groups: Quality (Sarah Hijazi), GRC (Maram AlHarbi), GRQ Specialist
 * (AlHanouf), Legal (Ali Fahad — NEW owner), and GRQ Team roll-ups (Shared).
 *
 * Each entry mirrors the Excel cells: name, description, calculation (formula),
 * target, frequency, owner, data source. Thresholds are derived from the single
 * Excel target. calc_mode = auto where a platform calculator already exists
 * (reused via the existing CANONICAL_TO_FEED / PROCESS_CALCULATORS maps, keyed by
 * code), checklist for framework/adoption, manual otherwise (incl. roll-ups until
 * their components have data). SDR + Sales KPIs are NOT in this Excel and are left
 * untouched. Idempotent upsert; old GRQ codes not in this set are deactivated.
 */
import { pool } from "./kpiDatabase";
import { logger } from "./logger";

interface FinalKpi {
  code: string;
  name: string;
  owner_type: "quality_manager" | "grc_manager" | "grq_specialist" | "legal_specialist" | "shared";
  owner_name: string;
  category: string;
  unit: string; // "%" | "days"
  target: number;
  direction: "higher_is_better" | "lower_is_better";
  frequency: "daily" | "weekly" | "monthly" | "quarterly" | "annual";
  calc_mode: "auto" | "checklist" | "manual" | "bu_coverage";
  north_star?: boolean;
  description: string;
  formula: string;
  data_source: string;
}

/** Derive green/amber/red bands from the single Excel target + direction. */
function bands(target: number, dir: "higher_is_better" | "lower_is_better") {
  if (dir === "higher_is_better") {
    return {
      green: target,
      amber: Math.round(target * 0.85),
      red: Math.round(target * 0.7),
    };
  }
  // lower is better (days / rates where less = good)
  return {
    green: target,
    amber: Math.round(target * 1.5),
    red: Math.round(target * 2),
  };
}

const FINAL_KPIS: FinalKpi[] = [
  // ───────────── Quality — Sarah Hijazi (quality_manager) ─────────────
  { code: "QM-KPI-002", name: "Audit Execution Rate", owner_type: "quality_manager", owner_name: "Sarah Hijazi", category: "audit", unit: "%", target: 90, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", north_star: true, description: "How much of the planned audit programme was actually completed in the period.", formula: "Completed Audits ÷ Planned Audits × 100", data_source: "Internal Audits module (/audits) + completed AI-audit runs (audit_runs)" },
  { code: "QM-KPI-008", name: "BU Coverage Rate", owner_type: "quality_manager", owner_name: "Sarah Hijazi", category: "governance", unit: "%", target: 100, direction: "higher_is_better", frequency: "quarterly", calc_mode: "bu_coverage", north_star: true, description: "Share of business units fully governed — framework PUBLISHED and at least one audit cycle COMPLETED. Stricter than Framework Completion: a BU counts only when both framework and audit are live.", formula: "(BUs with Published Framework AND ≥1 Completed Audit ÷ Total BUs Requiring Governance) × 100", data_source: "Per-BU Framework checklist — 'Process Releasing' (published) + 'Trial Audit Report' (audited) milestones" },
  { code: "QM-KPI-003", name: "Gap Closure Rate", owner_type: "quality_manager", owner_name: "Sarah Hijazi", category: "audit", unit: "%", target: 80, direction: "higher_is_better", frequency: "monthly", calc_mode: "auto", description: "Share of audit findings closed within their agreed deadline.", formula: "Closed Findings Within SLA ÷ Total Findings Due × 100", data_source: "CAPA Register on QMS Platform" },
  { code: "QM-KPI-009", name: "Repeat Findings Rate", owner_type: "quality_manager", owner_name: "Sarah Hijazi", category: "audit", unit: "%", target: 10, direction: "lower_is_better", frequency: "quarterly", calc_mode: "manual", description: "Findings that recur from earlier audits - shows whether root causes are truly fixed (lower is better).", formula: "Repeat Findings ÷ Total Findings × 100", data_source: "Audit Findings Log on QMS Platform" },
  { code: "QM-KPI-004", name: "QMS Adoption Rate", owner_type: "quality_manager", owner_name: "Sarah Hijazi", category: "quality", unit: "%", target: 70, direction: "higher_is_better", frequency: "quarterly", calc_mode: "checklist", description: "How widely the QMS processes are actually used across the business units.", formula: "Active QMS Users/Processes ÷ Target Scope × 100", data_source: "QMS Platform" },
  { code: "QM-KPI-011", name: "Continuous Improvement Index", owner_type: "quality_manager", owner_name: "Sarah Hijazi", category: "quality", unit: "%", target: 90, direction: "higher_is_better", frequency: "quarterly", calc_mode: "manual", description: "Share of planned improvement actions that were implemented.", formula: "Implemented Improvements ÷ Planned Improvements × 100", data_source: "Improvement Register on QMS Platform" },
  { code: "QM-KPI-006", name: "Quality → GRC Handoff SLA", owner_type: "quality_manager", owner_name: "Sarah Hijazi", category: "governance", unit: "%", target: 95, direction: "higher_is_better", frequency: "monthly", calc_mode: "auto", description: "Share of Quality-to-GRC escalations handed over within the SLA window.", formula: "Handoffs Within SLA ÷ Total Handoffs × 100", data_source: "Handoff Log" },

  // ───────────── GRC — Maram AlHarbi (grc_manager) ─────────────
  { code: "GRC-KPI-008", name: "Compliance Coverage Index", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "compliance", unit: "%", target: 90, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", north_star: true, description: "Share of applicable obligations mapped to a control or policy.", formula: "Mapped Obligations ÷ Total Obligations × 100", data_source: "QMS Platform → Compliance/Obligations register (applicable obligations with a mapped control or policy ÷ total applicable)" },
  { code: "QM-KPI-015", name: "Process & Quality Framework Completion", owner_type: "quality_manager", owner_name: "Sarah Hijazi", category: "governance", unit: "%", target: 100, direction: "higher_is_better", frequency: "quarterly", calc_mode: "checklist", north_star: true, description: "Share of required governance frameworks fully built and PUBLISHED. Total required = 8 (one per commercial department: SDR, Sales B2B, Marketplace, Customer Success, Marketing, Sales B2C, Contact Center, + 1 overarching QMS framework).", formula: "(Governance Frameworks Published ÷ Total Frameworks Required [8]) × 100", data_source: "Per-BU Framework checklist — 'Process Releasing' (published) milestone" },
  { code: "GRC-KPI-002", name: "Certification Milestones On Track", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "compliance", unit: "%", target: 100, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", description: "Share of certification / regulatory roadmap milestones achieved on schedule.", formula: "Achieved Milestones ÷ Planned Milestones × 100", data_source: "Certification Roadmap / Document Mapping" },
  { code: "GRC-KPI-003", name: "Audit Evidence Readiness", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "audit", unit: "%", target: 95, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", description: "Share of required audit evidence compiled and ready ahead of the audit.", formula: "Ready Evidence Items ÷ Required Evidence Items × 100", data_source: "Evidence Repository" },
  { code: "QM-KPI-010", name: "Documentation Lifecycle Compliance", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "governance", unit: "%", target: 95, direction: "higher_is_better", frequency: "monthly", calc_mode: "auto", description: "Share of controlled documents kept current through their full lifecycle (reviewed, approved, published on time).", formula: "Documents Reviewed On Time ÷ Documents Due × 100", data_source: "Document Control Register (Integrated QMS)" },
  { code: "GRC-KPI-012", name: "Regulatory Response Timeliness", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "compliance", unit: "days", target: 5, direction: "lower_is_better", frequency: "monthly", calc_mode: "manual", description: "Average time to respond to a regulator request (lower is better).", formula: "Avg(Response Date − Request Date)", data_source: "Compliance Log" },
  { code: "GRC-KPI-013", name: "Security Incident Governance Closure Time", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "compliance", unit: "days", target: 30, direction: "lower_is_better", frequency: "monthly", calc_mode: "manual", description: "Average time to govern a security incident through to closure (lower is better).", formula: "Avg(Closure Date − Incident Date)", data_source: "Incident Register" },
  { code: "GRC-KPI-010", name: "Risk Assessment Coverage", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "risk", unit: "%", target: 100, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", description: "Share of business units with a completed risk assessment.", formula: "Assessed BUs ÷ Total BUs × 100", data_source: "Risk Register" },
  { code: "GRC-KPI-005", name: "Risk Treatment On-Time Closure", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "risk", unit: "%", target: 85, direction: "higher_is_better", frequency: "monthly", calc_mode: "auto", description: "Share of risk treatment actions closed by their due date.", formula: "Closed On Time ÷ Total Treatments Due × 100", data_source: "Risk Register" },
  { code: "GRC-KPI-009", name: "High-Risk Items With Treatment Plan", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "risk", unit: "%", target: 100, direction: "higher_is_better", frequency: "monthly", calc_mode: "auto", description: "Share of high / critical risks that have an active treatment plan.", formula: "High Risks With Plan ÷ Total High Risks × 100", data_source: "Risk Register" },
  { code: "GRC-KPI-017", name: "Risk Register Hygiene", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "risk", unit: "%", target: 95, direction: "higher_is_better", frequency: "monthly", calc_mode: "auto", description: "Share of risks with complete, accurate register entries (owner, status, review date).", formula: "Valid Risks ÷ Total Risks Reviewed × 100", data_source: "Risk Register" },
  { code: "GRC-KPI-019", name: "TPRA SLA", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "vendor", unit: "%", target: 90, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", description: "Share of third-party (vendor) risk assessments completed within their SLA.", formula: "Assessments Completed Within SLA ÷ Total Assessments × 100", data_source: "TPRA Tracker" },
  { code: "GRC-KPI-014", name: "Client/Partner Security Assessment SLA", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "vendor", unit: "%", target: 90, direction: "higher_is_better", frequency: "monthly", calc_mode: "manual", description: "Share of client / partner security assessments answered within their SLA.", formula: "Completed Within SLA ÷ Total Requests × 100", data_source: "Assessment Log" },
  { code: "GRC-KPI-006", name: "High-Risk Vendor Findings Closure", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "vendor", unit: "%", target: 85, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", description: "Share of high-risk vendor findings remediated and closed.", formula: "Closed Findings ÷ Total Findings × 100", data_source: "Vendor Risk Tracker" },
  { code: "GRC-KPI-018", name: "Vendor Risk Posture", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "vendor", unit: "%", target: 90, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", description: "Share of critical vendors sitting within an acceptable risk rating.", formula: "Vendors Within Acceptable Rating ÷ Critical Vendors × 100", data_source: "Vendor Risk Tracker" },

  // ───────────── GRQ Specialist — AlHanouf (grq_specialist) ─────────────
  { code: "SPEC-KPI-01", name: "Governance Operations Readiness Index", owner_type: "grq_specialist", owner_name: "AlHanouf", category: "governance", unit: "%", target: 95, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", north_star: true, description: "Overall readiness of the governance support functions (docs, compliance, evidence, reporting, CAPA) - a roll-up of this team's KPIs.", formula: "Equal-weighted average of supporting KPIs #2–#7 (each 1/6)", data_source: "KPI Dashboard (roll-up)" },
  { code: "SPEC-KPI-02", name: "Compliance Obligation Tracking", owner_type: "grq_specialist", owner_name: "AlHanouf", category: "compliance", unit: "%", target: 95, direction: "higher_is_better", frequency: "monthly", calc_mode: "auto", description: "How complete and up-to-date the compliance obligation register is kept.", formula: "Updated Obligations ÷ Total Applicable Obligations × 100", data_source: "Compliance Register" },
  { code: "SPEC-KPI-03", name: "Executive Reporting Readiness", owner_type: "grq_specialist", owner_name: "AlHanouf", category: "governance", unit: "%", target: 100, direction: "higher_is_better", frequency: "monthly", calc_mode: "manual", description: "Share of management / board reports delivered on time.", formula: "Reports Delivered On Time ÷ Planned Reports × 100", data_source: "Reporting Calendar" },
  { code: "SPEC-KPI-04", name: "Quality → GRC Handoff Effectiveness", owner_type: "grq_specialist", owner_name: "AlHanouf", category: "governance", unit: "%", target: 95, direction: "higher_is_better", frequency: "monthly", calc_mode: "auto", description: "Share of Quality findings correctly accepted into the GRC workflow.", formula: "Accepted Handoffs ÷ Total Handoffs × 100", data_source: "Handoff Log" },
  { code: "SPEC-KPI-05", name: "Compliance Closure Tracking", owner_type: "grq_specialist", owner_name: "AlHanouf", category: "compliance", unit: "%", target: 95, direction: "higher_is_better", frequency: "monthly", calc_mode: "manual", description: "Share of compliance actions followed through to closure.", formula: "Closed Actions ÷ Due Actions × 100", data_source: "Compliance Action Log" },
  { code: "SPEC-KPI-06", name: "CAPA Follow-Up Compliance", owner_type: "grq_specialist", owner_name: "AlHanouf", category: "quality", unit: "%", target: 95, direction: "higher_is_better", frequency: "monthly", calc_mode: "auto", description: "Share of corrective actions (CAPAs) monitored and closed within SLA.", formula: "CAPAs Followed Within SLA ÷ Total CAPAs × 100", data_source: "CAPA Register" },
  { code: "SPEC-KPI-07", name: "Regulatory Evidence Availability", owner_type: "grq_specialist", owner_name: "AlHanouf", category: "compliance", unit: "%", target: 100, direction: "higher_is_better", frequency: "monthly", calc_mode: "auto", description: "Share of requested audit / assessment evidence that is available on demand.", formula: "Available Evidence ÷ Requested Evidence × 100", data_source: "Evidence Repository" },

  // ───────────── Legal — Ali Fahad (legal_specialist, NEW owner) ─────────────
  { code: "LEG-KPI-01", name: "Legal Governance Score", owner_type: "legal_specialist", owner_name: "Ali Fahad", category: "compliance", unit: "%", target: 95, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", north_star: true, description: "Overall legal effectiveness and compliance - a roll-up of the legal KPIs.", formula: "Equal-weighted average of Legal KPIs #2–#10 (each 1/9)", data_source: "KPI Dashboard (roll-up)" },
  { code: "LEG-KPI-02", name: "Contract Review SLA", owner_type: "legal_specialist", owner_name: "Ali Fahad", category: "compliance", unit: "%", target: 95, direction: "higher_is_better", frequency: "monthly", calc_mode: "manual", description: "Share of contracts reviewed within the legal SLA.", formula: "Contracts Reviewed Within SLA ÷ Total Contracts × 100", data_source: "Contract Register" },
  { code: "LEG-KPI-03", name: "Contract Closure Cycle Time", owner_type: "legal_specialist", owner_name: "Ali Fahad", category: "compliance", unit: "days", target: 5, direction: "lower_is_better", frequency: "monthly", calc_mode: "manual", description: "Average days to complete a legal contract review (lower is better).", formula: "Total Review Days ÷ Total Contracts", data_source: "Contract Register" },
  { code: "LEG-KPI-04", name: "Legal Consultation SLA", owner_type: "legal_specialist", owner_name: "Ali Fahad", category: "compliance", unit: "%", target: 95, direction: "higher_is_better", frequency: "monthly", calc_mode: "manual", description: "Share of internal legal requests answered within SLA.", formula: "Requests Answered Within SLA ÷ Total Requests × 100", data_source: "Legal Request Log" },
  { code: "LEG-KPI-05", name: "Legal Risk Identification Rate", owner_type: "legal_specialist", owner_name: "Ali Fahad", category: "compliance", unit: "%", target: 95, direction: "higher_is_better", frequency: "quarterly", calc_mode: "manual", description: "Share of contractual / legal risks caught before signature.", formula: "Risks Identified Before Signature ÷ Total Risks Identified × 100", data_source: "Contract Review Log" },
  { code: "LEG-KPI-06", name: "Contract Compliance Coverage", owner_type: "legal_specialist", owner_name: "Ali Fahad", category: "compliance", unit: "%", target: 100, direction: "higher_is_better", frequency: "quarterly", calc_mode: "manual", description: "Share of contracts containing all mandatory clauses.", formula: "Contracts With Required Clauses ÷ Total Contracts Reviewed × 100", data_source: "Contract Register" },
  { code: "LEG-KPI-07", name: "DPA & Privacy Clause Coverage", owner_type: "legal_specialist", owner_name: "Ali Fahad", category: "compliance", unit: "%", target: 100, direction: "higher_is_better", frequency: "quarterly", calc_mode: "manual", description: "Share of applicable contracts including the required PDPL / privacy (DPA) clauses.", formula: "Contracts With DPA/PDPL Clauses ÷ Applicable Contracts × 100", data_source: "Contract Register" },
  { code: "LEG-KPI-08", name: "Contract Repository Completeness", owner_type: "legal_specialist", owner_name: "Ali Fahad", category: "compliance", unit: "%", target: 100, direction: "higher_is_better", frequency: "monthly", calc_mode: "manual", description: "Share of contracts properly archived and traceable.", formula: "Contracts Properly Archived ÷ Total Contracts × 100", data_source: "Contract Repository" },
  { code: "LEG-KPI-09", name: "Legal Action Closure Rate", owner_type: "legal_specialist", owner_name: "Ali Fahad", category: "compliance", unit: "%", target: 90, direction: "higher_is_better", frequency: "quarterly", calc_mode: "manual", description: "Share of assigned legal actions closed.", formula: "Closed Actions ÷ Total Legal Actions × 100", data_source: "Legal Action Log" },
  { code: "LEG-KPI-10", name: "Contract Backlog Rate", owner_type: "legal_specialist", owner_name: "Ali Fahad", category: "compliance", unit: "%", target: 10, direction: "lower_is_better", frequency: "monthly", calc_mode: "manual", description: "Share of pending contracts overdue beyond the review SLA (lower is better).", formula: "Overdue Contracts ÷ Total Contracts Pending × 100", data_source: "Contract Register" },

  // ───────────── GRQ Team — roll-ups (shared) ─────────────
  { code: "GRQ-KPI-01", name: "GRQ Health Score", owner_type: "shared", owner_name: "GRQ Team", category: "governance", unit: "%", target: 90, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", north_star: true, description: "Overall operational health of the GRQ functions - a weighted roll-up of Quality, GRC, Specialist and Legal achievement.", formula: "Quality×35% + GRC×35% + GRQ Specialist×15% + Legal×15%", data_source: "KPI Dashboard (roll-up)" },
  { code: "GRQ-KPI-02", name: "Cross-Module Integration Score", owner_type: "shared", owner_name: "GRQ Team", category: "governance", unit: "%", target: 90, direction: "higher_is_better", frequency: "quarterly", calc_mode: "manual", description: "How effectively the Quality and GRC processes are integrated.", formula: "Successful Integrations ÷ Planned Integrations × 100", data_source: "Integration Plan / PMO Tracker" },
  { code: "GRQ-KPI-03", name: "Governance Maturity Score", owner_type: "shared", owner_name: "GRQ Team", category: "governance", unit: "%", target: 85, direction: "higher_is_better", frequency: "annual", calc_mode: "manual", description: "Maturity level of governance practices against the assessment model.", formula: "Assessment Score ÷ Maximum Score × 100", data_source: "Maturity Assessment" },
  { code: "GRQ-KPI-04", name: "Executive GRQ Score", owner_type: "shared", owner_name: "GRQ Team", category: "governance", unit: "%", target: 90, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", description: "Top-line GRQ performance - an equal blend of Quality health and GRC achievement.", formula: "50% × Quality Health Score + 50% × GRC KPI average", data_source: "KPI Dashboard (roll-up)" },
];

const FINAL_CODES = FINAL_KPIS.map((k) => k.code);

/**
 * Upsert the final GRQ KPI set and deactivate any older GRQ KPIs (the 5 GRQ
 * owner groups) whose code isn't in the final list. SDR/Sales (different owner
 * types) are never touched. Idempotent; preserves any checklist items linked by
 * kpi_id (e.g. the BU Framework / now Process & Framework Completion checklist).
 */
export async function seedFinalGrqKpis(): Promise<void> {
  for (const k of FINAL_KPIS) {
    const b = bands(k.target, k.direction);
    await pool.query(
      `INSERT INTO kpi_definitions
         (kpi_name, kpi_code, description, owner_type, owner_name, category, formula, data_source, unit, frequency,
          threshold_green, threshold_amber, threshold_red, threshold_direction, target_value, is_active, is_north_star, calc_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,$16,$17)
       ON CONFLICT (kpi_code) DO UPDATE SET
         kpi_name = EXCLUDED.kpi_name,
         description = EXCLUDED.description,
         owner_type = EXCLUDED.owner_type,
         owner_name = EXCLUDED.owner_name,
         category = EXCLUDED.category,
         formula = EXCLUDED.formula,
         data_source = EXCLUDED.data_source,
         unit = EXCLUDED.unit,
         frequency = EXCLUDED.frequency,
         threshold_green = EXCLUDED.threshold_green,
         threshold_amber = EXCLUDED.threshold_amber,
         threshold_red = EXCLUDED.threshold_red,
         threshold_direction = EXCLUDED.threshold_direction,
         target_value = EXCLUDED.target_value,
         is_active = true,
         is_north_star = EXCLUDED.is_north_star,
         calc_mode = EXCLUDED.calc_mode,
         updated_at = NOW()`,
      [k.name, k.code, k.description, k.owner_type, k.owner_name, k.category, k.formula, k.data_source, k.unit, k.frequency,
       b.green, b.amber, b.red, k.direction, k.target, k.north_star ?? false, k.calc_mode],
    );
  }

  // Deactivate older GRQ KPIs not in the final list (old QM/GRC/MAM/SHR codes,
  // the previous composites, etc.). Only the 5 GRQ owner groups — never SDR/Sales.
  const res = await pool.query(
    `UPDATE kpi_definitions SET is_active = false, updated_at = NOW()
      WHERE owner_type IN ('quality_manager','grc_manager','grq_specialist','legal_specialist','shared','governance_officer')
        AND kpi_code <> ALL($1::text[])
        AND is_active = true`,
    [FINAL_CODES],
  );
  // QM-KPI-015 (Process & Framework Completion) and QM-KPI-008 (BU Coverage) are
  // BOTH active, distinct KPIs aligned to the Leadership Platform: Framework
  // Completion = frameworks PUBLISHED ÷ 8; BU Coverage = PUBLISHED+AUDITED ÷ 8
  // (stricter). Both read the same per-BU 9-phase checklist at different
  // milestones; QM-KPI-015 is also reassigned to Quality (Sarah).
  await pool.query(
    `UPDATE kpi_definitions SET owner_type = 'quality_manager', owner_name = 'Sarah Hijazi', updated_at = NOW()
      WHERE kpi_code = 'QM-KPI-015'`,
  );

  logger.info(
    `📋 [KPIDB] Seeded ${FINAL_KPIS.length} final GRQ KPIs; deactivated ${res.rowCount ?? 0} superseded.`,
  );
}
