import { requireRoleOrKey, forbiddenResponse, getPlatformUser } from "../../utils/rbacMiddleware";
import type { UserRole } from "../../utils/rbacMiddleware";

import { logger } from "../../utils/logger";
// Roles permitted to read the health-index aggregates. These cover audit,
// NC, CAPA, KPI, and compliance data, so access is limited to governance-
// oriented roles that are already permitted to read those underlying modules
// directly. Mirrors the role set used by `/api/reports/capa-effectiveness`
// (REPORT_ALLOWED_ROLES in reportRoutes.ts) since both endpoints query the
// same sensitive operational tables (capa_records, nonconformance_records,
// quality_audit_results, kpi_values, obligations).
const HEALTH_INDEX_ROLES: UserRole[] = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
  "executive",
];

export const notificationRoutes = [
  {
    path: "/api/notifications",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getSessionUser, hasValidAdminApiKey } =
            await import("../../utils/rbacMiddleware");
          const { getNotifications } =
            await import("../../utils/notificationHub");
          const status = c.req.query("status");
          const module = c.req.query("module");
          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");

          const isAdminKey = hasValidAdminApiKey(c);
          const user = isAdminKey ? null : getSessionUser(c);

          // Admins and admin-key callers may see all notifications; everyone
          // else is scoped to their own email (plus unscoped system alerts).
          // Use the live DB role (not the stale cookie role) to prevent a
          // demoted user from retaining admin-scoped notification access.
          let isLiveAdmin = false;
          if (!isAdminKey && user?.email) {
            const platformUser = await getPlatformUser(user.email);
            isLiveAdmin =
              platformUser?.status === "active" &&
              platformUser?.role === "admin";
          }

          const recipientFilter =
            isAdminKey || isLiveAdmin
              ? undefined
              : user?.email ?? undefined;

          const result = await getNotifications({
            recipient: recipientFilter,
            status,
            module,
            limit,
            offset,
          });
          return c.json(result);
        } catch (error) {
          return c.json({ error: "Failed to fetch notifications" }, 500);
        }
      };
    },
  },
  {
    path: "/api/notifications/count",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getSessionUser, hasValidAdminApiKey } =
            await import("../../utils/rbacMiddleware");
          const { getUnreadCount } =
            await import("../../utils/notificationHub");

          const isAdminKey = hasValidAdminApiKey(c);
          const user = isAdminKey ? null : getSessionUser(c);

          // Use live DB role to prevent a demoted user from seeing the global
          // unread count instead of only their own.
          let isLiveAdmin = false;
          let liveRole: string | undefined;
          if (!isAdminKey && user?.email) {
            const platformUser = await getPlatformUser(user.email);
            if (platformUser?.status === "active") liveRole = platformUser.role;
            isLiveAdmin = liveRole === "admin";
          }

          const recipientFilter =
            isAdminKey || isLiveAdmin
              ? undefined
              : user?.email ?? undefined;

          const hubCount = await getUnreadCount(recipientFilter);

          // The bell LISTS audit_notifications (triggerRoutes wins the
          // /api/notifications registration), so a badge built from the hub
          // table alone read 0 while the dropdown showed hundreds of open
          // items. Total both feeds, scoped the same way each list is.
          let alertCount = 0;
          try {
            const { getUnreadNotificationCount, initAuditTriggerTables } =
              await import("../../utils/auditTriggerDatabase");
            const { TRIGGER_ADMIN_ROLES, TRIGGER_REVIEWER_ROLES } =
              await import("./triggerRoles");

            // Only count what this caller could actually open: the audit list
            // is gated on TRIGGER_REVIEWER_ROLES and scoped to recipient_role.
            // liveRole is the DB role, never the cookie's.
            const role = isAdminKey ? "admin" : liveRole;
            if (role && TRIGGER_REVIEWER_ROLES.includes(role as UserRole)) {
              await initAuditTriggerTables();
              alertCount = await getUnreadNotificationCount(
                TRIGGER_ADMIN_ROLES.has(role) ? undefined : role,
              );
            }
          } catch (alertError) {
            // A badge is not worth failing the request over.
            logger.error("[Notifications] audit count failed:", alertError);
          }

          return c.json({ count: hubCount + alertCount });
        } catch (error) {
          return c.json({ error: "Failed to fetch count" }, 500);
        }
      };
    },
  },
  {
    path: "/api/notifications/:id/read",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getSessionUser, forbiddenResponse, hasValidAdminApiKey } =
            await import("../../utils/rbacMiddleware");

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

          const { getNotificationById, markAsRead } =
            await import("../../utils/notificationHub");

          const notif = await getNotificationById(id);
          if (!notif) return c.json({ error: "Not found" }, 404);

          const isAdminKey = hasValidAdminApiKey(c);
          if (!isAdminKey) {
            const user = getSessionUser(c);
            if (!user) return c.json({ error: "Authentication required" }, 401);

            // Use live DB role — cookie role is stale after demotion.
            const platformUser = await getPlatformUser(user.email);
            const isLiveAdmin =
              platformUser?.status === "active" &&
              platformUser?.role === "admin";
            const isRecipient =
              notif.recipient && notif.recipient === user.email;

            if (!isLiveAdmin && !isRecipient) {
              return forbiddenResponse(
                c,
                "You may only mark your own notifications as read",
              );
            }
          }

          const updated = await markAsRead(id);
          if (!updated) return c.json({ error: "Not found" }, 404);
          return c.json({ success: true, notification: updated });
        } catch (error) {
          return c.json({ error: "Failed to mark as read" }, 500);
        }
      };
    },
  },
  {
    // NOTE: `POST /api/notifications/read-all` deliberately lives in
    // triggerRoutes.ts, not here. `/api/notifications` is registered in BOTH
    // files and triggerRoutes is spread first in src/mastra/index.ts, so that
    // file is what actually serves this path space — the bell lists
    // `audit_notifications`, not the hub table below. A read-all defined here
    // would be shadowed for the GET it is meant to clear. The trigger handler
    // clears BOTH feeds, including this one via `markAllAsRead`.
    path: "/api/notifications/:id/dismiss",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getSessionUser, forbiddenResponse, hasValidAdminApiKey } =
            await import("../../utils/rbacMiddleware");

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

          const { getNotificationById, dismissNotification } =
            await import("../../utils/notificationHub");

          const notif = await getNotificationById(id);
          if (!notif) return c.json({ error: "Not found" }, 404);

          const isAdminKey = hasValidAdminApiKey(c);
          if (!isAdminKey) {
            const user = getSessionUser(c);
            if (!user) return c.json({ error: "Authentication required" }, 401);

            // Use live DB role — cookie role is stale after demotion.
            const platformUser = await getPlatformUser(user.email);
            const isLiveAdmin =
              platformUser?.status === "active" &&
              platformUser?.role === "admin";
            const isRecipient =
              notif.recipient && notif.recipient === user.email;

            if (!isLiveAdmin && !isRecipient) {
              return forbiddenResponse(
                c,
                "You may only dismiss notifications addressed to you",
              );
            }
          }

          const dismissed = await dismissNotification(id);
          return c.json({ success: true, notification: dismissed });
        } catch (error) {
          return c.json({ error: "Failed to dismiss" }, 500);
        }
      };
    },
  },
  {
    path: "/api/health-index",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = await requireRoleOrKey(c, HEALTH_INDEX_ROLES);
        if (!user) {
          return forbiddenResponse(
            c,
            "Insufficient permissions to view health index",
          );
        }
        const pg = await import("pg");
        const pool = new pg.default.Pool({
          connectionString: process.env.DATABASE_URL,
        });
        try {
          const [
            auditScoreRes,
            ncResolutionRes,
            capaEffRes,
            kpiRes,
            complianceRes,
          ] = await Promise.all([
            pool
              .query(
                `SELECT AVG(overall_score) as avg_score FROM quality_audit_results WHERE created_at >= NOW() - INTERVAL '90 days'`,
              )
              .catch(() => ({ rows: [{ avg_score: null }] })),
            pool
              .query(
                `SELECT COUNT(*) FILTER (WHERE status = 'closed') as closed, COUNT(*) as total FROM nonconformance_records WHERE created_at >= NOW() - INTERVAL '90 days'`,
              )
              .catch(() => ({ rows: [{ closed: 0, total: 0 }] })),
            pool
              .query(
                `SELECT COUNT(*) FILTER (WHERE effectiveness_result = 'effective') as effective, COUNT(*) FILTER (WHERE effectiveness_result IS NOT NULL) as reviewed FROM capa_records WHERE created_at >= NOW() - INTERVAL '90 days'`,
              )
              .catch(() => ({ rows: [{ effective: 0, reviewed: 0 }] })),
            pool
              .query(
                `SELECT COUNT(*) FILTER (WHERE kv.actual_value >= kd.target_value) as met, COUNT(*) as total FROM kpi_definitions kd LEFT JOIN kpi_values kv ON kd.id = kv.kpi_id WHERE kv.period_end >= NOW() - INTERVAL '90 days'`,
              )
              .catch(() => ({ rows: [{ met: 0, total: 0 }] })),
            pool
              .query(
                `SELECT COUNT(*) FILTER (WHERE status = 'compliant') as compliant, COUNT(*) as total FROM obligations`,
              )
              .catch(() => ({ rows: [{ compliant: 0, total: 0 }] })),
          ]);

          const auditScore = parseFloat(auditScoreRes.rows[0]?.avg_score) || 0;
          const ncTotal = parseInt(ncResolutionRes.rows[0]?.total) || 0;
          const ncClosed = parseInt(ncResolutionRes.rows[0]?.closed) || 0;
          const ncResolutionRate =
            ncTotal > 0 ? (ncClosed / ncTotal) * 100 : 100;
          const capaReviewed = parseInt(capaEffRes.rows[0]?.reviewed) || 0;
          const capaEffective = parseInt(capaEffRes.rows[0]?.effective) || 0;
          const capaEffectivenessRate =
            capaReviewed > 0 ? (capaEffective / capaReviewed) * 100 : 100;
          const kpiTotal = parseInt(kpiRes.rows[0]?.total) || 0;
          const kpiMet = parseInt(kpiRes.rows[0]?.met) || 0;
          const kpiAchievementRate =
            kpiTotal > 0 ? (kpiMet / kpiTotal) * 100 : 100;
          const complianceTotal = parseInt(complianceRes.rows[0]?.total) || 0;
          const complianceCompliant =
            parseInt(complianceRes.rows[0]?.compliant) || 0;
          const complianceScore =
            complianceTotal > 0
              ? (complianceCompliant / complianceTotal) * 100
              : 100;

          const weights = {
            audit: 0.25,
            nc: 0.2,
            capa: 0.2,
            kpi: 0.2,
            compliance: 0.15,
          };
          const healthIndex =
            auditScore * weights.audit +
            ncResolutionRate * weights.nc +
            capaEffectivenessRate * weights.capa +
            kpiAchievementRate * weights.kpi +
            complianceScore * weights.compliance;

          let healthStatus: string;
          if (healthIndex >= 90) healthStatus = "excellent";
          else if (healthIndex >= 75) healthStatus = "good";
          else if (healthIndex >= 60) healthStatus = "fair";
          else healthStatus = "needs_attention";

          return c.json({
            healthIndex: Math.round(healthIndex * 100) / 100,
            healthStatus,
            components: {
              auditScore: {
                value: Math.round(auditScore * 100) / 100,
                weight: weights.audit,
              },
              ncResolutionRate: {
                value: Math.round(ncResolutionRate * 100) / 100,
                weight: weights.nc,
              },
              capaEffectivenessRate: {
                value: Math.round(capaEffectivenessRate * 100) / 100,
                weight: weights.capa,
              },
              kpiAchievementRate: {
                value: Math.round(kpiAchievementRate * 100) / 100,
                weight: weights.kpi,
              },
              complianceScore: {
                value: Math.round(complianceScore * 100) / 100,
                weight: weights.compliance,
              },
            },
            period: "90 days",
            calculatedAt: new Date().toISOString(),
          });
        } catch (error) {
          logger.error("[HealthIndex] Error:", error);
          return c.json({ error: "Failed to calculate health index" }, 500);
        } finally {
          await pool.end();
        }
      };
    },
  },
];
