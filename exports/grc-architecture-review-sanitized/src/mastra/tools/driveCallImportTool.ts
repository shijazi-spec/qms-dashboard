import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  listDriveAudioFiles,
  resolveDriveAuth,
  type DriveAuthMode,
} from "../../utils/IdentityProviderDriveCallSource";
import {
  createCallRecord,
  initCallIntelligenceTables,
  type CallRecord,
} from "../../utils/callIntelligenceDb";

const DriveImportRowSchema = z.object({
  drive_file_id: z.string(),
  drive_file_name: z.string(),
  mime_type: z.string(),
  created_call_record_id: z.number().optional(),
  status: z.enum(["created", "<REDACTED_TOKEN>", "<REDACTED_TOKEN>", "failed"]),
  error: z.string().optional(),
});

export const driveCallImportTool = createTool({
  id: "drive-call-import",
  description:
    "List audio recordings in a IdentityProvider Drive folder (or custom query) and create call_records for each, marked source='IdentityProvider_drive'. Audio bytes are NOT downloaded here — the recording_url points to the Drive media endpoint so the existing transcription pipeline can stream them. Pass `dry_run: true` to preview without writing.",
  inputSchema: z.object({
    folder_id: z
      .string()
      .optional()
      .describe(
        "Drive folder ID containing call recordings. Falls back to env IdentityProvider_DRIVE_CALLS_FOLDER_ID if not set.",
      ),
    query: z
      .string()
      .optional()
      .describe("Optional Drive query expression (Drive v3 q syntax) appended with AND."),
    page_size: z.number().int().positive().max(200).optional(),
    page_token: <REDACTED_SECRET>
    agent_email: z
      .string()
      .describe(
        "Agent email to attribute every created call to. Required because call_records requires agent_email.",
      ),
    default_direction: z.enum(["inbound", "outbound"]).default("outbound").optional(),
    dry_run: z.boolean().default(false).optional(),
  }),
  outputSchema: z.object({
    auth_mode: z.enum(["HostingPlatform_connector", "service_account", "oauth_refresh", "none"]),
    scanned: z.number(),
    created: z.number(),
    skipped: z.number(),
    failed: z.number(),
    next_page_token: <REDACTED_SECRET>
    rows: z.array(DriveImportRowSchema),
    note: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const auth = await resolveDriveAuth();
    if (auth.mode === "none") {
      return {
        auth_mode: "none" as DriveAuthMode,
        scanned: 0,
        created: 0,
        skipped: 0,
        failed: 0,
        rows: [],
        note:
          "No IdentityProvider Drive credentials configured. Set up one of: HostingPlatform Drive connector, IdentityProvider_DRIVE_CLIENT_EMAIL+PRIVATE_KEY, or IdentityProvider_OAUTH_CLIENT_ID+SECRET+REFRESH_TOKEN.",
      };
    }

    const listing = await listDriveAudioFiles({
      folder_id: context.folder_id,
      query: context.query,
      page_size: context.page_size,
      page_token: <REDACTED_SECRET>
      audio_only: true,
    });

    if (context.dry_run) {
      return {
        auth_mode: listing.auth_mode,
        scanned: listing.files.length,
        created: 0,
        skipped: listing.files.length,
        failed: 0,
        next_page_token: <REDACTED_SECRET>
        rows: listing.files.map((f) => ({
          drive_file_id: f.id,
          drive_file_name: f.name,
          mime_type: f.mimeType,
          status: "<REDACTED_TOKEN>" as const,
        })),
        note: "dry_run=true — no call_records written.",
      };
    }

    await initCallIntelligenceTables();

    const rows: Array<z.infer<typeof DriveImportRowSchema>> = [];
    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (const f of listing.files) {
      const callId = `gdrive_${f.id}`;
      try {
        const record: CallRecord = {
          call_id: callId,
          source: "IdentityProvider_drive",
          agent_email: context.agent_email,
          direction: context.default_direction ?? "outbound",
          recording_url: `<REDACTED_URL>`,
          status: "uploaded",
          call_date: f.modifiedTime ? new Date(f.modifiedTime) : new Date(),
          metadata: {
            drive_file_id: f.id,
            drive_file_name: f.name,
            drive_mime_type: f.mimeType,
            drive_web_view_link: f.webViewLink,
            drive_size_bytes: f.size ? Number(f.size) : undefined,
            drive_auth_mode: listing.auth_mode,
          },
        };
        const result = await createCallRecord(record);
        rows.push({
          drive_file_id: f.id,
          drive_file_name: f.name,
          mime_type: f.mimeType,
          created_call_record_id: result.id,
          status: "created",
        });
        created++;
      } catch (e) {
        rows.push({
          drive_file_id: f.id,
          drive_file_name: f.name,
          mime_type: f.mimeType,
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
        });
        failed++;
      }
    }

    return {
      auth_mode: listing.auth_mode,
      scanned: listing.files.length,
      created,
      skipped,
      failed,
      next_page_token: <REDACTED_SECRET>
      rows,
      note:
        "Records created with status='pending'. Trigger transcription via the existing call upload-audio / Whisper path with the recording_url, then call reconcile-call to merge governance.",
    };
  },
});
