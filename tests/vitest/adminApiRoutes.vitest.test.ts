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
  makeScorecardAttribute,
  makeSystemEvent,
  makeWorkflowRun,
} from "../_helpers/fixtures";

vi.mock("../../src/utils/governanceRules", () => ({
  walaPlusSalesGovernanceRules: {
    document: { name: "WalaPlus Sales Rules", version: "v1.1" },
  },
  qualityScorecardConfig: {
    name: "Quality Scorecard",
    description: "Default quality scorecard",
  },
}));

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

describe("POST /api/admin/documents — real data path", () => {
  test("200 returns saved document and logs activity", async () => {
    const doc = makeGovernanceDocument({ id: 7, name: "New Policy", version: "v2" });
    vi.mocked(db.saveGovernanceDocument).mockResolvedValueOnce(doc);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/documents", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: AUTH_HEADERS,
        body: {
          name: "New Policy",
          document_type: "sales",
          version: "v2",
          content_text: "...",
          rules_json: {},
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(doc);
    expect(db.saveGovernanceDocument).toHaveBeenCalledTimes(1);
    const savedArgs = vi.mocked(db.saveGovernanceDocument).mock.calls[0][0];
    expect(savedArgs.name).toBe("New Policy");
    expect(savedArgs.version).toBe("v2");
    expect(db.logAdminActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.logAdminActivity).mock.calls[0][0].action_type).toBe("document_upload");
  });
});

describe("PUT /api/admin/documents/:id/activate — real data path", () => {
  test("200 calls activateGovernanceDocument and logs activity", async () => {
    vi.mocked(db.activateGovernanceDocument).mockResolvedValueOnce(undefined);

    const handler = await buildHandler(
      adminApiRoutes,
      "/api/admin/documents/:id/activate",
      "PUT",
    );
    const res = await handler(
      makeContext({ method: "PUT", headers: AUTH_HEADERS, params: { id: "3" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(db.activateGovernanceDocument).toHaveBeenCalledWith(3);
    expect(db.logAdminActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.logAdminActivity).mock.calls[0][0].action_type).toBe("document_activate");
  });
});

describe("POST /api/admin/scorecard/attributes — real data path", () => {
  test("200 returns updated scorecard and logs activity", async () => {
    const scorecard = makeScorecard({ id: 2 });
    vi.mocked(db.addScorecardAttribute).mockResolvedValueOnce(scorecard);

    const handler = await buildHandler(
      adminApiRoutes,
      "/api/admin/scorecard/attributes",
      "POST",
    );
    const res = await handler(
      makeContext({
        method: "POST",
        headers: AUTH_HEADERS,
        body: { name: "Compliance Rate", dimension: "governance", weight: 20, target: 95 },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(scorecard);
    expect(db.addScorecardAttribute).toHaveBeenCalledTimes(1);
    const attrArgs = vi.mocked(db.addScorecardAttribute).mock.calls[0][0];
    expect(attrArgs.name).toBe("Compliance Rate");
    expect(attrArgs.dimension).toBe("governance");
    expect(attrArgs.weight).toBe(20);
    expect(db.logAdminActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.logAdminActivity).mock.calls[0][0].action_type).toBe(
      "scorecard_attribute_add",
    );
  });

  test("404 when no active scorecard found", async () => {
    vi.mocked(db.addScorecardAttribute).mockResolvedValueOnce(null);

    const handler = await buildHandler(
      adminApiRoutes,
      "/api/admin/scorecard/attributes",
      "POST",
    );
    const res = await handler(
      makeContext({
        method: "POST",
        headers: AUTH_HEADERS,
        body: { name: "Attr", dimension: "people", weight: 10 },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No active scorecard found" });
    expect(db.logAdminActivity).not.toHaveBeenCalled();
  });
});

describe("PUT /api/admin/scorecard/link-doc — real data path", () => {
  test("200 returns success and linked scorecard, logs activity", async () => {
    const scorecard = makeScorecard({ id: 5, name: "Sales SC" });
    vi.mocked(db.linkScorecardToGovernanceDoc).mockResolvedValueOnce(scorecard);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/scorecard/link-doc", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: AUTH_HEADERS,
        body: { governance_doc_id: 2, crm_module: "sales", team_name: "alpha" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, scorecard });
    expect(db.linkScorecardToGovernanceDoc).toHaveBeenCalledWith(2, "sales", "alpha");
    expect(db.logAdminActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.logAdminActivity).mock.calls[0][0].action_type).toBe(
      "scorecard_link_doc",
    );
  });

  test("404 when no matching scorecard found", async () => {
    vi.mocked(db.linkScorecardToGovernanceDoc).mockResolvedValueOnce(null);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/scorecard/link-doc", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: AUTH_HEADERS,
        body: { governance_doc_id: 99, crm_module: "sales", team_name: "beta" },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "Failed to link document - no matching scorecard found",
    });
    expect(db.logAdminActivity).not.toHaveBeenCalled();
  });
});

describe("PUT /api/admin/scorecards/:id/activate — real data path", () => {
  test("200 returns activated scorecard and logs activity", async () => {
    const scorecard = makeScorecard({ id: 4, name: "Active SC" });
    vi.mocked(db.setActiveScorecardForTeam).mockResolvedValueOnce(scorecard);

    const handler = await buildHandler(
      adminApiRoutes,
      "/api/admin/scorecards/:id/activate",
      "PUT",
    );
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: AUTH_HEADERS,
        params: { id: "4" },
        body: { crm_module: "sales", team_name: "alpha" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(scorecard);
    expect(db.setActiveScorecardForTeam).toHaveBeenCalledWith(4, "sales", "alpha");
    expect(db.logAdminActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.logAdminActivity).mock.calls[0][0].action_type).toBe(
      "scorecard_activate",
    );
  });

  test("404 when scorecard not found", async () => {
    vi.mocked(db.setActiveScorecardForTeam).mockResolvedValueOnce(null);

    const handler = await buildHandler(
      adminApiRoutes,
      "/api/admin/scorecards/:id/activate",
      "PUT",
    );
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: AUTH_HEADERS,
        params: { id: "999" },
        body: { crm_module: "sales", team_name: "gamma" },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Scorecard not found" });
    expect(db.logAdminActivity).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/scorecards/:id/clone — real data path", () => {
  test("200 returns cloned scorecard and logs activity", async () => {
    const cloned = makeScorecard({ id: 12, name: "Cloned SC" });
    vi.mocked(db.cloneScorecard).mockResolvedValueOnce(cloned);

    const handler = await buildHandler(
      adminApiRoutes,
      "/api/admin/scorecards/:id/clone",
      "POST",
    );
    const res = await handler(
      makeContext({
        method: "POST",
        headers: AUTH_HEADERS,
        params: { id: "6" },
        body: { name: "Cloned SC", version: "v2" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(cloned);
    expect(db.cloneScorecard).toHaveBeenCalledWith(6, "Cloned SC", "v2");
    expect(db.logAdminActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.logAdminActivity).mock.calls[0][0].action_type).toBe("scorecard_clone");
    expect(vi.mocked(db.logAdminActivity).mock.calls[0][0].metadata).toMatchObject({
      original_id: 6,
      new_name: "Cloned SC",
      version: "v2",
    });
  });

  test("404 when original scorecard not found", async () => {
    vi.mocked(db.cloneScorecard).mockResolvedValueOnce(null);

    const handler = await buildHandler(
      adminApiRoutes,
      "/api/admin/scorecards/:id/clone",
      "POST",
    );
    const res = await handler(
      makeContext({
        method: "POST",
        headers: AUTH_HEADERS,
        params: { id: "404" },
        body: { name: "Ghost Clone", version: "v1" },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Original scorecard not found" });
    expect(db.logAdminActivity).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/scorecards/:id/attributes — real data path", () => {
  test("200 returns attribute list for the given scorecard id", async () => {
    const attrs = [makeScorecardAttribute({ id: 1 }), makeScorecardAttribute({ id: 2 })];
    vi.mocked(db.getScorecardAttributes).mockResolvedValueOnce(attrs);

    const handler = await buildHandler(
      adminApiRoutes,
      "/api/admin/scorecards/:id/attributes",
      "GET",
    );
    const res = await handler(
      makeContext({ method: "GET", headers: AUTH_HEADERS, params: { id: "7" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(attrs);
    expect(db.getScorecardAttributes).toHaveBeenCalledWith(7);
  });
});

describe("POST /api/admin/scorecards/:id/attributes — real data path", () => {
  test("200 returns created attribute and logs activity", async () => {
    const attr = makeScorecardAttribute({ id: 5, scorecard_id: 8, attribute_name: "Close Rate" });
    vi.mocked(db.createScorecardAttribute).mockResolvedValueOnce(attr);

    const handler = await buildHandler(
      adminApiRoutes,
      "/api/admin/scorecards/:id/attributes",
      "POST",
    );
    const res = await handler(
      makeContext({
        method: "POST",
        headers: AUTH_HEADERS,
        params: { id: "8" },
        body: { attribute_name: "Close Rate", dimension: "process", weight: 15, order_index: 1, is_active: true },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(attr);
    const createCall = vi.mocked(db.createScorecardAttribute).mock.calls[0][0];
    expect(createCall.scorecard_id).toBe(8);
    expect(createCall.attribute_name).toBe("Close Rate");
    expect(db.logAdminActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.logAdminActivity).mock.calls[0][0].action_type).toBe("attribute_create");
  });
});

describe("PUT /api/admin/attributes/:id — real data path", () => {
  test("200 returns updated attribute and logs activity", async () => {
    const attr = makeScorecardAttribute({ id: 3, attribute_name: "Updated Attr" });
    vi.mocked(db.updateScorecardAttribute).mockResolvedValueOnce(attr);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/attributes/:id", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: AUTH_HEADERS,
        params: { id: "3" },
        body: { attribute_name: "Updated Attr", weight: 25 },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(attr);
    expect(db.updateScorecardAttribute).toHaveBeenCalledWith(3, {
      attribute_name: "Updated Attr",
      weight: 25,
    });
    expect(db.logAdminActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.logAdminActivity).mock.calls[0][0].action_type).toBe("attribute_update");
  });

  test("404 when attribute not found", async () => {
    vi.mocked(db.updateScorecardAttribute).mockResolvedValueOnce(null);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/attributes/:id", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: AUTH_HEADERS,
        params: { id: "999" },
        body: { weight: 5 },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Attribute not found" });
    expect(db.logAdminActivity).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/attributes/:id — real data path", () => {
  test("200 returns success when attribute deleted", async () => {
    vi.mocked(db.deleteScorecardAttribute).mockResolvedValueOnce(true);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/attributes/:id", "DELETE");
    const res = await handler(
      makeContext({ method: "DELETE", headers: AUTH_HEADERS, params: { id: "10" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(db.deleteScorecardAttribute).toHaveBeenCalledWith(10);
    expect(db.logAdminActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.logAdminActivity).mock.calls[0][0].action_type).toBe("attribute_delete");
  });

  test("404 when attribute not found", async () => {
    vi.mocked(db.deleteScorecardAttribute).mockResolvedValueOnce(false);

    const handler = await buildHandler(adminApiRoutes, "/api/admin/attributes/:id", "DELETE");
    const res = await handler(
      makeContext({ method: "DELETE", headers: AUTH_HEADERS, params: { id: "999" } }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Attribute not found" });
    expect(db.logAdminActivity).not.toHaveBeenCalled();
  });
});

describe("PUT /api/admin/scorecards/:id/attributes/reorder — real data path", () => {
  test("200 calls reorderScorecardAttributes with correct args and logs activity", async () => {
    vi.mocked(db.reorderScorecardAttributes).mockResolvedValueOnce(undefined);

    const handler = await buildHandler(
      adminApiRoutes,
      "/api/admin/scorecards/:id/attributes/reorder",
      "PUT",
    );
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: AUTH_HEADERS,
        params: { id: "5" },
        body: { attribute_ids: [3, 1, 2] },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(db.reorderScorecardAttributes).toHaveBeenCalledWith(5, [3, 1, 2]);
    expect(db.logAdminActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.logAdminActivity).mock.calls[0][0].action_type).toBe(
      "attributes_reorder",
    );
    expect(vi.mocked(db.logAdminActivity).mock.calls[0][0].metadata).toMatchObject({
      attribute_ids: [3, 1, 2],
    });
  });
});

describe("POST /api/admin/seed-defaults — real data path", () => {
  test("200 calls saveGovernanceDocument, saveScorecard, logAdminActivity", async () => {
    vi.mocked(db.saveGovernanceDocument).mockResolvedValueOnce(
      makeGovernanceDocument({ id: 1 }),
    );
    vi.mocked(db.saveScorecard).mockResolvedValueOnce(makeScorecard({ id: 1 }));

    const handler = await buildHandler(adminApiRoutes, "/api/admin/seed-defaults", "POST");
    const res = await handler(makeContext({ method: "POST", headers: AUTH_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: "Default data restored" });
    expect(db.saveGovernanceDocument).toHaveBeenCalledTimes(1);
    const docArgs = vi.mocked(db.saveGovernanceDocument).mock.calls[0][0];
    expect(docArgs.name).toBe("WalaPlus Sales Rules");
    expect(docArgs.version).toBe("v1.1");
    expect(docArgs.document_type).toBe("sales");
    expect(docArgs.is_active).toBe(true);
    expect(db.saveScorecard).toHaveBeenCalledTimes(1);
    const scArgs = vi.mocked(db.saveScorecard).mock.calls[0][0];
    expect(scArgs.name).toBe("Quality Scorecard");
    expect(scArgs.description).toBe("Default quality scorecard");
    expect(scArgs.is_active).toBe(true);
    expect(db.logAdminActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.logAdminActivity).mock.calls[0][0].action_type).toBe("seed_defaults");
  });
});

/**
 * Error-path coverage — every db-backed admin route returns a deterministic
 * 500 body when its underlying data-layer call rejects. Without this, a
 * production DB exception would surface as a non-deterministic 500 message,
 * making operational failures hard to diagnose. Each row here mirrors the
 * exact `c.json({ error: "..." }, 500)` literal from
 * src/mastra/routes/adminApiRoutes.ts so any drift in error wording is
 * caught at test time.
 */
type ErrorCase = {
  name: string;
  path: string;
  method: string;
  /** Property on the mocked `db` module to make reject. */
  dbFn: keyof typeof db;
  /** Exact `error` string the handler returns on 500. */
  errorMessage: string;
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
};

const ERROR_CASES: ErrorCase[] = [
  {
    name: "GET /api/admin/documents",
    path: "/api/admin/documents",
    method: "GET",
    dbFn: "getAllGovernanceDocuments",
    errorMessage: "Failed to fetch documents",
  },
  {
    name: "POST /api/admin/documents",
    path: "/api/admin/documents",
    method: "POST",
    dbFn: "saveGovernanceDocument",
    errorMessage: "Failed to save document",
    body: {
      name: "Doc",
      document_type: "sales",
      version: "v1",
      content_text: "x",
      rules_json: {},
    },
  },
  {
    name: "PUT /api/admin/documents/:id/activate",
    path: "/api/admin/documents/:id/activate",
    method: "PUT",
    dbFn: "activateGovernanceDocument",
    errorMessage: "Failed to activate document",
    params: { id: "1" },
  },
  {
    name: "PUT /api/admin/scorecard/weights",
    path: "/api/admin/scorecard/weights",
    method: "PUT",
    dbFn: "updateScorecardWeights",
    errorMessage: "Failed to update weights",
    body: { people: 33, process: 33, governance: 34 },
  },
  {
    name: "POST /api/admin/scorecard/attributes",
    path: "/api/admin/scorecard/attributes",
    method: "POST",
    dbFn: "addScorecardAttribute",
    errorMessage: "Failed to add attribute",
    body: { name: "Attr", dimension: "people", weight: 10 },
  },
  {
    name: "PUT /api/admin/scorecard/link-doc",
    path: "/api/admin/scorecard/link-doc",
    method: "PUT",
    dbFn: "linkScorecardToGovernanceDoc",
    errorMessage: "Failed to link document",
    body: { governance_doc_id: 1, crm_module: "sales", team_name: "alpha" },
  },
  {
    name: "GET /api/admin/scorecards",
    path: "/api/admin/scorecards",
    method: "GET",
    dbFn: "getScorecardsByModuleAndTeam",
    errorMessage: "Failed to fetch scorecards",
  },
  {
    name: "POST /api/admin/scorecards",
    path: "/api/admin/scorecards",
    method: "POST",
    dbFn: "createScorecard",
    errorMessage: "Failed to create scorecard",
    body: { name: "SC", dimensions: [], crm_module: "sales", team_name: "alpha" },
  },
  {
    name: "PUT /api/admin/scorecards/:id",
    path: "/api/admin/scorecards/:id",
    method: "PUT",
    dbFn: "updateScorecard",
    errorMessage: "Failed to update scorecard",
    params: { id: "1" },
    body: { name: "X" },
  },
  {
    name: "DELETE /api/admin/scorecards/:id",
    path: "/api/admin/scorecards/:id",
    method: "DELETE",
    dbFn: "deleteScorecard",
    errorMessage: "Failed to delete scorecard",
    params: { id: "1" },
  },
  {
    name: "PUT /api/admin/scorecards/:id/activate",
    path: "/api/admin/scorecards/:id/activate",
    method: "PUT",
    dbFn: "setActiveScorecardForTeam",
    errorMessage: "Failed to activate scorecard",
    params: { id: "1" },
    body: { crm_module: "sales", team_name: "alpha" },
  },
  {
    name: "POST /api/admin/scorecards/:id/clone",
    path: "/api/admin/scorecards/:id/clone",
    method: "POST",
    dbFn: "cloneScorecard",
    errorMessage: "Failed to clone scorecard",
    params: { id: "1" },
    body: { name: "Cloned", version: "v2" },
  },
  {
    name: "GET /api/admin/scorecards/:id/attributes",
    path: "/api/admin/scorecards/:id/attributes",
    method: "GET",
    dbFn: "getScorecardAttributes",
    errorMessage: "Failed to fetch attributes",
    params: { id: "1" },
  },
  {
    name: "POST /api/admin/scorecards/:id/attributes",
    path: "/api/admin/scorecards/:id/attributes",
    method: "POST",
    dbFn: "createScorecardAttribute",
    errorMessage: "Failed to create attribute",
    params: { id: "1" },
    body: { attribute_name: "Attr", dimension: "people", weight: 10, order_index: 0 },
  },
  {
    name: "PUT /api/admin/attributes/:id",
    path: "/api/admin/attributes/:id",
    method: "PUT",
    dbFn: "updateScorecardAttribute",
    errorMessage: "Failed to update attribute",
    params: { id: "1" },
    body: { weight: 5 },
  },
  {
    name: "DELETE /api/admin/attributes/:id",
    path: "/api/admin/attributes/:id",
    method: "DELETE",
    dbFn: "deleteScorecardAttribute",
    errorMessage: "Failed to delete attribute",
    params: { id: "1" },
  },
  {
    name: "PUT /api/admin/scorecards/:id/attributes/reorder",
    path: "/api/admin/scorecards/:id/attributes/reorder",
    method: "PUT",
    dbFn: "reorderScorecardAttributes",
    errorMessage: "Failed to reorder attributes",
    params: { id: "1" },
    body: { attribute_ids: [1, 2, 3] },
  },
  {
    name: "POST /api/admin/seed-defaults",
    path: "/api/admin/seed-defaults",
    method: "POST",
    dbFn: "saveGovernanceDocument",
    errorMessage: "Failed to seed defaults",
  },
  {
    name: "GET /api/admin/activities",
    path: "/api/admin/activities",
    method: "GET",
    dbFn: "getAdminActivities",
    errorMessage: "Failed to fetch admin activities",
  },
  {
    name: "GET /api/workflow/runs",
    path: "/api/workflow/runs",
    method: "GET",
    dbFn: "getWorkflowRuns",
    errorMessage: "Failed to fetch workflow runs",
  },
  {
    name: "GET /api/workflow/runs/:id",
    path: "/api/workflow/runs/:id",
    method: "GET",
    dbFn: "getWorkflowRunById",
    errorMessage: "Failed to fetch workflow run",
    params: { id: "1" },
  },
  {
    name: "GET /api/system/events",
    path: "/api/system/events",
    method: "GET",
    dbFn: "getSystemEvents",
    errorMessage: "Failed to fetch system events",
  },
  {
    name: "GET /api/activity/feed",
    path: "/api/activity/feed",
    method: "GET",
    dbFn: "getActivityFeed",
    errorMessage: "Failed to fetch activity feed",
  },
  {
    name: "GET /api/activity/stats",
    path: "/api/activity/stats",
    method: "GET",
    dbFn: "getActivityStats",
    errorMessage: "Failed to fetch activity stats",
  },
];

describe("error-path coverage — every db-backed admin route returns deterministic 500 body", () => {
  test.each(ERROR_CASES)(
    "$name returns 500 with exact error body when $dbFn rejects",
    async ({ path, method, dbFn, errorMessage, body, params, query }) => {
      const fn = db[dbFn] as unknown as ReturnType<typeof vi.fn>;
      vi.mocked(fn).mockRejectedValueOnce(new Error("simulated db failure"));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const handler = await buildHandler(adminApiRoutes, path, method);
      const res = await handler(
        makeContext({ method, headers: AUTH_HEADERS, body, params, query }),
      );

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: errorMessage });
      errSpy.mockRestore();
    },
  );
});
