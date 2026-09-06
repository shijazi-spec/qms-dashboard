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
  // Three route objects were removed here: GET import-sources,
  // GET reconciliation/:id and POST leads/match-phone. All three were
  // UNREACHABLE — callIntelligenceRoutes.ts defines the same three paths and
  // is spread earlier in src/mastra/index.ts, so its handlers always won.
  // dashboard/calls.html calls all three and gets the callIntelligence
  // versions; deleting these changes no behaviour. The copies here returned
  // an extra `success`/`mcp_evaluation_framework` envelope that no caller
  // ever saw. The routes below this point are live and unique to this module.

  {
    path: "/api/calls/evaluation/drive-import",
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
    path: "/api/calls/evaluation/validate/:id",
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
    path: "/api/calls/evaluation/governance/:id",
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
              note: "No governance snapshot yet. POST /api/calls/evaluation/validate/:id to create one.",
            },
            200,
          );
        }
        return c.json({ success: true, found: true, snapshot });
      };
    },
  },
];
