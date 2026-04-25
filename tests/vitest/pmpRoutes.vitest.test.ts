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
  deletePMPProject: vi.fn(),
  getPMPProjectById: vi.fn(),
  listProjectRisks: vi.fn(),
  listProjectMilestones: vi.fn(),
  listProjectStakeholders: vi.fn(),
  listProjectProcurement: vi.fn(),
  listProjectChangeRequests: vi.fn(),
  createProjectRisk: vi.fn(),
  updateProjectRisk: vi.fn(),
  deleteProjectRisk: vi.fn(),
  getProjectRiskById: vi.fn(),
  createProjectMilestone: vi.fn(),
  updateProjectMilestone: vi.fn(),
  deleteProjectMilestone: vi.fn(),
  getProjectMilestoneById: vi.fn(),
  createProjectStakeholder: vi.fn(),
  updateProjectStakeholder: vi.fn(),
  deleteProjectStakeholder: vi.fn(),
  getProjectStakeholderById: vi.fn(),
  createProjectProcurement: vi.fn(),
  updateProjectProcurement: vi.fn(),
  deleteProjectProcurement: vi.fn(),
  createProjectChangeRequest: vi.fn(),
  updateProjectChangeRequest: vi.fn(),
  deleteProjectChangeRequest: vi.fn(),
  getProjectPortfolioAnalytics: vi.fn(),
  getProjectGanttData: vi.fn(),
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

// ============================================
// PMP PROJECT UPDATE / DELETE
// ============================================

describe("PUT /api/pmp/projects/:projectId — real data path", () => {
  test("200 returns updated project and writes update audit entry", async () => {
    const oldProject = makePMPProject({ project_id: "p-7", project_name: "Old Name" });
    const newProject = makePMPProject({ project_id: "p-7", project_name: "New Name" });
    vi.mocked(teamDb.getPMPProjectById).mockResolvedValueOnce(oldProject);
    vi.mocked(teamDb.updatePMPProject).mockResolvedValueOnce(newProject);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/projects/:projectId", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        url: "http://localhost:5000/api/pmp/projects/p-7",
        params: { projectId: "p-7" },
        body: { project_name: "New Name" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, project: newProject });
    expect(teamDb.updatePMPProject).toHaveBeenCalledWith("p-7", { project_name: "New Name" });
    expect(teamDb.logAuditEntry).toHaveBeenCalledTimes(1);
    const audit = vi.mocked(teamDb.logAuditEntry).mock.calls[0][0];
    expect(audit.action_type).toBe("update");
    expect(audit.entity_type).toBe("pmp_project");
    expect(audit.entity_id).toBe("p-7");
    expect(audit.old_value).toBe(oldProject);
    expect(audit.new_value).toBe(newProject);
  });

  test("404 when updatePMPProject returns null and skips audit log", async () => {
    vi.mocked(teamDb.getPMPProjectById).mockResolvedValueOnce(null);
    vi.mocked(teamDb.updatePMPProject).mockResolvedValueOnce(null);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/projects/:projectId", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        url: "http://localhost:5000/api/pmp/projects/p-missing",
        params: { projectId: "p-missing" },
        body: { project_name: "Anything" },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "PMP project not found" });
    expect(teamDb.logAuditEntry).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/pmp/projects/:projectId — real data path", () => {
  test("200 returns success and writes delete audit entry with old_value", async () => {
    const oldProject = makePMPProject({ project_id: "p-8", project_name: "Doomed" });
    vi.mocked(teamDb.getPMPProjectById).mockResolvedValueOnce(oldProject);
    vi.mocked(teamDb.deletePMPProject).mockResolvedValueOnce(true);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/projects/:projectId", "DELETE");
    const res = await handler(
      makeContext({
        method: "DELETE",
        url: "http://localhost:5000/api/pmp/projects/p-8",
        params: { projectId: "p-8" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(teamDb.deletePMPProject).toHaveBeenCalledWith("p-8");
    const audit = vi.mocked(teamDb.logAuditEntry).mock.calls[0][0];
    expect(audit.action_type).toBe("delete");
    expect(audit.entity_type).toBe("pmp_project");
    expect(audit.entity_id).toBe("p-8");
    expect(audit.old_value).toBe(oldProject);
    expect(audit.description).toContain("Doomed");
  });

  test("404 when deletePMPProject returns false and skips audit log", async () => {
    vi.mocked(teamDb.getPMPProjectById).mockResolvedValueOnce(null);
    vi.mocked(teamDb.deletePMPProject).mockResolvedValueOnce(false);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/projects/:projectId", "DELETE");
    const res = await handler(
      makeContext({
        method: "DELETE",
        url: "http://localhost:5000/api/pmp/projects/p-missing",
        params: { projectId: "p-missing" },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "PMP project not found" });
    expect(teamDb.logAuditEntry).not.toHaveBeenCalled();
  });
});

// ============================================
// PROJECT RISKS
// ============================================

describe("POST /api/pmp/risks — real data path", () => {
  test("200 returns created risk and writes create audit entry", async () => {
    const risk = { risk_id: "r-99", title: "Vendor delay" } as Awaited<ReturnType<typeof teamDb.createProjectRisk>>;
    vi.mocked(teamDb.createProjectRisk).mockResolvedValueOnce(risk);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/risks", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        url: "http://localhost:5000/api/pmp/risks",
        body: { project_id: "p-1", title: "Vendor delay" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, risk });
    const audit = vi.mocked(teamDb.logAuditEntry).mock.calls[0][0];
    expect(audit.action_type).toBe("create");
    expect(audit.entity_type).toBe("project_risk");
    expect(audit.entity_id).toBe("r-99");
    expect(audit.description).toContain("Vendor delay");
    expect(audit.description).toContain("p-1");
  });
});

describe("PUT /api/pmp/risks/:riskId — real data path", () => {
  test("200 returns updated risk with old/new audit values", async () => {
    const oldRisk = { risk_id: "r-1", title: "Old title" } as Awaited<ReturnType<typeof teamDb.getProjectRiskById>>;
    const newRisk = { risk_id: "r-1", title: "New title" } as Awaited<ReturnType<typeof teamDb.updateProjectRisk>>;
    vi.mocked(teamDb.getProjectRiskById).mockResolvedValueOnce(oldRisk);
    vi.mocked(teamDb.updateProjectRisk).mockResolvedValueOnce(newRisk);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/risks/:riskId", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        url: "http://localhost:5000/api/pmp/risks/r-1",
        params: { riskId: "r-1" },
        body: { title: "New title" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, risk: newRisk });
    const audit = vi.mocked(teamDb.logAuditEntry).mock.calls[0][0];
    expect(audit.action_type).toBe("update");
    expect(audit.entity_type).toBe("project_risk");
    expect(audit.old_value).toBe(oldRisk);
    expect(audit.new_value).toBe(newRisk);
  });

  test("404 when updateProjectRisk returns null and skips audit log", async () => {
    vi.mocked(teamDb.getProjectRiskById).mockResolvedValueOnce(null);
    vi.mocked(teamDb.updateProjectRisk).mockResolvedValueOnce(null);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/risks/:riskId", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        url: "http://localhost:5000/api/pmp/risks/r-missing",
        params: { riskId: "r-missing" },
        body: { title: "x" },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project risk not found" });
    expect(teamDb.logAuditEntry).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/pmp/risks/:riskId — real data path", () => {
  test("200 deletes risk and writes delete audit entry", async () => {
    const oldRisk = { risk_id: "r-2", title: "Goner" } as Awaited<ReturnType<typeof teamDb.getProjectRiskById>>;
    vi.mocked(teamDb.getProjectRiskById).mockResolvedValueOnce(oldRisk);
    vi.mocked(teamDb.deleteProjectRisk).mockResolvedValueOnce(true);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/risks/:riskId", "DELETE");
    const res = await handler(
      makeContext({
        method: "DELETE",
        url: "http://localhost:5000/api/pmp/risks/r-2",
        params: { riskId: "r-2" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const audit = vi.mocked(teamDb.logAuditEntry).mock.calls[0][0];
    expect(audit.action_type).toBe("delete");
    expect(audit.entity_type).toBe("project_risk");
    expect(audit.entity_id).toBe("r-2");
    expect(audit.old_value).toBe(oldRisk);
    expect(audit.description).toContain("Goner");
  });

  test("404 when deleteProjectRisk returns false and skips audit log", async () => {
    vi.mocked(teamDb.getProjectRiskById).mockResolvedValueOnce(null);
    vi.mocked(teamDb.deleteProjectRisk).mockResolvedValueOnce(false);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/risks/:riskId", "DELETE");
    const res = await handler(
      makeContext({
        method: "DELETE",
        url: "http://localhost:5000/api/pmp/risks/r-missing",
        params: { riskId: "r-missing" },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project risk not found" });
    expect(teamDb.logAuditEntry).not.toHaveBeenCalled();
  });
});

// ============================================
// PROJECT MILESTONES
// ============================================

describe("POST /api/pmp/milestones — real data path", () => {
  test("200 returns created milestone and writes create audit entry", async () => {
    const milestone = { milestone_id: "m-99", name: "Phase 1 done" } as Awaited<ReturnType<typeof teamDb.createProjectMilestone>>;
    vi.mocked(teamDb.createProjectMilestone).mockResolvedValueOnce(milestone);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/milestones", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        url: "http://localhost:5000/api/pmp/milestones",
        body: { project_id: "p-1", name: "Phase 1 done" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, milestone });
    const audit = vi.mocked(teamDb.logAuditEntry).mock.calls[0][0];
    expect(audit.action_type).toBe("create");
    expect(audit.entity_type).toBe("project_milestone");
    expect(audit.entity_id).toBe("m-99");
    expect(audit.description).toContain("Phase 1 done");
  });
});

describe("PUT /api/pmp/milestones/:milestoneId — real data path", () => {
  test("200 returns updated milestone with old/new audit values", async () => {
    const oldMilestone = { milestone_id: "m-1", name: "Old Name" } as Awaited<ReturnType<typeof teamDb.getProjectMilestoneById>>;
    const newMilestone = { milestone_id: "m-1", name: "New Name" } as Awaited<ReturnType<typeof teamDb.updateProjectMilestone>>;
    vi.mocked(teamDb.getProjectMilestoneById).mockResolvedValueOnce(oldMilestone);
    vi.mocked(teamDb.updateProjectMilestone).mockResolvedValueOnce(newMilestone);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/milestones/:milestoneId", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        url: "http://localhost:5000/api/pmp/milestones/m-1",
        params: { milestoneId: "m-1" },
        body: { name: "New Name" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, milestone: newMilestone });
    expect(teamDb.updateProjectMilestone).toHaveBeenCalledWith("m-1", { name: "New Name" });
    const audit = vi.mocked(teamDb.logAuditEntry).mock.calls[0][0];
    expect(audit.action_type).toBe("update");
    expect(audit.entity_type).toBe("project_milestone");
    expect(audit.entity_id).toBe("m-1");
    expect(audit.old_value).toBe(oldMilestone);
    expect(audit.new_value).toBe(newMilestone);
  });

  test("404 when updateProjectMilestone returns null and skips audit log", async () => {
    vi.mocked(teamDb.getProjectMilestoneById).mockResolvedValueOnce(null);
    vi.mocked(teamDb.updateProjectMilestone).mockResolvedValueOnce(null);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/milestones/:milestoneId", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        url: "http://localhost:5000/api/pmp/milestones/m-missing",
        params: { milestoneId: "m-missing" },
        body: { name: "x" },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project milestone not found" });
    expect(teamDb.logAuditEntry).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/pmp/milestones/:milestoneId — real data path", () => {
  test("200 deletes milestone and writes delete audit entry", async () => {
    const oldMilestone = { milestone_id: "m-3", name: "Old Milestone" } as Awaited<ReturnType<typeof teamDb.getProjectMilestoneById>>;
    vi.mocked(teamDb.getProjectMilestoneById).mockResolvedValueOnce(oldMilestone);
    vi.mocked(teamDb.deleteProjectMilestone).mockResolvedValueOnce(true);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/milestones/:milestoneId", "DELETE");
    const res = await handler(
      makeContext({
        method: "DELETE",
        url: "http://localhost:5000/api/pmp/milestones/m-3",
        params: { milestoneId: "m-3" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const audit = vi.mocked(teamDb.logAuditEntry).mock.calls[0][0];
    expect(audit.action_type).toBe("delete");
    expect(audit.entity_type).toBe("project_milestone");
    expect(audit.entity_id).toBe("m-3");
    expect(audit.old_value).toBe(oldMilestone);
    expect(audit.description).toContain("Old Milestone");
  });

  test("404 when deleteProjectMilestone returns false and skips audit log", async () => {
    vi.mocked(teamDb.getProjectMilestoneById).mockResolvedValueOnce(null);
    vi.mocked(teamDb.deleteProjectMilestone).mockResolvedValueOnce(false);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/milestones/:milestoneId", "DELETE");
    const res = await handler(
      makeContext({
        method: "DELETE",
        url: "http://localhost:5000/api/pmp/milestones/m-missing",
        params: { milestoneId: "m-missing" },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project milestone not found" });
    expect(teamDb.logAuditEntry).not.toHaveBeenCalled();
  });
});

// ============================================
// PROJECT STAKEHOLDERS
// ============================================

describe("GET /api/pmp/stakeholders — real data path", () => {
  test("200 returns listProjectStakeholders() result with forwarded filters", async () => {
    const fixture = {
      stakeholders: [{ stakeholder_id: "s-1", name: "VP Sales" }],
      total: 1,
    } as Awaited<ReturnType<typeof teamDb.listProjectStakeholders>>;
    vi.mocked(teamDb.listProjectStakeholders).mockResolvedValueOnce(fixture);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/stakeholders", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        url: "http://localhost:5000/api/pmp/stakeholders?project_id=p-1&stakeholder_type=internal&influence=high&quadrant=manage_closely&limit=25&offset=10",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
    const args = vi.mocked(teamDb.listProjectStakeholders).mock.calls[0][0];
    expect(args).toEqual({
      projectId: "p-1",
      stakeholderType: "internal",
      influence: "high",
      quadrant: "manage_closely",
      limit: 25,
      offset: 10,
    });
  });

  test("200 falls back to default limit/offset when query params absent", async () => {
    vi.mocked(teamDb.listProjectStakeholders).mockResolvedValueOnce({
      stakeholders: [],
      total: 0,
    } as Awaited<ReturnType<typeof teamDb.listProjectStakeholders>>);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/stakeholders", "GET");
    await handler(
      makeContext({ method: "GET", url: "http://localhost:5000/api/pmp/stakeholders" }),
    );

    expect(teamDb.listProjectStakeholders).toHaveBeenCalledWith({
      projectId: undefined,
      stakeholderType: undefined,
      influence: undefined,
      quadrant: undefined,
      limit: 50,
      offset: 0,
    });
  });
});

describe("POST /api/pmp/stakeholders — real data path", () => {
  test("200 returns created stakeholder and writes create audit entry", async () => {
    const stakeholder = { stakeholder_id: "s-99", name: "VP Sales" } as Awaited<ReturnType<typeof teamDb.createProjectStakeholder>>;
    vi.mocked(teamDb.createProjectStakeholder).mockResolvedValueOnce(stakeholder);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/stakeholders", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        url: "http://localhost:5000/api/pmp/stakeholders",
        body: { project_id: "p-1", name: "VP Sales" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, stakeholder });
    const audit = vi.mocked(teamDb.logAuditEntry).mock.calls[0][0];
    expect(audit.action_type).toBe("create");
    expect(audit.entity_type).toBe("project_stakeholder");
    expect(audit.entity_id).toBe("s-99");
    expect(audit.description).toContain("VP Sales");
  });
});

describe("PUT /api/pmp/stakeholders/:stakeholderId — real data path", () => {
  test("200 returns updated stakeholder with old/new audit values", async () => {
    const oldStakeholder = { stakeholder_id: "s-1", name: "Old Name" } as Awaited<ReturnType<typeof teamDb.getProjectStakeholderById>>;
    const newStakeholder = { stakeholder_id: "s-1", name: "New Name" } as Awaited<ReturnType<typeof teamDb.updateProjectStakeholder>>;
    vi.mocked(teamDb.getProjectStakeholderById).mockResolvedValueOnce(oldStakeholder);
    vi.mocked(teamDb.updateProjectStakeholder).mockResolvedValueOnce(newStakeholder);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/stakeholders/:stakeholderId", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        url: "http://localhost:5000/api/pmp/stakeholders/s-1",
        params: { stakeholderId: "s-1" },
        body: { name: "New Name" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, stakeholder: newStakeholder });
    const audit = vi.mocked(teamDb.logAuditEntry).mock.calls[0][0];
    expect(audit.action_type).toBe("update");
    expect(audit.entity_type).toBe("project_stakeholder");
    expect(audit.old_value).toBe(oldStakeholder);
    expect(audit.new_value).toBe(newStakeholder);
  });

  test("404 when updateProjectStakeholder returns null and skips audit log", async () => {
    vi.mocked(teamDb.getProjectStakeholderById).mockResolvedValueOnce(null);
    vi.mocked(teamDb.updateProjectStakeholder).mockResolvedValueOnce(null);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/stakeholders/:stakeholderId", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        url: "http://localhost:5000/api/pmp/stakeholders/s-missing",
        params: { stakeholderId: "s-missing" },
        body: { name: "x" },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project stakeholder not found" });
    expect(teamDb.logAuditEntry).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/pmp/stakeholders/:stakeholderId — real data path", () => {
  test("200 deletes stakeholder and writes delete audit entry", async () => {
    const oldStakeholder = { stakeholder_id: "s-2", name: "Departing" } as Awaited<ReturnType<typeof teamDb.getProjectStakeholderById>>;
    vi.mocked(teamDb.getProjectStakeholderById).mockResolvedValueOnce(oldStakeholder);
    vi.mocked(teamDb.deleteProjectStakeholder).mockResolvedValueOnce(true);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/stakeholders/:stakeholderId", "DELETE");
    const res = await handler(
      makeContext({
        method: "DELETE",
        url: "http://localhost:5000/api/pmp/stakeholders/s-2",
        params: { stakeholderId: "s-2" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const audit = vi.mocked(teamDb.logAuditEntry).mock.calls[0][0];
    expect(audit.action_type).toBe("delete");
    expect(audit.entity_type).toBe("project_stakeholder");
    expect(audit.entity_id).toBe("s-2");
    expect(audit.old_value).toBe(oldStakeholder);
    expect(audit.description).toContain("Departing");
  });

  test("404 when deleteProjectStakeholder returns false and skips audit log", async () => {
    vi.mocked(teamDb.getProjectStakeholderById).mockResolvedValueOnce(null);
    vi.mocked(teamDb.deleteProjectStakeholder).mockResolvedValueOnce(false);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/stakeholders/:stakeholderId", "DELETE");
    const res = await handler(
      makeContext({
        method: "DELETE",
        url: "http://localhost:5000/api/pmp/stakeholders/s-missing",
        params: { stakeholderId: "s-missing" },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project stakeholder not found" });
    expect(teamDb.logAuditEntry).not.toHaveBeenCalled();
  });
});

// ============================================
// PORTFOLIO ANALYTICS & GANTT
// ============================================

describe("GET /api/pmp/portfolio/analytics — real data path", () => {
  test("200 returns getProjectPortfolioAnalytics() result verbatim", async () => {
    const analytics = {
      totalProjects: 7,
      byStatus: { planning: 3, execution: 4 },
      byPriority: { high: 2, medium: 5 },
      byDepartment: [{ department: "Quality", count: 4, avgCompletion: 60 }],
      avgSPI: 0.95,
      avgCPI: 1.02,
      totalBudget: 1_000_000,
      totalSpent: 250_000,
      atRiskProjects: 1,
      overdueProjects: 0,
      completedThisMonth: 2,
      riskSummary: { high: 1, medium: 2, low: 3, totalExposure: 50_000 },
      milestoneMetrics: { onTime: 5, delayed: 1, upcoming: 3 },
      procurementMetrics: { total: 2, active: 1, pending: 1, totalValue: 200_000 },
      changeControlMetrics: { total: 4, pending: 1, approved: 2, rejected: 1, totalImpact: 10_000 },
    } as Awaited<ReturnType<typeof teamDb.getProjectPortfolioAnalytics>>;
    vi.mocked(teamDb.getProjectPortfolioAnalytics).mockResolvedValueOnce(analytics);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/portfolio/analytics", "GET");
    const res = await handler(
      makeContext({ method: "GET", url: "http://localhost:5000/api/pmp/portfolio/analytics" }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(analytics);
    expect(teamDb.getProjectPortfolioAnalytics).toHaveBeenCalledTimes(1);
  });

  test("500 with deterministic body when getProjectPortfolioAnalytics throws", async () => {
    vi.mocked(teamDb.getProjectPortfolioAnalytics).mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/portfolio/analytics", "GET");
    const res = await handler(
      makeContext({ method: "GET", url: "http://localhost:5000/api/pmp/portfolio/analytics" }),
    );

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to fetch portfolio analytics" });
    errSpy.mockRestore();
  });
});

describe("GET /api/pmp/projects/:projectId/gantt — real data path", () => {
  test("200 returns getProjectGanttData() result when project exists", async () => {
    const ganttData = {
      project: makePMPProject({ project_id: "p-1", project_name: "Alpha" }),
      milestones: [],
      timeline: [],
    } as Awaited<ReturnType<typeof teamDb.getProjectGanttData>>;
    vi.mocked(teamDb.getProjectGanttData).mockResolvedValueOnce(ganttData);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/projects/:projectId/gantt", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        url: "http://localhost:5000/api/pmp/projects/p-1/gantt",
        params: { projectId: "p-1" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(ganttData);
    expect(teamDb.getProjectGanttData).toHaveBeenCalledWith("p-1");
  });

  test("404 when getProjectGanttData() returns null project", async () => {
    vi.mocked(teamDb.getProjectGanttData).mockResolvedValueOnce({
      project: null,
      milestones: [],
      timeline: [],
    } as Awaited<ReturnType<typeof teamDb.getProjectGanttData>>);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/pmp/projects/:projectId/gantt", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        url: "http://localhost:5000/api/pmp/projects/p-missing/gantt",
        params: { projectId: "p-missing" },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project not found" });
  });
});
