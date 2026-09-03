/**
 * Mobile Consultant Rating Routes — Task #802
 *
 * Backend entry points the upcoming ExampleOrg mobile app uses to record
 * thumbs-up/down ratings on AI consultant responses. This is the
 * `'mobile'` analogue of the Slack rating handler (Task #589 / #763): the
 * mobile client only knows the `callId` (or `messageId`) of the response
 * it rendered — it does NOT carry the prompt-version registry — so these
 * routes own the version lookup + the surface marker server-side and
 * delegate to the same persistence helpers the web call-id endpoint uses.
 *
 * ── Why a dedicated mobile route (vs. reusing /api/ai-ops/feedback) ────
 * The `clientSurface` field on the shared rating endpoints is a HINT from
 * the caller — convenient for the web client which is trusted to label
 * its own surface honestly. A mobile-shaped route lets us PIN the surface
 * marker to `'mobile'` server-side instead of trusting whatever the
 * mobile client posts, so the per-surface breakdown in the AI Ops
 * dashboard (`getFeedbackBreakdownByPromptVersion().client_surfaces`)
 * cannot be poisoned by a buggy / tampered mobile build claiming to be
 * the web chat.
 *
 * ── Done looks like ────────────────────────────────────────────────────
 * - Mobile thumbs-up/down on a callId  →  POST /api/mobile/consultant/feedback
 *   delegates to recordConsultantRatingFromSurface({ surface: 'mobile' })
 *   so the server reads `metadata->>'prompt_version'` from
 *   `ai_call_metrics` and writes the rating + the surface marker.
 * - Mobile thumbs-up/down on a messageId  →  POST /api/mobile/consultant/message-feedback
 *   forwards to saveFeedback() with `clientSurface: 'mobile'` forced on
 *   the metadata builder regardless of caller input.
 * - Mobile ratings appear under `client_surface = 'mobile'` in the AI
 *   Ops per-surface breakdown.
 */

import { requireRole } from "../../utils/rbacMiddleware";
import type { UserRole } from "../../utils/rbacDatabase";
import { recordConsultantRatingFromSurface } from "../../triggers/slackRatingHandler";
import {
  saveFeedback,
  buildAiCallFeedbackMetadata,
} from "../../utils/aiFeedbackDatabase";
import { FEEDBACK_COMMENT_MAX_LEN } from "../../utils/aiTelemetry";
import { QMS_CONSULTANT_PROMPT_VERSION } from "../agents/qmsConsultantAgent";
import { logger } from "../../utils/logger";

/**
 * Same role-set the web consultant chat uses (CONSULTANT_ROLES in
 * consultantRoutes). The mobile app authenticates against the same RBAC
 * layer as the web dashboard — there is no separate "mobile user" tier —
 * so reusing the list keeps the access policy in lock-step.
 */
const MOBILE_CONSULTANT_ROLES: UserRole[] = [
  "admin",
  "ai_specialist",
  "grc_manager",
  "head_of_operations_quality",
];

/**
 * Surface marker pinned server-side. NOT taken from the request body —
 * see the file header for the rationale. If a future build wants to
 * distinguish iOS vs Android we'd extend the helper, not the wire format.
 */
const MOBILE_SURFACE = "mobile" as const;

/**
 * Trim, drop empties, clamp length. Mirrors the `safeMetaString` helper
 * in consultantRoutes so the same validation contract applies wherever
 * a client-supplied metadata string lands in the JSONB column.
 */
function safeMetaString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

export const mobileRoutes = [
  /**
   * Call-id rating from the mobile app. The mobile client only knows the
   * `callId` it received on the streaming response — it does NOT carry
   * the prompt-version registry, so we delegate to the shared helper
   * which looks up `metadata->>'prompt_version'` from `ai_call_metrics`
   * server-side and writes the surface marker via the never-overwrite
   * helpers.
   */
  {
    path: "/api/mobile/consultant/feedback",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, MOBILE_CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const body = await c.req.json();
          const { callId, rating, comment } = body;

          const parsedCallId = parseInt(String(callId ?? ""), 10);
          if (
            !Number.isFinite(parsedCallId) ||
            parsedCallId <= 0 ||
            !["thumbs_up", "thumbs_down"].includes(rating)
          ) {
            return c.json(
              {
                error:
                  "callId (positive integer) and rating ('thumbs_up'|'thumbs_down') are required",
              },
              400,
            );
          }

          let cleanComment: string | undefined;
          if (comment != null) {
            if (typeof comment !== "string") {
              return c.json({ error: "comment must be a string" }, 400);
            }
            if (comment.length > FEEDBACK_COMMENT_MAX_LEN) {
              return c.json(
                {
                  error: `comment exceeds ${FEEDBACK_COMMENT_MAX_LEN} character limit`,
                },
                400,
              );
            }
            cleanComment = comment;
          }

          const result = await recordConsultantRatingFromSurface({
            callId: parsedCallId,
            rating: rating as "thumbs_up" | "thumbs_down",
            // Pinned server-side — see file header. Ignoring any
            // `clientSurface` the caller supplied is intentional.
            surface: MOBILE_SURFACE,
            userHash: String(user.userId),
            comment: cleanComment ?? null,
          });

          return c.json({
            success: result.success,
            promptVersion: result.promptVersion,
          });
        } catch (error) {
          logger.error("[Mobile] consultant feedback error:", error);
          return c.json({ error: "Failed to record feedback" }, 500);
        }
      };
    },
  },

  /**
   * Message-id rating from the mobile app. Mirrors the web chat's
   * /api/consultant/feedback shape, but with `clientSurface` PINNED to
   * `'mobile'` server-side. The mobile client SHOULD echo the
   * `promptVersion` it observed on the chat response so analytics
   * attributes the rating to the exact prompt revision the user reacted
   * to; we fall back to the current server-side constant only when the
   * client didn't send one (older mobile builds).
   */
  {
    path: "/api/mobile/consultant/message-feedback",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, MOBILE_CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const body = await c.req.json();
          const {
            messageId,
            conversationId,
            rating,
            category,
            comment,
            promptPreview,
            responsePreview,
            toolsCalled,
            promptVersion: clientPromptVersion,
          } = body;

          if (!messageId || !rating || !["up", "down"].includes(rating)) {
            return c.json(
              {
                error: "messageId and valid rating ('up'|'down') are required",
              },
              400,
            );
          }

          // ratingSource defaults to 'inline_thumbs' (matches the web
          // chat's inline thumbs UI). clientSurface is PINNED to
          // 'mobile' regardless of any value in the request body — see
          // the file header for the trust rationale.
          const feedbackMetadata = buildAiCallFeedbackMetadata({
            promptVersion:
              safeMetaString(clientPromptVersion, 100) ??
              QMS_CONSULTANT_PROMPT_VERSION,
            ratingSource: "inline_thumbs",
            clientSurface: MOBILE_SURFACE,
          });

          const result = await saveFeedback({
            message_id: messageId,
            conversation_id: conversationId || undefined,
            agent: "qmsConsultantAgent",
            rating,
            category: category || undefined,
            comment: comment ? String(comment).substring(0, 1000) : undefined,
            user_id: String(user.userId),
            user_email: user.email,
            prompt_preview: promptPreview || undefined,
            response_preview: responsePreview || undefined,
            tools_called: toolsCalled
              ? JSON.stringify(toolsCalled).substring(0, 1000)
              : undefined,
            metadata: feedbackMetadata,
          });

          return c.json({ success: true, id: result.id });
        } catch (error) {
          logger.error("[Mobile] consultant message-feedback error:", error);
          return c.json({ error: "Failed to save feedback" }, 500);
        }
      };
    },
  },
];
