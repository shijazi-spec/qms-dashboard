import { getSessionFromCookie } from "./authRoutes";
import { isAdminAuthorized, hasValidAdminApiKey } from "../../utils/rbacMiddleware";

export const adminApiRoutes = [
  {
    path: "/api/admin/auth",
    method: "POST",
    createHandler: async () => {
      return async (c: any) => {
        try {
          const body = await c.req.json();
          const key = body?.key;
          const expectedKey = process.env.ADMIN_API_KEY;
          if (!expectedKey || !key || key !== expectedKey) return c.json({ error: 'Authentication required' }, 401);
          // Security: HttpOnly prevents JS access (XSS), Secure enforces HTTPS-only
          // transmission, SameSite=Strict blocks CSRF. All three flags are required
          // and must never be made conditional for the admin_key cookie.
          c.header('Set-Cookie', `admin_key=${key}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`);
          return c.json({ success: true });
        } catch (error) {
          return c.json({ error: 'Authentication failed' }, 500);
        }
      };
    },
  },
  {
    path: "/api/admin/auth/logout",
    method: "POST",
    createHandler: async () => {
      return async (c: any) => {
        // Security: clear flags must mirror those used when the cookie was set —
        // HttpOnly, Secure, and SameSite=Strict are all required and unconditional.
        c.header('Set-Cookie', `admin_key=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
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
          const hasSession = !!getSessionFromCookie(c.req.header('Cookie'));
          if (!hasValidAdminApiKey(c) && !hasSession) return c.json({ error: "Authentication required" }, 401);
          const { getAllGovernanceDocuments } = await import("../../utils/database");
          const documents = await getAllGovernanceDocuments();
          return c.json(documents);
        } catch (error) {
          console.error("Error fetching documents:", error);
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
          const { requireAdminOrKey: rak } = await import("../../utils/rbacMiddleware");
          const adminUser = await rak(c);
          if (!adminUser) return c.json({ error: "Admin access required" }, 403);
          const data = await c.req.json();
          const { saveGovernanceDocument, logAdminActivity } = await import("../../utils/database");
          const doc = await saveGovernanceDocument({ name: data.name, document_type: data.document_type || 'sales', version: data.version, file_path: data.file_path || null, content_text: data.content_text, rules_json: data.rules_json, is_active: data.is_active !== false });
          await logAdminActivity({ action_type: 'document_upload', action_description: `Uploaded governance document: ${data.name} (${data.version})`, target_type: 'governance_document', target_id: String(doc.id), target_name: data.name, metadata: { version: data.version, document_type: data.document_type || 'sales', is_active: data.is_active !== false } });
          return c.json(doc);
        } catch (error) {
          console.error("Error saving document:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const id = parseInt(c.req.param("id"));
          const { activateGovernanceDocument, logAdminActivity } = await import("../../utils/database");
          await activateGovernanceDocument(id);
          await logAdminActivity({ action_type: 'document_activate', action_description: `Activated governance document ID: ${id}`, target_type: 'governance_document', target_id: String(id), metadata: { activated: true } });
          return c.json({ success: true });
        } catch (error) {
          console.error("Error activating document:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const weights = await c.req.json();
          const { updateScorecardWeights, logAdminActivity } = await import("../../utils/database");
          const scorecard = await updateScorecardWeights(weights);
          if (!scorecard) return c.json({ error: "No active scorecard found" }, 404);
          await logAdminActivity({ action_type: 'scorecard_weights_update', action_description: `Updated scorecard weights: People=${weights.people}%, Process=${weights.process}%, Governance=${weights.governance}%`, target_type: 'scorecard', target_id: String(scorecard.id), target_name: scorecard.name, metadata: weights });
          return c.json(scorecard);
        } catch (error) {
          console.error("Error updating weights:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const attr = await c.req.json();
          const { addScorecardAttribute, logAdminActivity } = await import("../../utils/database");
          const scorecard = await addScorecardAttribute(attr);
          if (!scorecard) return c.json({ error: "No active scorecard found" }, 404);
          await logAdminActivity({ action_type: 'scorecard_attribute_add', action_description: `Added scorecard attribute: ${attr.name} in ${attr.dimension} dimension`, target_type: 'scorecard', target_id: String(scorecard.id), target_name: attr.name, metadata: { dimension: attr.dimension, weight: attr.weight, target: attr.target } });
          return c.json(scorecard);
        } catch (error) {
          console.error("Error adding attribute:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const { governance_doc_id, crm_module, team_name } = await c.req.json();
          const { linkScorecardToGovernanceDoc, logAdminActivity } = await import("../../utils/database");
          const result = await linkScorecardToGovernanceDoc(governance_doc_id, crm_module, team_name);
          if (!result) return c.json({ error: "Failed to link document - no matching scorecard found" }, 404);
          await logAdminActivity({ action_type: 'scorecard_link_doc', action_description: `Linked governance document ${governance_doc_id} to scorecard for ${team_name} team (${crm_module})`, target_type: 'scorecard', target_id: String(result.id), metadata: { governance_doc_id, crm_module, team_name } });
          return c.json({ success: true, scorecard: result });
        } catch (error) {
          console.error("Error linking document to scorecard:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const crmModule = c.req.query('crm_module') || null;
          const teamName = c.req.query('team_name') || null;
          const { getScorecardsByModuleAndTeam } = await import("../../utils/database");
          const scorecards = await getScorecardsByModuleAndTeam(crmModule, teamName);
          return c.json(scorecards);
        } catch (error) {
          console.error("Error fetching scorecards:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const data = await c.req.json();
          const { createScorecard, logAdminActivity } = await import("../../utils/database");
          const scorecard = await createScorecard(data);
          await logAdminActivity({ action_type: 'scorecard_create', action_description: `Created scorecard: ${data.name}`, target_type: 'scorecard', target_id: String(scorecard.id), metadata: data });
          return c.json(scorecard);
        } catch (error) {
          console.error("Error creating scorecard:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const id = parseInt(c.req.param("id"));
          const updates = await c.req.json();
          const { updateScorecard, logAdminActivity } = await import("../../utils/database");
          const scorecard = await updateScorecard(id, updates);
          if (!scorecard) return c.json({ error: "Scorecard not found" }, 404);
          await logAdminActivity({ action_type: 'scorecard_update', action_description: `Updated scorecard: ${scorecard.name}`, target_type: 'scorecard', target_id: String(id), metadata: updates });
          return c.json(scorecard);
        } catch (error) {
          console.error("Error updating scorecard:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const id = parseInt(c.req.param("id"));
          const { deleteScorecard, logAdminActivity } = await import("../../utils/database");
          const deleted = await deleteScorecard(id);
          if (!deleted) return c.json({ error: "Scorecard not found" }, 404);
          await logAdminActivity({ action_type: 'scorecard_delete', action_description: `Deleted scorecard ID: ${id}`, target_type: 'scorecard', target_id: String(id) });
          return c.json({ success: true });
        } catch (error) {
          console.error("Error deleting scorecard:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const id = parseInt(c.req.param("id"));
          const { crm_module, team_name } = await c.req.json();
          const { setActiveScorecardForTeam, logAdminActivity } = await import("../../utils/database");
          const scorecard = await setActiveScorecardForTeam(id, crm_module, team_name);
          if (!scorecard) return c.json({ error: "Scorecard not found" }, 404);
          await logAdminActivity({ action_type: 'scorecard_activate', action_description: `Activated scorecard: ${scorecard.name} for ${team_name} (${crm_module})`, target_type: 'scorecard', target_id: String(id), metadata: { crm_module, team_name } });
          return c.json(scorecard);
        } catch (error) {
          console.error("Error activating scorecard:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const id = parseInt(c.req.param("id"));
          const { name, version } = await c.req.json();
          const { cloneScorecard, logAdminActivity } = await import("../../utils/database");
          const scorecard = await cloneScorecard(id, name, version);
          if (!scorecard) return c.json({ error: "Original scorecard not found" }, 404);
          await logAdminActivity({ action_type: 'scorecard_clone', action_description: `Cloned scorecard ID ${id} to: ${name}`, target_type: 'scorecard', target_id: String(scorecard.id), metadata: { original_id: id, new_name: name, version } });
          return c.json(scorecard);
        } catch (error) {
          console.error("Error cloning scorecard:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const scorecardId = parseInt(c.req.param("id"));
          const { getScorecardAttributes } = await import("../../utils/database");
          const attributes = await getScorecardAttributes(scorecardId);
          return c.json(attributes);
        } catch (error) {
          console.error("Error fetching attributes:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const scorecardId = parseInt(c.req.param("id"));
          const data = await c.req.json();
          const { createScorecardAttribute, logAdminActivity } = await import("../../utils/database");
          const attribute = await createScorecardAttribute({ scorecard_id: scorecardId, ...data });
          await logAdminActivity({ action_type: 'attribute_create', action_description: `Added attribute: ${data.attribute_name}`, target_type: 'scorecard_attribute', target_id: String(attribute.id), metadata: data });
          return c.json(attribute);
        } catch (error) {
          console.error("Error creating attribute:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const id = parseInt(c.req.param("id"));
          const updates = await c.req.json();
          const { updateScorecardAttribute, logAdminActivity } = await import("../../utils/database");
          const attribute = await updateScorecardAttribute(id, updates);
          if (!attribute) return c.json({ error: "Attribute not found" }, 404);
          await logAdminActivity({ action_type: 'attribute_update', action_description: `Updated attribute: ${attribute.attribute_name}`, target_type: 'scorecard_attribute', target_id: String(id), metadata: updates });
          return c.json(attribute);
        } catch (error) {
          console.error("Error updating attribute:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const id = parseInt(c.req.param("id"));
          const { deleteScorecardAttribute, logAdminActivity } = await import("../../utils/database");
          const deleted = await deleteScorecardAttribute(id);
          if (!deleted) return c.json({ error: "Attribute not found" }, 404);
          await logAdminActivity({ action_type: 'attribute_delete', action_description: `Deleted attribute ID: ${id}`, target_type: 'scorecard_attribute', target_id: String(id) });
          return c.json({ success: true });
        } catch (error) {
          console.error("Error deleting attribute:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const scorecardId = parseInt(c.req.param("id"));
          const { attribute_ids } = await c.req.json();
          const { reorderScorecardAttributes, logAdminActivity } = await import("../../utils/database");
          await reorderScorecardAttributes(scorecardId, attribute_ids);
          await logAdminActivity({ action_type: 'attributes_reorder', action_description: `Reordered attributes for scorecard ID: ${scorecardId}`, target_type: 'scorecard', target_id: String(scorecardId), metadata: { attribute_ids } });
          return c.json({ success: true });
        } catch (error) {
          console.error("Error reordering attributes:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const { saveGovernanceDocument, saveScorecard, logAdminActivity } = await import("../../utils/database");
          const { walaPlusSalesGovernanceRules, qualityScorecardConfig } = await import("../../utils/governanceRules");
          await saveGovernanceDocument({ name: walaPlusSalesGovernanceRules.document.name, document_type: 'sales', version: walaPlusSalesGovernanceRules.document.version, file_path: 'attached_assets/WalaPlus_Sales_1.1_01.12.2025_EN_1764681400933.pdf', content_text: JSON.stringify(walaPlusSalesGovernanceRules, null, 2), rules_json: walaPlusSalesGovernanceRules, is_active: true });
          await saveScorecard({ name: qualityScorecardConfig.name, description: qualityScorecardConfig.description, dimensions: qualityScorecardConfig, is_active: true });
          await logAdminActivity({ action_type: 'seed_defaults', action_description: 'Reset governance data to default values', target_type: 'system', metadata: { document: walaPlusSalesGovernanceRules.document.name, scorecard: qualityScorecardConfig.name } });
          return c.json({ success: true, message: "Default data restored" });
        } catch (error) {
          console.error("Error seeding defaults:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const { getAdminActivities } = await import("../../utils/database");
          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");
          const action_type = c.req.query("action_type");
          const startDate = c.req.query("startDate") ? new Date(c.req.query("startDate")) : undefined;
          const endDate = c.req.query("endDate") ? new Date(c.req.query("endDate")) : undefined;
          const result = await getAdminActivities({ limit, offset, action_type, startDate, endDate });
          return c.json(result);
        } catch (error) {
          console.error("Error fetching admin activities:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const { getWorkflowRuns } = await import("../../utils/database");
          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");
          const workflow_id = c.req.query("workflow_id");
          const status = c.req.query("status");
          const startDate = c.req.query("startDate") ? new Date(c.req.query("startDate")) : undefined;
          const endDate = c.req.query("endDate") ? new Date(c.req.query("endDate")) : undefined;
          const result = await getWorkflowRuns({ limit, offset, workflow_id, status, startDate, endDate });
          return c.json(result);
        } catch (error) {
          console.error("Error fetching workflow runs:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const id = parseInt(c.req.param("id"));
          const { getWorkflowRunById } = await import("../../utils/database");
          const run = await getWorkflowRunById(id);
          if (!run) return c.json({ error: "Workflow run not found" }, 404);
          return c.json(run);
        } catch (error) {
          console.error("Error fetching workflow run:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const { getSystemEvents } = await import("../../utils/database");
          const limit = parseInt(c.req.query("limit") || "100");
          const offset = parseInt(c.req.query("offset") || "0");
          const event_type = c.req.query("event_type");
          const event_category = c.req.query("event_category");
          const severity = c.req.query("severity");
          const startDate = c.req.query("startDate") ? new Date(c.req.query("startDate")) : undefined;
          const endDate = c.req.query("endDate") ? new Date(c.req.query("endDate")) : undefined;
          const result = await getSystemEvents({ limit, offset, event_type, event_category, severity, startDate, endDate });
          return c.json(result);
        } catch (error) {
          console.error("Error fetching system events:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const { getActivityFeed } = await import("../../utils/database");
          const limit = parseInt(c.req.query("limit") || "50");
          const result = await getActivityFeed(limit);
          return c.json(result);
        } catch (error) {
          console.error("Error fetching activity feed:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const { getActivityStats } = await import("../../utils/database");
          const stats = await getActivityStats();
          return c.json(stats);
        } catch (error) {
          console.error("Error fetching activity stats:", error);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const { getRateLimitStats } = await import("../../utils/rateLimiter");
          const stats = await getRateLimitStats();
          return c.json(stats);
        } catch (error) {
          console.error("Error fetching rate limit stats:", error);
          return c.json({ error: "Failed to fetch rate limit stats" }, 500);
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
          if (!isAdminAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const fs = await import("fs");
          const path = await import("path");
          const { resolveAuditEvidenceDir } = await import("../../utils/redactHistoricalLogs");
          const summaryPath = path.join(resolveAuditEvidenceDir(), "last-sweep.json");
          if (!fs.existsSync(summaryPath)) {
            return c.json({ recorded: false });
          }
          const raw = fs.readFileSync(summaryPath, "utf8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (parseErr) {
            console.error("Error parsing last-sweep.json:", parseErr);
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
            console.error(
              "last-sweep.json does not match expected SweepResult shape",
            );
            return c.json(
              { error: "Sweep summary file has an unexpected shape" },
              500,
            );
          }
          return c.json({ recorded: true, sweep: parsed });
        } catch (error) {
          console.error("Error reading redaction sweep status:", error);
          return c.json({ error: "Failed to read redaction sweep status" }, 500);
        }
      };
    },
  },
];
