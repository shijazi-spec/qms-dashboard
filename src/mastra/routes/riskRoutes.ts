export const riskRoutes = [
  {
    path: "/api/risks/export",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { exportRisksCSV, initRiskTables } = await import('../../utils/riskDatabase');
          await initRiskTables();

          logger?.info('📊 [RiskAPI] GET /api/risks/export');
          const csv = await exportRisksCSV();
          return c.text(csv, 200, {
            'Content-Type': 'text/csv',
            'Content-Disposition': 'attachment; filename="risks_export.csv"'
          });
        } catch (error) {
          console.error('❌ [RiskAPI] Error exporting risks:', error);
          return c.json({ error: 'Failed to export risks' }, 500);
        }
      };
    }
  },
  {
    path: "/api/risks/export-xlsx",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        const { requireAdminOrKey, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
        if (!await requireAdminOrKey(c)) return unauthorizedResponse(c);
        const pg = await import("pg");
        const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
        try {
          const logger = mastra?.getLogger();
          const { initRiskTables } = await import('../../utils/riskDatabase');
          await initRiskTables();
          logger?.info('📊 [RiskAPI] GET /api/risks/export-xlsx');

          const risks = await pool.query(`
            SELECT id, risk_title, risk_description, risk_category, risk_source,
                   identified_date, identified_by, risk_owner, owner_department,
                   impact_score, likelihood_score, risk_score, risk_level,
                   treatment_strategy, treatment_owner, treatment_deadline,
                   residual_impact, residual_likelihood, residual_risk_score
            FROM enterprise_risks ORDER BY risk_score DESC, id LIMIT 10000
          `);
          const actions = await pool.query(`
            SELECT rta.risk_id, er.risk_title, rta.action_title, rta.action_description,
                   rta.action_type, rta.assigned_to, rta.due_date, rta.status,
                   rta.completion_date, rta.percent_complete, rta.evidence_required, rta.evidence_attached
            FROM risk_treatment_actions rta LEFT JOIN enterprise_risks er ON er.id = rta.risk_id
            ORDER BY rta.due_date ASC LIMIT 50000
          `);

          const { buildWorkbook, xlsxResponseHeaders } = await import('../../utils/excelExport');
          const fmt = (d: any) => d ? new Date(d).toISOString().substring(0, 10) : '';

          const byLevel = (l: string) => risks.rows.filter((r: any) => r.risk_level === l).length;
          const byCategory: Record<string, any[]> = {};
          for (const r of risks.rows) {
            const cat = r.risk_category || 'Uncategorised';
            (byCategory[cat] = byCategory[cat] || []).push(r);
          }

          const riskColumns = [
            { header: 'ID', key: 'id', width: 6 },
            { header: 'Title', key: 'risk_title', width: 40 },
            { header: 'Category', key: 'risk_category', width: 16 },
            { header: 'Source', key: 'risk_source', width: 20 },
            { header: 'Owner', key: 'risk_owner', width: 22 },
            { header: 'Department', key: 'owner_department', width: 18 },
            { header: 'Identified', key: 'identified_str', width: 14 },
            { header: 'Impact', key: 'impact_score', width: 8 },
            { header: 'Likelihood', key: 'likelihood_score', width: 12 },
            { header: 'Score', key: 'risk_score', width: 8 },
            { header: 'Level', key: 'risk_level', width: 10 },
            { header: 'Treatment', key: 'treatment_strategy', width: 14 },
            { header: 'Treatment Owner', key: 'treatment_owner', width: 22 },
            { header: 'Treatment Deadline', key: 'treatment_deadline_str', width: 18 },
            { header: 'Residual Score', key: 'residual_risk_score', width: 14 },
            { header: 'Description', key: 'risk_description', width: 50 },
          ];

          const enrich = (r: any) => ({
            ...r,
            identified_str: fmt(r.identified_date),
            treatment_deadline_str: fmt(r.treatment_deadline),
          });

          const sheets: any[] = [
            {
              name: 'Summary',
              columns: [{ header: 'Metric', key: 'metric', width: 32 }, { header: 'Value', key: 'value', width: 18 }],
              rows: [
                { metric: 'Total enterprise risks', value: risks.rows.length },
                { metric: 'Critical', value: byLevel('critical') },
                { metric: 'High', value: byLevel('high') },
                { metric: 'Medium', value: byLevel('medium') },
                { metric: 'Low', value: byLevel('low') },
                { metric: 'Treatment actions total', value: actions.rows.length },
                { metric: 'Actions overdue', value: actions.rows.filter((a: any) => a.due_date && a.status !== 'completed' && new Date(a.due_date) < new Date()).length },
                { metric: 'Categories', value: Object.keys(byCategory).length },
                { metric: 'Generated', value: new Date().toISOString() },
              ],
            },
            { name: 'All Risks', columns: riskColumns, rows: risks.rows.map(enrich) },
          ];

          for (const [cat, list] of Object.entries(byCategory)) {
            sheets.push({ name: cat, columns: riskColumns, rows: list.map(enrich) });
          }

          sheets.push({
            name: 'Treatment Actions',
            columns: [
              { header: 'Risk ID', key: 'risk_id', width: 8 },
              { header: 'Risk Title', key: 'risk_title', width: 36 },
              { header: 'Action Title', key: 'action_title', width: 36 },
              { header: 'Type', key: 'action_type', width: 14 },
              { header: 'Assigned To', key: 'assigned_to', width: 22 },
              { header: 'Due Date', key: 'due_date_str', width: 14 },
              { header: 'Status', key: 'status', width: 14 },
              { header: '% Complete', key: 'percent_complete', width: 12 },
              { header: 'Completion Date', key: 'completion_date_str', width: 16 },
              { header: 'Evidence Required', key: 'evidence_required_str', width: 18 },
              { header: 'Evidence Attached', key: 'evidence_attached_str', width: 18 },
              { header: 'Description', key: 'action_description', width: 40 },
            ],
            rows: actions.rows.map((a: any) => ({
              ...a,
              due_date_str: fmt(a.due_date),
              completion_date_str: fmt(a.completion_date),
              evidence_required_str: a.evidence_required ? 'Yes' : 'No',
              evidence_attached_str: a.evidence_attached ? 'Yes' : 'No',
            })),
          });

          const buf = await buildWorkbook(sheets, { title: 'Enterprise Risk Register Export' });
          return c.body(buf, 200, xlsxResponseHeaders(`risks_${Date.now()}.xlsx`));
        } catch (error) {
          console.error('❌ [RiskAPI] Error exporting risks XLSX:', error);
          return c.json({ error: 'Failed to export risks XLSX' }, 500);
        } finally { await pool.end(); }
      };
    }
  },
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
          const date_from = url.searchParams.get('date_from') || undefined;
          const date_to = url.searchParams.get('date_to') || undefined;
          const limit = parseInt(url.searchParams.get('limit') || '50');
          const offset = parseInt(url.searchParams.get('offset') || '0');

          logger?.info('📊 [RiskAPI] GET /api/risks', { status, category, risk_level, owner_department });

          const result = await getAllRisks({
            status, category, risk_level, owner_department, date_from, date_to, limit, offset
          });

          const { obfuscateResourceIdsList } = await import('../../utils/riskDatabase');
          return c.json({ risks: obfuscateResourceIdsList(result.risks), total: result.total });
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
          
          const { obfuscateResourceIdsList } = await import('../../utils/riskDatabase');
          return c.json({ 
            overdue_risks: obfuscateResourceIdsList(overdueRisks),
            overdue_actions: obfuscateResourceIdsList(overdueActions)
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
          const { getRiskById, getRiskByPublicId, resolveRiskId, getTreatmentActions, getRiskAssessmentHistory, initRiskTables } = await import('../../utils/riskDatabase');
          await initRiskTables();
          
          const idParam = c.req.param('id');
          const resolved = resolveRiskId(idParam);
          logger?.info('📊 [RiskAPI] GET /api/risks/:id', { idParam });

          const risk = resolved.isUUID
            ? await getRiskByPublicId(resolved.uuid!)
            : await getRiskById(resolved.intId!);
          if (!risk) {
            return c.json({ error: 'Risk not found' }, 404);
          }

          const id = risk.id!;
          const [treatments, history] = await Promise.all([
            getTreatmentActions(id),
            getRiskAssessmentHistory(id)
          ]);

          const { obfuscateResourceIds, obfuscateResourceIdsList } = await import('../../utils/riskDatabase');
          return c.json({ 
            risk: obfuscateResourceIds(risk), 
            treatments: obfuscateResourceIdsList(treatments),
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
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createRisk, initRiskTables } = await import('../../utils/riskDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initRiskTables();
          
          const body = await c.req.json();
          logger?.info('📝 [RiskAPI] POST /api/risks', { title: body.risk_title, by: sessionUser.email });

          if (!body.risk_title || !body.risk_category || !body.impact_score || !body.likelihood_score) {
            return c.json({ error: 'Missing required fields' }, 400);
          }

          const risk = await createRisk({ ...body, identified_by: sessionUser.email });

          await logEvent({
            entityType: 'SYSTEM',
            entityId: (risk.public_id || risk.id!).toString(),
            actionType: 'CREATE',
            description: `New risk created: ${risk.risk_title}`,
            newValue: JSON.stringify(risk),
            userName: sessionUser.email,
            severity: risk.risk_level === 'critical' || risk.risk_level === 'high' ? 'WARNING' : 'INFO',
            module: 'risk_management',
            aiInvolved: body.ai_detected || false
          });

          const { obfuscateResourceIds } = await import('../../utils/riskDatabase');
          logger?.info('✅ [RiskAPI] Risk created', { id: risk.public_id, level: risk.risk_level });
          return c.json({ success: true, risk: obfuscateResourceIds(risk) });
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
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updateRisk, getRiskById, getRiskByPublicId, resolveRiskId, obfuscateResourceIds, initRiskTables } = await import('../../utils/riskDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initRiskTables();
          
          const idParam = c.req.param('id');
          const resolved = resolveRiskId(idParam);
          const body = await c.req.json();
          logger?.info('📝 [RiskAPI] PUT /api/risks/:id', { idParam, by: sessionUser.email });

          const existingRisk = resolved.isUUID
            ? await getRiskByPublicId(resolved.uuid!)
            : await getRiskById(resolved.intId!);
          if (!existingRisk) {
            return c.json({ error: 'Risk not found' }, 404);
          }

          const id = existingRisk.id!;

          if (body.status && body.status !== existingRisk.status) {
            return c.json({ error: 'Status changes are not allowed via generic update. Use the dedicated /close, /accept, or /escalate endpoints.' }, 400);
          }
          const { status, ...safeBody } = body;

          const updatedRisk = await updateRisk(id, safeBody, sessionUser.email);

          await logEvent({
            entityType: 'SYSTEM',
            entityId: (existingRisk.public_id || id).toString(),
            actionType: 'UPDATE',
            description: `Risk updated: ${updatedRisk.risk_title}`,
            oldValue: JSON.stringify(existingRisk),
            newValue: JSON.stringify(updatedRisk),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'risk_management'
          });

          logger?.info('✅ [RiskAPI] Risk updated', { id: existingRisk.public_id });
          return c.json({ success: true, risk: obfuscateResourceIds(updatedRisk) });
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
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createTreatmentAction, getRiskById, getRiskByPublicId, resolveRiskId, obfuscateResourceIds, initRiskTables } = await import('../../utils/riskDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initRiskTables();
          
          const idParam = c.req.param('id');
          const resolved = resolveRiskId(idParam);
          const body = await c.req.json();
          logger?.info('📝 [RiskAPI] POST /api/risks/:id/treatment', { idParam, by: sessionUser.email });

          const risk = resolved.isUUID
            ? await getRiskByPublicId(resolved.uuid!)
            : await getRiskById(resolved.intId!);
          if (!risk) {
            return c.json({ error: 'Risk not found' }, 404);
          }

          const riskId = risk.id!;

          if (!body.action_title || !body.action_type || !body.assigned_to || !body.due_date) {
            return c.json({ error: 'Missing required fields' }, 400);
          }

          const action = await createTreatmentAction({
            risk_id: riskId,
            ...body,
            created_by: sessionUser.email
          });

          await logEvent({
            entityType: 'SYSTEM',
            entityId: (action.public_id || action.id!).toString(),
            actionType: 'CREATE',
            description: `Treatment action created for risk: ${risk.risk_title}`,
            newValue: JSON.stringify(action),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'risk_management'
          });

          logger?.info('✅ [RiskAPI] Treatment action created', { actionId: action.public_id });
          return c.json({ success: true, action: obfuscateResourceIds(action) });
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
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updateTreatmentAction, resolveRiskId, obfuscateResourceIds, initRiskTables } = await import('../../utils/riskDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initRiskTables();
          
          const actionIdParam = c.req.param('actionId');
          const resolved = resolveRiskId(actionIdParam);
          const body = await c.req.json();
          logger?.info('📝 [RiskAPI] PUT /api/risks/treatment/:actionId', { actionIdParam, by: sessionUser.email });

          let actionId: number;
          if (resolved.isUUID) {
            const { getTreatmentActionByPublicId } = await import('../../utils/riskDatabase');
            const action = await getTreatmentActionByPublicId(resolved.uuid!);
            if (!action) {
              return c.json({ error: 'Treatment action not found' }, 404);
            }
            actionId = action.id!;
          } else {
            actionId = resolved.intId!;
          }

          const updatedAction = await updateTreatmentAction(actionId, body);

          await logEvent({
            entityType: 'SYSTEM',
            entityId: (updatedAction.public_id || actionId).toString(),
            actionType: 'UPDATE',
            description: `Treatment action updated: ${updatedAction.action_title}`,
            newValue: JSON.stringify(updatedAction),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'risk_management'
          });

          logger?.info('✅ [RiskAPI] Treatment action updated', { actionId: updatedAction.public_id });
          return c.json({ success: true, action: obfuscateResourceIds(updatedAction) });
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
          const { updateRisk, getRiskById, getRiskByPublicId, resolveRiskId, obfuscateResourceIds, initRiskTables } = await import('../../utils/riskDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initRiskTables();
          
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const idParam = c.req.param('id');
          const resolved = resolveRiskId(idParam);
          const body = await c.req.json();
          logger?.info('📝 [RiskAPI] POST /api/risks/:id/escalate', { idParam, by: sessionUser.email });

          const risk = resolved.isUUID
            ? await getRiskByPublicId(resolved.uuid!)
            : await getRiskById(resolved.intId!);
          if (!risk) {
            return c.json({ error: 'Risk not found' }, 404);
          }

          const id = risk.id!;
          const updatedRisk = await updateRisk(id, {
            status: 'escalated',
            escalation_reason: body.reason
          });

          await logEvent({
            entityType: 'SYSTEM',
            entityId: (risk.public_id || id).toString(),
            actionType: 'STATUS_CHANGE',
            description: `Risk escalated: ${risk.risk_title}. Reason: ${body.reason}`,
            oldValue: JSON.stringify({ status: risk.status }),
            newValue: JSON.stringify({ status: 'escalated', escalation_reason: body.reason }),
            userName: sessionUser.email,
            severity: 'CRITICAL',
            module: 'risk_management'
          });

          logger?.info('⚠️ [RiskAPI] Risk escalated', { id: risk.public_id });
          return c.json({ success: true, risk: obfuscateResourceIds(updatedRisk) });
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
          const { requireWriteRole, unauthorizedResponse, forbiddenResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updateRisk, getRiskById, getRiskByPublicId, resolveRiskId, obfuscateResourceIds, getTreatmentActions, initRiskTables } = await import('../../utils/riskDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          const { checkPermission } = await import('../../utils/rbacDatabase');
          await initRiskTables();
          
          const idParam = c.req.param('id');
          const resolved = resolveRiskId(idParam);
          const body = await c.req.json();
          logger?.info('📝 [RiskAPI] POST /api/risks/:id/close', { idParam, by: sessionUser.email });

          const hasPermission = await checkPermission(sessionUser.email, 'can_close_finding');
          if (!hasPermission) {
            return forbiddenResponse(c, 'Permission denied: cannot close risks');
          }

          const risk = resolved.isUUID
            ? await getRiskByPublicId(resolved.uuid!)
            : await getRiskById(resolved.intId!);
          if (!risk) {
            return c.json({ error: 'Risk not found' }, 404);
          }

          const id = risk.id!;
          const treatments = await getTreatmentActions(id);
          if (!treatments || treatments.length === 0) {
            return c.json({ error: 'Cannot close risk: at least one treatment action must exist before closure' }, 400);
          }

          const updatedRisk = await updateRisk(id, {
            status: 'closed'
          });

          await logEvent({
            entityType: 'SYSTEM',
            entityId: (risk.public_id || id).toString(),
            actionType: 'STATUS_CHANGE',
            description: `Risk closed: ${risk.risk_title}. Closure notes: ${body.closure_notes || 'N/A'}`,
            oldValue: JSON.stringify({ status: risk.status }),
            newValue: JSON.stringify({ status: 'closed' }),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'risk_management'
          });

          logger?.info('✅ [RiskAPI] Risk closed', { id: risk.public_id });
          return c.json({ success: true, risk: obfuscateResourceIds(updatedRisk) });
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
          const { requireWriteRole, unauthorizedResponse, forbiddenResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updateRisk, getRiskById, getRiskByPublicId, resolveRiskId, obfuscateResourceIds, initRiskTables } = await import('../../utils/riskDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          const { checkPermission, getUserByEmail, initRbacTables } = await import('../../utils/rbacDatabase');
          await initRiskTables();
          await initRbacTables();
          
          const idParam = c.req.param('id');
          const resolved = resolveRiskId(idParam);
          const body = await c.req.json();
          const userEmail = sessionUser.email;
          logger?.info('🔐 [RiskAPI] POST /api/risks/:id/accept (RBAC enforcement)', { idParam, userEmail });

          if (!body.justification) {
            return c.json({ error: 'Missing required fields' }, 400);
          }

          const user = await getUserByEmail(userEmail);
          if (!user) {
            logger?.warn('🚫 [RiskAPI] Risk acceptance blocked - user not registered in system', { userEmail });
            await logEvent({
              entityType: 'SYSTEM',
              entityId: idParam,
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
              entityId: idParam,
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

          const risk = resolved.isUUID
            ? await getRiskByPublicId(resolved.uuid!)
            : await getRiskById(resolved.intId!);
          if (!risk) {
            return c.json({ error: 'Risk not found' }, 404);
          }

          const id = risk.id!;

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
            entityId: (risk.public_id || id).toString(),
            actionType: 'STATUS_CHANGE',
            description: `Risk ACCEPTED by GRC Manager: ${risk.risk_title}. Justification: ${body.justification}`,
            oldValue: JSON.stringify({ status: risk.status, treatment_strategy: risk.treatment_strategy }),
            newValue: JSON.stringify({ status: 'monitoring', treatment_strategy: 'accept', accepted_by: user.name }),
            userName: userEmail,
            severity: 'CRITICAL',
            module: 'risk_management'
          });

          logger?.info('✅ [RiskAPI] Risk accepted by GRC Manager', { id: risk.public_id, acceptedBy: user.name, role: user.role });
          return c.json({ 
            success: true, 
            risk: obfuscateResourceIds(updatedRisk), 
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
