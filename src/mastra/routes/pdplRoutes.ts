import { requireAdminOrKey, requireAuthOrKey, unauthorizedResponse } from '../../utils/rbacMiddleware';

export const pdplRoutes = [
  {
    path: "/api/pdpl/status",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = requireAuthOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info("🔒 [PDPL API] Fetching compliance status");

          const { initPdplTables, getPdplComplianceStatus } = await import("../../utils/pdplDatabase");
          await initPdplTables();

          const status = await getPdplComplianceStatus();
          logger?.info("🔒 [PDPL API] Compliance score:", status.complianceScore);
          
          return c.json({ success: true, ...status });
        } catch (error: any) {
          console.error("Error fetching PDPL status:", error);
          return c.json({ success: false, error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/pdpl/inventory",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = requireAuthOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info("🔒 [PDPL API] Fetching data inventory");

          const { initPdplTables, getDataInventory } = await import("../../utils/pdplDatabase");
          await initPdplTables();

          const module = c.req.query("module");
          const category = c.req.query("category");
          
          const inventory = await getDataInventory({ module, category });
          return c.json({ success: true, inventory, count: inventory.length });
        } catch (error: any) {
          console.error("Error fetching data inventory:", error);
          return c.json({ success: false, error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/pdpl/inventory",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("🔒 [PDPL API] Adding data inventory item:", body.field_name);

          const { initPdplTables, addDataInventoryItem } = await import("../../utils/pdplDatabase");
          await initPdplTables();

          const userEmail = body.userEmail || 'system@walaplus.com';
          const item = await addDataInventoryItem(body, userEmail);
          return c.json({ success: true, item });
        } catch (error: any) {
          console.error("Error adding data inventory item:", error);
          return c.json({ success: false, error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/pdpl/inventory/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          logger?.info("🔒 [PDPL API] Updating data inventory item:", id);

          const { initPdplTables, updateDataInventoryItem } = await import("../../utils/pdplDatabase");
          await initPdplTables();

          const userEmail = body.userEmail || 'system@walaplus.com';
          const item = await updateDataInventoryItem(id, body, userEmail);
          
          if (!item) {
            return c.json({ success: false, error: "Item not found" }, 404);
          }
          return c.json({ success: true, item });
        } catch (error: any) {
          console.error("Error updating data inventory item:", error);
          return c.json({ success: false, error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/pdpl/dsar",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = requireAuthOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info("🔒 [PDPL API] Fetching DSAR requests");

          const { initPdplTables, getDSARRequests } = await import("../../utils/pdplDatabase");
          await initPdplTables();

          const status = c.req.query("status");
          const type = c.req.query("type");
          
          const requests = await getDSARRequests({ status, type });
          return c.json({ success: true, requests, count: requests.length });
        } catch (error: any) {
          console.error("Error fetching DSAR requests:", error);
          return c.json({ success: false, error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/pdpl/dsar",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("🔒 [PDPL API] Creating DSAR request:", body.request_type);

          const { initPdplTables, createDSARRequest } = await import("../../utils/pdplDatabase");
          await initPdplTables();

          const userEmail = body.userEmail || 'system@walaplus.com';
          const request = await createDSARRequest(body, userEmail);
          return c.json({ success: true, request });
        } catch (error: any) {
          console.error("Error creating DSAR request:", error);
          return c.json({ success: false, error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/pdpl/dsar/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          logger?.info("🔒 [PDPL API] Updating DSAR request:", id);

          const { initPdplTables, updateDSARRequest } = await import("../../utils/pdplDatabase");
          await initPdplTables();

          const userEmail = body.userEmail || 'system@walaplus.com';
          const request = await updateDSARRequest(id, body, userEmail);
          
          if (!request) {
            return c.json({ success: false, error: "Request not found" }, 404);
          }
          return c.json({ success: true, request });
        } catch (error: any) {
          console.error("Error updating DSAR request:", error);
          return c.json({ success: false, error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/pdpl/retention",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = requireAuthOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info("🔒 [PDPL API] Fetching retention policies");

          const { initPdplTables, getRetentionPolicies } = await import("../../utils/pdplDatabase");
          await initPdplTables();

          const policies = await getRetentionPolicies();
          return c.json({ success: true, policies, count: policies.length });
        } catch (error: any) {
          console.error("Error fetching retention policies:", error);
          return c.json({ success: false, error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/pdpl/retention/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          logger?.info("🔒 [PDPL API] Updating retention policy:", id);

          const { initPdplTables, updateRetentionPolicy } = await import("../../utils/pdplDatabase");
          await initPdplTables();

          const userEmail = body.userEmail || 'system@walaplus.com';
          const policy = await updateRetentionPolicy(id, body, userEmail);
          
          if (!policy) {
            return c.json({ success: false, error: "Policy not found" }, 404);
          }
          return c.json({ success: true, policy });
        } catch (error: any) {
          console.error("Error updating retention policy:", error);
          return c.json({ success: false, error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/pdpl/incidents",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = requireAuthOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info("🔒 [PDPL API] Fetching data incidents");

          const { initPdplTables, getDataIncidents } = await import("../../utils/pdplDatabase");
          await initPdplTables();

          const status = c.req.query("status");
          const severity = c.req.query("severity");
          
          const incidents = await getDataIncidents({ status, severity });
          return c.json({ success: true, incidents, count: incidents.length });
        } catch (error: any) {
          console.error("Error fetching data incidents:", error);
          return c.json({ success: false, error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/pdpl/incidents",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("🔒 [PDPL API] Creating data incident:", body.title);

          const { initPdplTables, createDataIncident } = await import("../../utils/pdplDatabase");
          await initPdplTables();

          const userEmail = body.userEmail || 'system@walaplus.com';
          const incident = await createDataIncident(body, userEmail);
          return c.json({ success: true, incident });
        } catch (error: any) {
          console.error("Error creating data incident:", error);
          return c.json({ success: false, error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/pdpl/incidents/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          logger?.info("🔒 [PDPL API] Updating data incident:", id);

          const { initPdplTables, updateDataIncident } = await import("../../utils/pdplDatabase");
          await initPdplTables();

          const userEmail = body.userEmail || 'system@walaplus.com';
          const incident = await updateDataIncident(id, body, userEmail);
          
          if (!incident) {
            return c.json({ success: false, error: "Incident not found" }, 404);
          }
          return c.json({ success: true, incident });
        } catch (error: any) {
          console.error("Error updating data incident:", error);
          return c.json({ success: false, error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/pdpl/guardrails",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = requireAuthOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info("🔒 [PDPL API] Fetching AI guardrails");

          const { initPdplTables, getAIGuardrails } = await import("../../utils/pdplDatabase");
          await initPdplTables();

          const guardrails = await getAIGuardrails();
          return c.json({ success: true, guardrails, count: guardrails.length });
        } catch (error: any) {
          console.error("Error fetching AI guardrails:", error);
          return c.json({ success: false, error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/pdpl/guardrails",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("🔒 [PDPL API] Adding AI guardrail:", body.field_name);

          const { initPdplTables, addAIGuardrail } = await import("../../utils/pdplDatabase");
          await initPdplTables();

          const userEmail = body.userEmail || 'system@walaplus.com';
          const guardrail = await addAIGuardrail(body, userEmail);
          return c.json({ success: true, guardrail });
        } catch (error: any) {
          console.error("Error adding AI guardrail:", error);
          return c.json({ success: false, error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/pdpl/mask",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info("🔒 [PDPL API] Masking PII for AI");

          const { initPdplTables, getAIGuardrails, maskPIIForAI } = await import("../../utils/pdplDatabase");
          await initPdplTables();

          const guardrails = await getAIGuardrails();
          const result = maskPIIForAI(body.text || '', guardrails);
          
          logger?.info(`🔒 [PDPL API] Masked ${result.maskedCount} PII items`);
          return c.json({ success: true, ...result });
        } catch (error: any) {
          console.error("Error masking PII:", error);
          return c.json({ success: false, error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/pdpl/audit-log",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = requireAuthOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info("🔒 [PDPL API] Fetching PDPL audit log");

          const { initPdplTables, getPdplAuditLog } = await import("../../utils/pdplDatabase");
          await initPdplTables();

          const limit = parseInt(c.req.query("limit") || "100");
          const logs = await getPdplAuditLog(limit);
          return c.json({ success: true, logs, count: logs.length });
        } catch (error: any) {
          console.error("Error fetching PDPL audit log:", error);
          return c.json({ success: false, error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
];
