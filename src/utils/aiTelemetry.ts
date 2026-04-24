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
 *
 * ── Downstream linking via callId ────────────────────────────────────────────
 * withAiTelemetry() returns { result, callId } where `callId` is the
 * ai_call_metrics.id of the row inserted for this LLM call (or null if the
 * insert failed). Route handlers should surface `callId` on their JSON
 * response payload (e.g. the QMS Consultant chat returns it as `callId`)
 * so that:
 *   • Inline thumbs-up/down feedback can POST { callId, rating } to
 *     /api/ai-ops/feedback → ai_call_feedback (FK to ai_call_metrics.id).
 *   • The AI Operations panel can join feedback back to the original call
 *     via getFeedbackRateByAgent() and display a per-agent feedback_rate_pct
 *     alongside latency / cost metrics for prompt A/B evaluation.
 * Streaming responses use recordStreamTelemetry() which also returns the
 * inserted row id for the same purpose.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import pg from 'pg';
const { Pool } = pg;
import { createHash } from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

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

/**
 * Stringify-and-redact arbitrary tool input/output payloads for the
 * `tool_input_preview` / `tool_output_preview` columns. Reuses the same
 * PII rules as redactPromptPreview() so secrets, emails, phone numbers
 * and card numbers never reach `ai_call_metrics`. Returns undefined for
 * null/undefined so we don't store an empty string.
 */
export function redactToolPayloadPreview(payload: unknown, maxLen = 300): string | undefined {
  if (payload === undefined || payload === null) return undefined;
  let asString: string;
  if (typeof payload === 'string') {
    asString = payload;
  } else {
    try {
      asString = JSON.stringify(payload);
    } catch {
      asString = String(payload);
    }
  }
  if (!asString) return undefined;
  return redactPromptPreview(asString, maxLen);
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
          tool_input_preview TEXT,
          tool_output_preview TEXT,
          user_hash          TEXT,
          session_hash       TEXT,
          started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          metadata           JSONB     DEFAULT '{}'::jsonb
        );

        ALTER TABLE ai_call_metrics
          ADD COLUMN IF NOT EXISTS prompt_preview TEXT;
        ALTER TABLE ai_call_metrics
          ADD COLUMN IF NOT EXISTS tool_input_preview TEXT;
        ALTER TABLE ai_call_metrics
          ADD COLUMN IF NOT EXISTS tool_output_preview TEXT;

        CREATE INDEX IF NOT EXISTS idx_ai_call_metrics_agent_started
          ON ai_call_metrics (agent_name, started_at DESC);

        CREATE INDEX IF NOT EXISTS idx_ai_call_metrics_tool_started
          ON ai_call_metrics (tool_name, started_at DESC)
          WHERE tool_name IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_ai_call_metrics_started_at
          ON ai_call_metrics (started_at DESC);

        -- Speeds up the per-prompt-version aggregate used by the
        -- AI Operations panel's Prompt Version comparison view
        -- (see getFeedbackRateByPromptVersion below).
        CREATE INDEX IF NOT EXISTS idx_ai_call_metrics_agent_prompt_version
          ON ai_call_metrics (agent_name, (metadata ->> 'prompt_version'), started_at DESC)
          WHERE tool_name IS NULL;
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
  tool_input_preview?: string;
  tool_output_preview?: string;
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
          prompt_preview, tool_input_preview, tool_output_preview,
          user_hash, session_hash, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
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
        row.tool_input_preview ?? null,
        row.tool_output_preview ?? null,
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
// Parent-call AsyncLocalStorage — used by wrapToolWithTelemetry() to attach
// a child tool row to its parent agent call. The context is set by
// startTelemetrySpan().run() / withAiTelemetry() and propagates across
// awaits inside the agent's generate/stream loop.
// ──────────────────────────────────────────────────────────────────────────────
const aiCallContext = new AsyncLocalStorage<{ callId: number | null }>();

export function getCurrentParentCallId(): number | null {
  return aiCallContext.getStore()?.callId ?? null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Open / finalize helpers — used by startTelemetrySpan() so we can allocate
// a row id BEFORE the LLM call so child tool rows have a parent to point at.
// ──────────────────────────────────────────────────────────────────────────────
async function openAiCallMetric(params: {
  agentName: string;
  model: string;
  promptPreview?: string;
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}): Promise<number | null> {
  try {
    await ensureAiMetricsTable();
    const result = await pool.query(
      `INSERT INTO ai_call_metrics
         (agent_name, model, success, prompt_preview, user_hash, session_hash, metadata)
       VALUES ($1, $2, TRUE, $3, $4, $5, $6)
       RETURNING id`,
      [
        params.agentName,
        params.model,
        params.promptPreview ?? null,
        params.userId ? hashValue(params.userId) : null,
        params.sessionId ? hashValue(params.sessionId) : null,
        JSON.stringify(params.metadata ?? {}),
      ]
    );
    return result.rows[0]?.id ?? null;
  } catch (err) {
    console.error('[aiTelemetry] Failed to open metric:', err);
    return null;
  }
}

async function finalizeAiCallMetric(
  callId: number,
  finals: {
    latencyMs: number;
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    success: boolean;
    errorClass?: string;
    errorMessage?: string;
  }
): Promise<void> {
  try {
    const cost =
      finals.promptTokens != null && finals.completionTokens != null
        ? computeCost(finals.model, finals.promptTokens, finals.completionTokens)
        : 0;
    await pool.query(
      `UPDATE ai_call_metrics
         SET latency_ms         = $2,
             prompt_tokens      = $3,
             completion_tokens  = $4,
             total_tokens       = $5,
             estimated_cost_usd = $6,
             success            = $7,
             error_class        = $8,
             error_message      = $9
       WHERE id = $1`,
      [
        callId,
        finals.latencyMs,
        finals.promptTokens ?? null,
        finals.completionTokens ?? null,
        finals.totalTokens ?? null,
        cost,
        finals.success,
        finals.errorClass ?? null,
        finals.errorMessage ? finals.errorMessage.slice(0, 500) : null,
      ]
    );
  } catch (err) {
    console.error('[aiTelemetry] Failed to finalize metric:', err);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Telemetry span — preferred low-level API. Allocates the parent row up
// front so any tool calls made inside .run(fn) can reference it via
// AsyncLocalStorage. Used by withAiTelemetry() (sync agent calls) and by
// the streaming routes (where init + stream consumption must share context).
// ──────────────────────────────────────────────────────────────────────────────
export interface TelemetrySpan {
  callId: number | null;
  run<T>(fn: () => Promise<T>): Promise<T>;
  finalize(opts: {
    success: boolean;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    errorClass?: string;
    errorMessage?: string;
  }): Promise<void>;
}

export async function startTelemetrySpan(params: WithAiTelemetryParams): Promise<TelemetrySpan> {
  const startedAt = Date.now();
  const promptPreview = params.promptText
    ? redactPromptPreview(params.promptText)
    : undefined;
  const callId = await openAiCallMetric({
    agentName: params.agentName,
    model: params.model,
    promptPreview,
    userId: params.userId,
    sessionId: params.sessionId,
    metadata: params.metadata,
  });

  return {
    callId,
    run<T>(fn: () => Promise<T>): Promise<T> {
      return aiCallContext.run({ callId }, fn);
    },
    async finalize(opts) {
      if (callId == null) return;
      await finalizeAiCallMetric(callId, {
        latencyMs: Date.now() - startedAt,
        model: params.model,
        promptTokens: opts.promptTokens,
        completionTokens: opts.completionTokens,
        totalTokens: opts.totalTokens,
        success: opts.success,
        errorClass: opts.errorClass,
        errorMessage: opts.errorMessage,
      });
    },
  };
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
  const span = await startTelemetrySpan(params);

  try {
    const result = await span.run(fn);

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

    await span.finalize({
      success: true,
      promptTokens,
      completionTokens,
      totalTokens,
    });

    return { result, callId: span.callId };
  } catch (err) {
    await span.finalize({
      success: false,
      errorClass: err instanceof Error ? err.constructor.name : 'UnknownError',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Tool-call telemetry — wrap each Mastra tool's execute() so we record a
// child row in ai_call_metrics tagged with `tool_name` + `parent_call_id`.
// This powers the "Top Tools" and "Recent Issues" tabs in dashboard/ai-ops.
//
// Wrapping ORDER (when combining with withApprovalGate):
//   wrapToolWithTelemetry(withApprovalGate(tool), agentName)
// Telemetry stays OUTSIDE the gate so we capture every LLM-initiated tool
// call — including those that get queued for human approval (which return
// { success: false, queued: true }). Queued calls are NOT counted as
// errors in the dashboard; only true exceptions or non-queued failures are.
// ──────────────────────────────────────────────────────────────────────────────
type WrappableTool = {
  id?: string;
  description?: string;
  execute?: (args: unknown) => Promise<unknown>;
};

function describeToolFailure(result: unknown): string | null {
  if (result === null || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (r.success !== false) return null;
  if (r.queued === true) return null; // HITL-gated queue is not an error
  if (typeof r.error === 'string') return r.error;
  if (typeof r.message === 'string') return r.message;
  return 'Tool returned success=false';
}

export function wrapToolWithTelemetry<T extends WrappableTool>(tool: T, agentName: string): T {
  const originalExecute = tool.execute;
  const toolId = tool.id;
  if (!originalExecute || !toolId) return tool;

  const wrappedExecute = async (args: unknown): Promise<unknown> => {
    const startedAt = Date.now();
    const parentCallId = getCurrentParentCallId();
    let success = true;
    let errorClass: string | undefined;
    let errorMessage: string | undefined;
    // Capture sanitized previews of the LLM-provided input and (truncated)
    // output so ops teams can reproduce a failing tool call without us
    // ever persisting raw secrets / PII. Both are ≤300 chars after the
    // same PII redaction rules used for prompt_preview.
    const toolInputPreview = redactToolPayloadPreview(args);
    let toolOutputPreview: string | undefined;

    try {
      const result = await originalExecute(args);
      toolOutputPreview = redactToolPayloadPreview(result);

      // Tools standardize on { success: boolean, ...}.
      // Treat soft-fail returns as errors UNLESS they are HITL-gated queues
      // (which are an expected, non-error outcome of a write tool).
      const failureMessage = describeToolFailure(result);
      if (failureMessage !== null) {
        success = false;
        errorClass = 'ToolReturnedFailure';
        errorMessage = failureMessage;
      }
      return result;
    } catch (err) {
      success = false;
      errorClass = err instanceof Error ? err.constructor.name : 'UnknownError';
      errorMessage = err instanceof Error ? err.message : String(err);
      // Even on hard failures we still want the redacted error string in
      // tool_output_preview so the dashboard can show what came back.
      toolOutputPreview = redactToolPayloadPreview(errorMessage);
      throw err;
    } finally {
      const latencyMs = Date.now() - startedAt;
      // Fire-and-forget — never let a metric write slow tool execution.
      insertAiCallMetric({
        agent_name: agentName,
        tool_name: toolId,
        parent_call_id: parentCallId ?? undefined,
        model: 'tool',
        latency_ms: latencyMs,
        success,
        error_class: errorClass,
        error_message: errorMessage,
        tool_input_preview: toolInputPreview,
        tool_output_preview: toolOutputPreview,
      }).catch(() => { /* non-fatal */ });
    }
  };

  // Clone the tool so we don't mutate the shared instance, then swap in the
  // telemetry-wrapped execute. Cloning via Object.assign preserves the
  // tool's prototype (e.g. Mastra's Tool class) and all original fields
  // (id, description, inputSchema, outputSchema, requireApproval, etc.).
  const proto = Object.getPrototypeOf(tool) as object | null;
  const cloned = Object.assign(
    proto ? Object.create(proto) : {},
    tool,
    { execute: wrappedExecute as unknown as T['execute'] },
  ) as T;
  return cloned;
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
  metadata?: Record<string, unknown>;
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
    metadata: params.metadata,
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

/**
 * Purge telemetry rows for prompt versions that are no longer deployed.
 *
 * A prompt-version is eligible for purging when ALL of the following hold:
 *  1. It is NOT in `liveVersions` (the set of currently deployed constants).
 *  2. Its newest `started_at` timestamp is older than `retentionDays` days
 *     — i.e. MAX(started_at) for that version is outside the window.
 *
 * When a version qualifies, ALL rows for that version are removed (not just
 * the old ones). If any row is still within the retention window the entire
 * version is left untouched.
 *
 * Returns the number of rows deleted.
 */
export async function purgeArchivedPromptVersionMetrics(
  liveVersions: string[],
  retentionDays: number,
): Promise<number> {
  try {
    await ensureAiMetricsTable();
    if (liveVersions.length === 0) {
      console.warn(
        '[aiTelemetry] purgeArchivedPromptVersionMetrics: no live versions supplied — skipping to avoid purging everything',
      );
      return 0;
    }
    // First identify which archived versions have their NEWEST sample older than
    // the retention window, then delete ALL rows for those versions.
    // This matches the "newest sample is >N days old" semantics from the spec:
    // if any row for an archived version is still within the window we leave
    // the entire version untouched.
    const result = await pool.query(
      `DELETE FROM ai_call_metrics
        WHERE metadata->>'prompt_version' IS NOT NULL
          AND metadata->>'prompt_version' != ALL($1::text[])
          AND metadata->>'prompt_version' IN (
            SELECT metadata->>'prompt_version'
            FROM   ai_call_metrics
            WHERE  metadata->>'prompt_version' IS NOT NULL
              AND  metadata->>'prompt_version' != ALL($1::text[])
            GROUP  BY metadata->>'prompt_version'
            HAVING MAX(started_at) < NOW() - MAKE_INTERVAL(days => $2)
          )`,
      [liveVersions, retentionDays],
    );
    return result.rowCount ?? 0;
  } catch (err) {
    console.error('[aiTelemetry] purgeArchivedPromptVersionMetrics failed:', err);
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

export async function getTopToolsByCost(limit = 10, agentName?: string): Promise<any[]> {
  await ensureAiMetricsTable();
  const params: any[] = [limit];
  let agentFilter = '';
  if (agentName && agentName.trim()) {
    params.push(agentName.trim());
    agentFilter = `AND agent_name = $${params.length}`;
  }
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
       ${agentFilter}
     GROUP BY tool_name, agent_name
     ORDER BY total_cost DESC, call_count DESC
     LIMIT $1`,
    params
  );
  return result.rows;
}

export async function getKnownAgentNames(): Promise<string[]> {
  await ensureAiMetricsTable();
  const result = await pool.query(
    `SELECT DISTINCT agent_name
     FROM ai_call_metrics
     WHERE tool_name IS NOT NULL
       AND started_at >= NOW() - INTERVAL '7 days'
     ORDER BY agent_name`
  );
  return result.rows.map(r => r.agent_name);
}

export async function getChildToolCallsForParent(parentId: number): Promise<{
  id: string;
  agent_name: string;
  tool_name: string | null;
  latency_ms: number;
  success: boolean;
  error_class: string | null;
  error_message: string | null;
  started_at: string;
}[]> {
  await ensureAiMetricsTable();
  const result = await pool.query(
    `SELECT
       id, agent_name, tool_name,
       latency_ms, success, error_class, error_message, started_at
     FROM ai_call_metrics
     WHERE parent_call_id = $1
     ORDER BY started_at ASC, id ASC`,
    [parentId]
  );
  return result.rows;
}

// ──────────────────────────────────────────────────────────────────────────────
// Per-tool rolling-window aggregates — used by the tool-health alert cron
// (src/mastra/workflows/toolHealthAlertsCron.ts) to detect tools whose
// error_rate or p95 latency has degraded over the last `windowMinutes`.
// ──────────────────────────────────────────────────────────────────────────────
export interface ToolWindowAggregate {
  tool_name: string;
  agent_name: string | null;
  call_count: number;
  error_count: number;
  error_rate_pct: number;
  p95_latency_ms: number;
  avg_latency_ms: number;
  max_latency_ms: number;
}

export async function getToolWindowAggregates(
  windowMinutes = 60,
  minCalls = 1,
): Promise<ToolWindowAggregate[]> {
  await ensureAiMetricsTable();
  const result = await pool.query(
    `SELECT
       tool_name,
       MAX(agent_name)                                                       AS agent_name,
       COUNT(*)                                                              AS call_count,
       COUNT(*) FILTER (WHERE NOT success)                                   AS error_count,
       ROUND(
         (COUNT(*) FILTER (WHERE NOT success)::FLOAT
          / NULLIF(COUNT(*), 0) * 100)::NUMERIC, 1
       )                                                                     AS error_rate_pct,
       COALESCE(
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms),
         0
       )                                                                     AS p95_latency_ms,
       ROUND(AVG(latency_ms)::NUMERIC, 0)                                    AS avg_latency_ms,
       MAX(latency_ms)                                                       AS max_latency_ms
     FROM ai_call_metrics
     WHERE tool_name IS NOT NULL
       AND started_at >= NOW() - MAKE_INTERVAL(mins => $1)
     GROUP BY tool_name
     HAVING COUNT(*) >= $2
     ORDER BY tool_name`,
    [windowMinutes, minCalls],
  );
  return result.rows.map((r: any) => ({
    tool_name: r.tool_name,
    agent_name: r.agent_name,
    call_count: Number(r.call_count),
    error_count: Number(r.error_count),
    error_rate_pct: Number(r.error_rate_pct ?? 0),
    p95_latency_ms: Math.round(Number(r.p95_latency_ms ?? 0)),
    avg_latency_ms: Number(r.avg_latency_ms ?? 0),
    max_latency_ms: Number(r.max_latency_ms ?? 0),
  }));
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
  tool_input_preview: string | null;
  tool_output_preview: string | null;
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
       prompt_preview, tool_input_preview, tool_output_preview,
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

/**
 * Fetch a single ai_call_metrics row by id, used by the AI Ops "call detail"
 * popover so links from Negative Feedback always resolve regardless of the
 * filtered Recent Issues window.
 */
export async function getCallById(callId: number): Promise<{
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
} | null> {
  await ensureAiMetricsTable();
  const result = await pool.query(
    `SELECT
       id, agent_name, tool_name, model,
       latency_ms, estimated_cost_usd,
       success, error_class, error_message,
       prompt_preview,
       started_at, prompt_tokens, completion_tokens
     FROM ai_call_metrics
     WHERE id = $1
     LIMIT 1`,
    [callId]
  );
  return result.rows[0] || null;
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
        ALTER TABLE ai_call_feedback
          ADD COLUMN IF NOT EXISTS comment TEXT;
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

// Comments are short freeform answers to "what went wrong?".  Cap conservatively
// to keep the row small and to discourage users from pasting prompts.
export const FEEDBACK_COMMENT_MAX_LEN = 1000;

function sanitizeFeedbackComment(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Strip HTML tags and common script vectors before storage.
  let cleaned = raw.replace(/<[^>]*>/g, '');
  cleaned = cleaned.replace(/javascript:/gi, '');
  cleaned = cleaned.replace(/on\w+\s*=/gi, '');
  cleaned = cleaned.trim();
  if (!cleaned) return null;
  if (cleaned.length > FEEDBACK_COMMENT_MAX_LEN) {
    cleaned = cleaned.slice(0, FEEDBACK_COMMENT_MAX_LEN);
  }
  return cleaned;
}

export async function insertCallFeedback(
  callId: number,
  rating: 'thumbs_up' | 'thumbs_down',
  userId?: string,
  comment?: string | null
): Promise<boolean> {
  try {
    await ensureFeedbackTable();
    const userHash = userId ? hashValue(userId) : 'anonymous';
    const cleanComment = sanitizeFeedbackComment(comment);
    await pool.query(
      `INSERT INTO ai_call_feedback (call_id, rating, user_hash, comment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ON CONSTRAINT uq_ai_call_feedback_call_user
       DO UPDATE SET rating  = EXCLUDED.rating,
                     comment = COALESCE(EXCLUDED.comment, ai_call_feedback.comment)`,
      [callId, rating, userHash, cleanComment]
    );
    return true;
  } catch (err) {
    console.error('[aiTelemetry] Failed to insert feedback:', err);
    return false;
  }
}

/**
 * Per-(agent, prompt_version) aggregate that backs the "Prompt Version"
 * comparison view in the AI Operations panel. Joins ai_call_feedback to
 * ai_call_metrics so a regression caused by a prompt edit (lower thumbs-up
 * rate, higher latency, more errors) is visible at a glance.
 *
 * Calls without a recorded prompt_version are bucketed as "(unknown)" so
 * legacy rows recorded before this column existed do not silently disappear.
 *
 * The row shape is exported as `PromptVersionAggregate` so the
 * prompt-regression cron (src/mastra/workflows/promptRegressionAlertsCron.ts)
 * and its tests share the exact shape and cannot drift from this query's
 * output.
 */
export interface PromptVersionAggregate {
  agent_name: string;
  prompt_version: string;
  call_count: number;
  total_feedback: number;
  thumbs_up: number;
  thumbs_down: number;
  feedback_rate_pct: number | null;
  p50_ms: number | null;
  avg_ms: number | null;
  error_rate_pct: number;
  first_seen: string;
  last_seen: string;
  /**
   * Unbounded all-time last seen — the most recent `started_at` across the
   * full `ai_call_metrics` history for this (agent_name, prompt_version)
   * pair, regardless of the query window. Allows the dashboard to show a
   * meaningful "last used" date for archived versions that have not been
   * active in the selected window.
   */
  last_seen_at: string;
  /**
   * Echoes back the minimum-sample floor that was applied when computing
   * `meets_min_feedback` so API consumers (the AI Ops dashboard, the
   * regression cron, etc.) can render the same threshold to the user.
   */
  min_feedback: number;
  /**
   * True when this row has at least `min_feedback` ratings — i.e. the
   * sample is large enough to be compared to other versions of the same
   * agent. Rows where this is false should not be flagged as "best" or
   * "regressed" by downstream consumers.
   */
  meets_min_feedback: boolean;
}

/**
 * Default minimum-sample floor for the per-prompt-version aggregate.
 *
 * A brand-new prompt version with a single thumbs-down can otherwise be
 * flagged as a "regression" against a mature version with hundreds of
 * votes, which is statistically meaningless and noisy on the dashboard
 * during a rollout. Five votes is the smallest sample where a 0%-vs-100%
 * gap can plausibly reflect real signal rather than the first reviewer's
 * mood. Callers can override per request (e.g. via the
 * `minFeedback` query string on `/api/ai-ops/prompt-versions`).
 */
export const DEFAULT_PROMPT_VERSION_MIN_FEEDBACK = 5;

export async function getFeedbackRateByPromptVersion(
  days = 30,
  minFeedback: number = DEFAULT_PROMPT_VERSION_MIN_FEEDBACK,
): Promise<PromptVersionAggregate[]> {
  // Guard against negative/NaN floors — a zero floor effectively disables
  // the small-sample protection, which is a valid (if discouraged) choice
  // we should still honour for callers that want raw aggregates.
  const floor = Number.isFinite(minFeedback) && minFeedback >= 0
    ? Math.floor(minFeedback)
    : DEFAULT_PROMPT_VERSION_MIN_FEEDBACK;
  try {
    await ensureAiMetricsTable();
    await ensureFeedbackTable();
    const result = await pool.query(
      `WITH windowed AS (
         SELECT
           m.agent_name,
           COALESCE(m.metadata ->> 'prompt_version', '(unknown)')            AS prompt_version,
           COUNT(*)                                                           AS call_count,
           COUNT(f.id)                                                        AS total_feedback,
           COUNT(f.id) FILTER (WHERE f.rating = 'thumbs_up')                 AS thumbs_up,
           COUNT(f.id) FILTER (WHERE f.rating = 'thumbs_down')               AS thumbs_down,
           CASE WHEN COUNT(f.id) > 0 THEN
             ROUND(
               (COUNT(f.id) FILTER (WHERE f.rating = 'thumbs_up')::FLOAT
                / COUNT(f.id) * 100)::NUMERIC, 1
             )
           ELSE NULL END                                                      AS feedback_rate_pct,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY m.latency_ms)         AS p50_ms,
           ROUND(AVG(m.latency_ms)::NUMERIC, 0)                              AS avg_ms,
           ROUND(
             (COUNT(*) FILTER (WHERE NOT m.success)::FLOAT
              / NULLIF(COUNT(*), 0) * 100)::NUMERIC, 1
           )                                                                  AS error_rate_pct,
           MIN(m.started_at)                                                  AS first_seen,
           MAX(m.started_at)                                                  AS last_seen,
           $2::INTEGER                                                        AS min_feedback,
           (COUNT(f.id) >= $2)                                                AS meets_min_feedback
         FROM ai_call_metrics m
         LEFT JOIN ai_call_feedback f ON f.call_id = m.id
         WHERE m.started_at >= NOW() - MAKE_INTERVAL(days => $1)
           AND m.tool_name IS NULL
         GROUP BY m.agent_name, COALESCE(m.metadata ->> 'prompt_version', '(unknown)')
       ),
       global_last AS (
         SELECT
           agent_name,
           COALESCE(metadata ->> 'prompt_version', '(unknown)')              AS prompt_version,
           MAX(started_at)                                                    AS last_seen_at
         FROM ai_call_metrics
         WHERE tool_name IS NULL
         GROUP BY agent_name, COALESCE(metadata ->> 'prompt_version', '(unknown)')
       )
       SELECT w.*, g.last_seen_at
       FROM windowed w
       JOIN global_last g
         ON g.agent_name = w.agent_name AND g.prompt_version = w.prompt_version
       ORDER BY w.agent_name, g.last_seen_at DESC`,
      [days, floor]
    );
    return result.rows;
  } catch (err) {
    console.error('[aiTelemetry] getFeedbackRateByPromptVersion failed:', err);
    return [];
  }
}

export async function getRecentNegativeFeedback(limit = 25): Promise<{
  feedback_id: string;
  call_id: string;
  agent_name: string;
  model: string;
  comment: string | null;
  created_at: string;
  call_started_at: string;
  prompt_preview: string | null;
  latency_ms: number;
  success: boolean;
  error_class: string | null;
}[]> {
  try {
    await ensureFeedbackTable();
    const result = await pool.query(
      `SELECT
         f.id           AS feedback_id,
         f.call_id      AS call_id,
         f.comment      AS comment,
         f.created_at   AS created_at,
         m.agent_name   AS agent_name,
         m.model        AS model,
         m.started_at   AS call_started_at,
         m.prompt_preview,
         m.latency_ms,
         m.success,
         m.error_class
       FROM ai_call_feedback f
       JOIN ai_call_metrics  m ON m.id = f.call_id
       WHERE f.rating = 'thumbs_down'
         AND f.created_at >= NOW() - INTERVAL '30 days'
       ORDER BY f.created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  } catch (err) {
    console.error('[aiTelemetry] getRecentNegativeFeedback failed:', err);
    return [];
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
     WHERE started_at >= NOW() - INTERVAL '24 hours'
       AND tool_name IS NULL`
  );
  const row = result.rows[0];
  return {
    totalCostUsd:   parseFloat(row.total_cost_usd)  || 0,
    callCount:      parseInt(row.call_count)         || 0,
    errorCount:     parseInt(row.error_count)        || 0,
    avgLatencyMs:   parseFloat(row.avg_latency_ms)   || 0,
  };
}
