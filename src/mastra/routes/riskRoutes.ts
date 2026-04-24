export const riskRoutes = [
  {
    path: "/api/risks/export",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { initRiskTables } = await import('../../utils/riskDatabase');
          await initRiskTables();
          logger?.info('📊 [RiskAPI] GET /api/risks/export');

          const pg = await import("pg");
          const localPool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
          const { escapeCSVValue } = await import('../../utils/inputSanitizer');
          const { streamCsv, cursorQuery } = await import('../../utils/excelExport');
          const headers = ['Public ID','Title','Category','Source','Identified Date','Identified By','Owner','Department','Impact','Likelihood','Score','Level','Treatment','Status','Created','Updated'];
          const cols = ['public_id','risk_title','risk_category','risk_source','identified_date','identified_by',
                        'risk_owner','owner_department','impact_score','likelihood_score','risk_score','risk_level',
                        'treatment_strategy','status','created_at','updated_at'];
          const source = cursorQuery(
            localPool,
            `SELECT ${cols.join(',')} FROM enterprise_risks ORDER BY created_at DESC`
          );
          const mappedRows = (async function* () {
            try {
              for await (const r of source) {
                yield cols.map(k => escapeCSVValue(String((r as Record<string, unknown>)[k] ?? '')));
              }
            } finally {
              await localPool.end();
            }
          })();
          return streamCsv(`risks_${Date.now()}.csv`, headers, mappedRows);
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

          const { streamXlsx, cursorQuery } = await import('../../utils/excelExport');

          // Aggregate summary stats and distinct categories — small results
          const [rTotR, rLevR, aTotR, aOvR, catsR] = await Promise.all([
            pool.query(`SELECT COUNT(*)::int AS total FROM enterprise_risks`),
            pool.query(`SELECT risk_level, COUNT(*)::int AS cnt FROM enterprise_risks GROUP BY risk_level`),
            pool.query(`SELECT COUNT(*)::int AS total FROM risk_treatment_actions`),
            pool.query(`SELECT COUNT(*)::int AS cnt FROM risk_treatment_actions WHERE due_date IS NOT NULL AND status != 'completed' AND due_date < NOW()`),
            pool.query(`SELECT DISTINCT COALESCE(risk_category, 'Uncategorised') AS cat FROM enterprise_risks ORDER BY cat`),
          ]);
          const rTotal  = rTotR.rows[0]?.total ?? 0;
          const rByLev  = (l: string) => rLevR.rows.find(r => r.risk_level === l)?.cnt ?? 0;
          const aTotal  = aTotR.rows[0]?.total ?? 0;
          const aOverdue = aOvR.rows[0]?.cnt ?? 0;
          const categories = catsR.rows.map(r => r.cat as string);

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

          const riskSql = `
            SELECT id, risk_title, risk_description, risk_category, risk_source, identified_by,
                   risk_owner, owner_department, impact_score, likelihood_score, risk_score, risk_level,
                   treatment_strategy, treatment_owner, residual_impact, residual_likelihood, residual_risk_score,
                   TO_CHAR(identified_date, 'YYYY-MM-DD')     AS identified_str,
                   TO_CHAR(treatment_deadline, 'YYYY-MM-DD')  AS treatment_deadline_str
            FROM enterprise_risks`;

          // All Risks sheet — server-side cursor, O(1) RSS, O(n) DB cost
          const allRisksSource = cursorQuery(pool,
            `${riskSql} ORDER BY risk_score DESC, id`
          );
          const allRisksRows = (async function* () {
            for await (const r of allRisksSource) yield r as Record<string, unknown>;
          })();

          const sheets: Array<{ name: string; columns: typeof riskColumns; rows: AsyncIterable<Record<string,unknown>> | Array<Record<string,unknown>> }> = [
            {
              name: 'Summary',
              columns: [{ header: 'Metric', key: 'metric', width: 32 }, { header: 'Value', key: 'value', width: 18 }],
              rows: [
                { metric: 'Total enterprise risks', value: rTotal },
                { metric: 'Critical', value: rByLev('critical') },
                { metric: 'High', value: rByLev('high') },
                { metric: 'Medium', value: rByLev('medium') },
                { metric: 'Low', value: rByLev('low') },
                { metric: 'Treatment actions total', value: aTotal },
                { metric: 'Actions overdue', value: aOverdue },
                { metric: 'Categories', value: categories.length },
                { metric: 'Generated', value: new Date().toISOString() },
              ],
            },
            { name: 'All Risks', columns: riskColumns, rows: allRisksRows },
          ];

          // Per-category sheets — one server-side cursor per category, no full materialisation
          for (const cat of categories) {
            const catSource = cursorQuery(pool,
              `${riskSql} WHERE COALESCE(risk_category, 'Uncategorised') = $1 ORDER BY risk_score DESC, id`,
              [cat]
            );
            const catRows = (async function* () {
              for await (const r of catSource) yield r as Record<string, unknown>;
            })();
            sheets.push({ name: cat, columns: riskColumns, rows: catRows });
          }

          // Treatment Actions sheet — server-side cursor, closes pool when done
          const actSource = cursorQuery(pool, `
            SELECT rta.risk_id, er.risk_title, rta.action_title, rta.action_description,
                   rta.action_type, rta.assigned_to, rta.status, rta.percent_complete,
                   TO_CHAR(rta.due_date, 'YYYY-MM-DD')        AS due_date_str,
                   TO_CHAR(rta.completion_date, 'YYYY-MM-DD') AS completion_date_str,
                   CASE WHEN rta.evidence_required THEN 'Yes' ELSE 'No' END AS evidence_required_str,
                   CASE WHEN rta.evidence_attached THEN 'Yes' ELSE 'No' END AS evidence_attached_str
            FROM risk_treatment_actions rta
            LEFT JOIN enterprise_risks er ON er.id = rta.risk_id
            ORDER BY rta.due_date ASC`
          );
          const actRows = (async function* () {
            try { for await (const r of actSource) yield r as Record<string, unknown>; }
            finally { await pool.end(); }
          })();

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
            rows: actRows,
          });

          return await streamXlsx(sheets, `risks_${Date.now()}.xlsx`, { title: 'Enterprise Risk Register Export' });
        } catch (error) {
          console.error('❌ [RiskAPI] Error exporting risks XLSX:', error);
          await pool.end();
          return c.json({ error: 'Failed to export risks XLSX' }, 500);
        }
        // pool is closed by the Treatment Actions sheet generator's finally block after full stream
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
