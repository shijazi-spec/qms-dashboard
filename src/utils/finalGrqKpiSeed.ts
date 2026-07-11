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

// ★ AUTHORITATIVE from "New_GRQ Final KPIs.xlsx" (Sarah, 2026-06-30): 27 KPIs.
// Leadership-tracked codes kept STABLE so the pull doesn't break:
//   QM-KPI-002 = Audit Execution, QM-KPI-015 = BU Framework Readiness ("built"),
//   QM-KPI-008 = BU Pilot Validation ("audited"), GRC-KPI-008 = Compliance Coverage.
const FINAL_KPIS: FinalKpi[] = [
  // ───────────── Quality — Sarah Hijazi (6) ─────────────
  { code: "QM-KPI-002", name: "Audit Execution Rate", owner_type: "quality_manager", owner_name: "Sarah Hijazi", category: "audit", unit: "%", target: 95, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", north_star: true, description: "Measures the percentage of planned internal audits completed within the defined period across in-scope business units.", formula: "Completed Audits ÷ Planned Audits × 100", data_source: "QMS Platform" },
  { code: "QM-KPI-015", name: "BU Framework Readiness Rate", owner_type: "quality_manager", owner_name: "Sarah Hijazi", category: "governance", unit: "%", target: 100, direction: "higher_is_better", frequency: "quarterly", calc_mode: "checklist", north_star: true, description: "Measures the percentage of planned business units that completed all pre-pilot framework preparation steps and achieved Ready-for-Pilot status.", formula: "BUs reaching 'Ready for Pilot' status ÷ total planned BUs × 100", data_source: "QMS Platform — per-BU Readiness action plan (7 stages)" },
  { code: "QM-KPI-008", name: "BU Pilot Validation Completion Rate", owner_type: "quality_manager", owner_name: "Sarah Hijazi", category: "governance", unit: "%", target: 100, direction: "higher_is_better", frequency: "quarterly", calc_mode: "checklist", north_star: true, description: "Measures the percentage of planned pilot-ready business units that completed pilot validation — pilot execution, reporting, and action planning.", formula: "Pilot-Ready BUs Completing Pilot Validation ÷ Total Quarterly Pilot-Planned BUs × 100", data_source: "QMS Platform — per-BU Pilot Validation action plan (5 stages)" },
  { code: "QM-KPI-009", name: "Repeat Findings Rate", owner_type: "quality_manager", owner_name: "Sarah Hijazi", category: "audit", unit: "%", target: 10, direction: "lower_is_better", frequency: "quarterly", calc_mode: "manual", description: "Measures the percentage of audit findings that recur from previously identified issues within the defined review period.", formula: "Repeat Findings ÷ Total Findings × 100", data_source: "Audit Report Dashboard" },
  { code: "QM-KPI-012", name: "CAPA Effectiveness Rate", owner_type: "quality_manager", owner_name: "Sarah Hijazi", category: "quality", unit: "%", target: 90, direction: "higher_is_better", frequency: "quarterly", calc_mode: "manual", description: "Measures the percentage of reviewed CAPAs verified effective in preventing recurrence within the effectiveness review period.", formula: "Effective CAPAs ÷ CAPAs reviewed for effectiveness × 100", data_source: "CAPA Register" },
  { code: "QM-KPI-004", name: "QMS Platform Adoption Rate", owner_type: "quality_manager", owner_name: "Sarah Hijazi", category: "quality", unit: "%", target: 70, direction: "higher_is_better", frequency: "quarterly", calc_mode: "checklist", description: "Measures the percentage of in-scope GRQ work activities (audit plans, findings, CAPAs, policies, risk actions, handoffs, approvals, evidence) created, tracked, updated and closed within the platform.", formula: "GRQ activities managed in platform ÷ total GRQ activities in scope × 100", data_source: "QMS Platform" },

  // ───────────── GRC — Maram AlHarbi (10) ─────────────
  { code: "GRC-KPI-008", name: "Compliance Coverage Index", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "compliance", unit: "%", target: 95, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", north_star: true, description: "Measures the percentage of identified compliance obligations (clauses/articles) mapped to defined controls, owners, and evidence requirements.", formula: "Mapped Obligations ÷ Total Obligations × 100", data_source: "Compliance Register" },
  { code: "GRC-KPI-003", name: "Audit / Certification Evidence Readiness", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "audit", unit: "%", target: 95, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", north_star: true, description: "Measures the percentage of required evidence items available, approved, and audit-ready within the defined audit/certification window.", formula: "Ready Evidence Items ÷ Required Evidence Items × 100", data_source: "Evidence Repository" },
  { code: "GRC-KPI-005", name: "Risk Treatment On-Time Closure", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "risk", unit: "%", target: 90, direction: "higher_is_better", frequency: "monthly", calc_mode: "auto", north_star: true, description: "Measures the percentage of due risk treatment actions closed within the approved target date.", formula: "Closed On Time ÷ Total Treatments Due × 100", data_source: "Risk Register" },
  { code: "GRC-KPI-002", name: "Certification Milestones On Track", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "compliance", unit: "%", target: 100, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", description: "Measures the percentage of planned certification, regulatory, and compliance roadmap milestones achieved within the approved timeline.", formula: "Achieved Milestones ÷ Planned Milestones × 100", data_source: "Certification Roadmap" },
  { code: "GRC-KPI-012", name: "Regulatory Response Timeliness", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "compliance", unit: "%", target: 90, direction: "higher_is_better", frequency: "monthly", calc_mode: "manual", description: "Measures the percentage of regulatory responses submitted within the defined SLA.", formula: "Responses Within SLA ÷ Total Regulatory Responses × 100", data_source: "Compliance Log" },
  { code: "GRC-KPI-013", name: "Security Incident On-Time Closure Rate", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "compliance", unit: "%", target: 95, direction: "higher_is_better", frequency: "monthly", calc_mode: "manual", description: "Measures the percentage of GRC-scope security incidents closed within the approved target timeline.", formula: "Security Incidents Closed Within Target ÷ Total Due for Closure × 100", data_source: "Incident Register" },
  { code: "GRC-KPI-010", name: "Risk Register Quality Index", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "risk", unit: "%", target: 95, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", description: "Measures the percentage of in-scope BUs with completed risk assessments and register entries that are complete, current, properly owned, and status-valid.", formula: "Valid Assessed BU Risk Records ÷ Total In-Scope BUs × 100", data_source: "Risk Register" },
  { code: "GRC-KPI-009", name: "High-Risk Items With Treatment Plan", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "risk", unit: "%", target: 100, direction: "higher_is_better", frequency: "monthly", calc_mode: "auto", description: "Measures the percentage of identified high-risk items that have an approved treatment plan, owner, and due date.", formula: "High Risks With Plan ÷ Total High Risks × 100", data_source: "Risk Register" },
  { code: "GRC-KPI-014", name: "Third-Party Assessment SLA", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "vendor", unit: "%", target: 90, direction: "higher_is_better", frequency: "quarterly", calc_mode: "manual", description: "Measures the percentage of in-scope third-party, client, and partner security/risk assessments completed within the defined SLA.", formula: "Assessments Completed Within SLA ÷ Total In-Scope Requests × 100", data_source: "Third-Party Assessment Log" },
  { code: "GRC-KPI-006", name: "High-Risk Vendor Findings Closure", owner_type: "grc_manager", owner_name: "Maram AlHarbi", category: "vendor", unit: "%", target: 85, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", description: "Measures the percentage of due high-risk vendor findings closed within the agreed remediation timeline.", formula: "High-Risk Vendor Findings Closed On Time ÷ Total Due × 100", data_source: "Vendor Risk Tracker" },

  // ───────────── GRQ Specialist — AlHanouf (3) ─────────────
  { code: "SPEC-KPI-01", name: "Governance Operations Readiness Index", owner_type: "grq_specialist", owner_name: "AlHanouf", category: "governance", unit: "%", target: 95, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", north_star: true, description: "Measures the overall operational readiness of GRQ support activities across document control and CAPA follow-up discipline.", formula: "Equal-weighted average of supporting KPIs #2–#3 (each 1/2)", data_source: "KPI Dashboard (roll-up)" },
  { code: "SPEC-KPI-02", name: "Documentation Lifecycle Compliance", owner_type: "grq_specialist", owner_name: "AlHanouf", category: "governance", unit: "%", target: 95, direction: "higher_is_better", frequency: "monthly", calc_mode: "manual", description: "Measures the percentage of controlled governance documents reviewed on time according to the approved lifecycle schedule.", formula: "Documents Reviewed On Time ÷ Documents Due × 100", data_source: "Document Master List" },
  { code: "SPEC-KPI-06", name: "CAPA Follow-Up SLA Compliance", owner_type: "grq_specialist", owner_name: "AlHanouf", category: "quality", unit: "%", target: 95, direction: "higher_is_better", frequency: "monthly", calc_mode: "auto", description: "Measures the percentage of due CAPAs followed up within the defined SLA and escalated when overdue.", formula: "CAPAs Followed Up Within SLA ÷ Total Due CAPAs × 100", data_source: "CAPA Register" },

  // ───────────── Legal — Ali Fahad (5) ─────────────
  { code: "LEG-KPI-01", name: "Legal Governance Score", owner_type: "legal_specialist", owner_name: "Ali Fahad", category: "compliance", unit: "%", target: 95, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", north_star: true, description: "Measures overall legal operational performance across contract review timeliness, clause compliance, archiving discipline, and legal action closure.", formula: "Equal-weighted average of Legal KPIs #2–#5 (each 1/4)", data_source: "KPI Dashboard (roll-up)" },
  { code: "LEG-KPI-02", name: "Contract Review SLA", owner_type: "legal_specialist", owner_name: "Ali Fahad", category: "compliance", unit: "%", target: 95, direction: "higher_is_better", frequency: "monthly", calc_mode: "manual", description: "Measures the percentage of in-scope contracts reviewed within the defined SLA, controlling overdue review backlog.", formula: "Contracts Reviewed Within SLA ÷ Total Contracts Due for Review × 100", data_source: "Contract Register" },
  { code: "LEG-KPI-06", name: "Contract Compliance Coverage", owner_type: "legal_specialist", owner_name: "Ali Fahad", category: "compliance", unit: "%", target: 100, direction: "higher_is_better", frequency: "quarterly", calc_mode: "manual", description: "Measures the percentage of reviewed contracts containing all mandatory standard legal clauses required by the organization.", formula: "Contracts With Required Clauses ÷ Total Contracts Reviewed × 100", data_source: "Contract Register" },
  { code: "LEG-KPI-08", name: "Contract Archiving Compliance", owner_type: "legal_specialist", owner_name: "Ali Fahad", category: "compliance", unit: "%", target: 100, direction: "higher_is_better", frequency: "monthly", calc_mode: "manual", description: "Measures the percentage of finalized contracts archived, indexed, and retrievable in the approved repository within the required timeframe.", formula: "Archived Finalized Contracts ÷ Total Finalized Requiring Archive × 100", data_source: "Archive Folder" },
  { code: "LEG-KPI-09", name: "Legal Action Closure Rate", owner_type: "legal_specialist", owner_name: "Ali Fahad", category: "compliance", unit: "%", target: 90, direction: "higher_is_better", frequency: "quarterly", calc_mode: "manual", description: "Measures the percentage of due legal actions closed within the agreed timeline.", formula: "Legal Actions Closed On Time ÷ Total Due Legal Actions × 100", data_source: "Legal Action Log" },

  // ───────────── Shared — GRQ Team (3) ─────────────
  { code: "GRQ-KPI-01", name: "GRQ Health Score", owner_type: "shared", owner_name: "GRQ Team", category: "governance", unit: "%", target: 90, direction: "higher_is_better", frequency: "quarterly", calc_mode: "auto", north_star: true, description: "Measures the overall operational health and performance of the Governance, Risk, Quality and Legal functions through a consolidated achievement score.", formula: "Quality×35% + GRC×35% + GRQ Specialist×15% + Legal×15%", data_source: "KPI Dashboard" },
  { code: "GRQ-KPI-02", name: "Quality ↔ GRC Handoff Effectiveness", owner_type: "shared", owner_name: "GRQ Team", category: "governance", unit: "%", target: 95, direction: "higher_is_better", frequency: "monthly", calc_mode: "manual", description: "Measures the percentage of handoffs between Quality and GRC submitted on time, correctly logged, accepted, and transferred into the required workflow without rework or delay.", formula: "Successful Handoffs ÷ Total Handoffs × 100", data_source: "Handoff Emails" },
  { code: "GRQ-KPI-03", name: "Governance Maturity Score", owner_type: "shared", owner_name: "GRQ Team", category: "governance", unit: "%", target: 85, direction: "higher_is_better", frequency: "annual", calc_mode: "manual", description: "Measures maturity of governance practices against the assessment model.", formula: "Assessment Score ÷ Maximum Score × 100", data_source: "Governance Maturity Assessment" },
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
  logger.info(
    `📋 [KPIDB] Seeded ${FINAL_KPIS.length} final GRQ KPIs; deactivated ${res.rowCount ?? 0} superseded.`,
  );
}
