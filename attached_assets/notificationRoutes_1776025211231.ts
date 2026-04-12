export const notificationRoutes = [
  {
    path: "/api/notifications",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getNotifications } = await import("../../utils/notificationHub");
          const status = c.req.query("status");
          const module = c.req.query("module");
          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");
          const result = await getNotifications({ status, module, limit, offset });
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
          const { getUnreadCount } = await import("../../utils/notificationHub");
          const count = await getUnreadCount();
          return c.json({ count });
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
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const { markAsRead } = await import("../../utils/notificationHub");
          const notif = await markAsRead(id);
          if (!notif) return c.json({ error: "Not found" }, 404);
          return c.json({ success: true, notification: notif });
        } catch (error) {
          return c.json({ error: "Failed to mark as read" }, 500);
        }
      };
    },
  },
  {
    path: "/api/notifications/:id/dismiss",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const { dismissNotification } = await import("../../utils/notificationHub");
          const notif = await dismissNotification(id);
          if (!notif) return c.json({ error: "Not found" }, 404);
          return c.json({ success: true, notification: notif });
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
        try {
          const pg = await import("pg");
          const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });

          const [auditScoreRes, ncResolutionRes, capaEffRes, kpiRes, complianceRes] = await Promise.all([
            pool.query(`SELECT AVG(overall_score) as avg_score FROM quality_audit_results WHERE created_at >= NOW() - INTERVAL '90 days'`),
            pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'closed') as closed, COUNT(*) as total FROM nonconformance_records WHERE created_at >= NOW() - INTERVAL '90 days'`),
            pool.query(`SELECT COUNT(*) FILTER (WHERE effectiveness_result = 'effective') as effective, COUNT(*) FILTER (WHERE effectiveness_result IS NOT NULL) as reviewed FROM capa_records WHERE created_at >= NOW() - INTERVAL '90 days'`),
            pool.query(`SELECT COUNT(*) FILTER (WHERE kv.actual_value >= kd.threshold_green) as met, COUNT(*) as total FROM kpi_definitions kd LEFT JOIN kpi_values kv ON kd.id = kv.kpi_id WHERE kv.period_end >= NOW() - INTERVAL '90 days'`),
            pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'compliant') as compliant, COUNT(*) as total FROM obligations`),
          ]);

          await pool.end();

          const auditScore = parseFloat(auditScoreRes.rows[0]?.avg_score) || 0;
          const ncTotal = parseInt(ncResolutionRes.rows[0]?.total) || 0;
          const ncClosed = parseInt(ncResolutionRes.rows[0]?.closed) || 0;
          const ncResolutionRate = ncTotal > 0 ? (ncClosed / ncTotal) * 100 : 100;
          const capaReviewed = parseInt(capaEffRes.rows[0]?.reviewed) || 0;
          const capaEffective = parseInt(capaEffRes.rows[0]?.effective) || 0;
          const capaEffectivenessRate = capaReviewed > 0 ? (capaEffective / capaReviewed) * 100 : 100;
          const kpiTotal = parseInt(kpiRes.rows[0]?.total) || 0;
          const kpiMet = parseInt(kpiRes.rows[0]?.met) || 0;
          const kpiAchievementRate = kpiTotal > 0 ? (kpiMet / kpiTotal) * 100 : 100;
          const complianceTotal = parseInt(complianceRes.rows[0]?.total) || 0;
          const complianceCompliant = parseInt(complianceRes.rows[0]?.compliant) || 0;
          const complianceScore = complianceTotal > 0 ? (complianceCompliant / complianceTotal) * 100 : 100;

          const weights = { audit: 0.25, nc: 0.20, capa: 0.20, kpi: 0.20, compliance: 0.15 };
          const healthIndex =
            (auditScore * weights.audit) +
            (ncResolutionRate * weights.nc) +
            (capaEffectivenessRate * weights.capa) +
            (kpiAchievementRate * weights.kpi) +
            (complianceScore * weights.compliance);

          let healthStatus: string;
          if (healthIndex >= 90) healthStatus = 'excellent';
          else if (healthIndex >= 75) healthStatus = 'good';
          else if (healthIndex >= 60) healthStatus = 'fair';
          else healthStatus = 'needs_attention';

          return c.json({
            healthIndex: Math.round(healthIndex * 100) / 100,
            healthStatus,
            components: {
              auditScore: { value: Math.round(auditScore * 100) / 100, weight: weights.audit },
              ncResolutionRate: { value: Math.round(ncResolutionRate * 100) / 100, weight: weights.nc },
              capaEffectivenessRate: { value: Math.round(capaEffectivenessRate * 100) / 100, weight: weights.capa },
              kpiAchievementRate: { value: Math.round(kpiAchievementRate * 100) / 100, weight: weights.kpi },
              complianceScore: { value: Math.round(complianceScore * 100) / 100, weight: weights.compliance },
            },
            period: '90 days',
            calculatedAt: new Date().toISOString(),
          });
        } catch (error) {
          console.error("[HealthIndex] Error:", error);
          return c.json({ error: "Failed to calculate health index" }, 500);
        }
      };
    },
  },
];
