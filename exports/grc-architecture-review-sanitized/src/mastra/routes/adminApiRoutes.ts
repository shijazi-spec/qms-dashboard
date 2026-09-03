import { getSessionFromCookie } from "./authRoutes";
import {
  isAdminAuthorized,
  hasValidAdminApiKey,
} from "../../utils/rbacMiddleware";

import { logger } from "../../utils/logger";
export const adminApiRoutes = [
  {
    // Security: this endpoint validates the raw ADMIN_API_KEY for server-to-server
    // tooling only. It no longer issues browser session cookies. Browser admin
    // access requires OIDC login with an admin platform role. Returning 200 on
    // success allows automation scripts that call this endpoint to detect a valid
    // key; they should use the X-Admin-Key header on subsequent API requests.
    path: "/api/admin/auth",
    method: "POST",
    createHandler: async () => {
      return async (c: any) => {
        try {
          const body = await c.req.json();
          const key = body?.key;
          const expectedKey = process.env.ADMIN_API_KEY;
          if (!expectedKey || !key || key !== expectedKey)
            return c.json({ error: "Authentication required" }, 401);
          return c.json({
            success: true,
            note: "Key verified. Use the X-Admin-Key header for subsequent requests.",
          });
        } catch (error) {
          return c.json({ error: "Authentication failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/auth/logout",
    method: "POST",
    createHandler: async () => {
      return async (c: any) => {
        // Clear any residual admin cookies from previous deployments that used
        // the now-removed cookie-based admin auth path. All three flags are
        // required and unconditional: HttpOnly (XSS), Secure (HTTPS-only),
        // SameSite=Strict (CSRF).
        c.header(
          "Set-Cookie",
          `admin_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
          { append: true },
        );
        c.header(
          "Set-Cookie",
          `admin_key=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
          { append: true },
        );
        return c.json({ success: true });
      };
    },
  },
  {
    path: "/api/admin/documents",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const hasSession = !!getSessionFromCookie(c.req.header("Cookie"));
          if (!hasValidAdminApiKey(c) && !hasSession)
            return c.json({ error: "Authentication required" }, 401);
          const { getAllGovernanceDocuments } =
            await import("../../utils/database");
          const documents = await getAllGovernanceDocuments();
          return c.json(documents);
        } catch (error) {
          logger.error("Error fetching documents:", error);
          return c.json({ error: "Failed to fetch documents" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/documents",
    method: "POST",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey: rak } =
            await import("../../utils/rbacMiddleware");
          const adminUser = await rak(c);
          if (!adminUser)
            return c.json({ error: "Admin access required" }, 403);
          const data = await c.req.json();
          const { saveGovernanceDocument, logAdminActivity } =
            await import("../../utils/database");
          const doc = await saveGovernanceDocument({
            name: data.name,
            document_type: data.document_type || "sales",
            version: data.version,
            file_path: data.file_path || null,
            content_text: data.content_text,
            rules_json: data.rules_json,
            is_active: data.is_active !== false,
          });
          await logAdminActivity({
            action_type: "document_upload",
            action_description: `Uploaded governance document: ${data.name} (${data.version})`,
            target_type: "governance_document",
            target_id: String(doc.id),
            target_name: data.name,
            metadata: {
              version: data.version,
              document_type: data.document_type || "sales",
              is_active: data.is_active !== false,
            },
          });
          return c.json(doc);
        } catch (error) {
          logger.error("Error saving document:", error);
          return c.json({ error: "Failed to save document" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/documents/:id/activate",
    method: "PUT",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const id = parseInt(c.req.param("id"));
          const { activateGovernanceDocument, logAdminActivity } =
            await import("../../utils/database");
          await activateGovernanceDocument(id);
          await logAdminActivity({
            action_type: "document_activate",
            action_description: `Activated governance document ID: ${id}`,
            target_type: "governance_document",
            target_id: String(id),
            metadata: { activated: true },
          });
          return c.json({ success: true });
        } catch (error) {
          logger.error("Error activating document:", error);
          return c.json({ error: "Failed to activate document" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/scorecard/weights",
    method: "PUT",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const weights = await c.req.json();
          const { updateScorecardWeights, logAdminActivity } =
            await import("../../utils/database");
          const scorecard = await updateScorecardWeights(weights);
          if (!scorecard)
            return c.json({ error: "No active scorecard found" }, 404);
          await logAdminActivity({
            action_type: "scorecard_weights_update",
            action_description: `Updated scorecard weights: People=${weights.people}%, Process=${weights.process}%, Governance=${weights.governance}%`,
            target_type: "scorecard",
            target_id: String(scorecard.id),
            target_name: scorecard.name,
            metadata: weights,
          });
          return c.json(scorecard);
        } catch (error) {
          logger.error("Error updating weights:", error);
          return c.json({ error: "Failed to update weights" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/scorecard/attributes",
    method: "POST",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const attr = await c.req.json();
          const { addScorecardAttribute, logAdminActivity } =
            await import("../../utils/database");
          const scorecard = await addScorecardAttribute(attr);
          if (!scorecard)
            return c.json({ error: "No active scorecard found" }, 404);
          await logAdminActivity({
            action_type: "scorecard_attribute_add",
            action_description: `Added scorecard attribute: ${attr.name} in ${attr.dimension} dimension`,
            target_type: "scorecard",
            target_id: String(scorecard.id),
            target_name: attr.name,
            metadata: {
              dimension: attr.dimension,
              weight: attr.weight,
              target: attr.target,
            },
          });
          return c.json(scorecard);
        } catch (error) {
          logger.error("Error adding attribute:", error);
          return c.json({ error: "Failed to add attribute" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/scorecard/link-doc",
    method: "PUT",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const { governance_doc_id, crm_module, team_name } =
            await c.req.json();
          const { linkScorecardToGovernanceDoc, logAdminActivity } =
            await import("../../utils/database");
          const result = await linkScorecardToGovernanceDoc(
            governance_doc_id,
            crm_module,
            team_name,
          );
          if (!result)
            return c.json(
              {
                error: "Failed to link document - no matching scorecard found",
              },
              404,
            );
          await logAdminActivity({
            action_type: "scorecard_link_doc",
            action_description: `Linked governance document ${governance_doc_id} to scorecard for ${team_name} team (${crm_module})`,
            target_type: "scorecard",
            target_id: String(result.id),
            metadata: { governance_doc_id, crm_module, team_name },
          });
          return c.json({ success: true, scorecard: result });
        } catch (error) {
          logger.error("Error linking document to scorecard:", error);
          return c.json({ error: "Failed to link document" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/scorecards",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const crmModule = c.req.query("crm_module") || null;
          const teamName = c.req.query("team_name") || null;
          const { getScorecardsByModuleAndTeam } =
            await import("../../utils/database");
          const scorecards = await getScorecardsByModuleAndTeam(
            crmModule,
            teamName,
          );
          return c.json(scorecards);
        } catch (error) {
          logger.error("Error fetching scorecards:", error);
          return c.json({ error: "Failed to fetch scorecards" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/scorecards",
    method: "POST",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const data = await c.req.json();
          const { createScorecard, logAdminActivity } =
            await import("../../utils/database");
          const scorecard = await createScorecard(data);
          await logAdminActivity({
            action_type: "scorecard_create",
            action_description: `Created scorecard: ${data.name}`,
            target_type: "scorecard",
            target_id: String(scorecard.id),
            metadata: data,
          });
          return c.json(scorecard);
        } catch (error) {
          logger.error("Error creating scorecard:", error);
          return c.json({ error: "Failed to create scorecard" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/scorecards/:id",
    method: "PUT",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const id = parseInt(c.req.param("id"));
          const updates = await c.req.json();
          const { updateScorecard, logAdminActivity } =
            await import("../../utils/database");
          const scorecard = await updateScorecard(id, updates);
          if (!scorecard) return c.json({ error: "Scorecard not found" }, 404);
          await logAdminActivity({
            action_type: "scorecard_update",
            action_description: `Updated scorecard: ${scorecard.name}`,
            target_type: "scorecard",
            target_id: String(id),
            metadata: updates,
          });
          return c.json(scorecard);
        } catch (error) {
          logger.error("Error updating scorecard:", error);
          return c.json({ error: "Failed to update scorecard" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/scorecards/:id",
    method: "DELETE",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const id = parseInt(c.req.param("id"));
          const { deleteScorecard, logAdminActivity } =
            await import("../../utils/database");
          const deleted = await deleteScorecard(id);
          if (!deleted) return c.json({ error: "Scorecard not found" }, 404);
          await logAdminActivity({
            action_type: "scorecard_delete",
            action_description: `Deleted scorecard ID: ${id}`,
            target_type: "scorecard",
            target_id: String(id),
          });
          return c.json({ success: true });
        } catch (error) {
          logger.error("Error deleting scorecard:", error);
          return c.json({ error: "Failed to delete scorecard" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/scorecards/:id/activate",
    method: "PUT",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const id = parseInt(c.req.param("id"));
          const { crm_module, team_name } = await c.req.json();
          const { setActiveScorecardForTeam, logAdminActivity } =
            await import("../../utils/database");
          const scorecard = await setActiveScorecardForTeam(
            id,
            crm_module,
            team_name,
          );
          if (!scorecard) return c.json({ error: "Scorecard not found" }, 404);
          await logAdminActivity({
            action_type: "scorecard_activate",
            action_description: `Activated scorecard: ${scorecard.name} for ${team_name} (${crm_module})`,
            target_type: "scorecard",
            target_id: String(id),
            metadata: { crm_module, team_name },
          });
          return c.json(scorecard);
        } catch (error) {
          logger.error("Error activating scorecard:", error);
          return c.json({ error: "Failed to activate scorecard" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/scorecards/:id/clone",
    method: "POST",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const id = parseInt(c.req.param("id"));
          const { name, version } = await c.req.json();
          const { cloneScorecard, logAdminActivity } =
            await import("../../utils/database");
          const scorecard = await cloneScorecard(id, name, version);
          if (!scorecard)
            return c.json({ error: "Original scorecard not found" }, 404);
          await logAdminActivity({
            action_type: "scorecard_clone",
            action_description: `Cloned scorecard ID ${id} to: ${name}`,
            target_type: "scorecard",
            target_id: String(scorecard.id),
            metadata: { original_id: id, new_name: name, version },
          });
          return c.json(scorecard);
        } catch (error) {
          logger.error("Error cloning scorecard:", error);
          return c.json({ error: "Failed to clone scorecard" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/scorecards/:id/attributes",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const scorecardId = parseInt(c.req.param("id"));
          const { getScorecardAttributes } =
            await import("../../utils/database");
          const attributes = await getScorecardAttributes(scorecardId);
          return c.json(attributes);
        } catch (error) {
          logger.error("Error fetching attributes:", error);
          return c.json({ error: "Failed to fetch attributes" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/scorecards/:id/attributes",
    method: "POST",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const scorecardId = parseInt(c.req.param("id"));
          const data = await c.req.json();
          const { createScorecardAttribute, logAdminActivity } =
            await import("../../utils/database");
          const attribute = await createScorecardAttribute({
            scorecard_id: scorecardId,
            ...data,
          });
          await logAdminActivity({
            action_type: "attribute_create",
            action_description: `Added attribute: ${data.attribute_name}`,
            target_type: "scorecard_attribute",
            target_id: String(attribute.id),
            metadata: data,
          });
          return c.json(attribute);
        } catch (error) {
          logger.error("Error creating attribute:", error);
          return c.json({ error: "Failed to create attribute" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/attributes/:id",
    method: "PUT",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const id = parseInt(c.req.param("id"));
          const updates = await c.req.json();
          const { updateScorecardAttribute, logAdminActivity } =
            await import("../../utils/database");
          const attribute = await updateScorecardAttribute(id, updates);
          if (!attribute) return c.json({ error: "Attribute not found" }, 404);
          await logAdminActivity({
            action_type: "attribute_update",
            action_description: `Updated attribute: ${attribute.attribute_name}`,
            target_type: "scorecard_attribute",
            target_id: String(id),
            metadata: updates,
          });
          return c.json(attribute);
        } catch (error) {
          logger.error("Error updating attribute:", error);
          return c.json({ error: "Failed to update attribute" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/attributes/:id",
    method: "DELETE",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const id = parseInt(c.req.param("id"));
          const { deleteScorecardAttribute, logAdminActivity } =
            await import("../../utils/database");
          const deleted = await deleteScorecardAttribute(id);
          if (!deleted) return c.json({ error: "Attribute not found" }, 404);
          await logAdminActivity({
            action_type: "attribute_delete",
            action_description: `Deleted attribute ID: ${id}`,
            target_type: "scorecard_attribute",
            target_id: String(id),
          });
          return c.json({ success: true });
        } catch (error) {
          logger.error("Error deleting attribute:", error);
          return c.json({ error: "Failed to delete attribute" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/scorecards/:id/attributes/reorder",
    method: "PUT",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const scorecardId = parseInt(c.req.param("id"));
          const { attribute_ids } = await c.req.json();
          const { reorderScorecardAttributes, logAdminActivity } =
            await import("../../utils/database");
          await reorderScorecardAttributes(scorecardId, attribute_ids);
          await logAdminActivity({
            action_type: "attributes_reorder",
            action_description: `Reordered attributes for scorecard ID: ${scorecardId}`,
            target_type: "scorecard",
            target_id: String(scorecardId),
            metadata: { attribute_ids },
          });
          return c.json({ success: true });
        } catch (error) {
          logger.error("Error reordering attributes:", error);
          return c.json({ error: "Failed to reorder attributes" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/seed-defaults",
    method: "POST",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const { saveGovernanceDocument, saveScorecard, logAdminActivity } =
            await import("../../utils/database");
          const { ExampleOrgSalesGovernanceRules, qualityScorecardConfig } =
            await import("../../utils/governanceRules");
          await saveGovernanceDocument({
            name: ExampleOrgSalesGovernanceRules.document.name,
            document_type: "sales",
            version: ExampleOrgSalesGovernanceRules.document.version,
            file_path:
              "attached_assets/ExampleOrg_Sales_1.1_01.12.2025_EN_1764681400933.pdf",
            content_text: JSON.stringify(ExampleOrgSalesGovernanceRules, null, 2),
            rules_json: ExampleOrgSalesGovernanceRules,
            is_active: true,
          });
          await saveScorecard({
            name: qualityScorecardConfig.name,
            description: qualityScorecardConfig.description,
            dimensions: qualityScorecardConfig,
            is_active: true,
          });
          await logAdminActivity({
            action_type: "seed_defaults",
            action_description: "Reset governance data to default values",
            target_type: "system",
            metadata: {
              document: ExampleOrgSalesGovernanceRules.document.name,
              scorecard: qualityScorecardConfig.name,
            },
          });
          return c.json({ success: true, message: "Default data restored" });
        } catch (error) {
          logger.error("Error seeding defaults:", error);
          return c.json({ error: "Failed to seed defaults" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/activities",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const { getAdminActivities } = await import("../../utils/database");
          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");
          const action_type = c.req.query("action_type");
          const startDate = c.req.query("startDate")
            ? new Date(c.req.query("startDate"))
            : undefined;
          const endDate = c.req.query("endDate")
            ? new Date(c.req.query("endDate"))
            : undefined;
          const result = await getAdminActivities({
            limit,
            offset,
            action_type,
            startDate,
            endDate,
          });
          return c.json(result);
        } catch (error) {
          logger.error("Error fetching admin activities:", error);
          return c.json({ error: "Failed to fetch admin activities" }, 500);
        }
      };
    },
  },
  {
    path: "/api/workflow/runs",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const { getWorkflowRuns } = await import("../../utils/database");
          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");
          const workflow_id = c.req.query("workflow_id");
          const status = c.req.query("status");
          const startDate = c.req.query("startDate")
            ? new Date(c.req.query("startDate"))
            : undefined;
          const endDate = c.req.query("endDate")
            ? new Date(c.req.query("endDate"))
            : undefined;
          const result = await getWorkflowRuns({
            limit,
            offset,
            workflow_id,
            status,
            startDate,
            endDate,
          });
          return c.json(result);
        } catch (error) {
          logger.error("Error fetching workflow runs:", error);
          return c.json({ error: "Failed to fetch workflow runs" }, 500);
        }
      };
    },
  },
  {
    path: "/api/workflow/runs/:id",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const id = parseInt(c.req.param("id"));
          const { getWorkflowRunById } = await import("../../utils/database");
          const run = await getWorkflowRunById(id);
          if (!run) return c.json({ error: "Workflow run not found" }, 404);
          return c.json(run);
        } catch (error) {
          logger.error("Error fetching workflow run:", error);
          return c.json({ error: "Failed to fetch workflow run" }, 500);
        }
      };
    },
  },
  {
    path: "/api/system/events",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const { getSystemEvents } = await import("../../utils/database");
          const limit = parseInt(c.req.query("limit") || "100");
          const offset = parseInt(c.req.query("offset") || "0");
          const event_type = c.req.query("event_type");
          const event_category = c.req.query("event_category");
          const severity = c.req.query("severity");
          const startDate = c.req.query("startDate")
            ? new Date(c.req.query("startDate"))
            : undefined;
          const endDate = c.req.query("endDate")
            ? new Date(c.req.query("endDate"))
            : undefined;
          const result = await getSystemEvents({
            limit,
            offset,
            event_type,
            event_category,
            severity,
            startDate,
            endDate,
          });
          return c.json(result);
        } catch (error) {
          logger.error("Error fetching system events:", error);
          return c.json({ error: "Failed to fetch system events" }, 500);
        }
      };
    },
  },
  {
    path: "/api/activity/feed",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const { getActivityFeed } = await import("../../utils/database");
          const limit = parseInt(c.req.query("limit") || "50");
          const result = await getActivityFeed(limit);
          return c.json(result);
        } catch (error) {
          logger.error("Error fetching activity feed:", error);
          return c.json({ error: "Failed to fetch activity feed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/activity/stats",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const { getActivityStats } = await import("../../utils/database");
          const stats = await getActivityStats();
          return c.json(stats);
        } catch (error) {
          logger.error("Error fetching activity stats:", error);
          return c.json({ error: "Failed to fetch activity stats" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/rate-limit-stats",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const { getRateLimitStats } = await import("../../utils/rateLimiter");
          const stats = await getRateLimitStats();
          return c.json(stats);
        } catch (error) {
          logger.error("Error fetching rate limit stats:", error);
          return c.json({ error: "Failed to fetch rate limit stats" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/alert-recipients",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const {
            parseChannel,
            listAlertRecipients,
            listAlertRecipientsAudit,
            parseRecipientsEnvValue,
            ALERT_CHANNELS,
          } = await import("../../utils/alertEmailRecipients");
          const channelParam = c.req.query("channel");
          const channel = parseChannel(channelParam);
          if (!channel) {
            return c.json(
              {
                error: "Missing or invalid channel",
                valid_channels: ALERT_CHANNELS,
              },
              400,
            );
          }
          const [recipients, audit] = await Promise.all([
            listAlertRecipients(channel),
            listAlertRecipientsAudit(channel, 25),
          ]);
          // Surface the env fallback to the dashboard so the UI can
          // show "Currently using env-var fallback (3 entries)" when
          // the DB list is empty and POST_RESTORE_SWEEP_ALERT_EMAIL /
          // AI_COST_ALERT_EMAIL is set.
          const envValue =
            channel === "post_restore_sweep"
              ? process.env.POST_RESTORE_SWEEP_ALERT_EMAIL
              : process.env.AI_COST_ALERT_EMAIL;
          const envFallback = parseRecipientsEnvValue(envValue);
          return c.json({
            channel,
            recipients,
            audit,
            env_fallback: envFallback,
            using_env_fallback:
              recipients.length === 0 && envFallback.length > 0,
          });
        } catch (error) {
          logger.error("Error fetching alert recipients:", error);
          return c.json({ error: "Failed to fetch alert recipients" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/alert-recipients",
    method: "POST",
    createHandler: async () => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const body = await c.req.json().catch(() => ({}));
          const { parseChannel, addAlertRecipient, ALERT_CHANNELS } =
            await import("../../utils/alertEmailRecipients");
          const channel = parseChannel(body?.channel);
          if (!channel) {
            return c.json(
              {
                error: "Missing or invalid channel",
                valid_channels: ALERT_CHANNELS,
              },
              400,
            );
          }
          if (typeof body?.email !== "string" || body.email.trim() === "") {
            return c.json({ error: "Missing email" }, 400);
          }
          // Identify the admin actor for the audit row. Fall back to a
          // sentinel value when the admin is using the API-key path
          // (no session cookie) so the audit row is never NULL.
          const session = getSessionFromCookie(c.req.header("Cookie"));
          const changedBy = session?.email || "admin-api-key";
          let result;
          try {
            result = await addAlertRecipient({
              channel,
              email: body.email,
              changedBy,
              note: typeof body?.note === "string" ? body.note : null,
            });
          } catch (validationErr: any) {
            return c.json(
              {
                error: validationErr?.message || "Invalid email",
              },
              400,
            );
          }
          return c.json({ success: true, ...result });
        } catch (error) {
          logger.error("Error adding alert recipient:", error);
          return c.json({ error: "Failed to add alert recipient" }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/alert-recipients",
    method: "DELETE",
    createHandler: async () => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const body = await c.req.json().catch(() => ({}));
          const { parseChannel, removeAlertRecipient, ALERT_CHANNELS } =
            await import("../../utils/alertEmailRecipients");
          const channel = parseChannel(body?.channel);
          if (!channel) {
            return c.json(
              {
                error: "Missing or invalid channel",
                valid_channels: ALERT_CHANNELS,
              },
              400,
            );
          }
          if (typeof body?.email !== "string" || body.email.trim() === "") {
            return c.json({ error: "Missing email" }, 400);
          }
          const session = getSessionFromCookie(c.req.header("Cookie"));
          const changedBy = session?.email || "admin-api-key";
          let result;
          try {
            result = await removeAlertRecipient({
              channel,
              email: body.email,
              changedBy,
              note: typeof body?.note === "string" ? body.note : null,
            });
          } catch (validationErr: any) {
            return c.json(
              {
                error: validationErr?.message || "Invalid email",
              },
              400,
            );
          }
          return c.json({ success: true, ...result });
        } catch (error) {
          logger.error("Error removing alert recipient:", error);
          return c.json({ error: "Failed to remove alert recipient" }, 500);
        }
      };
    },
  },
  {
    // Task #556: dedicated admin endpoint for the post-restore sweep
    // notification history. We can't reuse `/api/notifications` because
    // that path is shadowed by `triggerRoutes` (audit-trigger
    // notifications, role-gated, different schema). This endpoint
    // returns the rows from the notificationHub `notifications` table
    // that the boot redaction sweep emits via
    // `dispatchPostRestoreSweepAlert` — i.e. module='security/redaction-sweep'
    // AND related_entity_id='boot_redaction_sweep'. Both filters are
    // applied so an unrelated future use of the same module can't leak
    // into the dashboard panel.
    path: "/api/admin/redaction-sweep/alerts",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const limitRaw = parseInt(c.req.query("limit") || "20", 10);
          const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? limitRaw : 20;
          const offsetRaw = parseInt(c.req.query("offset") || "0", 10);
          const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
          const { initNotificationTables } = await import("../../utils/notificationHub");
          await initNotificationTables();
          const pg = await import("pg");
          const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
          try {
            const where = `WHERE module = $1 AND related_entity_id = $2`;
            const params = ['security/redaction-sweep', 'boot_redaction_sweep'];
            const countResult = await pool.query(
              `SELECT COUNT(*)::int AS total FROM notifications ${where}`,
              params,
            );
            const rowsResult = await pool.query(
              `SELECT id, title, message, module, priority, channel, status,
                      recipient, related_entity_type, related_entity_id,
                      action_url, sent_at, read_at, created_at
                 FROM notifications ${where}
                 ORDER BY created_at DESC
                 LIMIT $3 OFFSET $4`,
              [...params, limit, offset],
            );

            // Task #656: enrich each notification with the per-table sweep
            // counts pulled from the matching event_logs row's `new_value`
            // (the SweepResult JSON). The dispatcher's notification message
            // only carries 4 of the 5 counts operators want at a glance —
            // `ai_call_metrics` lives only in the event_logs JSON — so we
            // join here rather than have the dashboard re-parse the message.
            //
            // Match strategy: the sweep_timestamp string the dispatcher
            // bakes into the message (`Boot-time redaction sweep at <iso>
            // rewrote ...`) is the same string stored in
            // `event_logs.new_value->>'sweep_timestamp'`. Matching on that
            // exact string is more robust than matching on `created_at`
            // (the audit row and the notification row are inserted by
            // independent code paths and can be milliseconds apart).
            const sweepTsRegex = /sweep at (\S+) rewrote/i;
            const tsList: string[] = [];
            const notifSweepTs = new Map<string, string | null>();
            for (const n of rowsResult.rows) {
              const m = sweepTsRegex.exec(String(n.message ?? ''));
              const ts = m ? m[1] : null;
              notifSweepTs.set(String(n.id), ts);
              if (ts && !tsList.includes(ts)) tsList.push(ts);
            }

            const eventLogMap = new Map<
              string,
              { id: string; new_value: Record<string, unknown> | null }
            >();
            if (tsList.length > 0) {
              try {
                const elResult = await pool.query(
                  `SELECT id::text AS id, new_value
                     FROM event_logs
                    WHERE module = $1
                      AND entity_id = $2
                      AND new_value->>'sweep_timestamp' = ANY($3::text[])`,
                  [
                    'security/redaction-sweep',
                    'boot_redaction_sweep',
                    tsList,
                  ],
                );
                for (const row of elResult.rows) {
                  const nv =
                    row.new_value && typeof row.new_value === 'object'
                      ? (row.new_value as Record<string, unknown>)
                      : null;
                  const ts = nv && typeof nv.sweep_timestamp === 'string'
                    ? (nv.sweep_timestamp as string)
                    : null;
                  if (ts) {
                    eventLogMap.set(ts, { id: row.id, new_value: nv });
                  }
                }
              } catch (joinErr) {
                logger.warn(
                  '[Admin] Failed to join event_logs for post-restore alerts (per-table counts will fall back to message parsing)',
                  { error: joinErr instanceof Error ? joinErr.message : String(joinErr) },
                );
              }
            }

            const numericFromCount = (v: unknown): number | null => {
              if (typeof v === 'number' && Number.isFinite(v)) return v;
              return null;
            };
            const countFromVariant = (
              v: unknown,
            ): { count: number | null; skipped: string | null } => {
              if (v && typeof v === 'object') {
                const obj = v as Record<string, unknown>;
                if ('rows_updated' in obj) {
                  return {
                    count: numericFromCount(obj.rows_updated),
                    skipped: null,
                  };
                }
                if ('skipped' in obj && typeof obj.skipped === 'string') {
                  return { count: null, skipped: obj.skipped };
                }
              }
              return { count: null, skipped: null };
            };

            const messageRegexes: Record<string, RegExp> = {
              event_logs: /event_logs=(\d+)/,
              nc_change_history: /nc_change_history=(\d+)/,
              capa_change_history: /capa_change_history=(\d+)/,
              ai_pending_actions: /ai_pending_actions=(\d+)/,
            };
            const triggersFromMessage = (
              msg: string,
            ): Record<string, { count: number | null; skipped: string | null }> => {
              const out: Record<
                string,
                { count: number | null; skipped: string | null }
              > = {};
              for (const [key, rx] of Object.entries(messageRegexes)) {
                const m = rx.exec(msg);
                out[key] = {
                  count: m ? Number.parseInt(m[1]!, 10) : null,
                  skipped: null,
                };
              }
              // ai_call_metrics is not in the dispatcher's message body —
              // only in the event_logs new_value. Mark unknown when the
              // join fell through so the UI can render it as such.
              out.ai_call_metrics = { count: null, skipped: null };
              return out;
            };

            const enriched = rowsResult.rows.map((n: any) => {
              const ts = notifSweepTs.get(String(n.id));
              const el = ts ? eventLogMap.get(ts) : null;
              let triggers: Record<
                string,
                { count: number | null; skipped: string | null }
              >;
              let eventLogId: string | null = null;
              let triggersSource: 'event_logs' | 'message' | 'none' = 'none';
              if (el && el.new_value) {
                eventLogId = el.id;
                triggersSource = 'event_logs';
                const sv = el.new_value as Record<string, unknown>;
                triggers = {
                  event_logs: {
                    count: numericFromCount(sv.event_logs_updated),
                    skipped: null,
                  },
                  nc_change_history: {
                    count: numericFromCount(sv.nc_change_history_updated),
                    skipped: null,
                  },
                  capa_change_history: {
                    count: numericFromCount(sv.capa_change_history_updated),
                    skipped: null,
                  },
                  ai_pending_actions: countFromVariant(sv.ai_pending_actions),
                  ai_call_metrics: countFromVariant(sv.ai_call_metrics),
                };
              } else {
                triggers = triggersFromMessage(String(n.message ?? ''));
                if (Object.values(triggers).some((t) => t.count !== null)) {
                  triggersSource = 'message';
                }
              }
              return {
                ...n,
                triggers,
                triggers_source: triggersSource,
                sweep_timestamp: ts ?? null,
                event_log_id: eventLogId,
              };
            });

            return c.json({
              notifications: enriched,
              total: countResult.rows[0]?.total ?? 0,
              module: 'security/redaction-sweep',
              related_entity_id: 'boot_redaction_sweep',
            });
          } finally {
            await pool.end();
          }
        } catch (error) {
          logger.error("Error fetching post-restore sweep alerts:", error);
          return c.json({ error: "Failed to fetch post-restore sweep alerts" }, 500);
        }
      };
    },
  },
  {
    // Task #755 — surface the streaming-export per-job temp-file cache to
    // operators. Returns live entry counts, on-disk byte totals, hit/miss
    // counters, and the most recent janitor pass timestamp so admins can
    // catch the cache directory growing unbounded before disk fills.
    path: "/api/admin/export-cache/stats",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const { getStagedExportCacheStats } =
            await import("../../utils/excelExport");
          const stats = await getStagedExportCacheStats();
          return c.json(stats);
        } catch (error) {
          logger.error("Error fetching export cache stats:", error);
          return c.json(
            { error: "Failed to fetch export cache stats" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/admin/redaction-sweep/status",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c))
            return c.json({ error: "Insufficient permissions" }, 403);
          const fs = await import("fs");
          const path = await import("path");
          const { resolveAuditEvidenceDir } =
            await import("../../utils/redactHistoricalLogs");
          const summaryPath = path.join(
            resolveAuditEvidenceDir(),
            "last-sweep.json",
          );
          if (!fs.existsSync(summaryPath)) {
            return c.json({ recorded: false });
          }
          const raw = fs.readFileSync(summaryPath, "utf8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (parseErr) {
            logger.error("Error parsing last-sweep.json:", parseErr);
            return c.json({ error: "Sweep summary file is malformed" }, 500);
          }
          // Lightweight shape validation against SweepResult so a tampered
          // or pre-format-change file does not silently render as garbage
          // on the dashboard. We only check the top-level keys the UI
          // actually reads — the per-table sub-objects already have a
          // `skipped` fallback path on the frontend.
          const isObj = (v: unknown): v is Record<string, unknown> =>
            !!v && typeof v === "object" && !Array.isArray(v);
          const isSweepShape = (v: unknown): boolean => {
            if (!isObj(v)) return false;
            return (
              typeof v.sweep_timestamp === "string" &&
              typeof v.event_logs_updated === "number" &&
              typeof v.nc_change_history_updated === "number" &&
              typeof v.capa_change_history_updated === "number" &&
              typeof v.total_rows_updated === "number"
            );
          };
          if (!isSweepShape(parsed)) {
            logger.error(
              "last-sweep.json does not match expected SweepResult shape",
            );
            return c.json(
              { error: "Sweep summary file has an unexpected shape" },
              500,
            );
          }
          return c.json({ recorded: true, sweep: parsed });
        } catch (error) {
          logger.error("Error reading redaction sweep status:", error);
          return c.json(
            { error: "Failed to read redaction sweep status" },
            500,
          );
        }
      };
    },
  },
];
