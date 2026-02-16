export const handoffRoutes = [
  {
    path: "/api/handoff/rules",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getAllHandoffRules, initHandoffTables } = await import('../../utils/handoffDatabase');
          await initHandoffTables();
          
          const url = new URL(c.req.url);
          const source_module = url.searchParams.get('source_module') || undefined;
          const is_active = url.searchParams.get('is_active');

          logger?.info('📋 [HandoffAPI] GET /api/handoff/rules');
          const result = await getAllHandoffRules({ 
            source_module, 
            is_active: is_active ? is_active === 'true' : undefined 
          });
          return c.json(result);
        } catch (error) {
          console.error('❌ [HandoffAPI] Error fetching rules:', error);
          return c.json({ error: 'Failed to fetch handoff rules' }, 500);
        }
      };
    }
  },
  {
    path: "/api/handoff/summary",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getHandoffSummary, initHandoffTables } = await import('../../utils/handoffDatabase');
          await initHandoffTables();
          
          logger?.info('📊 [HandoffAPI] GET /api/handoff/summary');
          const summary = await getHandoffSummary();
          return c.json(summary);
        } catch (error) {
          console.error('❌ [HandoffAPI] Error fetching summary:', error);
          return c.json({ error: 'Failed to fetch handoff summary' }, 500);
        }
      };
    }
  },
  {
    path: "/api/handoff/events",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getHandoffEvents, initHandoffTables } = await import('../../utils/handoffDatabase');
          await initHandoffTables();
          
          const url = new URL(c.req.url);
          const status = url.searchParams.get('status') || undefined;
          const source_module = url.searchParams.get('source_module') || undefined;

          logger?.info('📋 [HandoffAPI] GET /api/handoff/events');
          const result = await getHandoffEvents({ status, source_module });
          return c.json(result);
        } catch (error) {
          console.error('❌ [HandoffAPI] Error fetching events:', error);
          return c.json({ error: 'Failed to fetch handoff events' }, 500);
        }
      };
    }
  },
  {
    path: "/api/handoff/rules",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { createHandoffRule, initHandoffTables } = await import('../../utils/handoffDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initHandoffTables();
          
          const body = await c.req.json();
          logger?.info('📝 [HandoffAPI] POST /api/handoff/rules', { name: body.name });

          if (!body.name || !body.source_module || !body.target_module || !body.trigger_type || !body.action_type) {
            return c.json({ error: 'Missing required fields' }, 400);
          }

          const ruleCode = 'HND-' + Date.now().toString(36).toUpperCase();
          const rule = await createHandoffRule({
            ...body,
            rule_code: ruleCode,
            trigger_condition: JSON.stringify(body.trigger_condition || {})
          });

          await logEvent({
            entityType: 'HANDOFF_RULE',
            entityId: rule.id!.toString(),
            actionType: 'CREATE',
            description: `Handoff rule created: ${rule.name}`,
            newValue: JSON.stringify(rule),
            userName: body.created_by || 'system',
            severity: 'INFO',
            module: 'handoff'
          });

          return c.json({ success: true, rule });
        } catch (error: any) {
          console.error('❌ [HandoffAPI] Error creating rule:', error);
          if (error.code === '23505') {
            return c.json({ error: 'Rule code already exists' }, 400);
          }
          return c.json({ error: 'Failed to create handoff rule' }, 500);
        }
      };
    }
  },
  {
    path: "/api/handoff/rules/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { updateHandoffRule, initHandoffTables } = await import('../../utils/handoffDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initHandoffTables();
          
          const id = parseInt(c.req.param('id'));
          const body = await c.req.json();
          logger?.info('📝 [HandoffAPI] PUT /api/handoff/rules/:id', { id });

          const rule = await updateHandoffRule(id, body);

          await logEvent({
            entityType: 'HANDOFF_RULE',
            entityId: id.toString(),
            actionType: 'UPDATE',
            description: `Handoff rule updated: ${rule.name}`,
            newValue: JSON.stringify(rule),
            userName: body.updated_by || 'system',
            severity: 'INFO',
            module: 'handoff'
          });

          return c.json({ success: true, rule });
        } catch (error) {
          console.error('❌ [HandoffAPI] Error updating rule:', error);
          return c.json({ error: 'Failed to update handoff rule' }, 500);
        }
      };
    }
  },
  {
    path: "/api/handoff/events",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { createHandoffEvent, initHandoffTables } = await import('../../utils/handoffDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initHandoffTables();
          
          const body = await c.req.json();
          logger?.info('📝 [HandoffAPI] POST /api/handoff/events');

          if (!body.rule_id || !body.source_record_id || !body.source_module || !body.target_module || !body.action_type) {
            return c.json({ error: 'Missing required fields' }, 400);
          }

          const event = await createHandoffEvent(body);

          await logEvent({
            entityType: 'HANDOFF_EVENT',
            entityId: event.id!.toString(),
            actionType: 'TRIGGER',
            description: `Handoff triggered: ${body.source_module} → ${body.target_module}`,
            newValue: JSON.stringify(event),
            userName: body.triggered_by || 'system',
            severity: 'INFO',
            module: 'handoff'
          });

          return c.json({ success: true, event });
        } catch (error) {
          console.error('❌ [HandoffAPI] Error creating event:', error);
          return c.json({ error: 'Failed to create handoff event' }, 500);
        }
      };
    }
  },
  {
    path: "/api/handoff/controls",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getAllControlMappings, initHandoffTables } = await import('../../utils/handoffDatabase');
          await initHandoffTables();
          
          logger?.info('📋 [HandoffAPI] GET /api/handoff/controls');
          const controls = await getAllControlMappings();
          return c.json({ controls });
        } catch (error) {
          console.error('❌ [HandoffAPI] Error fetching controls:', error);
          return c.json({ error: 'Failed to fetch control mappings' }, 500);
        }
      };
    }
  },
  {
    path: "/api/handoff/controls/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { updateControlMapping, initHandoffTables } = await import('../../utils/handoffDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initHandoffTables();
          
          const id = parseInt(c.req.param('id'));
          const body = await c.req.json();
          logger?.info('📝 [HandoffAPI] PUT /api/handoff/controls/:id', { id });

          const control = await updateControlMapping(id, body);

          await logEvent({
            entityType: 'CONTROL',
            entityId: id.toString(),
            actionType: 'UPDATE',
            description: `Control mapping updated: ${control.control_name}`,
            newValue: JSON.stringify(control),
            userName: body.updated_by || 'system',
            severity: 'INFO',
            module: 'handoff'
          });

          return c.json({ success: true, control });
        } catch (error) {
          console.error('❌ [HandoffAPI] Error updating control:', error);
          return c.json({ error: 'Failed to update control mapping' }, 500);
        }
      };
    }
  }
];
