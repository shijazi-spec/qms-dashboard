import pg from "pg";
import { logger } from "./logger";
import {
  redactSecretLikeStrings,
  deepRedactSecretLikeStrings,
} from "./eventLogsDatabase";
import { wrapPoolForRedaction } from "./redactedPool";

const { Pool } = pg;

const pool = wrapPoolForRedaction(new Pool({ connectionString: process.env.DATABASE_URL }));

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
          metadata      JSONB DEFAULT '{}'::jsonb,
          created_at    TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ai_feedback_message_id ON ai_response_feedback(message_id);
        CREATE INDEX IF NOT EXISTS idx_ai_feedback_created_at ON ai_response_feedback(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_feedback_rating     ON ai_response_feedback(rating);
        CREATE INDEX IF NOT EXISTS idx_ai_feedback_agent      ON ai_response_feedback(agent);
      `);
      await pool.query(`
        ALTER TABLE ai_response_feedback ADD COLUMN IF NOT EXISTS tools_called TEXT;
        ALTER TABLE ai_response_feedback ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
      `);
    } catch (err) {
      tableReady = null;
      throw err;
    }
  })();
  return tableReady;
}

function safeRedactPreview(
  text: string | undefined | null,
): string | undefined {
  if (!text) return undefined;
  const redacted = redactSecretLikeStrings(text.substring(0, 500));
  return typeof redacted === "string" ? redacted : text.substring(0, 500);
}

/**
 * Closed allow-list of keys that may appear in `ai_response_feedback.metadata`.
 *
 * Mirrors the protection added for `ai_call_metrics.metadata` by
 * `AiCallTelemetryMetadata` / `buildAiCallTelemetryMetadata()` in
 * `aiTelemetry.ts` (Task #484). Replaces a freeform `Record<string, unknown>`
 * shape so a developer cannot accidentally pass
 * `{ note: caughtError.message, debug: rawHeaders }` from a `catch` block —
 * which would land plaintext credentials in the JSONB column. The WRITE-path
 * scrubber `redactFeedbackMetadataForStorage()` defends against that one
 * layer too late: by the time it runs, the secret has already been
 * constructed in memory and (typically) logged to stdout via the structured
 * logger BEFORE the scrubber redacts it for the DB. This typed shape is the
 * source-side prevention; build it via `buildAiCallFeedbackMetadata()`.
 *
 * To add a new key:
 *   1. Add the snake_case field here.
 *   2. Add the camelCase field on `AiCallFeedbackMetadataInput`.
 *   3. Map it in `buildAiCallFeedbackMetadata()`.
 *   4. Update the test in `src/utils/__tests__/aiFeedbackMetadata.test.ts`.
 */
export interface AiCallFeedbackMetadata {
  /** Stable hash of the agent's instruction prompt (e.g. `qms@deadbeef`). */
  prompt_version?: string;
  /** Identifier for an A/B feature flag bucket. */
  feature_flag?: string;
  /** Identifier for an experiment arm (e.g. `control`, `treatment-1`). */
  experiment_arm?: string;
  /** Name of the orchestrating workflow (e.g. `qualityAuditWorkflow`). */
  workflow?: string;
  /** Step within a workflow (e.g. `sdr-audit`, `sales-audit`). */
  step?: string;
  /** Where the rating was captured (e.g. `inline_thumbs`, `detail_modal`). */
  rating_source?: string;
  /** Surface that produced the rating (e.g. `web`, `mobile`, `slack`). */
  client_surface?: string;
}

/**
 * camelCase mirror of `AiCallFeedbackMetadata` used as the input shape for
 * `buildAiCallFeedbackMetadata()`. Keeping the snake_case ↔ camelCase
 * boundary inside the helper means call-sites read naturally in TS while
 * the persisted JSONB stays in the snake_case shape (mirroring the sibling
 * `metadata->>'prompt_version'` SQL expressions used against
 * `ai_call_metrics.metadata`).
 */
export interface AiCallFeedbackMetadataInput {
  promptVersion?: string;
  featureFlag?: string;
  experimentArm?: string;
  workflow?: string;
  step?: string;
  ratingSource?: string;
  clientSurface?: string;
}

const FEEDBACK_METADATA_KEY_MAP: Record<
  keyof AiCallFeedbackMetadataInput,
  keyof AiCallFeedbackMetadata
> = {
  promptVersion: "prompt_version",
  featureFlag: "feature_flag",
  experimentArm: "experiment_arm",
  workflow: "workflow",
  step: "step",
  ratingSource: "rating_source",
  clientSurface: "client_surface",
};

/**
 * Build a typed `metadata` payload for `ai_response_feedback` rows.
 *
 * MUST be used at every `saveFeedback()` call site that wants to attach
 * metadata, instead of an inline object literal. The closed allow-list
 * (see `AiCallFeedbackMetadataInput`) prevents the pattern of stuffing
 * dynamic strings derived from `catch (err)`, raw HTTP headers, or tool
 * output into `metadata` — which would land plaintext credentials in the
 * JSONB column.
 *
 * Defense-in-depth runtime guard: even if a caller bypasses the type
 * system via `as any`, unexpected keys are dropped and a warning is
 * emitted via the structured logger with an actionable message so the
 * regression shows up in the operator console rather than silently
 * persisting.
 */
export function buildAiCallFeedbackMetadata(
  input: AiCallFeedbackMetadataInput,
): AiCallFeedbackMetadata {
  const out: AiCallFeedbackMetadata = {};
  const loose = input as Record<string, unknown>;
  for (const inputKey of Object.keys(loose)) {
    const mapped =
      FEEDBACK_METADATA_KEY_MAP[inputKey as keyof AiCallFeedbackMetadataInput];
    if (!mapped) {
      logger.warn(
        `[aiFeedbackDatabase] buildAiCallFeedbackMetadata received unexpected key "${inputKey}". ` +
          `Allowed keys: ${Object.keys(FEEDBACK_METADATA_KEY_MAP).join(", ")}. ` +
          `The key was dropped to prevent credential-shaped substrings from reaching ai_response_feedback.metadata.`,
      );
      continue;
    }
    const value = loose[inputKey];
    if (value === undefined) continue;
    (out as Record<string, unknown>)[mapped] = value;
  }
  return out;
}

/**
 * Scrub the caller-supplied `metadata` JSONB blob destined for
 * `ai_response_feedback.metadata` before it is `JSON.stringify`-ed into the
 * INSERT/UPDATE parameter slot.
 *
 * Mirrors `redactMetadataForStorage()` in `aiTelemetry.ts`: runs every
 * string leaf through `deepRedactSecretLikeStrings()` so a careless caller
 * cannot land a credential-shaped substring (sk-…, ghp_…, JWT, bcrypt
 * hash, AWS key) under an allowed key and have it persist in plaintext.
 *
 * Note: this is the second layer of defense. The first is the typed
 * `AiCallFeedbackMetadata` allow-list enforced at the call site by
 * `buildAiCallFeedbackMetadata()`, which prevents free-form keys derived
 * from `catch (err)` / raw headers / tool output from ever being
 * constructed in memory in the first place.
 *
 * Returns a plain object — never null — so callers can pass the result
 * straight into `JSON.stringify` without an extra `?? {}`.
 */
export function redactFeedbackMetadataForStorage(
  metadata: AiCallFeedbackMetadata | Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  const scrubbed = deepRedactSecretLikeStrings(metadata);
  if (scrubbed && typeof scrubbed === "object" && !Array.isArray(scrubbed)) {
    return scrubbed as Record<string, unknown>;
  }
  return {};
}

export interface FeedbackRecord {
  message_id: string;
  conversation_id?: string;
  agent?: string;
  rating: "up" | "down";
  category?: string;
  comment?: string;
  user_id?: string;
  user_email?: string;
  prompt_preview?: string;
  response_preview?: string;
  tools_called?: string;
  metadata?: AiCallFeedbackMetadata;
}

export async function saveFeedback(
  fb: FeedbackRecord,
): Promise<{ id: number }> {
  await initAIFeedbackTable();

  // upsert: one rating per message per user
  const existing = await pool.query(
    `SELECT id FROM ai_response_feedback WHERE message_id=$1 AND (user_id=$2 OR user_email=$3) LIMIT 1`,
    [fb.message_id, fb.user_id || null, fb.user_email || null],
  );

  const redactedPrompt = safeRedactPreview(fb.prompt_preview);
  const redactedResponse = safeRedactPreview(fb.response_preview);
  // Only serialize metadata when the caller actually provided it. On the
  // UPDATE branch we want to preserve the existing JSONB if the caller
  // omits it (mirrors the `tools_called=COALESCE(...)` preservation pattern
  // a few lines down) — otherwise a follow-up rating tweak from the same
  // user would erase the prompt_version / experiment_arm / rating_source
  // recorded with the original thumbs-up/down.
  const metadataJson =
    fb.metadata !== undefined
      ? JSON.stringify(redactFeedbackMetadataForStorage(fb.metadata))
      : null;

  if (existing.rows[0]) {
    const res = await pool.query(
      `UPDATE ai_response_feedback
          SET rating=$1, category=$2, comment=$3,
              prompt_preview=$4, response_preview=$5,
              tools_called=COALESCE($6, tools_called),
              metadata=COALESCE($7::jsonb, metadata),
              created_at=NOW()
        WHERE id=$8
        RETURNING id`,
      [
        fb.rating,
        fb.category || null,
        fb.comment || null,
        redactedPrompt || null,
        redactedResponse || null,
        fb.tools_called || null,
        metadataJson,
        existing.rows[0].id,
      ],
    );
    return { id: res.rows[0].id };
  }

  const res = await pool.query(
    `INSERT INTO ai_response_feedback
       (message_id, conversation_id, agent, rating, category, comment,
        user_id, user_email, prompt_preview, response_preview, tools_called, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::jsonb, '{}'::jsonb))
     RETURNING id`,
    [
      fb.message_id,
      fb.conversation_id || null,
      fb.agent || "qmsConsultantAgent",
      fb.rating,
      fb.category || null,
      fb.comment || null,
      fb.user_id || null,
      fb.user_email || null,
      redactedPrompt || null,
      redactedResponse || null,
      fb.tools_called ? fb.tools_called.substring(0, 1000) : null,
      metadataJson,
    ],
  );
  return { id: res.rows[0].id };
}

export interface FeedbackPromptVersionBreakdown {
  prompt_version: string;
  total: number;
  thumbs_up: number;
  thumbs_down: number;
  thumbs_up_ratio: number;
}

export interface FeedbackStats {
  total: number;
  thumbs_up: number;
  thumbs_down: number;
  thumbs_up_ratio: number;
  feedback_rate_estimate: number;
  top_categories: { category: string; count: number }[];
  /**
   * Per-prompt-version breakdown for the same window as the headline totals.
   *
   * Lets operators triage whether a thumbs-down spike is concentrated on one
   * prompt revision (e.g. a recent edit to QMS_CONSULTANT_INSTRUCTIONS) vs
   * spread across all revisions. Sourced from `metadata->>'prompt_version'`,
   * which is populated by `buildAiCallFeedbackMetadata()` at the
   * /api/consultant/feedback save site (Task #590).
   *
   * Rows where `metadata->>'prompt_version'` is NULL or blank are grouped
   * under the literal `unknown` so legacy rows (where metadata is `{}`)
   * still contribute to the totals instead of silently disappearing — see
   * `getRecentThumbsDown` for the matching dashboard rendering of that
   * sentinel.
   */
  prompt_versions: FeedbackPromptVersionBreakdown[];
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
    [safeDays],
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
    [safeDays],
  );

  // Per-prompt-version breakdown (Task #661).
  //
  // We coalesce empty / NULL prompt_version into the literal 'unknown' so
  // legacy rows from before Task #590 (where metadata is `{}`) still show
  // up in the table — otherwise an admin would see a per-version total
  // that doesn't add up to the headline thumbs-up / thumbs-down counts and
  // think the breakdown was broken. Cap at 12 rows so a long tail of
  // historical revisions doesn't blow up the dashboard payload; the
  // ORDER BY puts the busiest revisions first.
  const versions = await pool.query(
    `SELECT
       COALESCE(NULLIF(TRIM(metadata->>'prompt_version'), ''), 'unknown') AS prompt_version,
       COUNT(*)                                                            AS total,
       COUNT(*) FILTER (WHERE rating='up')                                 AS thumbs_up,
       COUNT(*) FILTER (WHERE rating='down')                               AS thumbs_down
     FROM ai_response_feedback
     WHERE created_at >= NOW() - make_interval(days => $1)
     GROUP BY 1
     ORDER BY total DESC, prompt_version ASC
     LIMIT 12`,
    [safeDays],
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
    top_categories: cats.rows.map((r) => ({
      category: r.category,
      count: parseInt(r.cnt),
    })),
    prompt_versions: versions.rows.map((r) => {
      const rowTotal = parseInt(r.total) || 0;
      const rowUp = parseInt(r.thumbs_up) || 0;
      const rowDown = parseInt(r.thumbs_down) || 0;
      return {
        prompt_version: String(r.prompt_version),
        total: rowTotal,
        thumbs_up: rowUp,
        thumbs_down: rowDown,
        thumbs_up_ratio:
          rowTotal > 0 ? Math.round((rowUp / rowTotal) * 100) : 0,
      };
    }),
  };
}

export interface RecentThumbsDown {
  id: number;
  message_id: string;
  conversation_id: string | null;
  agent: string | null;
  category: string | null;
  comment: string | null;
  user_email: string | null;
  prompt_preview: string | null;
  response_preview: string | null;
  tools_called: string | null;
  /**
   * Typed `metadata` JSONB blob written through `buildAiCallFeedbackMetadata()`
   * (Task #512). Surfacing it here lets the AI Operations dashboard correlate
   * thumbs-down ratings to the prompt revision / experiment arm / rating
   * surface they were captured against — the same insight the sibling
   * `ai_call_metrics.metadata` already powers in the Prompt Version
   * comparison view. Always an object (never `null`) so callers can render
   * `metadata.prompt_version` without a defensive nullish check.
   */
  metadata: AiCallFeedbackMetadata;
  created_at: string;
  /**
   * Triage badges projected out of `metadata` (Task #661).
   *
   * These mirror the snake_case keys persisted by
   * `buildAiCallFeedbackMetadata()` — see `AiCallFeedbackMetadata`. Hoisted
   * to top-level columns so the AI Ops dashboard can render them without
   * having to teach the frontend the JSONB shape, and so legacy rows where
   * `metadata` is `{}` cleanly come back as `null` (rendered as "—").
   */
  prompt_version: string | null;
  rating_source: string | null;
  client_surface: string | null;
}

/**
 * Optional filters for the recent thumbs-down report. Each filter narrows the
 * report down to feedback whose `metadata->>'prompt_version'` (resp.
 * `metadata->>'feature_flag'`) matches the provided value exactly. Used by the
 * AI Operations dashboard so an operator triaging a regression can pivot from
 * the "all recent thumbs-down" list to the rows tied to a specific prompt
 * revision or feature-flag bucket. Empty / whitespace-only strings are treated
 * as "no filter" so the dashboard can blindly forward the input box value
 * without trimming.
 */
export interface RecentThumbsDownFilters {
  promptVersion?: string | null;
  featureFlag?: string | null;
}

export async function getFeedbackByMessageId(
  messageId: string,
  userId?: string,
  userEmail?: string,
): Promise<{
  rating: "up" | "down";
  category: string | null;
  comment: string | null;
} | null> {
  await initAIFeedbackTable();
  const res = await pool.query(
    `SELECT rating, category, comment
     FROM ai_response_feedback
     WHERE message_id = $1
       AND ($2::text IS NULL OR user_id = $2 OR user_email = $3)
     ORDER BY created_at DESC
     LIMIT 1`,
    [messageId, userId ?? null, userEmail ?? null],
  );
  if (!res.rows[0]) return null;
  return {
    rating: res.rows[0].rating as "up" | "down",
    category: res.rows[0].category ?? null,
    comment: res.rows[0].comment ?? null,
  };
}

/**
 * Trim and length-cap a metadata filter value before it is sent through the
 * `metadata->>'…'` SQL expression. Returns `null` for empty / whitespace-only
 * strings so the caller can branch on "no filter applied" cleanly. The
 * 200-char cap mirrors the cap used elsewhere in this file (`agent`, etc.) so
 * a paste of a multi-MB string into the dashboard input cannot send a
 * pathological parameter to PG.
 */
function normalizeMetadataFilter(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.substring(0, 200);
}

export async function getRecentThumbsDown(
  limit = 20,
  filters: RecentThumbsDownFilters = {},
): Promise<RecentThumbsDown[]> {
  await initAIFeedbackTable();

  const promptVersion = normalizeMetadataFilter(filters.promptVersion);
  const featureFlag = normalizeMetadataFilter(filters.featureFlag);

  // Build the dynamic WHERE clauses with bind parameters so the
  // operator-supplied filter values can never be interpolated into SQL.
  // Mirrors how `getFeedbackTrend()` adds the optional `agent` filter above.
  const params: (number | string)[] = [Math.min(100, limit)];
  const extraClauses: string[] = [];
  if (promptVersion !== null) {
    params.push(promptVersion);
    extraClauses.push(`metadata->>'prompt_version' = $${params.length}`);
  }
  if (featureFlag !== null) {
    params.push(featureFlag);
    extraClauses.push(`metadata->>'feature_flag' = $${params.length}`);
  }
  const extraSql = extraClauses.length
    ? ` AND ${extraClauses.join(" AND ")}`
    : "";

  // Project prompt_version / rating_source / client_surface out of the
  // metadata JSONB so the dashboard can render triage badges without
  // having to know the underlying column shape (Task #661). NULLIF on the
  // trimmed value collapses blanks to NULL so the rendering layer's
  // "fallback to em-dash" logic kicks in for legacy rows where
  // `metadata` is still `{}`. We also return the raw `metadata` column so
  // callers (Task #580 — AI Ops dashboard call-detail view) can render the
  // full set of feedback metadata chips beside the comment.
  const res = await pool.query(
    `SELECT id, message_id, conversation_id, agent, category, comment,
            user_email, prompt_preview, response_preview, tools_called,
            metadata, created_at,
            NULLIF(TRIM(metadata->>'prompt_version'), '') AS prompt_version,
            NULLIF(TRIM(metadata->>'rating_source'),  '') AS rating_source,
            NULLIF(TRIM(metadata->>'client_surface'), '') AS client_surface
     FROM ai_response_feedback
     WHERE rating = 'down'${extraSql}
     ORDER BY created_at DESC
     LIMIT $1`,
    params,
  );
  return res.rows.map((row) => ({
    ...row,
    // Normalize the JSONB column to a plain object so the dashboard never has
    // to defensively check for `null` before reading
    // `metadata.prompt_version`. Driver returns `null` when the column is
    // SQL NULL; older rows written before the column existed land as `{}`
    // through the `DEFAULT '{}'::jsonb` clause in initAIFeedbackTable().
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as AiCallFeedbackMetadata)
        : {},
  }));
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
  const agentFilter =
    agent && typeof agent === "string" && agent.trim()
      ? agent.trim().substring(0, 100)
      : null;

  const params: (number | string)[] = [safeDays];
  let agentClause = "";
  if (agentFilter) {
    params.push(agentFilter);
    agentClause = " AND agent = $2";
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
    params,
  );

  return res.rows.map((r) => ({
    day: r.day,
    thumbs_up: parseInt(r.thumbs_up) || 0,
    thumbs_down: parseInt(r.thumbs_down) || 0,
  }));
}

export interface FeedbackTrendSummary {
  direction: "improving" | "worsening" | "stable" | "insufficient_data";
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
export function summarizeFeedbackTrend(
  trend: FeedbackTrendPoint[],
): FeedbackTrendSummary {
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

  if (points.length < 2 || totalUp + totalDown === 0) {
    return {
      direction: "insufficient_data",
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

  let direction: FeedbackTrendSummary["direction"];
  if (Math.abs(delta) < 0.05) {
    direction = "stable";
  } else if (delta > 0) {
    direction = "worsening";
  } else {
    direction = "improving";
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
     ORDER BY agent ASC`,
  );
  return res.rows.map((r) => String(r.agent));
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
     WHERE created_at >= NOW() - INTERVAL '7 days'`,
  );

  const cats = await pool.query(
    `SELECT category, COUNT(*) AS cnt
     FROM ai_response_feedback
     WHERE rating='down' AND category IS NOT NULL
       AND created_at >= NOW() - INTERVAL '7 days'
     GROUP BY category ORDER BY cnt DESC LIMIT 5`,
  );

  const samples = await pool.query(
    `SELECT category, comment
     FROM ai_response_feedback
     WHERE rating='down'
       AND created_at >= NOW() - INTERVAL '7 days'
     ORDER BY created_at DESC
     LIMIT 5`,
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
    top_categories: cats.rows.map((r) => ({
      category: r.category,
      count: parseInt(r.cnt),
    })),
    sample_down: samples.rows,
    trend,
  };
}
