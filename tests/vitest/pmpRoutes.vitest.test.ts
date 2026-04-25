/**
 * Vitest happy-path tests for src/mastra/routes/pmpRoutes.ts.
 *
 * `gateApiRoute` is replaced with a passthrough so we can call handlers
 * directly. The dynamic ESM import of `../../utils/teamDatabase` is
 * stubbed out so tests are fully deterministic and need no live database.
 *
 * pmpRoutes reads query params via `new URL(c.req.url).searchParams` so
 * tests pass query strings in the `url` field of makeContext rather than
 * in the `query` bag.
 *
 * Run via:  npx vitest run tests/vitest/pmpRoutes.vitest.test.ts
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { FakeContext, CapturedResponse } from "../_helpers/fakeContext";
import { buildHandler, makeContext } from "../_helpers/fakeContext";
import {
  makePMPProject,
  makeProjectRisk,
  makeProjectMilestone,
} from "../_helpers/fixtures";

const FAKE_USER = { userId: 0, email: "api@system", name: "API", role: "admin" as const };

vi.mock("../../src/utils/rbacMiddleware", () => ({
  gateApiRoute: <T>(r: T): T => r,
  requireRole: vi.fn(async () => FAKE_USER),
  forbiddenResponse: vi.fn((c: FakeContext, msg: string): CapturedResponse => c.json({ error: msg }, 403)),
  requireAdminOrKey: vi.fn(async () => FAKE_USER),
  requireRoleOrKey: vi.fn(async () => FAKE_USER),
  requireAuthOrKey: vi.fn((_c: FakeContext) => FAKE_USER),
  unauthorizedResponse: vi.fn((c: FakeContext): CapturedResponse => c.json({ error: "Unauthorized" }, 401)),
  hasAdminApiKeyConfigured: vi.fn(() => true),
}));

vi.mock("../../src/utils/teamDatabase", () => ({
  initTeamTables: vi.fn(async () => undefined),
  listPMPProjects: vi.fn(),
  createPMPProject: vi.fn(),
  updatePMPProject: vi.fn(),
  getPMPProjectById: vi.fn(),
  listProjectRisks: vi.fn(),
  listProjectMilestones: vi.fn(),
  listProjectStakeholders: vi.fn(),
  listProjectProcurement: vi.fn(),
  listProjectChangeRequests: vi.fn(),
  createProjectRisk: vi.fn(),
  updateProjectRisk: vi.fn(),
  deleteProjectRisk: vi.fn(),
  createProjectMilestone: vi.fn(),
  updateProjectMilestone: vi.fn(),
  deleteProjectMilestone: vi.fn(),
  createProjectStakeholder: vi.fn(),
  updateProjectStakeholder: vi.fn(),
  deleteProjectStakeholder: vi.fn(),
  createProjectProcurement: vi.fn(),
  updateProjectProcurement: vi.fn(),
  deleteProjectProcurement: vi.fn(),
  createProjectChangeRequest: vi.fn(),
  updateProjectChangeRequest: vi.fn(),
  deleteProjectChangeRequest: vi.fn(),
  getPMPPortfolioAnalytics: vi.fn(),
  logAuditEntry: vi.fn(async () => ({ id: 1, action_id: "a1" })),
}));

let teamDb: typeof import("../../src/utils/teamDatabase");

beforeEach(async () => {
  teamDb = await import("../../src/utils/teamDatabase");
  vi.clearAllMocks();
  vi.mocked(teamDb.initTeamTables).mockResolvedValue(undefined);
  vi.mocked(teamDb.logAuditEntry).mockResolvedValue({ id: 1, action_id: "a1" } as Awaited<ReturnType<typeof teamDb.logAuditEntry>>);
});

async function getRoutes() {
  const { pmpRoutes } = await import("../../src/mastra/routes/pmpRoutes");
  return pmpRoutes;
}

describe("GET /api/pmp/projects — real data path", () => {
  test("200 returns listPMPProjects() result with forwarded filters", async () => {
    const fixture = { projects: [makePMPProject({ project_id: "p-1", project_name: "Alpha" })], total: 1 };
    vi.mocked(teamDb.listPMPProjects).mockResolvedValueOnce(fixture);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/projects", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        url: "http://localhost:5000/api/pmp/projects?status=active&limit=20&offset=5",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
    const args = vi.mocked(teamDb.listPMPProjects).mock.calls[0][0];
    expect(args.status).toBe("active");
    expect(args.limit).toBe(20);
    expect(args.offset).toBe(5);
  });

  test("500 with deterministic body when listPMPProjects throws", async () => {
    vi.mocked(teamDb.listPMPProjects).mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/projects", "GET");
    const res = await handler(
      makeContext({ method: "GET", url: "http://localhost:5000/api/pmp/projects" }),
    );

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to fetch PMP projects" });
    errSpy.mockRestore();
  });
});

describe("POST /api/pmp/projects — real data path", () => {
  test("200 returns { success: true, project } and logs audit entry", async () => {
    const project = makePMPProject({ project_id: "p-10", project_name: "Beta Launch" });
    vi.mocked(teamDb.createPMPProject).mockResolvedValueOnce(project);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/projects", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        url: "http://localhost:5000/api/pmp/projects",
        body: { project_name: "Beta Launch", department: "Sales" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, project });
    expect(teamDb.createPMPProject).toHaveBeenCalledTimes(1);
    expect(teamDb.logAuditEntry).toHaveBeenCalledTimes(1);
    const audit = vi.mocked(teamDb.logAuditEntry).mock.calls[0][0];
    expect(audit.action_type).toBe("create");
    expect(audit.entity_type).toBe("pmp_project");
  });
});

describe("GET /api/pmp/projects/:projectId — real data path", () => {
  test("200 returns project with related data when found", async () => {
    const project = makePMPProject({ project_id: "p-3", project_name: "Gamma" });
    vi.mocked(teamDb.getPMPProjectById).mockResolvedValueOnce(project);
    vi.mocked(teamDb.listProjectRisks).mockResolvedValueOnce({ risks: [], total: 0 } as Awaited<ReturnType<typeof teamDb.listProjectRisks>>);
    vi.mocked(teamDb.listProjectMilestones).mockResolvedValueOnce({ milestones: [], total: 0 } as Awaited<ReturnType<typeof teamDb.listProjectMilestones>>);
    vi.mocked(teamDb.listProjectStakeholders).mockResolvedValueOnce({ stakeholders: [], total: 0 } as Awaited<ReturnType<typeof teamDb.listProjectStakeholders>>);
    vi.mocked(teamDb.listProjectProcurement).mockResolvedValueOnce({ procurement: [], total: 0 } as Awaited<ReturnType<typeof teamDb.listProjectProcurement>>);
    vi.mocked(teamDb.listProjectChangeRequests).mockResolvedValueOnce({ changeRequests: [], total: 0 } as Awaited<ReturnType<typeof teamDb.listProjectChangeRequests>>);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/projects/:projectId", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        url: "http://localhost:5000/api/pmp/projects/p-3",
        params: { projectId: "p-3" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body.project_id).toBe("p-3");
    expect(teamDb.getPMPProjectById).toHaveBeenCalledWith("p-3");
    expect(teamDb.listProjectRisks).toHaveBeenCalledWith({ projectId: "p-3", limit: 100 });
  });

  test("404 when project not found", async () => {
    vi.mocked(teamDb.getPMPProjectById).mockResolvedValueOnce(null);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/projects/:projectId", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        url: "http://localhost:5000/api/pmp/projects/p-999",
        params: { projectId: "p-999" },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "PMP project not found" });
  });
});

describe("GET /api/pmp/risks — real data path", () => {
  test("200 returns listProjectRisks() result with forwarded projectId", async () => {
    const fixture = {
      risks: [makeProjectRisk({ risk_id: "r-1", title: "Budget overrun" })],
      total: 1,
    };
    vi.mocked(teamDb.listProjectRisks).mockResolvedValueOnce(fixture);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/risks", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        url: "http://localhost:5000/api/pmp/risks?project_id=p-1&limit=10",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
    const args = vi.mocked(teamDb.listProjectRisks).mock.calls[0][0];
    expect(args.projectId).toBe("p-1");
    expect(args.limit).toBe(10);
  });
});

describe("GET /api/pmp/milestones — real data path", () => {
  test("200 returns listProjectMilestones() result", async () => {
    const fixture = {
      milestones: [makeProjectMilestone({ milestone_id: "m-1", name: "Launch" })],
      total: 1,
    };
    vi.mocked(teamDb.listProjectMilestones).mockResolvedValueOnce(fixture);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/milestones", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        url: "http://localhost:5000/api/pmp/milestones?project_id=p-2",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
    expect(teamDb.listProjectMilestones).toHaveBeenCalledWith({
      projectId: "p-2",
      limit: 50,
      offset: 0,
    });
  });
});
