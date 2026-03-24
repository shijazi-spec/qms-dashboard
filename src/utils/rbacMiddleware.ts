import { getSessionFromCookie } from '../mastra/routes/authRoutes';
import { getUserByEmail, checkPermission, type UserRole, type RolePermission } from './rbacDatabase';

export interface SessionUser {
  userId: number;
  email: string;
  name: string;
  role: string;
  picture?: string;
}

export function getSessionUser(c: any): SessionUser | null {
  const session = getSessionFromCookie(c.req.header('Cookie'));
  if (!session) return null;
  return {
    userId: session.userId,
    email: session.email,
    name: session.name,
    role: session.role,
    picture: session.picture,
  };
}

export function requireAuth(c: any): SessionUser | null {
  const user = getSessionUser(c);
  if (!user) return null;
  return user;
}

export function requireRole(c: any, allowedRoles: UserRole[]): SessionUser | null {
  const user = getSessionUser(c);
  if (!user) return null;
  if (!allowedRoles.includes(user.role as UserRole)) return null;
  return user;
}

export async function requirePermission(
  c: any,
  permission: keyof RolePermission
): Promise<SessionUser | null> {
  const user = getSessionUser(c);
  if (!user) return null;
  const hasPermission = await checkPermission(user.email, permission);
  if (!hasPermission) return null;
  return user;
}

export function unauthorizedResponse(c: any) {
  return c.json({ error: 'Authentication required' }, 401);
}

export function forbiddenResponse(c: any, detail?: string) {
  return c.json({ error: detail || 'Insufficient permissions' }, 403);
}

const WRITE_ROLES: UserRole[] = ['admin', 'grc_manager', 'quality_manager', 'ai_specialist', 'bu_owner', 'executive'];
const READ_ONLY_ROLES: UserRole[] = ['department_viewer'];

export function requireWriteRole(c: any): SessionUser | null {
  const user = getSessionUser(c);
  if (!user) return null;
  if (READ_ONLY_ROLES.includes(user.role as UserRole)) return null;
  if (!WRITE_ROLES.includes(user.role as UserRole)) return null;
  return user;
}

export function isDepartmentViewer(c: any): boolean {
  const user = getSessionUser(c);
  return user?.role === 'department_viewer';
}

export function requireAdminOrKey(c: any): SessionUser | null {
  const adminKey = c.req.header('X-Admin-Key');
  const expectedKey = process.env.ADMIN_API_KEY;
  if (expectedKey && adminKey === expectedKey) {
    return { userId: 0, email: 'api-key@system', name: 'API Key Access', role: 'admin' };
  }
  const user = getSessionUser(c);
  if (!user) return null;
  if (user.role !== 'admin') return null;
  return user;
}

export function requireAuthOrKey(c: any): SessionUser | null {
  const adminKey = c.req.header('X-Admin-Key');
  const expectedKey = process.env.ADMIN_API_KEY;
  if (expectedKey && adminKey === expectedKey) {
    return { userId: 0, email: 'api-key@system', name: 'API Key Access', role: 'admin' };
  }
  return getSessionUser(c);
}

type PermissionKey = keyof RolePermission;

interface RoutePermissionRule {
  pattern: RegExp;
  methods: string[];
  permission?: PermissionKey;
  roles?: UserRole[];
}

const ROUTE_PERMISSION_MAP: RoutePermissionRule[] = [
  { pattern: /^\/api\/risks\/\d+\/close$/, methods: ['POST'], permission: 'can_close_finding' },
  { pattern: /^\/api\/risks\/\d+\/accept$/, methods: ['POST'], permission: 'can_accept_risk' },
  { pattern: /^\/api\/risks\/\d+\/escalate$/, methods: ['POST'], permission: 'can_accept_risk' },
  { pattern: /^\/api\/risks\/\d+\/treatment$/, methods: ['POST'], roles: ['admin', 'grc_manager', 'quality_manager'] },
  { pattern: /^\/api\/risks(\/\d+)?$/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager'] },

  { pattern: /^\/api\/policies\/\d+\/transition$/, methods: ['POST'], permission: 'can_approve_policy' },
  { pattern: /^\/api\/policies(\/\d+)?$/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager'] },

  { pattern: /^\/api\/audits\/\d+\/findings/, methods: ['POST', 'PUT'], permission: 'can_close_finding' },
  { pattern: /^\/api\/audits\/\d+\/evidence/, methods: ['POST'], permission: 'can_submit_evidence' },
  { pattern: /^\/api\/audits(\/\d+)?$/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager'] },

  { pattern: /^\/api\/compliance\/controls/, methods: ['POST', 'PUT', 'DELETE'], permission: 'can_edit_controls' },
  { pattern: /^\/api\/compliance\/capa/, methods: ['POST', 'PUT'], permission: 'can_create_capa' },
  { pattern: /^\/api\/compliance/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager'] },

  { pattern: /^\/api\/vendors/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager'] },

  { pattern: /^\/api\/handoffs/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager'] },

  { pattern: /^\/api\/roi/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager', 'executive'] },

  { pattern: /^\/api\/migration/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin'] },

  { pattern: /^\/api\/users/, methods: ['POST', 'PUT', 'DELETE'], permission: 'can_manage_users' },
  { pattern: /^\/api\/invitations/, methods: ['POST', 'DELETE'], roles: ['admin', 'quality_manager'] },

  { pattern: /^\/api\/rbac/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin'] },

  { pattern: /^\/api\/call-intelligence/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'ai_specialist'] },

  { pattern: /^\/api\/event-logs/, methods: ['DELETE'], roles: ['admin'] },
];

export async function enforceRoutePermission(c: any, path: string, method: string): Promise<{ allowed: boolean; error?: string }> {
  const user = getSessionUser(c);
  if (!user) return { allowed: false, error: 'Authentication required' };

  if (user.role === 'department_viewer' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return { allowed: false, error: 'Read-only access: write operations not permitted' };
  }

  for (const rule of ROUTE_PERMISSION_MAP) {
    if (rule.pattern.test(path) && rule.methods.includes(method)) {
      if (user.role === 'admin') return { allowed: true };

      if (rule.roles && !rule.roles.includes(user.role as UserRole)) {
        return { allowed: false, error: `Role '${user.role}' is not authorized for this operation` };
      }

      if (rule.permission) {
        const hasPermission = await checkPermission(user.email, rule.permission);
        if (!hasPermission) {
          return { allowed: false, error: `Permission '${rule.permission}' required` };
        }
      }

      return { allowed: true };
    }
  }

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (!WRITE_ROLES.includes(user.role as UserRole)) {
      return { allowed: false, error: 'Insufficient role for write operations' };
    }
  }

  return { allowed: true };
}
