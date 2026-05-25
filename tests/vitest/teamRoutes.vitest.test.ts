/**
 * Vitest happy-path tests for src/mastra/routes/teamRoutes.ts.
 *
 * Stubs ../../utils/teamDatabase (dynamically imported by every handler)
 * and uses ADMIN_API_KEY + X-Admin-Key so the per-route role gates accept
 * the request as the synthetic admin user. The PMP project/risk/milestone/
 * stakeholder surface is out of scope for this real-data happy-path suite.
 *
 * Run via:  npx vitest run tests/vitest/teamRoutes.vitest.test.ts
 */

const TEST_ADMIN_KEY = "vitest-team-admin-key-2026";
process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;

import { beforeEach, describe, expect, test, vi } from "vitest";
import { teamRoutes } from "../../src/mastra/routes/teamRoutes";
import type {
  AuditLogEntry,
  TeamPerformanceMetric,
  TeamProjectAssignment,
  TrainingAssignment,
  TrainingCourse,
} from "../../src/utils/teamDatabase";
import { buildHandler, makeContext } from "../_helpers/fakeContext";

const ADMIN_HEADERS = { "X-Admin-Key": TEST_ADMIN_KEY };

vi.mock("../../src/utils/teamDatabase", () => ({
  initTeamTables: vi.fn(async () => undefined),
  listTeamMembers: vi.fn(),
  createTeamMember: vi.fn(),
  getTeamMemberById: vi.fn(),
  updateTeamMember: vi.fn(),
  deleteTeamMember: vi.fn(),
  getTeamAnalytics: vi.fn(),
  getPerformanceMetrics: vi.fn(),
  addPerformanceMetric: vi.fn(),
  listProjectAssignments: vi.fn(),
  createProjectAssignment: vi.fn(),
  updateProjectAssignment: vi.fn(),
  deleteProjectAssignment: vi.fn(),
  getTrainingMatrix: vi.fn(),
  listTrainingCourses: vi.fn(),
  createTrainingCourse: vi.fn(),
  getTrainingCourseById: vi.fn(),
  updateTrainingCourse: vi.fn(),
  deleteTrainingCourse: vi.fn(),
  listCourseAssignments: vi.fn(),
  createCourseAssignment: vi.fn(),
  updateCourseAssignment: vi.fn(),
  deleteCourseAssignment: vi.fn(),
  logAuditEntry: vi.fn(async (entry: Omit<AuditLogEntry, "id" | "action_id" | "created_at">) => entry),
  listAuditLogs: vi.fn(),
  getProjectsByKanbanStatus: vi.fn(),
  getCourseTrainingMatrix: vi.fn(),
}));

let team: typeof import("../../src/utils/teamDatabase");

beforeEach(async () => {
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  team = await import("../../src/utils/teamDatabase");
  vi.clearAllMocks();
  vi.mocked(team.initTeamTables).mockResolvedValue(undefined);
  vi.mocked(team.logAuditEntry).mockImplementation(
    async (entry: Omit<AuditLogEntry, "id" | "action_id" | "created_at">) =>
      ({ ...entry, action_id: "A-test", created_at: new Date() } as AuditLogEntry),
  );
});

describe("GET /api/team/members", () => {
  test("200 returns listTeamMembers() result and forwards filters/pagination", async () => {
    const fixture = {
      members: [{ member_id: "TM-1", full_name: "Alice", role: "lead", department: "QMS", status: "active" as const, email: "a@x.com" }],
      total: 1,
    };
    vi.mocked(team.listTeamMembers).mockResolvedValueOnce(fixture);

    const handler = await buildHandler(teamRoutes, "/api/team/members", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: ADMIN_HEADERS,
        url: "http://localhost/api/team/members?department=QMS&role=lead&status=active&limit=25&offset=10",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(fixture);
    expect(team.listTeamMembers).toHaveBeenCalledWith({
      department: "QMS",
      role: "lead",
      status: "active",
      limit: 25,
      offset: 10,
    });
  });

  test("200 falls back to default limit/offset when query params absent", async () => {
    vi.mocked(team.listTeamMembers).mockResolvedValueOnce({ members: [], total: 0 });

    const handler = await buildHandler(teamRoutes, "/api/team/members", "GET");
    await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(team.listTeamMembers).toHaveBeenCalledWith({
      department: undefined,
      role: undefined,
      status: undefined,
      limit: 50,
      offset: 0,
    });
  });

  test("500 with deterministic body when listTeamMembers throws", async () => {
    vi.mocked(team.listTeamMembers).mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const handler = await buildHandler(teamRoutes, "/api/team/members", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to fetch team members" });
    errSpy.mockRestore();
  });
});

describe("POST /api/team/members", () => {
  test("200 returns { success, member } from createTeamMember()", async () => {
    const created = { member_id: "TM-99", full_name: "New Hire", role: "auditor", department: "QMS", status: "active" as const, email: "n@x.com" };
    vi.mocked(team.createTeamMember).mockResolvedValueOnce(created);

    const handler = await buildHandler(teamRoutes, "/api/team/members", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        body: { full_name: "New Hire", role: "auditor", department: "QMS", email: "n@x.com", status: "active" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, member: created });
    expect(team.createTeamMember).toHaveBeenCalledTimes(1);
    expect(vi.mocked(team.createTeamMember).mock.calls[0][0].full_name).toBe("New Hire");
  });
});

describe("GET /api/team/members/:memberId", () => {
  test("200 returns the member when found", async () => {
    const member = { member_id: "TM-7", full_name: "Bob", role: "manager", department: "GRC", status: "active" as const, email: "b@x.com" };
    vi.mocked(team.getTeamMemberById).mockResolvedValueOnce(member);

    const handler = await buildHandler(teamRoutes, "/api/team/members/:memberId", "GET");
    const res = await handler(
      makeContext({ method: "GET", headers: ADMIN_HEADERS, params: { memberId: "TM-7" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(member);
    expect(team.getTeamMemberById).toHaveBeenCalledWith("TM-7");
  });

  test("404 when member not found", async () => {
    vi.mocked(team.getTeamMemberById).mockResolvedValueOnce(null);

    const handler = await buildHandler(teamRoutes, "/api/team/members/:memberId", "GET");
    const res = await handler(
      makeContext({ method: "GET", headers: ADMIN_HEADERS, params: { memberId: "TM-404" } }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Team member not found" });
  });
});

describe("PUT /api/team/members/:memberId", () => {
  test("200 returns { success, member } when update succeeds", async () => {
    const updated = { member_id: "TM-3", full_name: "Updated Name", role: "lead", department: "QMS", status: "active" as const, email: "x@y.com" };
    vi.mocked(team.updateTeamMember).mockResolvedValueOnce(updated);

    const handler = await buildHandler(teamRoutes, "/api/team/members/:memberId", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: ADMIN_HEADERS,
        params: { memberId: "TM-3" },
        body: { full_name: "Updated Name" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, member: updated });
    expect(team.updateTeamMember).toHaveBeenCalledWith("TM-3", { full_name: "Updated Name" });
  });

  test("404 when update returns null", async () => {
    vi.mocked(team.updateTeamMember).mockResolvedValueOnce(null);

    const handler = await buildHandler(teamRoutes, "/api/team/members/:memberId", "PUT");
    const res = await handler(
      makeContext({ method: "PUT", headers: ADMIN_HEADERS, params: { memberId: "missing" }, body: {} }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Team member not found" });
  });
});

describe("DELETE /api/team/members/:memberId", () => {
  test("200 returns success when delete succeeds", async () => {
    vi.mocked(team.deleteTeamMember).mockResolvedValueOnce(true);

    const handler = await buildHandler(teamRoutes, "/api/team/members/:memberId", "DELETE");
    const res = await handler(
      makeContext({ method: "DELETE", headers: ADMIN_HEADERS, params: { memberId: "TM-2" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: "Team member deleted" });
    expect(team.deleteTeamMember).toHaveBeenCalledWith("TM-2");
  });

  test("404 when delete returns false", async () => {
    vi.mocked(team.deleteTeamMember).mockResolvedValueOnce(false);

    const handler = await buildHandler(teamRoutes, "/api/team/members/:memberId", "DELETE");
    const res = await handler(
      makeContext({ method: "DELETE", headers: ADMIN_HEADERS, params: { memberId: "missing" } }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Team member not found" });
  });
});

describe("GET /api/team/analytics", () => {
  test("200 returns getTeamAnalytics() result directly", async () => {
    const analytics = {
      totalMembers: 12,
      byDepartment: { QMS: 5 },
      byStatus: { active: 11 },
      avgPerformance: 87.4,
    };
    // Cast: test only verifies pass-through of mock to res.body, not analytics shape.
    vi.mocked(team.getTeamAnalytics).mockResolvedValueOnce(
      analytics as unknown as Awaited<ReturnType<typeof team.getTeamAnalytics>>,
    );

    const handler = await buildHandler(teamRoutes, "/api/team/analytics", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toBe(analytics);
  });
});

describe("GET /api/team/performance", () => {
  test("200 forwards memberId / periodType / pagination filters", async () => {
    const fixture = { metrics: [{ id: 1, member_id: "TM-1", overall_score: 91 }], total: 1 };
    // Cast: test verifies the result is forwarded; individual metric shape is irrelevant.
    vi.mocked(team.getPerformanceMetrics).mockResolvedValueOnce(
      fixture as unknown as { metrics: TeamPerformanceMetric[]; total: number },
    );

    const handler = await buildHandler(teamRoutes, "/api/team/performance", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: ADMIN_HEADERS,
        url: "http://localhost/api/team/performance?memberId=TM-1&periodType=monthly&limit=20&offset=5",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(fixture);
    expect(team.getPerformanceMetrics).toHaveBeenCalledWith({
      memberId: "TM-1",
      periodType: "monthly",
      limit: 20,
      offset: 5,
    });
  });
});

describe("POST /api/team/performance", () => {
  test("200 returns { success, metric } from addPerformanceMetric()", async () => {
    const metric = { id: 7, member_id: "TM-1", quality_score: 90 };
    // Cast: test verifies res.body echo; full TeamPerformanceMetric shape irrelevant.
    vi.mocked(team.addPerformanceMetric).mockResolvedValueOnce(metric as unknown as TeamPerformanceMetric);

    const handler = await buildHandler(teamRoutes, "/api/team/performance", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        body: { member_id: "TM-1", quality_score: 90, productivity_score: 85, compliance_score: 95, period_type: "monthly" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, metric });
    expect(team.addPerformanceMetric).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/team/projects", () => {
  test("200 forwards project filters and pagination", async () => {
    const fixture = { assignments: [{ assignment_id: "A-1", project_name: "P1" }], total: 1 };
    // Cast: test verifies pass-through; individual assignment shape irrelevant.
    vi.mocked(team.listProjectAssignments).mockResolvedValueOnce(
      fixture as unknown as { assignments: TeamProjectAssignment[]; total: number },
    );

    const handler = await buildHandler(teamRoutes, "/api/team/projects", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: ADMIN_HEADERS,
        url: "http://localhost/api/team/projects?memberId=TM-1&projectType=audit&status=in_progress&priority=high",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(fixture);
    expect(team.listProjectAssignments).toHaveBeenCalledWith({
      memberId: "TM-1",
      projectType: "audit",
      status: "in_progress",
      priority: "high",
      limit: 50,
      offset: 0,
    });
  });
});

describe("POST /api/team/projects", () => {
  test("200 returns { success, assignment } from createProjectAssignment()", async () => {
    const assignment = { assignment_id: "A-9", project_name: "Audit-2026", member_id: "TM-1" };
    // Cast: test verifies res.body echo; full TeamProjectAssignment shape irrelevant.
    vi.mocked(team.createProjectAssignment).mockResolvedValueOnce(assignment as unknown as TeamProjectAssignment);

    const handler = await buildHandler(teamRoutes, "/api/team/projects", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        body: { project_name: "Audit-2026", project_type: "audit", member_id: "TM-1", member_name: "A", role_in_project: "owner", priority: "medium", status: "assigned", assigned_date: "2026-04-01" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, assignment });
  });
});

describe("PUT /api/team/projects/:assignmentId", () => {
  test("200 returns updated assignment", async () => {
    const assignment = { assignment_id: "A-9", project_name: "Audit-2026", status: "completed" };
    // Cast: test verifies res.body echo; full TeamProjectAssignment shape irrelevant.
    vi.mocked(team.updateProjectAssignment).mockResolvedValueOnce(assignment as unknown as TeamProjectAssignment);

    const handler = await buildHandler(teamRoutes, "/api/team/projects/:assignmentId", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: ADMIN_HEADERS,
        params: { assignmentId: "A-9" },
        body: { status: "completed" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, assignment });
    expect(team.updateProjectAssignment).toHaveBeenCalledWith("A-9", { status: "completed" });
  });

  test("404 when update returns null", async () => {
    vi.mocked(team.updateProjectAssignment).mockResolvedValueOnce(null);

    const handler = await buildHandler(teamRoutes, "/api/team/projects/:assignmentId", "PUT");
    const res = await handler(
      makeContext({ method: "PUT", headers: ADMIN_HEADERS, params: { assignmentId: "missing" }, body: {} }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Assignment not found" });
  });
});

describe("DELETE /api/team/projects/:assignmentId", () => {
  test("200 returns success when delete succeeds", async () => {
    vi.mocked(team.deleteProjectAssignment).mockResolvedValueOnce(true);

    const handler = await buildHandler(teamRoutes, "/api/team/projects/:assignmentId", "DELETE");
    const res = await handler(
      makeContext({ method: "DELETE", headers: ADMIN_HEADERS, params: { assignmentId: "A-9" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: "Assignment deleted" });
  });

  test("404 when delete returns false", async () => {
    vi.mocked(team.deleteProjectAssignment).mockResolvedValueOnce(false);

    const handler = await buildHandler(teamRoutes, "/api/team/projects/:assignmentId", "DELETE");
    const res = await handler(
      makeContext({ method: "DELETE", headers: ADMIN_HEADERS, params: { assignmentId: "missing" } }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Assignment not found" });
  });
});

describe("GET /api/team/training-matrix", () => {
  test("200 returns getTrainingMatrix() result directly", async () => {
    const matrix = { members: [{ member_id: "TM-1", full_name: "A", trainings: [] }], totalMembers: 1, totalTrainings: 0 };
    // Cast: test verifies pass-through of mock to res.body; full matrix shape irrelevant.
    vi.mocked(team.getTrainingMatrix).mockResolvedValueOnce(
      matrix as unknown as Awaited<ReturnType<typeof team.getTrainingMatrix>>,
    );

    const handler = await buildHandler(teamRoutes, "/api/team/training-matrix", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toBe(matrix);
  });
});

describe("GET /api/team/courses", () => {
  test("200 forwards department / course_type / is_active=true filter", async () => {
    const fixture = { courses: [{ course_id: "C-1", name: "Intro" }], total: 1 };
    // Cast: test verifies pass-through; full TrainingCourse shape irrelevant.
    vi.mocked(team.listTrainingCourses).mockResolvedValueOnce(
      fixture as unknown as { courses: TrainingCourse[]; total: number },
    );

    const handler = await buildHandler(teamRoutes, "/api/team/courses", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: ADMIN_HEADERS,
        url: "http://localhost/api/team/courses?department=QMS&course_type=mandatory&is_active=true&limit=10&offset=2",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(fixture);
    expect(team.listTrainingCourses).toHaveBeenCalledWith({
      department: "QMS",
      courseType: "mandatory",
      isActive: true,
      limit: 10,
      offset: 2,
    });
  });

  test("200 passes isActive=false when query param is the literal string 'false'", async () => {
    vi.mocked(team.listTrainingCourses).mockResolvedValueOnce({ courses: [], total: 0 });

    const handler = await buildHandler(teamRoutes, "/api/team/courses", "GET");
    await handler(
      makeContext({
        method: "GET",
        headers: ADMIN_HEADERS,
        url: "http://localhost/api/team/courses?is_active=false",
      }),
    );

    const call = vi.mocked(team.listTrainingCourses).mock.calls[0][0]!;
    expect(call.isActive).toBe(false);
  });

  test("200 leaves isActive undefined when query param is absent", async () => {
    vi.mocked(team.listTrainingCourses).mockResolvedValueOnce({ courses: [], total: 0 });

    const handler = await buildHandler(teamRoutes, "/api/team/courses", "GET");
    await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    const call = vi.mocked(team.listTrainingCourses).mock.calls[0][0]!;
    expect(call.isActive).toBeUndefined();
  });
});

describe("POST /api/team/courses", () => {
  test("200 returns created course and writes a training audit-log entry", async () => {
    const course = { course_id: "C-99", name: "ISO 9001 Awareness", course_type: "mandatory" as const, duration_hours: 2, is_active: true };
    vi.mocked(team.createTrainingCourse).mockResolvedValueOnce(course);

    const handler = await buildHandler(teamRoutes, "/api/team/courses", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        body: { name: "ISO 9001 Awareness", course_type: "mandatory", duration_hours: 2, is_active: true },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, course });
    expect(team.createTrainingCourse).toHaveBeenCalledTimes(1);
    expect(team.logAuditEntry).toHaveBeenCalledTimes(1);
    const auditArgs = vi.mocked(team.logAuditEntry).mock.calls[0][0];
    expect(auditArgs.action_type).toBe("create");
    expect(auditArgs.module).toBe("training");
    expect(auditArgs.entity_type).toBe("training_course");
    expect(auditArgs.entity_id).toBe("C-99");
  });
});

describe("GET /api/team/courses/:courseId", () => {
  test("200 returns the course when found", async () => {
    const course = { course_id: "C-7", name: "PDPL Awareness", course_type: "mandatory" as const, duration_hours: 1, is_active: true };
    vi.mocked(team.getTrainingCourseById).mockResolvedValueOnce(course);

    const handler = await buildHandler(teamRoutes, "/api/team/courses/:courseId", "GET");
    const res = await handler(
      makeContext({ method: "GET", headers: ADMIN_HEADERS, params: { courseId: "C-7" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(course);
  });

  test("404 when course not found", async () => {
    vi.mocked(team.getTrainingCourseById).mockResolvedValueOnce(null);

    const handler = await buildHandler(teamRoutes, "/api/team/courses/:courseId", "GET");
    const res = await handler(
      makeContext({ method: "GET", headers: ADMIN_HEADERS, params: { courseId: "missing" } }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Training course not found" });
  });
});

describe("PUT /api/team/courses/:courseId", () => {
  test("200 returns updated course and audits old + new value", async () => {
    const oldCourse = { course_id: "C-5", name: "Old Name", course_type: "mandatory" as const, duration_hours: 1, is_active: true };
    const newCourse = { ...oldCourse, name: "New Name" };
    vi.mocked(team.getTrainingCourseById).mockResolvedValueOnce(oldCourse);
    vi.mocked(team.updateTrainingCourse).mockResolvedValueOnce(newCourse);

    const handler = await buildHandler(teamRoutes, "/api/team/courses/:courseId", "PUT");
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: ADMIN_HEADERS,
        params: { courseId: "C-5" },
        body: { name: "New Name" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, course: newCourse });
    expect(team.updateTrainingCourse).toHaveBeenCalledWith("C-5", { name: "New Name" });
    const auditArgs = vi.mocked(team.logAuditEntry).mock.calls[0][0];
    expect(auditArgs.action_type).toBe("update");
    expect(auditArgs.old_value).toBe(oldCourse);
    expect(auditArgs.new_value).toBe(newCourse);
  });
});

describe("DELETE /api/team/courses/:courseId", () => {
  test("200 returns success and audits deletion", async () => {
    const oldCourse = { course_id: "C-2", name: "To delete", course_type: "optional" as const, duration_hours: 1, is_active: false };
    vi.mocked(team.getTrainingCourseById).mockResolvedValueOnce(oldCourse);
    vi.mocked(team.deleteTrainingCourse).mockResolvedValueOnce(true);

    const handler = await buildHandler(teamRoutes, "/api/team/courses/:courseId", "DELETE");
    const res = await handler(
      makeContext({ method: "DELETE", headers: ADMIN_HEADERS, params: { courseId: "C-2" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const auditArgs = vi.mocked(team.logAuditEntry).mock.calls[0][0];
    expect(auditArgs.action_type).toBe("delete");
    expect(auditArgs.old_value).toBe(oldCourse);
  });

  test("404 when delete returns false", async () => {
    vi.mocked(team.getTrainingCourseById).mockResolvedValueOnce(null);
    vi.mocked(team.deleteTrainingCourse).mockResolvedValueOnce(false);

    const handler = await buildHandler(teamRoutes, "/api/team/courses/:courseId", "DELETE");
    const res = await handler(
      makeContext({ method: "DELETE", headers: ADMIN_HEADERS, params: { courseId: "missing" } }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Training course not found" });
  });
});

describe("GET /api/team/course-assignments", () => {
  test("200 forwards member_id / course_id / status filters", async () => {
    const fixture = { assignments: [{ assignment_id: "TA-1" }], total: 1 };
    vi.mocked(team.listCourseAssignments).mockResolvedValueOnce(fixture);

    const handler = await buildHandler(teamRoutes, "/api/team/course-assignments", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: ADMIN_HEADERS,
        url: "http://localhost/api/team/course-assignments?member_id=TM-1&course_id=C-1&status=assigned",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(fixture);
    expect(team.listCourseAssignments).toHaveBeenCalledWith({
      memberId: "TM-1",
      courseId: "C-1",
      status: "assigned",
      limit: 50,
      offset: 0,
    });
  });
});

describe("POST /api/team/course-assignments", () => {
  test("200 returns { success, assignment } and audits assignment", async () => {
    const assignment = { assignment_id: "TA-9", course_id: "C-1", member_id: "TM-1", status: "assigned" as const };
    // Cast: test verifies res.body echo; full TrainingAssignment shape irrelevant.
    vi.mocked(team.createCourseAssignment).mockResolvedValueOnce(assignment as unknown as TrainingAssignment);

    const handler = await buildHandler(teamRoutes, "/api/team/course-assignments", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        body: { course_id: "C-1", member_id: "TM-1", assigned_date: "2026-04-01", status: "assigned", priority: "medium", requires_assessment: false },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, assignment });
    const auditArgs = vi.mocked(team.logAuditEntry).mock.calls[0][0];
    expect(auditArgs.action_type).toBe("assign");
    expect(auditArgs.entity_id).toBe("TA-9");
  });
});

describe("GET /api/team/kanban", () => {
  test("200 returns getProjectsByKanbanStatus() result directly", async () => {
    const board = { backlog: [], in_progress: [], review: [], completed: [] };
    // Cast: test verifies pass-through; the waiting_stakeholder bucket is omitted on purpose.
    vi.mocked(team.getProjectsByKanbanStatus).mockResolvedValueOnce(
      board as unknown as Awaited<ReturnType<typeof team.getProjectsByKanbanStatus>>,
    );

    const handler = await buildHandler(teamRoutes, "/api/team/kanban", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toBe(board);
  });
});

describe("GET /api/team/course-training-matrix", () => {
  test("200 returns getCourseTrainingMatrix() result directly", async () => {
    const matrix = { members: [{ member_id: "TM-1", full_name: "A", courses: [] }], totalMembers: 1, totalCourses: 0 };
    // Cast: test verifies pass-through; full course matrix shape irrelevant.
    vi.mocked(team.getCourseTrainingMatrix).mockResolvedValueOnce(
      matrix as unknown as Awaited<ReturnType<typeof team.getCourseTrainingMatrix>>,
    );

    const handler = await buildHandler(teamRoutes, "/api/team/course-training-matrix", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toBe(matrix);
  });
});

describe("GET /api/audit-trail", () => {
  test("200 forwards module / entity_type / entity_id / user_id / action_type filters", async () => {
    const fixture = { logs: [{ action_id: "A-1" }], total: 1 };
    // Cast: test verifies pass-through; full AuditLogEntry shape irrelevant.
    vi.mocked(team.listAuditLogs).mockResolvedValueOnce(
      fixture as unknown as { logs: AuditLogEntry[]; total: number },
    );

    const handler = await buildHandler(teamRoutes, "/api/audit-trail", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: ADMIN_HEADERS,
        url: "http://localhost/api/audit-trail?module=training&entity_type=training_course&entity_id=C-1&user_id=u-1&action_type=update&limit=25&offset=10",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(fixture);
    expect(team.listAuditLogs).toHaveBeenCalledWith({
      module: "training",
      entityType: "training_course",
      entityId: "C-1",
      userId: "u-1",
      actionType: "update",
      limit: 25,
      offset: 10,
    });
  });

  test("200 falls back to default limit=100/offset=0 when query absent", async () => {
    vi.mocked(team.listAuditLogs).mockResolvedValueOnce({ logs: [], total: 0 });

    const handler = await buildHandler(teamRoutes, "/api/audit-trail", "GET");
    await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(team.listAuditLogs).toHaveBeenCalledWith({
      module: undefined,
      entityType: undefined,
      entityId: undefined,
      userId: undefined,
      actionType: undefined,
      limit: 100,
      offset: 0,
    });
  });
});
