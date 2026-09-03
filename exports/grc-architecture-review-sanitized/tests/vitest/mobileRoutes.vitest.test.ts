/**
 * Vitest gate for the mobile rating routes (Task #802).
 *
 * The mobile-shaped rating endpoints exist specifically so the
 * `client_surface` marker that lands in
 * `ai_call_metrics.metadata->>'client_surface'` (call-id path) and
 * `ai_response_feedback.metadata->>'client_surface'` (message-id path)
 * is PINNED to `'mobile'` server-side — i.e. cannot be poisoned by a
 * buggy / tampered mobile build claiming to be the web chat. This test
 * locks that contract in:
 *
 *   1. POST /api/mobile/consultant/feedback (call-id path) MUST delegate
 *      to recordConsultantRatingFromSurface with `surface: 'mobile'`,
 *      regardless of any `clientSurface` field in the request body.
 *   2. POST /api/mobile/consultant/message-feedback (message-id path)
 *      MUST forward to saveFeedback with metadata.client_surface =
 *      'mobile', regardless of any `clientSurface` field in the body.
 *
 * Anti-tautology: the request body in each case explicitly sets a
 * different surface ('web', 'ChatProvider') and the assertions verify the
 * caller's value was IGNORED and 'mobile' was used instead.
 *
 * Run via:  npx vitest run tests/vitest/mobileRoutes.vitest.test.ts
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/triggers/ChatProviderRatingHandler", () => ({
  recordConsultantRatingFromSurface: vi.fn(),
}));

vi.mock("../../src/utils/aiFeedbackDatabase", () => ({
  saveFeedback: vi.fn(),
  // The route imports buildAiCallFeedbackMetadata for the metadata
  // allow-list. Reuse the real shape (echo input as snake_case) so the
  // assertions below can read `client_surface` / `prompt_version` off
  // the metadata the route hands to saveFeedback.
  buildAiCallFeedbackMetadata: (input: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    if (input.promptVersion != null) out.prompt_version = input.promptVersion;
    if (input.ratingSource != null) out.rating_source = input.ratingSource;
    if (input.clientSurface != null) out.client_surface = input.clientSurface;
    return out;
  },
}));

vi.mock("../../src/utils/rbacMiddleware", () => ({
  requireRole: vi.fn(async () => ({
    userId: "mobile-tester-1",
    email: "<REDACTED_EMAIL>",
    role: "ai_specialist",
  })),
}));

import { mobileRoutes } from "../../src/mastra/routes/mobileRoutes";
import { buildHandler, makeContext } from "../_helpers/fakeContext";

let ChatProvider: typeof import("../../src/triggers/ChatProviderRatingHandler");
let feedbackDb: typeof import("../../src/utils/aiFeedbackDatabase");

beforeEach(async () => {
  ChatProvider = await import("../../src/triggers/ChatProviderRatingHandler");
  feedbackDb = await import("../../src/utils/aiFeedbackDatabase");
  vi.clearAllMocks();
  vi.mocked(ChatProvider.recordConsultantRatingFromSurface).mockResolvedValue({
    success: true,
    promptVersion: "qms-consultant-vTEST",
  });
  vi.mocked(feedbackDb.saveFeedback).mockResolvedValue({ id: 999 });
});

describe("POST /api/mobile/consultant/feedback (call-id path)", () => {
  test("forces surface='mobile' even if body claims a different surface", async () => {
    const handler = await buildHandler(
      mobileRoutes,
      "/api/mobile/consultant/feedback",
      "POST",
    );
    const res = await handler(
      makeContext({
        method: "POST",
        body: {
          callId: 42,
          rating: "thumbs_up",
          comment: "nice",
          // Anti-tautology: caller LIES about its surface — must be ignored.
          clientSurface: "web",
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(ChatProvider.recordConsultantRatingFromSurface).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(ChatProvider.recordConsultantRatingFromSurface).mock
      .calls[0][0];
    expect(arg.surface).toBe("mobile");
    expect(arg.callId).toBe(42);
    expect(arg.rating).toBe("thumbs_up");
    expect(arg.userHash).toBe("mobile-tester-1");
    expect(arg.comment).toBe("nice");
    expect(res.body).toEqual({
      success: true,
      promptVersion: "qms-consultant-vTEST",
    });
  });

  test("rejects non-positive callId with 400 and does not call helper", async () => {
    const handler = await buildHandler(
      mobileRoutes,
      "/api/mobile/consultant/feedback",
      "POST",
    );
    const res = await handler(
      makeContext({ method: "POST", body: { callId: -1, rating: "thumbs_up" } }),
    );
    expect(res.status).toBe(400);
    expect(ChatProvider.recordConsultantRatingFromSurface).not.toHaveBeenCalled();
  });

  test("rejects unknown rating with 400", async () => {
    const handler = await buildHandler(
      mobileRoutes,
      "/api/mobile/consultant/feedback",
      "POST",
    );
    const res = await handler(
      makeContext({
        method: "POST",
        body: { callId: 1, rating: "love_it" },
      }),
    );
    expect(res.status).toBe(400);
    expect(ChatProvider.recordConsultantRatingFromSurface).not.toHaveBeenCalled();
  });
});

describe("POST /api/mobile/consultant/message-feedback (message-id path)", () => {
  test("forces metadata.client_surface='mobile' even if body claims a different surface", async () => {
    const handler = await buildHandler(
      mobileRoutes,
      "/api/mobile/consultant/message-feedback",
      "POST",
    );
    const res = await handler(
      makeContext({
        method: "POST",
        body: {
          messageId: "msg-abc",
          rating: "down",
          promptVersion: "qms-consultant-vCLIENT",
          // Anti-tautology: caller LIES about its surface — must be ignored.
          clientSurface: "ChatProvider",
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(feedbackDb.saveFeedback).toHaveBeenCalledTimes(1);
    const fb = vi.mocked(feedbackDb.saveFeedback).mock.calls[0][0];
    expect(fb.metadata?.client_surface).toBe("mobile");
    expect(fb.metadata?.prompt_version).toBe("qms-consultant-vCLIENT");
    expect(fb.metadata?.rating_source).toBe("inline_thumbs");
    expect(fb.message_id).toBe("msg-abc");
    expect(fb.rating).toBe("down");
    expect(fb.user_id).toBe("mobile-tester-1");
    expect(res.body).toEqual({ success: true, id: 999 });
  });

  test("rejects missing messageId with 400", async () => {
    const handler = await buildHandler(
      mobileRoutes,
      "/api/mobile/consultant/message-feedback",
      "POST",
    );
    const res = await handler(makeContext({ method: "POST", body: { rating: "up" } }));
    expect(res.status).toBe(400);
    expect(feedbackDb.saveFeedback).not.toHaveBeenCalled();
  });

  test("rejects call-id-style rating ('thumbs_up') with 400", async () => {
    const handler = await buildHandler(
      mobileRoutes,
      "/api/mobile/consultant/message-feedback",
      "POST",
    );
    const res = await handler(
      makeContext({
        method: "POST",
        body: { messageId: "x", rating: "thumbs_up" },
      }),
    );
    expect(res.status).toBe(400);
    expect(feedbackDb.saveFeedback).not.toHaveBeenCalled();
  });
});
