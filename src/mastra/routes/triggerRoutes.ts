export const triggerRoutes = [
  {
    path: "/api/triggers",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getPendingTriggers, initAuditTriggerTables } = await import('../../utils/auditTriggerDatabase');
          await initAuditTriggerTables();
          
          const url = new URL(c.req.url);
          const type = url.searchParams.get('type') || undefined;
          const role = url.searchParams.get('role') || undefined;

          logger?.info('🔔 [TriggerAPI] GET /api/triggers');

          const triggers = await getPendingTriggers({ type: type as any, role });
          return c.json({ success: true, triggers, count: triggers.length });
        } catch (error) {
          console.error('❌ [TriggerAPI] Error fetching triggers:', error);
          return c.json({ error: 'Failed to fetch triggers' }, 500);
        }
      };
    }
  },
  {
    path: "/api/triggers/stats",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getTriggersStats, initAuditTriggerTables } = await import('../../utils/auditTriggerDatabase');
          await initAuditTriggerTables();
          
          logger?.info('📊 [TriggerAPI] GET /api/triggers/stats');

          const stats = await getTriggersStats();
          return c.json({ success: true, ...stats });
        } catch (error) {
          console.error('❌ [TriggerAPI] Error fetching trigger stats:', error);
          return c.json({ error: 'Failed to fetch trigger stats' }, 500);
        }
      };
    }
  },
  {
    path: "/api/triggers/:id/action",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { updateTriggerStatus, initAuditTriggerTables } = await import('../../utils/auditTriggerDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initAuditTriggerTables();
          
          const id = parseInt(c.req.param('id'));
          const body = await c.req.json();
          const { action, decision, decidedBy, notes } = body;

          logger?.info('📝 [TriggerAPI] POST /api/triggers/:id/action', { id, action });

          if (!action) {
            return c.json({ error: 'Missing required fields' }, 400);
          }

          let status: 'acknowledged' | 'actioned' | 'dismissed' = 'acknowledged';
          let decisionData = undefined;

          if (action === 'acknowledge') {
            status = 'acknowledged';
          } else if (action === 'dismiss') {
            status = 'dismissed';
          } else if (action === 'decide') {
            if (!decision || !decidedBy) {
              return c.json({ error: 'decision and decidedBy are required for decide action' }, 400);
            }
            status = 'actioned';
            decisionData = { decision, decidedBy, notes };
          }

          const trigger = await updateTriggerStatus(id, status, decisionData);
          
          if (!trigger) {
            return c.json({ error: 'Trigger not found' }, 404);
          }

          await logEvent({
            entityType: 'TRIGGER',
            entityId: id.toString(),
            action: action.toUpperCase(),
            description: `Trigger ${trigger.trigger_id} ${action}d${decisionData ? ` - ${decision}` : ''}`,
            userEmail: decidedBy || body.userEmail || 'System',
            module: 'QMS'
          });

          return c.json({ success: true, trigger });
        } catch (error) {
          console.error('❌ [TriggerAPI] Error updating trigger:', error);
          return c.json({ error: 'Failed to update trigger' }, 500);
        }
      };
    }
  },
  {
    path: "/api/triggers/audit/:auditId",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getTriggersByAudit, initAuditTriggerTables } = await import('../../utils/auditTriggerDatabase');
          await initAuditTriggerTables();
          
          const auditId = parseInt(c.req.param('auditId'));
          logger?.info('🔔 [TriggerAPI] GET /api/triggers/audit/:auditId', { auditId });

          const triggers = await getTriggersByAudit(auditId);
          return c.json({ success: true, triggers });
        } catch (error) {
          console.error('❌ [TriggerAPI] Error fetching audit triggers:', error);
          return c.json({ error: 'Failed to fetch audit triggers' }, 500);
        }
      };
    }
  },
  {
    path: "/api/notifications",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getUnreadNotifications, initAuditTriggerTables } = await import('../../utils/auditTriggerDatabase');
          await initAuditTriggerTables();
          
          const url = new URL(c.req.url);
          const role = url.searchParams.get('role') || undefined;

          logger?.info('📧 [TriggerAPI] GET /api/notifications');

          const notifications = await getUnreadNotifications(role);
          return c.json({ success: true, notifications, count: notifications.length });
        } catch (error) {
          console.error('❌ [TriggerAPI] Error fetching notifications:', error);
          return c.json({ error: 'Failed to fetch notifications' }, 500);
        }
      };
    }
  },
  {
    path: "/api/notifications/:id/read",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { markNotificationRead, initAuditTriggerTables } = await import('../../utils/auditTriggerDatabase');
          await initAuditTriggerTables();
          
          const id = parseInt(c.req.param('id'));
          logger?.info('📧 [TriggerAPI] POST /api/notifications/:id/read', { id });

          await markNotificationRead(id);
          return c.json({ success: true });
        } catch (error) {
          console.error('❌ [TriggerAPI] Error marking notification read:', error);
          return c.json({ error: 'Failed to mark notification read' }, 500);
        }
      };
    }
  }
];
