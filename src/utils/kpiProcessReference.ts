/**
 * KPI → the controlled process document (and clause) it is measured against.
 *
 * A KPI detail page that cannot name its process is unauditable: the reader has
 * no way to check that the threshold being enforced is the one the SOP actually
 * states. This is the single place that mapping lives.
 *
 * Two rules, both learned the hard way and both worth keeping:
 *
 * 1. NEVER cite a clause the document does not carry for that KPI. A plausible
 *    reference an auditor cannot trace is worse than a blank field — it looks
 *    like evidence and isn't. Codes with no mapping return null and the panel
 *    renders nothing.
 * 2. Where the clause detail already exists in code, DERIVE from it rather than
 *    retyping it. The Sales entries read their SLA text straight out of
 *    salesStageSlaSpec, which is what the stage-aging KPI actually enforces, so
 *    the citation moves with the rule instead of rotting into a stale quote.
 */
import {
  SALES_SOP_DOCUMENT,
  SALES_STAGE_SLA_SPEC,
  getStageSlaSpec,
  describeSla,
  type StageSlaSpec,
} from "./salesStageSlaSpec";

export interface KpiProcessReference {
  document: string;
  /** The section of the document that defines this KPI, when known. */
  section?: string;
  clauses: Array<{ stage: string; sla: string }>;
}

/**
 * Customer Success Management Process — filed in Document Control 2026-08-18 as
 * WP-BU-CS-SOP-003. Its §8 defines the 33 CS KPIs in three tiers, and §9 is the
 * SLA table that CS-KPI-25 measures adherence against.
 */
export const CS_SOP_DOCUMENT = {
  title: "Customer Success Management Process",
  reference: "WP-BU-CS-SOP-003",
  issued: "13.08.2026",
  version: "1.1",
} as const;

/**
 * CS KPI code → the section of WP-BU-CS-SOP-003 that DEFINES it.
 *
 * Deliberately a section, not a clause. §8's KPI tables carry no per-KPI clause
 * reference, so naming one would be inventing it. The section is exact: these
 * ranges are the order the KPIs appear in the document's own tables.
 */
function csSection(code: string): string | null {
  const m = /^CS-KPI-(\d{2})$/.exec(code);
  if (!m) return null;
  const n = Number(m[1]);
  if (n >= 1 && n <= 8) return "8.1 Individual KPIs";
  if (n >= 9 && n <= 22) return "8.2 Process KPIs";
  if (n >= 23 && n <= 33) return "8.3 Governance KPIs";
  return null;
}

/**
 * CS KPIs that additionally measure against the §9 SLA table rather than only
 * being defined in §8. Only SLA / Milestone Adherence qualifies: §9 IS the list
 * of timeframes it grades, which is why the KPI exists.
 */
const CS_SLA_TABLE_CODES = new Set(["CS-KPI-25"]);

/**
 * Sales KPI code → the SOP stages it grades. Only the three the spec actually
 * covers. Win rate, document compliance, CRM accuracy, follow-up, first-contact
 * and duplicates have no clause in the Sales SOP.
 */
const SALES_KPI_TO_STAGES: Record<string, string[] | "all"> = {
  "SALES-KPI-01": "all",
  "SALES-KPI-03": ["Proposal"],
  "SALES-KPI-04": ["Agreement Sent"],
};

function salesReference(code: string): KpiProcessReference | null {
  const want = SALES_KPI_TO_STAGES[code];
  if (!want) return null;
  const specs =
    want === "all"
      ? SALES_STAGE_SLA_SPEC
      : want
          .map((s) => getStageSlaSpec(s))
          .filter((s): s is StageSlaSpec => s !== null);
  if (specs.length === 0) return null;
  const d = SALES_SOP_DOCUMENT;
  return {
    document: `${d.title} (${d.reference}, ${d.issued})`,
    clauses: specs.map((s) => ({ stage: s.stage, sla: describeSla(s) })),
  };
}

function csReference(code: string): KpiProcessReference | null {
  const section = csSection(code);
  if (!section) return null;
  const d = CS_SOP_DOCUMENT;
  const ref: KpiProcessReference = {
    document: `${d.title} (${d.reference} v${d.version}, ${d.issued})`,
    section,
    clauses: [],
  };
  if (CS_SLA_TABLE_CODES.has(code)) {
    ref.clauses.push({
      stage: "Service Level Agreements",
      sla: "Section 9 — the timeframes this KPI grades adherence against",
    });
  }
  return ref;
}

export function getKpiProcessReference(code: string): KpiProcessReference | null {
  return salesReference(code) ?? csReference(code);
}
