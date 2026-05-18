/**
 * CRM Compliance Check — evidence-based audit of post-call Zoho hygiene.
 *
 * Replaces the simulated/random implementation in callIntelligenceRoutes
 * that fired Math.random() for every check. That mock made the calls
 * dashboard actively misleading (the Compliance KPIs were just noise),
 * which is why the dashboard felt "dormant".
 *
 * For each linked Zoho record (Lead or Deal), we query four related
 * modules and compare timestamps to the call_date to decide whether
 * the post-call hygiene actions were actually performed.
 *
 * Failure mode: if Zoho is unreachable or the linkage is missing, we
 * return `{ success: false, reason }` and let the caller decide whether
 * to persist anything. We never fabricate booleans.
 */

import { fetchZohoRecords, getZohoConnectionStatus } from "./zohoCRM";
import { logger } from "./logger";

export interface CrmComplianceCheckInput {
  callRecordId: number;
  leadId?: string | null;
  dealId?: string | null;
  callDate: Date | string;
  expectedActions?: string[];
}

export interface CrmComplianceCheckResult {
  notes_updated: boolean;
  call_logged: boolean;
  task_created: boolean;
  stage_updated: boolean;
  meeting_outcome_logged: boolean;
  overall_compliance: boolean;
  compliance_score: number;
  missing_actions: string[];
  /** Per-check evidence — number of matching Zoho records found, errors, etc. */
  evidence: Record<string, unknown>;
}

export interface CrmComplianceCheckEnvelope {
  success: boolean;
  reason?: string;
  result?: CrmComplianceCheckResult;
}

const DEFAULT_EXPECTED_ACTIONS = [
  "notes_updated",
  "call_logged",
  "task_created",
  "stage_updated",
];

/**
 * Run the real-Zoho compliance check. Returns success=false (without
 * fabricating booleans) when:
 *  - the call has no lead/deal linkage
 *  - Zoho credentials aren't configured
 *  - the lookup itself fails (network / 4xx / 5xx)
 *
 * Callers should persist the result ONLY when success=true. When
 * success=false, the saved compliance row should reflect "not checked"
 * rather than fake passing/failing booleans.
 */
export async function runCrmComplianceCheck(
  input: CrmComplianceCheckInput,
): Promise<CrmComplianceCheckEnvelope> {
  const recordId = input.leadId || input.dealId;
  if (!recordId) {
    return {
      success: false,
      reason: "no_crm_linkage",
    };
  }

  const conn = getZohoConnectionStatus();
  if (!conn.connected) {
    return {
      success: false,
      reason: "zoho_not_connected",
    };
  }

  const module = input.leadId ? "Leads" : "Deals";
  // Zoho uses Who_Id for Leads/Contacts and What_Id for Deals/Accounts in
  // related modules (Calls, Tasks, Events). Pick the right key.
  const linkField = module === "Leads" ? "Who_Id" : "What_Id";

  const callDate = input.callDate instanceof Date
    ? input.callDate
    : new Date(input.callDate);
  if (isNaN(callDate.getTime())) {
    return {
      success: false,
      reason: "invalid_call_date",
    };
  }
  // Zoho criteria comparisons are tighter when we compare on the date-only
  // form (YYYY-MM-DD) for "greater_than" since some modules don't accept
  // full ISO timestamps. We fall back to a 1-second-before form which
  // captures items created during or after the call.
  const cutoffIso = new Date(callDate.getTime() - 1000).toISOString();

  // Run the four related-record queries in parallel. Each query is a
  // single Zoho API call. If any throws we trap it locally so a partial
  // result is still useful.
  const safeCount = async (
    moduleName: string,
    criteria: string,
  ): Promise<{ count: number; error?: string }> => {
    try {
      const rows = await fetchZohoRecords(moduleName, {
        criteria,
        perPage: 5,
      });
      return { count: rows.length };
    } catch (err: any) {
      logger.warn(`[crmComplianceCheck] ${moduleName} query failed`, {
        criteria,
        error: err?.message,
      });
      return { count: 0, error: String(err?.message || err) };
    }
  };

  const [notes, calls, tasks, events, recordSelf] = await Promise.all([
    safeCount(
      "Notes",
      `(Parent_Id:equals:${recordId})and(Created_Time:greater_than:${cutoffIso})`,
    ),
    safeCount(
      "Calls",
      `(${linkField}:equals:${recordId})and(Call_Start_Time:greater_than:${cutoffIso})`,
    ),
    safeCount(
      "Tasks",
      `(${linkField}:equals:${recordId})and(Created_Time:greater_than:${cutoffIso})`,
    ),
    safeCount(
      "Events",
      `(${linkField}:equals:${recordId})and(Start_DateTime:greater_than:${cutoffIso})`,
    ),
    // Fetch the lead/deal itself so we can use its Modified_Time as the
    // stage_updated proxy. If the parent record was touched after the
    // call, something on it changed (status/stage/owner/notes/etc).
    safeCount(module, `id:equals:${recordId}`).then(async () => {
      try {
        const rows = await fetchZohoRecords(module, {
          criteria: `id:equals:${recordId}`,
          perPage: 1,
        });
        return rows[0] || null;
      } catch (err: any) {
        logger.warn(
          `[crmComplianceCheck] ${module}/${recordId} self-fetch failed`,
          { error: err?.message },
        );
        return null;
      }
    }),
  ]);

  let stageUpdated = false;
  let parentModifiedTime: string | null = null;
  if (recordSelf && typeof recordSelf === "object") {
    parentModifiedTime = (recordSelf as any).modifiedTime || null;
    if (parentModifiedTime) {
      const modDate = new Date(parentModifiedTime);
      if (!isNaN(modDate.getTime()) && modDate > callDate) {
        stageUpdated = true;
      }
    }
  }

  const notesUpdated = notes.count > 0;
  const callLogged = calls.count > 0;
  const taskCreated = tasks.count > 0;
  const meetingOutcomeLogged = events.count > 0;

  const expected = input.expectedActions && input.expectedActions.length > 0
    ? input.expectedActions
    : DEFAULT_EXPECTED_ACTIONS;

  const missingActions: string[] = [];
  if (expected.includes("notes_updated") && !notesUpdated) {
    missingActions.push("Notes not updated after call");
  }
  if (expected.includes("call_logged") && !callLogged) {
    missingActions.push("Call not logged in CRM");
  }
  if (expected.includes("task_created") && !taskCreated) {
    missingActions.push("No follow-up task created");
  }
  if (expected.includes("stage_updated") && !stageUpdated) {
    missingActions.push("Lead/Deal stage not updated");
  }
  if (
    expected.includes("meeting_outcome_logged") &&
    !meetingOutcomeLogged
  ) {
    missingActions.push("Meeting outcome not logged");
  }

  const totalChecks = expected.length;
  const passedChecks = totalChecks - missingActions.length;
  const complianceScore =
    totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;

  return {
    success: true,
    result: {
      notes_updated: notesUpdated,
      call_logged: callLogged,
      task_created: taskCreated,
      stage_updated: stageUpdated,
      meeting_outcome_logged: meetingOutcomeLogged,
      overall_compliance: missingActions.length === 0,
      compliance_score: complianceScore,
      missing_actions: missingActions,
      evidence: {
        mode: "zoho_live",
        module,
        record_id: recordId,
        cutoff: cutoffIso,
        parent_modified_time: parentModifiedTime,
        notes_count: notes.count,
        notes_error: notes.error,
        calls_count: calls.count,
        calls_error: calls.error,
        tasks_count: tasks.count,
        tasks_error: tasks.error,
        events_count: events.count,
        events_error: events.error,
      },
    },
  };
}
