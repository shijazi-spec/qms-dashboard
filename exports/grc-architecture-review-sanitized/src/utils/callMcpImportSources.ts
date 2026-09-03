/**
 * Canonical description of how calls enter QMS and how they align to CRM.
 * SDR ↔ CRM phone match is **CRMProvider Leads only** (product scope: all Leads in CRM, bounded scan).
 * SDR process scope (ContactCenterProvider as doc home, governance v2.1 target, API deferral) — see `sdrProcessScope.ts`.
 */

import { getSdrProcessScopeForApi } from "./sdrProcessScope";

export type ImportChannelId = "ContactCenterProvider" | "bulk_upload" | "IdentityProvider_drive";

/**
 * Channel availability state. `suspended` was added when the SDR/QA team
 * paused the ContactCenterProvider integration pending a real Reporting-API rollout (see
 * `ContactCenterProvider_ENABLED` env flag below). It differs from `planned` (work hasn't
 * started) and `partial` (some endpoints work but full sync isn't wired)
 * by signalling "the code is here, the team chose not to expose it yet".
 * The UI renders suspended channels with a neutral banner and disabled
 * controls instead of error states.
 */
export type ImportChannelStatus = "available" | "partial" | "planned" | "suspended";

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
  /**
   * Optional operator-facing message shown verbatim by the dashboard
   * banner when the channel is `suspended`. Only set on suspended
   * channels — UI ignores it for other statuses.
   */
  suspended_notice?: string;
}

/**
 * Read the ContactCenterProvider_ENABLED env flag. Default is `false` — i.e. the ContactCenterProvider
 * channel is *suspended* until ops explicitly opts in by setting
 * ContactCenterProvider_ENABLED=true. The actual ContactCenterProvider backend code, routes, and DB
 * tables remain in place so flipping the flag re-enables the integration
 * without a code change. The flag controls UI visibility + the catalog
 * status reported by /api/calls/evaluation/import-sources (and the
 * `get-import-sources` MCP tool), nothing more.
 */
function isContactCenterProviderEnabled(): boolean {
  return process.env.ContactCenterProvider_ENABLED === "true";
}

export const CRM_PHONE_MATCH_SCOPE =
  "CRMProvider_leads_deals_with_activity_fallback" as const;

export const CRM_PHONE_MATCH_SCOPE_DESCRIPTION =
  "SDR ↔ CRM linkage runs in two phases. **Phase 1** — phone-digit match against CRMProvider **Leads + Deals** modules (Deals win when both contain a unique match, since a converted Deal supersedes its source Lead). **Phase 2 fallback** — when the phone digits don't pull up a unique record, the linker scans Notes / Calls / Tasks / Events created by the same agent on the same day as the call and links to the parent Lead/Deal when there is exactly one candidate. The result is tagged in `call_records.linked_via` so the UI can flag phone vs activity matches at different confidence levels. Contacts and Accounts remain out of scope.";

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
        id: "ContactCenterProvider",
        label: "ContactCenterProvider",
        // When ContactCenterProvider_ENABLED=true → fall back to the historical 'partial'
        // status (legacy behaviour). When the flag is off (the default
        // tonight, pending the tech team) → 'suspended', which the UI
        // renders as a neutral banner rather than an error or empty state.
        status: isContactCenterProviderEnabled() ? "partial" : "suspended",
        description:
          "SDR team documentation and operational scripts live in ContactCenterProvider. Automated ContactCenterProvider Reporting/Web Services pull (list calls + recording URLs) is deferred — add later. Meanwhile: configure/test via POST /api/calls/ContactCenterProvider/* and ingest per call with POST /api/calls/ingest (source ContactCenterProvider) when recording URLs are available from exports or webhooks.",
        ...(isContactCenterProviderEnabled()
          ? {}
          : {
              suspended_notice:
                "ContactCenterProvider integration is prepared but temporarily suspended. Please use manual upload until API setup is completed.",
            }),
        endpoints: [
          { method: "POST", path: "/api/calls/ContactCenterProvider/test" },
          { method: "POST", path: "/api/calls/ContactCenterProvider/configure" },
          {
            method: "POST",
            path: "/api/calls/ContactCenterProvider/sync",
            notes: "Completes last_sync metadata; full Reporting API ingestion to be wired in callIntelligenceRoutes.",
          },
          {
            method: "POST",
            path: "/api/calls/ingest",
            notes: "Per-call push with source ContactCenterProvider, recording_url, agent_email, optional lead_id.",
          },
        ],
      },
      {
        id: "bulk_upload",
        label: "Bulk upload / batch from spreadsheets or exports",
        status: "available",
        description:
          "Turn CSV or document-backed call lists into JSON and POST to bulk-upload (max 100 rows per request), or upload single/multipart audio via upload and upload-audio. Each row can include lead_id for CRMProvider Lead linkage.",
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
        id: "IdentityProvider_drive",
        label: "IdentityProvider Drive (or shared folder)",
        status: "planned",
        description:
          "Planned: service-account or OAuth, list folder, download audio, transcribe, then ingest with source IdentityProvider_drive. Use bulk or ContactCenterProvider ingest until Drive client env is set.",
        endpoints: [
          {
            method: "POST",
            path: "/api/calls/evaluation/drive-import",
            notes: "Returns 501 with env hints until implemented.",
          },
          {
            method: "POST",
            path: "/api/calls/ingest",
            notes: "Once downloaded, same ingest contract with source IdentityProvider_drive.",
          },
        ],
      },
    ],
  };
}
