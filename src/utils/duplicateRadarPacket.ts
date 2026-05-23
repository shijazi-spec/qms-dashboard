/**
 * Per-owner Remediation Packet (R2) — XLSX builder.
 *
 * Hands a CRM record owner a self-contained 4-sheet workbook that explains:
 *   - WHAT they own (Cover: metrics + RAG + due-by + escalation path)
 *   - WHAT to do for each cluster (Action Items: 5 playbook columns + id info)
 *   - The full record dump (Raw Records: every duplicate row, no playbook noise)
 *   - The standing answers (FAQ: 7 entries; tone is "I'm new to this packet")
 *
 * Packet "due-by" reuses the R1 playbook tier thresholds (high=7 / med=14 /
 * low=30 days) — we pick the EARLIEST of the owner's clusters so an owner
 * with a single critical cluster doesn't think they have 30 days.
 */

import {
  PLAYBOOK_XLSX_COLUMNS,
  emptyPlaybookState,
  startCluster,
  rowPlaybook,
  dueDate,
  getConfidenceTier,
} from "./duplicateRadarPlaybook";
import type { OwnerAccountability, PacketSettings } from "./duplicateRadarDatabase";

export interface PacketBuildInputs {
  owner: OwnerAccountability;
  settings: PacketSettings;
  // Rows for Action Items + Raw Records sheets. Pre-sorted by cluster_id,
  // is_primary DESC so startCluster()/rowPlaybook() can be threaded through.
  records: Array<Record<string, unknown>>;
  // Distinct cluster_confidence_score values for the owner's clusters, used
  // to compute the packet's earliest-tier due date.
  clusterConfidences: number[];
  now?: Date;
}

/**
 * The packet-level "due by" is the EARLIEST of the owner's clusters.
 * If the owner has at least one high-confidence cluster they get 7d;
 * otherwise medium → 14d, otherwise 30d. Avoids the surprise of an owner
 * thinking they have 30d when one of their clusters is revenue-critical.
 */
export function packetDueDate(
  clusterConfidences: number[],
  now?: Date,
): string {
  if (clusterConfidences.length === 0) {
    return dueDate({ cluster_confidence: null, now });
  }
  const tiers = clusterConfidences.map(getConfidenceTier);
  if (tiers.includes("high")) {
    return dueDate({ cluster_confidence: 95, now });
  }
  if (tiers.includes("medium")) {
    return dueDate({ cluster_confidence: 75, now });
  }
  return dueDate({ cluster_confidence: 30, now });
}

/**
 * Cover sheet: owner-scoped metrics + meta. Two-column key/value layout so
 * a non-technical reader scans it top-to-bottom in seconds.
 */
function buildCoverSheet(input: PacketBuildInputs) {
  const { owner, settings, now } = input;
  const due = packetDueDate(input.clusterConfidences, now);
  const generated = (now ?? new Date()).toISOString();
  const ragLabel =
    owner.rag_status === "red"
      ? "Red — duplicate rate >5%"
      : owner.rag_status === "amber"
        ? "Amber — duplicate rate 2-5%"
        : "Green — duplicate rate ≤2%";

  return {
    name: "Cover",
    columns: [
      { header: "Field", key: "field", width: 30 },
      { header: "Value", key: "value", width: 60 },
    ],
    rows: [
      { field: "Owner", value: owner.owner_name },
      { field: "Owner email", value: owner.owner_email || "—" },
      { field: "Total records", value: owner.total_records },
      { field: "Duplicate records", value: owner.duplicate_records },
      { field: "Duplicate rate", value: `${owner.duplicate_rate}%` },
      { field: "RAG status", value: ragLabel },
      { field: "High-confidence duplicates", value: owner.high_confidence_duplicates },
      { field: "Clusters involved", value: owner.clusters_involved },
      {
        field: "Estimated waste value (deals)",
        value: owner.estimated_waste_value,
      },
      { field: "Packet due by", value: due },
      {
        field: "Escalation contact",
        value: `${settings.escalation_contact_name} <${settings.escalation_contact_email}>`,
      },
      { field: "Dispute path", value: settings.dispute_path },
      { field: "Generated", value: generated },
    ],
  };
}

/**
 * Action Items sheet: identifying record info on the left, 5 playbook
 * columns on the right. Threads playbook state across rows the same way
 * /export-xlsx does so "Merge into <primary>" stays correct.
 */
function buildActionItemsSheet(records: Array<Record<string, unknown>>) {
  const idColumns = [
    { header: "Cluster ID", key: "cluster_id", width: 12 },
    { header: "Zoho ID", key: "zoho_record_id", width: 22 },
    { header: "Record name", key: "record_name", width: 30 },
    { header: "Type", key: "record_type", width: 12 },
    { header: "Is primary", key: "is_primary_label", width: 12 },
    { header: "Domain", key: "domain", width: 22 },
    { header: "Email", key: "email", width: 28 },
  ];

  const state = emptyPlaybookState();
  const rows: Array<Record<string, unknown>> = [];
  for (const rec of records) {
    const cid = Number(rec.cluster_id ?? -1);
    if (cid !== state.cluster_id) startCluster(state, rec);
    const pb = rowPlaybook(rec, state);
    rows.push({
      cluster_id: rec.cluster_id,
      zoho_record_id: rec.zoho_record_id,
      record_name: rec.record_name,
      record_type: rec.record_type,
      is_primary_label: rec.is_primary ? "Yes" : "No",
      domain: rec.domain,
      email: rec.email,
      ...pb,
    });
  }

  return {
    name: "Action Items",
    columns: [...idColumns, ...PLAYBOOK_XLSX_COLUMNS],
    rows,
  };
}

/**
 * Raw Records sheet: every column the operator might need to investigate
 * the row in Zoho, no playbook columns (so reads cleanly as a data dump).
 */
function buildRawRecordsSheet(records: Array<Record<string, unknown>>) {
  return {
    name: "Raw Records",
    columns: [
      { header: "Cluster ID", key: "cluster_id", width: 12 },
      { header: "Zoho ID", key: "zoho_record_id", width: 22 },
      { header: "Type", key: "record_type", width: 12 },
      { header: "Name", key: "record_name", width: 30 },
      { header: "Company", key: "company_name", width: 30 },
      { header: "Email", key: "email", width: 28 },
      { header: "Domain", key: "domain", width: 22 },
      { header: "Phone", key: "phone", width: 18 },
      { header: "Owner", key: "owner_name", width: 22 },
      { header: "Status / Stage", key: "status_or_stage", width: 18 },
      { header: "Value", key: "deal_value", width: 14 },
      { header: "Source", key: "source", width: 18 },
      { header: "Confidence", key: "confidence_score", width: 12 },
      { header: "Created", key: "created_str", width: 14 },
      { header: "Is primary", key: "is_primary_label", width: 12 },
    ],
    rows: records.map((r) => ({
      ...r,
      is_primary_label: r.is_primary ? "Yes" : "No",
    })),
  };
}

/**
 * FAQ sheet: 7 standing Q&A entries written for an owner who just received
 * the packet and has never used Duplicate Radar before. Edit these as
 * stakeholder feedback comes in — they're plain strings.
 */
const FAQ_ENTRIES: Array<{ q: string; a: string }> = [
  {
    q: "What counts as a duplicate?",
    a: "Two or more records (Lead, Deal, Contact or Account) that the radar matched on email domain, phone number, or normalized company name with a confidence score ≥60%. Records below 60% are flagged 'low confidence' and require manual triage.",
  },
  {
    q: "Why am I getting this packet?",
    a: "You are the Owner of record on at least one duplicate cluster. Cleaning these keeps reporting accurate, prevents commission disputes, and stops the same lead being worked twice.",
  },
  {
    q: "What does 'Merge into <name>' mean in the Recommended Action column?",
    a: "<name> is the primary record the radar (or an operator) selected as the survivor. Open it in Zoho, copy any unique field values from the duplicate into the primary, then run Zoho's merge so the duplicate is deleted and references re-link.",
  },
  {
    q: "What is the Survivorship Rule column telling me?",
    a: "It explains how confident the radar is about the primary selection. 'High-confidence (≥90%)' clusters are safe to merge after a quick field-check; 'low-confidence (<60%)' clusters should not be auto-merged — escalate them.",
  },
  {
    q: "What is the Due Date column based on?",
    a: "It's the recommended SLA derived from cluster severity: high-confidence = 7 days, medium = 14 days, low = 30 days. The packet-level 'Packet due by' on the Cover sheet uses your earliest cluster.",
  },
  {
    q: "How do I dispute a row?",
    a: "Follow the 'Dispute path' on the Cover sheet of this workbook. Include the Cluster ID and Zoho ID(s) from the Action Items sheet so the data-quality team can locate the cluster instantly.",
  },
  {
    q: "What happens after I act on these in Zoho?",
    a: "The next radar sync (typically nightly) re-scans your records. Resolved clusters drop off the dashboard within 24 hours. If a cluster reappears, it usually means the duplicate was re-created from a new source — escalate via the contact above.",
  },
];

function buildFaqSheet() {
  return {
    name: "FAQ",
    columns: [
      { header: "#", key: "n", width: 4 },
      { header: "Question", key: "q", width: 50 },
      { header: "Answer", key: "a", width: 90 },
    ],
    rows: FAQ_ENTRIES.map((e, i) => ({ n: i + 1, ...e })),
  };
}

/** Public entry: build all four sheets ready for `streamXlsx`. */
export function buildPacketSheets(input: PacketBuildInputs) {
  return [
    buildCoverSheet(input),
    buildActionItemsSheet(input.records),
    buildRawRecordsSheet(input.records),
    buildFaqSheet(),
  ];
}

/**
 * Filename slug used by both the route response (Content-Disposition) and
 * the dashboard's optimistic local filename. Strips anything that would
 * upset Windows / macOS filesystems while preserving readability.
 */
export function packetFilename(ownerName: string): string {
  const slug =
    (ownerName || "owner")
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}_-]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "owner";
  return `duplicate-radar-packet-${slug}.xlsx`;
}
