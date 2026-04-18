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
          const { updateTriggerStatus, initAuditTriggerTables } = await import('../../utils/auditTriggerDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          const { getSessionUser } = await import('../../utils/rbacMiddleware');
          await initAuditTriggerTables();

          const user = getSessionUser(c);
          const id = parseInt(c.req.param('id'));
          const body = await c.req.json().catch(() => ({}));
          const { action, decision, decidedBy, notes, dismiss_reason } = body;

          logger?.info('📝 [TriggerAPI] POST /api/triggers/:id/action', { id, action });

          if (!action) return c.json({ error: 'Missing required fields' }, 400);

          // Fetch current trigger so we can make risk-aware routing decisions
          const { auditTriggerPool: pool } = await import('../../utils/auditTriggerDatabase');
          const current = (await pool.query('SELECT * FROM audit_triggers WHERE id = $1', [id])).rows[0];

          let status: 'acknowledged' | 'actioned' | 'dismissed' = 'acknowledged';
          let decisionData: any = undefined;
          let extraUpdates: Record<string, any> = {};

          if (action === 'acknowledge') {
            status = 'acknowledged';
          } else if (action === 'dismiss') {
            const reason = typeof dismiss_reason === 'string' ? dismiss_reason.trim() : '';
            if (reason.length < 10) {
              return c.json({
                error: 'dismiss_reason is required (min 10 characters). ' +
                       'Dismissals must be justified per WP-SOP-009.',
              }, 400);
            }
            status = 'dismissed';
            extraUpdates = {
              dismiss_reason: reason,
              dismissed_at: 'NOW()',
              dismissed_by_email: user?.email || decidedBy || body.userEmail || 'system',
              // Re-evaluate in 24h — if the signal is still triggering, the
              // cron will resurface it with `status='pending'` so nobody can
              // bury a repeat failure.
              next_reevaluate_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
            };
          } else if (action === 'decide') {
            if (!decision || !(decidedBy || user?.email)) {
              return c.json({ error: 'decision and decidedBy are required for decide action' }, 400);
            }
            status = 'actioned';
            decisionData = { decision, decidedBy: decidedBy || user?.email, notes };
          } else if (action === 'propose_hitl') {
            if (!current) return c.json({ error: 'Trigger not found' }, 404);
            if (!user) return c.json({ error: 'Authentication required to propose HITL' }, 401);
            // Route high-risk decisions through the HITL queue so the Quality
            // Manager approves them in the same /ai-approvals inbox they use
            // for AI-write actions (WP-SOP-040).
            const { enqueuePendingAction } = await import('../../utils/aiApprovalDatabase');
            const riskMap: Record<string, 'high' | 'medium' | 'low'> = {
              critical: 'high', warning: 'medium', info: 'low',
            };
            const ticket = await enqueuePendingAction({
              toolId:           'trigger_decision',
              toolLabel:        `Trigger Decision — ${current.title}`,
              payload:          {
                trigger_id: id,
                trigger_type: current.trigger_type,
                audit_id: current.audit_id,
                proposed_decision: decision || 'approve_action',
                notes: notes || null,
              },
              payloadPreview:
                `Trigger: ${current.title}\n` +
                `Type: ${current.trigger_type} (severity: ${current.severity})\n` +
                `Action required: ${current.action_required || '(none specified)'}\n` +
                `Proposed decision: ${decision || 'approve_action'}`,
              riskLevel:        riskMap[current.severity] || 'medium',
              complianceRefs: [
                'WP-SOP-009 (Nonconformity & Corrective Action)',
                'WP-SOP-040 (Audit Programme Governance)',
                'WP-CTL-007 (Programme Sign-off Control)',
                'ISO 19011:2018 §6.7',
              ],
              requestedByUserId: user.userId,
              requestedByEmail:  user.email,
              requestedByName:   user.name,
              threadId:          `trigger-${id}`,
              ttlHours:          72,
            });
            extraUpdates = { hitl_action_code: ticket.action_code };
            status = 'acknowledged';  // stays open until reviewer approves
          } else {
            return c.json({ error: `Unknown action: ${action}` }, 400);
          }

          const trigger = await updateTriggerStatus(id, status, decisionData);
          if (!trigger) return c.json({ error: 'Trigger not found' }, 404);

          // Persist the extra columns added in the P0 schema migration
          if (Object.keys(extraUpdates).length > 0) {
            const fields: string[] = [];
            const vals: any[] = [];
            let i = 1;
            for (const [k, v] of Object.entries(extraUpdates)) {
              if (v === 'NOW()') {
                fields.push(`${k} = NOW()`);
              } else {
                fields.push(`${k} = $${i++}`);
                vals.push(v);
              }
            }
            vals.push(id);
            await pool.query(
              `UPDATE audit_triggers SET ${fields.join(', ')} WHERE id = $${i}`,
              vals
            );
          }

          await logEvent({
            entityType: 'TRIGGER',
            entityId: id.toString(),
            entityName: trigger.title,
            actionType: action.toUpperCase(),
            description:
              `Trigger ${trigger.trigger_id || id} ${action}` +
              (decisionData ? ` — ${decision}` : '') +
              (extraUpdates.dismiss_reason ? ` (reason: ${extraUpdates.dismiss_reason})` : '') +
              (extraUpdates.hitl_action_code ? ` (HITL ${extraUpdates.hitl_action_code})` : ''),
            userId: user?.userId,
            userEmail: user?.email || decidedBy || body.userEmail || 'System',
            userRole:  user?.role,
            module: 'audits',
            severity: action === 'dismiss' ? 'WARNING' : 'INFO',
            correlationId: extraUpdates.hitl_action_code || undefined,
          });

          return c.json({
            success: true,
            trigger,
            hitl_action_code: extraUpdates.hitl_action_code || undefined,
          });
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
