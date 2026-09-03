import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const crmComplianceTool = createTool({
  id: "crm-compliance-tool",
  description: "Validates CRM compliance after a call by checking if the agent properly updated CRMProvider CRM with notes, call logs, tasks, stage updates, and meeting outcomes.",
  inputSchema: z.object({
    call_record_id: z.number().describe("ID of the call record to check compliance for"),
    lead_id: z.string().optional().describe("CRMProvider Lead ID to check"),
    deal_id: z.string().optional().describe("CRMProvider Deal ID to check"),
    expected_actions: z.array(z.enum([
      "notes_updated",
      "call_logged", 
      "task_created",
      "stage_updated",
      "meeting_outcome_logged"
    ])).optional().describe("List of expected CRM actions to verify"),
    check_window_hours: z.number().default(24).describe("Hours after call to check for CRM updates")
  }),
  outputSchema: z.object({
    success: z.boolean(),
    call_record_id: z.number(),
    compliance: z.object({
      notes_updated: z.boolean(),
      call_logged: z.boolean(),
      task_created: z.boolean(),
      stage_updated: z.boolean(),
      meeting_outcome_logged: z.boolean(),
      overall_compliance: z.boolean(),
      compliance_score: z.number(),
      missing_actions: z.array(z.string()),
      details: z.record(z.any()).optional()
    }).optional(),
    message: z.string()
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔍 [CRMCompliance] Starting compliance check", { 
      call_record_id: context.call_record_id,
      lead_id: context.lead_id,
      deal_id: context.deal_id
    });

    try {
      const { 
        saveCompliance, 
        getCallRecordById 
      } = await import("../../utils/callIntelligenceDb");

      const callRecord = await getCallRecordById(context.call_record_id);
      if (!callRecord) {
        throw new Error(`Call record not found: ${context.call_record_id}`);
      }

      const leadId = context.lead_id || callRecord.lead_id;
      const dealId = context.deal_id || callRecord.deal_id;

      let notesUpdated = false;
      let callLogged = false;
      let taskCreated = false;
      let stageUpdated = false;
      let meetingOutcomeLogged = false;
      const complianceDetails: Record<string, any> = {};

      // Route ALL CRMProvider traffic through the shared CRMProviderCRM helper so the
      // OAuth cooldown, singleflight, and token caching enforced in
      // src/utils/CRMProviderCRM.ts apply to this tool too. Previously this tool
      // had its own raw fetch to /oauth/v2/token and CRMProvider APIs, which
      // bypassed the cooldown entirely — under load it kept burning the
      // per-account OAuth quota even while the rest of the app was
      // honoring the rate-limit window.
      const {
        getCRMProviderConnectionStatus,
        getValidAccessToken,
      } = await import("../../utils/CRMProviderCRM");

      const CRMProviderStatus = getCRMProviderConnectionStatus();
      if (CRMProviderStatus.configured) {
        logger?.info("📡 [CRMCompliance] Checking CRMProvider CRM for updates");

        try {
          // Single token acquisition routed through the shared helper so
          // the OAuth cooldown + singleflight + token cache all apply.
          // The returned token is cached for the session, so the four
          // CRM reads below reuse it without re-hitting /oauth/v2/token.
          const accessToken = await getValidAccessToken();
          const apiDomain = process.env.CRMProvider_API_DOMAIN || "<REDACTED_URL>";
          const authHeader = { Authorization: `CRMProvider-oauthtoken ${accessToken}` };

          if (leadId) {
            const callDate = callRecord.call_date ? new Date(callRecord.call_date) : new Date();

            const authedFetch = async (url: string): Promise<any | null> => {
              const resp = await fetch(url, { headers: authHeader });
              return resp.ok ? await resp.json() : null;
            };

            const notesData = await authedFetch(
              `<REDACTED_URL>`,
            );
            if (notesData?.data?.length) {
              const recentNote = notesData.data.find(
                (note: any) => new Date(note.Created_Time) >= callDate,
              );
              notesUpdated = !!recentNote;
              complianceDetails.notes = notesUpdated
                ? "Note found after call"
                : "No note found after call";
            }

            const callsData = await authedFetch(
              `<REDACTED_URL>`,
            );
            if (callsData?.data?.length) {
              const recentCall = callsData.data.find(
                (call: any) => new Date(call.Created_Time) >= callDate,
              );
              callLogged = !!recentCall;
              complianceDetails.calls = callLogged
                ? "Call logged after call"
                : "No call log found";
            }

            const tasksData = await authedFetch(
              `<REDACTED_URL>`,
            );
            if (tasksData?.data?.length) {
              const recentTask = tasksData.data.find(
                (task: any) => new Date(task.Created_Time) >= callDate,
              );
              taskCreated = !!recentTask;
              complianceDetails.tasks = taskCreated
                ? "Task created after call"
                : "No task found";
            }

            const leadData = await authedFetch(
              `<REDACTED_URL>`,
            );
            if (leadData?.data?.[0]) {
              const lead = leadData.data[0];
              const modifiedTime = new Date(lead.Modified_Time);
              stageUpdated = modifiedTime >= callDate;
              complianceDetails.stage = stageUpdated
                ? "Lead modified after call"
                : "No stage update detected";
            }
          }
        } catch (CRMProviderError) {
          const isRateLimited =
            CRMProviderError && typeof CRMProviderError === "object" &&
            (CRMProviderError as { isCRMProviderRateLimited?: boolean }).isCRMProviderRateLimited === true;
          logger?.error("❌ [CRMCompliance] CRMProvider API error", {
            error: CRMProviderError instanceof Error ? CRMProviderError.message : String(CRMProviderError),
            rateLimited: isRateLimited,
          });
          complianceDetails.mode = isRateLimited ? "CRMProvider_rate_limited" : "CRMProvider_error";
          complianceDetails.error =
            CRMProviderError instanceof Error ? CRMProviderError.message : String(CRMProviderError);
        }
      } else {
        logger?.warn("⚠️ [CRMCompliance] CRMProvider credentials not configured, cannot check CRM compliance");
        complianceDetails.mode = "not_configured";
        complianceDetails.error = "CRMProvider CRM credentials not configured";
      }

      const missingActions: string[] = [];
      const expectedActions = context.expected_actions || [
        "notes_updated", "call_logged", "task_created"
      ];

      if (expectedActions.includes("notes_updated") && !notesUpdated) {
        missingActions.push("Notes not updated after call");
      }
      if (expectedActions.includes("call_logged") && !callLogged) {
        missingActions.push("Call not logged in CRM");
      }
      if (expectedActions.includes("task_created") && !taskCreated) {
        missingActions.push("No follow-up task created");
      }
      if (expectedActions.includes("stage_updated") && !stageUpdated) {
        missingActions.push("Lead/Deal stage not updated");
      }
      if (expectedActions.includes("meeting_outcome_logged") && !meetingOutcomeLogged) {
        missingActions.push("Meeting outcome not logged");
      }

      const totalChecks = expectedActions.length;
      const passedChecks = totalChecks - missingActions.length;
      const complianceScore = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;
      const overallCompliance = missingActions.length === 0;

      const savedCompliance = await saveCompliance({
        call_record_id: context.call_record_id,
        lead_id: leadId,
        deal_id: dealId,
        notes_updated: notesUpdated,
        call_logged: callLogged,
        task_created: taskCreated,
        stage_updated: stageUpdated,
        meeting_outcome_logged: meetingOutcomeLogged,
        overall_compliance: overallCompliance,
        compliance_score: complianceScore,
        missing_actions: missingActions,
        compliance_details: complianceDetails
      });

      logger?.info("✅ [CRMCompliance] Compliance check completed", { 
        id: savedCompliance.id,
        compliance_score: complianceScore,
        missing_count: missingActions.length
      });

      return {
        success: true,
        call_record_id: context.call_record_id,
        compliance: {
          notes_updated: notesUpdated,
          call_logged: callLogged,
          task_created: taskCreated,
          stage_updated: stageUpdated,
          meeting_outcome_logged: meetingOutcomeLogged,
          overall_compliance: overallCompliance,
          compliance_score: complianceScore,
          missing_actions: missingActions,
          details: complianceDetails
        },
        message: overallCompliance 
          ? "CRM compliance check passed - all expected actions completed" 
          : `CRM compliance issues found: ${missingActions.length} missing actions`
      };
    } catch (error) {
      logger?.error("❌ [CRMCompliance] Compliance check failed", { 
        error: error instanceof Error ? error.message : String(error) 
      });

      return {
        success: false,
        call_record_id: context.call_record_id,
        message: `Compliance check failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
});
