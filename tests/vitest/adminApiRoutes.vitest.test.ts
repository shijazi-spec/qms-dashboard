/**
 * Vitest happy-path tests for src/mastra/routes/adminApiRoutes.ts.
 *
 * Complements the auth-boundary suite at tests/adminApiRoutes.test.ts by
 * stubbing the dynamic ESM imports of `../../utils/database` so we can
 * exercise the *real database paths* of each route — i.e. assert that the
 * route forwards the correct arguments to the data layer and returns the
 * exact JSON body back to the client. Tests are deterministic and need no
 * live database.
 *
 * Run via:  npx vitest run tests/vitest/adminApiRoutes.vitest.test.ts
 * Or as part of:  npm test  (see tests/runIntegrationTests.ts)
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { adminApiRoutes } from "../../src/mastra/routes/adminApiRoutes";
import type { AdminActivity } from "../../src/utils/database";
import { buildHandler, makeContext } from "../_helpers/fakeContext";
import {
  makeAdminActivity,
  makeGovernanceDocument,
  makeScorecard,
  makeSystemEvent,
  makeWorkflowRun,
} from "../_helpers/fixtures";

vi.mock("../../src/utils/database", () => ({
  getAllGovernanceDocuments: vi.fn(),
  saveGovernanceDocument: vi.fn(),
  activateGovernanceDocument: vi.fn(),
  updateScorecardWeights: vi.fn(),
  addScorecardAttribute: vi.fn(),
  linkScorecardToGovernanceDoc: vi.fn(),
  getScorecardsByModuleAndTeam: vi.fn(),
  createScorecard: vi.fn(),
  updateScorecard: vi.fn(),
  deleteScorecard: vi.fn(),
  setActiveScorecardForTeam: vi.fn(),
  cloneScorecard: vi.fn(),
  getScorecardAttributes: vi.fn(),
  createScorecardAttribute: vi.fn(),
  updateScorecardAttribute: vi.fn(),
  deleteScorecardAttribute: vi.fn(),
  reorderScorecardAttributes: vi.fn(),
  saveScorecard: vi.fn(),
  getAdminActivities: vi.fn(),
  getWorkflowRuns: vi.fn(),
  getWorkflowRunById: vi.fn(),
  getSystemEvents: vi.fn(),
  getActivityFeed: vi.fn(),
  getActivityStats: vi.fn(),
  logAdminActivity: vi.fn((activity: AdminActivity) => Promise.resolve(activity)),
}));

const ADMIN_KEY = "vitest-admin-key-2026";
const AUTH_HEADERS = { "X-Admin-Key": ADMIN_KEY };

let db: typeof import("../../src/utils/database");

beforeEach(async () => {
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  db = await import("../../src/utils/database");
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.ADMIN_API_KEY;
});

describe("GET /api/admin/documents — real data path", () => {
  test("200 returns getAllGovernanceDocuments() result", async () => {
    const docs = [makeGovernanceDocument({ id: 1, name: "doc" })];
    vi.mocked(db.getAllGovernanceDocuments).mockResolvedValueOnce(docs);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/documents", "GET");
    const res = await handler(makeContext({ method: "GET", headers: AUTH_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(docs);
    expect(db.getAllGovernanceDocuments).toHaveBeenCalledTimes(1);
  });
});

describe("PUT /api/admin/scorecard/weights — real data path", () => {
  test("200 returns updated scorecard and logs activity", async () => {
    const scorecard = makeScorecard({ id: 3, name: "S1" });
    vi.mocked(db.updateScorecardWeights).mockResolvedValueOnce(scorecard);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/scorecard/weights", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: AUTH_HEADERS,
        body: { people: 30, process: 40, governance: 30 },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(scorecard);
    expect(db.updateScorecardWeights).toHaveBeenCalledWith({
      people: 30,
      process: 40,
      governance: 30,
    });
    expect(db.logAdminActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.logAdminActivity).mock.calls[0][0].action_type).toBe(
      "scorecard_weights_update",
    );
  });

  test("404 when no active scorecard found and no activity logged", async () => {
    vi.mocked(db.updateScorecardWeights).mockResolvedValueOnce(null);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/scorecard/weights", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: AUTH_HEADERS,
        body: { people: 33, process: 33, governance: 34 },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No active scorecard found" });
    expect(db.logAdminActivity).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/scorecards — real data path", () => {
  test("200 forwards crm_module + team_name to getScorecardsByModuleAndTeam()", async () => {
    const scorecards = [makeScorecard({ id: 1 }), makeScorecard({ id: 2 })];
    vi.mocked(db.getScorecardsByModuleAndTeam).mockResolvedValueOnce(scorecards);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/scorecards", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: AUTH_HEADERS,
        query: { crm_module: "sales", team_name: "alpha" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(scorecards);
    expect(db.getScorecardsByModuleAndTeam).toHaveBeenCalledWith("sales", "alpha");
  });

  test("200 passes nulls when crm_module / team_name absent", async () => {
    vi.mocked(db.getScorecardsByModuleAndTeam).mockResolvedValueOnce([]);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/scorecards", "GET");
    await handler(makeContext({ method: "GET", headers: AUTH_HEADERS }));

    expect(db.getScorecardsByModuleAndTeam).toHaveBeenCalledWith(null, null);
  });
});

describe("POST /api/admin/scorecards — real data path", () => {
  test("200 returns createScorecard() result and logs activity", async () => {
    const created = makeScorecard({ id: 11, name: "New SC" });
    vi.mocked(db.createScorecard).mockResolvedValueOnce(created);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/scorecards", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: AUTH_HEADERS,
        body: { name: "New SC", dimensions: [], crm_module: "sales", team_name: "alpha" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(created);
    expect(db.createScorecard).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.logAdminActivity).mock.calls[0][0].action_type).toBe("scorecard_create");
  });
});

describe("PUT /api/admin/scorecards/:id — real data path", () => {
  test("200 returns updated scorecard", async () => {
    const updated = makeScorecard({ id: 5, name: "Updated" });
    vi.mocked(db.updateScorecard).mockResolvedValueOnce(updated);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/scorecards/:id", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: AUTH_HEADERS,
        params: { id: "5" },
        body: { name: "Updated" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(updated);
    expect(db.updateScorecard).toHaveBeenCalledWith(5, { name: "Updated" });
  });

  test("404 when scorecard not found", async () => {
    vi.mocked(db.updateScorecard).mockResolvedValueOnce(null);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/scorecards/:id", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: AUTH_HEADERS,
        params: { id: "404" },
        body: { name: "X" },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Scorecard not found" });
  });
});

describe("DELETE /api/admin/scorecards/:id — real data path", () => {
  test("200 returns success when delete succeeds", async () => {
    vi.mocked(db.deleteScorecard).mockResolvedValueOnce(true);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/scorecards/:id", "DELETE");
    const res = await handler(
      makeContext({ method: "DELETE", headers: AUTH_HEADERS, params: { id: "9" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(db.deleteScorecard).toHaveBeenCalledWith(9);
  });

  test("404 when scorecard not found", async () => {
    vi.mocked(db.deleteScorecard).mockResolvedValueOnce(false);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/scorecards/:id", "DELETE");
    const res = await handler(
      makeContext({ method: "DELETE", headers: AUTH_HEADERS, params: { id: "404" } }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Scorecard not found" });
  });
});

describe("GET /api/admin/activities — real data path", () => {
  test("200 returns getAdminActivities() result and forwards filters", async () => {
    const fixture: Awaited<ReturnType<typeof db.getAdminActivities>> = {
      activities: [makeAdminActivity({ id: 1 })],
      total: 1,
    };
    vi.mocked(db.getAdminActivities).mockResolvedValueOnce(fixture);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/activities", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: AUTH_HEADERS,
        query: {
          limit: "25",
          offset: "5",
          action_type: "scorecard_create",
          startDate: "2026-01-01T00:00:00.000Z",
          endDate: "2026-12-31T23:59:59.000Z",
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
    const args = vi.mocked(db.getAdminActivities).mock.calls[0][0]!;
    expect(args.limit).toBe(25);
    expect(args.offset).toBe(5);
    expect(args.action_type).toBe("scorecard_create");
    expect(args.startDate).toBeInstanceOf(Date);
    expect(args.endDate).toBeInstanceOf(Date);
  });

  test("500 with deterministic body when getAdminActivities throws", async () => {
    vi.mocked(db.getAdminActivities).mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/activities", "GET");
    const res = await handler(makeContext({ method: "GET", headers: AUTH_HEADERS }));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to fetch admin activities" });
    errSpy.mockRestore();
  });
});

describe("GET /api/workflow/runs — real data path", () => {
  test("200 returns getWorkflowRuns() result with forwarded filters", async () => {
    const fixture: Awaited<ReturnType<typeof db.getWorkflowRuns>> = {
      runs: [makeWorkflowRun({ id: 1 })],
      total: 1,
    };
    vi.mocked(db.getWorkflowRuns).mockResolvedValueOnce(fixture);

    const handler = await buildHandler(adminApiRoutes, "/api/workflow/runs", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: AUTH_HEADERS,
        query: { workflow_id: "wf-1", status: "completed" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
    const args = vi.mocked(db.getWorkflowRuns).mock.calls[0][0]!;
    expect(args.workflow_id).toBe("wf-1");
    expect(args.status).toBe("completed");
    expect(args.limit).toBe(50);
    expect(args.offset).toBe(0);
  });
});

describe("GET /api/workflow/runs/:id — real data path", () => {
  test("200 returns the run when found", async () => {
    const run = makeWorkflowRun({ id: 7, workflow_id: "wf-1", status: "completed" });
    vi.mocked(db.getWorkflowRunById).mockResolvedValueOnce(run);

    const handler = await buildHandler(adminApiRoutes, "/api/workflow/runs/:id", "GET");
    const res = await handler(
      makeContext({ method: "GET", headers: AUTH_HEADERS, params: { id: "7" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(run);
    expect(db.getWorkflowRunById).toHaveBeenCalledWith(7);
  });

  test("404 when run not found", async () => {
    vi.mocked(db.getWorkflowRunById).mockResolvedValueOnce(null);

    const handler = await buildHandler(adminApiRoutes, "/api/workflow/runs/:id", "GET");
    const res = await handler(
      makeContext({ method: "GET", headers: AUTH_HEADERS, params: { id: "404" } }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Workflow run not found" });
  });
});

describe("GET /api/system/events — real data path", () => {
  test("200 returns getSystemEvents() result with forwarded filters", async () => {
    const fixture: Awaited<ReturnType<typeof db.getSystemEvents>> = {
      events: [makeSystemEvent({ id: 1 })],
      total: 1,
    };
    vi.mocked(db.getSystemEvents).mockResolvedValueOnce(fixture);

    const handler = await buildHandler(adminApiRoutes, "/api/system/events", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: AUTH_HEADERS,
        query: { event_type: "boot", severity: "info" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
    const args = vi.mocked(db.getSystemEvents).mock.calls[0][0]!;
    expect(args.event_type).toBe("boot");
    expect(args.severity).toBe("info");
    expect(args.limit).toBe(100);
    expect(args.offset).toBe(0);
  });
});

describe("GET /api/activity/feed — real data path", () => {
  test("200 returns getActivityFeed() result", async () => {
    const feed: Awaited<ReturnType<typeof db.getActivityFeed>> = {
      activities: [
        {
          id: 1,
          type: "admin",
          title: "x",
          description: "Test entry",
          timestamp: new Date(0),
        },
      ],
    };
    vi.mocked(db.getActivityFeed).mockResolvedValueOnce(feed);

    const handler = await buildHandler(adminApiRoutes, "/api/activity/feed", "GET");
    const res = await handler(
      makeContext({ method: "GET", headers: AUTH_HEADERS, query: { limit: "20" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(feed);
    expect(db.getActivityFeed).toHaveBeenCalledWith(20);
  });
});

describe("GET /api/activity/stats — real data path", () => {
  test("200 returns getActivityStats() result", async () => {
    const stats: Awaited<ReturnType<typeof db.getActivityStats>> = {
      adminActions: { today: 1, week: 7, month: 30 },
      workflowRuns: { total: 100, completed: 90, failed: 5, running: 5 },
      systemEvents: { info: 50, warning: 5, error: 1, critical: 0 },
    };
    vi.mocked(db.getActivityStats).mockResolvedValueOnce(stats);

    const handler = await buildHandler(adminApiRoutes, "/api/activity/stats", "GET");
    const res = await handler(makeContext({ method: "GET", headers: AUTH_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toBe(stats);
  });
});
