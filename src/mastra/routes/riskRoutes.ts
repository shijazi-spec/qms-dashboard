export const riskRoutes = [
  {
    path: "/api/risks",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getAllRisks, initRiskTables } = await import('../../utils/riskDatabase');
          await initRiskTables();
          
          const url = new URL(c.req.url);
          const status = url.searchParams.get('status') || undefined;
          const category = url.searchParams.get('category') || undefined;
          const risk_level = url.searchParams.get('risk_level') || undefined;
          const owner_department = url.searchParams.get('owner_department') || undefined;
          const limit = parseInt(url.searchParams.get('limit') || '50');
          const offset = parseInt(url.searchParams.get('offset') || '0');

          logger?.info('📊 [RiskAPI] GET /api/risks', { status, category, risk_level, owner_department });

          const result = await getAllRisks({
            status, category, risk_level, owner_department, limit, offset
          });

          return c.json(result);
        } catch (error) {
          console.error('❌ [RiskAPI] Error fetching risks:', error);
          return c.json({ error: 'Failed to fetch risks' }, 500);
        }
      };
    }
  },
  {
    path: "/api/risks/heatmap",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getRiskHeatmapData, initRiskTables } = await import('../../utils/riskDatabase');
          await initRiskTables();
          
          logger?.info('📊 [RiskAPI] GET /api/risks/heatmap');
          const heatmap = await getRiskHeatmapData();
          return c.json({ heatmap });
        } catch (error) {
          console.error('❌ [RiskAPI] Error fetching heatmap:', error);
          return c.json({ error: 'Failed to fetch heatmap data' }, 500);
        }
      };
    }
  },
  {
    path: "/api/risks/summary",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getRiskSummaryStats, initRiskTables } = await import('../../utils/riskDatabase');
          await initRiskTables();
          
          logger?.info('📊 [RiskAPI] GET /api/risks/summary');
          const summary = await getRiskSummaryStats();
          return c.json(summary);
        } catch (error) {
          console.error('❌ [RiskAPI] Error fetching summary:', error);
          return c.json({ error: 'Failed to fetch risk summary' }, 500);
        }
      };
    }
  },
  {
    path: "/api/risks/trends",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getRiskTrends, initRiskTables } = await import('../../utils/riskDatabase');
          await initRiskTables();
          
          const url = new URL(c.req.url);
          const days = parseInt(url.searchParams.get('days') || '90');
          logger?.info('📊 [RiskAPI] GET /api/risks/trends', { days });
          
          const trends = await getRiskTrends(days);
          return c.json({ trends });
        } catch (error) {
          console.error('❌ [RiskAPI] Error fetching trends:', error);
          return c.json({ error: 'Failed to fetch risk trends' }, 500);
        }
      };
    }
  },
  {
    path: "/api/risks/overdue",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getOverdueRisks, getOverdueTreatmentActions, initRiskTables } = await import('../../utils/riskDatabase');
          await initRiskTables();
          
          logger?.info('📊 [RiskAPI] GET /api/risks/overdue');
          
          const [overdueRisks, overdueActions] = await Promise.all([
            getOverdueRisks(),
            getOverdueTreatmentActions()
          ]);
          
          return c.json({ 
            overdue_risks: overdueRisks,
            overdue_actions: overdueActions
          });
        } catch (error) {
          console.error('❌ [RiskAPI] Error fetching overdue items:', error);
          return c.json({ error: 'Failed to fetch overdue items' }, 500);
        }
      };
    }
  },
  {
    path: "/api/risks/categories",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getRiskCategories, initRiskTables } = await import('../../utils/riskDatabase');
          await initRiskTables();
          
          logger?.info('📊 [RiskAPI] GET /api/risks/categories');
          const categories = await getRiskCategories();
          return c.json({ categories });
        } catch (error) {
          console.error('❌ [RiskAPI] Error fetching categories:', error);
          return c.json({ error: 'Failed to fetch categories' }, 500);
        }
      };
    }
  },
  {
    path: "/api/risks/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getRiskById, getTreatmentActions, getRiskAssessmentHistory, initRiskTables } = await import('../../utils/riskDatabase');
          await initRiskTables();
          
          const id = parseInt(c.req.param('id'));
          logger?.info('📊 [RiskAPI] GET /api/risks/:id', { id });

          const risk = await getRiskById(id);
          if (!risk) {
            return c.json({ error: 'Risk not found' }, 404);
          }

          const [treatments, history] = await Promise.all([
            getTreatmentActions(id),
            getRiskAssessmentHistory(id)
          ]);

          return c.json({ 
            risk, 
            treatments,
            assessment_history: history
          });
        } catch (error) {
          console.error('❌ [RiskAPI] Error fetching risk:', error);
          return c.json({ error: 'Failed to fetch risk' }, 500);
        }
      };
    }
  },
  {
    path: "/api/risks",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createRisk, initRiskTables } = await import('../../utils/riskDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initRiskTables();
          
          const body = await c.req.json();
          logger?.info('📝 [RiskAPI] POST /api/risks', { title: body.risk_title, by: sessionUser.email });

          if (!body.risk_title || !body.risk_category || !body.impact_score || !body.likelihood_score) {
            return c.json({ error: 'Missing required fields: risk_title, risk_category, impact_score, likelihood_score' }, 400);
          }

          const risk = await createRisk({ ...body, identified_by: sessionUser.email });

          await logEvent({
            entityType: 'SYSTEM',
            entityId: risk.id!.toString(),
            actionType: 'CREATE',
            description: `New risk created: ${risk.risk_title}`,
            newValue: JSON.stringify(risk),
            userName: sessionUser.email,
            severity: risk.risk_level === 'critical' || risk.risk_level === 'high' ? 'WARNING' : 'INFO',
            module: 'risk_management',
            aiInvolved: body.ai_detected || false
          });

          logger?.info('✅ [RiskAPI] Risk created', { id: risk.id, level: risk.risk_level });
          return c.json({ success: true, risk });
        } catch (error) {
          console.error('❌ [RiskAPI] Error creating risk:', error);
          return c.json({ error: 'Failed to create risk' }, 500);
        }
      };
    }
  },
  {
    path: "/api/risks/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updateRisk, getRiskById, initRiskTables } = await import('../../utils/riskDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initRiskTables();
          
          const id = parseInt(c.req.param('id'));
          const body = await c.req.json();
          logger?.info('📝 [RiskAPI] PUT /api/risks/:id', { id, by: sessionUser.email });

          const existingRisk = await getRiskById(id);
          if (!existingRisk) {
            return c.json({ error: 'Risk not found' }, 404);
          }

          const updatedRisk = await updateRisk(id, body, sessionUser.email);

          await logEvent({
            entityType: 'SYSTEM',
            entityId: id.toString(),
            actionType: 'UPDATE',
            description: `Risk updated: ${updatedRisk.risk_title}`,
            oldValue: JSON.stringify(existingRisk),
            newValue: JSON.stringify(updatedRisk),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'risk_management'
          });

          logger?.info('✅ [RiskAPI] Risk updated', { id });
          return c.json({ success: true, risk: updatedRisk });
        } catch (error) {
          console.error('❌ [RiskAPI] Error updating risk:', error);
          return c.json({ error: 'Failed to update risk' }, 500);
        }
      };
    }
  },
  {
    path: "/api/risks/:id/treatment",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createTreatmentAction, getRiskById, initRiskTables } = await import('../../utils/riskDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initRiskTables();
          
          const riskId = parseInt(c.req.param('id'));
          const body = await c.req.json();
          logger?.info('📝 [RiskAPI] POST /api/risks/:id/treatment', { riskId, by: sessionUser.email });

          const risk = await getRiskById(riskId);
          if (!risk) {
            return c.json({ error: 'Risk not found' }, 404);
          }

          if (!body.action_title || !body.action_type || !body.assigned_to || !body.due_date) {
            return c.json({ error: 'Missing required fields: action_title, action_type, assigned_to, due_date' }, 400);
          }

          const action = await createTreatmentAction({
            risk_id: riskId,
            ...body,
            created_by: sessionUser.email
          });

          await logEvent({
            entityType: 'SYSTEM',
            entityId: action.id!.toString(),
            actionType: 'CREATE',
            description: `Treatment action created for risk: ${risk.risk_title}`,
            newValue: JSON.stringify(action),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'risk_management'
          });

          logger?.info('✅ [RiskAPI] Treatment action created', { actionId: action.id });
          return c.json({ success: true, action });
        } catch (error) {
          console.error('❌ [RiskAPI] Error creating treatment action:', error);
          return c.json({ error: 'Failed to create treatment action' }, 500);
        }
      };
    }
  },
  {
    path: "/api/risks/treatment/:actionId",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updateTreatmentAction, initRiskTables } = await import('../../utils/riskDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initRiskTables();
          
          const actionId = parseInt(c.req.param('actionId'));
          const body = await c.req.json();
          logger?.info('📝 [RiskAPI] PUT /api/risks/treatment/:actionId', { actionId, by: sessionUser.email });

          const updatedAction = await updateTreatmentAction(actionId, body);

          await logEvent({
            entityType: 'SYSTEM',
            entityId: actionId.toString(),
            actionType: 'UPDATE',
            description: `Treatment action updated: ${updatedAction.action_title}`,
            newValue: JSON.stringify(updatedAction),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'risk_management'
          });

          logger?.info('✅ [RiskAPI] Treatment action updated', { actionId });
          return c.json({ success: true, action: updatedAction });
        } catch (error) {
          console.error('❌ [RiskAPI] Error updating treatment action:', error);
          return c.json({ error: 'Failed to update treatment action' }, 500);
        }
      };
    }
  },
  {
    path: "/api/risks/:id/escalate",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { updateRisk, getRiskById, initRiskTables } = await import('../../utils/riskDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initRiskTables();
          
          const { getSessionUser, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const id = parseInt(c.req.param('id'));
          const body = await c.req.json();
          logger?.info('📝 [RiskAPI] POST /api/risks/:id/escalate', { id, by: sessionUser.email });

          const risk = await getRiskById(id);
          if (!risk) {
            return c.json({ error: 'Risk not found' }, 404);
          }

          const updatedRisk = await updateRisk(id, {
            status: 'escalated',
            escalation_reason: body.reason
          });

          await logEvent({
            entityType: 'SYSTEM',
            entityId: id.toString(),
            actionType: 'STATUS_CHANGE',
            description: `Risk escalated: ${risk.risk_title}. Reason: ${body.reason}`,
            oldValue: JSON.stringify({ status: risk.status }),
            newValue: JSON.stringify({ status: 'escalated', escalation_reason: body.reason }),
            userName: sessionUser.email,
            severity: 'CRITICAL',
            module: 'risk_management'
          });

          logger?.info('⚠️ [RiskAPI] Risk escalated', { id });
          return c.json({ success: true, risk: updatedRisk });
        } catch (error) {
          console.error('❌ [RiskAPI] Error escalating risk:', error);
          return c.json({ error: 'Failed to escalate risk' }, 500);
        }
      };
    }
  },
  {
    path: "/api/risks/:id/close",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse, forbiddenResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updateRisk, getRiskById, initRiskTables } = await import('../../utils/riskDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          const { checkPermission } = await import('../../utils/rbacDatabase');
          await initRiskTables();
          
          const id = parseInt(c.req.param('id'));
          const body = await c.req.json();
          logger?.info('📝 [RiskAPI] POST /api/risks/:id/close', { id, by: sessionUser.email });

          const hasPermission = await checkPermission(sessionUser.email, 'can_close_finding');
          if (!hasPermission) {
            return forbiddenResponse(c, 'Permission denied: cannot close risks');
          }

          const risk = await getRiskById(id);
          if (!risk) {
            return c.json({ error: 'Risk not found' }, 404);
          }

          const updatedRisk = await updateRisk(id, {
            status: 'closed'
          });

          await logEvent({
            entityType: 'SYSTEM',
            entityId: id.toString(),
            actionType: 'STATUS_CHANGE',
            description: `Risk closed: ${risk.risk_title}. Closure notes: ${body.closure_notes || 'N/A'}`,
            oldValue: JSON.stringify({ status: risk.status }),
            newValue: JSON.stringify({ status: 'closed' }),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'risk_management'
          });

          logger?.info('✅ [RiskAPI] Risk closed', { id });
          return c.json({ success: true, risk: updatedRisk });
        } catch (error) {
          console.error('❌ [RiskAPI] Error closing risk:', error);
          return c.json({ error: 'Failed to close risk' }, 500);
        }
      };
    }
  },
  {
    path: "/api/risks/:id/accept",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse, forbiddenResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updateRisk, getRiskById, initRiskTables } = await import('../../utils/riskDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          const { checkPermission, getUserByEmail, initRbacTables } = await import('../../utils/rbacDatabase');
          await initRiskTables();
          await initRbacTables();
          
          const id = parseInt(c.req.param('id'));
          const body = await c.req.json();
          const userEmail = sessionUser.email;
          logger?.info('🔐 [RiskAPI] POST /api/risks/:id/accept (RBAC enforcement)', { id, userEmail });

          if (!body.justification) {
            return c.json({ error: 'justification is required for risk acceptance' }, 400);
          }

          const user = await getUserByEmail(userEmail);
          if (!user) {
            logger?.warn('🚫 [RiskAPI] Risk acceptance blocked - user not registered in system', { userEmail });
            await logEvent({
              entityType: 'SYSTEM',
              entityId: id.toString(),
              actionType: 'UPDATE',
              description: `Risk acceptance BLOCKED: User ${userEmail} not found in system_users`,
              userName: userEmail,
              severity: 'WARNING',
              module: 'risk_management'
            });
            return c.json({ 
              error: 'User not found: You must be a registered system user to perform this action'
            }, 403);
          }

          if (!user.is_active) {
            logger?.warn('🚫 [RiskAPI] Risk acceptance blocked - user account inactive', { userEmail });
            return c.json({ 
              error: 'Account inactive: Your user account has been deactivated'
            }, 403);
          }

          const hasPermission = await checkPermission(userEmail, 'can_accept_risk');
          if (!hasPermission) {
            logger?.warn('🚫 [RiskAPI] Risk acceptance blocked - user lacks GRC permission', { userEmail, userRole: user.role });
            await logEvent({
              entityType: 'SYSTEM',
              entityId: id.toString(),
              actionType: 'UPDATE',
              description: `Risk acceptance BLOCKED: User ${userEmail} (role: ${user.role}) lacks GRC Manager permission`,
              userName: userEmail,
              severity: 'WARNING',
              module: 'risk_management'
            });
            return c.json({ 
              error: `Permission denied: Only GRC Manager or Admin role can accept risks. Your role (${user.role}) does not have this permission.`
            }, 403);
          }

          const risk = await getRiskById(id);
          if (!risk) {
            return c.json({ error: 'Risk not found' }, 404);
          }

          if (risk.status === 'closed') {
            return c.json({ error: 'Cannot accept a closed risk. Reopen it first.' }, 400);
          }

          if (risk.treatment_strategy === 'accept' && risk.accepted_at) {
            return c.json({ 
              error: 'Risk already accepted',
              accepted_by: risk.accepted_by,
              accepted_at: risk.accepted_at
            }, 400);
          }

          const updatedRisk = await updateRisk(id, {
            treatment_strategy: 'accept',
            status: 'monitoring',
            accepted_by: user.name,
            accepted_by_role: user.role,
            accepted_at: new Date(),
            acceptance_justification: body.justification
          });

          await logEvent({
            entityType: 'SYSTEM',
            entityId: id.toString(),
            actionType: 'STATUS_CHANGE',
            description: `Risk ACCEPTED by GRC Manager: ${risk.risk_title}. Justification: ${body.justification}`,
            oldValue: JSON.stringify({ status: risk.status, treatment_strategy: risk.treatment_strategy }),
            newValue: JSON.stringify({ status: 'monitoring', treatment_strategy: 'accept', accepted_by: user.name }),
            userName: userEmail,
            severity: 'CRITICAL',
            module: 'risk_management'
          });

          logger?.info('✅ [RiskAPI] Risk accepted by GRC Manager', { id, acceptedBy: user.name, role: user.role });
          return c.json({ 
            success: true, 
            risk: updatedRisk, 
            message: `Risk accepted successfully by ${user.name} (${user.role})`,
            accepted_by: user.name,
            accepted_by_role: user.role
          });
        } catch (error) {
          console.error('❌ [RiskAPI] Error accepting risk:', error);
          return c.json({ error: 'Failed to accept risk' }, 500);
        }
      };
    }
  }
];
