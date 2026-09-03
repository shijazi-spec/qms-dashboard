import type { UserRole } from "../../utils/rbacDatabase";

import { logger as safeLogger } from "../../utils/logger";
import { getLLMProviderApiKey, getLLMProviderBaseUrl } from "../../utils/LLMProviderCredentials";
const TEAM_MGMT_ROLES: UserRole[] = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
];

async function requireTeamAccess(c: any) {
  const { requireRole, forbiddenResponse } =
    await import("../../utils/rbacMiddleware");
  const user = await requireRole(c, TEAM_MGMT_ROLES);
  if (!user) return { user: null, response: forbiddenResponse(c) };
  return { user, response: null };
}

export const teamRoutes = [
  {
    path: "/api/team/members",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { response: authError } = await requireTeamAccess(c);
          if (authError) return authError;

          logger?.info("👥 [Team API] Fetching team members");

          const { initTeamTables, listTeamMembers } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const url = new URL(c.req.url);
          const department = url.searchParams.get("department") || undefined;
          const role = url.searchParams.get("role") || undefined;
          const status = url.searchParams.get("status") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");

          const result = await listTeamMembers({
            department,
            role,
            status,
            limit,
            offset,
          });
          logger?.info("✅ [Team API] Team members fetched", {
            count: result.members.length,
          });
          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching team members:", error);
          return c.json({ error: "Failed to fetch team members" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/members",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("➕ [Team API] Creating team member", {
            name: body.full_name,
          });

          const { initTeamTables, createTeamMember } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const member = await createTeamMember(body);
          logger?.info("✅ [Team API] Team member created", {
            id: member.member_id,
          });
          return c.json({ success: true, member });
        } catch (error) {
          safeLogger.error("Error creating team member:", error);
          return c.json({ error: "Failed to create team member" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/members/:memberId",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { response: authError } = await requireTeamAccess(c);
          if (authError) return authError;

          const memberId = c.req.param("memberId");
          logger?.info("👤 [Team API] Fetching team member", { memberId });

          const { initTeamTables, getTeamMemberById } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const member = await getTeamMemberById(memberId);
          if (!member) {
            return c.json({ error: "Team member not found" }, 404);
          }

          logger?.info("✅ [Team API] Team member fetched", { memberId });
          return c.json(member);
        } catch (error) {
          safeLogger.error("Error fetching team member:", error);
          return c.json({ error: "Failed to fetch team member" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/members/:memberId",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const memberId = c.req.param("memberId");
          const body = await c.req.json();
          logger?.info("✏️ [Team API] Updating team member", { memberId });

          const { initTeamTables, updateTeamMember } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const member = await updateTeamMember(memberId, body);
          if (!member) {
            return c.json({ error: "Team member not found" }, 404);
          }

          logger?.info("✅ [Team API] Team member updated", { memberId });
          return c.json({ success: true, member });
        } catch (error) {
          safeLogger.error("Error updating team member:", error);
          return c.json({ error: "Failed to update team member" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/members/:memberId",
    method: "DELETE" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const memberId = c.req.param("memberId");
          logger?.info("🗑️ [Team API] Deleting team member", { memberId });

          const { initTeamTables, deleteTeamMember } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const success = await deleteTeamMember(memberId);
          if (!success) {
            return c.json({ error: "Team member not found" }, 404);
          }

          logger?.info("✅ [Team API] Team member deleted", { memberId });
          return c.json({ success: true, message: "Team member deleted" });
        } catch (error) {
          safeLogger.error("Error deleting team member:", error);
          return c.json({ error: "Failed to delete team member" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/analytics",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { response: authError } = await requireTeamAccess(c);
          if (authError) return authError;

          logger?.info("📊 [Team API] Fetching team analytics");

          const { initTeamTables, getTeamAnalytics } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const analytics = await getTeamAnalytics();
          logger?.info("✅ [Team API] Team analytics fetched");
          return c.json(analytics);
        } catch (error) {
          safeLogger.error("Error fetching team analytics:", error);
          return c.json({ error: "Failed to fetch team analytics" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/performance",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { response: authError } = await requireTeamAccess(c);
          if (authError) return authError;

          logger?.info("📈 [Team API] Fetching performance metrics");

          const { initTeamTables, getPerformanceMetrics } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const url = new URL(c.req.url);
          const memberId = url.searchParams.get("memberId") || undefined;
          const periodType = url.searchParams.get("periodType") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");

          const result = await getPerformanceMetrics({
            memberId,
            periodType,
            limit,
            offset,
          });
          logger?.info("✅ [Team API] Performance metrics fetched", {
            count: result.metrics.length,
          });
          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching performance metrics:", error);
          return c.json({ error: "Failed to fetch performance metrics" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/performance",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("➕ [Team API] Adding performance metric", {
            memberId: body.member_id,
          });

          const { initTeamTables, addPerformanceMetric } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const metric = await addPerformanceMetric(body);
          logger?.info("✅ [Team API] Performance metric added");
          return c.json({ success: true, metric });
        } catch (error) {
          safeLogger.error("Error adding performance metric:", error);
          return c.json({ error: "Failed to add performance metric" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/projects",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { response: authError } = await requireTeamAccess(c);
          if (authError) return authError;

          logger?.info("📋 [Team API] Fetching project assignments");

          const { initTeamTables, listProjectAssignments } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const url = new URL(c.req.url);
          const memberId = url.searchParams.get("memberId") || undefined;
          const projectType = url.searchParams.get("projectType") || undefined;
          const status = url.searchParams.get("status") || undefined;
          const priority = url.searchParams.get("priority") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");

          const result = await listProjectAssignments({
            memberId,
            projectType,
            status,
            priority,
            limit,
            offset,
          });
          logger?.info("✅ [Team API] Project assignments fetched", {
            count: result.assignments.length,
          });
          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching project assignments:", error);
          return c.json({ error: "Failed to fetch project assignments" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/projects",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("➕ [Team API] Creating project assignment", {
            project: body.project_name,
          });

          const { initTeamTables, createProjectAssignment } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const assignment = await createProjectAssignment(body);
          logger?.info("✅ [Team API] Project assignment created", {
            id: assignment.assignment_id,
          });
          return c.json({ success: true, assignment });
        } catch (error) {
          safeLogger.error("Error creating project assignment:", error);
          return c.json({ error: "Failed to create project assignment" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/projects/:assignmentId",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const assignmentId = c.req.param("assignmentId");
          const body = await c.req.json();
          logger?.info("✏️ [Team API] Updating project assignment", {
            assignmentId,
          });

          const { initTeamTables, updateProjectAssignment } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const assignment = await updateProjectAssignment(assignmentId, body);
          if (!assignment) {
            return c.json({ error: "Assignment not found" }, 404);
          }

          logger?.info("✅ [Team API] Project assignment updated", {
            assignmentId,
          });
          return c.json({ success: true, assignment });
        } catch (error) {
          safeLogger.error("Error updating project assignment:", error);
          return c.json({ error: "Failed to update project assignment" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/projects/:assignmentId",
    method: "DELETE" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const assignmentId = c.req.param("assignmentId");
          logger?.info("🗑️ [Team API] Deleting project assignment", {
            assignmentId,
          });

          const { initTeamTables, deleteProjectAssignment } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const success = await deleteProjectAssignment(assignmentId);
          if (!success) {
            return c.json({ error: "Assignment not found" }, 404);
          }

          logger?.info("✅ [Team API] Project assignment deleted", {
            assignmentId,
          });
          return c.json({ success: true, message: "Assignment deleted" });
        } catch (error) {
          safeLogger.error("Error deleting project assignment:", error);
          return c.json({ error: "Failed to delete project assignment" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/training-matrix",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { response: authError } = await requireTeamAccess(c);
          if (authError) return authError;

          logger?.info("📚 [Team API] Fetching training matrix");

          const { initTeamTables, getTrainingMatrix } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const matrix = await getTrainingMatrix();
          logger?.info("✅ [Team API] Training matrix fetched", {
            count: matrix.members.length,
          });
          return c.json(matrix);
        } catch (error) {
          safeLogger.error("Error fetching training matrix:", error);
          return c.json({ error: "Failed to fetch training matrix" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/courses",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { response: authError } = await requireTeamAccess(c);
          if (authError) return authError;

          logger?.info("📚 [Team API] Fetching training courses");

          const { initTeamTables, listTrainingCourses } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const url = new URL(c.req.url);
          const department = url.searchParams.get("department") || undefined;
          const courseType = url.searchParams.get("course_type") || undefined;
          const isActive =
            url.searchParams.get("is_active") === "true"
              ? true
              : url.searchParams.get("is_active") === "false"
                ? false
                : undefined;
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");

          const result = await listTrainingCourses({
            department,
            courseType,
            isActive,
            limit,
            offset,
          });
          logger?.info("✅ [Team API] Training courses fetched", {
            count: result.courses.length,
          });
          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching training courses:", error);
          return c.json({ error: "Failed to fetch training courses" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/courses",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("➕ [Team API] Creating training course", {
            name: body.name,
          });

          const { initTeamTables, createTrainingCourse, logAuditEntry } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const course = await createTrainingCourse(body);

          await logAuditEntry({
            action_type: "create",
            module: "training",
            entity_type: "training_course",
            entity_id: course.course_id,
            description: `Created training course: ${course.name}`,
            new_value: course,
            ai_involved: false,
          });

          logger?.info("✅ [Team API] Training course created", {
            id: course.course_id,
          });
          return c.json({ success: true, course });
        } catch (error) {
          safeLogger.error("Error creating training course:", error);
          return c.json({ error: "Failed to create training course" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/courses/:courseId",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { response: authError } = await requireTeamAccess(c);
          if (authError) return authError;

          const courseId = c.req.param("courseId");
          logger?.info("📖 [Team API] Fetching training course", { courseId });

          const { initTeamTables, getTrainingCourseById } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const course = await getTrainingCourseById(courseId);
          if (!course) {
            return c.json({ error: "Training course not found" }, 404);
          }

          logger?.info("✅ [Team API] Training course fetched", { courseId });
          return c.json(course);
        } catch (error) {
          safeLogger.error("Error fetching training course:", error);
          return c.json({ error: "Failed to fetch training course" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/courses/:courseId",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const courseId = c.req.param("courseId");
          const body = await c.req.json();
          logger?.info("✏️ [Team API] Updating training course", { courseId });

          const {
            initTeamTables,
            getTrainingCourseById,
            updateTrainingCourse,
            logAuditEntry,
          } = await import("../../utils/teamDatabase");
          await initTeamTables();

          const oldCourse = await getTrainingCourseById(courseId);
          const course = await updateTrainingCourse(courseId, body);
          if (!course) {
            return c.json({ error: "Training course not found" }, 404);
          }

          await logAuditEntry({
            action_type: "update",
            module: "training",
            entity_type: "training_course",
            entity_id: courseId,
            description: `Updated training course: ${course.name}`,
            old_value: oldCourse,
            new_value: course,
            ai_involved: false,
          });

          logger?.info("✅ [Team API] Training course updated", { courseId });
          return c.json({ success: true, course });
        } catch (error) {
          safeLogger.error("Error updating training course:", error);
          return c.json({ error: "Failed to update training course" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/courses/:courseId",
    method: "DELETE" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const courseId = c.req.param("courseId");
          logger?.info("🗑️ [Team API] Deleting training course", { courseId });

          const {
            initTeamTables,
            getTrainingCourseById,
            deleteTrainingCourse,
            logAuditEntry,
          } = await import("../../utils/teamDatabase");
          await initTeamTables();

          const oldCourse = await getTrainingCourseById(courseId);
          const success = await deleteTrainingCourse(courseId);
          if (!success) {
            return c.json({ error: "Training course not found" }, 404);
          }

          await logAuditEntry({
            action_type: "delete",
            module: "training",
            entity_type: "training_course",
            entity_id: courseId,
            description: `Deleted training course: ${oldCourse?.name}`,
            old_value: oldCourse,
            ai_involved: false,
          });

          logger?.info("✅ [Team API] Training course deleted", { courseId });
          return c.json({ success: true });
        } catch (error) {
          safeLogger.error("Error deleting training course:", error);
          return c.json({ error: "Failed to delete training course" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/course-assignments",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { response: authError } = await requireTeamAccess(c);
          if (authError) return authError;

          logger?.info("📚 [Team API] Fetching course assignments");

          const { initTeamTables, listCourseAssignments } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const url = new URL(c.req.url);
          const memberId = url.searchParams.get("member_id") || undefined;
          const courseId = url.searchParams.get("course_id") || undefined;
          const status = url.searchParams.get("status") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");

          const result = await listCourseAssignments({
            memberId,
            courseId,
            status,
            limit,
            offset,
          });
          logger?.info("✅ [Team API] Course assignments fetched", {
            count: result.assignments.length,
          });
          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching course assignments:", error);
          return c.json({ error: "Failed to fetch course assignments" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/course-assignments",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("➕ [Team API] Creating course assignment", {
            courseId: body.course_id,
            memberId: body.member_id,
          });

          const { initTeamTables, createCourseAssignment, logAuditEntry } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const assignment = await createCourseAssignment(body);

          await logAuditEntry({
            action_type: "assign",
            module: "training",
            entity_type: "course_assignment",
            entity_id: assignment.assignment_id,
            description: `Assigned course ${body.course_id} to member ${body.member_id}`,
            new_value: assignment,
            ai_involved: false,
          });

          logger?.info("✅ [Team API] Course assignment created", {
            id: assignment.assignment_id,
          });
          return c.json({ success: true, assignment });
        } catch (error) {
          safeLogger.error("Error creating course assignment:", error);
          return c.json({ error: "Failed to create course assignment" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/course-assignments/:assignmentId",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const assignmentId = c.req.param("assignmentId");
          const body = await c.req.json();
          logger?.info("✏️ [Team API] Updating course assignment", {
            assignmentId,
          });

          const { initTeamTables, updateCourseAssignment, logAuditEntry } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const assignment = await updateCourseAssignment(assignmentId, body);
          if (!assignment) {
            return c.json({ error: "Course assignment not found" }, 404);
          }

          await logAuditEntry({
            action_type: "update",
            module: "training",
            entity_type: "course_assignment",
            entity_id: assignmentId,
            description: `Updated course assignment status to ${body.status || "updated"}`,
            new_value: assignment,
            ai_involved: false,
          });

          logger?.info("✅ [Team API] Course assignment updated", {
            assignmentId,
          });
          return c.json({ success: true, assignment });
        } catch (error) {
          safeLogger.error("Error updating course assignment:", error);
          return c.json({ error: "Failed to update course assignment" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/course-assignments/:assignmentId",
    method: "DELETE" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const assignmentId = c.req.param("assignmentId");
          logger?.info("🗑️ [Team API] Deleting course assignment", {
            assignmentId,
          });

          const { initTeamTables, deleteCourseAssignment, logAuditEntry } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const success = await deleteCourseAssignment(assignmentId);
          if (!success) {
            return c.json({ error: "Course assignment not found" }, 404);
          }

          await logAuditEntry({
            action_type: "delete",
            module: "training",
            entity_type: "course_assignment",
            entity_id: assignmentId,
            description: `Deleted course assignment`,
            ai_involved: false,
          });

          logger?.info("✅ [Team API] Course assignment deleted", {
            assignmentId,
          });
          return c.json({ success: true });
        } catch (error) {
          safeLogger.error("Error deleting course assignment:", error);
          return c.json({ error: "Failed to delete course assignment" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/kanban",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { response: authError } = await requireTeamAccess(c);
          if (authError) return authError;

          logger?.info("📋 [Team API] Fetching Kanban board");

          const { initTeamTables, getProjectsByKanbanStatus } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const kanban = await getProjectsByKanbanStatus();
          logger?.info("✅ [Team API] Kanban board fetched");
          return c.json(kanban);
        } catch (error) {
          safeLogger.error("Error fetching Kanban board:", error);
          return c.json({ error: "Failed to fetch Kanban board" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/course-training-matrix",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { response: authError } = await requireTeamAccess(c);
          if (authError) return authError;

          logger?.info("📚 [Team API] Fetching course training matrix");

          const { initTeamTables, getCourseTrainingMatrix } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const matrix = await getCourseTrainingMatrix();
          logger?.info("✅ [Team API] Course training matrix fetched", {
            count: matrix.members.length,
          });
          return c.json(matrix);
        } catch (error) {
          safeLogger.error("Error fetching course training matrix:", error);
          return c.json(
            { error: "Failed to fetch course training matrix" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/audit-trail",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { response: authError } = await requireTeamAccess(c);
          if (authError) return authError;

          logger?.info("📝 [Audit API] Fetching audit logs");

          const { initTeamTables, listAuditLogs } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const url = new URL(c.req.url);
          const module = url.searchParams.get("module") || undefined;
          const entityType = url.searchParams.get("entity_type") || undefined;
          const entityId = url.searchParams.get("entity_id") || undefined;
          const userId = url.searchParams.get("user_id") || undefined;
          const actionType = url.searchParams.get("action_type") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "100");
          const offset = parseInt(url.searchParams.get("offset") || "0");

          const result = await listAuditLogs({
            module,
            entityType,
            entityId,
            userId,
            actionType,
            limit,
            offset,
          });
          logger?.info("✅ [Audit API] Audit logs fetched", {
            count: result.logs.length,
          });
          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching audit logs:", error);
          return c.json({ error: "Failed to fetch audit logs" }, 500);
        }
      };
    },
  },
  {
    path: "/api/team/ai-scope-generator",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("🤖 [Team API] Generating AI scope", {
            projectName: body.project_name,
          });

          const { createLLMProvider } = await import("@ai-sdk/LLMProvider");
          const { generateText } = await import("ai");
          const { initTeamTables, logAuditEntry } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const LLMProvider = createLLMProvider({
            baseURL: getLLMProviderBaseUrl(),
            apiKey: <REDACTED_SECRET>
          });

          const prompt = `You are a Quality Management expert. Based on the following project information, generate a comprehensive project scope document.

Project Details:
- Project Name: ${body.project_name}
- Project Type: ${body.project_type}
- Department: ${body.department || "Not specified"}
- Description: ${body.description || "Not specified"}
- Priority: ${body.priority || "medium"}

Generate a JSON response with the following structure:
{
  "scope": "Detailed project scope description",
  "expected_outputs": ["List of expected deliverables"],
  "sop_requirements": ["List of SOPs that may need creation or update"],
  "kpis": ["List of key performance indicators to track"],
  "risks": ["List of potential risks"],
  "dependencies": ["List of dependencies on other projects or resources"],
  "timeline_phases": [{"phase": "Phase name", "duration": "Duration estimate", "activities": ["Activities"]}],
  "stakeholders_to_meet": ["List of stakeholders to engage"],
  "resources_needed": ["List of resources required"]
}

Respond ONLY with valid JSON, no additional text.`;

          // Raw-fetch /chat/completions — `.chat()` adapter now also
          // emits v3 spec under @ai-sdk/LLMProvider 3.x, breaking <REDACTED_EMAIL>
          // (needs v2). Helper avoids the SDK entirely.
          const { generateChatText } = await import(
            "../../utils/LLMProviderChatHelper"
          );
          const { text } = await generateChatText({
            model: "gpt-4o",
            prompt,
            maxTokens: <REDACTED_SECRET>
          });

          let scopeResult;
          try {
            scopeResult = JSON.parse(text);
          } catch {
            scopeResult = {
              scope: text,
              error: "Failed to parse AI response as JSON",
            };
          }

          await logAuditEntry({
            action_type: "create",
            module: "project",
            entity_type: "ai_scope",
            entity_id: body.project_name || "unknown",
            description: `AI generated scope for project: ${body.project_name}`,
            new_value: scopeResult,
            ai_involved: true,
          });

          logger?.info("✅ [Team API] AI scope generated");
          return c.json({ success: true, scope: scopeResult });
        } catch (error) {
          safeLogger.error("Error generating AI scope:", error);
          return c.json({ error: "Failed to generate AI scope" }, 500);
        }
      };
    },
  },
  {
    path: "/team",
    method: "GET" as const,
    createHandler: async () => {
      const { readFileSync, existsSync } = await import("fs");
      const { join } = await import("path");

      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "team.html"),
            join(process.cwd(), "..", "dashboard", "team.html"),
            "/home/runner/workspace/dashboard/team.html",
          ];

          for (const teamPath of possiblePaths) {
            if (existsSync(teamPath)) {
              const html = readFileSync(teamPath, "utf-8");
              return c.html(html);
            }
          }

          safeLogger.error(
            "Team dashboard not found in any path:",
            possiblePaths,
          );
          return c.text("Team dashboard not found", 404);
        } catch (error) {
          safeLogger.error("Error serving Team dashboard:", error);
          return c.text("Error loading Team dashboard", 500);
        }
      };
    },
  },
];
