import { getSessionFromCookie } from '../mastra/routes/authRoutes';
import { getUserByEmail, checkPermission, type UserRole, type RolePermission } from './rbacDatabase';

export interface SessionUser {
  userId: number;
  email: string;
  name: string;
  role: string;
  picture?: string;
}

const dbRoleCache = new Map<string, { role: string; fetchedAt: number }>();
const DB_ROLE_CACHE_TTL = 60_000;

export async function getVerifiedRole(email: string, tokenRole: string): Promise<string> {
  const cached = dbRoleCache.get(email);
  if (cached && (Date.now() - cached.fetchedAt) < DB_ROLE_CACHE_TTL) {
    return cached.role;
  }
  try {
    const dbUser = await getUserByEmail(email);
    if (dbUser) {
      dbRoleCache.set(email, { role: dbUser.role, fetchedAt: Date.now() });
      return dbUser.role;
    }
  } catch {
  }
  return tokenRole;
}

export function getSessionUser(c: any): SessionUser | null {
  const session = getSessionFromCookie(c.req.header('Cookie'));
  if (session) {
    return {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
      picture: session.picture,
    };
  }
  const adminKeyHeader = c.req.header('X-Admin-Key');
  const expectedKey = process.env.ADMIN_API_KEY;
  if (expectedKey && adminKeyHeader === expectedKey) {
    return {
      userId: 0,
      email: 'admin-key@system',
      name: 'Admin API',
      role: 'admin',
    };
  }
  return null;
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

const WRITE_ROLES: UserRole[] = ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'ai_specialist', 'bu_owner', 'executive'];
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

function getAdminKey(c: any): string | null {
  const headerKey = c.req.header('X-Admin-Key');
  if (headerKey) return headerKey;
  const cookies = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim());
  const adminCookie = cookies.find((s: string) => s.startsWith('admin_key='));
  if (adminCookie) return adminCookie.split('=')[1] || null;
  return null;
}

export function requireAdminOrKey(c: any): SessionUser | null {
  const adminKey = getAdminKey(c);
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
  const adminKey = getAdminKey(c);
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
  { pattern: /^\/api\/risks\/treatment\/\d+$/, methods: ['PUT'], roles: ['admin', 'grc_manager', 'quality_manager'] },
  { pattern: /^\/api\/risks(\/\d+)?$/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager'] },

  { pattern: /^\/api\/policies\/\d+\/transition$/, methods: ['POST'], permission: 'can_approve_policy' },
  { pattern: /^\/api\/policies\/\d+\/grc-approval$/, methods: ['POST'], permission: 'can_approve_policy' },
  { pattern: /^\/api\/policies\/\d+\/publish$/, methods: ['POST'], permission: 'can_approve_policy' },
  { pattern: /^\/api\/policies\/\d+\/set-owners$/, methods: ['POST'], roles: ['admin', 'grc_manager'] },
  { pattern: /^\/api\/policies\/\d+\/acknowledge$/, methods: ['POST'], roles: ['admin', 'grc_manager', 'quality_manager', 'bu_owner'] },
  { pattern: /^\/api\/policies(\/\d+)?$/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager'] },

  { pattern: /^\/api\/audits\/findings(\/\d+)?$/, methods: ['POST', 'PUT'], permission: 'can_close_finding' },
  { pattern: /^\/api\/audits\/evidence-packs$/, methods: ['POST'], permission: 'can_submit_evidence' },
  { pattern: /^\/api\/audits\/\d+\/checklist$/, methods: ['PUT'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager'] },
  { pattern: /^\/api\/audits\/checklist\/\d+$/, methods: ['PUT'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager'] },
  { pattern: /^\/api\/audits(\/\d+)?$/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager'] },

  // Audit Programme (ISO 19011 §5.2). Quality Manager can draft; only
  // Head of Operations & Quality (or admin) can approve via the HITL sign-off.
  { pattern: /^\/api\/audit-programme\/\d+\/submit$/, methods: ['POST'], roles: ['admin', 'head_of_operations_quality', 'quality_manager'] },
  { pattern: /^\/api\/audit-programme\/\d+\/approve$/, methods: ['POST'], roles: ['admin', 'head_of_operations_quality'] },
  { pattern: /^\/api\/audit-programme\/\d+\/reject$/, methods: ['POST'], roles: ['admin', 'head_of_operations_quality'] },
  { pattern: /^\/api\/audit-programme(\/\d+)?$/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'head_of_operations_quality', 'quality_manager'] },

  // Manual Audit Intake (off-platform audits) — Quality Manager is single-point intake.
  { pattern: /^\/api\/manual-audit-intake/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'head_of_operations_quality', 'quality_manager'] },

  // External Audits (regulatory, certification, surveillance) — GRC owns, QM contributes.
  { pattern: /^\/api\/external-audits/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager'] },

  { pattern: /^\/api\/compliance\/controls/, methods: ['POST', 'PUT', 'DELETE'], permission: 'can_edit_controls' },
  { pattern: /^\/api\/compliance\/capa/, methods: ['POST', 'PUT'], permission: 'can_create_capa' },
  { pattern: /^\/api\/compliance/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager'] },

  { pattern: /^\/api\/vendors/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager'] },

  { pattern: /^\/api\/handoff\//, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager'] },

  { pattern: /^\/api\/roi/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager', 'executive'] },

  { pattern: /^\/api\/migration/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin'] },

  { pattern: /^\/api\/users/, methods: ['POST', 'PUT', 'DELETE'], permission: 'can_manage_users' },
  { pattern: /^\/api\/invitations/, methods: ['POST', 'DELETE'], roles: ['admin', 'quality_manager'] },

  { pattern: /^\/api\/rbac/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin'] },

  { pattern: /^\/api\/call-intelligence/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'ai_specialist'] },

  { pattern: /^\/api\/event-logs/, methods: ['DELETE'], roles: ['admin'] },

  { pattern: /^\/api\/audit\/trigger$/, methods: ['POST'], roles: ['admin', 'quality_manager', 'grc_manager', 'team_lead', 'auditor', 'quality_specialist', 'department_viewer', 'ai_specialist', 'bu_owner', 'executive'] },
];

export async function enforceRoutePermission(c: any, path: string, method: string): Promise<{ allowed: boolean; error?: string }> {
  const user = getSessionUser(c);
  if (!user) return { allowed: false, error: 'Authentication required' };

  const verifiedRole = await getVerifiedRole(user.email, user.role);
  user.role = verifiedRole;

  for (const rule of ROUTE_PERMISSION_MAP) {
    if (rule.pattern.test(path) && rule.methods.includes(method)) {
      if (user.role === 'admin') return { allowed: true };
      if (rule.roles && rule.roles.includes(user.role as UserRole)) {
        return { allowed: true };
      }
    }
  }

  if (user.role === 'department_viewer' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return { allowed: false, error: 'Read-only access: write operations not permitted' };
  }

  for (const rule of ROUTE_PERMISSION_MAP) {
    if (rule.pattern.test(path) && rule.methods.includes(method)) {
      if (user.role === 'admin') return { allowed: true };

      if (rule.roles && !rule.roles.includes(user.role as UserRole)) {
        return { allowed: false, error: 'Insufficient permissions for this operation' };
      }

      if (rule.permission) {
        const hasPermission = await checkPermission(user.email, rule.permission);
        if (!hasPermission) {
          return { allowed: false, error: 'Insufficient permissions for this operation' };
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
