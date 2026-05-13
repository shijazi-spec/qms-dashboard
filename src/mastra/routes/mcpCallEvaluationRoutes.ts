import {
  requireAdminOrKey,
  requireRoleOrKey,
  unauthorizedResponse,
} from "../../utils/rbacMiddleware";

const CALL_READ_ROLES = [
  "admin",
  "ai_specialist",
  "head_of_operations_quality",
  "quality_manager",
  "team_lead",
  "grc_manager",
] as const;

/**
 * MCP evaluation & call–lead reconciliation API.
 * - Reconciliation compares transcript vs stored QA / analysis (programmatic checks).
 * - Phone match: Zoho **Leads only** (all Leads in CRM, bounded scan) — see GET import-sources.
 * - Import channels: Five9 (partial), bulk upload (live), Google Drive (stub).
 */
export const mcpCallEvaluationRoutes = [
  {
    path: "/api/calls/mcp/import-sources",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = await requireRoleOrKey(c, [...CALL_READ_ROLES]);
        if (!user) return unauthorizedResponse(c);

        const { getCallImportSourcesCatalog } =
          await import("../../utils/callMcpImportSources");

        return c.json({
          success: true,
          mcp_evaluation_framework: "programmatic_v1",
          ...getCallImportSourcesCatalog(),
        });
      };
    },
  },
  {
    path: "/api/calls/mcp/reconciliation/:id",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = await requireRoleOrKey(c, [...CALL_READ_ROLES]);
        if (!user) return unauthorizedResponse(c);

        const id = Number.parseInt(String(c.req.param("id") || ""), 10);
        if (!Number.isFinite(id) || id <= 0) {
          return c.json({ error: "Invalid call record id" }, 400);
        }

        const { initCallIntelligenceTables, getCallWithFullAnalysis } =
          await import("../../utils/callIntelligenceDb");
        const { buildTranscriptVsEvaluationReport } =
          await import("../../utils/callMcpReconciliation");

        await initCallIntelligenceTables();
        const bundle = await getCallWithFullAnalysis(id);
        if (!bundle.record) {
          return c.json({ error: "Call record not found" }, 404);
        }

        const report = buildTranscriptVsEvaluationReport({
          call_record_id: id,
          lead_id: bundle.record.lead_id,
          agent_email: bundle.record.agent_email,
          transcript_text: bundle.transcript?.transcript_text ?? null,
          talk_ratio: bundle.analysis?.talk_ratio ?? null,
          sentiment_label: bundle.analysis?.sentiment_label ?? null,
          qa_score_percentage: bundle.qaScore?.score_percentage ?? null,
          improvements: bundle.qaScore?.improvements ?? null,
        });

        const { getSdrProcessScopeForApi } = await import("../../utils/sdrProcessScope");

        return c.json({
          success: true,
          mcp_evaluation_framework: "programmatic_v1",
          sdr_process_scope: getSdrProcessScopeForApi(),
          report,
        });
      };
    },
  },
  {
    path: "/api/calls/mcp/leads/match-phone",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = await requireRoleOrKey(c, [...CALL_READ_ROLES]);
        if (!user) return unauthorizedResponse(c);

        let body: { phone?: string; max_records?: number } = {};
        try {
          body = (await c.req.json()) || {};
        } catch {
          body = {};
        }
        const phone = String(body.phone || "").trim();
        if (!phone) {
          return c.json({ error: "phone is required" }, 400);
        }

        const { findLeadsByPhoneMatch } = await import("../../utils/callLeadPhoneMatch");
        const result = await findLeadsByPhoneMatch(phone, {
          maxRecords: body.max_records,
        });

        const { CRM_PHONE_MATCH_SCOPE, CRM_PHONE_MATCH_SCOPE_DESCRIPTION } =
          await import("../../utils/callMcpImportSources");

        return c.json({
          success: true,
          crm_phone_match_scope: CRM_PHONE_MATCH_SCOPE,
          crm_phone_match_scope_description: CRM_PHONE_MATCH_SCOPE_DESCRIPTION,
          ...result,
          note:
            result.scanned === 0 && result.matches.length === 0
              ? "No Zoho credentials or no Leads fetched — configure Zoho and retry."
              : undefined,
        });
      };
    },
  },
  {
    path: "/api/calls/mcp/drive-import",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        const admin = await requireAdminOrKey(c);
        if (!admin) return unauthorizedResponse(c);

        let body: {
          folder_id?: string;
          query?: string;
          page_size?: number;
          page_token?: string;
          agent_email?: string;
          default_direction?: "inbound" | "outbound";
          dry_run?: boolean;
        } = {};
        try {
          body = (await c.req.json()) || {};
        } catch {
          body = {};
        }

        const agent_email = String(body.agent_email || "").trim();
        if (!agent_email) {
          return c.json(
            { error: "agent_email is required to attribute imported call_records." },
            400,
          );
        }

        const { driveCallImportTool } = await import("../tools/driveCallImportTool");
        const result = await (driveCallImportTool as any).execute({
          context: {
            folder_id: body.folder_id,
            query: body.query,
            page_size: body.page_size,
            page_token: body.page_token,
            agent_email,
            default_direction: body.default_direction ?? "outbound",
            dry_run: body.dry_run ?? false,
          },
        });

        if (result.auth_mode === "none") {
          return c.json(
            {
              success: false,
              status: "no_auth",
              ...result,
              required_env_options: [
                "Replit Drive connector (REPLIT_CONNECTORS_HOSTNAME + repl identity)",
                "Service Account (GOOGLE_DRIVE_CLIENT_EMAIL + GOOGLE_DRIVE_PRIVATE_KEY)",
                "OAuth refresh (GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REFRESH_TOKEN)",
              ],
            },
            503,
          );
        }

        return c.json({ success: true, ...result });
      };
    },
  },
  {
    path: "/api/calls/mcp/validate/:id",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = await requireRoleOrKey(c, [...CALL_READ_ROLES]);
        if (!user) return unauthorizedResponse(c);

        const id = Number.parseInt(String(c.req.param("id") || ""), 10);
        if (!Number.isFinite(id) || id <= 0) {
          return c.json({ error: "Invalid call record id" }, 400);
        }

        const { runSdrCallValidation, evaluateAndPersistGovernance } =
          await import("../../utils/sdrCallValidation");
        const result = await runSdrCallValidation(id);
        if (!result.found) {
          return c.json({ error: "Call record not found" }, 404);
        }
        // Re-evaluate-and-persist so the dashboard snapshot reflects the latest run.
        await evaluateAndPersistGovernance(id).catch(() => null);
        return c.json({ success: true, ...result });
      };
    },
  },
  {
    path: "/api/calls/mcp/governance/:id",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = await requireRoleOrKey(c, [...CALL_READ_ROLES]);
        if (!user) return unauthorizedResponse(c);

        const id = Number.parseInt(String(c.req.param("id") || ""), 10);
        if (!Number.isFinite(id) || id <= 0) {
          return c.json({ error: "Invalid call record id" }, 400);
        }

        const { getGovernanceResultByCallId, initCallIntelligenceTables } =
          await import("../../utils/callIntelligenceDb");
        await initCallIntelligenceTables();
        const snapshot = await getGovernanceResultByCallId(id);
        if (!snapshot) {
          return c.json(
            {
              success: true,
              found: false,
              note: "No governance snapshot yet. POST /api/calls/mcp/validate/:id to create one.",
            },
            200,
          );
        }
        return c.json({ success: true, found: true, snapshot });
      };
    },
  },
];
