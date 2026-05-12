/**
 * Canonical description of how calls enter QMS and how they align to CRM.
 * SDR ↔ CRM phone match is **Zoho Leads only** (product scope: all Leads in CRM, bounded scan).
 * SDR process scope (Five9 as doc home, governance v2.1 target, API deferral) — see `sdrProcessScope.ts`.
 */

import { getSdrProcessScopeForApi } from "./sdrProcessScope";

export type ImportChannelId = "five9" | "bulk_upload" | "google_drive";

export type ImportChannelStatus = "available" | "partial" | "planned";

export interface ImportChannelEndpoint {
  method: string;
  path: string;
  notes?: string;
}

export interface ImportChannelInfo {
  id: ImportChannelId;
  label: string;
  status: ImportChannelStatus;
  description: string;
  endpoints: ImportChannelEndpoint[];
}

export const CRM_PHONE_MATCH_SCOPE =
  "zoho_leads_only" as const;

export const CRM_PHONE_MATCH_SCOPE_DESCRIPTION =
  "Phone-based SDR ↔ CRM alignment uses the Zoho **Leads** module only. `findLeadsByPhoneMatch` scans fetched Leads (bounded by max_records) and matches Phone/Mobile. Contacts, Deals, and Activities are out of scope.";

export function getCallImportSourcesCatalog(): {
  crm_phone_match_scope: typeof CRM_PHONE_MATCH_SCOPE;
  crm_phone_match_scope_description: string;
  sdr_process_scope: ReturnType<typeof getSdrProcessScopeForApi>;
  channels: ImportChannelInfo[];
} {
  return {
    crm_phone_match_scope: CRM_PHONE_MATCH_SCOPE,
    crm_phone_match_scope_description: CRM_PHONE_MATCH_SCOPE_DESCRIPTION,
    sdr_process_scope: getSdrProcessScopeForApi(),
    channels: [
      {
        id: "five9",
        label: "Five9",
        status: "partial",
        description:
          "SDR team documentation and operational scripts live in Five9. Automated Five9 Reporting/Web Services pull (list calls + recording URLs) is deferred — add later. Meanwhile: configure/test via POST /api/calls/five9/* and ingest per call with POST /api/calls/ingest (source five9) when recording URLs are available from exports or webhooks.",
        endpoints: [
          { method: "POST", path: "/api/calls/five9/test" },
          { method: "POST", path: "/api/calls/five9/configure" },
          {
            method: "POST",
            path: "/api/calls/five9/sync",
            notes: "Completes last_sync metadata; full Reporting API ingestion to be wired in callIntelligenceRoutes.",
          },
          {
            method: "POST",
            path: "/api/calls/ingest",
            notes: "Per-call push with source five9, recording_url, agent_email, optional lead_id.",
          },
        ],
      },
      {
        id: "bulk_upload",
        label: "Bulk upload / batch from spreadsheets or exports",
        status: "available",
        description:
          "Turn CSV or document-backed call lists into JSON and POST to bulk-upload (max 100 rows per request), or upload single/multipart audio via upload and upload-audio. Each row can include lead_id for Zoho Lead linkage.",
        endpoints: [
          {
            method: "POST",
            path: "/api/calls/bulk-upload",
            notes: "Body: { calls: [{ agent_email, recording_url?, call_id?, lead_id?, ... }] }",
          },
          { method: "POST", path: "/api/calls/upload", notes: "Multipart manual file" },
          {
            method: "POST",
            path: "/api/calls/upload-audio",
            notes: "Multipart + transcription path when configured",
          },
        ],
      },
      {
        id: "google_drive",
        label: "Google Drive (or shared folder)",
 slack-audit-notification-alignment
        status: "available",
        description:
          "Lists audio recordings in a Drive folder and creates call_records (source=google_drive) with recording_url pointing at the Drive media endpoint. Auth resolves at runtime in this order: Replit Drive connector → Service Account (GOOGLE_DRIVE_CLIENT_EMAIL + GOOGLE_DRIVE_PRIVATE_KEY) → OAuth refresh (GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN). Trigger transcription via existing upload-audio / Whisper path on the resulting record.",

        status: "planned",
        description:
          "Planned: service-account or OAuth, list folder, download audio, transcribe, then ingest with source google_drive. Use bulk or Five9 ingest until Drive client env is set.",
 main
        endpoints: [
          {
            method: "POST",
            path: "/api/calls/mcp/drive-import",
 slack-audit-notification-alignment
            notes:
              "Body: { folder_id?, query?, page_size?, page_token?, agent_email, default_direction?, dry_run? }. Returns 503 if no auth path configured.",

            notes: "Returns 501 with env hints until implemented.",
 main
          },
          {
            method: "POST",
            path: "/api/calls/ingest",
 slack-audit-notification-alignment
            notes: "Also valid for one-off Drive-sourced calls (source=google_drive).",

            notes: "Once downloaded, same ingest contract with source google_drive.",
 main
          },
        ],
      },
    ],
  };
}
