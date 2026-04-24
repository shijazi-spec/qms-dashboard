/**
 * AI Observability — Token, Cost, Latency & Error Telemetry
 *
 * Every LLM call made through the agent or workflow layer should pass through
 * withAiTelemetry() so that a row is written to ai_call_metrics for
 * financial tracking, quality drift detection, and operational alerting.
 *
 * ── Price Table ──────────────────────────────────────────────────────────────
 * Location : src/utils/aiTelemetry.ts  →  MODEL_PRICE_TABLE
 * Last updated : 2025-01  (OpenAI pricing at GA)
 * How to update: Edit the inputPer1k / outputPer1k values (USD per 1 000 tokens)
 *   to match https://openai.com/api/pricing  whenever OpenAI changes rates.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import pg from 'pg';
const { Pool } = pg;
import { createHash } from 'crypto';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ──────────────────────────────────────────────────────────────────────────────
// Price table — USD per 1 000 tokens
// ──────────────────────────────────────────────────────────────────────────────
export const MODEL_PRICE_TABLE: Record<string, { inputPer1k: number; outputPer1k: number }> = {
  'gpt-4o':            { inputPer1k: 0.0025,   outputPer1k: 0.010   },
  'gpt-4o-mini':       { inputPer1k: 0.00015,  outputPer1k: 0.0006  },
  'gpt-4-turbo':       { inputPer1k: 0.010,    outputPer1k: 0.030   },
  'gpt-4':             { inputPer1k: 0.030,    outputPer1k: 0.060   },
  'gpt-3.5-turbo':     { inputPer1k: 0.0005,   outputPer1k: 0.0015  },
  'gpt-4o-2024-11-20': { inputPer1k: 0.0025,   outputPer1k: 0.010   },
  'gpt-4o-2024-08-06': { inputPer1k: 0.0025,   outputPer1k: 0.010   },
};

function computeCost(model: string, promptTokens: number, completionTokens: number): number {
  const key = Object.keys(MODEL_PRICE_TABLE).find(k => model.startsWith(k)) ?? 'gpt-4o';
  const prices = MODEL_PRICE_TABLE[key];
  return (promptTokens / 1000) * prices.inputPer1k + (completionTokens / 1000) * prices.outputPer1k;
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

const PII_PATTERNS: [RegExp, string][] = [
  [/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
  [/\b(?:\+?\d{1,3}[\s-])?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[PHONE]'],
  [/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[CARD]'],
  [/\b(?:password|secret|token|key|auth)\s*[:=]\s*\S+/gi, '[REDACTED]'],
];

export function redactPromptPreview(prompt: string, maxLen = 300): string {
  let preview = prompt.slice(0, maxLen + 100);
  for (const [pattern, replacement] of PII_PATTERNS) {
    preview = preview.replace(pattern, replacement);
  }
  return preview.slice(0, maxLen);
}

// ──────────────────────────────────────────────────────────────────────────────
// Table bootstrap (idempotent — called lazily before every write)
// ──────────────────────────────────────────────────────────────────────────────
let tableReady: Promise<void> | null = null;

export async function ensureAiMetricsTable(): Promise<void> {
  if (tableReady) return tableReady;
  tableReady = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ai_call_metrics (
          id                 BIGSERIAL PRIMARY KEY,
          agent_name         TEXT      NOT NULL,
          tool_name          TEXT,
          parent_call_id     BIGINT,
          model              TEXT      NOT NULL DEFAULT 'gpt-4o',
          prompt_tokens      INTEGER,
          completion_tokens  INTEGER,
          total_tokens       INTEGER,
          latency_ms         INTEGER,
          estimated_cost_usd NUMERIC(14, 8),
          success            BOOLEAN   NOT NULL DEFAULT TRUE,
          error_class        TEXT,
          error_message      TEXT,
          prompt_preview     TEXT,
          user_hash          TEXT,
          session_hash       TEXT,
          started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          metadata           JSONB     DEFAULT '{}'::jsonb
        );

        ALTER TABLE ai_call_metrics
          ADD COLUMN IF NOT EXISTS prompt_preview TEXT;

        CREATE INDEX IF NOT EXISTS idx_ai_call_metrics_agent_started
          ON ai_call_metrics (agent_name, started_at DESC);

        CREATE INDEX IF NOT EXISTS idx_ai_call_metrics_tool_started
          ON ai_call_metrics (tool_name, started_at DESC)
          WHERE tool_name IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_ai_call_metrics_started_at
          ON ai_call_metrics (started_at DESC);
      `);
    } catch (err) {
      tableReady = null;
      throw err;
    }
  })();
  return tableReady;
}

// ──────────────────────────────────────────────────────────────────────────────
// Low-level insert
// ──────────────────────────────────────────────────────────────────────────────
export interface AiCallMetricRow {
  agent_name: string;
  tool_name?: string;
  parent_call_id?: number;
  model: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  latency_ms: number;
  estimated_cost_usd?: number;
  success: boolean;
  error_class?: string;
  error_message?: string;
  prompt_preview?: string;
  user_hash?: string;
  session_hash?: string;
  metadata?: Record<string, unknown>;
}

export async function insertAiCallMetric(row: AiCallMetricRow): Promise<number | null> {
  try {
    await ensureAiMetricsTable();

    const cost =
      row.estimated_cost_usd ??
      (row.prompt_tokens != null && row.completion_tokens != null
        ? computeCost(row.model, row.prompt_tokens, row.completion_tokens)
        : 0);

    const result = await pool.query(
      `INSERT INTO ai_call_metrics
         (agent_name, tool_name, parent_call_id, model,
          prompt_tokens, completion_tokens, total_tokens,
          latency_ms, estimated_cost_usd,
          success, error_class, error_message,
          prompt_preview, user_hash, session_hash, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        row.agent_name,
        row.tool_name ?? null,
        row.parent_call_id ?? null,
        row.model,
        row.prompt_tokens ?? null,
        row.completion_tokens ?? null,
        row.total_tokens ?? null,
        row.latency_ms,
        cost,
        row.success,
        row.error_class ?? null,
        row.error_message ? row.error_message.slice(0, 500) : null,
        row.prompt_preview ?? null,
        row.user_hash ?? null,
        row.session_hash ?? null,
        JSON.stringify(row.metadata ?? {}),
      ]
    );
    return result.rows[0]?.id ?? null;
  } catch (err) {
    console.error('[aiTelemetry] Failed to insert metric:', err);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Primary wrapper — wraps any agent.generateLegacy / generate call
// ──────────────────────────────────────────────────────────────────────────────
export interface WithAiTelemetryParams {
  agentName: string;
  model: string;
  promptText?: string;
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export async function withAiTelemetry<T>(
  params: WithAiTelemetryParams,
  fn: () => Promise<T>
): Promise<{ result: T; callId: number | null }> {
  await ensureAiMetricsTable();
  const startedAt = Date.now();
  const promptPreview = params.promptText
    ? redactPromptPreview(params.promptText)
    : undefined;

  try {
    const result = await fn();
    const latencyMs = Date.now() - startedAt;

    const res = result as Record<string, unknown>;
    const rawUsage =
      (res?.usage as Record<string, unknown> | undefined) ??
      ((res?.rawResponse as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined) ??
      null;
    const promptTokens =
      typeof rawUsage?.promptTokens === 'number' ? rawUsage.promptTokens
      : typeof rawUsage?.prompt_tokens === 'number' ? rawUsage.prompt_tokens
      : undefined;
    const completionTokens =
      typeof rawUsage?.completionTokens === 'number' ? rawUsage.completionTokens
      : typeof rawUsage?.completion_tokens === 'number' ? rawUsage.completion_tokens
      : undefined;
    const totalTokens =
      typeof rawUsage?.totalTokens === 'number' ? rawUsage.totalTokens
      : typeof rawUsage?.total_tokens === 'number' ? rawUsage.total_tokens
      : undefined;

    const callId = await insertAiCallMetric({
      agent_name: params.agentName,
      model: params.model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      latency_ms: latencyMs,
      success: true,
      prompt_preview: promptPreview,
      user_hash: params.userId ? hashValue(params.userId) : undefined,
      session_hash: params.sessionId ? hashValue(params.sessionId) : undefined,
      metadata: params.metadata,
    });

    return { result, callId };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    await insertAiCallMetric({
      agent_name: params.agentName,
      model: params.model,
      latency_ms: latencyMs,
      success: false,
      error_class: err instanceof Error ? err.constructor.name : 'UnknownError',
      error_message: err instanceof Error ? err.message : String(err),
      prompt_preview: promptPreview,
      user_hash: params.userId ? hashValue(params.userId) : undefined,
      session_hash: params.sessionId ? hashValue(params.sessionId) : undefined,
      metadata: params.metadata,
    });
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Streaming telemetry helper
// Records a metric row after the stream has been fully consumed.
// Usage:
//   const startedAt = Date.now();
//   // ... process stream ...
//   await recordStreamTelemetry({ agentName, model, startedAt, stream, ... });
// ──────────────────────────────────────────────────────────────────────────────
export async function recordStreamTelemetry(params: {
  agentName: string;
  model: string;
  startedAt: number;
  stream: { usage?: Promise<{ promptTokens?: number; completionTokens?: number; totalTokens?: number; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }> } | null;
  success: boolean;
  errorClass?: string;
  errorMessage?: string;
  promptText?: string;
  userId?: string;
  sessionId?: string;
}): Promise<number | null> {
  const latencyMs = Date.now() - params.startedAt;
  const promptPreview = params.promptText
    ? redactPromptPreview(params.promptText)
    : undefined;

  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let totalTokens: number | undefined;

  if (params.success && params.stream != null) {
    try {
      const usage = await Promise.race([
        params.stream.usage ?? Promise.resolve(null),
        new Promise<null>(res => setTimeout(() => res(null), 2000)),
      ]);
      if (usage) {
        promptTokens = usage.promptTokens ?? usage.prompt_tokens ?? undefined;
        completionTokens = usage.completionTokens ?? usage.completion_tokens ?? undefined;
        totalTokens = usage.totalTokens ?? usage.total_tokens ?? undefined;
      }
    } catch {
      // Usage unavailable — record without token counts
    }
  }

  return insertAiCallMetric({
    agent_name: params.agentName,
    model: params.model,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    latency_ms: latencyMs,
    success: params.success,
    error_class: params.errorClass,
    error_message: params.errorMessage,
    prompt_preview: promptPreview,
    user_hash: params.userId ? hashValue(params.userId) : undefined,
    session_hash: params.sessionId ? hashValue(params.sessionId) : undefined,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// 90-day pruning — called from the daily cost-summary cron
// ──────────────────────────────────────────────────────────────────────────────
export async function pruneOldAiMetrics(): Promise<number> {
  try {
    await ensureAiMetricsTable();
    const result = await pool.query(
      `DELETE FROM ai_call_metrics WHERE started_at < NOW() - INTERVAL '90 days'`
    );
    return result.rowCount ?? 0;
  } catch (err) {
    console.error('[aiTelemetry] Pruning failed:', err);
    return 0;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Aggregate queries — consumed by the AI Operations panel routes
// ──────────────────────────────────────────────────────────────────────────────

export async function getWeeklyCostTrend(days = 14): Promise<any[]> {
  await ensureAiMetricsTable();
  const result = await pool.query(
    `SELECT
       DATE(started_at AT TIME ZONE 'UTC')        AS day,
       SUM(estimated_cost_usd)                     AS total_cost,
       COUNT(*)                                    AS call_count,
       COUNT(*) FILTER (WHERE NOT success)         AS error_count
     FROM ai_call_metrics
     WHERE started_at >= NOW() - MAKE_INTERVAL(days => $1)
       AND tool_name IS NULL
     GROUP BY DATE(started_at AT TIME ZONE 'UTC')
     ORDER BY day`,
    [days]
  );
  return result.rows;
}

export async function getAgentLatencyPercentiles(): Promise<any[]> {
  await ensureAiMetricsTable();
  const result = await pool.query(
    `SELECT
       agent_name,
       COUNT(*)                                                              AS call_count,
       PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY latency_ms)            AS p50_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)            AS p95_ms,
       ROUND(AVG(latency_ms)::NUMERIC, 0)                                  AS avg_ms,
       ROUND(
         (COUNT(*) FILTER (WHERE NOT success)::FLOAT
          / NULLIF(COUNT(*), 0) * 100)::NUMERIC, 1
       )                                                                    AS error_rate_pct,
       ROUND(SUM(estimated_cost_usd)::NUMERIC, 4)                          AS total_cost
     FROM ai_call_metrics
     WHERE started_at >= NOW() - INTERVAL '7 days'
       AND tool_name IS NULL
     GROUP BY agent_name
     ORDER BY total_cost DESC`
  );
  return result.rows;
}

export async function getTopToolsByCost(limit = 10): Promise<any[]> {
  await ensureAiMetricsTable();
  const result = await pool.query(
    `SELECT
       tool_name,
       agent_name,
       COUNT(*)                                                              AS call_count,
       ROUND(SUM(estimated_cost_usd)::NUMERIC, 6)                          AS total_cost,
       ROUND(AVG(latency_ms)::NUMERIC, 0)                                  AS avg_latency_ms,
       ROUND(
         (COUNT(*) FILTER (WHERE NOT success)::FLOAT
          / NULLIF(COUNT(*), 0) * 100)::NUMERIC, 1
       )                                                                    AS error_rate_pct
     FROM ai_call_metrics
     WHERE tool_name IS NOT NULL
       AND started_at >= NOW() - INTERVAL '7 days'
     GROUP BY tool_name, agent_name
     ORDER BY total_cost DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function getRecentSlowFailedCalls(limit = 20): Promise<{
  id: string;
  agent_name: string;
  tool_name: string | null;
  model: string;
  latency_ms: number;
  estimated_cost_usd: string;
  success: boolean;
  error_class: string | null;
  error_message: string | null;
  prompt_preview: string | null;
  started_at: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}[]> {
  await ensureAiMetricsTable();
  const result = await pool.query(
    `SELECT
       id, agent_name, tool_name, model,
       latency_ms, estimated_cost_usd,
       success, error_class, error_message,
       prompt_preview,
       started_at, prompt_tokens, completion_tokens
     FROM ai_call_metrics
     WHERE (NOT success OR latency_ms > 30000)
       AND started_at >= NOW() - INTERVAL '7 days'
     ORDER BY started_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// ──────────────────────────────────────────────────────────────────────────────
// Call-level feedback (thumbs up / down) — enables feedback_rate per agent
// ──────────────────────────────────────────────────────────────────────────────
let feedbackTableReady: Promise<void> | null = null;

async function ensureFeedbackTable(): Promise<void> {
  if (feedbackTableReady) return feedbackTableReady;
  feedbackTableReady = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ai_call_feedback (
          id          BIGSERIAL PRIMARY KEY,
          call_id     BIGINT NOT NULL REFERENCES ai_call_metrics(id) ON DELETE CASCADE,
          rating      TEXT   NOT NULL CHECK (rating IN ('thumbs_up','thumbs_down')),
          user_hash   TEXT   NOT NULL DEFAULT 'anonymous',
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_ai_call_feedback_call_user UNIQUE (call_id, user_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_call_feedback_call_id
          ON ai_call_feedback (call_id);
        CREATE INDEX IF NOT EXISTS idx_ai_call_feedback_created_at
          ON ai_call_feedback (created_at DESC);
      `);
    } catch (err) {
      feedbackTableReady = null;
      throw err;
    }
  })();
  return feedbackTableReady;
}

export async function insertCallFeedback(
  callId: number,
  rating: 'thumbs_up' | 'thumbs_down',
  userId?: string
): Promise<boolean> {
  try {
    await ensureFeedbackTable();
    const userHash = userId ? hashValue(userId) : 'anonymous';
    await pool.query(
      `INSERT INTO ai_call_feedback (call_id, rating, user_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT uq_ai_call_feedback_call_user
       DO UPDATE SET rating = EXCLUDED.rating`,
      [callId, rating, userHash]
    );
    return true;
  } catch (err) {
    console.error('[aiTelemetry] Failed to insert feedback:', err);
    return false;
  }
}

export async function getFeedbackRateByAgent(): Promise<{
  agent_name: string;
  total_feedback: number;
  thumbs_up: number;
  thumbs_down: number;
  feedback_rate_pct: number;
}[]> {
  try {
    await ensureFeedbackTable();
    const result = await pool.query(
      `SELECT
         m.agent_name,
         COUNT(f.id)                                                          AS total_feedback,
         COUNT(f.id) FILTER (WHERE f.rating = 'thumbs_up')                   AS thumbs_up,
         COUNT(f.id) FILTER (WHERE f.rating = 'thumbs_down')                 AS thumbs_down,
         ROUND(
           (COUNT(f.id) FILTER (WHERE f.rating = 'thumbs_up')::FLOAT
            / NULLIF(COUNT(f.id), 0) * 100)::NUMERIC, 1
         )                                                                    AS feedback_rate_pct
       FROM ai_call_feedback f
       JOIN ai_call_metrics  m ON m.id = f.call_id
       WHERE f.created_at >= NOW() - INTERVAL '30 days'
       GROUP BY m.agent_name
       ORDER BY total_feedback DESC`
    );
    return result.rows;
  } catch {
    return [];
  }
}

export async function getDailyCostSummary(): Promise<{
  totalCostUsd: number;
  callCount: number;
  errorCount: number;
  avgLatencyMs: number;
}> {
  await ensureAiMetricsTable();
  const result = await pool.query(
    `SELECT
       COALESCE(SUM(estimated_cost_usd), 0)       AS total_cost_usd,
       COUNT(*)                                    AS call_count,
       COUNT(*) FILTER (WHERE NOT success)         AS error_count,
       COALESCE(ROUND(AVG(latency_ms)::NUMERIC,0), 0) AS avg_latency_ms
     FROM ai_call_metrics
     WHERE started_at >= NOW() - INTERVAL '24 hours'`
  );
  const row = result.rows[0];
  return {
    totalCostUsd:   parseFloat(row.total_cost_usd)  || 0,
    callCount:      parseInt(row.call_count)         || 0,
    errorCount:     parseInt(row.error_count)        || 0,
    avgLatencyMs:   parseFloat(row.avg_latency_ms)   || 0,
  };
}
