import { getSessionFromCookie } from "./authRoutes";

function isQmsAuthorized(c: any): boolean {
  const adminKey = c.req.header("X-Admin-Key") || (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
  const expectedKey = process.env.ADMIN_API_KEY;
  const hasValidAdminKey = !!(expectedKey && adminKey === expectedKey);
  const session = getSessionFromCookie(c.req.header('Cookie'));
  const isAdminRole = session?.role === 'admin';
  return hasValidAdminKey || isAdminRole;
}

export const qmsApiRoutes = [
  {
    path: "/api/qms/dashboard",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isQmsAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const { getQmsDashboardData } = await import("../../utils/qmsDatabase");
          const data = await getQmsDashboardData();
          return c.json(data);
        } catch (error) {
          console.error("Error fetching QMS dashboard:", error);
          return c.json({ error: "Failed to fetch QMS dashboard" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/evaluations",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isQmsAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const { getDealEvaluations } = await import("../../utils/qmsDatabase");
          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");
          const dealId = c.req.query("dealId");
          const minScore = c.req.query("minScore") ? parseFloat(c.req.query("minScore")) : undefined;
          const maxScore = c.req.query("maxScore") ? parseFloat(c.req.query("maxScore")) : undefined;
          const result = await getDealEvaluations({ limit, offset, dealId, minScore, maxScore });
          return c.json(result);
        } catch (error) {
          console.error("Error fetching evaluations:", error);
          return c.json({ error: "Failed to fetch evaluations" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/evaluations/stats",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isQmsAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const { getEvaluationStatistics } = await import("../../utils/qmsDatabase");
          const stats = await getEvaluationStatistics();
          return c.json(stats);
        } catch (error) {
          console.error("Error fetching evaluation stats:", error);
          return c.json({ error: "Failed to fetch evaluation stats" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/capa",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isQmsAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const { getCapaRecords } = await import("../../utils/qmsDatabase");
          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");
          const status = c.req.query("status");
          const severity = c.req.query("severity");
          const assignedTo = c.req.query("assignedTo");
          const result = await getCapaRecords({ limit, offset, status, severity, assignedTo });
          return c.json(result);
        } catch (error) {
          console.error("Error fetching CAPA records:", error);
          return c.json({ error: "Failed to fetch CAPA records" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/capa/:id",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isQmsAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const id = parseInt(c.req.param("id"));
          const { getCapaById, getCapaActionItems } = await import("../../utils/qmsDatabase");
          const capa = await getCapaById(id);
          if (!capa) return c.json({ error: "CAPA not found" }, 404);
          const actionItems = await getCapaActionItems(id);
          return c.json({ capa, actionItems });
        } catch (error) {
          console.error("Error fetching CAPA details:", error);
          return c.json({ error: "Failed to fetch CAPA details" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/capa",
    method: "POST",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isQmsAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const data = await c.req.json();
          const { createCapaRecord } = await import("../../utils/qmsDatabase");
          const capa = await createCapaRecord({ title: data.title, description: data.description, capa_type: data.capaType, source_type: data.sourceType, source_id: data.sourceId, source_reference: data.sourceReference, severity: data.severity, status: 'open', priority: data.priority || 'medium', assigned_to: data.assignedTo, target_date: data.targetDate ? new Date(data.targetDate) : undefined, created_by: data.createdBy || 'Admin' });
          try { const { logEvent } = await import("../../utils/eventLogsDatabase"); await logEvent({ actionType: 'CREATE', entityType: 'CAPA', entityId: String(capa.id), entityName: capa.capa_number, description: `CAPA created: ${capa.title}`, newValue: JSON.stringify(capa), module: 'qms', severity: 'INFO' }); } catch {}
          return c.json(capa);
        } catch (error) {
          console.error("Error creating CAPA:", error);
          return c.json({ error: "Failed to create CAPA" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/nc",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isQmsAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const { getNonconformances } = await import("../../utils/qmsDatabase");
          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");
          const status = c.req.query("status");
          const severity = c.req.query("severity");
          const result = await getNonconformances({ limit, offset, status, severity });
          return c.json(result);
        } catch (error) {
          console.error("Error fetching NC records:", error);
          return c.json({ error: "Failed to fetch NC records" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/nc",
    method: "POST",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isQmsAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const data = await c.req.json();
          const { createNonconformance } = await import("../../utils/qmsDatabase");
          const nc = await createNonconformance({ title: data.title, description: data.description, nc_type: data.ncType, category: data.category, source_type: data.sourceType, source_id: data.sourceId, source_reference: data.sourceReference, severity: data.severity, status: 'open', detected_by: data.detectedBy || 'Admin', criteria_violations: data.criteriaViolations });
          try { const { logEvent } = await import("../../utils/eventLogsDatabase"); await logEvent({ actionType: 'CREATE', entityType: 'CAPA', entityId: String(nc.id), entityName: nc.nc_number, description: `Nonconformance created: ${nc.title}`, newValue: JSON.stringify(nc), module: 'qms', severity: 'INFO' }); } catch {}
          return c.json(nc);
        } catch (error) {
          console.error("Error creating NC:", error);
          return c.json({ error: "Failed to create NC" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/training",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isQmsAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const { getTrainingRecords } = await import("../../utils/qmsDatabase");
          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");
          const trainingType = c.req.query("trainingType");
          const isActive = c.req.query("isActive") === "true" ? true : c.req.query("isActive") === "false" ? false : undefined;
          const result = await getTrainingRecords({ limit, offset, trainingType, isActive });
          return c.json(result);
        } catch (error) {
          console.error("Error fetching training records:", error);
          return c.json({ error: "Failed to fetch training records" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/training/assignments",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isQmsAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const { getTrainingAssignments } = await import("../../utils/qmsDatabase");
          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");
          const employeeId = c.req.query("employeeId");
          const trainingId = c.req.query("trainingId");
          const status = c.req.query("status");
          const result = await getTrainingAssignments({ limit, offset, employeeId, trainingId, status });
          return c.json(result);
        } catch (error) {
          console.error("Error fetching assignments:", error);
          return c.json({ error: "Failed to fetch training assignments" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/framework",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!isQmsAuthorized(c)) return c.json({ error: 'Insufficient permissions' }, 403);
          const { getActiveFramework } = await import("../../utils/qmsDatabase");
          const { getDefaultFramework } = await import("../../utils/evaluationSchema");
          let framework = await getActiveFramework();
          if (!framework) framework = getDefaultFramework();
          return c.json(framework);
        } catch (error) {
          console.error("Error fetching framework:", error);
          return c.json({ error: "Failed to fetch evaluation framework" }, 500);
        }
      };
    },
  },
];
