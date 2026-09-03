/**
 * Zoho structured-fields sync — promotes call-evaluation results from
 * a free-form Note (the existing /sync-zoho behavior) into actual
 * filterable fields on the Zoho Lead/Deal record.
 *
 * Per DMAIC Improve phase Solution #4 and strategic report scope #1/#2:
 * "Right now, evaluation results get written as a formatted note via
 * /api/calls/:callId/sync-zoho. Notes cannot be filtered, reported on,
 * or used in Zoho workflow triggers." Promoting to structured fields
 * unlocks native Zoho dashboards filtered by QA_Score and lets the
 * sales manager build workflow triggers like "QA_Score < 60 → alert".
 *
 * --------------------------------------------------------------------
 *  PREREQUISITE — Zoho admin must create these custom fields FIRST
 * --------------------------------------------------------------------
 *
 *  On BOTH the Leads and Deals modules, the Zoho admin needs to add:
 *
 *    1. Decimal / Number  — for the QA score (0–100)
 *    2. Picklist or Boolean — for compliance pass/fail
 *    3. Date  — for the last-evaluation timestamp
 *
 *  The actual API field names Zoho assigns depend on the field labels
 *  the admin types in. Override the defaults via env vars in Replit
 *  Secrets if the admin chose different names:
 *
 *    ZOHO_FIELD_QA_SCORE         (default: QA_Score)
 *    ZOHO_FIELD_COMPLIANCE_PASS  (default: Compliance_Pass)
 *    ZOHO_FIELD_LAST_EVAL_DATE   (default: Last_Evaluation_Date)
 *
 * --------------------------------------------------------------------
 *  Behavior
 * --------------------------------------------------------------------
 *
 *  Feature-flagged on ZOHO_STRUCTURED_FIELDS. Ships disabled; flip on
 *  AFTER the Zoho admin has created the fields, otherwise the PATCH
 *  will 400 with "Invalid field" and leave a noisy log trail.
 *
 *  The existing Note-write at /api/calls/:callId/sync-zoho is NOT
 *  removed — both run in parallel. Notes carry the human-readable
 *  detail; structured fields carry the machine-filterable signal.
 */

import { logger as safeLogger } from "./logger";
import { isFlagEnabled } from "./featureFlags";

/** Per-tenant field-name configuration, read from env. */
export interface ZohoStructuredFieldNames {
  qaScore: string;
  compliancePass: string;
  lastEvalDate: string;
}

export function readFieldNames(): ZohoStructuredFieldNames {
  return {
    qaScore: process.env.ZOHO_FIELD_QA_SCORE || "QA_Score",
    compliancePass:
      process.env.ZOHO_FIELD_COMPLIANCE_PASS || "Compliance_Pass",
    lastEvalDate:
      process.env.ZOHO_FIELD_LAST_EVAL_DATE || "Last_Evaluation_Date",
  };
}

/** Subset of fields needed from the evaluation row. */
export interface EvaluationPatchInput {
  overall_score?: number | string | null;
  /** Compliance result — true/false, "pass"/"fail", null when not scored. */
  compliance_pass?: boolean | string | null;
  /** ISO date string or Date. Falls back to "now" when null. */
  evaluated_at?: string | Date | null;
}

export interface BuildPatchResult {
  /** Patch object to send as Zoho PUT body — empty {} if nothing to patch. */
  patch: Record<string, any>;
  /** Names of the fields actually included (for log audit). */
  fieldsIncluded: string[];
}

/**
 * Build the Zoho PATCH payload from an evaluation row. Pure function —
 * no I/O. Skips fields whose source values are null/undefined so we
 * never overwrite a Zoho cell with empty when the platform doesn't
 * have a value to write.
 */
export function buildEvaluationPatch(
  ev: EvaluationPatchInput,
  fields: ZohoStructuredFieldNames = readFieldNames(),
): BuildPatchResult {
  const patch: Record<string, any> = {};
  const included: string[] = [];

  // QA score — must be a finite number to write
  if (ev.overall_score !== null && ev.overall_score !== undefined) {
    const n = Number(ev.overall_score);
    if (Number.isFinite(n)) {
      patch[fields.qaScore] = n;
      included.push(fields.qaScore);
    }
  }

  // Compliance pass — accept boolean or pass/fail string
  if (ev.compliance_pass !== null && ev.compliance_pass !== undefined) {
    let val: boolean | null = null;
    if (typeof ev.compliance_pass === "boolean") {
      val = ev.compliance_pass;
    } else if (typeof ev.compliance_pass === "string") {
      const s = ev.compliance_pass.trim().toLowerCase();
      if (["pass", "true", "yes", "1"].includes(s)) val = true;
      else if (["fail", "false", "no", "0"].includes(s)) val = false;
    }
    if (val !== null) {
      patch[fields.compliancePass] = val;
      included.push(fields.compliancePass);
    }
  }

  // Last evaluation date — accept ISO string or Date, fall back to "now".
  //
  // Three input cases:
  //   (a) evaluated_at is a valid ISO/Date → use it.
  //   (b) evaluated_at is set but unparseable (e.g. "not-a-date") → treat
  //       the same as (c): the caller passed garbage, but if we have
  //       anything else to write, stamp "now" so Zoho's
  //       Last_Evaluation_Date field isn't silently left stale.
  //   (c) evaluated_at is unset → if patch already has content, stamp
  //       "now"; otherwise leave the date off so we don't write a date
  //       to an otherwise-empty patch.
  let evalDate: Date | null = null;
  if (ev.evaluated_at) {
    const d = ev.evaluated_at instanceof Date
      ? ev.evaluated_at
      : new Date(ev.evaluated_at);
    if (!Number.isNaN(d.getTime())) evalDate = d;
  }
  if (!evalDate && Object.keys(patch).length > 0) {
    // Covers cases (b) and (c). Only stamp "now" if we have something
    // else to write — never write an evaluation date for an empty patch.
    evalDate = new Date();
  }
  if (evalDate) {
    // Zoho expects YYYY-MM-DD for Date fields, YYYY-MM-DDTHH:MM:SS+0000
    // for DateTime. We use Date (no time) for safety — works for both.
    patch[fields.lastEvalDate] = evalDate.toISOString().slice(0, 10);
    included.push(fields.lastEvalDate);
  }

  return { patch, fieldsIncluded: included };
}

export interface SyncStructuredFieldsResult {
  /** True when the PATCH actually went out. */
  synced: boolean;
  /** Why we skipped, when synced=false. */
  <REDACTED_TOKEN>?: string;
  /** Fields included on the PATCH (audit trail). */
  fields?: string[];
  /** Zoho module the patch went to. */
  module?: "Leads" | "Deals";
  /** Zoho record ID the patch went to. */
  record_id?: string;
}

/**
 * Promote an evaluation to Zoho structured fields. Best-effort —
 * never throws so the caller's Note-write keeps running.
 *
 * Decision tree:
 *   1. Flag off → <REDACTED_TOKEN>='flag_disabled'
 *   2. No Lead/Deal → <REDACTED_TOKEN>='no_crm_linkage'
 *   3. Empty patch → <REDACTED_TOKEN>='no_writable_fields'
 *   4. PUT runs; on failure → <REDACTED_TOKEN>='zoho_error' (and logged)
 */
export async function syncEvaluationToZohoStructuredFields(
  evaluation: EvaluationPatchInput,
  callRecord: {
    id?: number;
    lead_id?: string | null;
    deal_id?: string | null;
  },
  options: { logger?: any; identity?: string | null } = {},
): Promise<SyncStructuredFieldsResult> {
  const { logger, identity } = options;

  if (!isFlagEnabled("zoho_structured_fields", identity)) {
    return { synced: false, <REDACTED_TOKEN>: "flag_disabled" };
  }

  const { lead_id, deal_id } = callRecord;
  if (!lead_id && !deal_id) {
    return { synced: false, <REDACTED_TOKEN>: "no_crm_linkage" };
  }

  const { patch, fieldsIncluded } = buildEvaluationPatch(evaluation);
  if (fieldsIncluded.length === 0) {
    return { synced: false, <REDACTED_TOKEN>: "no_writable_fields" };
  }

  const module: "Leads" | "Deals" = lead_id ? "Leads" : "Deals";
  const recordId = (lead_id || deal_id) as string;

  try {
    const { updateZohoRecord } = await import("./zohoCRM");
    await updateZohoRecord(module, recordId, patch);

    logger?.info("✅ [zohoStructuredFields] PATCH succeeded", {
      callId: callRecord.id,
      module,
      recordId,
      fields: fieldsIncluded,
    });
    return {
      synced: true,
      fields: fieldsIncluded,
      module,
      record_id: recordId,
    };
  } catch (err: any) {
    safeLogger.warn("[zohoStructuredFields] PATCH failed", {
      callId: callRecord.id,
      module,
      recordId,
      fields: fieldsIncluded,
      error: err?.message || String(err),
    });
    return {
      synced: false,
      <REDACTED_TOKEN>: "zoho_error",
      fields: fieldsIncluded,
      module,
      record_id: recordId,
    };
  }
}
