import { Hono } from 'hono';
import { getDashboardData, getLatestAuditResult, getAuditHistory, getActiveGovernanceDocument, getActiveScorecard } from '../../utils/database';
import { serveStatic } from 'hono/bun';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface DashboardDeps {
  getDashboardData: () => Promise<unknown>;
  getLatestAuditResult: () => Promise<unknown>;
  getAuditHistory: (limit: number) => Promise<unknown>;
  getActiveGovernanceDocument: () => Promise<unknown>;
  getActiveScorecard: () => Promise<unknown>;
}

const defaultDeps: DashboardDeps = {
  getDashboardData,
  getLatestAuditResult,
  getAuditHistory,
  getActiveGovernanceDocument,
  getActiveScorecard,
};

export function createDashboardRoutes(deps: DashboardDeps = defaultDeps) {
  const app = new Hono();

  app.get('/dashboard', async (c) => {
    try {
      const data = await deps.getDashboardData();
      return c.json(data);
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
      return c.json({ error: 'Failed to fetch dashboard data' }, 500);
    }
  });

  app.get('/audit/latest', async (c) => {
    try {
      const result = await deps.getLatestAuditResult();
      if (!result) {
        return c.json({ message: 'No audit results found' }, 404);
      }
      return c.json(result);
    } catch (error) {
      console.error('Error fetching latest audit:', error);
      return c.json({ error: 'Failed to fetch latest audit' }, 500);
    }
  });

  app.get('/audit/history', async (c) => {
    try {
      const limit = parseInt(c.req.query('limit') || '20');
      const history = await deps.getAuditHistory(limit);
      return c.json(history);
    } catch (error) {
      console.error('Error fetching audit history:', error);
      return c.json({ error: 'Failed to fetch audit history' }, 500);
    }
  });

  app.get('/governance', async (c) => {
    try {
      const doc = await deps.getActiveGovernanceDocument();
      if (!doc) {
        return c.json({ message: 'No governance document found' }, 404);
      }
      return c.json(doc);
    } catch (error) {
      console.error('Error fetching governance document:', error);
      return c.json({ error: 'Failed to fetch governance document' }, 500);
    }
  });

  app.get('/scorecard', async (c) => {
    try {
      const scorecard = await deps.getActiveScorecard();
      if (!scorecard) {
        return c.json({ message: 'No scorecard found' }, 404);
      }
      return c.json(scorecard);
    } catch (error) {
      console.error('Error fetching scorecard:', error);
      return c.json({ error: 'Failed to fetch scorecard' }, 500);
    }
  });

  app.post('/audit/trigger', async (c) => {
    try {
      const workflowBaseUrl = process.env.MASTRA_WORKFLOW_BASE_URL ?? 'http://localhost:5000';
      const workflowUrl = `${workflowBaseUrl}/api/workflows/quality-audit-workflow/start-async`;
      const response = await fetch(workflowUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputData: {} })
      });
      
      if (response.ok) {
        return c.json({ success: true, message: 'Audit triggered successfully' });
      } else {
        return c.json({ success: false, message: 'Failed to trigger audit' }, 500);
      }
    } catch (error) {
      console.error('Error triggering audit:', error);
      return c.json({ error: 'Failed to trigger audit' }, 500);
    }
  });

  return app;
}
