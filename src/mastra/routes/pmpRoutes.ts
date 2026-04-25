import {
  gateApiRoute,
  requireRole,
  forbiddenResponse,
  hasValidAdminApiKey,
} from "../../utils/rbacMiddleware";
import type { UserRole } from "../../utils/rbacDatabase";
import { getSessionFromCookie } from "./authRoutes";

import { logger as safeLogger } from "../../utils/logger";
const PMP_READ_ROLES: UserRole[] = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
  "executive",
  "bu_owner",
];
const PMP_WRITE_ROLES: UserRole[] = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
  "bu_owner",
];
const PMP_CHARTER_ROLES: UserRole[] = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
  "ai_specialist",
  "bu_owner",
];

function pmpGate<
  T extends { path: string; method: string; createHandler: (deps: any) => any },
>(route: T): T {
  if (!route.path.startsWith("/api/")) return route;
  const roles =
    route.path === "/api/pmp/generate-charter"
      ? PMP_CHARTER_ROLES
      : ["POST", "PUT", "DELETE"].includes(route.method)
        ? PMP_WRITE_ROLES
        : PMP_READ_ROLES;
  const originalCreate = route.createHandler;
  return {
    ...route,
    createHandler: async (deps: any) => {
      const inner = await originalCreate(deps);
      return async (c: any) => {
        const user = await requireRole(c, roles);
        if (!user)
          return forbiddenResponse(c, "Insufficient permissions for PMP data");
        return inner(c);
      };
    },
  };
}

const _pmpRoutesRaw = [
  // ============================================
  // PMP PROJECTS ROUTES
  // ============================================
  {
    path: "/api/pmp/projects",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("📋 [PMP API] Fetching PMP projects");

          const { initTeamTables, listPMPProjects } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const url = new URL(c.req.url);
          const department = url.searchParams.get("department") || undefined;
          const status = url.searchParams.get("status") || undefined;
          const priority = url.searchParams.get("priority") || undefined;
          const projectType = url.searchParams.get("project_type") || undefined;
          const managerId = url.searchParams.get("manager_id") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");

          const result = await listPMPProjects({
            department,
            status,
            priority,
            projectType,
            managerId,
            limit,
            offset,
          });
          logger?.info("✅ [PMP API] Projects fetched", {
            count: result.projects.length,
          });
          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching PMP projects:", error);
          return c.json({ error: "Failed to fetch PMP projects" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/projects",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("➕ [PMP API] Creating PMP project", {
            name: body.project_name,
          });

          const { initTeamTables, createPMPProject, logAuditEntry } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const project = await createPMPProject(body);

          await logAuditEntry({
            action_type: "create",
            module: "project",
            entity_type: "pmp_project",
            entity_id: project.project_id,
            description: `Created PMP project: ${project.project_name}`,
            new_value: project,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] PMP project created", {
            id: project.project_id,
          });
          return c.json({ success: true, project });
        } catch (error) {
          safeLogger.error("Error creating PMP project:", error);
          return c.json({ error: "Failed to create PMP project" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/projects/:projectId",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const projectId = c.req.param("projectId");
          logger?.info("📖 [PMP API] Fetching PMP project", { projectId });

          const {
            initTeamTables,
            getPMPProjectById,
            listProjectRisks,
            listProjectMilestones,
            listProjectStakeholders,
            listProjectProcurement,
            listProjectChangeRequests,
          } = await import("../../utils/teamDatabase");
          await initTeamTables();

          const project = await getPMPProjectById(projectId);
          if (!project) {
            return c.json({ error: "PMP project not found" }, 404);
          }

          const [risks, milestones, stakeholders, procurement, changeRequests] =
            await Promise.all([
              listProjectRisks({ projectId, limit: 100 }),
              listProjectMilestones({ projectId, limit: 100 }),
              listProjectStakeholders({ projectId, limit: 100 }),
              listProjectProcurement({ projectId, limit: 100 }),
              listProjectChangeRequests({ projectId, limit: 100 }),
            ]);

          logger?.info("✅ [PMP API] PMP project fetched with details", {
            projectId,
          });
          return c.json({
            ...project,
            risks: risks.risks,
            milestones: milestones.milestones,
            stakeholders: stakeholders.stakeholders,
            procurement: procurement.procurement,
            changeRequests: changeRequests.changeRequests,
          });
        } catch (error) {
          safeLogger.error("Error fetching PMP project:", error);
          return c.json({ error: "Failed to fetch PMP project" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/projects/:projectId",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const projectId = c.req.param("projectId");
          const body = await c.req.json();
          logger?.info("✏️ [PMP API] Updating PMP project", { projectId });

          const {
            initTeamTables,
            getPMPProjectById,
            updatePMPProject,
            logAuditEntry,
          } = await import("../../utils/teamDatabase");
          await initTeamTables();

          const oldProject = await getPMPProjectById(projectId);
          const project = await updatePMPProject(projectId, body);
          if (!project) {
            return c.json({ error: "PMP project not found" }, 404);
          }

          await logAuditEntry({
            action_type: "update",
            module: "project",
            entity_type: "pmp_project",
            entity_id: projectId,
            description: `Updated PMP project: ${project.project_name}`,
            old_value: oldProject,
            new_value: project,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] PMP project updated", { projectId });
          return c.json({ success: true, project });
        } catch (error) {
          safeLogger.error("Error updating PMP project:", error);
          return c.json({ error: "Failed to update PMP project" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/projects/:projectId",
    method: "DELETE" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const projectId = c.req.param("projectId");
          logger?.info("🗑️ [PMP API] Deleting PMP project", { projectId });

          const {
            initTeamTables,
            getPMPProjectById,
            deletePMPProject,
            logAuditEntry,
          } = await import("../../utils/teamDatabase");
          await initTeamTables();

          const oldProject = await getPMPProjectById(projectId);
          const success = await deletePMPProject(projectId);
          if (!success) {
            return c.json({ error: "PMP project not found" }, 404);
          }

          await logAuditEntry({
            action_type: "delete",
            module: "project",
            entity_type: "pmp_project",
            entity_id: projectId,
            description: `Deleted PMP project: ${oldProject?.project_name}`,
            old_value: oldProject,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] PMP project deleted", { projectId });
          return c.json({ success: true });
        } catch (error) {
          safeLogger.error("Error deleting PMP project:", error);
          return c.json({ error: "Failed to delete PMP project" }, 500);
        }
      };
    },
  },

  // ============================================
  // PROJECT RISKS ROUTES
  // ============================================
  {
    path: "/api/pmp/risks",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("⚠️ [PMP API] Fetching project risks");

          const { initTeamTables, listProjectRisks } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const url = new URL(c.req.url);
          const projectId = url.searchParams.get("project_id") || undefined;
          const category = url.searchParams.get("category") || undefined;
          const status = url.searchParams.get("status") || undefined;
          const ownerId = url.searchParams.get("owner_id") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");

          const result = await listProjectRisks({
            projectId,
            category,
            status,
            ownerId,
            limit,
            offset,
          });
          logger?.info("✅ [PMP API] Risks fetched", {
            count: result.risks.length,
          });
          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching project risks:", error);
          return c.json({ error: "Failed to fetch project risks" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/risks",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("➕ [PMP API] Creating project risk", {
            title: body.title,
          });

          const { initTeamTables, createProjectRisk, logAuditEntry } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const risk = await createProjectRisk(body);

          await logAuditEntry({
            action_type: "create",
            module: "project",
            entity_type: "project_risk",
            entity_id: risk.risk_id,
            description: `Created risk: ${risk.title} for project ${body.project_id}`,
            new_value: risk,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] Risk created", { id: risk.risk_id });
          return c.json({ success: true, risk });
        } catch (error) {
          safeLogger.error("Error creating project risk:", error);
          return c.json({ error: "Failed to create project risk" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/risks/:riskId",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const riskId = c.req.param("riskId");
          logger?.info("📖 [PMP API] Fetching project risk", { riskId });

          const { initTeamTables, getProjectRiskById } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const risk = await getProjectRiskById(riskId);
          if (!risk) {
            return c.json({ error: "Project risk not found" }, 404);
          }

          logger?.info("✅ [PMP API] Risk fetched", { riskId });
          return c.json(risk);
        } catch (error) {
          safeLogger.error("Error fetching project risk:", error);
          return c.json({ error: "Failed to fetch project risk" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/risks/:riskId",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const riskId = c.req.param("riskId");
          const body = await c.req.json();
          logger?.info("✏️ [PMP API] Updating project risk", { riskId });

          const {
            initTeamTables,
            getProjectRiskById,
            updateProjectRisk,
            logAuditEntry,
          } = await import("../../utils/teamDatabase");
          await initTeamTables();

          const oldRisk = await getProjectRiskById(riskId);
          const risk = await updateProjectRisk(riskId, body);
          if (!risk) {
            return c.json({ error: "Project risk not found" }, 404);
          }

          await logAuditEntry({
            action_type: "update",
            module: "project",
            entity_type: "project_risk",
            entity_id: riskId,
            description: `Updated risk: ${risk.title}`,
            old_value: oldRisk,
            new_value: risk,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] Risk updated", { riskId });
          return c.json({ success: true, risk });
        } catch (error) {
          safeLogger.error("Error updating project risk:", error);
          return c.json({ error: "Failed to update project risk" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/risks/:riskId",
    method: "DELETE" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const riskId = c.req.param("riskId");
          logger?.info("🗑️ [PMP API] Deleting project risk", { riskId });

          const {
            initTeamTables,
            getProjectRiskById,
            deleteProjectRisk,
            logAuditEntry,
          } = await import("../../utils/teamDatabase");
          await initTeamTables();

          const oldRisk = await getProjectRiskById(riskId);
          const success = await deleteProjectRisk(riskId);
          if (!success) {
            return c.json({ error: "Project risk not found" }, 404);
          }

          await logAuditEntry({
            action_type: "delete",
            module: "project",
            entity_type: "project_risk",
            entity_id: riskId,
            description: `Deleted risk: ${oldRisk?.title}`,
            old_value: oldRisk,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] Risk deleted", { riskId });
          return c.json({ success: true });
        } catch (error) {
          safeLogger.error("Error deleting project risk:", error);
          return c.json({ error: "Failed to delete project risk" }, 500);
        }
      };
    },
  },

  // ============================================
  // PROJECT MILESTONES ROUTES
  // ============================================
  {
    path: "/api/pmp/milestones",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("🎯 [PMP API] Fetching project milestones");

          const { initTeamTables, listProjectMilestones } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const url = new URL(c.req.url);
          const projectId = url.searchParams.get("project_id") || undefined;
          const status = url.searchParams.get("status") || undefined;
          const milestoneType =
            url.searchParams.get("milestone_type") || undefined;
          const ownerId = url.searchParams.get("owner_id") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");

          const result = await listProjectMilestones({
            projectId,
            status,
            milestoneType,
            ownerId,
            limit,
            offset,
          });
          logger?.info("✅ [PMP API] Milestones fetched", {
            count: result.milestones.length,
          });
          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching project milestones:", error);
          return c.json({ error: "Failed to fetch project milestones" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/milestones",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("➕ [PMP API] Creating project milestone", {
            name: body.name,
          });

          const { initTeamTables, createProjectMilestone, logAuditEntry } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const milestone = await createProjectMilestone(body);

          await logAuditEntry({
            action_type: "create",
            module: "project",
            entity_type: "project_milestone",
            entity_id: milestone.milestone_id,
            description: `Created milestone: ${milestone.name} for project ${body.project_id}`,
            new_value: milestone,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] Milestone created", {
            id: milestone.milestone_id,
          });
          return c.json({ success: true, milestone });
        } catch (error) {
          safeLogger.error("Error creating project milestone:", error);
          return c.json({ error: "Failed to create project milestone" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/milestones/:milestoneId",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const milestoneId = c.req.param("milestoneId");
          logger?.info("📖 [PMP API] Fetching project milestone", {
            milestoneId,
          });

          const { initTeamTables, getProjectMilestoneById } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const milestone = await getProjectMilestoneById(milestoneId);
          if (!milestone) {
            return c.json({ error: "Project milestone not found" }, 404);
          }

          logger?.info("✅ [PMP API] Milestone fetched", { milestoneId });
          return c.json(milestone);
        } catch (error) {
          safeLogger.error("Error fetching project milestone:", error);
          return c.json({ error: "Failed to fetch project milestone" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/milestones/:milestoneId",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const milestoneId = c.req.param("milestoneId");
          const body = await c.req.json();
          logger?.info("✏️ [PMP API] Updating project milestone", {
            milestoneId,
          });

          const {
            initTeamTables,
            getProjectMilestoneById,
            updateProjectMilestone,
            logAuditEntry,
          } = await import("../../utils/teamDatabase");
          await initTeamTables();

          const oldMilestone = await getProjectMilestoneById(milestoneId);
          const milestone = await updateProjectMilestone(milestoneId, body);
          if (!milestone) {
            return c.json({ error: "Project milestone not found" }, 404);
          }

          await logAuditEntry({
            action_type: "update",
            module: "project",
            entity_type: "project_milestone",
            entity_id: milestoneId,
            description: `Updated milestone: ${milestone.name}`,
            old_value: oldMilestone,
            new_value: milestone,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] Milestone updated", { milestoneId });
          return c.json({ success: true, milestone });
        } catch (error) {
          safeLogger.error("Error updating project milestone:", error);
          return c.json({ error: "Failed to update project milestone" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/milestones/:milestoneId",
    method: "DELETE" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const milestoneId = c.req.param("milestoneId");
          logger?.info("🗑️ [PMP API] Deleting project milestone", {
            milestoneId,
          });

          const {
            initTeamTables,
            getProjectMilestoneById,
            deleteProjectMilestone,
            logAuditEntry,
          } = await import("../../utils/teamDatabase");
          await initTeamTables();

          const oldMilestone = await getProjectMilestoneById(milestoneId);
          const success = await deleteProjectMilestone(milestoneId);
          if (!success) {
            return c.json({ error: "Project milestone not found" }, 404);
          }

          await logAuditEntry({
            action_type: "delete",
            module: "project",
            entity_type: "project_milestone",
            entity_id: milestoneId,
            description: `Deleted milestone: ${oldMilestone?.name}`,
            old_value: oldMilestone,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] Milestone deleted", { milestoneId });
          return c.json({ success: true });
        } catch (error) {
          safeLogger.error("Error deleting project milestone:", error);
          return c.json({ error: "Failed to delete project milestone" }, 500);
        }
      };
    },
  },

  // ============================================
  // PROJECT STAKEHOLDERS ROUTES
  // ============================================
  {
    path: "/api/pmp/stakeholders",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("👥 [PMP API] Fetching project stakeholders");

          const { initTeamTables, listProjectStakeholders } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const url = new URL(c.req.url);
          const projectId = url.searchParams.get("project_id") || undefined;
          const stakeholderType =
            url.searchParams.get("stakeholder_type") || undefined;
          const influence = url.searchParams.get("influence") || undefined;
          const quadrant = url.searchParams.get("quadrant") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");

          const result = await listProjectStakeholders({
            projectId,
            stakeholderType,
            influence,
            quadrant,
            limit,
            offset,
          });
          logger?.info("✅ [PMP API] Stakeholders fetched", {
            count: result.stakeholders.length,
          });
          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching project stakeholders:", error);
          return c.json({ error: "Failed to fetch project stakeholders" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/stakeholders",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("➕ [PMP API] Creating project stakeholder", {
            name: body.name,
          });

          const { initTeamTables, createProjectStakeholder, logAuditEntry } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const stakeholder = await createProjectStakeholder(body);

          await logAuditEntry({
            action_type: "create",
            module: "project",
            entity_type: "project_stakeholder",
            entity_id: stakeholder.stakeholder_id,
            description: `Created stakeholder: ${stakeholder.name} for project ${body.project_id}`,
            new_value: stakeholder,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] Stakeholder created", {
            id: stakeholder.stakeholder_id,
          });
          return c.json({ success: true, stakeholder });
        } catch (error) {
          safeLogger.error("Error creating project stakeholder:", error);
          return c.json({ error: "Failed to create project stakeholder" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/stakeholders/:stakeholderId",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const stakeholderId = c.req.param("stakeholderId");
          logger?.info("📖 [PMP API] Fetching project stakeholder", {
            stakeholderId,
          });

          const { initTeamTables, getProjectStakeholderById } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const stakeholder = await getProjectStakeholderById(stakeholderId);
          if (!stakeholder) {
            return c.json({ error: "Project stakeholder not found" }, 404);
          }

          logger?.info("✅ [PMP API] Stakeholder fetched", { stakeholderId });
          return c.json(stakeholder);
        } catch (error) {
          safeLogger.error("Error fetching project stakeholder:", error);
          return c.json({ error: "Failed to fetch project stakeholder" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/stakeholders/:stakeholderId",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const stakeholderId = c.req.param("stakeholderId");
          const body = await c.req.json();
          logger?.info("✏️ [PMP API] Updating project stakeholder", {
            stakeholderId,
          });

          const {
            initTeamTables,
            getProjectStakeholderById,
            updateProjectStakeholder,
            logAuditEntry,
          } = await import("../../utils/teamDatabase");
          await initTeamTables();

          const oldStakeholder = await getProjectStakeholderById(stakeholderId);
          const stakeholder = await updateProjectStakeholder(
            stakeholderId,
            body,
          );
          if (!stakeholder) {
            return c.json({ error: "Project stakeholder not found" }, 404);
          }

          await logAuditEntry({
            action_type: "update",
            module: "project",
            entity_type: "project_stakeholder",
            entity_id: stakeholderId,
            description: `Updated stakeholder: ${stakeholder.name}`,
            old_value: oldStakeholder,
            new_value: stakeholder,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] Stakeholder updated", { stakeholderId });
          return c.json({ success: true, stakeholder });
        } catch (error) {
          safeLogger.error("Error updating project stakeholder:", error);
          return c.json({ error: "Failed to update project stakeholder" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/stakeholders/:stakeholderId",
    method: "DELETE" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const stakeholderId = c.req.param("stakeholderId");
          logger?.info("🗑️ [PMP API] Deleting project stakeholder", {
            stakeholderId,
          });

          const {
            initTeamTables,
            getProjectStakeholderById,
            deleteProjectStakeholder,
            logAuditEntry,
          } = await import("../../utils/teamDatabase");
          await initTeamTables();

          const oldStakeholder = await getProjectStakeholderById(stakeholderId);
          const success = await deleteProjectStakeholder(stakeholderId);
          if (!success) {
            return c.json({ error: "Project stakeholder not found" }, 404);
          }

          await logAuditEntry({
            action_type: "delete",
            module: "project",
            entity_type: "project_stakeholder",
            entity_id: stakeholderId,
            description: `Deleted stakeholder: ${oldStakeholder?.name}`,
            old_value: oldStakeholder,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] Stakeholder deleted", { stakeholderId });
          return c.json({ success: true });
        } catch (error) {
          safeLogger.error("Error deleting project stakeholder:", error);
          return c.json({ error: "Failed to delete project stakeholder" }, 500);
        }
      };
    },
  },

  // ============================================
  // PORTFOLIO ANALYTICS & GANTT
  // ============================================
  {
    path: "/api/pmp/portfolio/analytics",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("📊 [PMP API] Fetching portfolio analytics");

          const { initTeamTables, getProjectPortfolioAnalytics } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const analytics = await getProjectPortfolioAnalytics();
          logger?.info("✅ [PMP API] Portfolio analytics fetched");
          return c.json(analytics);
        } catch (error) {
          safeLogger.error("Error fetching portfolio analytics:", error);
          return c.json({ error: "Failed to fetch portfolio analytics" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/projects/:projectId/gantt",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const projectId = c.req.param("projectId");
          logger?.info("📅 [PMP API] Fetching project Gantt data", {
            projectId,
          });

          const { initTeamTables, getProjectGanttData } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const ganttData = await getProjectGanttData(projectId);
          if (!ganttData.project) {
            return c.json({ error: "Project not found" }, 404);
          }

          logger?.info("✅ [PMP API] Gantt data fetched", { projectId });
          return c.json(ganttData);
        } catch (error) {
          safeLogger.error("Error fetching Gantt data:", error);
          return c.json({ error: "Failed to fetch Gantt data" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/generate-charter",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("🤖 [PMP API] Generating AI project charter", {
            projectName: body.project_name,
          });

          const { createOpenAI } = await import("@ai-sdk/openai");
          const { generateText } = await import("ai");

          const openai = createOpenAI({
            baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
            apiKey:
              process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
              process.env.OPENAI_API_KEY,
          });

          const prompt = `Generate a comprehensive PMP-compliant Project Charter for the following project:

Project Name: ${body.project_name}
Project Type: ${body.project_type || "Quality Improvement"}
Department: ${body.department || "Quality Assurance"}
Description: ${body.description || "No description provided"}
Budget: ${body.budget ? `$${body.budget.toLocaleString()}` : "TBD"}
Duration: ${body.duration_months || "TBD"} months

Please generate a complete project charter in JSON format with the following sections:
{
  "project_purpose": "Clear statement of why this project exists",
  "business_case": "Justification for the project including expected benefits",
  "project_objectives": ["SMART objectives as array"],
  "scope_statement": "What is included and excluded",
  "deliverables": ["List of key deliverables"],
  "assumptions": ["Key assumptions"],
  "constraints": ["Known constraints"],
  "high_level_risks": ["Top 5 risks with brief descriptions"],
  "success_criteria": ["Measurable success criteria"],
  "milestones": [{"name": "Milestone Name", "description": "Brief description", "week": 1}],
  "stakeholder_categories": [{"type": "Type", "role": "Role", "interest": "high/medium/low"}],
  "communication_approach": "Recommended communication strategy",
  "quality_requirements": "Quality standards and acceptance criteria",
  "estimated_budget_breakdown": {"labor": 0, "materials": 0, "contingency": 0},
  "recommended_team_structure": [{"role": "Role Name", "responsibility": "Key responsibility"}]
}

Ensure all content is practical, actionable, and follows PMP best practices.`;

          const { text } = await generateText({
            model: openai("gpt-4o"),
            prompt,
          });

          let charter;
          try {
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            charter = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: text };
          } catch {
            charter = { raw: text };
          }

          logger?.info("✅ [PMP API] AI charter generated");
          return c.json({ success: true, charter });
        } catch (error) {
          safeLogger.error("Error generating charter:", error);
          return c.json({ error: "Failed to generate project charter" }, 500);
        }
      };
    },
  },

  // ============================================
  // PROCUREMENT MANAGEMENT ROUTES
  // ============================================
  {
    path: "/api/pmp/procurement",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("📦 [PMP API] Fetching procurement records");

          const { initTeamTables, listProjectProcurement } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const url = new URL(c.req.url);
          const projectId = url.searchParams.get("project_id") || undefined;
          const status = url.searchParams.get("status") || undefined;
          const procurementType =
            url.searchParams.get("procurement_type") || undefined;
          const vendorName = url.searchParams.get("vendor_name") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");

          const result = await listProjectProcurement({
            projectId,
            status,
            procurementType,
            vendorName,
            limit,
            offset,
          });
          logger?.info("✅ [PMP API] Procurement records fetched", {
            count: result.procurement.length,
          });
          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching procurement:", error);
          return c.json({ error: "Failed to fetch procurement records" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/procurement",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("➕ [PMP API] Creating procurement record", {
            title: body.title,
          });

          const { initTeamTables, createProjectProcurement, logAuditEntry } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const procurement = await createProjectProcurement(body);

          await logAuditEntry({
            action_type: "create",
            module: "project",
            entity_type: "project_procurement",
            entity_id: procurement.procurement_id,
            description: `Created procurement: ${procurement.title} for project ${body.project_id}`,
            new_value: procurement,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] Procurement created", {
            id: procurement.procurement_id,
          });
          return c.json({ success: true, procurement });
        } catch (error) {
          safeLogger.error("Error creating procurement:", error);
          return c.json({ error: "Failed to create procurement record" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/procurement/:procurementId",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const procurementId = c.req.param("procurementId");
          logger?.info("📖 [PMP API] Fetching procurement record", {
            procurementId,
          });

          const { initTeamTables, getProjectProcurementById } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const procurement = await getProjectProcurementById(procurementId);
          if (!procurement) {
            return c.json({ error: "Procurement record not found" }, 404);
          }

          logger?.info("✅ [PMP API] Procurement fetched", { procurementId });
          return c.json(procurement);
        } catch (error) {
          safeLogger.error("Error fetching procurement:", error);
          return c.json({ error: "Failed to fetch procurement record" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/procurement/:procurementId",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const procurementId = c.req.param("procurementId");
          const body = await c.req.json();
          logger?.info("✏️ [PMP API] Updating procurement record", {
            procurementId,
          });

          const {
            initTeamTables,
            getProjectProcurementById,
            updateProjectProcurement,
            logAuditEntry,
          } = await import("../../utils/teamDatabase");
          await initTeamTables();

          const oldProcurement = await getProjectProcurementById(procurementId);
          const procurement = await updateProjectProcurement(
            procurementId,
            body,
          );
          if (!procurement) {
            return c.json({ error: "Procurement record not found" }, 404);
          }

          await logAuditEntry({
            action_type: "update",
            module: "project",
            entity_type: "project_procurement",
            entity_id: procurementId,
            description: `Updated procurement: ${procurement.title}`,
            old_value: oldProcurement,
            new_value: procurement,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] Procurement updated", { procurementId });
          return c.json({ success: true, procurement });
        } catch (error) {
          safeLogger.error("Error updating procurement:", error);
          return c.json({ error: "Failed to update procurement record" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/procurement/:procurementId",
    method: "DELETE" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const procurementId = c.req.param("procurementId");
          logger?.info("🗑️ [PMP API] Deleting procurement record", {
            procurementId,
          });

          const {
            initTeamTables,
            getProjectProcurementById,
            deleteProjectProcurement,
            logAuditEntry,
          } = await import("../../utils/teamDatabase");
          await initTeamTables();

          const oldProcurement = await getProjectProcurementById(procurementId);
          const success = await deleteProjectProcurement(procurementId);
          if (!success) {
            return c.json({ error: "Procurement record not found" }, 404);
          }

          await logAuditEntry({
            action_type: "delete",
            module: "project",
            entity_type: "project_procurement",
            entity_id: procurementId,
            description: `Deleted procurement: ${oldProcurement?.title}`,
            old_value: oldProcurement,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] Procurement deleted", { procurementId });
          return c.json({ success: true });
        } catch (error) {
          safeLogger.error("Error deleting procurement:", error);
          return c.json({ error: "Failed to delete procurement record" }, 500);
        }
      };
    },
  },

  // ============================================
  // CHANGE REQUEST (INTEGRATION) ROUTES
  // ============================================
  {
    path: "/api/pmp/change-requests",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("📝 [PMP API] Fetching change requests");

          const { initTeamTables, listProjectChangeRequests } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const url = new URL(c.req.url);
          const projectId = url.searchParams.get("project_id") || undefined;
          const status = url.searchParams.get("status") || undefined;
          const changeType = url.searchParams.get("change_type") || undefined;
          const priority = url.searchParams.get("priority") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");

          const result = await listProjectChangeRequests({
            projectId,
            status,
            changeType,
            priority,
            limit,
            offset,
          });
          logger?.info("✅ [PMP API] Change requests fetched", {
            count: result.changeRequests.length,
          });
          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching change requests:", error);
          return c.json({ error: "Failed to fetch change requests" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/change-requests",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("➕ [PMP API] Creating change request", {
            title: body.title,
          });

          const { initTeamTables, createProjectChangeRequest, logAuditEntry } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const changeRequest = await createProjectChangeRequest(body);

          await logAuditEntry({
            action_type: "create",
            module: "project",
            entity_type: "project_change_request",
            entity_id: changeRequest.change_request_id,
            description: `Created change request: ${changeRequest.title} for project ${body.project_id}`,
            new_value: changeRequest,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] Change request created", {
            id: changeRequest.change_request_id,
          });
          return c.json({ success: true, changeRequest });
        } catch (error) {
          safeLogger.error("Error creating change request:", error);
          return c.json({ error: "Failed to create change request" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/change-requests/:changeRequestId",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const changeRequestId = c.req.param("changeRequestId");
          logger?.info("📖 [PMP API] Fetching change request", {
            changeRequestId,
          });

          const { initTeamTables, getProjectChangeRequestById } =
            await import("../../utils/teamDatabase");
          await initTeamTables();

          const changeRequest =
            await getProjectChangeRequestById(changeRequestId);
          if (!changeRequest) {
            return c.json({ error: "Change request not found" }, 404);
          }

          logger?.info("✅ [PMP API] Change request fetched", {
            changeRequestId,
          });
          return c.json(changeRequest);
        } catch (error) {
          safeLogger.error("Error fetching change request:", error);
          return c.json({ error: "Failed to fetch change request" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/change-requests/:changeRequestId",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const changeRequestId = c.req.param("changeRequestId");
          const body = await c.req.json();
          logger?.info("✏️ [PMP API] Updating change request", {
            changeRequestId,
          });

          const {
            initTeamTables,
            getProjectChangeRequestById,
            updateProjectChangeRequest,
            logAuditEntry,
          } = await import("../../utils/teamDatabase");
          await initTeamTables();

          const oldChangeRequest =
            await getProjectChangeRequestById(changeRequestId);
          const changeRequest = await updateProjectChangeRequest(
            changeRequestId,
            body,
          );
          if (!changeRequest) {
            return c.json({ error: "Change request not found" }, 404);
          }

          await logAuditEntry({
            action_type: "update",
            module: "project",
            entity_type: "project_change_request",
            entity_id: changeRequestId,
            description: `Updated change request: ${changeRequest.title}`,
            old_value: oldChangeRequest,
            new_value: changeRequest,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] Change request updated", {
            changeRequestId,
          });
          return c.json({ success: true, changeRequest });
        } catch (error) {
          safeLogger.error("Error updating change request:", error);
          return c.json({ error: "Failed to update change request" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pmp/change-requests/:changeRequestId",
    method: "DELETE" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const changeRequestId = c.req.param("changeRequestId");
          logger?.info("🗑️ [PMP API] Deleting change request", {
            changeRequestId,
          });

          const {
            initTeamTables,
            getProjectChangeRequestById,
            deleteProjectChangeRequest,
            logAuditEntry,
          } = await import("../../utils/teamDatabase");
          await initTeamTables();

          const oldChangeRequest =
            await getProjectChangeRequestById(changeRequestId);
          const success = await deleteProjectChangeRequest(changeRequestId);
          if (!success) {
            return c.json({ error: "Change request not found" }, 404);
          }

          await logAuditEntry({
            action_type: "delete",
            module: "project",
            entity_type: "project_change_request",
            entity_id: changeRequestId,
            description: `Deleted change request: ${oldChangeRequest?.title}`,
            old_value: oldChangeRequest,
            ai_involved: false,
          });

          logger?.info("✅ [PMP API] Change request deleted", {
            changeRequestId,
          });
          return c.json({ success: true });
        } catch (error) {
          safeLogger.error("Error deleting change request:", error);
          return c.json({ error: "Failed to delete change request" }, 500);
        }
      };
    },
  },

  // ============================================
  // PROJECTS DASHBOARD PAGE
  // ============================================
  {
    path: "/projects",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        const session = getSessionFromCookie(c.req.header("Cookie"));
        if (!session && !hasValidAdminApiKey(c)) {
          return c.redirect("/login");
        }
        try {
          const { readFileSync, existsSync } = await import("fs");
          const { join } = await import("path");

          const possiblePaths = [
            join(process.cwd(), "dashboard", "projects.html"),
            join(process.cwd(), "..", "dashboard", "projects.html"),
            join(process.cwd(), "..", "..", "dashboard", "projects.html"),
            "/home/runner/workspace/dashboard/projects.html",
          ];

          for (const filePath of possiblePaths) {
            if (existsSync(filePath)) {
              const html = readFileSync(filePath, "utf-8");
              return c.html(html);
            }
          }

          return c.text(
            `Projects dashboard not found. Searched paths: ${possiblePaths.join(", ")}`,
            404,
          );
        } catch (error) {
          safeLogger.error("Error loading Projects dashboard:", error);
          return c.text("Error loading Projects dashboard", 500);
        }
      };
    },
  },
];

export const pmpRoutes = _pmpRoutesRaw.map(pmpGate).map(gateApiRoute);
