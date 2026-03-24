export const complianceRoutes = [
  {
    path: "/api/compliance/regulations",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getAllRegulations, initComplianceTables } = await import('../../utils/complianceDatabase');
          await initComplianceTables();
          
          const url = new URL(c.req.url);
          const status = url.searchParams.get('status') || undefined;
          const jurisdiction = url.searchParams.get('jurisdiction') || undefined;
          const category = url.searchParams.get('category') || undefined;

          logger?.info('📋 [ComplianceAPI] GET /api/compliance/regulations');

          const regulations = await getAllRegulations({ status, jurisdiction, category });
          return c.json({ regulations });
        } catch (error) {
          console.error('❌ [ComplianceAPI] Error fetching regulations:', error);
          return c.json({ error: 'Failed to fetch regulations' }, 500);
        }
      };
    }
  },
  {
    path: "/api/compliance/regulations/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getRegulationById, getObligationsByRegulation, initComplianceTables } = await import('../../utils/complianceDatabase');
          await initComplianceTables();
          
          const id = parseInt(c.req.param('id'));
          logger?.info('📋 [ComplianceAPI] GET /api/compliance/regulations/:id', { id });

          const regulation = await getRegulationById(id);
          if (!regulation) {
            return c.json({ error: 'Regulation not found' }, 404);
          }

          const obligations = await getObligationsByRegulation(id);
          return c.json({ regulation, obligations });
        } catch (error) {
          console.error('❌ [ComplianceAPI] Error fetching regulation:', error);
          return c.json({ error: 'Failed to fetch regulation' }, 500);
        }
      };
    }
  },
  {
    path: "/api/compliance/regulations",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createRegulation, initComplianceTables } = await import('../../utils/complianceDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initComplianceTables();
          
          const body = await c.req.json();
          logger?.info('📝 [ComplianceAPI] POST /api/compliance/regulations', { name: body.name, by: sessionUser.email });

          if (!body.regulation_code || !body.name || !body.jurisdiction || !body.category) {
            return c.json({ error: 'Missing required fields: regulation_code, name, jurisdiction, category' }, 400);
          }

          const regulation = await createRegulation({ ...body, created_by: sessionUser.email });

          await logEvent({
            entityType: 'REGULATION',
            entityId: regulation.id!.toString(),
            actionType: 'CREATE',
            description: `New regulation added: ${regulation.name}`,
            newValue: JSON.stringify(regulation),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'compliance_tracker'
          });

          return c.json({ success: true, regulation });
        } catch (error: any) {
          console.error('❌ [ComplianceAPI] Error creating regulation:', error);
          if (error.code === '23505') {
            return c.json({ error: 'Regulation code already exists' }, 400);
          }
          return c.json({ error: 'Failed to create regulation' }, 500);
        }
      };
    }
  },
  {
    path: "/api/compliance/obligations",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getAllObligations, initComplianceTables } = await import('../../utils/complianceDatabase');
          await initComplianceTables();
          
          const url = new URL(c.req.url);
          const status = url.searchParams.get('status') || undefined;
          const priority = url.searchParams.get('priority') || undefined;
          const department = url.searchParams.get('department') || undefined;
          const regulation_id = url.searchParams.get('regulation_id') ? parseInt(url.searchParams.get('regulation_id')!) : undefined;

          logger?.info('📋 [ComplianceAPI] GET /api/compliance/obligations');

          const result = await getAllObligations({ status, priority, department, regulation_id });
          return c.json(result);
        } catch (error) {
          console.error('❌ [ComplianceAPI] Error fetching obligations:', error);
          return c.json({ error: 'Failed to fetch obligations' }, 500);
        }
      };
    }
  },
  {
    path: "/api/compliance/obligations/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getObligationById, getAssessmentHistory, initComplianceTables } = await import('../../utils/complianceDatabase');
          await initComplianceTables();
          
          const id = parseInt(c.req.param('id'));
          logger?.info('📋 [ComplianceAPI] GET /api/compliance/obligations/:id', { id });

          const obligation = await getObligationById(id);
          if (!obligation) {
            return c.json({ error: 'Obligation not found' }, 404);
          }

          const assessments = await getAssessmentHistory(id);
          return c.json({ obligation, assessments });
        } catch (error) {
          console.error('❌ [ComplianceAPI] Error fetching obligation:', error);
          return c.json({ error: 'Failed to fetch obligation' }, 500);
        }
      };
    }
  },
  {
    path: "/api/compliance/obligations",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createObligation, initComplianceTables } = await import('../../utils/complianceDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initComplianceTables();
          
          const body = await c.req.json();
          logger?.info('📝 [ComplianceAPI] POST /api/compliance/obligations', { title: body.title, by: sessionUser.email });

          if (!body.obligation_code || !body.regulation_id || !body.title || !body.description) {
            return c.json({ error: 'Missing required fields: obligation_code, regulation_id, title, description' }, 400);
          }

          const obligation = await createObligation({ ...body, created_by: sessionUser.email });

          await logEvent({
            entityType: 'OBLIGATION',
            entityId: obligation.id!.toString(),
            actionType: 'CREATE',
            description: `New compliance obligation created: ${obligation.title}`,
            newValue: JSON.stringify(obligation),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'compliance_tracker'
          });

          return c.json({ success: true, obligation });
        } catch (error: any) {
          console.error('❌ [ComplianceAPI] Error creating obligation:', error);
          if (error.code === '23505') {
            return c.json({ error: 'Obligation code already exists' }, 400);
          }
          return c.json({ error: 'Failed to create obligation' }, 500);
        }
      };
    }
  },
  {
    path: "/api/compliance/obligations/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updateObligation, getObligationById, initComplianceTables } = await import('../../utils/complianceDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initComplianceTables();
          
          const id = parseInt(c.req.param('id'));
          const body = await c.req.json();
          logger?.info('📝 [ComplianceAPI] PUT /api/compliance/obligations/:id', { id, by: sessionUser.email });

          const existing = await getObligationById(id);
          if (!existing) {
            return c.json({ error: 'Obligation not found' }, 404);
          }

          const obligation = await updateObligation(id, body);

          await logEvent({
            entityType: 'OBLIGATION',
            entityId: id.toString(),
            actionType: 'UPDATE',
            description: `Compliance obligation updated: ${obligation.title}`,
            oldValue: JSON.stringify(existing),
            newValue: JSON.stringify(obligation),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'compliance_tracker'
          });

          return c.json({ success: true, obligation });
        } catch (error) {
          console.error('❌ [ComplianceAPI] Error updating obligation:', error);
          return c.json({ error: 'Failed to update obligation' }, 500);
        }
      };
    }
  },
  {
    path: "/api/compliance/assessments",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createAssessment, getObligationById, initComplianceTables } = await import('../../utils/complianceDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initComplianceTables();
          
          const body = await c.req.json();
          logger?.info('📝 [ComplianceAPI] POST /api/compliance/assessments', { by: sessionUser.email });

          if (!body.obligation_id || !body.compliance_status) {
            return c.json({ error: 'Missing required fields: obligation_id, compliance_status' }, 400);
          }

          const obligation = await getObligationById(body.obligation_id);
          if (!obligation) {
            return c.json({ error: 'Obligation not found' }, 404);
          }

          const assessment = await createAssessment({ ...body, assessed_by: sessionUser.email });

          await logEvent({
            entityType: 'ASSESSMENT',
            entityId: assessment.id!.toString(),
            actionType: 'CREATE',
            description: `Compliance assessment recorded for ${obligation.title}: ${body.compliance_status}`,
            newValue: JSON.stringify(assessment),
            userName: sessionUser.email,
            severity: body.compliance_status === 'non_compliant' ? 'CRITICAL' : 'INFO',
            module: 'compliance_tracker'
          });

          return c.json({ success: true, assessment });
        } catch (error) {
          console.error('❌ [ComplianceAPI] Error creating assessment:', error);
          return c.json({ error: 'Failed to create assessment' }, 500);
        }
      };
    }
  },
  {
    path: "/api/compliance/summary",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getComplianceSummary, initComplianceTables } = await import('../../utils/complianceDatabase');
          await initComplianceTables();
          
          logger?.info('📊 [ComplianceAPI] GET /api/compliance/summary');
          const summary = await getComplianceSummary();
          return c.json(summary);
        } catch (error) {
          console.error('❌ [ComplianceAPI] Error fetching summary:', error);
          return c.json({ error: 'Failed to fetch compliance summary' }, 500);
        }
      };
    }
  },
  {
    path: "/api/compliance/calendar",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getComplianceCalendar, initComplianceTables } = await import('../../utils/complianceDatabase');
          await initComplianceTables();
          
          const url = new URL(c.req.url);
          const month = url.searchParams.get('month') ? parseInt(url.searchParams.get('month')!) : undefined;
          const year = url.searchParams.get('year') ? parseInt(url.searchParams.get('year')!) : undefined;
          const status = url.searchParams.get('status') || undefined;

          logger?.info('📋 [ComplianceAPI] GET /api/compliance/calendar');
          const events = await getComplianceCalendar({ month, year, status });
          return c.json({ events });
        } catch (error) {
          console.error('❌ [ComplianceAPI] Error fetching calendar:', error);
          return c.json({ error: 'Failed to fetch compliance calendar' }, 500);
        }
      };
    }
  },
  {
    path: "/api/compliance/calendar",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createCalendarEvent, initComplianceTables } = await import('../../utils/complianceDatabase');
          await initComplianceTables();
          
          const body = await c.req.json();
          logger?.info('📝 [ComplianceAPI] POST /api/compliance/calendar');

          if (!body.obligation_id || !body.event_type || !body.scheduled_date) {
            return c.json({ error: 'Missing required fields: obligation_id, event_type, scheduled_date' }, 400);
          }

          const event = await createCalendarEvent(body);
          return c.json({ success: true, event });
        } catch (error) {
          console.error('❌ [ComplianceAPI] Error creating calendar event:', error);
          return c.json({ error: 'Failed to create calendar event' }, 500);
        }
      };
    }
  },
  {
    path: "/api/compliance/deadlines",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getUpcomingDeadlines, getOverdueEvents, initComplianceTables } = await import('../../utils/complianceDatabase');
          await initComplianceTables();
          
          const url = new URL(c.req.url);
          const days = parseInt(url.searchParams.get('days') || '30');

          logger?.info('📋 [ComplianceAPI] GET /api/compliance/deadlines');
          
          const [upcoming, overdue] = await Promise.all([
            getUpcomingDeadlines(days),
            getOverdueEvents()
          ]);

          return c.json({ upcoming, overdue });
        } catch (error) {
          console.error('❌ [ComplianceAPI] Error fetching deadlines:', error);
          return c.json({ error: 'Failed to fetch deadlines' }, 500);
        }
      };
    }
  }
];
