/**
 * OKR module
 * ==========
 * The 2026 GRQ Objectives & Key Results (Quality + GRC), from
 * "OKRS & KPIs for GRQ Dep.xlsx". Two tables: okr_objectives and
 * okr_key_results. Each Key Result keeps its sheet text (definition,
 * calculation, target, frequency, data source). Where a KR maps to one of the
 * 17 feed KPIs, `kpi_code` is set and the OKR page shows that calculator's live
 * value; otherwise the KR is "pending calculator" (read-only).
 *
 * No calculation logic lives here — the route joins to buildLeadershipKpiFeed()
 * by kpi_code. This module only stores/serves the OKR structure.
 */

import { pool } from "./kpiDatabase";
import { logger } from "./logger";

export interface OkrKeyResult {
  kr_code: string;
  kpi_name: string;
  kpi_code: string | null;
  definition: string;
  calculation: string;
  target_text: string;
  frequency: string;
  data_source: string;
}
export interface OkrObjective {
  objective_code: string;
  team: "quality" | "grc";
  objective: string;
  owner: string;
  key_results: OkrKeyResult[];
}

const SEED: OkrObjective[] = [
  {
    objective_code: "Q-O1",
    team: "quality",
    objective:
      "Deploy Internal Governance & Process Quality Framework across all BUs",
    owner: "Sara (Quality)",
    key_results: [
      { kr_code: "Q-KR1", kpi_name: "QMS Framework Completion", kpi_code: "QM-KPI-015", definition: "Share of planned BU governance frameworks (process/SOP packages) approved and published in QMS.", calculation: "(# Approved Framework Packages ÷ # Planned Framework Packages) × 100", target_text: "100% by Q4", frequency: "Quarterly", data_source: "QMS Governance Library" },
      { kr_code: "Q-KR2", kpi_name: "Governance Training Coverage", kpi_code: "QM-KPI-005", definition: "Coverage of BU staff trained on the governance documents released for their BU.", calculation: "(# Trained Staff ÷ # Target Staff) × 100", target_text: "≥90% by Q4", frequency: "Quarterly", data_source: "LMS / Training Tracker" },
      { kr_code: "Q-KR3", kpi_name: "Governance Adoption Rate", kpi_code: "QM-KPI-004", definition: "Share of audited BUs demonstrating adherence to the latest approved governance documents.", calculation: "(# BUs Passing Adoption Check ÷ # BUs Audited) × 100", target_text: "≥85% by Q4", frequency: "Quarterly", data_source: "Audit Results (QMS)" },
    ],
  },
  {
    objective_code: "Q-O2",
    team: "quality",
    objective: "Execute Internal BU Audit Program at Scale (PPG)",
    owner: "Sara (Quality)",
    key_results: [
      { kr_code: "Q-KR1", kpi_name: "Audit Execution Rate", kpi_code: "QM-KPI-002", definition: "Percent of planned audits completed within the quarter.", calculation: "(# Audits Completed ÷ # Audits Planned) × 100", target_text: "≥95% each quarter", frequency: "Quarterly", data_source: "QMS Audit Calendar" },
      { kr_code: "Q-KR2", kpi_name: "BU Coverage Rate", kpi_code: "QM-KPI-008", definition: "Percent of total BUs audited at least once in the year (or by plan).", calculation: "(# BUs Audited ÷ # Total BUs) × 100", target_text: "100% annual coverage", frequency: "Quarterly/Annual", data_source: "QMS Audit Register" },
      { kr_code: "Q-KR3", kpi_name: "Audit Cycle Time", kpi_code: null, definition: "Average days from audit start to final report issued.", calculation: "Avg(Report Issue Date − Audit Start Date)", target_text: "≤10 business days", frequency: "Monthly", data_source: "QMS Audit Workflow" },
    ],
  },
  {
    objective_code: "Q-O3",
    team: "quality",
    objective: "Close Execution Gaps and Prevent Repeat Findings",
    owner: "Sara (Quality)",
    key_results: [
      { kr_code: "Q-KR1", kpi_name: "Gap Closure Rate", kpi_code: "QM-KPI-003", definition: "Percent of audit findings closed within agreed timeline.", calculation: "(# Findings Closed On-Time ÷ # Total Findings) × 100", target_text: "≥90% monthly", frequency: "Monthly", data_source: "QMS Action Tracker" },
      { kr_code: "Q-KR2", kpi_name: "Repeat Findings Rate", kpi_code: null, definition: "Percent of findings that re-occur in subsequent audits (same theme/category).", calculation: "(# Repeat Findings ÷ # Total Findings) × 100", target_text: "≤10% by Q4", frequency: "Quarterly", data_source: "QMS Findings History" },
      { kr_code: "Q-KR3", kpi_name: "Escalation Reduction (Quality)", kpi_code: null, definition: "Reduction in escalations caused by governance/process non-adherence.", calculation: "(Baseline Escalations − Current Escalations) ÷ Baseline × 100", target_text: "≥20% reduction YoY", frequency: "Quarterly", data_source: "Escalation Log / Ops Tickets" },
    ],
  },
  {
    objective_code: "Q-O4",
    team: "quality",
    objective: "Drive Automation & Waste Reduction via QMS",
    owner: "Sara (Quality)",
    key_results: [
      { kr_code: "Q-KR1", kpi_name: "Automation Coverage (Quality Workflows)", kpi_code: null, definition: "Percent of key quality workflows executed through QMS automation (not email/Excel).", calculation: "(# Automated Quality Workflows ÷ # Key Quality Workflows) × 100", target_text: "≥30% by Q4", frequency: "Quarterly", data_source: "QMS / Automation Logs" },
      { kr_code: "Q-KR2", kpi_name: "Manual Effort Reduction", kpi_code: null, definition: "Reduction in manual effort for audit reporting, tracking, and follow-ups.", calculation: "(Baseline Manual Hours − Current Manual Hours) ÷ Baseline × 100", target_text: "≥30% by Q4", frequency: "Quarterly", data_source: "Time Study / QMS Activity Logs" },
      { kr_code: "Q-KR3", kpi_name: "Operational Waste Reduction (Rework)", kpi_code: null, definition: "Reduction in rework instances linked to process non-compliance.", calculation: "(Baseline Rework − Current Rework) ÷ Baseline × 100", target_text: "≥20% by Q4", frequency: "Quarterly", data_source: "Ops Tickets / QMS" },
    ],
  },
  {
    objective_code: "G-O1",
    team: "grc",
    objective: "Establish Enterprise Risk Visibility and Closure Discipline",
    owner: "Maram (GRC)",
    key_results: [
      { kr_code: "G-KR1", kpi_name: "Risk Assessment Coverage (BUs)", kpi_code: null, definition: "Share of Business Units with completed risk assessment in the year/plan.", calculation: "(# BUs Assessed ÷ # Total BUs) × 100", target_text: "100% by Q4", frequency: "Quarterly", data_source: "Enterprise Risk Register" },
      { kr_code: "G-KR2", kpi_name: "High-Risk Items with Treatment Plan", kpi_code: null, definition: "Share of high/critical risks having an approved mitigation plan and owner.", calculation: "(# High Risks with Plans ÷ # Total High Risks) × 100", target_text: "100% always", frequency: "Monthly", data_source: "Risk Register" },
      { kr_code: "G-KR3", kpi_name: "Risk Treatment On-Time Closure", kpi_code: "GRC-KPI-005", definition: "Share of mitigation actions closed within due dates.", calculation: "(# Treatments Closed On-Time ÷ # Total Treatments Due) × 100", target_text: "≥85% monthly", frequency: "Monthly", data_source: "Risk Action Tracker (QMS)" },
    ],
  },
  {
    objective_code: "G-O2",
    team: "grc",
    objective: "Maintain Continuous Regulatory & Audit Readiness (PDPL, NCA, ISO)",
    owner: "Maram (GRC)",
    key_results: [
      { kr_code: "G-KR1", kpi_name: "Compliance Coverage Index", kpi_code: "GRC-KPI-008", definition: "Coverage of required controls for applicable regulations/standards.", calculation: "(# Controls Implemented ÷ # Controls Required) × 100", target_text: "≥95% by Q4", frequency: "Quarterly", data_source: "Compliance Matrix" },
      { kr_code: "G-KR2", kpi_name: "Audit Evidence Readiness", kpi_code: "GRC-KPI-003", definition: "Share of required audit evidence available and up-to-date.", calculation: "(# Evidence Items Ready ÷ # Evidence Items Required) × 100", target_text: "≥95% by audit windows", frequency: "Quarterly", data_source: "Evidence Repository" },
      { kr_code: "G-KR3", kpi_name: "Certification Milestones On-Track", kpi_code: "GRC-KPI-002", definition: "Delivery of planned certification milestones (surveillance/recert/prep) on schedule.", calculation: "(# Milestones Delivered ÷ # Milestones Planned) × 100", target_text: "100% on-time", frequency: "Quarterly", data_source: "Certification Plan" },
    ],
  },
  {
    objective_code: "G-O3",
    team: "grc",
    objective: "Strengthen Third-Party & Partner Assurance (TPRA)",
    owner: "Maram (GRC)",
    key_results: [
      { kr_code: "G-KR1", kpi_name: "TPRA Coverage Rate (Critical Vendors)", kpi_code: null, definition: "Share of critical vendors/partners assessed and approved annually.", calculation: "(# Critical Vendors Assessed ÷ # Total Critical Vendors) × 100", target_text: "≥95% by Q4", frequency: "Quarterly", data_source: "TPRA Tracker" },
      { kr_code: "G-KR2", kpi_name: "Client/Partner Security Assessment SLA", kpi_code: null, definition: "Share of external security questionnaires delivered within agreed SLA.", calculation: "(# Assessments Delivered On-Time ÷ # Total Assessments) × 100", target_text: "≥90% monthly", frequency: "Monthly", data_source: "Assessment Tracker" },
      { kr_code: "G-KR3", kpi_name: "High-Risk Vendor Findings Closure", kpi_code: null, definition: "Share of high-risk vendor findings closed within agreed timeline.", calculation: "(# Vendor Findings Closed ÷ # High-Risk Vendor Findings) × 100", target_text: "≥85% quarterly", frequency: "Quarterly", data_source: "Vendor Findings Log" },
    ],
  },
  {
    objective_code: "G-O4",
    team: "grc",
    objective: "Strengthen Incident Governance & External Trust",
    owner: "Maram (GRC)",
    key_results: [
      { kr_code: "G-KR1", kpi_name: "Regulatory Response Timeliness", kpi_code: null, definition: "Average days to respond to regulatory or official compliance requests.", calculation: "Avg(Response Date − Request Date)", target_text: "≤5 business days (avg)", frequency: "Monthly", data_source: "Regulatory Log" },
      { kr_code: "G-KR2", kpi_name: "Security Incident Governance Closure Time", kpi_code: null, definition: "Average days from incident identification to governance closure (incl. evidence and lessons learned).", calculation: "Avg(Closure Date − Incident Date)", target_text: "≤30 days", frequency: "Quarterly", data_source: "Incident Register" },
      { kr_code: "G-KR3", kpi_name: "Policy Review Compliance", kpi_code: null, definition: "Share of policies reviewed/updated within scheduled review cycle.", calculation: "(# Policies Reviewed On-Time ÷ # Policies Due) × 100", target_text: "≥95% by Q4", frequency: "Quarterly", data_source: "Policy Library" },
    ],
  },
];

export async function initOkrTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS okr_objectives (
      id SERIAL PRIMARY KEY,
      objective_code VARCHAR(20) UNIQUE NOT NULL,
      team VARCHAR(20) NOT NULL,
      objective TEXT NOT NULL,
      owner VARCHAR(100),
      sort_order INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS okr_key_results (
      id SERIAL PRIMARY KEY,
      objective_code VARCHAR(20) NOT NULL REFERENCES okr_objectives(objective_code) ON DELETE CASCADE,
      kr_code VARCHAR(20) NOT NULL,
      kpi_name VARCHAR(255) NOT NULL,
      kpi_code VARCHAR(20),
      definition TEXT,
      calculation TEXT,
      target_text VARCHAR(120),
      frequency VARCHAR(40),
      data_source VARCHAR(255),
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(objective_code, kr_code)
    )
  `);

  const existing = await pool.query("SELECT COUNT(*)::int AS n FROM okr_objectives");
  if ((existing.rows[0]?.n ?? 0) === 0) {
    logger.info("🌱 [OKR] Seeding GRQ 2026 OKRs...");
    for (let oi = 0; oi < SEED.length; oi++) {
      const o = SEED[oi];
      await pool.query(
        `INSERT INTO okr_objectives (objective_code, team, objective, owner, sort_order)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (objective_code) DO NOTHING`,
        [o.objective_code, o.team, o.objective, o.owner, oi],
      );
      for (let ki = 0; ki < o.key_results.length; ki++) {
        const k = o.key_results[ki];
        await pool.query(
          `INSERT INTO okr_key_results
             (objective_code, kr_code, kpi_name, kpi_code, definition, calculation, target_text, frequency, data_source, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (objective_code, kr_code) DO NOTHING`,
          [o.objective_code, k.kr_code, k.kpi_name, k.kpi_code, k.definition, k.calculation, k.target_text, k.frequency, k.data_source, ki],
        );
      }
    }
    logger.info("✅ [OKR] Seeded 8 objectives / 24 key results");
  }

  // Phase-2: link the 14 previously-"pending" KRs to their new calculator codes
  // (idempotent — runs every boot; only writes when changed).
  const KR_KPI_MAP: Array<[string, string, string]> = [
    ["Q-O2", "Q-KR3", "QM-KPI-009"],
    ["Q-O3", "Q-KR2", "QM-KPI-010"],
    ["Q-O3", "Q-KR3", "QM-KPI-011"],
    ["Q-O4", "Q-KR1", "QM-KPI-012"],
    ["Q-O4", "Q-KR2", "QM-KPI-013"],
    ["Q-O4", "Q-KR3", "QM-KPI-014"],
    ["G-O1", "G-KR1", "GRC-KPI-009"],
    ["G-O1", "G-KR2", "GRC-KPI-010"],
    ["G-O3", "G-KR1", "GRC-KPI-011"],
    ["G-O3", "G-KR2", "GRC-KPI-012"],
    ["G-O3", "G-KR3", "GRC-KPI-013"],
    ["G-O4", "G-KR1", "GRC-KPI-014"],
    ["G-O4", "G-KR2", "GRC-KPI-015"],
    ["G-O4", "G-KR3", "GRC-KPI-016"],
  ];
  for (const [oc, kc, code] of KR_KPI_MAP) {
    await pool.query(
      `UPDATE okr_key_results SET kpi_code = $1, updated_at = NOW()
       WHERE objective_code = $2 AND kr_code = $3 AND (kpi_code IS NULL OR kpi_code <> $1)`,
      [code, oc, kc],
    );
  }
}

export async function getOkrs(): Promise<OkrObjective[]> {
  const objs = await pool.query(
    `SELECT objective_code, team, objective, owner FROM okr_objectives WHERE is_active ORDER BY sort_order, objective_code`,
  );
  const krs = await pool.query(
    `SELECT objective_code, kr_code, kpi_name, kpi_code, definition, calculation, target_text, frequency, data_source
     FROM okr_key_results ORDER BY objective_code, sort_order, kr_code`,
  );
  return objs.rows.map((o: any) => ({
    objective_code: o.objective_code,
    team: o.team,
    objective: o.objective,
    owner: o.owner,
    key_results: krs.rows.filter((k: any) => k.objective_code === o.objective_code),
  }));
}
