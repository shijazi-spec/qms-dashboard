import { logger as safeLogger } from "../../utils/logger"; // Roles that can see all triggers/notifications and action any trigger regardless of assigned_role
const TRIGGER_ADMIN_ROLES = new Set(["admin", "head_of_operations_quality"]);

// Roles permitted to participate in trigger review workflows
const TRIGGER_REVIEWER_ROLES = new Set([
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
  "auditor",
  "team_lead",
  "executive",
  "bu_owner",
  "ai_specialist",
]);

export const triggerRoutes = [
  {
    path: "/api/triggers",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getPendingTriggers, initAuditTriggerTables } =
            await import("../../utils/auditTriggerDatabase");
          const { getSessionUser } = await import("../../utils/rbacMiddleware");
          await initAuditTriggerTables();

          const user = getSessionUser(c);
          if (!user) return c.json({ error: "Authentication required" }, 401);
          if (!TRIGGER_REVIEWER_ROLES.has(user.role)) {
            return c.json(
              { error: "Insufficient permissions to view triggers" },
              403,
            );
          }
          
          const url = new URL(c.req.url);
          const type = url.searchParams.get("type") || undefined;

          // Non-admin users can only see triggers assigned to their own role.
          // Admin/head_of_operations_quality may optionally filter by any role.
          const effectiveRole = TRIGGER_ADMIN_ROLES.has(user.role)
            ? url.searchParams.get("role") || undefined
            : user.role;

          logger?.info("🔔 [TriggerAPI] GET /api/triggers", {
            userRole: user.role,
            effectiveRole,
          });

          const triggers = await getPendingTriggers({
            type: type as any,
            role: effectiveRole,
          });
          return c.json({ success: true, triggers, count: triggers.length });
        } catch (error) {
          safeLogger.error("❌ [TriggerAPI] Error fetching triggers:", error);
          return c.json({ error: "Failed to fetch triggers" }, 500);
        }
      };
    },
  },
  {
    path: "/api/triggers/stats",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getTriggersStats, initAuditTriggerTables } =
            await import("../../utils/auditTriggerDatabase");
          const { getSessionUser } = await import("../../utils/rbacMiddleware");
          await initAuditTriggerTables();
          
          const user = getSessionUser(c);
          if (!user) return c.json({ error: "Authentication required" }, 401);
          if (!TRIGGER_REVIEWER_ROLES.has(user.role)) {
            return c.json(
              { error: "Insufficient permissions to view trigger stats" },
              403,
            );
          }

          logger?.info("📊 [TriggerAPI] GET /api/triggers/stats", {
            userRole: user.role,
          });

          const stats = await getTriggersStats();
          return c.json({ success: true, ...stats });
        } catch (error) {
          safeLogger.error(
            "❌ [TriggerAPI] Error fetching trigger stats:",
            error,
          );
          return c.json({ error: "Failed to fetch trigger stats" }, 500);
        }
      };
    },
  },
  /**
   * POST /api/triggers/:id/action
   *
   * Supported actions:
   *   acknowledge           → no side-effect, just marks as read
   *   dismiss               → requires dismiss_reason (min 10 chars);
   *                           schedules a daily re-evaluation so triggers
   *                           that are dismissed but whose underlying signal
   *                           keeps getting worse resurface automatically
   *   decide                → records a final decision (approved/rejected/modified)
   *   propose_hitl          → high-risk triggers route through the HITL queue
   *                           at /ai-approvals instead of actioning in place
   *
   * Authorization: the caller must be authenticated and their role must match
   * the trigger's assigned_role, or they must hold an admin-level role
   * (admin / head_of_operations_quality).
   *
   * Reference: WP-CTL-007 (Sign-off Control), WP-SOP-009 (Nonconformity &
   * Corrective Action), ISO 19011 §6.7 (follow-up).
   */
  {
    path: "/api/triggers/:id/action",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { updateTriggerStatus, initAuditTriggerTables } =
            await import("../../utils/auditTriggerDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          const { getSessionUser } = await import("../../utils/rbacMiddleware");
          await initAuditTriggerTables();
          
          const user = getSessionUser(c);
          if (!user) return c.json({ error: "Authentication required" }, 401);

          const id = parseInt(c.req.param("id"));
          const body = await c.req.json().catch(() => ({}));
          const { action, decision, decidedBy, notes, dismiss_reason } = body;

          logger?.info("📝 [TriggerAPI] POST /api/triggers/:id/action", {
            id,
            action,
            userRole: user.role,
          });

          if (!action) return c.json({ error: "Missing required fields" }, 400);

          // Fetch current trigger so we can make risk-aware routing decisions
          // and verify role-based ownership.
          const { auditTriggerPool: pool } =
            await import("../../utils/auditTriggerDatabase");
          const current = (
            await pool.query("SELECT * FROM audit_triggers WHERE id = $1", [id])
          ).rows[0];

          if (!current) return c.json({ error: "Trigger not found" }, 404);

          // Authorization: only the assigned role (or privileged admin roles) may action a trigger.
          // Triggers with no assigned_role are also restricted to admin-level roles to prevent
          // unowned triggers from becoming an open-access write surface.
          if (!TRIGGER_ADMIN_ROLES.has(user.role)) {
            if (!current.assigned_role || user.role !== current.assigned_role) {
              return c.json(
                {
                  error:
                    "Forbidden: you are not the assigned reviewer for this trigger",
                },
                403,
              );
            }
          }

          let status: "acknowledged" | "actioned" | "dismissed" =
            "acknowledged";
          let decisionData: any = undefined;
          let extraUpdates: Record<string, any> = {};

          if (action === "acknowledge") {
            status = "acknowledged";
          } else if (action === "dismiss") {
            const reason =
              typeof dismiss_reason === "string" ? dismiss_reason.trim() : "";
            if (reason.length < 10) {
              return c.json(
                {
                  error:
                    "dismiss_reason is required (min 10 characters). " +
                    "Dismissals must be justified per WP-SOP-009.",
                },
                400,
              );
            }
            status = "dismissed";
            extraUpdates = {
              dismiss_reason: reason,
              dismissed_at: "NOW()",
              dismissed_by_email: user.email,
              // Re-evaluate in 24h — if the signal is still triggering, the
              // cron will resurface it with `status='pending'` so nobody can
              // bury a repeat failure.
              next_reevaluate_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
            };
          } else if (action === "decide") {
            if (!decision || !user.email) {
              return c.json(
                { error: "decision is required for decide action" },
                400,
              );
            }
            status = "actioned";
            decisionData = { decision, decidedBy: user.email, notes };
          } else if (action === "propose_hitl") {
            if (!user)
              return c.json(
                { error: "Authentication required to propose HITL" },
                401,
              );
            // Route high-risk decisions through the HITL queue so the Quality
            // Manager approves them in the same /ai-approvals inbox they use
            // for AI-write actions (WP-SOP-040).
            const { enqueuePendingAction } =
              await import("../../utils/aiApprovalDatabase");
            const riskMap: Record<string, "high" | "medium" | "low"> = {
              critical: "high",
              warning: "medium",
              info: "low",
            };
            const ticket = await enqueuePendingAction({
              toolId: "trigger_decision",
              toolLabel: `Trigger Decision — ${current.title}`,
              payload: {
                trigger_id: id,
                trigger_type: current.trigger_type,
                audit_id: current.audit_id,
                proposed_decision: decision || "approve_action",
                notes: notes || null,
              },
              payloadPreview:
                `Trigger: ${current.title}\n` +
                `Type: ${current.trigger_type} (severity: ${current.severity})\n` +
                `Action required: ${current.action_required || "(none specified)"}\n` +
                `Proposed decision: ${decision || "approve_action"}`,
              riskLevel: riskMap[current.severity] || "medium",
              complianceRefs: [
                "WP-SOP-009 (Nonconformity & Corrective Action)",
                "WP-SOP-040 (Audit Programme Governance)",
                "WP-CTL-007 (Programme Sign-off Control)",
                "ISO 19011:2018 §6.7",
              ],
              requestedByUserId: user.userId,
              requestedByEmail: user.email,
              requestedByName: user.name,
              threadId: `trigger-${id}`,
              ttlHours: 72,
            });
            extraUpdates = { hitl_action_code: ticket.action_code };
            status = "acknowledged"; // stays open until reviewer approves
          } else {
            return c.json({ error: `Unknown action: ${action}` }, 400);
          }

          const trigger = await updateTriggerStatus(id, status, decisionData);
          if (!trigger) return c.json({ error: "Trigger not found" }, 404);

          // Persist the extra columns added in the P0 schema migration
          if (Object.keys(extraUpdates).length > 0) {
            const fields: string[] = [];
            const vals: any[] = [];
            let i = 1;
            for (const [k, v] of Object.entries(extraUpdates)) {
              if (v === "NOW()") {
                fields.push(`${k} = NOW()`);
              } else {
                fields.push(`${k} = $${i++}`);
                vals.push(v);
              }
            }
            vals.push(id);
            await pool.query(
              `UPDATE audit_triggers SET ${fields.join(", ")} WHERE id = $${i}`,
              vals,
            );
          }

          await logEvent({
            entityType: "TRIGGER",
            entityId: id.toString(),
            entityName: trigger.title,
            actionType: action.toUpperCase(),
            description:
              `Trigger ${trigger.trigger_id || id} ${action}` +
              (decisionData ? ` — ${decision}` : "") +
              (extraUpdates.dismiss_reason
                ? ` (reason: ${extraUpdates.dismiss_reason})`
                : "") +
              (extraUpdates.hitl_action_code
                ? ` (HITL ${extraUpdates.hitl_action_code})`
                : ""),
            userId: user.userId,
            userEmail: user.email,
            userRole: user.role,
            module: "audits",
            severity: action === "dismiss" ? "WARNING" : "INFO",
            correlationId: extraUpdates.hitl_action_code || undefined,
          });

          return c.json({
            success: true,
            trigger,
            hitl_action_code: extraUpdates.hitl_action_code || undefined,
          });
        } catch (error) {
          safeLogger.error("❌ [TriggerAPI] Error updating trigger:", error);
          return c.json({ error: "Failed to update trigger" }, 500);
        }
      };
    },
  },
  {
    path: "/api/triggers/audit/:auditId",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getTriggersByAudit, initAuditTriggerTables } =
            await import("../../utils/auditTriggerDatabase");
          const { getSessionUser } = await import("../../utils/rbacMiddleware");
          await initAuditTriggerTables();
          
          const user = getSessionUser(c);
          if (!user) return c.json({ error: "Authentication required" }, 401);
          if (!TRIGGER_REVIEWER_ROLES.has(user.role)) {
            return c.json(
              { error: "Insufficient permissions to view audit triggers" },
              403,
            );
          }

          const auditId = parseInt(c.req.param("auditId"));

          // Non-admin users only see triggers assigned to their own role within
          // the audit. Admin-level roles can see all triggers for the audit.
          const effectiveRole = TRIGGER_ADMIN_ROLES.has(user.role)
            ? undefined
            : user.role;

          logger?.info("🔔 [TriggerAPI] GET /api/triggers/audit/:auditId", {
            auditId,
            userRole: user.role,
            effectiveRole,
          });

          const triggers = await getTriggersByAudit(auditId, effectiveRole);
          return c.json({ success: true, triggers });
        } catch (error) {
          safeLogger.error(
            "❌ [TriggerAPI] Error fetching audit triggers:",
            error,
          );
          return c.json({ error: "Failed to fetch audit triggers" }, 500);
        }
      };
    },
  },
  {
    path: "/api/notifications",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getUnreadNotifications, initAuditTriggerTables } =
            await import("../../utils/auditTriggerDatabase");
          const { getSessionUser } = await import("../../utils/rbacMiddleware");
          await initAuditTriggerTables();

          const user = getSessionUser(c);
          if (!user) return c.json({ error: "Authentication required" }, 401);
          if (!TRIGGER_REVIEWER_ROLES.has(user.role)) {
            return c.json(
              { error: "Insufficient permissions to view notifications" },
              403,
            );
          }
          
          const url = new URL(c.req.url);

          // Non-admin users can only see notifications addressed to their own role.
          // Admin/head_of_operations_quality may optionally filter by any role.
          const effectiveRole = TRIGGER_ADMIN_ROLES.has(user.role)
            ? url.searchParams.get("role") || undefined
            : user.role;

          logger?.info("📧 [TriggerAPI] GET /api/notifications", {
            userRole: user.role,
            effectiveRole,
          });

          const notifications = await getUnreadNotifications(effectiveRole);
          return c.json({
            success: true,
            notifications,
            count: notifications.length,
          });
        } catch (error) {
          safeLogger.error(
            "❌ [TriggerAPI] Error fetching notifications:",
            error,
          );
          return c.json({ error: "Failed to fetch notifications" }, 500);
        }
      };
    },
  },
  {
    path: "/api/notifications/:id/read",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { markNotificationRead, initAuditTriggerTables } =
            await import("../../utils/auditTriggerDatabase");
          const { getSessionUser } = await import("../../utils/rbacMiddleware");
          await initAuditTriggerTables();
          
          const user = getSessionUser(c);
          if (!user) return c.json({ error: "Authentication required" }, 401);

          const id = parseInt(c.req.param("id"));
          logger?.info("📧 [TriggerAPI] POST /api/notifications/:id/read", {
            id,
            userRole: user.role,
          });

          // Verify the notification exists and belongs to the caller's role.
          const { auditTriggerPool: pool } =
            await import("../../utils/auditTriggerDatabase");
          const notification = (
            await pool.query(
              "SELECT * FROM audit_notifications WHERE id = $1",
              [id],
            )
          ).rows[0];

          if (!notification)
            return c.json({ error: "Notification not found" }, 404);

          if (
            !TRIGGER_ADMIN_ROLES.has(user.role) &&
            notification.recipient_role &&
            user.role !== notification.recipient_role
          ) {
            return c.json(
              {
                error:
                  "Forbidden: this notification does not belong to your role",
              },
              403,
            );
          }

          await markNotificationRead(id);
          return c.json({ success: true });
        } catch (error) {
          safeLogger.error(
            "❌ [TriggerAPI] Error marking notification read:",
            error,
          );
          return c.json({ error: "Failed to mark notification read" }, 500);
        }
      };
    },
  },
];
