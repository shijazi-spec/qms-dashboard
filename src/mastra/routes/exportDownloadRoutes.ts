import pg from 'pg';
const { Pool } = pg;
import { getSessionUser, unauthorizedResponse } from '../../utils/rbacMiddleware';
import { logger } from '../../utils/logger';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_recent_downloads (
      user_id INTEGER PRIMARY KEY,
      entries  JSONB    NOT NULL DEFAULT '[]',
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  tableReady = true;
}

export const exportDownloadRoutes = [
  {
    path: '/api/exports/recent-downloads',
    method: 'GET' as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!user.userId) return c.json({ entries: [] });
        try {
          await ensureTable();
          const result = await pool.query(
            'SELECT entries FROM user_recent_downloads WHERE user_id = $1',
            [user.userId]
          );
          const entries = result.rows.length > 0 ? result.rows[0].entries : [];
          return c.json({ entries });
        } catch (error) {
          logger.error({ err: error }, '[ExportDownloads] GET error');
          return c.json({ entries: [] });
        }
      };
    },
  },
  {
    path: '/api/exports/recent-downloads',
    method: 'POST' as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!user.userId) return c.json({ success: true });
        try {
          const body = await c.req.json();
          const entries = Array.isArray(body.entries) ? body.entries : [];
          await ensureTable();
          await pool.query(
            `INSERT INTO user_recent_downloads (user_id, entries, updated_at)
             VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (user_id) DO UPDATE
             SET entries = $2::jsonb, updated_at = NOW()`,
            [user.userId, JSON.stringify(entries)]
          );
          return c.json({ success: true });
        } catch (error) {
          logger.error({ err: error }, '[ExportDownloads] POST error');
          return c.json({ error: 'Failed to save recent downloads' }, 500);
        }
      };
    },
  },
  {
    path: '/api/exports/recent-downloads',
    method: 'DELETE' as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!user.userId) return c.json({ success: true });
        try {
          await ensureTable();
          await pool.query(
            'DELETE FROM user_recent_downloads WHERE user_id = $1',
            [user.userId]
          );
          return c.json({ success: true });
        } catch (error) {
          logger.error({ err: error }, '[ExportDownloads] DELETE error');
          return c.json({ error: 'Failed to clear recent downloads' }, 500);
        }
      };
    },
  },
];
