import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const callIngestTool = createTool({
  id: "call-ingest-tool",
  description:
    "Ingests call recordings from Five9, Twilio, mobile, Google Meet/Drive, or bulk-upload flows. Creates a call record and prepares it for analysis.",
  inputSchema: z.object({
    call_id: z.string().describe("Unique identifier for the call from the source system"),
    source: z
      .enum([
        "five9",
        "twilio",
        "mobile",
        "google_meet",
        "google_drive",
        "bulk_upload",
        "manual",
      ])
      .describe("Source of the call recording"),
    recording_url: z.string().optional().describe("URL to the call recording audio file"),
    lead_id: z.string().optional().describe("Zoho Lead ID if known"),
    deal_id: z.string().optional().describe("Zoho Deal ID if known"),
    contact_name: z.string().optional().describe("Name of the contact on the call"),
    agent_email: z.string().describe("Email of the agent who made/received the call"),
    agent_name: z.string().optional().describe("Name of the agent"),
    direction: z.enum(["inbound", "outbound"]).default("outbound").describe("Direction of the call"),
    duration_seconds: z.number().optional().describe("Duration of the call in seconds"),
    call_date: z.string().optional().describe("Date and time of the call (ISO format)"),
    metadata: z.record(z.any()).optional().describe("Additional metadata from the source system")
  }),
  outputSchema: z.object({
    success: z.boolean(),
    call_record_id: z.number().optional(),
    call_id: z.string(),
    status: z.string(),
    message: z.string()
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📞 [CallIngest] Starting call ingestion", { 
      call_id: context.call_id, 
      source: context.source 
    });

    try {
      const { createCallRecord } = await import("../../utils/callIntelligenceDb");

      const callRecord = await createCallRecord({
        call_id: context.call_id,
        source: context.source,
        lead_id: context.lead_id,
        deal_id: context.deal_id,
        contact_name: context.contact_name,
        agent_email: context.agent_email,
        agent_name: context.agent_name,
        direction: context.direction,
        duration_seconds: context.duration_seconds,
        recording_url: context.recording_url,
        call_date: context.call_date ? new Date(context.call_date) : new Date(),
        status: "pending",
        metadata: context.metadata || {}
      });

      logger?.info("✅ [CallIngest] Call record created", { 
        id: callRecord.id, 
        call_id: callRecord.call_id 
      });

      return {
        success: true,
        call_record_id: callRecord.id,
        call_id: callRecord.call_id,
        status: "pending",
        message: `Call record created successfully. Ready for transcription and analysis.`
      };
    } catch (error) {
      logger?.error("❌ [CallIngest] Failed to ingest call", { 
        error: error instanceof Error ? error.message : String(error) 
      });

      return {
        success: false,
        call_id: context.call_id,
        status: "failed",
        message: `Failed to ingest call: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
});
