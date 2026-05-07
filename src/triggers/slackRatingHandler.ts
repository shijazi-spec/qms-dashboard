/**
 * Slack Consultant Rating Handler — Task #763
 *
 * Helper used by the Slack thumbs-up/down bot (and the pattern any future
 * non-web rating surface — mobile app, embedded widget — should follow)
 * to record a rating on an AI consultant call so the AI Operations
 * dashboard attributes the rating to the right prompt revision and the
 * right UI surface.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 * Task #589 wired `promptVersion` + `clientSurface` through both rating
 * paths (`POST /api/ai-ops/feedback` and `POST /api/consultant/feedback`)
 * for the WEB consultant chat. The web client knows the prompt version
 * because the streaming response echoes it back in the `done` SSE frame
 * so the inline thumbs UI can include it on the rating POST.
 *
 * Other surfaces (Slack bot, mobile app, embedded widget) typically only
 * have the `callId` of the response the user reacted to. They do NOT
 * carry the version echo, so without this helper their ratings would
 * land in the dashboard with `metadata->>'prompt_version'` = NULL — the
 * "(unknown)" bucket — and `metadata->>'client_surface'` = NULL too,
 * making it impossible to tell whether a regression is a Slack-only
 * problem or a system-wide one.
 *
 * ── How to wire up a new surface ────────────────────────────────────────
 * 1. Identify the `callId` your surface received (returned by
 *    `withAiTelemetry()` and surfaced on consultant streaming responses
 *    as `callId`). Pass it through to wherever your surface captures
 *    the user's thumbs-up/down.
 * 2. Call {@link recordConsultantRatingFromSurface} with:
 *      - `callId`     — number, the rated call's row id
 *      - `rating`     — 'thumbs_up' | 'thumbs_down'
 *      - `surface`    — short literal: 'slack' | 'mobile' | 'embedded'
 *      - `userHash`   — anonymous-safe identifier (Slack user id, etc.)
 *      - `comment`    — optional, capped to FEEDBACK_COMMENT_MAX_LEN
 * 3. The helper looks up `metadata->>'prompt_version'` from
 *    `ai_call_metrics` for that `callId` (server-side source of truth)
 *    and writes the rating + the version + the surface marker through
 *    the same persistence path the web call-id rating endpoint uses.
 *
 * Treat any new surface like another rating client of the same backend:
 * do NOT bypass `insertCallFeedback` / `setCallPromptVersionIfMissing` /
 * `setCallClientSurfaceIfMissing` — they enforce the dedupe constraint,
 * the never-overwrite-server-truth rule, and the length caps that keep
 * `ai_call_metrics.metadata` clean.
 */

import {
  insertCallFeedback,
  setCallPromptVersionIfMissing,
  setCallClientSurfaceIfMissing,
  getCallPromptVersion,
} from "../utils/aiTelemetry";
import { logger } from "../utils/logger";

export type ConsultantRatingSurface =
  | "slack"
  | "mobile"
  | "embedded"
  | string;

export interface RecordConsultantRatingInput {
  /** `ai_call_metrics.id` of the response the user reacted to. */
  callId: number;
  /** Thumbs-up or thumbs-down. Mirrors the call-id endpoint's enum. */
  rating: "thumbs_up" | "thumbs_down";
  /**
   * Surface marker that lands in `metadata->>'client_surface'`.
   * Use a short literal — `'slack'`, `'mobile'`, `'embedded'` — to keep
   * the dashboard breakdown stable.
   */
  surface: ConsultantRatingSurface;
  /**
   * Stable identifier for the rater. Slack passes the user id; mobile
   * passes the authenticated user id. Hashed downstream by
   * `insertCallFeedback`, so callers don't need to anonymise it
   * themselves — but they MUST pass something stable so the
   * one-rating-per-(call,user) UNIQUE constraint dedupes correctly.
   */
  userHash?: string;
  /** Optional free-form comment; sanitised + length-capped downstream. */
  comment?: string | null;
}

export interface RecordConsultantRatingResult {
  /** True when the rating row was inserted/updated. */
  success: boolean;
  /**
   * The prompt version this rating was attributed to (looked up from
   * `ai_call_metrics.metadata->>'prompt_version'`), or null when the
   * row had none recorded — matching the dashboard's "(unknown)"
   * bucketing rather than fabricating a value.
   */
  promptVersion: string | null;
}

/**
 * Record a consultant rating arriving from a non-web surface.
 *
 * Looks up the server-side `prompt_version` for the rated call,
 * inserts the thumbs-up/down row, and backfills the surface marker
 * onto `ai_call_metrics.metadata` when missing — using the same
 * never-overwrite-server-truth helpers the web call-id endpoint uses.
 *
 * Errors are logged and surfaced as `{ success: false }` so the caller
 * (Slack action handler, mobile API route, etc.) can decide whether to
 * react in-channel — but the helper itself never throws.
 */
export async function recordConsultantRatingFromSurface(
  input: RecordConsultantRatingInput,
): Promise<RecordConsultantRatingResult> {
  const { callId, rating, surface, userHash, comment } = input;

  if (!Number.isFinite(callId) || callId <= 0) {
    logger.warn("[slackRatingHandler] invalid callId", { callId });
    return { success: false, promptVersion: null };
  }
  if (rating !== "thumbs_up" && rating !== "thumbs_down") {
    logger.warn("[slackRatingHandler] invalid rating", { rating });
    return { success: false, promptVersion: null };
  }

  // Look up the version that was active when the response was generated.
  // The dashboard reads this same `metadata->>'prompt_version'` field, so
  // attributing the rating to whatever the row already carries keeps the
  // join tight and avoids fabricating a value the surface couldn't have
  // observed.
  const promptVersion = await getCallPromptVersion(callId);

  const success = await insertCallFeedback(
    callId,
    rating,
    userHash,
    comment ?? null,
  );

  if (!success) {
    return { success: false, promptVersion };
  }

  // Best-effort metadata fill — must not flip the rating to a failure if
  // the UPDATE doesn't land (legacy row may have been pruned by the
  // retention sweep between the read above and this write).
  if (promptVersion) {
    await setCallPromptVersionIfMissing(callId, promptVersion);
  }
  await setCallClientSurfaceIfMissing(callId, surface);

  return { success: true, promptVersion };
}
