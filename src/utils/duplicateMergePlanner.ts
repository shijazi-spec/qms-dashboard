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

/** CRM modules the agentic resolver supports. */
export type CrmModule = "Accounts" | "Leads" | "Deals" | "Contacts";

/** duplicate_records.record_type value for each module. */
export const MODULE_RECORD_TYPE: Record<CrmModule, string> = {
  Accounts: "account",
  Leads: "lead",
  Deals: "deal",
  Contacts: "contact",
};

/** Singular human label per module. */
const MODULE_LABEL: Record<CrmModule, string> = {
  Accounts: "Account",
  Leads: "Lead",
  Deals: "Deal",
  Contacts: "Contact",
};

/**
 * Normalize a (possibly Arabic) personal name for EQUALITY comparison in the
 * ≥2-attribute contact rule. Plain `trim().toLowerCase()` left visually-
 * identical Arabic names comparing UNEQUAL — a very common cause of "these are
 * obviously the same person but the modal won't let me merge them" (the plan
 * falls to link-only). Here we: Unicode-NFKC; strip bidi / zero-width marks,
 * tatweel and harakat (diacritics); fold the common Arabic letter variants
 * (آأإ→ا, ى→ي, ة→ه); collapse whitespace; lowercase. The ≥2-attribute rule
 * still requires a second signal (email or phone) to match, so the slightly
 * looser name match can't merge two genuinely different people on its own.
 * (Ahmad 2026-06-22.)
 */
export function normalizePersonName(s: string | null | undefined): string {
  return String(s || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "") // zero-width + bidi marks
    .replace(/\u0640/g, "") // tatweel
    .replace(/[\u064B-\u0652\u0670]/g, "") // harakat / diacritics
    .replace(/[\u0622\u0623\u0625]/g, "\u0627") // alef variants -> alef
    .replace(/\u0649/g, "\u064A") // alef maqsura -> yaa
    .replace(/\u0629/g, "\u0647") // taa marbuta -> haa
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

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
  /** Whether this record is in the merge set (false = operator-excluded, untouched). */
  included: boolean;
  /** 0..1 fraction of tracked Account fields that are populated. */
  completeness: number;
  createdDate: string | null;
  modifiedDate: string | null;
  owner: string | null;
  /** Zoho Layout / account category (e.g. "Corporate Accounts", "Partner Accounts"). Informational. */
  layout: string | null;
  /**
   * Zoho Account_Name (parent Account) when the record has one. Surfaced in
   * the Contacts merge modal in place of the 📎 attachments chip — for
   * Contacts the parent-Account context is the more useful merge-decision
   * signal (which company does each duplicate belong to?). Null for records
   * with no Account_Name (e.g. orphan Contacts, all Accounts/Leads).
   */
  accountName: string | null;
  /** Deal Stage (Zoho). Surfaced in the Deals merge modal in place of the
   *  attachments chip — the stage is the more useful merge-decision signal for
   *  Deals (don't merge away an open/won deal). Null for non-Deal records. */
  stage: string | null;
  hasZohoId: boolean;
}

export interface MergePlan {
  clusterId: number;
  module: CrmModule;
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
  /** Accounts in the cluster the survivor can be linked to (Contacts/Deals only). */
  accountCandidates: { zohoId: string; name: string }[];
  /** Account the survivor's Account_Name will be set to on apply (null = no link). */
  linkAccountZohoId: string | null;
  /**
   * Cascade-only Zoho IDs (Contacts merge): records that should receive the
   * Account_Name cascade BUT are NOT tagged Duplicate-Delete because they
   * failed the ≥2-attribute strict rule against the survivor. They appear
   * as "Excluded" in the plan; the executor adds them to its Account_Name
   * cascade so every contact in the cluster lands under the surviving
   * Account, but no Duplicate-Delete tag is applied.
   */
  cascadeOnlyZohoIds: string[];
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

// Per-module field catalogues. Standard Zoho API field names; if your org
// renamed a standard field or you want custom fields migrated, adjust here.
// `custom: true` fields are flagged to the operator as API-name assumptions.
const MODULE_FIELDS: Record<CrmModule, FieldSpec[]> = {
  Accounts: [
    { zoho: "Account_Name", label: "Account Name", fallback: (r) => r.record_name || r.company_name },
    { zoho: "Phone", label: "Phone", fallback: (r) => r.phone },
    { zoho: "Website", label: "Website", fallback: (r) => r.website || r.domain },
    { zoho: "Industry", label: "Industry", fallback: (r) => r.industry },
    { zoho: "Employees", label: "Employees", fallback: (r) => r.no_of_employees },
    { zoho: "Billing_Country", label: "Country", fallback: (r) => r.country },
    { zoho: "Billing_State", label: "Region / State", fallback: (r) => r.region },
    { zoho: "Account_Type", label: "Account Type", fallback: (r) => r.account_type },
    { zoho: "CR_Number", label: "CR Number", custom: true, fallback: (r) => r.cr_number },
    { zoho: "VAT_Number", label: "VAT Number", custom: true, fallback: (r) => r.vat_number },
  ],
  Leads: [
    { zoho: "Last_Name", label: "Name", fallback: (r) => r.record_name },
    { zoho: "Company", label: "Company", fallback: (r) => r.company_name },
    { zoho: "Email", label: "Email", fallback: (r) => r.email },
    { zoho: "Phone", label: "Phone", fallback: (r) => r.phone },
    { zoho: "Mobile", label: "Mobile", fallback: (r) => r.mobile },
    { zoho: "Lead_Status", label: "Lead Status", fallback: (r) => r.status },
    { zoho: "Lead_Source", label: "Source", fallback: (r) => r.source },
    { zoho: "Industry", label: "Industry", fallback: (r) => r.industry },
    { zoho: "Website", label: "Website", fallback: (r) => r.website || r.domain },
  ],
  Deals: [
    { zoho: "Deal_Name", label: "Deal Name", fallback: (r) => r.record_name },
    { zoho: "Amount", label: "Amount", fallback: (r) => r.deal_value },
    { zoho: "Stage", label: "Stage", fallback: (r) => r.stage },
    { zoho: "Pipeline", label: "Pipeline", fallback: (r) => r.pipeline },
    { zoho: "Closing_Date", label: "Closing Date" },
    { zoho: "Account_Name", label: "Account", fallback: (r) => r.account_name },
    { zoho: "Contact_Name", label: "Contact", fallback: (r) => r.contact_name },
    { zoho: "Lead_Source", label: "Source", fallback: (r) => r.source },
  ],
  Contacts: [
    { zoho: "Last_Name", label: "Name", fallback: (r) => r.record_name },
    { zoho: "Email", label: "Email", fallback: (r) => r.email },
    { zoho: "Phone", label: "Phone", fallback: (r) => r.phone },
    { zoho: "Mobile", label: "Mobile", fallback: (r) => r.mobile },
    { zoho: "Account_Name", label: "Account", fallback: (r) => r.account_name },
    { zoho: "Title", label: "Title", fallback: (r) => r.title },
    { zoho: "Lead_Source", label: "Source", fallback: (r) => r.source },
  ],
};

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

function completeness(r: DuplicateRecord, fields: FieldSpec[]): number {
  if (!fields.length) return 0;
  let filled = 0;
  for (const f of fields) if (fieldValue(r, f) !== null) filled++;
  return filled / fields.length;
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

// Zoho Layout (account category, e.g. "Corporate Accounts" / "Partner
// Accounts"). Surfaced in the plan as INFO only — a layout difference between
// records is legitimate (corporate B2B/B2C vs merchant partner), NOT a merge
// conflict, so it is deliberately kept out of ACCOUNT_FIELDS / conflict logic.
function layoutOf(r: DuplicateRecord): string | null {
  const v = normalize(rawVal(r, "Layout"));
  if (v !== null) return String(v);
  return r.layout_name || null;
}

// Zoho Account_Name (the parent Account a Contact/Deal is linked to). normalize()
// already unwraps the Zoho lookup shape `{ name, id }` to the display name.
// Falls back to the denormalised `account_name` column when raw_data is empty
// (older / pre-sync rows). Returns null when the record has no parent Account.
function accountNameOf(r: DuplicateRecord): string | null {
  const v = normalize(rawVal(r, "Account_Name"));
  if (v !== null) return String(v);
  return r.account_name || null;
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

function pickMaster(
  records: DuplicateRecord[],
  fields: FieldSpec[],
): DuplicateRecord {
  return [...records].sort((a, b) => {
    const ca = completeness(a, fields);
    const cb = completeness(b, fields);
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

function masterReasonText(master: DuplicateRecord, fields: FieldSpec[]): string {
  const pct = Math.round(completeness(master, fields) * 100);
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
  /**
   * Operator override: force this zoho_record_id to be the survivor instead of
   * the deterministic pick. Ignored if it doesn't match an Account record in
   * the cluster (falls back to the automatic choice).
   */
  masterZohoId?: string | null;
  /**
   * Operator-selected subset of account zoho_record_ids to merge (must be >=2).
   * Records not in the selection are left untouched (shown as "Excluded").
   * Omitted/empty = merge all accounts in the cluster.
   */
  includeZohoIds?: string[] | null;
  /**
   * Link the survivor's Account_Name to this account (Contacts/Deals). A non-
   * empty string = link to that account id; "" / null = explicitly don't link;
   * undefined = default to the cluster's primary/sole account if any.
   */
  linkAccountZohoId?: string | null;
  /**
   * DB ids of Account records that have ALREADY been tagged Duplicate-Delete
   * by a prior Accounts merge on this cluster. They are filtered out of
   * accountCandidates so the LINK SURVIVOR TO ACCOUNT picker only shows alive
   * Accounts (the surviving record from a previous Accounts merge, or
   * Accounts not yet resolved). Without this, the operator would see zombie
   * buttons for the SLB / Slb duplicates they already merged into the
   * "Schlumberger (SLB)" survivor.
   */
  taggedAccountDbIds?: number[];
  /**
   * Operator FORCE-MERGE override (Contacts): bypass the ≥2-attribute
   * soft-exclusion and tag the selected non-survivor contacts as duplicates
   * even when they share fewer than 2 of {email, phone, name}. For verified
   * edge cases (e.g. the same person entered twice with different name
   * spellings, sharing only a phone). Migrate-then-tag still applies — nothing
   * is deleted. Use with an explicit operator confirmation + audit note.
   */
  forceMergeContacts?: boolean;
}

/**
 * Build a non-destructive merge plan for a cluster, scoped to one CRM module
 * (Accounts / Leads / Deals / Contacts). Same migrate-then-tag model for every
 * module — only the field catalogue and record_type differ. Throws if there are
 * fewer than 2 records of that module's type (nothing to merge).
 */
export function buildMergePlan(
  module: CrmModule,
  clusterId: number,
  allRecords: DuplicateRecord[],
  opts: BuildPlanOptions = {},
): MergePlan {
  const fields = MODULE_FIELDS[module];
  const recordType = MODULE_RECORD_TYPE[module];
  const label = MODULE_LABEL[module];
  const tagName = opts.tagName || "Duplicate-Delete";
  const warnings: string[] = [];

  const nonTarget = allRecords.filter((r) => r.record_type !== recordType);
  if (nonTarget.length > 0) {
    warnings.push(
      `${nonTarget.length} non-${label} record(s) in this cluster are ignored — this plan resolves ${module} only.`,
    );
  }

  const records = allRecords.filter((r) => r.record_type === recordType);
  if (records.length < 2) {
    throw new Error(
      `Cluster ${clusterId} has ${records.length} ${label} record(s); need at least 2 to plan a merge.`,
    );
  }

  // Operator may select a subset to merge (>=2). Records left out of the
  // selection are untouched (rendered as "Excluded" in the plan).
  const sel = (opts.includeZohoIds || []).filter(Boolean);
  const selSet = new Set(sel);
  const mergeSet =
    sel.length > 0
      ? records.filter((r) => r.zoho_record_id && selSet.has(r.zoho_record_id))
      : records;
  // A LINK-ONLY (cascade) plan is valid with a single record: it sets
  // Account_Name on the cluster's contacts and tags/merges nothing. So the
  // "need 2 to merge" rule only applies when there is NO link target chosen
  // (a pure merge). When a real account is being linked, allow 1 selected.
  const isLinkOnly =
    typeof opts.linkAccountZohoId === "string" &&
    opts.linkAccountZohoId.trim().length > 0;
  if (sel.length > 0 && mergeSet.length < 1) {
    throw new Error(`Select at least 1 ${label} record (selected ${mergeSet.length}).`);
  }
  if (sel.length > 0 && mergeSet.length < 2 && !isLinkOnly) {
    throw new Error(
      `Select at least 2 ${label} records to merge — or pick an Account to link to for a link-only cascade (selected ${mergeSet.length}).`,
    );
  }
  if (sel.length > 0 && mergeSet.length < records.length) {
    warnings.push(
      `${records.length - mergeSet.length} ${label.toLowerCase()}(s) excluded from this merge by the operator — left untouched.`,
    );
  }

  const overridden =
    opts.masterZohoId != null
      ? mergeSet.find((r) => r.zoho_record_id === opts.masterZohoId)
      : undefined;
  if (opts.masterZohoId != null && !overridden) {
    warnings.push(
      `Requested master ${opts.masterZohoId} is not in the selected merge set — using the recommended survivor instead.`,
    );
  }
  const master = overridden || pickMaster(mergeSet, fields);
  let duplicates = mergeSet.filter((r) => r !== master);

  // ── HARD RULE for Contacts ──────────────────────────────────────────────
  // Two contacts can only be tagged Duplicate-Delete of each other when they
  // share AT LEAST 2 of {lower(email), normalized phone, lower(record_name)}.
  // Sharing only a parent Account or company name is NOT duplicate evidence
  // — that's what the Account_Name cascade is for (everyone in the cluster
  // gets re-pointed to the surviving Account regardless). A non-matching
  // contact stays in the cluster but is moved to "softExcluded": rendered
  // as Excluded in the plan, untouched in Zoho.
  //
  // Reason: Sarah Hijazi (2026-06-10) — the previous behaviour was tagging
  // genuinely different people who happened to sit in the same cluster.
  // See feedback-contact-merge-rule.md.
  const contactSoftExcluded: typeof duplicates = [];
  // Operator FORCE-MERGE bypasses the ≥2-attribute soft-exclusion: every
  // selected non-survivor contact is tagged as a duplicate (verified by a
  // human). Default behaviour (no force) keeps the safe rule.
  if (module === "Contacts" && duplicates.length > 0 && !opts.forceMergeContacts) {
    const masterEmail = (master.email || "").trim().toLowerCase();
    const masterPhone = (master.phone_normalized || "").trim();
    // Arabic-aware name normalization so visually-identical names (differing
    // only by invisible bidi marks / NFC-vs-NFKC / tatweel / ة-vs-ه) compare
    // equal instead of silently dropping a real duplicate to cascade-only.
    const masterName = normalizePersonName(master.record_name);
    const passesStrict = (r: DuplicateRecord): boolean => {
      let matches = 0;
      const rEmail = (r.email || "").trim().toLowerCase();
      const rPhone = (r.phone_normalized || "").trim();
      const rName = normalizePersonName(r.record_name);
      if (masterEmail && rEmail && masterEmail === rEmail) matches++;
      if (masterPhone && rPhone && masterPhone === rPhone) matches++;
      if (masterName && rName && masterName === rName) matches++;
      return matches >= 2;
    };
    const keep: typeof duplicates = [];
    for (const r of duplicates) {
      if (passesStrict(r)) keep.push(r);
      else contactSoftExcluded.push(r);
    }
    duplicates = keep;
    if (contactSoftExcluded.length > 0) {
      const names = contactSoftExcluded
        .slice(0, 5)
        .map((r) => recName(r))
        .join(", ");
      const more =
        contactSoftExcluded.length > 5
          ? ` (+${contactSoftExcluded.length - 5} more)`
          : "";
      warnings.push(
        `${contactSoftExcluded.length} contact(s) left UNTAGGED — they share fewer than 2 identity attributes (email/phone/name) with "${recName(master)}" and are NOT duplicates of it: ${names}${more}. Account_Name cascade will still re-point them to the surviving Account when a link target is chosen.`,
      );
    }
    if (duplicates.length === 0) {
      warnings.push(
        `Cascade-only plan — no genuine contact duplicates of "${recName(master)}" in this cluster. Apply will set Account_Name on every contact but tag none.`,
      );
    }
  } else if (module === "Contacts" && opts.forceMergeContacts && duplicates.length > 0) {
    warnings.push(
      `⚠ FORCE-MERGE — the operator confirmed the ${duplicates.length} selected contact(s) are the SAME person as "${recName(master)}" and overrode the ≥2-attribute rule. They will be tagged Duplicate-Delete (migrate-then-tag; nothing is deleted).`,
    );
    // Pull soft-excluded contacts out of mergeSet so the UI renders them
    // as "Excluded" (untouched) instead of "Duplicate-Delete". The
    // Account_Name cascade still covers them via plan.cascadeOnlyZohoIds
    // (added to the executor below).
    if (contactSoftExcluded.length > 0) {
      const excluded = new Set(contactSoftExcluded);
      // mergeSet is a plain array; rebuild it without the soft-excluded set.
      for (let i = mergeSet.length - 1; i >= 0; i--) {
        if (excluded.has(mergeSet[i])) mergeSet.splice(i, 1);
      }
    }
  }

  // Cross-module link: accounts in the cluster the survivor can be linked to
  // (Contacts / Deals set their Account_Name lookup). Surfaced for the UI; the
  // executor applies it on apply when an account is chosen.
  const canLinkAccount = module === "Contacts" || module === "Deals";
  const taggedAccountSet = new Set<number>(opts.taggedAccountDbIds || []);
  const accountCandidates = canLinkAccount
    ? allRecords
        .filter(
          (r) =>
            r.record_type === "account" &&
            r.zoho_record_id &&
            // Drop Accounts that were tagged Duplicate-Delete by a prior
            // Accounts merge on this cluster — they're zombies in Zoho and
            // must not appear as link targets.
            (r.id == null || !taggedAccountSet.has(r.id)),
        )
        .map((r) => ({
          zohoId: r.zoho_record_id as string,
          name: r.record_name || r.company_name || (r.zoho_record_id as string),
        }))
    : [];
  const suggestedAccount =
    accountCandidates.find((a) =>
      allRecords.some((r) => r.zoho_record_id === a.zohoId && r.is_primary),
    )?.zohoId ||
    (accountCandidates.length === 1 ? accountCandidates[0].zohoId : null);
  let linkAccountZohoId: string | null;
  if (opts.linkAccountZohoId === undefined) {
    linkAccountZohoId = suggestedAccount; // default suggestion on first preview
  } else if (!opts.linkAccountZohoId) {
    linkAccountZohoId = null; // explicit "don't link"
  } else {
    linkAccountZohoId = accountCandidates.some(
      (a) => a.zohoId === opts.linkAccountZohoId,
    )
      ? opts.linkAccountZohoId
      : null;
  }

  // Field decisions — gap-fills + conflicts only (keeps are omitted as noise).
  const fieldDecisions: MergeFieldDecision[] = [];
  let fillCount = 0;
  let conflictCount = 0;
  let usesCustomField = false;

  for (const f of fields) {
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

  // Preserve an alternate email on a CONTACT merge (Ahmad 2026-06-22). The
  // survivor keeps its primary Email; a duplicate's DIFFERENT email would
  // otherwise be discarded when that duplicate is tagged for deletion. If the
  // survivor's Secondary_Email is still empty, capture the freshest distinct
  // alternate email into it so no email is lost. Gap-fill only — never
  // overwrites an existing Secondary_Email. Zoho Contacts has a single
  // Secondary_Email field, so if there are several alternates only one is
  // preserved and the rest are surfaced as alternatives + a warning.
  if (module === "Contacts") {
    const emailRaw = (r: DuplicateRecord): string =>
      String((rawVal(r, "Email") ?? r.email ?? "") as unknown).trim();
    const masterSecondary = String(
      (rawVal(master, "Secondary_Email") ?? "") as unknown,
    ).trim();
    if (!masterSecondary) {
      const dupsByFresh = [...duplicates].sort(
        (a, b) => modifiedMs(b) - modifiedMs(a),
      );
      // Effective primary email after merge: the master's, or — if the master
      // had none — whichever duplicate email the loop above used to gap-fill it.
      let primaryKey = emailRaw(master).toLowerCase();
      if (!primaryKey) {
        const filler = dupsByFresh.find((d) => emailRaw(d));
        primaryKey = filler ? emailRaw(filler).toLowerCase() : "";
      }
      const seen = new Set<string>();
      if (primaryKey) seen.add(primaryKey);
      const alts: { zohoId: string | null; recordName: string; value: string }[] = [];
      for (const d of dupsByFresh) {
        const e = emailRaw(d);
        const k = e.toLowerCase();
        if (e && !seen.has(k)) {
          seen.add(k);
          alts.push({ zohoId: d.zoho_record_id ?? null, recordName: recName(d), value: e });
        }
      }
      if (alts.length > 0) {
        const chosen = alts[0]!;
        fieldDecisions.push({
          field: "Secondary_Email",
          label: "Secondary Email",
          action: "fill",
          chosenValue: chosen.value,
          fromZohoId: chosen.zohoId,
          reason: `Survivor's email differs from "${chosen.recordName}" — preserved its email in Secondary_Email so no email is lost on merge.`,
          alternatives: alts.slice(1),
        });
        fillCount++;
        if (alts.length > 1) {
          warnings.push(
            `${alts.length} distinct alternate email(s) found, but Zoho Contacts has a single Secondary_Email field — only "${chosen.value}" is preserved on the survivor. The rest are listed as alternatives; capture them manually if needed: ${alts
              .slice(1)
              .map((a) => a.value)
              .join(", ")}.`,
          );
        }
      }
    }
  }

  // Preserve alternate (EN/AR) names on an ACCOUNT merge (Ahmad 2026-06-22).
  // The Account Name field is bilingual — one record may hold the English name,
  // another the Arabic — so a straight merge keeps the survivor's name and the
  // other-language name is lost when the admin deletes the duplicate. There's no
  // dedicated Arabic-name field, so we APPEND the distinct alternate name(s) to
  // the survivor's Description as "Also known as: …" (non-destructive, keeps
  // Account_Name clean for reporting). Gap-aware: appends to any existing
  // Description rather than overwriting.
  if (module === "Accounts") {
    const nameOf = (r: DuplicateRecord): string =>
      String(
        ((r.raw_data as any)?.Account_Name ?? r.record_name ?? r.company_name ?? "") as unknown,
      ).trim();
    const masterName = nameOf(master);
    const masterKey = masterName.toLowerCase();
    const seenNames = new Set<string>();
    if (masterKey) seenNames.add(masterKey);
    const altNames: string[] = [];
    for (const d of duplicates) {
      const n = nameOf(d);
      const k = n.toLowerCase();
      if (n && !seenNames.has(k)) {
        seenNames.add(k);
        altNames.push(n);
      }
    }
    if (altNames.length > 0) {
      const existingDesc = String(
        ((master.raw_data as any)?.Description ?? "") as unknown,
      ).trim();
      const aka = `Also known as: ${altNames.join(" | ")}`;
      const newDesc = existingDesc
        ? existingDesc.includes(aka)
          ? existingDesc
          : `${existingDesc}\n${aka}`
        : aka;
      if (newDesc !== existingDesc) {
        fieldDecisions.push({
          field: "Description",
          label: "Description (alternate names)",
          action: "fill",
          chosenValue: newDesc,
          fromZohoId: master.zoho_record_id ?? null,
          reason: `Preserved ${altNames.length} alternate name(s) (EN/AR) on the survivor so no name is lost when the duplicate is deleted.`,
          alternatives: altNames.map((n) => ({ zohoId: null, recordName: n, value: n })),
        });
        fillCount++;
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
  // Cascade-only ids — soft-excluded Contacts that should still receive the
  // Account_Name cascade but never the Duplicate-Delete tag. Stays an empty
  // array for every other module.
  const cascadeOnlyZohoIds = contactSoftExcluded
    .map((r) => r.zoho_record_id)
    .filter((x): x is string => typeof x === "string" && x.length > 0);

  const records_summary: MergePlanRecordSummary[] = records.map((r) => ({
    dbId: r.id ?? null,
    zohoId: r.zoho_record_id ?? null,
    name: recName(r),
    isMaster: r === master,
    included: mergeSet.includes(r),
    completeness: Math.round(completeness(r, fields) * 100) / 100,
    createdDate: isoOrNull(r.created_date),
    modifiedDate: isoOrNull(r.modified_date),
    owner: r.owner_name || r.owner_email || null,
    layout: layoutOf(r),
    accountName: accountNameOf(r),
    stage: r.stage ?? null,
    hasZohoId: !!r.zoho_record_id,
  }));

  const masterReason = overridden
    ? `Operator-selected survivor — ${Math.round(completeness(master, fields) * 100)}% of tracked fields populated`
    : masterReasonText(master, fields);
  // LINK-ONLY rationale for Contacts (Sarah Hijazi 2026-06-10):
  // when 0 contacts qualify as duplicates under the ≥2-attribute rule,
  // the plan is "link cascade only" — no tagging happens. The rationale
  // text must say that explicitly so chat/agent/log consumers don't read
  // "0 duplicate(s) would be tagged" as a noisy merge proposal.
  const linkOnlyMode =
    module === "Contacts" &&
    duplicates.length === 0 &&
    cascadeOnlyZohoIds.length > 0;
  const rationale = linkOnlyMode
    ? `Link-only plan for "${recName(master)}"` +
      (master.zoho_record_id ? ` (${master.zoho_record_id})` : "") +
      `. ${cascadeOnlyZohoIds.length} other contact(s) in this cluster do NOT pairwise share ≥2 of {email, phone, name} with the survivor — they are different people at the same Account, not duplicates of each other. ` +
      `On Apply, every contact's Account_Name is updated to the chosen Account. No record is tagged "${tagName}"; the platform deletes nothing.`
    : `Proposed survivor: "${recName(master)}"` +
      (master.zoho_record_id ? ` (${master.zoho_record_id})` : "") +
      ` — ${masterReason}. ${duplicates.length} duplicate(s) would be tagged "${tagName}" for the Zoho admin to delete. ` +
      `${fillCount} field(s) would be migrated onto the survivor; ${conflictCount} field conflict(s) flagged for review. ` +
      `The platform deletes nothing — it only edits the survivor and tags the duplicates.`;

  return {
    clusterId,
    module,
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
    accountCandidates,
    linkAccountZohoId,
    cascadeOnlyZohoIds,
    generatedBy: opts.generatedBy || "duplicate-radar",
    generatedAt: opts.generatedAt ?? null,
  };
}

/** Back-compat convenience wrapper — Accounts merge plan. */
export function buildAccountMergePlan(
  clusterId: number,
  allRecords: DuplicateRecord[],
  opts: BuildPlanOptions = {},
): MergePlan {
  return buildMergePlan("Accounts", clusterId, allRecords, opts);
}
