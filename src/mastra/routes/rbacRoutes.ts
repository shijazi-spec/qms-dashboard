import * as rbacDb from '../../utils/rbacDatabase';
import { requireAdminOrKey, unauthorizedResponse } from '../../utils/rbacMiddleware';

export const rbacRoutes = [
  {
    path: "/api/rbac/users",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { initRbacTables } = await import('../../utils/rbacDatabase');
          await initRbacTables();
          
          const url = new URL(c.req.url);
          const role = url.searchParams.get('role') as rbacDb.UserRole | undefined;
          const department = url.searchParams.get('department') || undefined;
          const active_only = url.searchParams.get('active_only') === 'true';

          logger?.info('👤 [RBAC API] GET /api/rbac/users', { role, department });
          const users = await rbacDb.getSystemUsers({ role, department, active_only });
          return c.json({ users, total: users.length });
        } catch (error: any) {
          console.error('❌ [RBAC API] Error fetching users:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    }
  },
  {
    path: "/api/rbac/users/:email",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const email = c.req.param('email');
          logger?.info('👤 [RBAC API] GET /api/rbac/users/:email', { email });
          
          const user = await rbacDb.getUserByEmail(email);
          if (!user) {
            return c.json({ error: 'User not found' }, 404);
          }
          return c.json(user);
        } catch (error: any) {
          console.error('❌ [RBAC API] Error fetching user:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    }
  },
  {
    path: "/api/rbac/users",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info('👤 [RBAC API] POST /api/rbac/users', { email: body.email });
          
          const user = await rbacDb.createSystemUser(body);
          return c.json(user, 201);
        } catch (error: any) {
          console.error('❌ [RBAC API] Error creating user:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    }
  },
  {
    path: "/api/rbac/users/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param('id'));
          const body = await c.req.json();
          logger?.info('👤 [RBAC API] PUT /api/rbac/users/:id', { id });
          
          const user = await rbacDb.updateSystemUser(id, body);
          return c.json(user);
        } catch (error: any) {
          console.error('❌ [RBAC API] Error updating user:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    }
  },
  {
    path: "/api/rbac/permissions/:role",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const role = c.req.param('role') as rbacDb.UserRole;
          logger?.info('🔐 [RBAC API] GET /api/rbac/permissions/:role', { role });
          
          const permissions = await rbacDb.getRolePermissions(role);
          if (!permissions) {
            return c.json({ error: 'Role not found' }, 404);
          }
          return c.json(permissions);
        } catch (error: any) {
          console.error('❌ [RBAC API] Error fetching permissions:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    }
  },
  {
    path: "/api/rbac/check-permission",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { email, permission } = await c.req.json();
          logger?.info('🔐 [RBAC API] POST /api/rbac/check-permission', { email, permission });
          
          if (!email || !permission) {
            return c.json({ error: 'Email and permission are required' }, 400);
          }
          const hasPermission = await rbacDb.checkPermission(email, permission);
          return c.json({ email, permission, hasPermission });
        } catch (error: any) {
          console.error('❌ [RBAC API] Error checking permission:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    }
  },
  {
    path: "/api/rbac/bu-processes",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const url = new URL(c.req.url);
          const department = url.searchParams.get('department') || undefined;
          const active_only = url.searchParams.get('active_only') === 'true';

          logger?.info('📋 [RBAC API] GET /api/rbac/bu-processes', { department });
          const processes = await rbacDb.getBuProcesses({ department, active_only });
          return c.json({ processes, total: processes.length });
        } catch (error: any) {
          console.error('❌ [RBAC API] Error fetching BU processes:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    }
  },
  {
    path: "/api/rbac/bu-processes",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const body = await c.req.json();
          logger?.info('📋 [RBAC API] POST /api/rbac/bu-processes', { code: body.process_code });
          
          const process = await rbacDb.createBuProcess(body);
          return c.json(process, 201);
        } catch (error: any) {
          console.error('❌ [RBAC API] Error creating BU process:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    }
  },
  {
    path: "/api/rbac/bu-processes/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param('id'));
          const body = await c.req.json();
          logger?.info('📋 [RBAC API] PUT /api/rbac/bu-processes/:id', { id });
          
          const process = await rbacDb.updateBuProcess(id, body);
          return c.json(process);
        } catch (error: any) {
          console.error('❌ [RBAC API] Error updating BU process:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    }
  },
  {
    path: "/api/rbac/calculate-control-readiness",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info('📊 [RBAC API] POST /api/rbac/calculate-control-readiness');
          
          const stats = await rbacDb.calculateControlReadiness();
          return c.json({ success: true, ...stats });
        } catch (error: any) {
          console.error('❌ [RBAC API] Error calculating control readiness:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    }
  },
  {
    path: "/api/rbac/escalate-overdue",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info('⚠️ [RBAC API] POST /api/rbac/escalate-overdue');
          
          const result = await rbacDb.escalateOverdueActions();
          return c.json({ success: true, ...result });
        } catch (error: any) {
          console.error('❌ [RBAC API] Error escalating overdue actions:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    }
  },
  {
    path: "/api/rbac/escalations",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const url = new URL(c.req.url);
          const status = url.searchParams.get('status') || undefined;
          const source_type = url.searchParams.get('source_type') || undefined;

          logger?.info('⚠️ [RBAC API] GET /api/rbac/escalations', { status, source_type });
          const escalations = await rbacDb.getEscalationLog({ status, source_type });
          return c.json({ escalations, total: escalations.length });
        } catch (error: any) {
          console.error('❌ [RBAC API] Error fetching escalations:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    }
  },
  {
    path: "/api/rbac/escalations/:id/resolve",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param('id'));
          const { resolved_by, notes } = await c.req.json();
          logger?.info('⚠️ [RBAC API] PUT /api/rbac/escalations/:id/resolve', { id });
          
          await rbacDb.resolveEscalation(id, resolved_by, notes);
          return c.json({ success: true });
        } catch (error: any) {
          console.error('❌ [RBAC API] Error resolving escalation:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    }
  },
  {
    path: "/api/rbac/roles",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await requireAdminOrKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info('🔐 [RBAC API] GET /api/rbac/roles');
          
          const roles = [
            { id: 'quality_manager', name: 'Quality Manager', description: 'Creates/edits CAPA, audits, findings, training' },
            { id: 'grc_manager', name: 'GRC Manager', description: 'Accepts risks, approves policies, compliance sign-off' },
            { id: 'ai_specialist', name: 'AI Specialist', description: 'View dashboards, configure AI settings (no approvals)' },
            { id: 'bu_owner', name: 'BU Owner', description: 'Submit evidence, update action status' },
            { id: 'executive', name: 'Executive', description: 'Read-only strategic views' },
            { id: 'admin', name: 'Admin', description: 'Full system access' },
          ];
          return c.json({ roles });
        } catch (error: any) {
          console.error('❌ [RBAC API] Error fetching roles:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    }
  }
];
