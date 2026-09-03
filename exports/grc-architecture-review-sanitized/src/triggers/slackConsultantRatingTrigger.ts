/**
 * Slack Consultant Rating Bot — Task #801
 *
 * Slack interactive endpoint that receives `block_actions` payloads when
 * a Slack user clicks the thumbs-up / thumbs-down buttons attached to a
 * consultant reply, verifies the request signature, and forwards the
 * rating into the AI Operations dashboard via the
 * {@link recordConsultantRatingFromSurface} helper added in Task #763.
 *
 * ── Wire-up flow ────────────────────────────────────────────────────────
 *  1. The consultant Slack message is posted with a pair of buttons whose
 *     `block_id` is `consultant_rating:<callId>` and whose `action_id` is
 *     either `thumbs_up` or `thumbs_down` (see
 *     {@link buildConsultantRatingBlocks} — the canonical schema).
 *  2. Slack POSTs an `application/x-www-form-urlencoded` body with a
 *     single `payload=<json>` field to this endpoint when the user clicks
 *     a button.
 *  3. The handler verifies `X-Slack-Signature` + `X-Slack-Request-Timestamp`
 *     against `SLACK_SIGNING_SECRET` BEFORE doing anything else (per
 *     Slack's spec) and rejects requests older than 5 minutes to defeat
 *     replay attacks.
 *  4. It calls `recordConsultantRatingFromSurface({ callId, rating,
 *     surface: 'slack', userHash })` so the rating lands with
 *     `metadata->>'client_surface' = 'slack'` and the prompt-version
 *     attribution lookup runs server-side.
 *  5. Slack requires a response within 3 seconds; the handler ACKs
 *     immediately and POSTs the "Thanks for the feedback!" replacement
 *     blocks back to Slack via the `response_url` so the original
 *     buttons disappear and the user sees confirmation in-channel.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { Context } from "hono";

import { registerApiRoute } from "../mastra/inngest";
import { logger } from "../utils/logger";
import { recordConsultantRatingFromSurface } from "./slackRatingHandler";
import type { ApiRoute } from "./slackTriggers";

// Slack rejects timestamps older than 5 minutes for replay defence; we
// mirror their cutoff here so a captured request can't be re-sent later.
const SLACK_REPLAY_WINDOW_SECONDS = 60 * 5;

/** Stable block_id prefix; the suffix carries the rated callId. */
const RATING_BLOCK_ID_PREFIX = "consultant_rating:";

/** Action IDs Slack sends back on button click. Mirrors the rating enum. */
const ACTION_ID_THUMBS_UP = "thumbs_up";
const ACTION_ID_THUMBS_DOWN = "thumbs_down";

export interface ConsultantRatingButtonOptions {
  /** Optional override for the prompt shown above the buttons. */
  prompt?: string;
}

/**
 * Build the Slack Block Kit blocks that render the thumbs-up / thumbs-down
 * buttons under a consultant reply. Exported so the consultant Slack
 * notifier (and any other surface that posts a consultant reply into
 * Slack) uses the SAME `block_id` / `action_id` schema this endpoint
 * parses — keep these in sync.
 */
export function buildConsultantRatingBlocks(
  callId: number,
  options: ConsultantRatingButtonOptions = {},
): unknown[] {
  if (!Number.isFinite(callId) || callId <= 0) {
    throw new Error(
      `buildConsultantRatingBlocks: callId must be a positive integer (got ${callId})`,
    );
  }
  const value = String(callId);
  return [
    {
      type: "actions",
      block_id: `${RATING_BLOCK_ID_PREFIX}${value}`,
      elements: [
        {
          type: "button",
          action_id: ACTION_ID_THUMBS_UP,
          text: { type: "plain_text", text: ":+1: Helpful", emoji: true },
          value,
        },
        {
          type: "button",
          action_id: ACTION_ID_THUMBS_DOWN,
          text: { type: "plain_text", text: ":-1: Not helpful", emoji: true },
          value,
        },
      ],
    },
    ...(options.prompt
      ? [
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: options.prompt }],
          },
        ]
      : []),
  ];
}

/**
 * Verify a Slack request signature per
 * <REDACTED_URL>
 * Caller must pass the RAW request body (verbatim, before JSON / form
 * parsing) — even one byte difference invalidates the HMAC.
 */
export function verifySlackSignature(params: {
  signingSecret: string;
  timestamp: string;
  signature: string;
  rawBody: string;
  nowSeconds?: number;
}): boolean {
  const { signingSecret, timestamp, signature, rawBody } = params;
  if (!signingSecret || !timestamp || !signature) return false;

  const tsNum = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(tsNum)) return false;

  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > SLACK_REPLAY_WINDOW_SECONDS) {
    return false;
  }

  const expected =
    "v0=" +
    createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex");

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(sigBuf, expectedBuf);
  } catch {
    return false;
  }
}

interface ParsedRatingAction {
  callId: number;
  rating: "thumbs_up" | "thumbs_down";
  userId: string | undefined;
  responseUrl: string | undefined;
}

/**
 * Pull the (callId, rating, userId, responseUrl) tuple out of a Slack
 * `block_actions` payload. Returns null when the payload doesn't carry
 * one of our consultant-rating buttons (e.g. an unrelated interactive
 * component shares the same endpoint).
 */
export function parseConsultantRatingAction(
  payload: any,
): ParsedRatingAction | null {
  if (!payload || payload.type !== "block_actions") return null;
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  for (const action of actions) {
    const blockId =
      typeof action?.block_id === "string" ? action.block_id : "";
    if (!blockId.startsWith(RATING_BLOCK_ID_PREFIX)) continue;

    const actionId = action?.action_id;
    let rating: "thumbs_up" | "thumbs_down";
    if (actionId === ACTION_ID_THUMBS_UP) rating = "thumbs_up";
    else if (actionId === ACTION_ID_THUMBS_DOWN) rating = "thumbs_down";
    else continue;

    // Prefer the explicit `value` Slack echoes back from the button (set
    // by buildConsultantRatingBlocks); fall back to the block_id suffix
    // so a manually-built button still works as long as the schema lines
    // up.
    const rawValue =
      typeof action.value === "string" && action.value.length > 0
        ? action.value
        : blockId.slice(RATING_BLOCK_ID_PREFIX.length);
    const callId = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(callId) || callId <= 0) continue;

    const userId =
      typeof payload?.user?.id === "string" ? payload.user.id : undefined;
    const responseUrl =
      typeof payload?.response_url === "string"
        ? payload.response_url
        : undefined;
    return { callId, rating, userId, responseUrl };
  }
  return null;
}

function buildAcknowledgementBlocks(
  rating: "thumbs_up" | "thumbs_down",
  userId: string | undefined,
): unknown[] {
  const emoji = rating === "thumbs_up" ? ":+1:" : ":-1:";
  const who = userId ? `<@${userId}>` : "you";
  return [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${emoji} Thanks for the feedback, ${who}!`,
        },
      ],
    },
  ];
}

async function postConfirmationToSlack(
  responseUrl: string,
  rating: "thumbs_up" | "thumbs_down",
  userId: string | undefined,
): Promise<void> {
  try {
    const res = await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replace_original: true,
        text: "Thanks for the feedback!",
        blocks: buildAcknowledgementBlocks(rating, userId),
      }),
    });
    if (!res.ok) {
      logger.warn("[slackConsultantRating] response_url returned non-OK", {
        status: res.status,
      });
    }
  } catch (err) {
    logger.error(
      "[slackConsultantRating] Failed to POST confirmation to Slack",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
}

/**
 * The Hono handler. Exported so it can be unit-tested without spinning
 * up the full Mastra server.
 */
export async function handleSlackConsultantRatingRequest(
  c: Context,
): Promise<Response> {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    // Without a signing secret we cannot verify ANY request, so refuse
    // to accept ratings rather than open an unauthenticated write to
    // ai_call_feedback.
    logger.warn(
      "[slackConsultantRating] SLACK_SIGNING_SECRET not configured; rejecting",
    );
    return c.text("Slack signing secret not configured", 503);
  }

  // Read the body verbatim FIRST — signature verification needs the
  // exact bytes Slack signed. Parsing must happen after the HMAC check.
  const rawBody = await c.req.text();
  const signature = c.req.header("x-slack-signature") ?? "";
  const timestamp = c.req.header("x-slack-request-timestamp") ?? "";

  if (
    !verifySlackSignature({
      signingSecret,
      timestamp,
      signature,
      rawBody,
    })
  ) {
    logger.warn("[slackConsultantRating] Invalid Slack signature");
    return c.text("Invalid signature", 401);
  }

  // Slack interactive payloads arrive as form-urlencoded with a single
  // `payload=<json>` field.
  let payload: any;
  try {
    const params = new URLSearchParams(rawBody);
    const payloadStr = params.get("payload");
    if (!payloadStr) {
      return c.text("Missing payload", 400);
    }
    payload = JSON.parse(payloadStr);
  } catch (err) {
    logger.warn("[slackConsultantRating] Failed to parse payload", {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.text("Malformed payload", 400);
  }

  const action = parseConsultantRatingAction(payload);
  if (!action) {
    // Not a consultant-rating click — ack so Slack doesn't keep retrying
    // but otherwise ignore (other interactive components may share the
    // same endpoint in the future).
    return c.text("", 200);
  }

  const { callId, rating, userId, responseUrl } = action;

  // Run the rating write + the confirmation POST without blocking the
  // ack response — Slack times out the interactive request at ~3s, and
  // the rating helper / response_url POST should not delay that ack.
  void (async () => {
    try {
      const result = await recordConsultantRatingFromSurface({
        callId,
        rating,
        surface: "slack",
        userHash: userId,
      });
      if (!result.success) {
        logger.warn(
          "[slackConsultantRating] recordConsultantRatingFromSurface returned failure",
          { callId, rating, userId },
        );
      }
    } catch (err) {
      logger.error(
        "[slackConsultantRating] recordConsultantRatingFromSurface threw",
        {
          callId,
          rating,
          userId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }

    if (responseUrl) {
      await postConfirmationToSlack(responseUrl, rating, userId);
    }
  })();

  return c.text("", 200);
}

/**
 * Build the api-route entries to spread into the Mastra `apiRoutes`
 * array in `src/mastra/index.ts`. Mirrors the dual-path pattern used by
 * `registerSlackTrigger` (one path under `/webhooks/...` for Slack to
 * call directly, plus an `/api/webhooks/...` alias for callers behind
 * the `/api` prefix).
 */
export function registerSlackConsultantRatingRoutes(): ApiRoute[] {
  return [
    registerApiRoute("/webhooks/slack/consultant-rating", {
      method: "POST",
      handler: handleSlackConsultantRatingRequest,
    }),
    {
      path: "/api/webhooks/slack/consultant-rating",
      method: "POST",
      handler: handleSlackConsultantRatingRequest,
    },
  ];
}
