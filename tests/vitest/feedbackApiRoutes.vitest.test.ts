/**
 * Vitest happy-path tests for src/mastra/routes/feedbackApiRoutes.ts.
 *
 * Stubs the dynamic ESM imports of `../../utils/database` so we can
 * exercise the real handler logic and assert on the JSON the handler
 * returns. Tests are deterministic and need no live database.
 *
 * Run via:  npx vitest run tests/vitest/feedbackApiRoutes.vitest.test.ts
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { feedbackApiRoutes } from "../../src/mastra/routes/feedbackApiRoutes";
import { buildHandler, makeContext } from "../_helpers/fakeContext";
import { makeTeamFeedback } from "../_helpers/fixtures";

vi.mock("../../src/utils/database", () => ({
  submitFeedback: vi.fn(),
  getAllFeedback: vi.fn(),
  getFeedbackStats: vi.fn(),
}));

let db: typeof import("../../src/utils/database");

beforeEach(async () => {
  db = await import("../../src/utils/database");
  vi.clearAllMocks();
});

describe("POST /api/feedback — real data path", () => {
  test("200 returns success with feedback object from submitFeedback()", async () => {
    const feedback = makeTeamFeedback({ id: 1, submitter_name: "Alice", dashboard: "kpi", rating: 5 });
    vi.mocked(db.submitFeedback).mockResolvedValueOnce(feedback);

    const handler = await buildHandler(feedbackApiRoutes, "/api/feedback", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        body: {
          submitter_name: "Alice",
          submitter_role: "manager",
          dashboard: "kpi",
          rating: 5,
          ease_of_use: 4,
          comments: "Great tool",
          suggestions: "Add more filters",
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, feedback });
    const call = vi.mocked(db.submitFeedback).mock.calls[0][0];
    expect(call.submitter_name).toBe("Alice");
    expect(call.dashboard).toBe("kpi");
    expect(call.rating).toBe(5);
  });

  test("400 when submitter_name / dashboard / rating are missing", async () => {
    const handler = await buildHandler(feedbackApiRoutes, "/api/feedback", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        body: { submitter_name: "Bob", dashboard: "qms" },
      }),
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Name, dashboard, and rating are required" });
    expect(db.submitFeedback).not.toHaveBeenCalled();
  });

  test("500 with deterministic body when submitFeedback throws", async () => {
    vi.mocked(db.submitFeedback).mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const handler = await buildHandler(feedbackApiRoutes, "/api/feedback", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        body: { submitter_name: "Alice", dashboard: "kpi", rating: 4 },
      }),
    );

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to submit feedback" });
    errSpy.mockRestore();
  });
});

describe("GET /api/feedback — real data path", () => {
  test("200 returns { feedback: [...] } from getAllFeedback()", async () => {
    const items = [makeTeamFeedback({ id: 1, dashboard: "kpi", rating: 5 })];
    vi.mocked(db.getAllFeedback).mockResolvedValueOnce(items);

    const handler = await buildHandler(feedbackApiRoutes, "/api/feedback", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        query: { dashboard: "kpi", startDate: "2026-01-01", endDate: "2026-12-31" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ feedback: items });
    expect(db.getAllFeedback).toHaveBeenCalledWith({
      dashboard: "kpi",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
  });

  test("200 passes undefined filters when query params are absent", async () => {
    vi.mocked(db.getAllFeedback).mockResolvedValueOnce([]);

    const handler = await buildHandler(feedbackApiRoutes, "/api/feedback", "GET");
    await handler(makeContext({ method: "GET" }));

    expect(db.getAllFeedback).toHaveBeenCalledWith({
      dashboard: undefined,
      startDate: undefined,
      endDate: undefined,
    });
  });
});

describe("GET /api/feedback/stats — real data path", () => {
  test("200 returns getFeedbackStats() result directly", async () => {
    const stats: Awaited<ReturnType<typeof db.getFeedbackStats>> = {
      totalFeedback: 42,
      avgRating: 4.2,
      avgEaseOfUse: 3.8,
      byDashboard: [],
      recentFeedback: [],
    };
    vi.mocked(db.getFeedbackStats).mockResolvedValueOnce(stats);

    const handler = await buildHandler(feedbackApiRoutes, "/api/feedback/stats", "GET");
    const res = await handler(makeContext({ method: "GET" }));

    expect(res.status).toBe(200);
    expect(res.body).toBe(stats);
    expect(db.getFeedbackStats).toHaveBeenCalledTimes(1);
  });

  test("500 with deterministic body when getFeedbackStats throws", async () => {
    vi.mocked(db.getFeedbackStats).mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const handler = await buildHandler(feedbackApiRoutes, "/api/feedback/stats", "GET");
    const res = await handler(makeContext({ method: "GET" }));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to fetch feedback stats" });
    errSpy.mockRestore();
  });
});
