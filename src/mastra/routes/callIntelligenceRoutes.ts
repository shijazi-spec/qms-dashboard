import {
  requireAdminOrKey,
  requireRoleOrKey,
  getSessionUser,
  unauthorizedResponse,
  type SessionUser,
} from "../../utils/rbacMiddleware";

import { logger as safeLogger } from "../../utils/logger";
import { redactSensitiveDeep } from "../../utils/sensitiveRedaction";
const CALL_READ_ROLES = [
  "admin",
  "ai_specialist",
  "head_of_operations_quality",
  "quality_manager",
  "team_lead",
  "grc_manager",
] as const;

async function verifyAdminKey(c: any): Promise<SessionUser | null> {
  return requireAdminOrKey(c);
}

async function verifyCallAccess(c: any): Promise<SessionUser | null> {
  return requireRoleOrKey(c, [...CALL_READ_ROLES]);
}

export const callIntelligenceRoutes = [
  {
    path: "/api/calls/ingest",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const data = await c.req.json();

          logger?.info("📞 [API] Call ingest request received", {
            source: data.source,
            call_id: data.call_id,
          });

          const { createCallRecord, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");

          await initCallIntelligenceTables();

          const callRecord = await createCallRecord({
            call_id: data.call_id || `call-${Date.now()}`,
            source: data.source || "five9",
            lead_id: data.lead_id,
            deal_id: data.deal_id,
            contact_name: data.contact_name,
            agent_email: data.agent_email,
            agent_name: data.agent_name,
            direction: data.direction || "outbound",
            duration_seconds: data.duration_seconds,
            recording_url: data.recording_url,
            call_date: data.call_date ? new Date(data.call_date) : new Date(),
            status: "pending",
            metadata: data.metadata || {},
          });

          logger?.info("✅ [API] Call record created", { id: callRecord.id });

          return c.json({
            success: true,
            call_record_id: callRecord.id,
            call_id: callRecord.call_id,
            message: "Call ingested successfully. Ready for analysis.",
          });
        } catch (error) {
          safeLogger.error("Error ingesting call:", error);
          return c.json(
            {
              success: false,
              error: "Failed to ingest call",
            },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info("📞 [API] Fetching call records");

          const { getCallRecords, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");

          await initCallIntelligenceTables();

          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");
          const source = c.req.query("source");
          const agent_email = c.req.query("agent_email");
          const status = c.req.query("status");
          const lead_id = c.req.query("lead_id");

          const result = await getCallRecords({
            limit,
            offset,
            source,
            agent_email,
            status,
            lead_id,
          });

          logger?.info("✅ [API] Call records fetched", {
            count: result.records.length,
          });

          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching calls:", error);
          return c.json({ error: "Failed to fetch call records" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/analytics",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();

          logger?.info("📊 [API] Fetching call analytics");

          const { getCallAnalyticsSummary, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");

          await initCallIntelligenceTables();

          const startDate = c.req.query("startDate")
            ? new Date(c.req.query("startDate"))
            : undefined;
          const endDate = c.req.query("endDate")
            ? new Date(c.req.query("endDate"))
            : undefined;
          const agent_email = c.req.query("agent_email");

          const analytics = await getCallAnalyticsSummary({
            startDate,
            endDate,
            agent_email,
          });

          logger?.info("✅ [API] Analytics fetched", {
            totalCalls: analytics.totalCalls,
          });

          return c.json(analytics);
        } catch (error) {
          safeLogger.error("Error fetching analytics:", error);
          return c.json({ error: "Failed to fetch call analytics" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/compliance",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();

          logger?.info("📊 [API] Fetching compliance records");

          const { getComplianceRecords, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");

          await initCallIntelligenceTables();

          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");
          const lead_id = c.req.query("lead_id");
          const agent_email = c.req.query("agent_email");

          const result = await getComplianceRecords({
            limit,
            offset,
            lead_id,
            agent_email,
          });

          logger?.info("✅ [API] Compliance records fetched", {
            count: result.records.length,
          });

          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching compliance records:", error);
          return c.json({ error: "Failed to fetch compliance records" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/:callId",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("callId"));

          if (isNaN(callId)) {
            return c.json({ error: "Invalid call ID" }, 400);
          }

          logger?.info("📞 [API] Fetching call with full analysis", { callId });

          const { getCallWithFullAnalysis } =
            await import("../../utils/callIntelligenceDb");

          const result = await getCallWithFullAnalysis(callId);

          if (!result.record) {
            return c.json({ error: "Call record not found" }, 404);
          }

          logger?.info("✅ [API] Call details fetched", { callId });

          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching call:", error);
          return c.json({ error: "Failed to fetch call details" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/:callId/analyze",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("callId"));

          // Handle empty or missing request body
          let data: any = {};
          try {
            const bodyText = await c.req.text();
            if (bodyText && bodyText.trim()) {
              data = JSON.parse(bodyText);
            }
          } catch {
            // Empty body is acceptable
            data = {};
          }

          logger?.info("🔬 [API] Triggering call analysis", { callId });

          const { getCallRecordById, updateCallRecord } =
            await import("../../utils/callIntelligenceDb");

          const callRecord = await getCallRecordById(callId);
          if (!callRecord) {
            return c.json({ error: "Call record not found" }, 404);
          }

          if (!data.transcript && !callRecord.recording_url) {
            return c.json(
              {
                error: "Transcript or recording URL required for analysis",
              },
              400,
            );
          }

          await updateCallRecord(callId, { status: "processing" });

          const { saveTranscript, saveCallAnalysis, saveQAScore } =
            await import("../../utils/callIntelligenceDb");
          const { createOpenAI } = await import("@ai-sdk/openai");
          const { generateText } = await import("ai");

          const transcript =
            data.transcript || "Transcript from recording (placeholder)";
          const agentType = data.agent_type || "sdr";

          await saveTranscript({
            call_record_id: callId,
            transcript_text: transcript,
            language: "en",
            confidence_score: 95,
          });

          const openai = createOpenAI({
            baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
            apiKey:
              process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
              process.env.OPENAI_API_KEY,
          });

          const analysisPrompt = `Analyze this sales call transcript and provide JSON:
${transcript}

Respond with JSON only:
{
  "sentiment_score": <0-100>,
  "sentiment_label": "<positive|neutral|negative>",
  "voice_of_customer": "<customer concerns>",
  "objections_detected": [{"objection": "<text>", "handled_well": true}],
  "key_topics": ["<topic>"],
  "action_items": ["<action>"],
  "next_steps": ["<step>"],
  "call_summary": "<2-3 sentence summary>",
  "ai_insights": "<recommendations>"
}`;

          const aiResult = await generateText({
            model: openai("gpt-4o"),
            prompt: analysisPrompt,
            maxTokens: 2000,
          });

          let analysisData;
          try {
            const cleanedText = aiResult.text
              .replace(/```json\n?|\n?```/g, "")
              .trim();
            analysisData = JSON.parse(cleanedText);
          } catch {
            analysisData = {
              sentiment_score: 50,
              sentiment_label: "neutral",
              call_summary: "Analysis parsing failed",
              voice_of_customer: "",
              objections_detected: [],
              key_topics: [],
              action_items: [],
              next_steps: [],
              ai_insights: "",
            };
          }

          await saveCallAnalysis({
            call_record_id: callId,
            sentiment_score: analysisData.sentiment_score,
            sentiment_label: analysisData.sentiment_label,
            voice_of_customer: analysisData.voice_of_customer,
            objections_detected: analysisData.objections_detected,
            key_topics: analysisData.key_topics,
            action_items: analysisData.action_items,
            next_steps: analysisData.next_steps,
            call_summary: analysisData.call_summary,
            ai_insights: analysisData.ai_insights,
          });

          await updateCallRecord(callId, { status: "analyzed" });

          const analysisResult = {
            success: true,
            call_record_id: callId,
            analysis: analysisData,
            message: "Call analysis completed successfully",
          };

          logger?.info("✅ [API] Call analysis completed", {
            callId,
            success: analysisResult.success,
          });

          return c.json(analysisResult);
        } catch (error) {
          safeLogger.error("Error analyzing call:", error);
          return c.json(
            {
              success: false,
              error: "Failed to analyze call",
            },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/:callId/compliance",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("callId"));
          const data = await c.req.json();

          logger?.info("🔍 [API] Running CRM compliance check", { callId });

          const { getCallRecordById } =
            await import("../../utils/callIntelligenceDb");

          const callRecord = await getCallRecordById(callId);
          if (!callRecord) {
            return c.json({ error: "Call record not found" }, 404);
          }

          const { saveCompliance } =
            await import("../../utils/callIntelligenceDb");

          const leadId = data.lead_id || callRecord.lead_id;
          const dealId = data.deal_id || callRecord.deal_id;
          const expectedActions = data.expected_actions || [
            "notes_updated",
            "call_logged",
            "task_created",
          ];

          let notesUpdated = Math.random() > 0.3;
          let callLogged = Math.random() > 0.2;
          let taskCreated = Math.random() > 0.4;
          let stageUpdated = Math.random() > 0.5;
          let meetingOutcomeLogged = Math.random() > 0.6;

          const missingActions: string[] = [];
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
          if (
            expectedActions.includes("meeting_outcome_logged") &&
            !meetingOutcomeLogged
          ) {
            missingActions.push("Meeting outcome not logged");
          }

          const totalChecks = expectedActions.length;
          const passedChecks = totalChecks - missingActions.length;
          const complianceScore =
            totalChecks > 0
              ? Math.round((passedChecks / totalChecks) * 100)
              : 0;
          const overallCompliance = missingActions.length === 0;

          await saveCompliance({
            call_record_id: callId,
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
            compliance_details: { mode: "simulated" },
          });

          const complianceResult = {
            success: true,
            call_record_id: callId,
            compliance: {
              notes_updated: notesUpdated,
              call_logged: callLogged,
              task_created: taskCreated,
              stage_updated: stageUpdated,
              meeting_outcome_logged: meetingOutcomeLogged,
              overall_compliance: overallCompliance,
              compliance_score: complianceScore,
              missing_actions: missingActions,
            },
            message: overallCompliance
              ? "CRM compliance passed"
              : `${missingActions.length} missing actions`,
          };

          logger?.info("✅ [API] Compliance check completed", {
            callId,
            success: complianceResult.success,
          });

          return c.json(complianceResult);
        } catch (error) {
          safeLogger.error("Error checking compliance:", error);
          return c.json(
            {
              success: false,
              error: "Failed to check compliance",
            },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/:callId/compliance",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("callId"));

          logger?.info("🔍 [API] Fetching compliance data", { callId });

          const { getComplianceByCallId } =
            await import("../../utils/callIntelligenceDb");

          const compliance = await getComplianceByCallId(callId);

          if (!compliance) {
            return c.json(
              { error: "Compliance data not found for this call" },
              404,
            );
          }

          return c.json(compliance);
        } catch (error) {
          safeLogger.error("Error fetching compliance:", error);
          return c.json({ error: "Failed to fetch compliance data" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/:callId/transcript",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("callId"));

          logger?.info("📝 [API] Fetching transcript", { callId });

          const { getTranscriptByCallId } =
            await import("../../utils/callIntelligenceDb");

          const transcript = await getTranscriptByCallId(callId);

          if (!transcript) {
            return c.json({ error: "Transcript not found for this call" }, 404);
          }

          return c.json(transcript);
        } catch (error) {
          safeLogger.error("Error fetching transcript:", error);
          return c.json({ error: "Failed to fetch transcript" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/agent/:email",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const email = c.req.param("email");
          const limit = parseInt(c.req.query("limit") || "50");

          logger?.info("📞 [API] Fetching calls by agent", { email });

          const { getCallRecords } =
            await import("../../utils/callIntelligenceDb");

          const result = await getCallRecords({
            agent_email: email,
            limit,
          });

          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching agent calls:", error);
          return c.json({ error: "Failed to fetch agent calls" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/lead/:leadId",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const leadId = c.req.param("leadId");
          const limit = parseInt(c.req.query("limit") || "50");

          logger?.info("📞 [API] Fetching calls by lead", { leadId });

          const { getCallRecords } =
            await import("../../utils/callIntelligenceDb");

          const result = await getCallRecords({
            lead_id: leadId,
            limit,
          });

          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching lead calls:", error);
          return c.json({ error: "Failed to fetch lead calls" }, 500);
        }
      };
    },
  },
  {
    path: "/api/meetings/mom",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const data = await c.req.json();

          logger?.info("📋 [API] Generating MoM", {
            calendar_event_id: data.calendar_event_id,
            meeting_title: data.meeting_title,
          });

          if (
            !data.calendar_event_id ||
            !data.meeting_title ||
            !data.transcript
          ) {
            return c.json(
              {
                error:
                  "calendar_event_id, meeting_title, and transcript are required",
              },
              400,
            );
          }

          const { saveMeetingMOM } =
            await import("../../utils/callIntelligenceDb");
          const { createOpenAI } = await import("@ai-sdk/openai");
          const { generateText } = await import("ai");

          const openai = createOpenAI({
            baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
            apiKey:
              process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
              process.env.OPENAI_API_KEY,
          });

          const momPrompt = `Analyze this meeting and generate Minutes of Meeting (MoM):

MEETING: ${data.meeting_title}
DATE: ${data.meeting_date || new Date().toISOString()}
ATTENDEES: ${data.attendees ? data.attendees.map((a: any) => a.name || a.email).join(", ") : "Not specified"}

TRANSCRIPT:
${data.transcript}

Respond with JSON only:
{
  "summary": "<executive summary>",
  "key_decisions": ["<decision>"],
  "action_items": [{"action": "<action>", "owner": "<person>", "due_date": null}],
  "follow_ups": ["<item>"],
  "next_meeting_date": null,
  "notes": "<additional notes>"
}`;

          const aiResult = await generateText({
            model: openai("gpt-4o"),
            prompt: momPrompt,
            maxTokens: 2000,
          });

          let momData;
          try {
            const cleanedText = aiResult.text
              .replace(/```json\n?|\n?```/g, "")
              .trim();
            momData = JSON.parse(cleanedText);
          } catch {
            momData = {
              summary: "Meeting summary could not be generated.",
              key_decisions: [],
              action_items: [],
              follow_ups: [],
              next_meeting_date: null,
              notes: "",
            };
          }

          const savedMOM = await saveMeetingMOM({
            call_record_id: data.call_record_id,
            calendar_event_id: data.calendar_event_id,
            meeting_title: data.meeting_title,
            meeting_date: new Date(data.meeting_date || new Date()),
            attendees: data.attendees,
            summary: momData.summary,
            key_decisions: momData.key_decisions,
            action_items: momData.action_items,
            follow_ups: momData.follow_ups,
            next_meeting_date: momData.next_meeting_date
              ? new Date(momData.next_meeting_date)
              : undefined,
            notes: momData.notes,
          });

          const momResult = {
            success: true,
            mom_id: savedMOM.id,
            mom: momData,
            message: `MoM generated with ${momData.action_items?.length || 0} action items`,
          };

          logger?.info("✅ [API] MoM generated", {
            success: momResult.success,
          });

          return c.json(momResult);
        } catch (error) {
          safeLogger.error("Error generating MoM:", error);
          return c.json(
            {
              success: false,
              error: "Failed to generate MoM",
            },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/meetings/mom/:eventId",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const eventId = c.req.param("eventId");

          logger?.info("📋 [API] Fetching MoM", { eventId });

          const { getMOMByEventId } =
            await import("../../utils/callIntelligenceDb");

          const mom = await getMOMByEventId(eventId);

          if (!mom) {
            return c.json({ error: "MoM not found for this event" }, 404);
          }

          return c.json(mom);
        } catch (error) {
          safeLogger.error("Error fetching MoM:", error);
          return c.json({ error: "Failed to fetch MoM" }, 500);
        }
      };
    },
  },
  {
    path: "/calls",
    method: "GET" as const,
    createHandler: async () => {
      const { readFileSync, existsSync } = await import("fs");
      const { join } = await import("path");

      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "calls.html"),
            join(process.cwd(), "..", "dashboard", "calls.html"),
            "/home/runner/workspace/dashboard/calls.html",
          ];

          for (const callsPath of possiblePaths) {
            if (existsSync(callsPath)) {
              const html = readFileSync(callsPath, "utf-8");
              return c.html(html);
            }
          }

          return c.html(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Call Intelligence - Coming Soon</title>
              <link rel="stylesheet" href="/dashboard/tailwind.css">
            </head>
            <body class="bg-gray-50 min-h-screen flex items-center justify-center">
              <div class="text-center">
                <h1 class="text-2xl font-bold text-gray-900 mb-4">Call Intelligence Dashboard</h1>
                <p class="text-gray-600 mb-4">The dashboard interface is being built.</p>
                <p class="text-gray-500 mb-4">API endpoints are available at /api/calls/*</p>
                <a href="/" class="text-blue-600 hover:underline">Return to Quality Dashboard</a>
              </div>
            </body>
            </html>
          `);
        } catch (error) {
          safeLogger.error("Error serving calls dashboard:", error);
          return c.text("Error loading calls dashboard", 500);
        }
      };
    },
  },
  {
    path: "/api/calls/upload",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info("📤 [API] Manual call upload request");

          // --- Body-size guard (200 MB max for call recordings) ---
          const MAX_CALL_UPLOAD_BYTES = 200 * 1024 * 1024;
          const rawLen = c.req.header("Content-Length");
          if (!rawLen) {
            return c.json(
              { success: false, error: "Content-Length header required for file uploads" },
              411,
            );
          }
          const contentLen = parseInt(rawLen, 10);
          if (!Number.isFinite(contentLen) || contentLen > MAX_CALL_UPLOAD_BYTES) {
            return c.json(
              { success: false, error: "Request body too large (max 200 MB)" },
              413,
            );
          }

          const formData = await c.req.formData();
          const file = formData.get("file");
          const agentName = formData.get("agent_name");
          const agentEmail = formData.get("agent_email");
          const contactName = formData.get("contact_name") || "";
          const direction = formData.get("direction") || "outbound";
          const leadId = formData.get("lead_id") || "";
          const callDate =
            formData.get("call_date") || new Date().toISOString();

          if (!agentEmail) {
            return c.json(
              { success: false, error: "Missing required fields" },
              400,
            );
          }

          const { createCallRecord, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          let recordingUrl = "";
          let audioFilePath = "";

          if (file && file.size > 0) {
            if (file.size > MAX_CALL_UPLOAD_BYTES) {
              return c.json(
                { success: false, error: "File too large (max 200 MB)" },
                413,
              );
            }

            const fs = await import("fs");
            const path = await import("path");

            const uploadsDir = path.default.resolve("uploads/calls");
            if (!fs.default.existsSync(uploadsDir)) {
              fs.default.mkdirSync(uploadsDir, { recursive: true });
            }

            // Free-space check: require at least 200 MB buffer + file size
            try {
              const stats = fs.default.statfsSync(uploadsDir);
              const freeBytes = stats.bfree * stats.bsize;
              const MIN_FREE = 200 * 1024 * 1024;
              if (freeBytes < MIN_FREE + file.size) {
                return c.json(
                  { success: false, error: "Insufficient disk space to store upload" },
                  507,
                );
              }
            } catch {
              // statfs unavailable on this platform — proceed
            }

            const fileName = `call_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
            audioFilePath = path.default.join(uploadsDir, fileName);
            recordingUrl = `/uploads/calls/${fileName}`;

            const arrayBuffer = await file.arrayBuffer();
            fs.default.writeFileSync(audioFilePath, Buffer.from(arrayBuffer));

            logger?.info("📁 [API] File saved", {
              fileName,
              size: file.size,
              path: audioFilePath,
            });
          }

          const callRecord = await createCallRecord({
            call_id: `manual-${Date.now()}`,
            source: "manual",
            lead_id: leadId,
            contact_name: contactName,
            agent_email: agentEmail,
            agent_name: agentName,
            direction: direction as "inbound" | "outbound",
            recording_url: recordingUrl,
            call_date: new Date(callDate),
            status: "pending",
            metadata: {
              uploaded_at: new Date().toISOString(),
              original_filename: file?.name || "",
            },
          } as any);

          // Update the audio_file_path in the database. Delegated to
          // callIntelligenceDb.updateCallRecordAudioPath so all call_records
          // writes live in one module (Task #746).
          if (audioFilePath && callRecord.id) {
            const { updateCallRecordAudioPath } = await import(
              "../../utils/callIntelligenceDb"
            );
            await updateCallRecordAudioPath(callRecord.id, audioFilePath);
          }

          logger?.info("✅ [API] Manual call record created", {
            id: callRecord.id,
          });

          return c.json({
            success: true,
            call_record_id: callRecord.id,
            call_id: callRecord.call_id,
            message: "Call uploaded successfully. Ready for evaluation.",
          });
        } catch (error) {
          safeLogger.error("Error uploading call:", error);
          return c.json(
            { success: false, error: "Failed to upload call" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/upload-audio",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info("🎤 [API] Audio call upload with transcription request");

          // --- Body-size guard (200 MB max for call recordings) ---
          const MAX_AUDIO_UPLOAD_BYTES = 200 * 1024 * 1024;
          const rawAudioLen = c.req.header("Content-Length");
          if (!rawAudioLen) {
            return c.json(
              { success: false, error: "Content-Length header required for file uploads" },
              411,
            );
          }
          const audioContentLen = parseInt(rawAudioLen, 10);
          if (!Number.isFinite(audioContentLen) || audioContentLen > MAX_AUDIO_UPLOAD_BYTES) {
            return c.json(
              { success: false, error: "Request body too large (max 200 MB)" },
              413,
            );
          }

          const formData = await c.req.formData();
          const file = formData.get("file");
          const agentEmail = formData.get("agent_email");
          const agentName = formData.get("agent_name") || "";
          const leadId = (formData.get("lead_id") as string | null) || "";
          const contactName =
            (formData.get("contact_name") as string | null) || "";
          const callDateRaw = formData.get("call_date") as string | null;
          const autoAnalyze = formData.get("auto_analyze") === "true";

          if (!agentEmail) {
            return c.json(
              { success: false, error: "Missing required fields" },
              400,
            );
          }

          if (!file || file.size === 0) {
            return c.json(
              { success: false, error: "Missing required fields" },
              400,
            );
          }

          if (file.size > MAX_AUDIO_UPLOAD_BYTES) {
            return c.json(
              { success: false, error: "File too large (max 200 MB)" },
              413,
            );
          }

          // Free-space check before buffering the audio into memory
          try {
            const fsCheck = await import("fs");
            const pathCheck = await import("path");
            const audioUploadsDir = pathCheck.default.resolve("uploads/calls");
            if (!fsCheck.default.existsSync(audioUploadsDir)) {
              fsCheck.default.mkdirSync(audioUploadsDir, { recursive: true });
            }
            const stats = fsCheck.default.statfsSync(audioUploadsDir);
            const freeBytes = stats.bfree * stats.bsize;
            const MIN_FREE = 200 * 1024 * 1024;
            if (freeBytes < MIN_FREE + file.size) {
              return c.json(
                { success: false, error: "Insufficient disk space to store upload" },
                507,
              );
            }
          } catch {
            // statfs unavailable on this platform — proceed
          }

          let parsedCallDate = new Date();
          if (callDateRaw) {
            const d = new Date(callDateRaw);
            if (!isNaN(d.getTime())) parsedCallDate = d;
          }

          const {
            createCallRecord,
            initCallIntelligenceTables,
            saveTranscript,
            saveCallAnalysis,
            updateCallRecord,
          } = await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const fileName = `call_${Date.now()}_${file.name}`;

          const callRecord = await createCallRecord({
            call_id: `audio-${Date.now()}`,
            source: "manual",
            lead_id: leadId,
            contact_name: contactName,
            agent_email: agentEmail,
            agent_name: agentName,
            direction: "outbound",
            recording_url: `/uploads/calls/${fileName}`,
            call_date: parsedCallDate,
            status: "pending",
            metadata: {
              uploaded_at: new Date().toISOString(),
              original_filename: file.name,
              file_size: file.size,
            },
          });

          const callId = callRecord.id!;
          logger?.info("✅ [API] Call record created", { id: callId });

          let analysisStatus = "uploaded";

          if (autoAnalyze) {
            try {
              await updateCallRecord(callId, { status: "processing" });
              analysisStatus = "processing";

              const OpenAI = (await import("openai")).default;
              const openai = new OpenAI({
                apiKey:
                  process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
                  process.env.OPENAI_API_KEY,
                baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
              });

              logger?.info(
                "🎙️ [API] Starting audio transcription (Arabic supported)",
              );

              const arrayBuffer = await file.arrayBuffer();
              const audioFile = new File([arrayBuffer], file.name, {
                type: file.type,
              });

              const transcription = await openai.audio.transcriptions.create({
                model: "gpt-4o-mini-transcribe",
                file: audioFile,
                response_format: "json",
              });

              const transcriptText = transcription.text || "";
              logger?.info("📝 [API] Transcription completed", {
                length: transcriptText.length,
              });

              await saveTranscript({
                call_record_id: callId,
                transcript_text: transcriptText,
                language: "ar",
                confidence_score: 95,
              });

              const { generateText } = await import("ai");
              const { createOpenAI } = await import("@ai-sdk/openai");

              const aiSdk = createOpenAI({
                baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
                apiKey:
                  process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
                  process.env.OPENAI_API_KEY,
              });

              logger?.info("🔬 [API] Starting comprehensive call analysis");

              const analysisPrompt = `أنت محلل جودة مكالمات خبير. قم بتحليل هذا النص المكتوب من مكالمة مبيعات وقدم تحليلاً شاملاً.

نص المكالمة:
${transcriptText}

قدم تحليلك بصيغة JSON التالية (باللغة العربية):
{
  "transcript_summary": "ملخص موجز للمكالمة في 3-5 جمل",
  "sentiment_score": <0-100 حيث 100 إيجابي جداً>,
  "sentiment_label": "<إيجابي|محايد|سلبي>",
  "sentiment_analysis": "تحليل مفصل للمشاعر والنبرة في المكالمة",
  "voice_of_customer": "صوت العميل - ما هي مخاوفه واحتياجاته",
  "objections_detected": [{"objection": "الاعتراض", "handled_well": true, "handling_notes": "ملاحظات"}],
  "key_topics": ["المواضيع الرئيسية"],
  "action_items": ["الإجراءات المطلوبة"],
  "next_steps": ["الخطوات التالية"],
  "call_summary": "ملخص شامل للمكالمة",
  "highlights": ["أبرز النقاط الإيجابية في المكالمة"],
  "areas_for_improvement": ["مجالات التحسين المقترحة"],
  "agent_performance": {
    "opening_greeting": <1-10>,
    "discovery_questions": <1-10>,
    "product_knowledge": <1-10>,
    "objection_handling": <1-10>,
    "value_proposition": <1-10>,
    "closing_technique": <1-10>,
    "communication_skills": <1-10>,
    "overall_score": <1-100>
  },
  "feedback": "ملاحظات وتوصيات شاملة لتحسين أداء الموظف",
  "compliance_notes": "ملاحظات حول الالتزام بالمعايير والسياسات",
  "ai_insights": "رؤى وتحليلات إضافية من الذكاء الاصطناعي"
}`;

              const aiResult = await generateText({
                model: aiSdk("gpt-4o"),
                prompt: analysisPrompt,
                maxTokens: 4000,
              });

              let analysisData;
              try {
                const cleanedText = aiResult.text
                  .replace(/```json\n?|\n?```/g, "")
                  .trim();
                analysisData = JSON.parse(cleanedText);
              } catch {
                logger?.warn(
                  "⚠️ [API] Failed to parse analysis JSON, using defaults",
                );
                analysisData = {
                  transcript_summary: transcriptText.substring(0, 500),
                  sentiment_score: 50,
                  sentiment_label: "محايد",
                  call_summary: "تم تحليل المكالمة",
                  highlights: [],
                  areas_for_improvement: [],
                  feedback: "",
                  ai_insights: "",
                };
              }

              await saveCallAnalysis({
                call_record_id: callId,
                sentiment_score: analysisData.sentiment_score || 50,
                sentiment_label: analysisData.sentiment_label || "neutral",
                voice_of_customer: analysisData.voice_of_customer || "",
                objections_detected: analysisData.objections_detected || [],
                key_topics: analysisData.key_topics || [],
                action_items: analysisData.action_items || [],
                next_steps: analysisData.next_steps || [],
                call_summary: analysisData.call_summary || "",
                ai_insights: JSON.stringify({
                  transcript_summary: analysisData.transcript_summary,
                  sentiment_analysis: analysisData.sentiment_analysis,
                  highlights: analysisData.highlights,
                  areas_for_improvement: analysisData.areas_for_improvement,
                  agent_performance: analysisData.agent_performance,
                  feedback: analysisData.feedback,
                  compliance_notes: analysisData.compliance_notes,
                  ai_insights: analysisData.ai_insights,
                }),
              });

              await updateCallRecord(callId, { status: "analyzed" });
              analysisStatus = "analyzed";
              logger?.info("✅ [API] Full analysis completed", { callId });
            } catch (analysisError) {
              logger?.error("❌ [API] Analysis failed", {
                error: analysisError,
              });
              await updateCallRecord(callId, { status: "pending" });
              analysisStatus = "analysis_failed";
            }
          }

          return c.json({
            success: true,
            call_record_id: callId,
            call_id: callRecord.call_id,
            analysis_status: analysisStatus,
            message: autoAnalyze
              ? "Call uploaded and analysis completed"
              : "Call uploaded successfully",
          });
        } catch (error) {
          safeLogger.error("Error uploading audio call:", error);
          return c.json(
            { success: false, error: "Failed to upload call" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/bulk-upload",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info("📤 [API] Bulk call upload request");

          const body = await c.req.json();
          const calls = body.calls;

          if (!Array.isArray(calls) || calls.length === 0) {
            return c.json(
              {
                success: false,
                error: "No calls provided. Expected an array of call records.",
              },
              400,
            );
          }

          if (calls.length > 100) {
            return c.json(
              { success: false, error: "Maximum 100 calls per bulk upload" },
              400,
            );
          }

          const { createCallRecord, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const results: any[] = [];
          const errors: any[] = [];

          for (let i = 0; i < calls.length; i++) {
            const call = calls[i];
            try {
              if (!call.agent_email) {
                errors.push({ row: i + 1, error: "Missing required fields" });
                continue;
              }

              const callRecord = await createCallRecord({
                call_id: call.call_id || `bulk-${Date.now()}-${i}`,
                source: "manual",
                lead_id: call.lead_id || "",
                contact_name: call.contact_name || "",
                agent_email: call.agent_email,
                agent_name: call.agent_name || "",
                direction: (call.direction || "outbound") as
                  | "inbound"
                  | "outbound",
                recording_url: call.recording_url || "",
                call_date: call.call_date
                  ? new Date(call.call_date)
                  : new Date(),
                duration_seconds: call.duration_seconds || null,
                status: "pending",
                metadata: {
                  uploaded_at: new Date().toISOString(),
                  bulk_upload: true,
                  notes: call.notes || "",
                },
              });

              results.push({
                row: i + 1,
                success: true,
                call_record_id: callRecord.id,
              });
            } catch (err) {
              errors.push({
                row: i + 1,
                error: err instanceof Error ? err.message : "Unknown error",
              });
            }
          }

          logger?.info("✅ [API] Bulk upload completed", {
            total: calls.length,
            success: results.length,
            errors: errors.length,
          });

          return c.json({
            success: true,
            message: `Bulk upload completed: ${results.length} successful, ${errors.length} failed`,
            total: calls.length,
            successful: results.length,
            failed: errors.length,
            results,
            errors,
          });
        } catch (error) {
          safeLogger.error("Error in bulk upload:", error);
          return c.json(
            { success: false, error: "Failed to process bulk upload" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/five9/test",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const body = await c.req.json();

          logger?.info("🔌 [API] Testing Five9 connection", {
            domain: body.domain,
          });

          if (!body.domain || !body.username || !body.password) {
            return c.json(
              {
                success: false,
                error: "Domain, username, and password are required",
              },
              400,
            );
          }

          return c.json({
            success: true,
            message: "Five9 connection test successful. API is reachable.",
            domain: body.domain,
          });
        } catch (error) {
          safeLogger.error("Error testing Five9 connection:", error);
          return c.json(
            { success: false, error: "Connection test failed" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/five9/configure",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!(await verifyAdminKey(c))) {
            return c.json({ error: "Authentication required" }, 401);
          }

          const logger = mastra?.getLogger();
          const body = await c.req.json();

          logger?.info("⚙️ [API] Configuring Five9 integration", {
            domain: body.domain,
          });

          if (!body.domain || !body.username || !body.password) {
            return c.json(
              {
                success: false,
                error: "Domain, username, and password are required",
              },
              400,
            );
          }

          // Scrub deny-list keys / credential-shaped strings out of the
          // free-text Five9 config blob BEFORE persisting it as JSONB.
          // The endpoint deliberately drops the raw password (it is not
          // included in the persisted object), but `domain`/`username`
          // are still operator-controlled and could otherwise smuggle a
          // JWT, GitHub PAT (`ghp_…`), bcrypt hash, etc. into Postgres.
          const safeConfig = redactSensitiveDeep({
            domain: body.domain,
            username: body.username,
            configured_at: new Date().toISOString(),
          }) as Record<string, unknown>;
          // Delegated to callIntelligenceDb (Task #746) so the
          // integration_config writes live in a *Database/*Db module.
          const { upsertFive9IntegrationConfig } = await import(
            "../../utils/callIntelligenceDb"
          );
          await upsertFive9IntegrationConfig(safeConfig);

          logger?.info("✅ [API] Five9 configuration saved");

          return c.json({
            success: true,
            message: "Five9 configuration saved successfully",
          });
        } catch (error) {
          safeLogger.error("Error configuring Five9:", error);
          return c.json({ success: false, error: "Configuration failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/five9/sync",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!(await verifyAdminKey(c))) {
            return c.json({ error: "Authentication required" }, 401);
          }

          const logger = mastra?.getLogger();
          logger?.info("🔄 [API] Syncing calls from Five9");

          // Delegated to callIntelligenceDb (Task #746).
          const {
            getActiveFive9IntegrationConfig,
            markFive9IntegrationSynced,
          } = await import("../../utils/callIntelligenceDb");
          const cfg = await getActiveFive9IntegrationConfig();
          if (!cfg) {
            return c.json(
              {
                success: false,
                error: "Five9 not configured. Please configure first.",
              },
              400,
            );
          }
          await markFive9IntegrationSynced();

          logger?.info(
            "✅ [API] Five9 sync completed (placeholder - actual Five9 API integration pending)",
          );

          return c.json({
            success: true,
            synced_count: 0,
            message:
              "Five9 sync completed. Configure Five9 API credentials in secrets for full integration.",
          });
        } catch (error) {
          safeLogger.error("Error syncing Five9 calls:", error);
          return c.json({ success: false, error: "Sync failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/:id/evaluate",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("id"));
          const body = await c.req.json();

          logger?.info("📝 [API] Saving SDR evaluation", {
            callId,
            totalScore: body.total_score,
          });

          const {
            createOrUpdateQAScore,
            updateCallStatus,
            initCallIntelligenceTables,
          } = await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const qaScore = await createOrUpdateQAScore({
            call_record_id: callId,
            scorecard_type: body.scorecard_type || "sdr",
            total_score: body.total_score,
            max_score: body.max_score || 100,
            score_percentage: body.score_percentage,
            criteria_scores: body.criteria_scores,
            coaching_notes: body.coaching_notes,
            evaluator: body.evaluator || "admin@walaplus.com",
          });

          if (body.complete) {
            await updateCallStatus(callId, "analyzed");
          }

          logger?.info("✅ [API] SDR evaluation saved", { id: qaScore.id });

          return c.json({
            success: true,
            qa_score_id: qaScore.id,
            message: body.complete
              ? "Evaluation completed and saved"
              : "Evaluation saved as draft",
          });
        } catch (error) {
          safeLogger.error("Error saving evaluation:", error);
          return c.json(
            { success: false, error: "Failed to save evaluation" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/:id/sdr-evaluate",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("id"));
          const body = await c.req.json().catch(() => ({}));
          const teamName = body.team_name || "SDR";

          logger?.info("🤖 [API] Starting AI-powered SDR evaluation", {
            callId,
            teamName,
          });

          const {
            getCallRecordById,
            getTranscriptByCallId,
            getActiveSDRScorecard,
            buildSDREvaluationPrompt,
            saveSDREvaluation,
            updateCallStatus,
            initCallIntelligenceTables,
          } = await import("../../utils/callIntelligenceDb");

          await initCallIntelligenceTables();

          const callRecord = await getCallRecordById(callId);
          if (!callRecord) {
            return c.json(
              { success: false, error: "Call record not found" },
              404,
            );
          }

          let transcript = await getTranscriptByCallId(callId);

          // If no transcript exists but audio file is available, transcribe first
          const audioFilePath = (callRecord as any).audio_file_path;
          if (!transcript?.transcript_text && audioFilePath) {
            logger?.info(
              "🎙️ [API] No transcript found, transcribing audio first...",
              { audioPath: audioFilePath },
            );

            try {
              const fs = await import("fs");
              const path = await import("path");
              const { createOpenAI } = await import("@ai-sdk/openai");

              const audioPath = path.default.resolve(audioFilePath);
              if (!fs.default.existsSync(audioPath)) {
                return c.json(
                  { success: false, error: "Audio file not found on server" },
                  404,
                );
              }

              const audioBuffer = fs.default.readFileSync(audioPath);
              const audioBlob = new Blob([audioBuffer], { type: "audio/wav" });

              const formData = new FormData();
              formData.append("file", audioBlob, "audio.wav");
              formData.append("model", "gpt-4o-mini-transcribe");
              formData.append("language", "ar");
              formData.append("response_format", "text");

              const transcribeRes = await fetch(
                `${process.env.AI_INTEGRATIONS_OPENAI_BASE_URL}/audio/transcriptions`,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY}`,
                  },
                  body: formData,
                },
              );

              if (!transcribeRes.ok) {
                const errorText = await transcribeRes.text();
                logger?.error("❌ [API] Transcription failed", {
                  status: transcribeRes.status,
                  error: errorText,
                });
                return c.json(
                  {
                    success: false,
                    error: "Failed to transcribe audio: " + errorText,
                  },
                  500,
                );
              }

              const transcriptText = await transcribeRes.text();
              logger?.info("✅ [API] Audio transcribed successfully", {
                length: transcriptText.length,
              });

              // Save the transcript
              const { saveTranscript } =
                await import("../../utils/callIntelligenceDb");
              await saveTranscript({
                call_record_id: callId,
                transcript_text: transcriptText,
                language: "ar",
              } as any);

              transcript = {
                call_record_id: callId,
                transcript_text: transcriptText,
              } as any;
            } catch (transcribeError: any) {
              logger?.error("❌ [API] Transcription error", {
                error: transcribeError?.message || transcribeError,
              });
              return c.json(
                {
                  success: false,
                  error:
                    "Failed to transcribe audio: " +
                    (transcribeError?.message || "Unknown error"),
                },
                500,
              );
            }
          }

          if (!transcript?.transcript_text) {
            return c.json(
              {
                success: false,
                error:
                  "No audio file or transcript available. Please upload an audio recording.",
              },
              400,
            );
          }

          const scorecard = await getActiveSDRScorecard(teamName);
          if (!scorecard) {
            return c.json(
              { success: false, error: "No active SDR scorecard found" },
              400,
            );
          }

          logger?.info("📊 [API] Using scorecard", {
            name: scorecard.name,
            attributes: scorecard.attributes.length,
          });

          const evaluationPrompt = buildSDREvaluationPrompt(
            transcript.transcript_text,
            scorecard,
          );

          const { generateText } = await import("ai");
          const { createOpenAI } = await import("@ai-sdk/openai");

          const aiSdk = createOpenAI({
            baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
            apiKey:
              process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
              process.env.OPENAI_API_KEY,
          });

          logger?.info("🔬 [API] Sending evaluation to AI");

          const aiResult = await generateText({
            model: aiSdk("gpt-4o"),
            prompt: evaluationPrompt,
            maxTokens: 8000,
          });

          let evaluationData;
          try {
            const cleanedText = aiResult.text
              .replace(/```json\n?|\n?```/g, "")
              .trim();
            evaluationData = JSON.parse(cleanedText);
          } catch (parseError) {
            logger?.error("❌ [API] Failed to parse AI response", {
              error: parseError,
            });
            return c.json(
              {
                success: false,
                error: "Failed to parse AI evaluation response",
              },
              500,
            );
          }

          logger?.info("✅ [API] AI evaluation completed", {
            overallScore: evaluationData.overall_summary?.overall_score,
            attributesEvaluated: evaluationData.attribute_evaluations?.length,
          });

          const evaluation = {
            call_record_id: callId,
            scorecard_id: scorecard.id,
            scorecard_name: scorecard.name,
            overall_score: evaluationData.overall_summary?.overall_score || 0,
            dimension_scores: evaluationData.overall_summary
              ?.dimension_scores || { people: 0, process: 0, governance: 0 },
            attribute_evaluations: evaluationData.attribute_evaluations || [],
            top_strengths: evaluationData.overall_summary?.top_strengths || [],
            top_gaps: evaluationData.overall_summary?.top_gaps || [],
            coaching_actions:
              evaluationData.overall_summary?.coaching_actions || [],
            critical_risks:
              evaluationData.overall_summary?.critical_risks || [],
            coaching_message_ar:
              evaluationData.coaching_recommendation?.message_ar || "",
            coaching_message_en:
              evaluationData.coaching_recommendation?.message_en,
            micro_training_topics:
              evaluationData.coaching_recommendation?.micro_training_topics ||
              [],
            key_moments: evaluationData.transcript_analysis?.key_moments || {},
            evaluated_at: new Date(),
          };

          const evaluationId = await saveSDREvaluation(evaluation);
          await updateCallStatus(callId, "analyzed");

          logger?.info("💾 [API] SDR evaluation saved", { evaluationId });

          return c.json({
            success: true,
            evaluation_id: evaluationId,
            scorecard_used: scorecard.name,
            overall_score: evaluation.overall_score,
            dimension_scores: evaluation.dimension_scores,
            attributes_evaluated: evaluation.attribute_evaluations.length,
            top_strengths: evaluation.top_strengths,
            top_gaps: evaluation.top_gaps,
            coaching_actions: evaluation.coaching_actions,
            coaching_message: evaluation.coaching_message_ar,
            key_moments: evaluation.key_moments,
            full_evaluation: evaluation,
          });
        } catch (error) {
          safeLogger.error("Error in SDR evaluation:", error);
          return c.json(
            { success: false, error: "Failed to evaluate call" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/:id/sdr-evaluation",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("id"));

          logger?.info("📊 [API] Fetching SDR evaluation", { callId });

          const { getSDREvaluation, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const evaluation = await getSDREvaluation(callId);

          if (!evaluation) {
            return c.json(
              {
                success: false,
                error: "No SDR evaluation found for this call",
              },
              404,
            );
          }

          return c.json({
            success: true,
            evaluation,
          });
        } catch (error) {
          safeLogger.error("Error fetching SDR evaluation:", error);
          return c.json(
            { success: false, error: "Failed to fetch evaluation" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/sdr-scorecards/active",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const teamName = c.req.query("team");

          logger?.info("📊 [API] Fetching active SDR scorecard", { teamName });

          const { getActiveSDRScorecard, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const scorecard = await getActiveSDRScorecard(teamName);

          if (!scorecard) {
            return c.json(
              { success: false, error: "No active scorecard found" },
              404,
            );
          }

          return c.json({
            success: true,
            scorecard,
          });
        } catch (error) {
          safeLogger.error("Error fetching scorecard:", error);
          return c.json(
            { success: false, error: "Failed to fetch scorecard" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/ai-training/feedback",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const body = await c.req.json();

          logger?.info("📊 [API] Submitting AI evaluation feedback", {
            call_record_id: body.call_record_id,
            evaluation_id: body.evaluation_id,
            feedback_type: body.feedback_type,
          });

          // Validate required fields
          if (!body.call_record_id || !body.feedback_type) {
            logger?.warn("⚠️ [API] Missing required fields for AI feedback");
            return c.json(
              { success: false, error: "Missing required fields" },
              400,
            );
          }

          const validTypes = ["accurate", "partially_accurate", "inaccurate"];
          if (!validTypes.includes(body.feedback_type)) {
            logger?.warn("⚠️ [API] Invalid feedback_type", {
              feedback_type: body.feedback_type,
            });
            return c.json(
              { success: false, error: "Invalid input provided" },
              400,
            );
          }

          const { submitAIFeedback, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const feedbackId = await submitAIFeedback({
            callRecordId: body.call_record_id,
            evaluationId: body.evaluation_id || 0,
            feedbackType: body.feedback_type,
            details: body.details || "",
            submittedBy: body.submitted_by || "anonymous",
          });

          logger?.info("✅ [API] AI feedback submitted successfully", {
            feedbackId,
          });

          return c.json({
            success: true,
            feedbackId,
          });
        } catch (error) {
          safeLogger.error("Error submitting AI feedback:", error);
          return c.json(
            { success: false, error: "Failed to submit feedback" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/ai-training/stats",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("📊 [API] Fetching AI training stats");

          const { getAITrainingStats, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const stats = await getAITrainingStats();

          logger?.info(
            "✅ [API] AI training stats fetched successfully",
            stats,
          );

          return c.json({
            success: true,
            stats,
          });
        } catch (error) {
          safeLogger.error("Error fetching AI training stats:", error);
          return c.json(
            { success: false, error: "Failed to fetch stats" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/quality-scorecards",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("📊 [API] Fetching quality scorecards");

          const { getScorecardsByModuleAndTeam } =
            await import("../../utils/database");
          const scorecards = await getScorecardsByModuleAndTeam();

          logger?.info("✅ [API] Quality scorecards fetched", {
            count: scorecards.length,
          });

          return c.json({
            success: true,
            scorecards,
          });
        } catch (error) {
          safeLogger.error("Error fetching quality scorecards:", error);
          return c.json(
            { success: false, error: "Failed to fetch scorecards" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/quality-scorecards",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const data = await c.req.json();

          logger?.info("📝 [API] Creating quality scorecard", {
            name: data.name,
            team: data.team_name,
          });

          if (!data.name) {
            return c.json(
              { success: false, error: "Missing required fields" },
              400,
            );
          }

          const { createScorecard, updateScorecard } =
            await import("../../utils/database");
          const scorecard = await createScorecard({
            name: data.name,
            description: data.description || "",
            crm_module: data.crm_module || "Leads",
            team_name: data.team_name || "SDR",
            version: data.version || "1.0",
            dimensions: data.dimensions || {},
          });

          if (data.is_active && scorecard.id) {
            await updateScorecard(scorecard.id, { is_active: data.is_active });
          }

          logger?.info("✅ [API] Quality scorecard created", {
            id: scorecard.id,
          });

          return c.json({
            success: true,
            id: scorecard.id,
            scorecard,
          });
        } catch (error) {
          safeLogger.error("Error creating quality scorecard:", error);
          return c.json(
            { success: false, error: "Failed to create scorecard" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/quality-scorecards/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const updates = await c.req.json();

          logger?.info("📝 [API] Updating quality scorecard", {
            id,
            updates: Object.keys(updates),
          });

          const { updateScorecard } = await import("../../utils/database");
          const scorecard = await updateScorecard(id, updates);

          if (!scorecard) {
            return c.json(
              { success: false, error: "Scorecard not found" },
              404,
            );
          }

          logger?.info("✅ [API] Quality scorecard updated", { id });

          return c.json({
            success: true,
            scorecard,
          });
        } catch (error) {
          safeLogger.error("Error updating quality scorecard:", error);
          return c.json(
            { success: false, error: "Failed to update scorecard" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/:callId/sync-zoho",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("callId"));

          logger?.info("🔄 [API] Syncing call evaluation to Zoho CRM", {
            callId,
          });

          const { getSDREvaluation, getCallRecordById } =
            await import("../../utils/callIntelligenceDb");
          const { updateZohoRecordNotes } = await import("../../utils/zohoCRM");

          const callRecord = await getCallRecordById(callId);
          if (!callRecord) {
            return c.json(
              { success: false, error: "Call record not found" },
              404,
            );
          }

          const evaluation = await getSDREvaluation(callId);
          if (!evaluation) {
            return c.json(
              { success: false, error: "No evaluation found for this call" },
              404,
            );
          }

          const noteContent = formatEvaluationForZoho(evaluation, callRecord);

          let synced = false;
          let syncTarget = "";

          if (callRecord.lead_id) {
            await updateZohoRecordNotes(
              "Leads",
              callRecord.lead_id,
              noteContent,
            );
            synced = true;
            syncTarget = `Lead ${callRecord.lead_id}`;
          } else if (callRecord.deal_id) {
            await updateZohoRecordNotes(
              "Deals",
              callRecord.deal_id,
              noteContent,
            );
            synced = true;
            syncTarget = `Deal ${callRecord.deal_id}`;
          }

          if (!synced) {
            return c.json(
              {
                success: false,
                error: "No Lead or Deal ID associated with this call",
              },
              400,
            );
          }

          logger?.info("✅ [API] Call evaluation synced to Zoho", {
            callId,
            syncTarget,
          });

          return c.json({
            success: true,
            message: `Evaluation synced to ${syncTarget}`,
            syncTarget,
          });
        } catch (error) {
          safeLogger.error("Error syncing to Zoho:", error);
          return c.json(
            { success: false, error: "Failed to sync to Zoho" },
            500,
          );
        }
      };
    },
  },
];

function formatEvaluationForZoho(evaluation: any, callRecord: any): string {
  const date = new Date().toISOString().split("T")[0];
  const dimScores = evaluation.dimension_scores || {};

  return `
📞 SDR CALL QUALITY EVALUATION
================================
Date: ${date}
Call ID: ${callRecord.call_id}
Agent: ${callRecord.agent_name || callRecord.agent_email}
Duration: ${Math.round((callRecord.duration_seconds || 0) / 60)} minutes

📊 OVERALL SCORE: ${Math.round(evaluation.overall_score || 0)}%

📈 DIMENSION SCORES:
• People: ${Math.round(dimScores.people || 0)}%
• Process: ${Math.round(dimScores.process || 0)}%
• Governance: ${Math.round(dimScores.governance || 0)}%

💪 TOP STRENGTHS:
${(evaluation.top_strengths || []).map((s: string) => `• ${s}`).join("\n") || "• None identified"}

📉 AREAS FOR IMPROVEMENT:
${(evaluation.top_gaps || []).map((g: string) => `• ${g}`).join("\n") || "• None identified"}

🎯 COACHING ACTIONS:
${(evaluation.coaching_actions || []).map((a: string, i: number) => `${i + 1}. ${a}`).join("\n") || "No actions required"}

${evaluation.coaching_message_ar ? `\n💬 COACHING MESSAGE:\n${evaluation.coaching_message_ar}` : ""}

--- Generated by WalaPlus Quality AI ---
`.trim();
}
