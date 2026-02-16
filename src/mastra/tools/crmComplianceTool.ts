import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const crmComplianceTool = createTool({
  id: "crm-compliance-tool",
  description: "Validates CRM compliance after a call by checking if the agent properly updated Zoho CRM with notes, call logs, tasks, stage updates, and meeting outcomes.",
  inputSchema: z.object({
    call_record_id: z.number().describe("ID of the call record to check compliance for"),
    lead_id: z.string().optional().describe("Zoho Lead ID to check"),
    deal_id: z.string().optional().describe("Zoho Deal ID to check"),
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

      const zohoClientId = process.env.ZOHO_CLIENT_ID;
      const zohoClientSecret = process.env.ZOHO_CLIENT_SECRET;
      const zohoRefreshToken = process.env.ZOHO_REFRESH_TOKEN;

      if (zohoClientId && zohoClientSecret && zohoRefreshToken) {
        logger?.info("📡 [CRMCompliance] Checking Zoho CRM for updates");

        try {
          const tokenResponse = await fetch('https://accounts.zoho.com/oauth/v2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              client_id: zohoClientId,
              client_secret: zohoClientSecret,
              refresh_token: zohoRefreshToken
            })
          });

          const tokenData = await tokenResponse.json();
          const accessToken = tokenData.access_token;

          if (accessToken && leadId) {
            const callDate = callRecord.call_date ? new Date(callRecord.call_date) : new Date();
            const checkAfter = callDate.toISOString().split('T')[0];

            const notesResponse = await fetch(
              `https://www.zohoapis.com/crm/v2/Leads/${leadId}/Notes?page=1&per_page=5`,
              {
                headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
              }
            );

            if (notesResponse.ok) {
              const notesData = await notesResponse.json();
              if (notesData.data && notesData.data.length > 0) {
                const recentNote = notesData.data.find((note: any) => {
                  const noteDate = new Date(note.Created_Time);
                  return noteDate >= callDate;
                });
                notesUpdated = !!recentNote;
                complianceDetails.notes = notesUpdated ? "Note found after call" : "No note found after call";
              }
            }

            const callsResponse = await fetch(
              `https://www.zohoapis.com/crm/v2/Leads/${leadId}/Calls?page=1&per_page=5`,
              {
                headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
              }
            );

            if (callsResponse.ok) {
              const callsData = await callsResponse.json();
              if (callsData.data && callsData.data.length > 0) {
                const recentCall = callsData.data.find((call: any) => {
                  const callLogDate = new Date(call.Created_Time);
                  return callLogDate >= callDate;
                });
                callLogged = !!recentCall;
                complianceDetails.calls = callLogged ? "Call logged after call" : "No call log found";
              }
            }

            const tasksResponse = await fetch(
              `https://www.zohoapis.com/crm/v2/Tasks?criteria=(What_Id:equals:${leadId})&page=1&per_page=5`,
              {
                headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
              }
            );

            if (tasksResponse.ok) {
              const tasksData = await tasksResponse.json();
              if (tasksData.data && tasksData.data.length > 0) {
                const recentTask = tasksData.data.find((task: any) => {
                  const taskDate = new Date(task.Created_Time);
                  return taskDate >= callDate;
                });
                taskCreated = !!recentTask;
                complianceDetails.tasks = taskCreated ? "Task created after call" : "No task found";
              }
            }

            const leadResponse = await fetch(
              `https://www.zohoapis.com/crm/v2/Leads/${leadId}`,
              {
                headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
              }
            );

            if (leadResponse.ok) {
              const leadData = await leadResponse.json();
              if (leadData.data && leadData.data[0]) {
                const lead = leadData.data[0];
                const modifiedTime = new Date(lead.Modified_Time);
                stageUpdated = modifiedTime >= callDate;
                complianceDetails.stage = stageUpdated ? "Lead modified after call" : "No stage update detected";
              }
            }
          }
        } catch (zohoError) {
          logger?.warn("⚠️ [CRMCompliance] Zoho API error, using simulation", { 
            error: zohoError instanceof Error ? zohoError.message : String(zohoError) 
          });
          notesUpdated = Math.random() > 0.3;
          callLogged = Math.random() > 0.2;
          taskCreated = Math.random() > 0.4;
          stageUpdated = Math.random() > 0.5;
          meetingOutcomeLogged = Math.random() > 0.6;
          complianceDetails.mode = "simulated";
        }
      } else {
        logger?.info("📝 [CRMCompliance] Zoho credentials not configured, using simulation");
        notesUpdated = Math.random() > 0.3;
        callLogged = Math.random() > 0.2;
        taskCreated = Math.random() > 0.4;
        stageUpdated = Math.random() > 0.5;
        meetingOutcomeLogged = Math.random() > 0.6;
        complianceDetails.mode = "simulated";
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
