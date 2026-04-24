import pg from 'pg';
const { Pool } = pg;
import { getSessionFromCookie } from './authRoutes';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SUPPORTED_LANGS = ['en', 'ar'];

async function ensureLangColumn(): Promise<void> {
  try {
    await pool.query(
      `ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS ui_language VARCHAR(10) DEFAULT 'en'`
    );
  } catch (_) {}
}

export const i18nRoutes = [
  {
    path: '/api/user/language-preference',
    method: 'GET' as const,
    createHandler: async () => {
      return async (c: any) => {
        const session = getSessionFromCookie(c.req.header('Cookie'));
        if (!session) {
          return c.json({ lang: null });
        }
        try {
          await ensureLangColumn();
          const result = await pool.query(
            'SELECT ui_language FROM platform_users WHERE id = $1',
            [session.userId]
          );
          const lang = result.rows[0]?.ui_language || 'en';
          return c.json({ lang: SUPPORTED_LANGS.includes(lang) ? lang : 'en' });
        } catch {
          return c.json({ lang: 'en' });
        }
      };
    },
  },
  {
    path: '/api/user/language-preference',
    method: 'POST' as const,
    createHandler: async () => {
      return async (c: any) => {
        const session = getSessionFromCookie(c.req.header('Cookie'));
        let body: any = {};
        try { body = await c.req.json(); } catch (_) {}
        const lang = body?.lang;
        if (!lang || !SUPPORTED_LANGS.includes(lang)) {
          return c.json({ error: 'Unsupported language' }, 400);
        }
        if (!session) {
          return c.json({ success: true, lang });
        }
        try {
          await ensureLangColumn();
          await pool.query(
            'UPDATE platform_users SET ui_language = $1 WHERE id = $2',
            [lang, session.userId]
          );
        } catch (err) {
          return c.json({ error: 'Failed to persist language preference' }, 500);
        }
        return c.json({ success: true, lang });
      };
    },
  },
];
