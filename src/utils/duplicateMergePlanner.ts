/**
 * Duplicate Resolution — deterministic merge PLANNER (Phase 1, Accounts).
 *
 * Pure, side-effect-free, DB-free. Given a cluster's records it produces a
 * `MergePlan` describing how the duplicates would be resolved:
 *   • which record survives (the "master") and why,
 *   • which field values would be migrated onto the master (gap-fills only —
 *     the master's existing values are never overwritten automatically),
 *   • which duplicates would be tagged `Duplicate-Delete` for the Zoho admin,
 *   • field-level conflicts and other warnings for the operator to eyeball.
 *
 * IMPORTANT: this module performs NO writes and contacts NO external service.
 * It is the trustworthy backbone of the agentic feature — the LLM agent (added
 * later) only narrates on top of this; it never authors the data decisions.
 * The execute path (separate, write-gated) consumes a plan produced here.
 *
 * Uses `import type` so importing this file never pulls the pg pool in
 * `duplicateRadarDatabase` into memory — keeps the planner unit-testable.
 */

import type { DuplicateRecord } from "./duplicateRadarDatabase";

// ── Output types ───────────────────────────────────────────────────────────

export type MergeFieldAction = "fill" | "conflict";

export interface MergeFieldDecision {
  /** Zoho API field name (Accounts module). */
  field: string;
  /** Human label for the UI. */
  label: string;
  action: MergeFieldAction;
  chosenValue: string | number | null;
  /** zoho_record_id of the record supplying `chosenValue`. */
  fromZohoId: string | null;
  reason: string;
  /** Other values seen for this field across the cluster (for operator review). */
  alternatives: Array<{
    zohoId: string | null;
    recordName: string;
    value: string | number | null;
  }>;
}

export interface MergePlanRecordSummary {
  dbId: number | null;
  zohoId: string | null;
  name: string;
  isMaster: boolean;
  /** 0..1 fraction of tracked Account fields that are populated. */
  completeness: number;
  createdDate: string | null;
  modifiedDate: string | null;
  owner: string | null;
  hasZohoId: boolean;
}

export interface MergePlan {
  clusterId: number;
  module: "Accounts";
  /** Phase 1 mechanism — migrate fields to master, tag duplicates for admin. */
  method: "migrate_tag";
  tagName: string;
  masterZohoId: string | null;
  masterDbId: number | null;
  masterName: string;
  masterReason: string;
  /** zoho_record_ids that would receive the delete tag. */
  duplicateZohoIds: string[];
  duplicateDbIds: number[];
  fieldDecisions: MergeFieldDecision[];
  warnings: string[];
  /** Deterministic, human-readable summary for the review panel. */
  rationale: string;
  records: MergePlanRecordSummary[];
  generatedBy: string;
  /** ISO timestamp; stamped by the caller (route), null if not provided. */
  generatedAt: string | null;
}

// ── Field catalogue (Accounts) ───────────────────────────────────────────────
// `zoho` is the API field name applied during execute; `fallback` reads the
// structured column when raw_data lacks the key (older / pre-sync rows).
// NOTE: custom-field API names (CR_Number, VAT_Number) are ASSUMPTIONS and must
// be confirmed against the live Zoho org before the execute path is enabled —
// the planner emits a warning to that effect.

interface FieldSpec {
  zoho: string;
  label: string;
  custom?: boolean;
  fallback?: (r: DuplicateRecord) => unknown;
}

const ACCOUNT_FIELDS: FieldSpec[] = [
  {
    zoho: "Account_Name",
    label: "Account Name",
    fallback: (r) => r.record_name || r.company_name,
  },
  { zoho: "Phone", label: "Phone", fallback: (r) => r.phone },
  { zoho: "Website", label: "Website", fallback: (r) => r.website || r.domain },
  { zoho: "Industry", label: "Industry", fallback: (r) => r.industry },
  { zoho: "Employees", label: "Employees", fallback: (r) => r.no_of_employees },
  { zoho: "Billing_Country", label: "Country", fallback: (r) => r.country },
  { zoho: "Billing_State", label: "Region / State", fallback: (r) => r.region },
  {
    zoho: "Account_Type",
    label: "Account Type",
    fallback: (r) => r.account_type,
  },
  {
    zoho: "CR_Number",
    label: "CR Number",
    custom: true,
    fallback: (r) => r.cr_number,
  },
  {
    zoho: "VAT_Number",
    label: "VAT Number",
    custom: true,
    fallback: (r) => r.vat_number,
  },
];

// ── Value helpers ────────────────────────────────────────────────────────────

function rawVal(r: DuplicateRecord, zoho: string): unknown {
  const raw = r.raw_data;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && zoho in raw) {
    return (raw as Record<string, unknown>)[zoho];
  }
  return undefined;
}

/** Coerce any Zoho/column value into a scalar string|number, or null if empty. */
function normalize(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  if (typeof v === "object") {
    // Zoho lookup / owner objects: { name, id } or { value }
    const o = v as Record<string, unknown>;
    if (typeof o.name === "string" && o.name.trim() !== "")
      return o.name.trim();
    if (typeof o.value === "string" && o.value.trim() !== "")
      return o.value.trim();
  }
  return null;
}

function fieldValue(r: DuplicateRecord, f: FieldSpec): string | number | null {
  const fromRaw = normalize(rawVal(r, f.zoho));
  if (fromRaw !== null) return fromRaw;
  if (f.fallback) return normalize(f.fallback(r));
  return null;
}

function dateMs(d: Date | string | null | undefined): number {
  if (!d) return Number.POSITIVE_INFINITY; // unknown dates sort last for "oldest"
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

function modifiedMs(r: DuplicateRecord): number {
  const t = dateMs(r.modified_date);
  return t === Number.POSITIVE_INFINITY ? 0 : t; // unknown = oldest mod for "freshest"
}

function completeness(r: DuplicateRecord): number {
  let filled = 0;
  for (const f of ACCOUNT_FIELDS) if (fieldValue(r, f) !== null) filled++;
  return filled / ACCOUNT_FIELDS.length;
}

function recName(r: DuplicateRecord): string {
  return (
    r.record_name ||
    r.company_name ||
    r.zoho_record_id ||
    `record #${r.id ?? "?"}`
  );
}

function isoOrNull(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function sameScalar(
  a: string | number | null,
  b: string | number | null,
): boolean {
  if (a === null || b === null) return a === b;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

// ── Master selection ─────────────────────────────────────────────────────────
// Deterministic priority: most-complete → oldest (canonical original) →
// has an owner → lowest db id (stable).

function pickMaster(records: DuplicateRecord[]): DuplicateRecord {
  return [...records].sort((a, b) => {
    const ca = completeness(a);
    const cb = completeness(b);
    if (cb !== ca) return cb - ca;
    const da = dateMs(a.created_date);
    const db = dateMs(b.created_date);
    if (da !== db) return da - db;
    const oa = a.owner_email || a.owner_name ? 0 : 1;
    const ob = b.owner_email || b.owner_name ? 0 : 1;
    if (oa !== ob) return oa - ob;
    return (a.id ?? 0) - (b.id ?? 0);
  })[0];
}

function masterReasonText(master: DuplicateRecord): string {
  const pct = Math.round(completeness(master) * 100);
  const created = isoOrNull(master.created_date);
  const bits = [`most complete (${pct}% of tracked fields populated)`];
  if (created) bits.push(`oldest record (created ${created.slice(0, 10)})`);
  if (master.owner_name || master.owner_email)
    bits.push("has an assigned owner");
  return bits.join("; ");
}

// ── Plan builder ─────────────────────────────────────────────────────────────

export interface BuildPlanOptions {
  tagName?: string;
  generatedBy?: string;
  /** ISO timestamp; the route passes new Date().toISOString(). */
  generatedAt?: string | null;
}

/**
 * Build a non-destructive merge plan for an Accounts cluster.
 * Throws if there are fewer than 2 account-type records (nothing to merge).
 */
export function buildAccountMergePlan(
  clusterId: number,
  allRecords: DuplicateRecord[],
  opts: BuildPlanOptions = {},
): MergePlan {
  const tagName = opts.tagName || "Duplicate-Delete";
  const warnings: string[] = [];

  const nonAccount = allRecords.filter((r) => r.record_type !== "account");
  if (nonAccount.length > 0) {
    warnings.push(
      `${nonAccount.length} non-Account record(s) in this cluster are ignored — Phase 1 resolves Accounts only.`,
    );
  }

  const records = allRecords.filter((r) => r.record_type === "account");
  if (records.length < 2) {
    throw new Error(
      `Cluster ${clusterId} has ${records.length} Account record(s); need at least 2 to plan a merge.`,
    );
  }

  const master = pickMaster(records);
  const duplicates = records.filter((r) => r !== master);

  // Field decisions — gap-fills + conflicts only (keeps are omitted as noise).
  const fieldDecisions: MergeFieldDecision[] = [];
  let fillCount = 0;
  let conflictCount = 0;
  let usesCustomField = false;

  for (const f of ACCOUNT_FIELDS) {
    const masterVal = fieldValue(master, f);
    const dupVals = duplicates
      .map((d) => ({
        zohoId: d.zoho_record_id ?? null,
        recordName: recName(d),
        value: fieldValue(d, f),
      }))
      .filter((x) => x.value !== null);

    if (masterVal === null) {
      if (dupVals.length === 0) continue; // nobody has it
      // Fill from the freshest duplicate that holds a value.
      const freshest = [...duplicates]
        .filter((d) => fieldValue(d, f) !== null)
        .sort((a, b) => modifiedMs(b) - modifiedMs(a))[0];
      const chosen = fieldValue(freshest, f);
      fieldDecisions.push({
        field: f.zoho,
        label: f.label,
        action: "fill",
        chosenValue: chosen,
        fromZohoId: freshest.zoho_record_id ?? null,
        reason: `Master is empty; filled from "${recName(freshest)}" (most recently modified record holding a value).`,
        alternatives: dupVals.filter(
          (x) => x.zohoId !== (freshest.zoho_record_id ?? null),
        ),
      });
      fillCount++;
      if (f.custom) usesCustomField = true;
    } else {
      const conflicting = dupVals.filter(
        (x) => !sameScalar(x.value, masterVal),
      );
      if (conflicting.length > 0) {
        fieldDecisions.push({
          field: f.zoho,
          label: f.label,
          action: "conflict",
          chosenValue: masterVal,
          fromZohoId: master.zoho_record_id ?? null,
          reason: `Kept master value; ${conflicting.length} duplicate value(s) differ — review before accepting.`,
          alternatives: conflicting,
        });
        conflictCount++;
        warnings.push(
          `Field "${f.label}" differs across records — kept master ("${masterVal}"). ${conflicting.length} alternative(s) available.`,
        );
        if (f.custom) usesCustomField = true;
      }
    }
  }

  // Structural warnings.
  const untaggable = duplicates.filter((d) => !d.zoho_record_id);
  if (untaggable.length > 0) {
    warnings.push(
      `${untaggable.length} duplicate(s) have no Zoho record id — they cannot be tagged or migrated (synthetic / pre-sync rows).`,
    );
  }
  if (!master.zoho_record_id) {
    warnings.push(
      "Proposed master has no Zoho record id — it cannot be written to. Review the cluster before resolving.",
    );
  }
  const flaggedPrimary = records.find((r) => r.is_primary);
  if (flaggedPrimary && flaggedPrimary !== master) {
    warnings.push(
      `Recommended master ("${recName(master)}") differs from the currently flagged primary ("${recName(flaggedPrimary)}"). Override in the panel if the flag is correct.`,
    );
  }
  if (usesCustomField) {
    warnings.push(
      "Plan touches custom fields (CR Number / VAT Number) whose Zoho API names are assumptions — confirm them against the org before enabling the execute path.",
    );
  }

  const duplicateZohoIds = duplicates
    .map((d) => d.zoho_record_id)
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  const duplicateDbIds = duplicates
    .map((d) => d.id)
    .filter((x): x is number => typeof x === "number");

  const records_summary: MergePlanRecordSummary[] = records.map((r) => ({
    dbId: r.id ?? null,
    zohoId: r.zoho_record_id ?? null,
    name: recName(r),
    isMaster: r === master,
    completeness: Math.round(completeness(r) * 100) / 100,
    createdDate: isoOrNull(r.created_date),
    modifiedDate: isoOrNull(r.modified_date),
    owner: r.owner_name || r.owner_email || null,
    hasZohoId: !!r.zoho_record_id,
  }));

  const masterReason = masterReasonText(master);
  const rationale =
    `Proposed survivor: "${recName(master)}"` +
    (master.zoho_record_id ? ` (${master.zoho_record_id})` : "") +
    ` — ${masterReason}. ${duplicates.length} duplicate(s) would be tagged "${tagName}" for the Zoho admin to delete. ` +
    `${fillCount} field(s) would be migrated onto the survivor; ${conflictCount} field conflict(s) flagged for review. ` +
    `The platform deletes nothing — it only edits the survivor and tags the duplicates.`;

  return {
    clusterId,
    module: "Accounts",
    method: "migrate_tag",
    tagName,
    masterZohoId: master.zoho_record_id ?? null,
    masterDbId: master.id ?? null,
    masterName: recName(master),
    masterReason,
    duplicateZohoIds,
    duplicateDbIds,
    fieldDecisions,
    warnings,
    rationale,
    records: records_summary,
    generatedBy: opts.generatedBy || "duplicate-radar",
    generatedAt: opts.generatedAt ?? null,
  };
}
