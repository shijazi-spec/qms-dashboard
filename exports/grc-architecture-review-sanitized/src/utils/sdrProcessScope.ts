/**
 * Product scope for SDR call intelligence vs CRM and governance.
 *
 * - SDR-facing documentation and day-to-day process live in **Five9** (team-owned).
 * - **Five9 Reporting/Web Services API** for automated pull of call lists + recording URLs is **deferred**;
 *   use bulk ingest or manual `POST /api/calls/ingest` until that API work lands.
 * - Quality **target** for deeper programmatic checks is **ExampleOrg SDR Governance v2.1** plus supporting
 *   artifacts (governance PDF, call script, stages/reasons workbook, COPC-style scorecard). Those files
 *   live in your internal Quality repository (e.g. Google Drive); they are not bundled in this repo.
 * - Programmatic checks use **src/config/sdr-governance-2.1.rules.json** plus heuristics in
 *   `callMcpReconciliation.ts`. Edit the JSON when Quality exports rubric lines from PDFs/XLSX.
 */

export const SDR_GOVERNANCE_VERSION = "2.1" as const;

/** Five9 API automation (sync from cloud) — not shipped yet; ingest via other paths meanwhile. */
export const SDR_FIVE9_API_INTEGRATION_STATUS = "deferred" as const;

/** Filenames only (organizational paths vary per workstation / Drive). */
export const SDR_GOVERNANCE_ARTIFACT_NAMES = [
  "WalaPlus_SDR_2.1_04.12.2025_EN.pdf",
  "SDR Call Script_AR [Updated].pdf",
  "WalaPlus_SDR_Stages Reasons_2.1_04.12.2025.xlsx",
  "Five9_SDR_QA_Scorecard_COPC_Template.xlsx",
] as const;

export function getSdrProcessScopeForApi(): {
  governance_version: typeof SDR_GOVERNANCE_VERSION;
  five9_api_integration: typeof SDR_FIVE9_API_INTEGRATION_STATUS;
  sdr_documentation_home: "five9";
  crm_lead_phone_fields: readonly ["Phone", "Mobile"];
  programmatic_checks: {
    implementation: string;
    target_alignment: string;
    governance_artifact_names: readonly string[];
  };
} {
  return {
    governance_version: SDR_GOVERNANCE_VERSION,
    five9_api_integration: SDR_FIVE9_API_INTEGRATION_STATUS,
    sdr_documentation_home: "five9",
    crm_lead_phone_fields: ["Phone", "Mobile"],
    programmatic_checks: {
      implementation: "programmatic_v1_heuristic_plus_sdr_governance_json",
      target_alignment:
        "Tune src/config/sdr-governance-2.1.rules.json from SDR Governance 2.1, call script, stages/reasons matrix, and COPC scorecard exports.",
      governance_artifact_names: [...SDR_GOVERNANCE_ARTIFACT_NAMES],
    },
  };
}
