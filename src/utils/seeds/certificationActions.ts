/**
 * Certification Actions — GRQ-PLAN-2026-01 v3.0, §3.1 "Full action mapping".
 *
 * Breaks the 7 plan milestones (+ 2 Technology dependencies) in
 * certificationMilestonePlan.ts into the 23 checkable actions the document
 * actually lists. `action_text`, `owner` and the evidence description are
 * transcribed VERBATIM from the approved plan — do not paraphrase.
 *
 * `verification_mode` only ever stores `auto` or `manual`. The spec's third
 * class, `auto (awaiting data)`, is a RUNTIME resolution state (the query and
 * table exist but the table is empty today) computed by the evidence
 * resolver at read time — see spec §3 and §4.2 — never a seed-time
 * classification, so every `auto (awaiting data)` row in §3.1 seeds here as
 * plain `auto`.
 *
 * `evidence_source` is the short identifier the evidence resolver's
 * dispatcher switches on (spec §4.2), not the prose description in §3.1's
 * "Evidence source" column — that description is reproduced in comments
 * next to each row for traceability back to the document.
 *
 * This module is PURE: no pool, no db import. northStarSources.ts inserts
 * these rows and stamps them with the existing PLAN_VERSION / SOURCE_DOC
 * provenance constants from certificationMilestonePlan.ts.
 */

export interface ActionSeed {
  action_key: string;
  milestone_key: string;
  sort_order: number;
  action_text: string;
  owner: string;
  verification_mode: "auto" | "manual";
  evidence_source: string | null;
}

export const CERTIFICATION_ACTIONS: ActionSeed[] = [
  // ── Milestone 1 — By 30 Aug 2026 · Document Library · GRC ────────────────
  {
    action_key: "ACT-2026-08-DOCS-01",
    milestone_key: "PLAN-2026-08-DOCS",
    sort_order: 1,
    action_text: "Remaining document batches released",
    owner: "GRC",
    verification_mode: "auto",
    // `policies` JOIN `policy_files` — documents with retrievable bytes ÷
    // register total. Never use `file_name IS NOT NULL` (metadata outlives
    // the bytes, policyDatabase.ts:472).
    evidence_source: "policies.retrievable_ratio",
  },
  {
    action_key: "ACT-2026-08-DOCS-02",
    milestone_key: "PLAN-2026-08-DOCS",
    sort_order: 2,
    action_text: "Identified gaps closed",
    owner: "GRC",
    verification_mode: "auto",
    // qms_uploaded_documents WHERE extraction_status='placeholder' = 0
    evidence_source: "qms_uploaded_documents.placeholder_count",
  },

  // ── Milestone 2 — Sep 2026 · Document Library / SACS-002 · GRC, Alhanouf ─
  {
    action_key: "ACT-2026-09-APPROVE-01",
    milestone_key: "PLAN-2026-09-APPROVE",
    sort_order: 1,
    action_text: "Library approved",
    owner: "GRC, Alhanouf",
    verification_mode: "auto",
    // policies WHERE compliance_approved IS TRUE ÷ total
    evidence_source: "policies.compliance_approved_ratio",
  },
  {
    action_key: "ACT-2026-09-APPROVE-02",
    milestone_key: "PLAN-2026-09-APPROVE",
    sort_order: 2,
    action_text: "…and signed",
    owner: "GRC, Alhanouf",
    verification_mode: "manual",
    // No signature capability exists in the platform (spec §8). Manual tick
    // + evidence document.
    evidence_source: null,
  },
  {
    action_key: "ACT-2026-09-APPROVE-03",
    milestone_key: "PLAN-2026-09-APPROVE",
    sort_order: 3,
    action_text: "Document codes updated",
    owner: "GRC, Alhanouf",
    verification_mode: "auto",
    // doc_tracker_documents.code_ok; check doc_tracker_collectors.health_state
    // first — stale collector => report "not collected", not 0.
    evidence_source: "doc_tracker_documents.code_ok",
  },
  {
    action_key: "ACT-2026-09-APPROVE-04",
    milestone_key: "PLAN-2026-09-APPROVE",
    sort_order: 4,
    action_text: "SACS-002 recertification progressed",
    owner: "GRC, Alhanouf",
    verification_mode: "manual",
    // External certification body.
    evidence_source: null,
  },
  {
    action_key: "ACT-2026-09-APPROVE-05",
    milestone_key: "PLAN-2026-09-APPROVE",
    sort_order: 5,
    action_text: "Surveillance audit date confirmed with Bureau Veritas",
    owner: "GRC, Alhanouf",
    verification_mode: "auto",
    // external_audits WHERE kind='surveillance' AND certification_body ILIKE
    // '%bureau veritas%' AND planned_date IS NOT NULL
    evidence_source: "external_audits.surveillance_bv_planned",
  },
  {
    action_key: "ACT-2026-09-APPROVE-06",
    milestone_key: "PLAN-2026-09-APPROVE",
    sort_order: 6,
    action_text: "HyperPay attestation + responsibility matrix obtained",
    owner: "GRC, Alhanouf",
    verification_mode: "manual",
    // Third-party document; evidence link.
    evidence_source: null,
  },

  // ── Milestone 3 — Oct 2026 · PCI DSS · GRC, HR, Technology ───────────────
  {
    action_key: "ACT-2026-10-SAQA-01",
    milestone_key: "PLAN-2026-10-SAQA",
    sort_order: 1,
    action_text: "SAQ A completed and signed",
    owner: "GRC, HR, Technology",
    verification_mode: "manual",
    // Evidence document.
    evidence_source: null,
  },
  {
    action_key: "ACT-2026-10-SAQA-02",
    milestone_key: "PLAN-2026-10-SAQA",
    sort_order: 2,
    action_text: "SAQ A submitted to both acquirers",
    owner: "GRC, HR, Technology",
    verification_mode: "manual",
    // Evidence document.
    evidence_source: null,
  },
  {
    action_key: "ACT-2026-10-SAQA-03",
    milestone_key: "PLAN-2026-10-SAQA",
    sort_order: 3,
    action_text: "Awareness training delivered and recorded",
    owner: "GRC, HR, Technology",
    verification_mode: "auto",
    // training_records (qmsDatabase.ts) — empty today.
    evidence_source: "training_records.count",
  },
  {
    action_key: "ACT-2026-10-SAQA-04",
    milestone_key: "PLAN-2026-10-SAQA",
    sort_order: 4,
    action_text: "Evidence pack assembled",
    owner: "GRC, HR, Technology",
    verification_mode: "auto",
    // evidence_records (evidenceDatabase.ts) — empty today.
    evidence_source: "evidence_records.count",
  },

  // ── Milestone 4 — Nov 2026 · ISO 27001 / PDPL · GRQ ──────────────────────
  {
    action_key: "ACT-2026-11-AUDIT-01",
    milestone_key: "PLAN-2026-11-AUDIT",
    sort_order: 1,
    action_text: "Internal audit run against ISO 27001 and PDPL",
    owner: "GRQ",
    verification_mode: "auto",
    // audit_runs (auditProgrammeDatabase.ts) — empty today.
    evidence_source: "audit_runs.count",
  },
  {
    action_key: "ACT-2026-11-AUDIT-02",
    milestone_key: "PLAN-2026-11-AUDIT",
    sort_order: 2,
    action_text: "Findings raised and corrective actions opened",
    owner: "GRQ",
    verification_mode: "auto",
    // nonconformance_records + capa_records (qmsDatabase.ts)
    evidence_source: "nonconformance_capa.count",
  },

  // ── Milestone 5 — Dec 2026 · PDPL · Head of GRQ ──────────────────────────
  {
    action_key: "ACT-2026-12-MGMTREV-01",
    milestone_key: "PLAN-2026-12-MGMTREV",
    sort_order: 1,
    action_text: "Management review held and minuted",
    owner: "Head of GRQ",
    verification_mode: "auto",
    // management_reviews (managementReviewDatabase.ts:88)
    evidence_source: "management_reviews.count",
  },
  {
    action_key: "ACT-2026-12-MGMTREV-02",
    milestone_key: "PLAN-2026-12-MGMTREV",
    sort_order: 2,
    action_text: "Risk assessment refreshed",
    owner: "Head of GRQ",
    verification_mode: "auto",
    // enterprise_risks.last_review_date within the quarter, or a
    // risk_assessment_history row.
    evidence_source: "enterprise_risks.last_review_date",
  },
  {
    action_key: "ACT-2026-12-MGMTREV-03",
    milestone_key: "PLAN-2026-12-MGMTREV",
    sort_order: 3,
    action_text: "Treatment plan approved",
    owner: "Head of GRQ",
    verification_mode: "auto",
    // enterprise_risks WHERE treatment_strategy IS NOT NULL ÷ open risks
    evidence_source: "enterprise_risks.treatment_strategy_ratio",
  },

  // ── Milestone 6 — Jan 2027 · ISO 27001 · Technology, GRC ─────────────────
  {
    action_key: "ACT-2027-01-PENTEST-01",
    milestone_key: "PLAN-2027-01-PENTEST",
    sort_order: 1,
    action_text: "Penetration test report filed",
    owner: "Technology, GRC",
    verification_mode: "auto",
    // evidence_records of the pen-test type.
    evidence_source: "evidence_records.pentest",
  },
  {
    action_key: "ACT-2027-01-PENTEST-02",
    milestone_key: "PLAN-2027-01-PENTEST",
    sort_order: 2,
    action_text: "Readiness check against clauses 9.2 and 9.3",
    owner: "Technology, GRC",
    verification_mode: "auto",
    // obligation_documents coverage of the ISO-27001 obligations whose
    // obligation_code matches 9.2 / 9.3.
    evidence_source: "obligation_documents.iso27001_9_2_9_3",
  },

  // ── Milestone 7 — Feb 2027 · ISO 27001 · Bureau Veritas ──────────────────
  {
    action_key: "ACT-2027-02-SURV-01",
    milestone_key: "PLAN-2027-02-SURV",
    sort_order: 1,
    action_text: "Surveillance audit conducted by Bureau Veritas",
    owner: "Bureau Veritas",
    verification_mode: "auto",
    // external_audits row for that audit marked complete.
    evidence_source: "external_audits.surveillance_complete",
  },
  {
    action_key: "ACT-2027-02-SURV-02",
    milestone_key: "PLAN-2027-02-SURV",
    sort_order: 2,
    action_text: "Certification maintained",
    owner: "Bureau Veritas",
    verification_mode: "auto",
    // external_audit_certificates with an unexpired expiry_date for ISO 27001.
    evidence_source: "external_audit_certificates.unexpired",
  },

  // ── Dependencies — Technology (both manual; answers owed by another dept)─
  {
    action_key: "ACT-DEP-TECH-ANSWERS-01",
    milestone_key: "DEP-TECH-ANSWERS",
    sort_order: 1,
    action_text:
      "Confirm the HyperPay redirect is complete without exception, and what identifier the transaction export returns",
    owner: "Technology",
    verification_mode: "manual",
    evidence_source: null,
  },
  {
    action_key: "ACT-DEP-TECH-EVIDENCE-01",
    milestone_key: "DEP-TECH-EVIDENCE",
    sort_order: 1,
    action_text:
      "Supply pen-test report, access reviews, log samples, configuration baselines, backup/restore results, vulnerability scan output, and name a responsible person",
    owner: "Technology",
    verification_mode: "manual",
    evidence_source: null,
  },
];
