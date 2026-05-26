/**
 * Shared post-ingest pipeline for call records.
 *
 * Both /api/calls/ingest (Five9-style metadata push) and
 * /api/calls/upload (manual UI audio upload) need the same auto-link
 * + compliance behavior after the call_records row is created.
 * Until this consolidation, the block was duplicated in both routes
 * (~70 lines each, identical logic, drifting wording). That kind of
 * duplication was the upstream cause of the 2026-05-23 upload bug —
 * `/upload` was missing the autoLink block that `/ingest` had had
 * for months (see DMAIC Analyze phase, 5 Whys → root cause: no shared
 * post-ingest pipeline).
 *
 * The two exported functions:
 *
 *   - runComplianceAfterLink(callId, leadId, dealId, callDate, logger?)
 *     Was previously a private function at the top of
 *     callIntelligenceRoutes.ts. Body is unchanged; only the home moved.
 *
 *   - autoLinkCallAndCompliance(callRecord, options)
 *     New wrapper that calls extractCallPhoneCandidates → autoLinkCallToCrm
 *     → (on success) updateCallRecordLinkedVia → runComplianceAfterLink.
 *     Best-effort: any throw is logged at warn and swallowed so the
 *     enclosing HTTP handler still returns success.
 *
 * NOTE — scope: this PR consolidates `/ingest` and `/upload`. The audit
 * found that `/upload-audio` is also missing the autoLink call inside
 * its autoAnalyze block (line ~2300). That is a behavior fix, not a
 * refactor; tracking separately so behavior change isn't smuggled into
 * a refactor PR.
 */

import { logger as safeLogger } from "./logger";

// =====================================================================
//   runComplianceAfterLink — moved from callIntelligenceRoutes.ts
// =====================================================================

/**
 * Run the Zoho-backed CRM compliance check for a call that was just
 * linked to a Lead/Deal, and persist the result via saveCompliance.
 * Best-effort: any failure (Zoho unreachable, missing fields, etc.)
 * is swallowed so the originating auto-link call still returns
 * success. Mirrors the body of /api/calls/:callId/compliance but
 * without the HTTP wrapper so it can be called from other handlers.
 */
export async function runComplianceAfterLink(
  callId: number,
  leadId: string | null | undefined,
  dealId: string | null | undefined,
  callDate: any,
  logger?: any,
): Promise<void> {
  try {
    if (!leadId && !dealId) return;
    const { saveCompliance } = await import("./callIntelligenceDb");
    const { runCrmComplianceCheck } = await import("./crmComplianceCheck");
    const expectedActions = [
      "notes_updated",
      "call_logged",
      "task_created",
      "stage_updated",
    ];
    const checked = await runCrmComplianceCheck({
      callRecordId: callId,
      leadId: leadId ?? undefined,
      dealId: dealId ?? undefined,
      callDate,
      expectedActions,
    });
    if (!checked.success || !checked.result) {
      await saveCompliance({
        call_record_id: callId,
        lead_id: leadId ?? undefined,
        deal_id: dealId ?? undefined,
        notes_updated: false,
        call_logged: false,
        task_created: false,
        stage_updated: false,
        meeting_outcome_logged: false,
        overall_compliance: false,
        compliance_score: 0,
        missing_actions: [`Not checked: ${checked.reason}`],
        compliance_details: { mode: "not_checked", reason: checked.reason },
      });
      logger?.info("[Compliance] auto-run skipped after link", {
        callId,
        reason: checked.reason,
      });
      return;
    }
    const r = checked.result;
    await saveCompliance({
      call_record_id: callId,
      lead_id: leadId ?? undefined,
      deal_id: dealId ?? undefined,
      notes_updated: r.notes_updated,
      call_logged: r.call_logged,
      task_created: r.task_created,
      stage_updated: r.stage_updated,
      meeting_outcome_logged: r.meeting_outcome_logged,
      overall_compliance: r.overall_compliance,
      compliance_score: r.compliance_score,
      missing_actions: r.missing_actions,
      compliance_details: r.evidence,
    });
    logger?.info("[Compliance] auto-ran after link", {
      callId,
      score: r.compliance_score,
    });
  } catch (err: any) {
    safeLogger.warn("[Compliance] auto-run after link threw", {
      callId,
      error: err?.message || String(err),
    });
  }
}

// =====================================================================
//   autoLinkCallAndCompliance — new shared wrapper
// =====================================================================

export interface AutoLinkAndComplianceOptions {
  logger?: any;
  /**
   * Short string included in log payloads so /ingest and /upload calls
   * can be distinguished in operational logs. e.g. "ingest", "manual upload".
   * Default: "auto-link".
   */
  logTag?: string;
}

export interface AutoLinkAndComplianceResult {
  /**
   * True only when a Zoho Lead or Deal was actually linked to this call
   * record. False when the record already had a manual link (skipped),
   * when phone-matching drew a blank, or when the linker threw.
   */
  linked: boolean;
  linked_via?: string | null;
  picked_module?: string | null;
  lead_id?: string | null;
  deal_id?: string | null;
  reason?: string;
  /** True if an error was caught and swallowed (still safe to return success). */
  threw?: boolean;
}

/**
 * Auto-link a freshly-created call record to a Zoho Lead/Deal, then
 * run the CRM compliance check. Best-effort throughout — never throws.
 *
 * Skip semantics: if the callRecord already has a `lead_id` or `deal_id`,
 * we treat it as manually linked and do not overwrite. The compliance
 * check is also skipped in that case (the caller can run it later if
 * desired, but we don't want to double-fire on the same link event).
 */
export async function autoLinkCallAndCompliance(
  callRecord: {
    id?: number;
    agent_email?: string | null;
    agent_name?: string | null;
    call_date?: any;
    lead_id?: string | number | null;
    deal_id?: string | number | null;
    [key: string]: any;
  },
  options: AutoLinkAndComplianceOptions = {},
): Promise<AutoLinkAndComplianceResult> {
  const { logger } = options;
  const logTag = options.logTag || "auto-link";

  // Skip if the record was already linked by the caller (manual link wins).
  if (callRecord.lead_id || callRecord.deal_id) {
    return {
      linked: false,
      reason: "already_linked",
    };
  }

  try {
    const { autoLinkCallToCrm } = await import("./sdrCallLinking");
    const { extractCallPhoneCandidates } = await import("./callLeadPhoneMatch");
    const {
      updateCallRecordLeadId,
      updateCallRecordDealId,
      updateCallRecordLinkedVia,
    } = await import("./callIntelligenceDb");

    const candidates = extractCallPhoneCandidates(callRecord);
    const linkResult = await autoLinkCallToCrm(
      callRecord.id!,
      candidates,
      updateCallRecordLeadId,
      updateCallRecordDealId,
      {
        // Activity-based fallback: if phone matching draws a blank,
        // look for CRM activities the same agent did on the same day
        // so the link still lands.
        agentEmail: callRecord.agent_email || undefined,
        agentName: callRecord.agent_name || null,
        callDate: callRecord.call_date
          ? new Date(callRecord.call_date)
          : new Date(),
      },
    );

    if (linkResult.linked) {
      logger?.info(`🔗 [${logTag}] Auto-linked call to Zoho`, {
        callId: callRecord.id,
        module: linkResult.picked_module,
        recordId: linkResult.lead_id || linkResult.deal_id,
        linked_via: linkResult.linked_via,
      });

      if (linkResult.linked_via) {
        try {
          await updateCallRecordLinkedVia(
            callRecord.id!,
            linkResult.linked_via,
          );
        } catch {
          // diagnostic field only — never fail the pipeline on this
        }
      }

      // Auto-trigger the CRM compliance check now that the call has
      // a Zoho Lead/Deal to score against, so the top-level Compliance
      // Rate KPI populates without manual action.
      await runComplianceAfterLink(
        callRecord.id!,
        linkResult.lead_id ?? null,
        linkResult.deal_id ?? null,
        callRecord.call_date,
        logger,
      );

      return {
        linked: true,
        linked_via: linkResult.linked_via,
        picked_module: linkResult.picked_module,
        lead_id: linkResult.lead_id ?? null,
        deal_id: linkResult.deal_id ?? null,
      };
    }

    logger?.info(`ℹ️ [${logTag}] Auto-link skipped/failed`, {
      callId: callRecord.id,
      reason: linkResult.reason,
    });
    return {
      linked: false,
      reason: linkResult.reason,
    };
  } catch (err: any) {
    // Auto-link is best-effort — never fail the enclosing request
    // because of a CRM lookup hiccup.
    logger?.warn(`[${logTag}] Auto-link threw, continuing`, {
      callId: callRecord.id,
      error: err?.message || String(err),
    });
    return {
      linked: false,
      reason: "error",
      threw: true,
    };
  }
}
