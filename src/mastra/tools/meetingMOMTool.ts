import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const meetingMOMTool = createTool({
  id: "meeting-mom-tool",
  description: "Generates Minutes of Meeting (MoM) from a meeting transcript or recording. Extracts key decisions, action items, follow-ups, and next meeting date.",
  inputSchema: z.object({
    calendar_event_id: z.string().describe("Google Calendar event ID"),
    meeting_title: z.string().describe("Title of the meeting"),
    meeting_date: z.string().describe("Date and time of the meeting (ISO format)"),
    attendees: z.array(z.object({
      email: z.string(),
      name: z.string().optional()
    })).optional().describe("List of meeting attendees"),
    transcript: z.string().describe("Full transcript or notes from the meeting"),
    call_record_id: z.number().optional().describe("Associated call record ID if meeting was recorded")
  }),
  outputSchema: z.object({
    success: z.boolean(),
    mom_id: z.number().optional(),
    mom: z.object({
      summary: z.string(),
      key_decisions: z.array(z.string()),
      action_items: z.array(z.object({
        action: z.string(),
        owner: z.string().optional(),
        due_date: z.string().optional()
      })),
      follow_ups: z.array(z.string()),
      next_meeting_date: z.string().optional(),
      notes: z.string().optional()
    }).optional(),
    message: z.string()
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📋 [MeetingMOM] Generating Minutes of Meeting", { 
      calendar_event_id: context.calendar_event_id,
      meeting_title: context.meeting_title
    });

    try {
      const { saveMeetingMOM } = await import("../../utils/callIntelligenceDb");

      const momPrompt = `Analyze the following meeting transcript and generate comprehensive Minutes of Meeting (MoM).

MEETING TITLE: ${context.meeting_title}
MEETING DATE: ${context.meeting_date}
ATTENDEES: ${context.attendees ? context.attendees.map(a => a.name || a.email).join(', ') : 'Not specified'}

TRANSCRIPT/NOTES:
${context.transcript}

Please provide the MoM in the following JSON format:
{
  "summary": "<2-3 paragraph executive summary of the meeting>",
  "key_decisions": ["<decision 1>", "<decision 2>"],
  "action_items": [
    {
      "action": "<specific action to be taken>",
      "owner": "<person responsible>",
      "due_date": "<deadline if mentioned, otherwise null>"
    }
  ],
  "follow_ups": ["<follow-up item 1>", "<follow-up item 2>"],
  "next_meeting_date": "<if mentioned, ISO format date, otherwise null>",
  "notes": "<any additional important notes or context>"
}

Respond ONLY with the JSON, no additional text.`;

      const { createOpenAI } = await import("@ai-sdk/openai");
      const { generateText } = await import("ai");

      const openai = createOpenAI({
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
        apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY
      });

      const result = await generateText({
        model: openai("gpt-4o"),
        prompt: momPrompt,
        maxTokens: 2000
      });

      let momData;
      try {
        const cleanedText = result.text.replace(/```json\n?|\n?```/g, '').trim();
        momData = JSON.parse(cleanedText);
      } catch (parseError) {
        logger?.warn("⚠️ [MeetingMOM] Failed to parse MoM JSON, using defaults");
        momData = {
          summary: "Meeting summary could not be generated from the provided transcript.",
          key_decisions: [],
          action_items: [],
          follow_ups: [],
          next_meeting_date: null,
          notes: ""
        };
      }

      const savedMOM = await saveMeetingMOM({
        call_record_id: context.call_record_id,
        calendar_event_id: context.calendar_event_id,
        meeting_title: context.meeting_title,
        meeting_date: new Date(context.meeting_date),
        attendees: context.attendees,
        summary: momData.summary,
        key_decisions: momData.key_decisions,
        action_items: momData.action_items,
        follow_ups: momData.follow_ups,
        next_meeting_date: momData.next_meeting_date ? new Date(momData.next_meeting_date) : undefined,
        notes: momData.notes
      });

      logger?.info("✅ [MeetingMOM] MoM generated and saved", { 
        id: savedMOM.id,
        action_items_count: momData.action_items?.length || 0
      });

      return {
        success: true,
        mom_id: savedMOM.id,
        mom: {
          summary: momData.summary,
          key_decisions: momData.key_decisions,
          action_items: momData.action_items,
          follow_ups: momData.follow_ups,
          next_meeting_date: momData.next_meeting_date,
          notes: momData.notes
        },
        message: `Minutes of Meeting generated successfully with ${momData.action_items?.length || 0} action items`
      };
    } catch (error) {
      logger?.error("❌ [MeetingMOM] MoM generation failed", { 
        error: error instanceof Error ? error.message : String(error) 
      });

      return {
        success: false,
        message: `MoM generation failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
});
