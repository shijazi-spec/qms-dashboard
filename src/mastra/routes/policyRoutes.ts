import type { Pool as PgPool } from "pg";
import {
  requireRoleOrKey,
  unauthorizedResponse,
  forbiddenResponse,
} from "../../utils/rbacMiddleware";

import { logger as safeLogger } from "../../utils/logger";
const POLICY_READ_ROLES = [
  "admin",
  "grc_manager",
  "quality_manager",
  "head_of_operations_quality",
  "bu_owner",
  "executive",
  "quality_specialist",
  "auditor",
  "team_lead",
  "ai_specialist",
] as const;

const CONFIDENTIALITY_PRIVILEGED_ROLES = new Set([
  "admin",
  "grc_manager",
  "quality_manager",
  "head_of_operations_quality",
]);

const NON_SENSITIVE_CONFIDENTIALITY = ["public", "internal"];

function getAllowedConfidentiality(role: string): string[] | undefined {
  if (CONFIDENTIALITY_PRIVILEGED_ROLES.has(role)) return undefined;
  return NON_SENSITIVE_CONFIDENTIALITY;
}

function canAccessConfidentialPolicy(
  role: string,
  confidentiality: string | undefined,
): boolean {
  if (CONFIDENTIALITY_PRIVILEGED_ROLES.has(role)) return true;
  const level = confidentiality || "internal";
  return level === "public" || level === "internal";
}

export const policyRoutes = [
  {
    path: "/api/policies",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireRoleOrKey(c, [...POLICY_READ_ROLES]);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { getAllPolicies, initPolicyTables } =
            await import("../../utils/policyDatabase");
          await initPolicyTables();

          const url = new URL(c.req.url);
          const status = url.searchParams.get("status") || undefined;
          const category = url.searchParams.get("category") || undefined;
          const document_type =
            url.searchParams.get("document_type") || undefined;
          const owner_department =
            url.searchParams.get("owner_department") || undefined;
          const search = url.searchParams.get("search") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");

          logger?.info("📋 [PolicyAPI] GET /api/policies", {
            status,
            category,
            document_type,
          });

          const allowedConfidentiality = getAllowedConfidentiality(admin.role);
          const result = await getAllPolicies({
            status,
            category,
            document_type,
            owner_department,
            search,
            limit,
            offset,
            allowedConfidentiality,
          });

          return c.json(result);
        } catch (error) {
          safeLogger.error("❌ [PolicyAPI] Error fetching policies:", error);
          return c.json({ error: "Failed to fetch policies" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies/summary",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireRoleOrKey(c, [...POLICY_READ_ROLES]);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { getPolicySummaryStats, initPolicyTables } =
            await import("../../utils/policyDatabase");
          await initPolicyTables();

          logger?.info("📊 [PolicyAPI] GET /api/policies/summary");
          const allowedConfidentiality = getAllowedConfidentiality(admin.role);
          const summary = await getPolicySummaryStats(allowedConfidentiality);
          return c.json(summary);
        } catch (error) {
          safeLogger.error("❌ [PolicyAPI] Error fetching summary:", error);
          return c.json({ error: "Failed to fetch policy summary" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies/overdue",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireRoleOrKey(c, [...POLICY_READ_ROLES]);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { getOverduePolicies, initPolicyTables } =
            await import("../../utils/policyDatabase");
          await initPolicyTables();

          logger?.info("📋 [PolicyAPI] GET /api/policies/overdue");
          const allowedConfidentiality = getAllowedConfidentiality(admin.role);
          const policies = await getOverduePolicies(allowedConfidentiality);
          return c.json({ policies });
        } catch (error) {
          safeLogger.error(
            "❌ [PolicyAPI] Error fetching overdue policies:",
            error,
          );
          return c.json({ error: "Failed to fetch overdue policies" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies/by-type-summary",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireRoleOrKey(c, [...POLICY_READ_ROLES]);
          if (!admin) return unauthorizedResponse(c);

          const { getDocumentsByTypeSummary, initPolicyTables } =
            await import("../../utils/policyDatabase");
          await initPolicyTables();
          const allowedConfidentiality = getAllowedConfidentiality(admin.role);
          const summary = await getDocumentsByTypeSummary(allowedConfidentiality);
          return c.json({ summary });
        } catch (error) {
          safeLogger.error(
            "❌ [PolicyAPI] Error fetching by-type summary:",
            error,
          );
          return c.json({ error: "Failed to fetch summary" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies/review-cycles",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireRoleOrKey(c, [...POLICY_READ_ROLES]);
          if (!admin) return unauthorizedResponse(c);

          const { getReviewCycles, initPolicyTables } =
            await import("../../utils/policyDatabase");
          await initPolicyTables();
          const url = new URL(c.req.url);
          const policyId = url.searchParams.get("policy_id")
            ? parseInt(url.searchParams.get("policy_id")!)
            : undefined;
          const allowedConfidentiality = getAllowedConfidentiality(admin.role);
          const cycles = await getReviewCycles(policyId, allowedConfidentiality);
          return c.json({ review_cycles: cycles });
        } catch (error) {
          safeLogger.error(
            "❌ [PolicyAPI] Error fetching review cycles:",
            error,
          );
          return c.json({ error: "Failed to fetch review cycles" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies/review-cycles",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const { createReviewCycle, initPolicyTables } =
            await import("../../utils/policyDatabase");
          await initPolicyTables();
          const body = await c.req.json();
          if (!body.policy_id || !body.scheduled_date)
            return c.json({ error: "Missing required fields" }, 400);
          const cycle = await createReviewCycle(body);
          return c.json({ success: true, review_cycle: cycle });
        } catch (error) {
          safeLogger.error(
            "❌ [PolicyAPI] Error creating review cycle:",
            error,
          );
          return c.json({ error: "Failed to create review cycle" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies/export/estimate",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        let pool: PgPool | null = null;
        try {
          const admin = await requireRoleOrKey(c, [...POLICY_READ_ROLES]);
          if (!admin) return unauthorizedResponse(c);

          const { initPolicyTables } =
            await import("../../utils/policyDatabase");
          await initPolicyTables();

          const url = new URL(c.req.url);
          const document_type =
            url.searchParams.get("document_type") || undefined;
          const status = url.searchParams.get("status") || undefined;

          const conditions: string[] = [];
          const filterParams: unknown[] = [];
          if (document_type) {
            filterParams.push(document_type);
            conditions.push(`document_type = $${filterParams.length}`);
          }
          if (status) {
            filterParams.push(status);
            conditions.push(`status = $${filterParams.length}`);
          }
          const allowedConfidentiality = getAllowedConfidentiality(admin.role);
          if (allowedConfidentiality) {
            filterParams.push(allowedConfidentiality);
            conditions.push(`confidentiality = ANY($${filterParams.length}::text[])`);
          }
          const where = conditions.length
            ? `WHERE ${conditions.join(" AND ")}`
            : "";

          const pg = await import("pg");
          pool = new pg.default.Pool({
            connectionString: process.env.DATABASE_URL,
          });
          const r = await pool.query(
            `SELECT COUNT(*)::int AS total FROM policies ${where}`,
            filterParams,
          );
          const { estimateFromCount, estimateResponse } =
            await import("../../utils/exportEstimate");
          return estimateResponse(estimateFromCount(r.rows[0]?.total, "csv"));
        } catch (error) {
          safeLogger.error("❌ [PolicyAPI] Error estimating export:", error);
          return c.json({ error: "Failed to estimate export size" }, 500);
        } finally {
          if (pool) await pool.end();
        }
      };
    },
  },
  {
    path: "/api/policies/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        let exportPool: PgPool | null = null;
        try {
          const admin = await requireRoleOrKey(c, [...POLICY_READ_ROLES]);
          if (!admin) return unauthorizedResponse(c);

          const { initPolicyTables } =
            await import("../../utils/policyDatabase");
          await initPolicyTables();

          const url = new URL(c.req.url);
          const document_type =
            url.searchParams.get("document_type") || undefined;
          const status = url.searchParams.get("status") || undefined;

          const { escapeCSVValue } = await import("../../utils/inputSanitizer");
          const { streamCsv, cursorQuery, stageStreamingExportFromHono } =
            await import("../../utils/excelExport");
          const pg = await import("pg");
          exportPool = new pg.default.Pool({
            connectionString: process.env.DATABASE_URL,
          });

          const conditions: string[] = [];
          const filterParams: unknown[] = [];
          if (document_type) {
            filterParams.push(document_type);
            conditions.push(`document_type = $${filterParams.length}`);
          }
          if (status) {
            filterParams.push(status);
            conditions.push(`status = $${filterParams.length}`);
          }
          const allowedConfidentiality = getAllowedConfidentiality(admin.role);
          if (allowedConfidentiality) {
            filterParams.push(allowedConfidentiality);
            conditions.push(`confidentiality = ANY($${filterParams.length}::text[])`);
          }
          const where = conditions.length
            ? `WHERE ${conditions.join(" AND ")}`
            : "";

          const source = cursorQuery(
            exportPool,
            `SELECT id, document_number, policy_number, title, document_type, category, status, confidentiality, owner_name, owner_department, version, effective_date, review_date, tags, created_at FROM policies ${where} ORDER BY id ASC`,
            filterParams,
          );

          const headers = [
            "ID",
            "Doc Number",
            "Policy Number",
            "Title",
            "Type",
            "Category",
            "Status",
            "Confidentiality",
            "Owner",
            "Department",
            "Version",
            "Effective Date",
            "Review Date",
            "Tags",
            "Created",
          ];
          const rows = (async function* () {
            try {
              for await (const p of source) {
                const row = p as Record<string, unknown>;
                yield [
                  row["id"],
                  row["document_number"] ?? "",
                  row["policy_number"],
                  row["title"],
                  row["document_type"] ?? "policy",
                  row["category"],
                  row["status"],
                  row["confidentiality"] ?? "internal",
                  row["owner_name"] ?? "",
                  row["owner_department"] ?? "",
                  row["version"],
                  row["effective_date"] ?? "",
                  row["review_date"] ?? "",
                  Array.isArray(row["tags"])
                    ? (row["tags"] as string[]).join("; ")
                    : String(row["tags"] ?? ""),
                  row["created_at"] ?? "",
                ].map((v) => escapeCSVValue(String(v ?? "")));
              }
            } finally {
              await exportPool.end();
            }
          })();
          return await stageStreamingExportFromHono(c, () =>
            streamCsv(
              `qms_documents_${new Date().toISOString().split("T")[0]}.csv`,
              headers,
              rows,
            ),
          );
        } catch (error) {
          safeLogger.error("❌ [PolicyAPI] Error exporting:", error);
          if (exportPool) await exportPool.end();
          return c.json({ error: "Failed to export" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies/pending-acknowledgments",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireRoleOrKey(c, [...POLICY_READ_ROLES]);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { getPendingAcknowledgments, initPolicyTables } =
            await import("../../utils/policyDatabase");
          await initPolicyTables();

          const url = new URL(c.req.url);
          const department = url.searchParams.get("department") || undefined;

          logger?.info(
            "📋 [PolicyAPI] GET /api/policies/pending-acknowledgments",
            { department },
          );
          const allowedConfidentiality = getAllowedConfidentiality(admin.role);
          const policies = await getPendingAcknowledgments(
            department,
            allowedConfidentiality,
          );
          return c.json({ policies });
        } catch (error) {
          safeLogger.error(
            "❌ [PolicyAPI] Error fetching pending acknowledgments:",
            error,
          );
          return c.json(
            { error: "Failed to fetch pending acknowledgments" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/policies/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireRoleOrKey(c, [...POLICY_READ_ROLES]);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const {
            getPolicyById,
            getPolicyVersions,
            getPolicyAcknowledgments,
            getAcknowledgmentStats,
            initPolicyTables,
          } = await import("../../utils/policyDatabase");
          await initPolicyTables();

          const id = parseInt(c.req.param("id"));
          logger?.info("📋 [PolicyAPI] GET /api/policies/:id", { id });

          const policy = await getPolicyById(id);
          if (!policy) {
            return c.json({ error: "Policy not found" }, 404);
          }

          if (!canAccessConfidentialPolicy(admin.role, policy.confidentiality)) {
            return forbiddenResponse(
              c,
              "Access to this policy is restricted by its confidentiality classification",
            );
          }

          const [versions, acknowledgments, ackStats] = await Promise.all([
            getPolicyVersions(id),
            getPolicyAcknowledgments(id),
            getAcknowledgmentStats(id),
          ]);

          return c.json({
            policy,
            versions,
            acknowledgments,
            acknowledgment_stats: ackStats,
          });
        } catch (error) {
          safeLogger.error("❌ [PolicyAPI] Error fetching policy:", error);
          return c.json({ error: "Failed to fetch policy" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createPolicy, initPolicyTables } =
            await import("../../utils/policyDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initPolicyTables();

          const body = await c.req.json();
          logger?.info("📝 [PolicyAPI] POST /api/policies", {
            title: body.title,
            by: sessionUser.email,
          });

          if (!body.policy_number || !body.title || !body.category) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          // Strip file-attachment fields — file_path/file_name/file_size/file_mime_type
          // must only be set by the dedicated internal upload endpoint, never by the
          // create-policy JSON body (prevents cross-module file rebinding at creation).
          const {
            file_path: _fp,
            file_name: _fn,
            file_size: _fs,
            file_mime_type: _fmt,
            ...safeBody
          } = body;

          const policy = await createPolicy({
            ...safeBody,
            created_by: sessionUser.email,
          });

          await logEvent({
            entityType: "DOCUMENT",
            entityId: policy.id!.toString(),
            actionType: "CREATE",
            description: `New policy created: ${policy.title} (${policy.policy_number})`,
            newValue: JSON.stringify(policy),
            userName: sessionUser.email,
            severity: "INFO",
            module: "policy_governance",
          });

          logger?.info("✅ [PolicyAPI] Policy created", { id: policy.id });
          return c.json({ success: true, policy });
        } catch (error: any) {
          safeLogger.error("❌ [PolicyAPI] Error creating policy:", error);
          if (error.code === "23505") {
            return c.json({ error: "Policy number already exists" }, 400);
          }
          return c.json({ error: "Failed to create policy" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRoleLive, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireWriteRoleLive(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updatePolicy, getPolicyById, initPolicyTables } =
            await import("../../utils/policyDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initPolicyTables();

          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          logger?.info("📝 [PolicyAPI] PUT /api/policies/:id", {
            id,
            by: sessionUser.email,
          });

          const existingPolicy = await getPolicyById(id);
          if (!existingPolicy) {
            return c.json({ error: "Policy not found" }, 404);
          }

          if (body.status && body.status !== existingPolicy.status) {
            return c.json(
              {
                error:
                  "Status changes are not allowed via generic update. Use the dedicated /transition endpoint for policy lifecycle changes.",
              },
              400,
            );
          }
          // Strip status and file-attachment fields: file_path/file_name/file_size/
          // file_mime_type are managed exclusively by the internal upload handler and
          // must never be set by external callers (prevents cross-module file rebinding).
          const {
            status,
            file_path,
            file_name,
            file_size,
            file_mime_type,
            ...safeBody
          } = body;

          const updatedPolicy = await updatePolicy(
            id,
            safeBody,
            sessionUser.email,
          );

          await logEvent({
            entityType: "DOCUMENT",
            entityId: id.toString(),
            actionType: "UPDATE",
            description: `Policy updated: ${updatedPolicy.title}`,
            oldValue: JSON.stringify(existingPolicy),
            newValue: JSON.stringify(updatedPolicy),
            userName: sessionUser.email,
            severity: "INFO",
            module: "policy_governance",
          });

          logger?.info("✅ [PolicyAPI] Policy updated", { id });
          return c.json({ success: true, policy: updatedPolicy });
        } catch (error) {
          safeLogger.error("❌ [PolicyAPI] Error updating policy:", error);
          return c.json({ error: "Failed to update policy" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies/:id/transition",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { transitionPolicyStatus, getPolicyById, initPolicyTables } =
            await import("../../utils/policyDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initPolicyTables();

          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          logger?.info("📝 [PolicyAPI] POST /api/policies/:id/transition", {
            id,
            newStatus: body.new_status,
            by: sessionUser.email,
          });

          if (!body.new_status) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          if (["published", "approved"].includes(body.new_status)) {
            const { checkPermission } =
              await import("../../utils/rbacDatabase");
            const canApprove = await checkPermission(
              sessionUser.email,
              "can_approve_policy",
            );
            if (!canApprove) {
              return forbiddenResponse(
                c,
                "Permission denied: only authorized roles can approve/publish policies",
              );
            }
          }

          const existingPolicy = await getPolicyById(id);
          if (!existingPolicy) {
            return c.json({ error: "Policy not found" }, 404);
          }

          const updatedPolicy = await transitionPolicyStatus(
            id,
            body.new_status,
            sessionUser.email,
          );

          await logEvent({
            entityType: "DOCUMENT",
            entityId: id.toString(),
            actionType: "STATUS_CHANGE",
            description: `Policy status changed: ${existingPolicy.status} → ${body.new_status}`,
            oldValue: JSON.stringify({ status: existingPolicy.status }),
            newValue: JSON.stringify({ status: body.new_status }),
            userName: sessionUser.email,
            severity: body.new_status === "published" ? "INFO" : "INFO",
            module: "policy_governance",
          });

          logger?.info("✅ [PolicyAPI] Policy status transitioned", {
            id,
            newStatus: body.new_status,
          });
          return c.json({ success: true, policy: updatedPolicy });
        } catch (error: any) {
          safeLogger.error("❌ [PolicyAPI] Error transitioning policy:", error);
          const safeMsg =
            error.message &&
            (error.message.includes("Invalid transition") ||
              error.message.includes("Cannot transition"))
              ? error.message
              : "Failed to transition policy";
          return c.json({ error: safeMsg }, 400);
        }
      };
    },
  },
  {
    path: "/api/policies/:id/acknowledge",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { acknowledgePolicy, getPolicyById, initPolicyTables } =
            await import("../../utils/policyDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initPolicyTables();

          const policyId = parseInt(c.req.param("id"));
          const body = await c.req.json();
          logger?.info("📝 [PolicyAPI] POST /api/policies/:id/acknowledge", {
            policyId,
            by: sessionUser.email,
          });

          const policy = await getPolicyById(policyId);
          if (!policy) {
            return c.json({ error: "Policy not found" }, 404);
          }

          const ackData = {
            ...body,
            policy_id: policyId,
            user_name: sessionUser.name,
            user_email: sessionUser.email,
          };
          const ack = await acknowledgePolicy(ackData);

          await logEvent({
            entityType: "DOCUMENT",
            entityId: policyId.toString(),
            actionType: "UPDATE",
            description: `Policy acknowledged by ${sessionUser.name} (${sessionUser.email})`,
            newValue: JSON.stringify(ack),
            userName: sessionUser.email,
            severity: "INFO",
            module: "policy_governance",
          });

          logger?.info("✅ [PolicyAPI] Policy acknowledged", {
            policyId,
            user: body.user_email,
          });
          return c.json({ success: true, acknowledgment: ack });
        } catch (error) {
          safeLogger.error("❌ [PolicyAPI] Error acknowledging policy:", error);
          return c.json({ error: "Failed to acknowledge policy" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies/:id/grc-approval",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updatePolicy, getPolicyById, initPolicyTables } =
            await import("../../utils/policyDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          const { checkPermission, getUserByEmail, initRbacTables } =
            await import("../../utils/rbacDatabase");
          await initPolicyTables();
          await initRbacTables();

          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          const userEmail = sessionUser.email;
          logger?.info(
            "🔐 [PolicyAPI] POST /api/policies/:id/grc-approval (RBAC enforcement)",
            { id, userEmail },
          );

          const user = await getUserByEmail(userEmail);
          if (!user) {
            logger?.warn(
              "🚫 [PolicyAPI] Policy approval blocked - user not registered in system",
              { userEmail },
            );
            await logEvent({
              entityType: "DOCUMENT",
              entityId: id.toString(),
              actionType: "UPDATE",
              description: `Policy GRC approval BLOCKED: User ${userEmail} not found in system_users`,
              userName: userEmail,
              severity: "WARNING",
              module: "policy_governance",
            });
            return c.json(
              {
                error:
                  "User not found: You must be a registered system user to perform this action",
              },
              403,
            );
          }

          if (!user.is_active) {
            logger?.warn(
              "🚫 [PolicyAPI] Policy approval blocked - user account inactive",
              { userEmail },
            );
            return c.json(
              {
                error:
                  "Account inactive: Your user account has been deactivated",
              },
              403,
            );
          }

          const hasPermission = await checkPermission(
            userEmail,
            "can_approve_policy",
          );
          if (!hasPermission) {
            logger?.warn(
              "🚫 [PolicyAPI] Policy approval blocked - user lacks GRC permission",
              { userEmail, userRole: user.role },
            );
            await logEvent({
              entityType: "DOCUMENT",
              entityId: id.toString(),
              actionType: "UPDATE",
              description: `Policy GRC approval BLOCKED: User ${userEmail} (role: ${user.role}) lacks GRC Manager permission`,
              userName: userEmail,
              severity: "WARNING",
              module: "policy_governance",
            });
            return c.json(
              {
                error: `Permission denied: Only GRC Manager or Admin role can approve policies. Your role (${user.role}) does not have this permission.`,
              },
              403,
            );
          }

          const policy = await getPolicyById(id);
          if (!policy) {
            return c.json({ error: "Policy not found" }, 404);
          }

          if (policy.compliance_approved) {
            return c.json(
              {
                error: "Policy already approved by GRC",
                approved_by: policy.compliance_approved_by,
                approved_at: policy.compliance_approved_at,
              },
              400,
            );
          }

          const updatedPolicy = await updatePolicy(
            id,
            {
              compliance_approved: true,
              compliance_approved_by: user.name,
              compliance_approved_at: new Date(),
              approval_blocked_reason: undefined,
            },
            userEmail,
          );

          await logEvent({
            entityType: "DOCUMENT",
            entityId: id.toString(),
            actionType: "UPDATE",
            description: `Policy GRC APPROVED by Compliance Owner: ${policy.title}`,
            oldValue: JSON.stringify({ compliance_approved: false }),
            newValue: JSON.stringify({
              compliance_approved: true,
              compliance_approved_by: user.name,
            }),
            userName: userEmail,
            severity: "INFO",
            module: "policy_governance",
          });

          logger?.info("✅ [PolicyAPI] Policy GRC approved", {
            id,
            approvedBy: user.name,
            role: user.role,
          });
          return c.json({
            success: true,
            policy: updatedPolicy,
            message: `Policy approved by ${user.name} (${user.role})`,
            approved_by: user.name,
            approved_by_role: user.role,
          });
        } catch (error) {
          safeLogger.error("❌ [PolicyAPI] Error approving policy:", error);
          return c.json({ error: "Failed to approve policy" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies/:id/set-owners",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const { checkPermission } = await import("../../utils/rbacDatabase");
          const canApprove = await checkPermission(
            sessionUser.email,
            "can_approve_policy",
          );
          if (!canApprove) {
            return forbiddenResponse(
              c,
              "Permission denied: only authorized roles can set policy owners",
            );
          }

          const logger = mastra?.getLogger();
          const { updatePolicy, getPolicyById, initPolicyTables } =
            await import("../../utils/policyDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initPolicyTables();

          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          logger?.info("📝 [PolicyAPI] POST /api/policies/:id/set-owners", {
            id,
            by: sessionUser.email,
          });

          if (!body.operational_owner || !body.compliance_owner) {
            return c.json(
              {
                error:
                  "Both operational_owner and compliance_owner are required (dual ownership)",
              },
              400,
            );
          }

          const policy = await getPolicyById(id);
          if (!policy) {
            return c.json({ error: "Policy not found" }, 404);
          }

          const updatedPolicy = await updatePolicy(
            id,
            {
              operational_owner: body.operational_owner,
              operational_owner_email: body.operational_owner_email,
              compliance_owner: body.compliance_owner,
              compliance_owner_email: body.compliance_owner_email,
            },
            sessionUser.email,
          );

          await logEvent({
            entityType: "DOCUMENT",
            entityId: id.toString(),
            actionType: "UPDATE",
            description: `Policy dual ownership set: Operational=${body.operational_owner}, Compliance=${body.compliance_owner}`,
            newValue: JSON.stringify({
              operational_owner: body.operational_owner,
              compliance_owner: body.compliance_owner,
            }),
            userName: sessionUser.email,
            severity: "INFO",
            module: "policy_governance",
          });

          logger?.info("✅ [PolicyAPI] Policy owners set", { id });
          return c.json({ success: true, policy: updatedPolicy });
        } catch (error) {
          safeLogger.error(
            "❌ [PolicyAPI] Error setting policy owners:",
            error,
          );
          return c.json({ error: "Failed to set policy owners" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies/:id/publish",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const { checkPermission } = await import("../../utils/rbacDatabase");
          const canApprove = await checkPermission(
            sessionUser.email,
            "can_approve_policy",
          );
          if (!canApprove) {
            return forbiddenResponse(
              c,
              "Permission denied: only authorized roles can publish policies",
            );
          }

          const logger = mastra?.getLogger();
          const { transitionPolicyStatus, getPolicyById, initPolicyTables } =
            await import("../../utils/policyDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initPolicyTables();

          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          logger?.info(
            "📝 [PolicyAPI] POST /api/policies/:id/publish (with GRC check)",
            { id, by: sessionUser.email },
          );

          const policy = await getPolicyById(id);
          if (!policy) {
            return c.json({ error: "Policy not found" }, 404);
          }

          if (!policy.compliance_approved) {
            logger?.warn(
              "🚫 [PolicyAPI] Policy publish BLOCKED - missing GRC approval",
              { id },
            );
            await logEvent({
              entityType: "DOCUMENT",
              entityId: id.toString(),
              actionType: "UPDATE",
              description: `Policy publish BLOCKED: Missing GRC/Compliance Owner approval for "${policy.title}"`,
              userName: sessionUser.email,
              severity: "WARNING",
              module: "policy_governance",
            });
            return c.json(
              {
                error:
                  "Cannot publish: Policy requires GRC Manager (Compliance Owner) approval first",
                compliance_approved: false,
                action_required: "Request GRC approval before publishing",
              },
              400,
            );
          }

          const updatedPolicy = await transitionPolicyStatus(
            id,
            "published",
            sessionUser.email,
          );

          await logEvent({
            entityType: "DOCUMENT",
            entityId: id.toString(),
            actionType: "STATUS_CHANGE",
            description: `Policy PUBLISHED (after GRC approval): ${policy.title}`,
            oldValue: JSON.stringify({ status: policy.status }),
            newValue: JSON.stringify({ status: "published" }),
            userName: sessionUser.email,
            severity: "INFO",
            module: "policy_governance",
          });

          logger?.info("✅ [PolicyAPI] Policy published", { id });
          return c.json({
            success: true,
            policy: updatedPolicy,
            message: "Policy published successfully (GRC approval verified)",
          });
        } catch (error: any) {
          safeLogger.error("❌ [PolicyAPI] Error publishing policy:", error);
          return c.json({ error: "Failed to publish policy" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies/:id",
    method: "DELETE" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRoleLive, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireWriteRoleLive(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const { deletePolicy, getPolicyById, initPolicyTables } =
            await import("../../utils/policyDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initPolicyTables();

          const id = parseInt(c.req.param("id"));
          const policy = await getPolicyById(id);
          if (!policy) return c.json({ error: "Policy not found" }, 404);

          if (policy.status === "published") {
            return c.json(
              {
                error:
                  "Cannot delete a published document. Archive or retire it first.",
              },
              400,
            );
          }

          await deletePolicy(id);
          await logEvent({
            entityType: "DOCUMENT",
            entityId: id.toString(),
            actionType: "DELETE",
            description: `Document deleted: ${policy.title} (${policy.policy_number})`,
            userName: sessionUser.email,
            severity: "WARNING",
            module: "policy_governance",
          });

          return c.json({ success: true });
        } catch (error) {
          safeLogger.error("❌ [PolicyAPI] Error deleting policy:", error);
          return c.json({ error: "Failed to delete document" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies/:id/link",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const { linkPolicyToEntities, initPolicyTables } =
            await import("../../utils/policyDatabase");
          await initPolicyTables();

          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          const updated = await linkPolicyToEntities(id, body);
          return c.json({ success: true, policy: updated });
        } catch (error) {
          safeLogger.error("❌ [PolicyAPI] Error linking policy:", error);
          return c.json({ error: "Failed to link document" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies/review-cycles/:id",
    method: "PUT" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, unauthorizedResponse, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireRole(c, [
            "admin",
            "grc_manager",
            "quality_manager",
          ]);
          if (!sessionUser) {
            const { getSessionUser } =
              await import("../../utils/rbacMiddleware");
            if (!getSessionUser(c)) return unauthorizedResponse(c);
            return forbiddenResponse(
              c,
              "Permission denied: only policy management roles can update review cycles",
            );
          }

          const { updateReviewCycle, initPolicyTables } =
            await import("../../utils/policyDatabase");
          await initPolicyTables();
          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          const cycle = await updateReviewCycle(id, body);
          return c.json({ success: true, review_cycle: cycle });
        } catch (error) {
          safeLogger.error(
            "❌ [PolicyAPI] Error updating review cycle:",
            error,
          );
          return c.json({ error: "Failed to update review cycle" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies/:id/upload",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, unauthorizedResponse, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireRole(c, [
            "admin",
            "grc_manager",
            "quality_manager",
          ]);
          if (!sessionUser) {
            const { getSessionUser } =
              await import("../../utils/rbacMiddleware");
            if (!getSessionUser(c)) return unauthorizedResponse(c);
            return forbiddenResponse(
              c,
              "Permission denied: only policy management roles can upload policy documents",
            );
          }

          const { updatePolicy, getPolicyById, initPolicyTables } =
            await import("../../utils/policyDatabase");
          const { validateFile, saveUploadedFile, deleteUploadedFile } =
            await import("../../utils/fileUpload");
          await initPolicyTables();

          const id = parseInt(c.req.param("id"));
          const policy = await getPolicyById(id);
          if (!policy) return c.json({ error: "Document not found" }, 404);

          const rawUploadLen = c.req.header('Content-Length');
          if (!rawUploadLen) return c.json({ error: 'Content-Length header required for file uploads' }, 411);
          const uploadContentLen = parseInt(rawUploadLen, 10);
          if (!Number.isFinite(uploadContentLen) || uploadContentLen > 26 * 1024 * 1024) {
            return c.json({ error: 'Request body too large (max 25 MB)' }, 413);
          }

          const formData = await c.req.formData();
          const file = formData.get("file");
          if (!file || !(file instanceof File))
            return c.json({ error: "No file provided" }, 400);

          const validation = validateFile(file.name, file.size, file.type);
          if (!validation.valid)
            return c.json({ error: validation.error }, 400);

          const oldFilePath = policy.file_path || null;

          const buffer = Buffer.from(await file.arrayBuffer());
          const fileInfo = await saveUploadedFile(buffer, file.name, file.type, 'policies');

          await updatePolicy(
            id,
            {
              file_path: fileInfo.filePath,
              file_name: fileInfo.fileName,
              file_size: fileInfo.fileSize,
              file_mime_type: fileInfo.mimeType,
            },
            sessionUser.email,
          );

          // Remove the previous blob so the shared document volume is not
          // slowly exhausted by repeated attachment replacements.
          if (oldFilePath && oldFilePath !== fileInfo.filePath) {
            deleteUploadedFile(oldFilePath);
          }

          return c.json({ success: true, file: fileInfo });
        } catch (error) {
          safeLogger.error("❌ [PolicyAPI] Error uploading file:", error);
          return c.json({ error: "Failed to upload file" }, 500);
        }
      };
    },
  },
  {
    path: "/api/policies/:id/download",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireRoleOrKey(c, [...POLICY_READ_ROLES]);
          if (!admin) return unauthorizedResponse(c);

          const { getPolicyById, initPolicyTables } =
            await import("../../utils/policyDatabase");
          const { getUploadedFileForModule } = await import("../../utils/fileUpload");
          await initPolicyTables();

          const id = parseInt(c.req.param("id"));
          const policy = await getPolicyById(id);
          if (!policy || !policy.file_path)
            return c.json({ error: "No file attached" }, 404);

          if (!canAccessConfidentialPolicy(admin.role, policy.confidentiality)) {
            return forbiddenResponse(
              c,
              "Access to this policy file is restricted by its confidentiality classification",
            );
          }

          // Scoped read: refuse to return a blob outside /data/documents/policies/.
          // The legacy un-prefixed layout has been migrated out, so allowLegacy
          // is no longer needed.
          const file = getUploadedFileForModule(policy.file_path, 'policies');
          if (!file) return c.json({ error: "File not found on disk" }, 404);

          // Range-aware response so the streaming-download helper can resume
          // an interrupted download without re-fetching the whole file.
          const { bufferResponseWithRange } =
            await import("../../utils/excelExport");
          const reqHeaders = {
            range: c.req.header("Range"),
            "if-range": c.req.header("If-Range"),
          };
          return bufferResponseWithRange(
            file.buffer,
            policy.file_mime_type || "application/octet-stream",
            policy.file_name || file.fileName,
            reqHeaders,
          );
        } catch (error) {
          safeLogger.error("❌ [PolicyAPI] Error downloading file:", error);
          return c.json({ error: "Failed to download file" }, 500);
        }
      };
    },
  },
];
