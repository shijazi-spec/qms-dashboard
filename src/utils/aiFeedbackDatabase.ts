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

export async function getFeedbackByMessageId(
  messageId: string,
  userId?: string,
  userEmail?: string,
): Promise<{ rating: 'up' | 'down'; category: string | null; comment: string | null } | null> {
  await initAIFeedbackTable();
  const res = await pool.query(
    `SELECT rating, category, comment
     FROM ai_response_feedback
     WHERE message_id = $1
       AND ($2::text IS NULL OR user_id = $2 OR user_email = $3)
     ORDER BY created_at DESC
     LIMIT 1`,
    [messageId, userId ?? null, userEmail ?? null]
  );
  if (!res.rows[0]) return null;
  return {
    rating: res.rows[0].rating as 'up' | 'down',
    category: res.rows[0].category ?? null,
    comment: res.rows[0].comment ?? null,
  };
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

export async function getFeedbackTrend(
  days = 30,
  agent?: string | null,
): Promise<FeedbackTrendPoint[]> {
  await initAIFeedbackTable();

  const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
  const agentFilter = agent && typeof agent === 'string' && agent.trim()
    ? agent.trim().substring(0, 100)
    : null;

  const params: (number | string)[] = [safeDays];
  let agentClause = '';
  if (agentFilter) {
    params.push(agentFilter);
    agentClause = ' AND agent = $2';
  }

  const res = await pool.query(
    `SELECT
       TO_CHAR(DATE(created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
       COUNT(*) FILTER (WHERE rating = 'up')   AS thumbs_up,
       COUNT(*) FILTER (WHERE rating = 'down') AS thumbs_down
     FROM ai_response_feedback
     WHERE created_at >= NOW() - make_interval(days => $1)${agentClause}
     GROUP BY DATE(created_at AT TIME ZONE 'UTC')
     ORDER BY day ASC`,
    params
  );

  return res.rows.map(r => ({
    day: r.day,
    thumbs_up: parseInt(r.thumbs_up) || 0,
    thumbs_down: parseInt(r.thumbs_down) || 0,
  }));
}

export interface FeedbackTrendSummary {
  direction: 'improving' | 'worsening' | 'stable' | 'insufficient_data';
  peak_negative_day: string | null;
  peak_negative_count: number;
  total_thumbs_up: number;
  total_thumbs_down: number;
  first_half_down_rate: number;
  second_half_down_rate: number;
  days_observed: number;
}

/**
 * Summarize a feedback time-series for inclusion in scheduled QMS reports.
 * Returns trend direction (based on thumbs-down rate change between the first
 * and second half of the window) and the worst single-day spike.
 */
export function summarizeFeedbackTrend(trend: FeedbackTrendPoint[]): FeedbackTrendSummary {
  const points = Array.isArray(trend) ? trend : [];
  const totalUp = points.reduce((s, p) => s + (p.thumbs_up || 0), 0);
  const totalDown = points.reduce((s, p) => s + (p.thumbs_down || 0), 0);

  let peakDay: string | null = null;
  let peakCount = 0;
  for (const p of points) {
    if ((p.thumbs_down || 0) > peakCount) {
      peakCount = p.thumbs_down || 0;
      peakDay = p.day;
    }
  }

  if (points.length < 2 || (totalUp + totalDown) === 0) {
    return {
      direction: 'insufficient_data',
      peak_negative_day: peakDay,
      peak_negative_count: peakCount,
      total_thumbs_up: totalUp,
      total_thumbs_down: totalDown,
      first_half_down_rate: 0,
      second_half_down_rate: 0,
      days_observed: points.length,
    };
  }

  const mid = Math.floor(points.length / 2);
  const firstHalf = points.slice(0, mid);
  const secondHalf = points.slice(mid);

  const halfRate = (half: FeedbackTrendPoint[]) => {
    const up = half.reduce((s, p) => s + (p.thumbs_up || 0), 0);
    const down = half.reduce((s, p) => s + (p.thumbs_down || 0), 0);
    const total = up + down;
    return total > 0 ? down / total : 0;
  };

  const firstRate = halfRate(firstHalf);
  const secondRate = halfRate(secondHalf);
  const delta = secondRate - firstRate;

  let direction: FeedbackTrendSummary['direction'];
  if (Math.abs(delta) < 0.05) {
    direction = 'stable';
  } else if (delta > 0) {
    direction = 'worsening';
  } else {
    direction = 'improving';
  }

  return {
    direction,
    peak_negative_day: peakDay,
    peak_negative_count: peakCount,
    total_thumbs_up: totalUp,
    total_thumbs_down: totalDown,
    first_half_down_rate: Math.round(firstRate * 100) / 100,
    second_half_down_rate: Math.round(secondRate * 100) / 100,
    days_observed: points.length,
  };
}

export async function getDistinctFeedbackAgents(): Promise<string[]> {
  await initAIFeedbackTable();
  const res = await pool.query(
    `SELECT DISTINCT agent
     FROM ai_response_feedback
     WHERE agent IS NOT NULL AND agent <> ''
     ORDER BY agent ASC`
  );
  return res.rows.map(r => String(r.agent));
}

export async function getWeeklyFeedbackDigest(): Promise<{
  period: string;
  total: number;
  thumbs_up: number;
  thumbs_down: number;
  thumbs_up_pct: number;
  top_categories: { category: string; count: number }[];
  sample_down: { category: string | null; comment: string | null }[];
  trend: FeedbackTrendPoint[];
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

  const trend = await getFeedbackTrend(7);

  return {
    period: `${weekStart.toDateString()} – ${now.toDateString()}`,
    total,
    thumbs_up: up,
    thumbs_down: down,
    thumbs_up_pct: total > 0 ? Math.round((up / total) * 100) : 0,
    top_categories: cats.rows.map(r => ({ category: r.category, count: parseInt(r.cnt) })),
    sample_down: samples.rows,
    trend,
  };
}
