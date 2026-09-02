/**
 * Certification Milestone Plan — GRQ-PLAN-2026-01 v3.0 (24 Aug 2026).
 *
 * Mirrors the approved Word document. Three sections are stored, typed:
 *   - "plan"             §4 The plan            -> the ONLY rows that score GRC-KPI-002
 *   - "framework_target" §2 When we are compliant
 *   - "dependency"       §5 What we need from other departments
 *
 * Month-only labels in the document become end-of-month dates. The single
 * explicit date ("By 30 Aug 2026") is kept verbatim.
 */

export const PLAN_VERSION = "3.0";
export const SOURCE_DOC = "GRQ-PLAN-2026-01";

export type MilestoneType = "plan" | "framework_target" | "dependency";

export interface PlanMilestoneSeed {
  milestone_key: string;
  milestone_type: MilestoneType;
  /** Free-text label shown in the UI. */
  certification: string;
  /** regulations.regulation_code, or null when the row is not framework-specific. */
  regulation_code: string | null;
  milestone_name: string;
  /** ISO date, or null when the plan sets no date. */
  planned_date: string | null;
  owner: string;
  notes: string;
}

export const CERTIFICATION_MILESTONE_PLAN: PlanMilestoneSeed[] = [
  // ── §4 The plan — these drive the KPI ──────────────────────────────────
  {
    milestone_key: "PLAN-2026-08-DOCS",
    milestone_type: "plan",
    certification: "Document Library",
    regulation_code: null,
    milestone_name: "All documents complete; remaining batches released, gaps closed",
    planned_date: "2026-08-30",
    owner: "GRC",
    notes: "Completion of the document library is not compliance on its own.",
  },
  {
    milestone_key: "PLAN-2026-09-APPROVE",
    milestone_type: "plan",
    certification: "Document Library",
    regulation_code: null,
    milestone_name:
      "Library approved and signed; document codes updated; SACS-002 recertification progressed; surveillance audit date confirmed with Bureau Veritas; HyperPay attestation and responsibility matrix obtained",
    planned_date: "2026-09-30",
    owner: "GRC, Alhanouf",
    notes: "Documents must be approved before staff can be trained on them.",
  },
  {
    milestone_key: "PLAN-2026-10-SAQA",
    milestone_type: "plan",
    certification: "PCI DSS",
    regulation_code: "PCI-DSS",
    milestone_name:
      "SAQ A completed, signed and submitted to both acquirers; awareness training delivered and recorded; Technology assembles the evidence pack",
    planned_date: "2026-10-31",
    owner: "GRC, HR, Technology",
    notes: "Training has to land in October so the November audit is worth running.",
  },
  {
    milestone_key: "PLAN-2026-11-AUDIT",
    milestone_type: "plan",
    certification: "ISO 27001 / PDPL",
    regulation_code: "ISO-27001",
    milestone_name:
      "First internal audit against ISO 27001 and PDPL; findings raised and corrective actions opened",
    planned_date: "2026-11-30",
    owner: "GRQ",
    notes: "The audit must happen before the management review.",
  },
  {
    milestone_key: "PLAN-2026-12-MGMTREV",
    milestone_type: "plan",
    certification: "PDPL",
    regulation_code: "PDPL",
    milestone_name:
      "Management review held and minuted; risk assessment refreshed and treatment plan approved",
    planned_date: "2026-12-31",
    owner: "Head of GRQ",
    notes: "PDPL position becomes defensible at this point.",
  },
  {
    milestone_key: "PLAN-2027-01-PENTEST",
    milestone_type: "plan",
    certification: "ISO 27001",
    regulation_code: "ISO-27001",
    milestone_name:
      "Penetration test report filed; readiness check against clauses 9.2 and 9.3",
    planned_date: "2027-01-31",
    owner: "Technology, GRC",
    notes: "",
  },
  {
    milestone_key: "PLAN-2027-02-SURV",
    milestone_type: "plan",
    certification: "ISO 27001",
    regulation_code: "ISO-27001",
    milestone_name: "Surveillance audit by Bureau Veritas; certification maintained",
    planned_date: "2027-02-28",
    owner: "Bureau Veritas",
    notes: "",
  },

  // ── §2 When we can say we are compliant ────────────────────────────────
  {
    milestone_key: "FT-SACS002",
    milestone_type: "framework_target",
    certification: "SACS-002 (Saudi Aramco)",
    regulation_code: "SACS-002",
    milestone_name: "Compliant from September 2026 — recertification completed",
    planned_date: "2026-09-30",
    owner: "GRC",
    notes: "Status now: certificate lapsed 5 Feb 2026.",
  },
  {
    milestone_key: "FT-PCIDSS",
    milestone_type: "framework_target",
    certification: "PCI DSS v4.0.1",
    regulation_code: "PCI-DSS",
    milestone_name:
      "Compliant from October 2026 — SAQ A completed and signed, HyperPay attestation held, submitted to both acquirers",
    planned_date: "2026-10-31",
    owner: "GRC",
    notes:
      "Status now: in scope as a merchant, never validated. SAQ A holds only if HyperPay returns a token, not a card number.",
  },
  {
    milestone_key: "FT-PDPL",
    milestone_type: "framework_target",
    certification: "PDPL",
    regulation_code: "PDPL",
    milestone_name:
      "Compliant from December 2026 — library closed, staff trained, internal audit done, findings closed",
    planned_date: "2026-12-31",
    owner: "GRC",
    notes: "Status now: documents nearly complete.",
  },
  {
    milestone_key: "FT-ISO27001",
    milestone_type: "framework_target",
    certification: "ISO/IEC 27001:2022",
    regulation_code: "ISO-27001",
    milestone_name: "Compliant from February 2027 — surveillance audit passed",
    planned_date: "2027-02-28",
    owner: "GRC",
    notes: "Status now: certified since Feb 2026.",
  },
  {
    milestone_key: "FT-NCA-ECC",
    milestone_type: "framework_target",
    certification: "NCA Essential Cybersecurity Controls",
    regulation_code: "NCA-ECC",
    milestone_name:
      "Compliant from April 2027 — applicable controls written into the documents and self-assessed",
    planned_date: "2027-04-30",
    owner: "GRC",
    notes:
      "Status now: mapped, applicability unconfirmed. The plan lists NCA as one line; the platform splits it into ECC and DCC.",
  },
  {
    milestone_key: "FT-NCA-DCC",
    milestone_type: "framework_target",
    certification: "NCA Data Cybersecurity Controls",
    regulation_code: "NCA-DCC",
    milestone_name:
      "Compliant from April 2027 — applicable controls written into the documents and self-assessed",
    planned_date: "2027-04-30",
    owner: "GRC",
    notes:
      "Status now: mapped, applicability unconfirmed. The plan lists NCA as one line; the platform splits it into ECC and DCC.",
  },
  {
    milestone_key: "FT-SOC2",
    milestone_type: "framework_target",
    certification: "SOC 2",
    regulation_code: "SOC2",
    milestone_name: "Target date not set in plan v3.0",
    planned_date: null,
    owner: "GRC",
    notes:
      "SOC 2 is named in the plan introduction but has no row in the section 2 table. Date to be set in v4.0.",
  },

  // ── §5 What we need from other departments ─────────────────────────────
  {
    milestone_key: "DEP-TECH-ANSWERS",
    milestone_type: "dependency",
    certification: "PCI DSS",
    regulation_code: "PCI-DSS",
    milestone_name:
      "Technology — answers: is the redirect to HyperPay complete without exception, and what identifier does the transaction export actually return?",
    planned_date: "2026-09-30",
    owner: "Technology",
    notes: "These two answers set the PCI position (SAQ A versus a far larger self-assessment).",
  },
  {
    milestone_key: "DEP-TECH-EVIDENCE",
    milestone_type: "dependency",
    certification: "ISO 27001 / PDPL",
    regulation_code: "ISO-27001",
    milestone_name:
      "Technology — evidence: penetration test report, access reviews, log samples, configuration baselines, backup and restore test results, vulnerability scan output, plus a named person responsible for supplying it",
    planned_date: "2026-10-31",
    owner: "Technology",
    notes:
      "GRC produces documents, not evidence. From October every milestone depends on material other departments hold — the largest risk to these dates.",
  },
];

/**
 * Attach regulation ids to seed rows. A code the platform does not have yet
 * resolves to null rather than dropping the row — the milestone still matters
 * even when its framework record is missing.
 */
export function resolveMilestoneRegulationIds(
  rows: PlanMilestoneSeed[],
  idByCode: Record<string, number>,
): Array<PlanMilestoneSeed & { regulation_id: number | null }> {
  return rows.map((r) => ({
    ...r,
    regulation_id:
      r.regulation_code !== null && idByCode[r.regulation_code] !== undefined
        ? idByCode[r.regulation_code]
        : null,
  }));
}
