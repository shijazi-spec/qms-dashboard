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

import pg from "pg";
const { Pool } = pg;
import { createHash } from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "./logger";
import {
  redactSensitiveDeep,
  redactSecretLikeStrings,
  deepRedactSecretLikeStrings,
} from "./eventLogsDatabase";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ──────────────────────────────────────────────────────────────────────────────
// Price table — USD per 1 000 tokens
// ──────────────────────────────────────────────────────────────────────────────
export const MODEL_PRICE_TABLE: Record<
  string,
  { inputPer1k: number; outputPer1k: number }
> = {
  "gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01 },
  "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  "gpt-4-turbo": { inputPer1k: 0.01, outputPer1k: 0.03 },
  "gpt-4": { inputPer1k: 0.03, outputPer1k: 0.06 },
  "gpt-3.5-turbo": { inputPer1k: 0.0005, outputPer1k: 0.0015 },
  "gpt-4o-2024-11-20": { inputPer1k: 0.0025, outputPer1k: 0.01 },
  "gpt-4o-2024-08-06": { inputPer1k: 0.0025, outputPer1k: 0.01 },
};

function computeCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const key =
    Object.keys(MODEL_PRICE_TABLE).find((k) => model.startsWith(k)) ?? "gpt-4o";
  const prices = MODEL_PRICE_TABLE[key];
  return (
    (promptTokens / 1000) * prices.inputPer1k +
    (completionTokens / 1000) * prices.outputPer1k
  );
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

const PII_PATTERNS: [RegExp, string][] = [
  [/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[EMAIL]"],
  [/\b(?:\+?\d{1,3}[\s-])?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[PHONE]"],
  [/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, "[CARD]"],
  [/\b(?:password|secret|token|key|auth)\s*[:=]\s*\S+/gi, "[REDACTED]"],
];

/**
 * Scrub a string destined for the `ai_call_metrics.error_message` TEXT column.
 *
 * Tool / LLM error strings frequently echo the input that triggered them
 * (e.g. "Connection failed with key sk-live-…"), so we route every write
 * path through the regex deny-list in `redactSecretLikeStrings()` BEFORE
 * truncating to the column's 500-char budget. Returns null for empty input
 * so callers can pass the redacted result straight into a SQL parameter.
 *
 * Mirrors the protection already applied to `prompt_preview`,
 * `tool_input_preview`, `tool_output_preview`, and the `execution_result.error`
 * leaf in `ai_pending_actions` (Task #256).
 */
export function redactErrorMessageForStorage(
  message: string | null | undefined,
): string | null {
  if (!message) return null;
  const scrubbed = String(redactSecretLikeStrings(message));
  return scrubbed.slice(0, 500);
}

/**
 * Closed allow-list of keys that may appear in `ai_call_metrics.metadata`.
 *
 * Replaces the historical `Record<string, unknown>` shape so a developer
 * cannot accidentally pass `{ note: caughtError.message, debug: rawHeaders }`
 * from a `catch` block — which would land plaintext credentials in the
 * JSONB column. The WRITE-path scrubber `redactMetadataForStorage()`
 * defends against that one layer too late: by the time it runs, the
 * secret has already been constructed in memory and (typically) logged
 * to stdout via logger.error / Pino BEFORE telemetry redacts it for
 * the DB. This typed shape is the source-side prevention; build it via
 * `buildAiCallTelemetryMetadata()`.
 *
 * To add a new key:
 *   1. Add the snake_case field here.
 *   2. Add the camelCase field on `AiCallTelemetryMetadataInput`.
 *   3. Map it in `buildAiCallTelemetryMetadata()`.
 *   4. Update the test in `src/utils/__tests__/aiTelemetryMetadata.test.ts`.
 */
export interface AiCallTelemetryMetadata {
  /** Stable hash of the agent's instruction prompt (e.g. `qms@deadbeef`). */
  prompt_version?: string;
  /** Identifier for an A/B feature flag bucket. */
  feature_flag?: string;
  /** Identifier for an experiment arm (e.g. `control`, `treatment-1`). */
  experiment_arm?: string;
  /** Sampling temperature used for the call. */
  agent_temperature?: number;
  /** Name of the orchestrating workflow (e.g. `qualityAuditWorkflow`). */
  workflow?: string;
  /** Step within a workflow (e.g. `sdr-audit`, `sales-audit`). */
  step?: string;
  /** Background-scan kind (e.g. `platform_scan`). */
  scan_type?: string;
  /**
   * Surface that produced the call / rating (e.g. `web`, `mobile`, `slack`,
   * `embedded`). Mirrors the same field on `AiCallFeedbackMetadata` and
   * is read by the per-surface breakdown in
   * `getFeedbackBreakdownByPromptVersion()`. Task #763 made the call-id
   * rating endpoint backfill this onto legacy rows that lack one so
   * Slack / mobile / embedded ratings attribute correctly.
   */
  client_surface?: string;
}

/**
 * camelCase mirror of `AiCallTelemetryMetadata` used as the input shape
 * for `buildAiCallTelemetryMetadata()`. Keeping the snake_case ↔ camelCase
 * boundary inside the helper means call-sites read naturally in TS while
 * the persisted JSONB stays in the snake_case shape that
 * `metadata->>'prompt_version'` SQL expressions already query.
 */
export interface AiCallTelemetryMetadataInput {
  promptVersion?: string;
  featureFlag?: string;
  experimentArm?: string;
  agentTemperature?: number;
  workflow?: string;
  step?: string;
  scanType?: string;
  clientSurface?: string;
}

const TELEMETRY_METADATA_KEY_MAP: Record<
  keyof AiCallTelemetryMetadataInput,
  keyof AiCallTelemetryMetadata
> = {
  promptVersion: "prompt_version",
  featureFlag: "feature_flag",
  experimentArm: "experiment_arm",
  agentTemperature: "agent_temperature",
  workflow: "workflow",
  step: "step",
  scanType: "scan_type",
  clientSurface: "client_surface",
};

/**
 * Brand applied to the value returned by `buildAiCallTelemetryMetadata()`.
 *
 * The three public telemetry entry points (`withAiTelemetry()`,
 * `startTelemetrySpan()`, `recordStreamTelemetry()`) accept `metadata` only
 * if it carries this brand — i.e. only if it was produced by the helper.
 * An inline object literal like `{ prompt_version: ver, ...debugDump }` no
 * longer type-checks at those sites, so the source-side allow-list cannot
 * be silently bypassed by spreading a `catch (err)` payload into the call
 * (which is the leak path Task #484 originally closed for non-streaming
 * callers — Task #511 extends the same enforcement to the streaming path
 * before any future caller wires it up).
 *
 * Implementation note: a `unique symbol` brand is structurally
 * unforgeable in TypeScript without an explicit `as` cast, which
 * preserves an audit-trail in code review whenever a test intentionally
 * bypasses the contract to exercise the runtime scrubber.
 */
declare const builtAiCallTelemetryMetadataBrand: unique symbol;
export type BuiltAiCallTelemetryMetadata = AiCallTelemetryMetadata & {
  readonly [builtAiCallTelemetryMetadataBrand]: true;
};

/**
 * Build a typed `metadata` payload for `ai_call_metrics` rows.
 *
 * MUST be used at every `withAiTelemetry()` / `startTelemetrySpan()` /
 * `recordStreamTelemetry()` call site instead of an inline object literal.
 * The closed allow-list (see `AiCallTelemetryMetadataInput`) prevents the
 * pattern of stuffing dynamic strings derived from `catch (err)`, raw
 * HTTP headers, or tool output into `metadata` — which would land
 * plaintext credentials in the JSONB column.
 *
 * Defense-in-depth runtime guard: even if a caller bypasses the type
 * system via `as any`, unexpected keys are dropped and a
 * structured warn is emitted with an actionable message so the regression
 * shows up in the operator console rather than silently persisting.
 *
 * The return value carries the {@link BuiltAiCallTelemetryMetadata} brand
 * so the three public telemetry entry points only accept builder output.
 * An inline literal at those sites stops type-checking entirely — the
 * leak class can no longer slip in even if a future feature wires up
 * streaming telemetry without re-reading these comments.
 */
export function buildAiCallTelemetryMetadata(
  input: AiCallTelemetryMetadataInput,
): BuiltAiCallTelemetryMetadata {
  const out: AiCallTelemetryMetadata = {};
  const loose = input as Record<string, unknown>;
  for (const inputKey of Object.keys(loose)) {
    const mapped =
      TELEMETRY_METADATA_KEY_MAP[
        inputKey as keyof AiCallTelemetryMetadataInput
      ];
    if (!mapped) {
      logger.warn(
        `[aiTelemetry] buildAiCallTelemetryMetadata received unexpected key "${inputKey}". ` +
          `Allowed keys: ${Object.keys(TELEMETRY_METADATA_KEY_MAP).join(", ")}. ` +
          `The key was dropped to prevent credential-shaped substrings from reaching ai_call_metrics.metadata.`,
      );
      continue;
    }
    const value = loose[inputKey];
    if (value === undefined) continue;
    (out as Record<string, unknown>)[mapped] = value;
  }
  // The brand is a phantom field — the runtime payload is a plain object
  // with the snake_case allow-list keys and nothing else.
  return out as BuiltAiCallTelemetryMetadata;
}

/**
 * Scrub the caller-supplied `metadata` JSONB blob destined for
 * `ai_call_metrics.metadata` before it is `JSON.stringify`-ed into the
 * INSERT/OPEN parameter slot.
 *
 * Mirrors `redactErrorMessageForStorage()` but for structured payloads:
 * runs every string leaf through `deepRedactSecretLikeStrings()` so a
 * careless caller cannot land a credential-shaped substring (sk-…, ghp_…,
 * JWT, bcrypt hash, AWS key) under an innocuous key like `metadata.note`
 * and have it persist in plaintext until the daily
 * `backfillAiCallMetricsRedaction()` sweep catches it (Task #475 added the
 * `metadata` column to that sweep; this defends the WRITE path so the
 * plaintext never reaches the table in the first place).
 *
 * Note: this is the second layer of defense. The first is the typed
 * `AiCallTelemetryMetadata` allow-list enforced at the call site by
 * `buildAiCallTelemetryMetadata()` (Task #484), which prevents free-form
 * keys derived from `catch (err)` / raw headers / tool output from ever
 * being constructed in memory in the first place.
 *
 * Returns a plain object — never null — so callers can pass the result
 * straight into `JSON.stringify` without an extra `?? {}`.
 */
export function redactMetadataForStorage(
  metadata:
    | AiCallTelemetryMetadata
    | Record<string, unknown>
    | null
    | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  const scrubbed = deepRedactSecretLikeStrings(metadata);
  if (scrubbed && typeof scrubbed === "object" && !Array.isArray(scrubbed)) {
    return scrubbed as Record<string, unknown>;
  }
  return {};
}

export function redactPromptPreview(prompt: string, maxLen = 300): string {
  // Run the secret-like deny list (sk-…, ghp_…, JWTs, bcrypt hashes, AWS
  // access keys, etc.) BEFORE the basic PII_PATTERNS pass so prompt_preview
  // gets the same protection as tool_input_preview / tool_output_preview.
  let preview = String(redactSecretLikeStrings(prompt)).slice(0, maxLen + 100);
  for (const [pattern, replacement] of PII_PATTERNS) {
    preview = preview.replace(pattern, replacement);
  }
  return preview.slice(0, maxLen);
}

/**
 * Stringify-and-redact arbitrary tool input/output payloads for the
 * `tool_input_preview` / `tool_output_preview` columns.
 *
 * Applies two layers of protection before the final PII_PATTERNS pass:
 *   1. For object payloads — `redactSensitiveDeep()` from eventLogsDatabase,
 *      which covers key-based deny list (api_key, authorization, password …)
 *      AND regex patterns (sk-…, ghp_…, JWTs, bcrypt hashes, AWS keys, etc.).
 *   2. For string payloads — `redactSecretLikeStrings()` which applies the
 *      same regex deny list to free-form text (e.g. error messages).
 *   3. Finally, `redactPromptPreview()` applies the PII_PATTERNS (emails,
 *      phones, cards, generic `token=…` / `key=…` patterns) and caps length.
 *
 * Returns undefined for null/undefined so we don't store an empty string.
 */
export function redactToolPayloadPreview(
  payload: unknown,
  maxLen = 300,
): string | undefined {
  if (payload === undefined || payload === null) return undefined;
  let asString: string;
  if (typeof payload === "string") {
    asString = String(redactSecretLikeStrings(payload));
  } else {
    try {
      const deepRedacted = redactSensitiveDeep(payload);
      asString = JSON.stringify(deepRedacted);
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
        -- Task #467: breadcrumb populated by the historical preview-redaction
        -- sweep (see redactAiCallMetrics in src/utils/redactHistoricalLogs.ts)
        -- whenever it rewrites any of prompt_preview / tool_input_preview /
        -- tool_output_preview on a row that pre-dated the write-time redactor.
        -- The AI Operations call-detail panel surfaces this as an info badge
        -- so auditors can tell the preview was retroactively cleaned vs.
        -- originally written that way. Nullable on purpose: only rows the
        -- sweep actually touched carry a timestamp, so reads can distinguish
        -- "swept once on YYYY-MM-DD" from "never needed sweeping".
        ALTER TABLE ai_call_metrics
          ADD COLUMN IF NOT EXISTS previews_redacted_at TIMESTAMPTZ;

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

        -- Speeds up getChildToolCallsForParent which filters by parent_call_id.
        -- Partial index skips the majority of rows that are top-level calls.
        CREATE INDEX IF NOT EXISTS idx_ai_call_metrics_parent_call_id
          ON ai_call_metrics (parent_call_id)
          WHERE parent_call_id IS NOT NULL;
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
  metadata?: AiCallTelemetryMetadata;
}

export async function insertAiCallMetric(
  row: AiCallMetricRow,
): Promise<number | null> {
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
        redactErrorMessageForStorage(row.error_message),
        row.prompt_preview ?? null,
        row.tool_input_preview ?? null,
        row.tool_output_preview ?? null,
        row.user_hash ?? null,
        row.session_hash ?? null,
        JSON.stringify(redactMetadataForStorage(row.metadata)),
      ],
    );
    return result.rows[0]?.id ?? null;
  } catch (err) {
    logger.error("[aiTelemetry] Failed to insert metric:", err);
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
  metadata?: AiCallTelemetryMetadata;
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
        JSON.stringify(redactMetadataForStorage(params.metadata)),
      ],
    );
    return result.rows[0]?.id ?? null;
  } catch (err) {
    logger.error("[aiTelemetry] Failed to open metric:", err);
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
  },
): Promise<void> {
  try {
    const cost =
      finals.promptTokens != null && finals.completionTokens != null
        ? computeCost(
            finals.model,
            finals.promptTokens,
            finals.completionTokens,
          )
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
        redactErrorMessageForStorage(finals.errorMessage),
      ],
    );
  } catch (err) {
    logger.error("[aiTelemetry] Failed to finalize metric:", err);
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

export async function startTelemetrySpan(
  params: WithAiTelemetryParams,
): Promise<TelemetrySpan> {
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
  /**
   * Branded so only `buildAiCallTelemetryMetadata()` output is accepted —
   * an inline `{ ... }` literal stops type-checking entirely and the
   * source-side allow-list cannot be silently bypassed by spreading a
   * `catch (err)` payload into the call. See {@link BuiltAiCallTelemetryMetadata}.
   */
  metadata?: BuiltAiCallTelemetryMetadata;
}

export async function withAiTelemetry<T>(
  params: WithAiTelemetryParams,
  fn: () => Promise<T>,
): Promise<{ result: T; callId: number | null }> {
  const span = await startTelemetrySpan(params);

  try {
    const result = await span.run(fn);

    const res = result as Record<string, unknown>;
    const rawUsage =
      (res?.usage as Record<string, unknown> | undefined) ??
      ((res?.rawResponse as Record<string, unknown> | undefined)?.usage as
        | Record<string, unknown>
        | undefined) ??
      null;
    const promptTokens =
      typeof rawUsage?.promptTokens === "number"
        ? rawUsage.promptTokens
        : typeof rawUsage?.prompt_tokens === "number"
          ? rawUsage.prompt_tokens
          : undefined;
    const completionTokens =
      typeof rawUsage?.completionTokens === "number"
        ? rawUsage.completionTokens
        : typeof rawUsage?.completion_tokens === "number"
          ? rawUsage.completion_tokens
          : undefined;
    const totalTokens =
      typeof rawUsage?.totalTokens === "number"
        ? rawUsage.totalTokens
        : typeof rawUsage?.total_tokens === "number"
          ? rawUsage.total_tokens
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
      errorClass: err instanceof Error ? err.constructor.name : "UnknownError",
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
// Mastra's current Tool<...> emits an `execute` whose first argument is a
// strongly-typed context object (e.g. `{ context: Input, runtimeContext, ... }`)
// and which optionally takes a second `MastraToolInvocationOptions` argument.
// We don't care about the exact shape at the telemetry layer — we only need to
// forward whatever arguments the LLM runtime hands us. Using `any[]` for the
// parameter list (instead of `unknown` / a fixed-arity tuple) lets this type
// stay assignable from any concrete `Tool<...>` instance regardless of how
// narrowly Mastra has typed its input/output schemas. Behavior is unchanged.
type WrappableTool = {
  id?: string;
  description?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute?: (...args: any[]) => Promise<any>;
};

function describeToolFailure(result: unknown): string | null {
  if (result === null || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (r.success !== false) return null;
  if (r.queued === true) return null; // HITL-gated queue is not an error
  if (typeof r.error === "string") return r.error;
  if (typeof r.message === "string") return r.message;
  return "Tool returned success=false";
}

export function wrapToolWithTelemetry<T extends WrappableTool>(
  tool: T,
  agentName: string,
): T {
  const originalExecute = tool.execute;
  const toolId = tool.id;
  if (!originalExecute || !toolId) return tool;

  const wrappedExecute = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...args: any[]
  ): Promise<unknown> => {
    const startedAt = Date.now();
    const parentCallId = getCurrentParentCallId();
    let success = true;
    let errorClass: string | undefined;
    let errorMessage: string | undefined;
    // Capture sanitized previews of the LLM-provided input and (truncated)
    // output so ops teams can reproduce a failing tool call without us
    // ever persisting raw secrets / PII. Both are ≤300 chars after the
    // same PII redaction rules used for prompt_preview.
    const toolInputPreview = redactToolPayloadPreview(args[0]);
    let toolOutputPreview: string | undefined;

    try {
      const result = await originalExecute(...args);
      toolOutputPreview = redactToolPayloadPreview(result);

      // Tools standardize on { success: boolean, ...}.
      // Treat soft-fail returns as errors UNLESS they are HITL-gated queues
      // (which are an expected, non-error outcome of a write tool).
      const failureMessage = describeToolFailure(result);
      if (failureMessage !== null) {
        success = false;
        errorClass = "ToolReturnedFailure";
        errorMessage = failureMessage;
      }
      return result;
    } catch (err) {
      success = false;
      errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
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
        model: "tool",
        latency_ms: latencyMs,
        success,
        error_class: errorClass,
        error_message: errorMessage,
        tool_input_preview: toolInputPreview,
        tool_output_preview: toolOutputPreview,
      }).catch(() => {
        /* non-fatal */
      });
    }
  };

  // Clone the tool so we don't mutate the shared instance, then swap in the
  // telemetry-wrapped execute. Cloning via Object.assign preserves the
  // tool's prototype (e.g. Mastra's Tool class) and all original fields
  // (id, description, inputSchema, outputSchema, requireApproval, etc.).
  const proto = Object.getPrototypeOf(tool) as object | null;
  const cloned = Object.assign(proto ? Object.create(proto) : {}, tool, {
    execute: wrappedExecute as unknown as T["execute"],
  }) as T;
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
/**
 * Params for `recordStreamTelemetry()`.
 *
 * Exported as a named interface (rather than left as an inline object-type
 * literal on the function signature) so the brand-contract test in
 * `src/utils/__tests__/aiTelemetryMetadata.test.ts` can hold this shape
 * to the same `// @ts-expect-error` directive that already locks the
 * non-streaming entry points (`withAiTelemetry()` / `startTelemetrySpan()`
 * share `WithAiTelemetryParams`). Without a named interface, a future
 * refactor that accidentally widened `metadata` back to
 * `AiCallTelemetryMetadata` (or replaced the brand with the bare
 * allow-list) would still pass the existing tests — only the runtime
 * guardrail script would catch the regression. See Task #582.
 */
export interface RecordStreamTelemetryParams {
  agentName: string;
  model: string;
  startedAt: number;
  stream: {
    usage?: Promise<{
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    }>;
  } | null;
  success: boolean;
  errorClass?: string;
  errorMessage?: string;
  promptText?: string;
  userId?: string;
  sessionId?: string;
  /**
   * Branded so only `buildAiCallTelemetryMetadata()` output is accepted —
   * mirrors the enforcement on `withAiTelemetry()` / `startTelemetrySpan()`
   * so a future caller wiring up streaming telemetry cannot land
   * `metadata: { prompt_version: ver, ...debugDump }` and leak the spread
   * payload into ai_call_metrics.metadata. See {@link BuiltAiCallTelemetryMetadata}.
   */
  metadata?: BuiltAiCallTelemetryMetadata;
}

export async function recordStreamTelemetry(params: RecordStreamTelemetryParams): Promise<number | null> {
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
        new Promise<null>((res) => setTimeout(() => res(null), 2000)),
      ]);
      if (usage) {
        promptTokens = usage.promptTokens ?? usage.prompt_tokens ?? undefined;
        completionTokens =
          usage.completionTokens ?? usage.completion_tokens ?? undefined;
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
// Configurable retention pruning — called from the daily cost-summary cron
//
// `ai_call_metrics` is append-only, so without an automatic prune the table
// grows without bound. With high-volume agents this slows every query (even
// the indexed ones) over time. The daily cron runs `pruneOldAiMetrics()` to
// delete rows whose `started_at` is older than the configured retention
// window.
//
// Operators tune the window via the `AI_METRICS_RETENTION_DAYS` env var
// (default 90). Values are clamped to >= 1 day so a misconfiguration cannot
// wipe rows newer than 24h. Non-numeric / NaN / <= 0 values fall back to the
// default. An explicit argument to `pruneOldAiMetrics(retentionDays)` always
// wins over the env var, which is useful for tests and one-off sweeps.
// ──────────────────────────────────────────────────────────────────────────────
export const DEFAULT_AI_METRICS_RETENTION_DAYS = 90;

/**
 * Resolve the effective retention window (in days) for `ai_call_metrics`.
 * Reads `AI_METRICS_RETENTION_DAYS` from the environment, validates it as a
 * positive integer, and clamps to a minimum of 1. Falls back to
 * {@link DEFAULT_AI_METRICS_RETENTION_DAYS} when the env var is absent,
 * non-numeric, NaN, zero, or negative.
 */
export function resolveAiMetricsRetentionDays(): number {
  const raw = process.env.AI_METRICS_RETENTION_DAYS;
  if (raw == null || raw === "") return DEFAULT_AI_METRICS_RETENTION_DAYS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AI_METRICS_RETENTION_DAYS;
  }
  return Math.max(1, Math.floor(parsed));
}

/**
 * Resolve the EFFECTIVE retention window (in days) consulted by the
 * daily prune cron. Layers in precedence:
 *
 *   1. `AI_METRICS_RETENTION_DAYS_LOCK` (truthy) — forces the env-derived
 *      value to win regardless of any DB override (Task #504).
 *   2. The `ai_metrics_retention_config` row written by the AI Ops
 *      "Retention" control on the dashboard, if a positive integer.
 *   3. {@link resolveAiMetricsRetentionDays} (env var → default).
 *
 * Done as a separate async function so the env-only sync resolver above
 * stays available to callers that can't afford to await a DB hit (and so
 * the existing pure unit tests for env parsing keep working unchanged).
 *
 * Failures reading the override row fall back silently to the env-only
 * resolver — a transient DB hiccup should never cause the cron to wipe
 * rows that the operator wanted to keep.
 */
export async function resolveEffectiveAiMetricsRetentionDays(): Promise<number> {
  const envValue = resolveAiMetricsRetentionDays();
  try {
    const { isAiMetricsRetentionLocked, getAiMetricsRetentionConfig } =
      await import("./aiMetricsRetentionConfig");
    if (isAiMetricsRetentionLocked()) return envValue;
    const cfg = await getAiMetricsRetentionConfig();
    if (
      cfg.retention_days != null &&
      Number.isFinite(cfg.retention_days) &&
      cfg.retention_days > 0
    ) {
      return Math.max(1, Math.floor(cfg.retention_days));
    }
    return envValue;
  } catch (err) {
    logger.error(
      "[aiTelemetry] resolveEffectiveAiMetricsRetentionDays fallback:",
      err,
    );
    return envValue;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Prune-run history table — bootstrap (idempotent, called from pruneOldAiMetrics)
//
// Records the result of every `pruneOldAiMetrics()` invocation so the AI
// Operations dashboard can surface the most recent prune cron run alongside
// total row count and oldest-row age. Without this, admins have no way to
// tell whether the daily prune is keeping up with insert volume.
// ──────────────────────────────────────────────────────────────────────────────
let pruneRunsTableReady: Promise<void> | null = null;

async function ensurePruneRunsTable(): Promise<void> {
  if (pruneRunsTableReady) return pruneRunsTableReady;
  pruneRunsTableReady = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ai_metrics_prune_runs (
          id              BIGSERIAL PRIMARY KEY,
          ran_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          retention_days  INTEGER     NOT NULL,
          rows_deleted    INTEGER     NOT NULL DEFAULT 0,
          duration_ms     INTEGER     NOT NULL DEFAULT 0,
          success         BOOLEAN     NOT NULL DEFAULT TRUE,
          error_message   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ai_metrics_prune_runs_ran_at
          ON ai_metrics_prune_runs (ran_at DESC);
      `);
    } catch (err) {
      pruneRunsTableReady = null;
      throw err;
    }
  })();
  return pruneRunsTableReady;
}

async function recordPruneRun(row: {
  retention_days: number;
  rows_deleted: number;
  duration_ms: number;
  success: boolean;
  error_message?: string | null;
}): Promise<void> {
  try {
    await ensurePruneRunsTable();
    await pool.query(
      `INSERT INTO ai_metrics_prune_runs
         (retention_days, rows_deleted, duration_ms, success, error_message)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        row.retention_days,
        row.rows_deleted,
        row.duration_ms,
        row.success,
        redactErrorMessageForStorage(row.error_message),
      ],
    );
  } catch (err) {
    logger.error("[aiTelemetry] Failed to record prune run:", err);
  }
}

export async function pruneOldAiMetrics(
  retentionDays?: number,
): Promise<number> {
  const startedAt = Date.now();
  const days =
    typeof retentionDays === "number" &&
    Number.isFinite(retentionDays) &&
    retentionDays > 0
      ? Math.max(1, Math.floor(retentionDays))
      : resolveAiMetricsRetentionDays();
  try {
    await ensureAiMetricsTable();
    const result = await pool.query(
      `DELETE FROM ai_call_metrics WHERE started_at < NOW() - MAKE_INTERVAL(days => $1)`,
      [days],
    );
    const deleted = result.rowCount ?? 0;
    await recordPruneRun({
      retention_days: days,
      rows_deleted: deleted,
      duration_ms: Date.now() - startedAt,
      success: true,
    });
    return deleted;
  } catch (err) {
    logger.error("[aiTelemetry] Pruning failed:", err);
    await recordPruneRun({
      retention_days: days,
      rows_deleted: 0,
      duration_ms: Date.now() - startedAt,
      success: false,
      error_message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Composed prune step used by the daily `ai-cost-summary` Inngest cron
 * (Task #565). Resolves the EFFECTIVE retention window via
 * {@link resolveEffectiveAiMetricsRetentionDays} (so the dashboard
 * override written through the AI Operations UI is honoured on the very
 * next pass — no redeploy needed) and then runs
 * {@link pruneOldAiMetrics} with that value.
 *
 * Extracted from the cron handler so an integration test can invoke
 * exactly the same composition as the cron — preventing a future
 * refactor that drops the `await` on the effective resolver, or starts
 * caching the env value across runs, from slipping through unnoticed.
 *
 * Returns `{ retentionDays, rowsDeleted }` so callers (test or
 * production cron) can log/assert what window was actually applied and
 * how many rows it removed.
 */
export async function runAiMetricsPruneCronStep(): Promise<{
  retentionDays: number;
  rowsDeleted: number;
}> {
  const retentionDays = await resolveEffectiveAiMetricsRetentionDays();
  const rowsDeleted = await pruneOldAiMetrics(retentionDays);
  return { retentionDays, rowsDeleted };
}

// ──────────────────────────────────────────────────────────────────────────────
// Table-size telemetry — backs the "Storage Health" KPI tiles on /ai-ops
// (Task #505). Surfaces total row count, oldest-row age in days, and the
// most recent prune cron run so admins can tell at a glance whether the
// configured retention window is keeping the table at a reasonable size.
// ──────────────────────────────────────────────────────────────────────────────
export interface AiMetricsTableStats {
  rowCount: number;
  oldestStartedAt: string | null;
  oldestAgeDays: number | null;
  retentionDays: number;
  exceedsRetention: boolean;
  lastPrune: {
    ranAt: string;
    retentionDays: number;
    rowsDeleted: number;
    durationMs: number;
    success: boolean;
    errorMessage: string | null;
  } | null;
}

export async function getAiMetricsTableStats(): Promise<AiMetricsTableStats> {
  await ensureAiMetricsTable();
  await ensurePruneRunsTable();
  const retentionDays = resolveAiMetricsRetentionDays();

  // Single round-trip: row count + oldest started_at + age in days.
  const sizeResult = await pool.query(
    `SELECT
       COUNT(*)::BIGINT                                              AS row_count,
       MIN(started_at)                                                AS oldest_started_at,
       EXTRACT(EPOCH FROM (NOW() - MIN(started_at))) / 86400.0        AS oldest_age_days
     FROM ai_call_metrics`,
  );
  const sizeRow = sizeResult.rows[0] ?? {};
  const rowCount = Number(sizeRow.row_count ?? 0);
  const oldestStartedAt = sizeRow.oldest_started_at
    ? new Date(sizeRow.oldest_started_at).toISOString()
    : null;
  const oldestAgeDays =
    sizeRow.oldest_age_days != null ? Number(sizeRow.oldest_age_days) : null;

  const pruneResult = await pool.query(
    `SELECT ran_at, retention_days, rows_deleted, duration_ms, success, error_message
       FROM ai_metrics_prune_runs
      ORDER BY ran_at DESC
      LIMIT 1`,
  );
  const lastPruneRow = pruneResult.rows[0];
  const lastPrune = lastPruneRow
    ? {
        ranAt: new Date(lastPruneRow.ran_at).toISOString(),
        retentionDays: Number(lastPruneRow.retention_days),
        rowsDeleted: Number(lastPruneRow.rows_deleted),
        durationMs: Number(lastPruneRow.duration_ms),
        success: Boolean(lastPruneRow.success),
        errorMessage: lastPruneRow.error_message ?? null,
      }
    : null;

  // The prune is "failing or behind schedule" when at least one row exists
  // older than the configured retention window. A small grace allowance
  // (the cron only runs once per day) is intentionally NOT applied here —
  // the dashboard tile owns the visual styling and can pick its own
  // threshold for amber vs red if desired in the future.
  const exceedsRetention =
    oldestAgeDays != null && oldestAgeDays > retentionDays;

  return {
    rowCount,
    oldestStartedAt,
    oldestAgeDays,
    retentionDays,
    exceedsRetention,
    lastPrune,
  };
}

/**
 * Recent prune-run history for the AI Ops dashboard (Task #559).
 *
 * Returns the last `limit` rows from `ai_metrics_prune_runs` in
 * reverse-chronological order so admins can see the rolling history of
 * pruned-row counts and spot retention spikes (e.g. an ingest burst that
 * is silently aging out useful telemetry, or a tightened window that
 * just started chopping rows). Reuses the same table the daily cron
 * already writes to from {@link pruneOldAiMetrics} — no separate
 * `ai_metrics_prune_history` table is needed because the existing one
 * already captures the (date, retention_days_used, rows_deleted,
 * run_duration_ms) tuple the dashboard wants.
 *
 * `limit` is clamped to [1, 365]; non-finite / non-positive values fall
 * back to a safe default of 30 (matches the dashboard's "last 30 daily
 * passes" framing).
 */
export interface AiMetricsPruneRunHistoryEntry {
  id: number;
  ranAt: string;
  retentionDays: number;
  rowsDeleted: number;
  durationMs: number;
  success: boolean;
  errorMessage: string | null;
}

export async function getAiMetricsPruneRunHistory(
  limit?: number,
): Promise<AiMetricsPruneRunHistoryEntry[]> {
  const fallback = 30;
  let n: number;
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    n = Math.floor(limit);
  } else {
    n = fallback;
  }
  if (n < 1) n = 1;
  if (n > 365) n = 365;
  await ensurePruneRunsTable();
  const result = await pool.query(
    `SELECT id, ran_at, retention_days, rows_deleted, duration_ms, success, error_message
       FROM ai_metrics_prune_runs
      ORDER BY ran_at DESC
      LIMIT $1`,
    [n],
  );
  return result.rows.map((r: any) => ({
    id: Number(r.id),
    ranAt: new Date(r.ran_at).toISOString(),
    retentionDays: Number(r.retention_days),
    rowsDeleted: Number(r.rows_deleted),
    durationMs: Number(r.duration_ms),
    success: Boolean(r.success),
    errorMessage: r.error_message ?? null,
  }));
}

/**
 * Dry-run counterpart of {@link pruneOldAiMetrics} (Task #550).
 *
 * Returns how many `ai_call_metrics` rows WOULD be removed by the next
 * cron pass if the retention window were tightened to `retentionDays`.
 * Re-uses the exact same `started_at < NOW() - MAKE_INTERVAL(...)`
 * predicate as the prune itself so the dashboard preview can never drift
 * from what the cron actually deletes.
 *
 * Throws on invalid input rather than silently returning 0 — the caller
 * (the AI Ops route) validates the value against
 * `AI_METRICS_RETENTION_BOUNDS` first, so reaching this function with a
 * non-positive value is a programmer error.
 */
export async function countAiMetricsOlderThan(
  retentionDays: number,
): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error("retentionDays must be a positive number");
  }
  await ensureAiMetricsTable();
  const days = Math.max(1, Math.floor(retentionDays));
  const result = await pool.query<{ count: string | number | null }>(
    `SELECT COUNT(*)::bigint AS count
       FROM ai_call_metrics
      WHERE started_at < NOW() - MAKE_INTERVAL(days => $1)`,
    [days],
  );
  const raw = result.rows[0]?.count ?? 0;
  // pg returns BIGINT as a string by default. Coerce safely; the table is
  // pruned daily so the value will always fit in a JS Number long-term,
  // but we still guard against NaN from an unexpected payload shape.
  const n = typeof raw === "string" ? Number(raw) : raw;
  return Number.isFinite(n) ? Number(n) : 0;
}

/**
 * Result of a dry-run prune impact preview (Task #561).
 *
 * `rowCount` is the number of rows that WOULD be deleted by the next prune
 * pass at the candidate retention window. `oldestRowAgeDays` is the age in
 * days of the oldest row in the deletion bucket — i.e. `MIN(started_at)`
 * among rows older than the candidate window. `daysToDelete` is the span
 * of telemetry (in whole days, rounded up) that would be removed:
 * `ceil(oldestRowAgeDays) - candidateDays`. Both age fields are `null` /
 * `0` when no rows are older than the candidate window.
 */
export interface AiMetricsPruneImpactPreview {
  candidateDays: number;
  rowCount: number;
  oldestRowAgeDays: number | null;
  daysToDelete: number;
}

/**
 * Live impact preview for the dashboard's retention edit form (Task #561).
 *
 * Reports BOTH the row count AND the time span of telemetry that the next
 * prune cron tick would delete if the operator saved `candidateDays`. The
 * dashboard needs the days-span figure so the inline confirm step can say
 * "this will delete ~80 days of telemetry" even when the row volume is
 * relatively small (e.g. a quiet test environment). Computed in a single
 * round-trip and re-uses the same `started_at < NOW() - MAKE_INTERVAL`
 * predicate as `pruneOldAiMetrics()` and `countAiMetricsOlderThan()` so
 * the preview cannot drift from what the cron will actually delete.
 *
 * Throws on non-positive / non-finite input rather than silently returning
 * 0 — the caller (the AI Ops route) validates against
 * `AI_METRICS_RETENTION_BOUNDS` first.
 */
export async function previewAiMetricsPruneImpact(
  candidateDays: number,
): Promise<AiMetricsPruneImpactPreview> {
  if (!Number.isFinite(candidateDays) || candidateDays <= 0) {
    throw new Error("candidateDays must be a positive number");
  }
  await ensureAiMetricsTable();
  const days = Math.max(1, Math.floor(candidateDays));
  const result = await pool.query<{
    count: string | number | null;
    oldest_age_days: string | number | null;
  }>(
    `SELECT COUNT(*)::bigint                                             AS count,
            EXTRACT(EPOCH FROM (NOW() - MIN(started_at))) / 86400.0      AS oldest_age_days
       FROM ai_call_metrics
      WHERE started_at < NOW() - MAKE_INTERVAL(days => $1)`,
    [days],
  );
  const row = result.rows[0] ?? {};
  const rawCount = row.count ?? 0;
  const rowCountNum =
    typeof rawCount === "string" ? Number(rawCount) : rawCount;
  const rowCount = Number.isFinite(rowCountNum) ? Number(rowCountNum) : 0;

  let oldestRowAgeDays: number | null = null;
  if (row.oldest_age_days != null) {
    const n =
      typeof row.oldest_age_days === "string"
        ? Number(row.oldest_age_days)
        : row.oldest_age_days;
    if (Number.isFinite(n)) oldestRowAgeDays = Number(n);
  }

  // Span (in whole days, rounded up so a 79.4-day-old oldest row at
  // candidate=7 reports "73 days of telemetry deleted" rather than
  // 72 — the operator should err on the side of the larger number).
  // Only meaningful when the deletion bucket is non-empty; an empty
  // bucket reports 0 days even if oldestRowAgeDays happens to be null.
  let daysToDelete = 0;
  if (rowCount > 0 && oldestRowAgeDays != null) {
    const span = Math.ceil(oldestRowAgeDays) - days;
    daysToDelete = span > 0 ? span : 0;
  }

  return {
    candidateDays: days,
    rowCount,
    oldestRowAgeDays,
    daysToDelete,
  };
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
      logger.warn(
        "[aiTelemetry] purgeArchivedPromptVersionMetrics: no live versions supplied — skipping to avoid purging everything",
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
    logger.error(
      "[aiTelemetry] purgeArchivedPromptVersionMetrics failed:",
      err,
    );
    return 0;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Prompt-version purge run audit trail
//
// The Inngest cron (promptVersionPurgeFunction) writes one row per run so the
// AI Operations panel can show a "Last purge" info strip and operators get
// visible confirmation that the job ran. The table is intentionally tiny:
// one row per cron tick, capped at PROMPT_VERSION_PURGE_HISTORY_KEEP rows by
// each writer (NOT a TTL), so the table stays small without an extra cron.
// ──────────────────────────────────────────────────────────────────────────────
const PROMPT_VERSION_PURGE_HISTORY_KEEP = 200;

let purgeRunsTableReady: Promise<void> | null = null;
async function ensurePromptVersionPurgeRunsTable(): Promise<void> {
  if (purgeRunsTableReady) return purgeRunsTableReady;
  purgeRunsTableReady = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS prompt_version_purge_runs (
          id              BIGSERIAL  PRIMARY KEY,
          ran_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_count   INTEGER     NOT NULL DEFAULT 0,
          retention_days  INTEGER     NOT NULL,
          live_versions   TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[]
        );
        CREATE INDEX IF NOT EXISTS idx_prompt_version_purge_runs_ran_at
          ON prompt_version_purge_runs (ran_at DESC);
      `);
    } catch (err) {
      purgeRunsTableReady = null;
      throw err;
    }
  })();
  return purgeRunsTableReady;
}

export interface PromptVersionPurgeRun {
  id: number;
  ran_at: string;
  deleted_count: number;
  retention_days: number;
  live_versions: string[];
}

export async function recordPromptVersionPurgeRun(
  deletedCount: number,
  retentionDays: number,
  liveVersions: string[],
): Promise<number | null> {
  try {
    await ensurePromptVersionPurgeRunsTable();
    const result = await pool.query(
      `INSERT INTO prompt_version_purge_runs (deleted_count, retention_days, live_versions)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [
        Math.max(0, Math.floor(deletedCount)),
        Math.max(1, Math.floor(retentionDays)),
        liveVersions,
      ],
    );
    // Trim history to the most-recent N rows so the table cannot grow without
    // bound. Cheap because the index above orders rows by ran_at DESC.
    await pool.query(
      `DELETE FROM prompt_version_purge_runs
        WHERE id IN (
          SELECT id FROM prompt_version_purge_runs
          ORDER BY ran_at DESC
          OFFSET $1
        )`,
      [PROMPT_VERSION_PURGE_HISTORY_KEEP],
    );
    return result.rows[0]?.id ?? null;
  } catch (err) {
    logger.error("[aiTelemetry] recordPromptVersionPurgeRun failed:", err);
    return null;
  }
}

export async function getLastPromptVersionPurgeRun(): Promise<PromptVersionPurgeRun | null> {
  try {
    await ensurePromptVersionPurgeRunsTable();
    const result = await pool.query(
      `SELECT id, ran_at, deleted_count, retention_days, live_versions
         FROM prompt_version_purge_runs
        ORDER BY ran_at DESC
        LIMIT 1`,
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    return {
      id: Number(row.id),
      ran_at:
        row.ran_at instanceof Date
          ? row.ran_at.toISOString()
          : String(row.ran_at),
      deleted_count: Number(row.deleted_count) || 0,
      retention_days: Number(row.retention_days) || 0,
      live_versions: Array.isArray(row.live_versions) ? row.live_versions : [],
    };
  } catch (err) {
    logger.error("[aiTelemetry] getLastPromptVersionPurgeRun failed:", err);
    return null;
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
    [days],
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
     ORDER BY total_cost DESC`,
  );
  return result.rows;
}

/**
 * Builds the SQL for getTopToolsByCost. Exported (along with the helper) so
 * the EXPLAIN-based regression test in
 * tests/aiTelemetryDashboardIndexes.test.ts can assert that the
 * agent-filtered variant uses `idx_ai_call_metrics_agent_started`. Keep the
 * two callers (getTopToolsByCost + the test) in lock-step by routing both
 * through this builder so a future SQL tweak can never silently drift past
 * the test.
 */
export function buildTopToolsByCostSql(hasAgentFilter: boolean): string {
  const agentFilter = hasAgentFilter ? "AND agent_name = $2" : "";
  return `SELECT
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
     LIMIT $1`;
}

export async function getTopToolsByCost(
  limit = 10,
  agentName?: string,
): Promise<any[]> {
  await ensureAiMetricsTable();
  const params: any[] = [limit];
  const trimmedAgent =
    agentName && agentName.trim() ? agentName.trim() : null;
  if (trimmedAgent) params.push(trimmedAgent);
  const result = await pool.query(
    buildTopToolsByCostSql(!!trimmedAgent),
    params,
  );
  return result.rows;
}

export interface ParentCallForTool {
  id: string;
  agent_name: string;
  model: string | null;
  started_at: string;
  latency_ms: number;
  estimated_cost_usd: string;
  success: boolean;
  tool_invocations: string;
  tool_cost: string;
}

export async function getParentCallsForTool(
  toolName: string,
  limit = 20,
  windowDays = 7,
): Promise<ParentCallForTool[]> {
  await ensureAiMetricsTable();
  // windowDays is interpolated (not a $-param) because PostgreSQL does not
  // accept bind parameters inside an INTERVAL literal. The route layer
  // already clamps the value via safeInt(..., 1, 90), and the function
  // signature defaults to 7, so the value is always a small bounded
  // integer — never user-controlled free-form text.
  const safeDays = Math.max(1, Math.min(90, Math.floor(windowDays) || 7));
  const result = await pool.query(
    `SELECT
       p.id,
       p.agent_name,
       p.model,
       p.started_at,
       p.latency_ms,
       COALESCE(p.estimated_cost_usd, 0)                          AS estimated_cost_usd,
       p.success,
       COUNT(c.id)                                                AS tool_invocations,
       COALESCE(ROUND(SUM(c.estimated_cost_usd)::NUMERIC, 6), 0) AS tool_cost
     FROM ai_call_metrics p
     JOIN ai_call_metrics c ON c.parent_call_id = p.id
     WHERE c.tool_name = $1
       AND p.started_at >= NOW() - (INTERVAL '1 day' * ${safeDays})
     GROUP BY p.id, p.agent_name, p.model, p.started_at, p.latency_ms,
              p.estimated_cost_usd, p.success
     ORDER BY tool_cost DESC, p.started_at DESC
     LIMIT $2`,
    [toolName, limit],
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
     ORDER BY agent_name`,
  );
  return result.rows.map((r) => r.agent_name);
}

/**
 * SQL for the per-parent child-tool-call lookup. Exported as a constant so
 * the index-usage regression test
 * (tests/aiTelemetryChildCallIndex.test.ts) can EXPLAIN exactly the SQL the
 * production function runs and assert that the partial index
 * `idx_ai_call_metrics_parent_call_id` is used. Keep this and
 * `getChildToolCallsForParent` in sync.
 */
export const CHILD_TOOL_CALLS_SQL = `SELECT
       id, agent_name, tool_name, model,
       prompt_tokens, completion_tokens, estimated_cost_usd,
       latency_ms, success, error_class, error_message, started_at,
       prompt_preview, tool_input_preview, tool_output_preview,
       previews_redacted_at
     FROM ai_call_metrics
     WHERE parent_call_id = $1
     ORDER BY started_at ASC, id ASC`;

export async function getChildToolCallsForParent(parentId: number): Promise<
  {
    id: string;
    agent_name: string;
    tool_name: string | null;
    model: string | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    estimated_cost_usd: number | null;
    latency_ms: number;
    success: boolean;
    error_class: string | null;
    error_message: string | null;
    started_at: string;
    prompt_preview: string | null;
    tool_input_preview: string | null;
    tool_output_preview: string | null;
    previews_redacted_at: string | null;
  }[]
> {
  await ensureAiMetricsTable();
  const result = await pool.query(CHILD_TOOL_CALLS_SQL, [parentId]);
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

/**
 * Returns the set of tool names that had at least one call recorded in the
 * last `windowMinutes` minutes. Used by the tool-health cron to determine
 * which tools have "gone silent" so their open alerts can be auto-resolved.
 *
 * Intentionally does NOT apply a `minCalls` filter — a tool that had just
 * one call is still active; we only want tools with truly zero activity.
 */
/**
 * SQL for the silent-tool auto-resolve sweep's "which tools have had any
 * activity in the last N minutes?" probe. Exported so the EXPLAIN-based
 * regression test in tests/aiTelemetryDashboardIndexes.test.ts can assert
 * the partial index `idx_ai_call_metrics_tool_started` is used and the
 * sweep cannot silently fall back to a Seq Scan in production.
 */
export const TOOLS_WITH_CALLS_IN_WINDOW_SQL = `SELECT DISTINCT tool_name
       FROM ai_call_metrics
      WHERE tool_name IS NOT NULL
        AND started_at >= NOW() - MAKE_INTERVAL(mins => $1)`;

export async function getToolsWithCallsInWindow(
  windowMinutes: number,
): Promise<Set<string>> {
  await ensureAiMetricsTable();
  // Intentionally NOT caught here. This function is used by the silent-tool
  // auto-resolve sweep to decide which tools are still active. Returning an
  // empty set on DB failure would be interpreted as "no tools active" and
  // could cause the sweep to resolve every open tool_health alert
  // incorrectly. The caller (runSilentToolSweep) has its own try/catch that
  // aborts the sweep on any error, so failing loudly here is the safe
  // (fail-closed) behavior.
  const result = await pool.query(
    TOOLS_WITH_CALLS_IN_WINDOW_SQL,
    [windowMinutes],
  );
  return new Set<string>(
    result.rows.map((r: { tool_name: string }) => r.tool_name),
  );
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

/**
 * SQL for the global "recent slow/failed calls" time-scrubber query on the
 * AI Operations dashboard. Exported so the EXPLAIN-based regression test
 * in tests/aiTelemetryDashboardIndexes.test.ts can assert the
 * `idx_ai_call_metrics_started_at` index drives the ORDER BY started_at
 * DESC LIMIT N pattern and the dashboard cannot silently regress to a
 * Seq Scan.
 */
export const RECENT_SLOW_FAILED_CALLS_SQL = `SELECT
       id, agent_name, tool_name, model,
       latency_ms, estimated_cost_usd,
       success, error_class, error_message,
       prompt_preview, tool_input_preview, tool_output_preview,
       started_at, prompt_tokens, completion_tokens
     FROM ai_call_metrics
     WHERE (NOT success OR latency_ms > 30000)
       AND started_at >= NOW() - INTERVAL '7 days'
     ORDER BY started_at DESC
     LIMIT $1`;

export async function getRecentSlowFailedCalls(limit = 20): Promise<
  {
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
  }[]
> {
  await ensureAiMetricsTable();
  const result = await pool.query(RECENT_SLOW_FAILED_CALLS_SQL, [limit]);
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
  // Task #467: ISO-8601 timestamp the historical preview-redaction sweep
  // wrote when it scrubbed any of the *_preview columns on this row, or
  // null if the row never needed sweeping. The AI Operations call-detail
  // modal renders an info badge whenever this is set so operators know
  // the preview reflects a retroactive cleanup, not the original write.
  previews_redacted_at: string | null;
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
       prompt_preview, previews_redacted_at,
       started_at, prompt_tokens, completion_tokens
     FROM ai_call_metrics
     WHERE id = $1
     LIMIT 1`,
    [callId],
  );
  return result.rows[0] || null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Call-level feedback (thumbs up / down) — enables feedback_rate per agent
// ──────────────────────────────────────────────────────────────────────────────
let feedbackTableReady: Promise<void> | null = null;

export async function ensureFeedbackTable(): Promise<void> {
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
  if (typeof raw !== "string") return null;
  // Strip HTML tags and common script vectors before storage.
  let cleaned = raw.replace(/<[^>]*>/g, "");
  cleaned = cleaned.replace(/javascript:/gi, "");
  cleaned = cleaned.replace(/on\w+\s*=/gi, "");
  cleaned = cleaned.trim();
  if (!cleaned) return null;
  if (cleaned.length > FEEDBACK_COMMENT_MAX_LEN) {
    cleaned = cleaned.slice(0, FEEDBACK_COMMENT_MAX_LEN);
  }
  return cleaned;
}

export async function insertCallFeedback(
  callId: number,
  rating: "thumbs_up" | "thumbs_down",
  userId?: string,
  comment?: string | null,
): Promise<boolean> {
  try {
    await ensureFeedbackTable();
    const userHash = userId ? hashValue(userId) : "anonymous";
    const cleanComment = sanitizeFeedbackComment(comment);
    await pool.query(
      `INSERT INTO ai_call_feedback (call_id, rating, user_hash, comment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ON CONSTRAINT uq_ai_call_feedback_call_user
       DO UPDATE SET rating  = EXCLUDED.rating,
                     comment = COALESCE(EXCLUDED.comment, ai_call_feedback.comment)`,
      [callId, rating, userHash, cleanComment],
    );
    return true;
  } catch (err) {
    logger.error("[aiTelemetry] Failed to insert feedback:", err);
    return false;
  }
}

/**
 * Backfill `prompt_version` into `ai_call_metrics.metadata` for a single
 * call, but ONLY when the row does not already carry one. The
 * authoritative writer is the streaming consultant route, which sets
 * `metadata.prompt_version` at span open via
 * {@link buildAiCallTelemetryMetadata}; this helper is the call-id rating
 * path's "echo back what the client saw" safety net so call-id ratings
 * (POST /api/ai-ops/feedback) are also visible in the per-version
 * analytics view (`getFeedbackRateByPromptVersion`) when an older row
 * predates the always-on telemetry path or when a future surface routes
 * through aiOps without going through the consultant span first.
 *
 * Refuses to overwrite an existing prompt_version because the client is
 * untrusted — the server-side span value (recorded at the moment the
 * response was generated) is the source of truth. We only fill the
 * field when it is absent or empty.
 *
 * Returns true when the row was updated (i.e. metadata.prompt_version
 * was missing and is now `version`), false otherwise — including when
 * the call id is unknown or the value already matched.
 */
export async function setCallPromptVersionIfMissing(
  callId: number,
  version: string,
): Promise<boolean> {
  try {
    if (!Number.isFinite(callId) || callId <= 0) return false;
    if (typeof version !== "string") return false;
    const trimmed = version.trim().slice(0, 100);
    if (!trimmed) return false;
    await ensureAiMetricsTable();
    const result = await pool.query(
      `UPDATE ai_call_metrics
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                         || jsonb_build_object('prompt_version', $2::text)
        WHERE id = $1
          AND COALESCE(metadata ->> 'prompt_version', '') = ''`,
      [callId, trimmed],
    );
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    logger.error("[aiTelemetry] Failed to backfill prompt_version on call:", err);
    return false;
  }
}

/**
 * Task #763: companion to {@link setCallPromptVersionIfMissing} that
 * backfills `metadata.client_surface` on a call row when it is missing.
 *
 * Used by non-web rating surfaces (Slack thumbs-up/down bot, mobile app,
 * embedded widget) to mark which UI produced the rating so per-surface
 * analytics in the AI Operations dashboard
 * (`getFeedbackBreakdownByPromptVersion().client_surfaces`) are populated
 * without changing the message-id consultant feedback path.
 *
 * Refuses to overwrite an existing `client_surface` because the value
 * recorded server-side at span open time (when present) is the source of
 * truth — a misconfigured downstream surface shouldn't be able to reattribute
 * a row to a different bucket after the fact.
 *
 * Returns true when the row was updated, false otherwise.
 */
export async function setCallClientSurfaceIfMissing(
  callId: number,
  surface: string,
): Promise<boolean> {
  try {
    if (!Number.isFinite(callId) || callId <= 0) return false;
    if (typeof surface !== "string") return false;
    const trimmed = surface.trim().slice(0, 50);
    if (!trimmed) return false;
    await ensureAiMetricsTable();
    const result = await pool.query(
      `UPDATE ai_call_metrics
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                         || jsonb_build_object('client_surface', $2::text)
        WHERE id = $1
          AND COALESCE(metadata ->> 'client_surface', '') = ''`,
      [callId, trimmed],
    );
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    logger.error("[aiTelemetry] Failed to backfill client_surface on call:", err);
    return false;
  }
}

/**
 * Read the recorded `metadata.prompt_version` for a single call.
 *
 * Task #763: non-web rating surfaces (Slack bot, mobile app, embedded
 * widget) typically only have the `callId` of the response the user
 * reacted to — they do not carry the `promptVersion` echo the web
 * consultant chat client passes back in its feedback POST. Surfaces
 * call this helper to look up the version that was active when the
 * response was generated, then forward it on the rating POST so
 * per-version analytics (`getFeedbackRateByPromptVersion`) attribute
 * Slack/mobile/embedded ratings the same way they attribute web ones.
 *
 * Returns the trimmed prompt-version string, or null when the row does
 * not exist or has no `metadata.prompt_version` (e.g. a legacy call
 * recorded before the always-on telemetry path).
 */
export async function getCallPromptVersion(
  callId: number,
): Promise<string | null> {
  try {
    if (!Number.isFinite(callId) || callId <= 0) return null;
    await ensureAiMetricsTable();
    const result = await pool.query(
      `SELECT NULLIF(TRIM(metadata ->> 'prompt_version'), '') AS prompt_version
         FROM ai_call_metrics
        WHERE id = $1
        LIMIT 1`,
      [callId],
    );
    const value = result.rows[0]?.prompt_version;
    return typeof value === "string" && value ? value : null;
  } catch (err) {
    logger.error("[aiTelemetry] Failed to read prompt_version for call:", err);
    return null;
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
  /**
   * Earliest `started_at` for this (agent, version) pair *within the
   * selected window*. NULL for rows that were last active outside the
   * window — they appear as archived placeholders with 0 in-window calls
   * (see Task #330).
   */
  first_seen: string | null;
  /**
   * Most recent `started_at` for this (agent, version) pair *within the
   * selected window*. NULL for archived rows that fall outside the
   * window. Use `last_seen_at` for the unbounded all-time value.
   */
  last_seen: string | null;
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
  /**
   * Per-surface call-count breakdown hoisted from
   * `ai_call_metrics.metadata.client_surface` within the selected window
   * (Task #749). Shape: `{ web: 12, slack: 3, mobile: 1, unknown: 4 }`
   * where the `unknown` bucket collapses rows whose metadata never
   * captured a surface (e.g. legacy traffic). Empty object for archived
   * rows with no in-window activity. Lets the AI Ops dashboard render a
   * tooltip/breakdown showing which surfaces contributed to each
   * (agent, prompt_version) bucket without a follow-up query.
   */
  client_surfaces: Record<string, number>;
  /**
   * Per-rating-source breakdown hoisted from
   * `ai_call_feedback.metadata.rating_source` within the selected window
   * (Task #799). Shape: `{ inline_thumbs: 7, comment_modal: 2, retro_triage: 1, unknown: 3 }`
   * where the `unknown` bucket collapses ratings whose metadata never
   * captured a source (e.g. legacy votes recorded before the field was
   * introduced). Empty object for rows with no in-window ratings. Lets
   * the AI Ops dashboard render a per-source breakdown showing whether a
   * version's feedback rate is heavily skewed toward a single source
   * (which can bias the rate) without an extra round-trip.
   */
  rating_sources: Record<string, number>;
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
  _pool?: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> },
): Promise<PromptVersionAggregate[]> {
  // Guard against negative/NaN floors — a zero floor effectively disables
  // the small-sample protection, which is a valid (if discouraged) choice
  // we should still honour for callers that want raw aggregates.
  const floor =
    Number.isFinite(minFeedback) && minFeedback >= 0
      ? Math.floor(minFeedback)
      : DEFAULT_PROMPT_VERSION_MIN_FEEDBACK;
  const queryPool = _pool ?? pool;
  try {
    if (!_pool) {
      await ensureAiMetricsTable();
      await ensureFeedbackTable();
    }
    const result = await queryPool.query(
      FEEDBACK_RATE_BY_PROMPT_VERSION_SQL,
      [days, floor],
    );
    return result.rows;
  } catch (err) {
    logger.error("[aiTelemetry] getFeedbackRateByPromptVersion failed:", err);
    return [];
  }
}

/**
 * SQL for the AI Operations dashboard's Prompt Version comparison view.
 * Exported so the EXPLAIN-based regression test in
 * tests/aiTelemetryDashboardIndexes.test.ts can assert that the partial
 * index `idx_ai_call_metrics_agent_prompt_version` is used by at least one
 * scan in the plan and the (expensive) per-prompt-version aggregate cannot
 * silently regress to a Seq Scan on `ai_call_metrics`.
 *
 * Bind parameters: $1 = days window, $2 = min_feedback floor.
 */
export const FEEDBACK_RATE_BY_PROMPT_VERSION_SQL = `WITH windowed AS (
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
       -- Per-surface call-count breakdown (Task #749). Computed as its
       -- own grouped CTE and re-joined to the windowed CTE to avoid the
       -- "subquery uses ungrouped column" error you would get from
       -- inlining a correlated subquery into the windowed SELECT.
       -- Collapses missing/empty client_surface metadata into an
       -- "unknown" bucket so per-surface counts stay additive with
       -- call_count even on legacy rows that predate metadata capture.
       surface_counts AS (
         SELECT
           m.agent_name,
           COALESCE(m.metadata ->> 'prompt_version', '(unknown)')              AS prompt_version,
           COALESCE(NULLIF(m.metadata ->> 'client_surface', ''), 'unknown')    AS surface,
           COUNT(*)                                                            AS surface_count
         FROM ai_call_metrics m
         WHERE m.started_at >= NOW() - MAKE_INTERVAL(days => $1)
           AND m.tool_name IS NULL
         GROUP BY
           m.agent_name,
           COALESCE(m.metadata ->> 'prompt_version', '(unknown)'),
           COALESCE(NULLIF(m.metadata ->> 'client_surface', ''), 'unknown')
       ),
       surface_breakdown AS (
         SELECT
           agent_name,
           prompt_version,
           jsonb_object_agg(surface, surface_count) AS client_surfaces
         FROM surface_counts
         GROUP BY agent_name, prompt_version
       ),
       -- Per-rating-source breakdown (Task #799). Mirrors the
       -- surface_counts CTE above but pulls from
       -- ai_call_feedback.metadata.rating_source and is keyed off the
       -- joined feedback row (so it counts ratings, not calls). Like
       -- surfaces, missing/empty values collapse into an "unknown"
       -- bucket so the per-source counts stay additive with
       -- total_feedback even on legacy ratings recorded before the
       -- field existed. The grouped jsonb_object_agg is split into a
       -- separate CTE for the same reason as surface_breakdown — to
       -- avoid "subquery uses ungrouped column" errors.
       rating_source_counts AS (
         SELECT
           m.agent_name,
           COALESCE(m.metadata ->> 'prompt_version', '(unknown)')                  AS prompt_version,
           COALESCE(NULLIF(f.metadata ->> 'rating_source', ''), 'unknown')         AS rating_source,
           COUNT(*)                                                                AS source_count
         FROM ai_call_metrics m
         JOIN ai_call_feedback f ON f.call_id = m.id
         WHERE m.started_at >= NOW() - MAKE_INTERVAL(days => $1)
           AND m.tool_name IS NULL
         GROUP BY
           m.agent_name,
           COALESCE(m.metadata ->> 'prompt_version', '(unknown)'),
           COALESCE(NULLIF(f.metadata ->> 'rating_source', ''), 'unknown')
       ),
       rating_source_breakdown AS (
         SELECT
           agent_name,
           prompt_version,
           jsonb_object_agg(rating_source, source_count) AS rating_sources
         FROM rating_source_counts
         GROUP BY agent_name, prompt_version
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
       -- LEFT JOIN from global_last so (agent, version) pairs whose most
       -- recent traffic predates the selected window still surface as
       -- archived placeholder rows (Task #330). When there's no matching
       -- windowed aggregate, in-window metrics fall back to 0/NULL so the
       -- dashboard can clearly show "no activity in window" without losing
       -- the historic version label or its all-time last_seen_at.
       SELECT
         g.agent_name,
         g.prompt_version,
         COALESCE(w.call_count, 0)             AS call_count,
         COALESCE(w.total_feedback, 0)         AS total_feedback,
         COALESCE(w.thumbs_up, 0)              AS thumbs_up,
         COALESCE(w.thumbs_down, 0)            AS thumbs_down,
         w.feedback_rate_pct                   AS feedback_rate_pct,
         w.p50_ms                              AS p50_ms,
         w.avg_ms                              AS avg_ms,
         COALESCE(w.error_rate_pct, 0)         AS error_rate_pct,
         w.first_seen                          AS first_seen,
         w.last_seen                           AS last_seen,
         $2::INTEGER                           AS min_feedback,
         COALESCE(w.meets_min_feedback, FALSE) AS meets_min_feedback,
         g.last_seen_at                        AS last_seen_at,
         COALESCE(sb.client_surfaces, '{}'::jsonb) AS client_surfaces,
         COALESCE(rsb.rating_sources, '{}'::jsonb) AS rating_sources
       FROM global_last g
       LEFT JOIN windowed w
         ON w.agent_name = g.agent_name AND w.prompt_version = g.prompt_version
       LEFT JOIN surface_breakdown sb
         ON sb.agent_name = g.agent_name AND sb.prompt_version = g.prompt_version
       LEFT JOIN rating_source_breakdown rsb
         ON rsb.agent_name = g.agent_name AND rsb.prompt_version = g.prompt_version
       ORDER BY g.agent_name, g.last_seen_at DESC`;

export async function getRecentNegativeFeedback(limit = 25): Promise<
  {
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
    /**
     * Client surface that submitted the rating, hoisted from
     * `ai_call_metrics.metadata.client_surface` (Task #749). Lets the AI
     * Ops dashboard show whether thumbs-down ratings are coming from the
     * web chat, the Slack bot, or a mobile client without a separate
     * round-trip. NULL for legacy rows where the surface was never
     * captured.
     */
    client_surface: string | null;
    /**
     * Parent call's full `ai_call_metrics.metadata` JSONB (Task #621). Lets
     * the AI Ops dashboard's Negative Feedback table render the same
     * prompt-version / experiment-arm / feature-flag chips already shown on
     * the Recent Thumbs-Down panel so operators don't lose regression
     * context when pivoting between the two views. Always an object —
     * legacy rows where metadata is SQL NULL are normalized to `{}` so the
     * dashboard never has to defensively null-check before reading nested
     * keys.
     */
    metadata: Record<string, unknown>;
  }[]
> {
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
         m.error_class,
         m.metadata ->> 'client_surface' AS client_surface,
         m.metadata     AS metadata
       FROM ai_call_feedback f
       JOIN ai_call_metrics  m ON m.id = f.call_id
       WHERE f.rating = 'thumbs_down'
         AND f.created_at >= NOW() - INTERVAL '30 days'
       ORDER BY f.created_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      ...row,
      metadata:
        row.metadata && typeof row.metadata === "object"
          ? (row.metadata as Record<string, unknown>)
          : {},
    }));
  } catch (err) {
    logger.error("[aiTelemetry] getRecentNegativeFeedback failed:", err);
    return [];
  }
}

export async function getFeedbackRateByAgent(): Promise<
  {
    agent_name: string;
    total_feedback: number;
    thumbs_up: number;
    thumbs_down: number;
    feedback_rate_pct: number;
  }[]
> {
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
       ORDER BY total_feedback DESC`,
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
       AND tool_name IS NULL`,
  );
  const row = result.rows[0];
  return {
    totalCostUsd: parseFloat(row.total_cost_usd) || 0,
    callCount: parseInt(row.call_count) || 0,
    errorCount: parseInt(row.error_count) || 0,
    avgLatencyMs: parseFloat(row.avg_latency_ms) || 0,
  };
}
