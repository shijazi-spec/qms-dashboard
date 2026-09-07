/**
 * connectorEvidenceRoutes — read and run the automated evidence connectors.
 *
 * Two verbs, deliberately separated:
 *   GET  /api/connectors/github          - what we currently hold, plus whether
 *                                          the App is configured at all
 *   POST /api/connectors/github/collect  - go and look now
 *   GET  /api/connectors/github/history  - one check over time, which is the
 *                                          question an auditor actually asks
 *
 * Collection is a POST because it calls an external service and appends rows;
 * making it a GET would let a page refresh, a link preview or a crawler trigger
 * API traffic against GitHub.
 */

import { logger as safeLogger } from "../../utils/logger";

const READ_ROLES = [
  "admin",
  "grc_manager",
  "quality_manager",
  "head_of_operations_quality",
  "executive",
];
const WRITE_ROLES = [
  "admin",
  "grc_manager",
  "quality_manager",
  "head_of_operations_quality",
];

async function gate(c: any, allowed: string[]) {
  const { requireRole, getSessionUser, unauthorizedResponse, forbiddenResponse } =
    await import("../../utils/rbacMiddleware");
  const user = await requireRole(c, allowed as any);
  if (!user) {
    if (!getSessionUser(c)) return { error: unauthorizedResponse(c), user: null };
    return { error: forbiddenResponse(c, "Permission denied for connectors"), user: null };
  }
  return { error: null, user };
}

export const connectorEvidenceRoutes = [
  {
    path: "/api/connectors/github",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, READ_ROLES);
          if (g.error) return g.error;

          const { githubAppConfigured } = await import("../../utils/githubAppAuth");
          const { evidenceRepo, CHECK_CLAUSE_MAP, GITHUB_SOURCE } = await import(
            "../../utils/githubEvidenceConnector"
          );
          const { latestObservations } = await import(
            "../../utils/connectorEvidenceDatabase"
          );

          const rows = await latestObservations(GITHUB_SOURCE);
          return c.json({
            success: true,
            configured: githubAppConfigured(),
            repo: evidenceRepo(),
            clause_map: CHECK_CLAUSE_MAP,
            observations: rows,
            // Say plainly when there is nothing rather than returning [] and
            // letting the page guess whether that means "clean" or "never ran".
            never_collected: rows.length === 0,
          });
        } catch (error) {
          safeLogger.error("❌ [Connectors] github status error:", error);
          return c.json({ error: "Failed to read connector evidence" }, 500);
        }
      };
    },
  },
  {
    path: "/api/connectors/github/collect",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, WRITE_ROLES);
          if (g.error) return g.error;

          const { collectGithubEvidence } = await import(
            "../../utils/githubEvidenceConnector"
          );
          const result = await collectGithubEvidence();

          if (!result.configured) {
            // 200, not an error: "the App is not set up" is a true answer to
            // the question asked, and the UI needs to render it as guidance.
            return c.json({
              success: false,
              configured: false,
              repo: result.repo,
              message:
                "GitHub App not configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.",
            });
          }
          return c.json({
            success: true,
            configured: true,
            repo: result.repo,
            written: result.written,
            observations: result.observations,
          });
        } catch (error) {
          safeLogger.error("❌ [Connectors] github collect error:", error);
          return c.json({ error: "Failed to collect GitHub evidence" }, 500);
        }
      };
    },
  },
  {
    path: "/api/connectors/github/history",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, READ_ROLES);
          if (g.error) return g.error;

          const checkKey = String(c.req.query("check") || "").trim();
          if (!checkKey) return c.json({ error: "check is required" }, 400);

          const { observationHistory } = await import(
            "../../utils/connectorEvidenceDatabase"
          );
          const { GITHUB_SOURCE } = await import(
            "../../utils/githubEvidenceConnector"
          );
          const rows = await observationHistory(GITHUB_SOURCE, checkKey, {
            subject: c.req.query("subject") || undefined,
            since: c.req.query("since") || undefined,
            limit: Number(c.req.query("limit")) || undefined,
          });
          return c.json({ success: true, check: checkKey, observations: rows });
        } catch (error) {
          safeLogger.error("❌ [Connectors] github history error:", error);
          return c.json({ error: "Failed to read connector history" }, 500);
        }
      };
    },
  },
];
