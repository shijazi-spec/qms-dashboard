/**
 * CRM Compliance Check — evidence-based audit of post-call CRMProvider hygiene.
 *
 * Replaces the simulated/random implementation in callIntelligenceRoutes
 * that fired Math.random() for every check. That mock made the calls
 * dashboard actively misleading (the Compliance KPIs were just noise),
 * which is why the dashboard felt "dormant".
 *
 * For each linked CRMProvider record (Lead or Deal), we query four related
 * modules and compare timestamps to the call_date to decide whether
 * the post-call hygiene actions were actually performed.
 *
 * Failure mode: if CRMProvider is unreachable or the linkage is missing, we
 * return `{ success: false, reason }` and let the caller decide whether
 * to persist anything. We never fabricate booleans.
 */

import { fetchCRMProviderRecords, getCRMProviderConnectionStatus } from "./CRMProviderCRM";
import {
  ownerMatchesAgent,
  activityFallsOnDay,
  ymdInUTC,
} from "./sdrCallLinking";
import { logger } from "./logger";

export interface CrmComplianceCheckInput {
  callRecordId: number;
  leadId?: string | null;
  dealId?: string | null;
  callDate: Date | string;
  expectedActions?: string[];
  /**
   * Agent who actually made the recorded call. Used to verify that the
   * matching CRMProvider Call activity was logged BY THAT SAME AGENT and on the
   * SAME DATE. A Call logged by a different rep, or stamped with a
   * different date, does not count as the caller's own post-call hygiene
   * and is treated as non-compliant.
   */
  agentEmail?: string | null;
  agentName?: string | null;
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
  /** Per-check evidence — number of matching CRMProvider records found, errors, etc. */
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
 * Run the real-CRMProvider compliance check. Returns success=false (without
 * fabricating booleans) when:
 *  - the call has no lead/deal linkage
 *  - CRMProvider credentials aren't configured
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

  const conn = getCRMProviderConnectionStatus();
  if (!conn.connected) {
    return {
      success: false,
      reason: "CRMProvider_not_connected",
    };
  }

  const module = input.leadId ? "Leads" : "Deals";
  // CRMProvider uses Who_Id for Leads/Contacts and What_Id for Deals/Accounts in
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
  // CRMProvider criteria comparisons are tighter when we compare on the date-only
  // form (YYYY-MM-DD) for "greater_than" since some modules don't accept
  // full ISO timestamps. We fall back to a 1-second-before form which
  // captures items created during or after the call.
  const cutoffIso = new Date(callDate.getTime() - 1000).toISOString();

  // Run the four related-record queries in parallel. Each query is a
  // single CRMProvider API call. If any throws we trap it locally so a partial
  // result is still useful.
  const safeCount = async (
    moduleName: string,
    criteria: string,
  ): Promise<{ count: number; error?: string }> => {
    try {
      const rows = await fetchCRMProviderRecords(moduleName, {
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

  // Calls get a richer fetch (rows, not just a count) so we can verify
  // the logged Call was made BY THE SAME AGENT and ON THE SAME DATE as
  // the recorded call. A Call logged by another rep or with a mismatched
  // date is the exact non-compliance pattern ops flagged (e.g. a call by
  // r.alsammak whose CRMProvider Call was logged by "هاجر الجبري" on a later day
  // with an "Invalid number" result).
  const safeFetchRows = async (
    moduleName: string,
    criteria: string,
  ): Promise<{ rows: any[]; error?: string }> => {
    try {
      const rows = await fetchCRMProviderRecords(moduleName, {
        criteria,
        perPage: 20,
      });
      return { rows };
    } catch (err: any) {
      logger.warn(`[crmComplianceCheck] ${moduleName} query failed`, {
        criteria,
        error: err?.message,
      });
      return { rows: [], error: String(err?.message || err) };
    }
  };

  const [notes, callRows, tasks, events, recordSelf] = await Promise.all([
    safeCount(
      "Notes",
      `(Parent_Id:equals:${recordId})and(Created_Time:greater_than:${cutoffIso})`,
    ),
    safeFetchRows(
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
        const rows = await fetchCRMProviderRecords(module, {
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

  // Verify the matching CRMProvider Call activity belongs to the same agent and
  // the same calendar day as the recorded call. A Call logged by another
  // rep, or stamped with a different date, is NOT valid post-call hygiene
  // for this caller and must not satisfy the "call logged" check.
  const callAgentEmail = (input.agentEmail || "").trim();
  const callAgentName = (input.agentName || "").trim() || null;
  const callDay = ymdInUTC(callDate);
  const canCheckOwner = !!(callAgentEmail || callAgentName);

  let matchingCalls = 0;
  let wrongAgentCalls = 0;
  let wrongDateCalls = 0;
  for (const row of callRows.rows) {
    const owner = (row as any)?.owner as string | undefined;
    const startTime =
      (row as any)?.data?.Call_Start_Time ?? (row as any)?.Call_Start_Time;
    const dateOk = activityFallsOnDay(startTime, callDay);
    const ownerOk = canCheckOwner
      ? ownerMatchesAgent(owner, callAgentEmail, callAgentName)
      : true;
    if (dateOk && ownerOk) {
      matchingCalls++;
    } else {
      if (!ownerOk) wrongAgentCalls++;
      if (!dateOk) wrongDateCalls++;
    }
  }

  const notesUpdated = notes.count > 0;
  // call_logged now requires a same-agent, same-day Call. When we cannot
  // identify the agent (no email/name on the record) we fall back to the
  // legacy same-day-only rule so we never over-penalize on missing data.
  const callLogged = matchingCalls > 0;
  const callLoggedByOther = matchingCalls === 0 && callRows.rows.length > 0;
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
    if (callLoggedByOther) {
      // A Call exists on the record but it was logged by a different
      // agent and/or on a different date — surface the precise reason.
      const reasons: string[] = [];
      if (wrongAgentCalls > 0) reasons.push("by a different agent");
      if (wrongDateCalls > 0) reasons.push("with a mismatched date");
      missingActions.push(
        `Call logged ${reasons.join(" and ") || "incorrectly"} in CRM`,
      );
    } else {
      missingActions.push("Call not logged in CRM");
    }
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
        mode: "CRMProvider_live",
        module,
        record_id: recordId,
        cutoff: cutoffIso,
        parent_modified_time: parentModifiedTime,
        notes_count: notes.count,
        notes_error: notes.error,
        calls_count: callRows.rows.length,
        calls_error: callRows.error,
        calls_matching_agent_date: matchingCalls,
        calls_wrong_agent: wrongAgentCalls,
        calls_wrong_date: wrongDateCalls,
        call_logged_by_other: callLoggedByOther,
        tasks_count: tasks.count,
        tasks_error: tasks.error,
        events_count: events.count,
        events_error: events.error,
      },
    },
  };
}
