import pg from 'pg';
import { redactSecretLikeStrings } from './eventLogsDatabase';

const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let tableReady: Promise<void> | null = null;

export async function initAIFeedbackTable(): Promise<void> {
  if (tableReady) return tableReady;
  tableReady = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ai_response_feedback (
          id            SERIAL PRIMARY KEY,
          message_id    TEXT NOT NULL,
          conversation_id TEXT,
          agent         TEXT NOT NULL DEFAULT 'qmsConsultantAgent',
          rating        TEXT NOT NULL CHECK (rating IN ('up','down')),
          category      TEXT,
          comment       TEXT,
          user_id       TEXT,
          user_email    TEXT,
          prompt_preview TEXT,
          response_preview TEXT,
          tools_called  TEXT,
          created_at    TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ai_feedback_message_id ON ai_response_feedback(message_id);
        CREATE INDEX IF NOT EXISTS idx_ai_feedback_created_at ON ai_response_feedback(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_feedback_rating     ON ai_response_feedback(rating);
        CREATE INDEX IF NOT EXISTS idx_ai_feedback_agent      ON ai_response_feedback(agent);
      `);
      await pool.query(`
        ALTER TABLE ai_response_feedback ADD COLUMN IF NOT EXISTS tools_called TEXT;
      `);
    } catch (err) {
      tableReady = null;
      throw err;
    }
  })();
  return tableReady;
}

function safeRedactPreview(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const redacted = redactSecretLikeStrings(text.substring(0, 500));
  return typeof redacted === 'string' ? redacted : text.substring(0, 500);
}

export interface FeedbackRecord {
  message_id: string;
  conversation_id?: string;
  agent?: string;
  rating: 'up' | 'down';
  category?: string;
  comment?: string;
  user_id?: string;
  user_email?: string;
  prompt_preview?: string;
  response_preview?: string;
  tools_called?: string;
}

export async function saveFeedback(fb: FeedbackRecord): Promise<{ id: number }> {
  await initAIFeedbackTable();

  // upsert: one rating per message per user
  const existing = await pool.query(
    `SELECT id FROM ai_response_feedback WHERE message_id=$1 AND (user_id=$2 OR user_email=$3) LIMIT 1`,
    [fb.message_id, fb.user_id || null, fb.user_email || null]
  );

  const redactedPrompt = safeRedactPreview(fb.prompt_preview);
  const redactedResponse = safeRedactPreview(fb.response_preview);

  if (existing.rows[0]) {
    const res = await pool.query(
      `UPDATE ai_response_feedback
          SET rating=$1, category=$2, comment=$3,
              prompt_preview=$4, response_preview=$5,
              tools_called=COALESCE($6, tools_called), created_at=NOW()
        WHERE id=$7
        RETURNING id`,
      [fb.rating, fb.category || null, fb.comment || null,
       redactedPrompt || null, redactedResponse || null,
       fb.tools_called || null, existing.rows[0].id]
    );
    return { id: res.rows[0].id };
  }

  const res = await pool.query(
    `INSERT INTO ai_response_feedback
       (message_id, conversation_id, agent, rating, category, comment,
        user_id, user_email, prompt_preview, response_preview, tools_called)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      fb.message_id,
      fb.conversation_id || null,
      fb.agent || 'qmsConsultantAgent',
      fb.rating,
      fb.category || null,
      fb.comment || null,
      fb.user_id || null,
      fb.user_email || null,
      redactedPrompt || null,
      redactedResponse || null,
      fb.tools_called ? fb.tools_called.substring(0, 1000) : null,
    ]
  );
  return { id: res.rows[0].id };
}

export interface FeedbackStats {
  total: number;
  thumbs_up: number;
  thumbs_down: number;
  thumbs_up_ratio: number;
  feedback_rate_estimate: number;
  top_categories: { category: string; count: number }[];
}

export async function getFeedbackStats(days = 30): Promise<FeedbackStats> {
  await initAIFeedbackTable();

  const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));

  const totals = await pool.query(
    `SELECT
       COUNT(*)                                                  AS total,
       COUNT(*) FILTER (WHERE rating='up')                      AS thumbs_up,
       COUNT(*) FILTER (WHERE rating='down')                    AS thumbs_down
     FROM ai_response_feedback
     WHERE created_at >= NOW() - make_interval(days => $1)`,
    [safeDays]
  );

  const cats = await pool.query(
    `SELECT category, COUNT(*) AS cnt
     FROM ai_response_feedback
     WHERE rating='down'
       AND category IS NOT NULL
       AND created_at >= NOW() - make_interval(days => $1)
     GROUP BY category
     ORDER BY cnt DESC
     LIMIT 6`,
    [safeDays]
  );

  const total = parseInt(totals.rows[0].total) || 0;
  const up = parseInt(totals.rows[0].thumbs_up) || 0;
  const down = parseInt(totals.rows[0].thumbs_down) || 0;

  return {
    total,
    thumbs_up: up,
    thumbs_down: down,
    thumbs_up_ratio: total > 0 ? Math.round((up / total) * 100) : 0,
    feedback_rate_estimate: 0,
    top_categories: cats.rows.map(r => ({ category: r.category, count: parseInt(r.cnt) })),
  };
}

export interface RecentThumbsDown {
  id: number;
  message_id: string;
  conversation_id: string | null;
  category: string | null;
  comment: string | null;
  user_email: string | null;
  prompt_preview: string | null;
  response_preview: string | null;
  tools_called: string | null;
  created_at: string;
}

export async function getRecentThumbsDown(limit = 20): Promise<RecentThumbsDown[]> {
  await initAIFeedbackTable();

  const res = await pool.query(
    `SELECT id, message_id, conversation_id, category, comment,
            user_email, prompt_preview, response_preview, tools_called, created_at
     FROM ai_response_feedback
     WHERE rating = 'down'
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.min(100, limit)]
  );
  return res.rows;
}

export interface FeedbackTrendPoint {
  day: string;
  thumbs_up: number;
  thumbs_down: number;
}

export async function getFeedbackTrend(days = 30): Promise<FeedbackTrendPoint[]> {
  await initAIFeedbackTable();

  const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));

  const res = await pool.query(
    `SELECT
       TO_CHAR(DATE(created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
       COUNT(*) FILTER (WHERE rating = 'up')   AS thumbs_up,
       COUNT(*) FILTER (WHERE rating = 'down') AS thumbs_down
     FROM ai_response_feedback
     WHERE created_at >= NOW() - make_interval(days => $1)
     GROUP BY DATE(created_at AT TIME ZONE 'UTC')
     ORDER BY day ASC`,
    [safeDays]
  );

  return res.rows.map(r => ({
    day: r.day,
    thumbs_up: parseInt(r.thumbs_up) || 0,
    thumbs_down: parseInt(r.thumbs_down) || 0,
  }));
}

export async function getWeeklyFeedbackDigest(): Promise<{
  period: string;
  total: number;
  thumbs_up: number;
  thumbs_down: number;
  thumbs_up_pct: number;
  top_categories: { category: string; count: number }[];
  sample_down: { category: string | null; comment: string | null }[];
}> {
  await initAIFeedbackTable();

  const totals = await pool.query(
    `SELECT
       COUNT(*)                                    AS total,
       COUNT(*) FILTER (WHERE rating='up')         AS up,
       COUNT(*) FILTER (WHERE rating='down')       AS down
     FROM ai_response_feedback
     WHERE created_at >= NOW() - INTERVAL '7 days'`
  );

  const cats = await pool.query(
    `SELECT category, COUNT(*) AS cnt
     FROM ai_response_feedback
     WHERE rating='down' AND category IS NOT NULL
       AND created_at >= NOW() - INTERVAL '7 days'
     GROUP BY category ORDER BY cnt DESC LIMIT 5`
  );

  const samples = await pool.query(
    `SELECT category, comment
     FROM ai_response_feedback
     WHERE rating='down'
       AND created_at >= NOW() - INTERVAL '7 days'
     ORDER BY created_at DESC
     LIMIT 5`
  );

  const total = parseInt(totals.rows[0].total) || 0;
  const up = parseInt(totals.rows[0].up) || 0;
  const down = parseInt(totals.rows[0].down) || 0;
  const now = new Date();
  const weekStart = new Date(now.getTime() - 7 * 86400000);

  return {
    period: `${weekStart.toDateString()} – ${now.toDateString()}`,
    total,
    thumbs_up: up,
    thumbs_down: down,
    thumbs_up_pct: total > 0 ? Math.round((up / total) * 100) : 0,
    top_categories: cats.rows.map(r => ({ category: r.category, count: parseInt(r.cnt) })),
    sample_down: samples.rows,
  };
}
