import pg from 'pg';
const { Pool } = pg;
import { getSessionFromCookie } from '../mastra/routes/authRoutes';
import { getUserByEmail, checkPermission, type UserRole, type RolePermission } from './rbacDatabase';

const platformPool = new Pool({ connectionString: process.env.DATABASE_URL });

export interface SessionUser {
  userId: number;
  email: string;
  name: string;
  role: string;
  picture?: string;
}

const dbRoleCache = new Map<string, { role: string; fetchedAt: number }>();
const DB_ROLE_CACHE_TTL = 60_000;

const platformStatusCache = new Map<string, { status: string; role: string; fetchedAt: number }>();
const PLATFORM_STATUS_CACHE_TTL = 30_000;

export async function getPlatformUser(email: string): Promise<{ status: string; role: string } | null> {
  const cached = platformStatusCache.get(email);
  if (cached && (Date.now() - cached.fetchedAt) < PLATFORM_STATUS_CACHE_TTL) {
    return { status: cached.status, role: cached.role };
  }
  try {
    const result = await platformPool.query(
      'SELECT status, role FROM platform_users WHERE email = $1',
      [email]
    );
    if (result.rows.length > 0) {
      const { status, role } = result.rows[0];
      platformStatusCache.set(email, { status, role, fetchedAt: Date.now() });
      return { status, role };
    }
  } catch {
  }
  return null;
}

export async function checkPlatformUserActive(email: string): Promise<boolean> {
  const user = await getPlatformUser(email);
  if (!user) return false;
  return user.status === 'active';
}

export function invalidatePlatformUserCache(email: string): void {
  platformStatusCache.delete(email);
  dbRoleCache.delete(email);
}

export async function getVerifiedRole(email: string, tokenRole: string): Promise<string> {
  const cached = dbRoleCache.get(email);
  if (cached && (Date.now() - cached.fetchedAt) < DB_ROLE_CACHE_TTL) {
    return cached.role;
  }
  try {
    const platformUser = await getPlatformUser(email);
    if (platformUser) {
      dbRoleCache.set(email, { role: platformUser.role, fetchedAt: Date.now() });
      return platformUser.role;
    }
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

export async function requireRole(c: any, allowedRoles: UserRole[]): Promise<SessionUser | null> {
  const user = getSessionUser(c);
  if (!user) return null;
  if (!hasValidAdminApiKey(c)) {
    const platformUser = await getPlatformUser(user.email);
    if (!platformUser || platformUser.status !== 'active') return null;
    user.role = platformUser.role;
  }
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

export function getAdminKey(c: any): string | null {
  const headerKey = c.req.header('X-Admin-Key');
  if (headerKey) return headerKey;
  const cookies = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim());
  const adminCookie = cookies.find((s: string) => s.startsWith('admin_key='));
  if (adminCookie) return adminCookie.split('=')[1] || null;
  return null;
}

export function hasValidAdminApiKey(c: any): boolean {
  const adminKey = getAdminKey(c);
  const expectedKey = process.env.ADMIN_API_KEY;
  return !!(expectedKey && adminKey === expectedKey);
}

export function isAdminAuthorized(c: any): boolean {
  if (hasValidAdminApiKey(c)) return true;
  const session = getSessionFromCookie(c.req.header('Cookie'));
  return session?.role === 'admin';
}

export async function requireAdminOrKey(c: any): Promise<SessionUser | null> {
  if (hasValidAdminApiKey(c)) {
    return { userId: 0, email: 'api-key@system', name: 'API Key Access', role: 'admin' };
  }
  const user = getSessionUser(c);
  if (!user) return null;
  const platformUser = await getPlatformUser(user.email);
  if (!platformUser || platformUser.status !== 'active') return null;
  if (platformUser.role !== 'admin') return null;
  user.role = platformUser.role;
  return user;
}

export async function requireRoleOrKey(c: any, allowedRoles: UserRole[]): Promise<SessionUser | null> {
  if (hasValidAdminApiKey(c)) {
    return { userId: 0, email: 'api-key@system', name: 'API Key Access', role: 'admin' };
  }
  return requireRole(c, allowedRoles);
}

export function requireAuthOrKey(c: any): SessionUser | null {
  if (hasValidAdminApiKey(c)) {
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
  // Event logs — admin-only read (cross-module audit trail with PII and sensitive diffs)
  { pattern: /^\/api\/logs/, methods: ['GET'], roles: ['admin'] },
  { pattern: /^\/api\/event-logs/, methods: ['GET'], roles: ['admin'] },

  { pattern: /^\/api\/risks\/\d+\/close$/, methods: ['POST'], permission: 'can_close_finding' },
  { pattern: /^\/api\/risks\/\d+\/accept$/, methods: ['POST'], permission: 'can_accept_risk' },
  { pattern: /^\/api\/risks\/\d+\/escalate$/, methods: ['POST'], permission: 'can_accept_risk' },
  { pattern: /^\/api\/risks\/\d+\/treatment$/, methods: ['POST'], roles: ['admin', 'grc_manager', 'quality_manager'] },
  { pattern: /^\/api\/risks\/treatment\/\d+$/, methods: ['PUT'], roles: ['admin', 'grc_manager', 'quality_manager'] },
  { pattern: /^\/api\/risks(\/\d+)?$/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager'] },
  // Risk register reads — governance roles and senior leadership only
  { pattern: /^\/api\/risks/, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'executive'] },

  { pattern: /^\/api\/policies\/\d+\/transition$/, methods: ['POST'], permission: 'can_approve_policy' },
  { pattern: /^\/api\/policies\/\d+\/grc-approval$/, methods: ['POST'], permission: 'can_approve_policy' },
  { pattern: /^\/api\/policies\/\d+\/publish$/, methods: ['POST'], permission: 'can_approve_policy' },
  { pattern: /^\/api\/policies\/\d+\/set-owners$/, methods: ['POST'], roles: ['admin', 'grc_manager'] },
  { pattern: /^\/api\/policies\/\d+\/acknowledge$/, methods: ['POST'], roles: ['admin', 'grc_manager', 'quality_manager', 'bu_owner'] },
  { pattern: /^\/api\/policies\/\d+\/upload$/, methods: ['POST'], roles: ['admin', 'grc_manager', 'quality_manager'] },
  { pattern: /^\/api\/policies\/review-cycles\/\d+$/, methods: ['PUT'], roles: ['admin', 'grc_manager', 'quality_manager'] },
  { pattern: /^\/api\/policies(\/\d+)?$/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager'] },

  { pattern: /^\/api\/audits\/findings(\/\d+)?$/, methods: ['POST', 'PUT'], permission: 'can_close_finding' },
  { pattern: /^\/api\/audits\/evidence-packs$/, methods: ['POST'], permission: 'can_submit_evidence' },
  { pattern: /^\/api\/audits\/\d+\/checklist$/, methods: ['PUT'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager'] },
  { pattern: /^\/api\/audits\/checklist\/\d+$/, methods: ['PUT'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager'] },
  { pattern: /^\/api\/audits(\/\d+)?$/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager'] },
  // Audit reads — governance roles and senior leadership only
  { pattern: /^\/api\/audits/, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'executive'] },

  // Audit Programme (ISO 19011 §5.2). Quality Manager can draft; only
  // Head of Operations & Quality (or admin) can approve via the HITL sign-off.
  { pattern: /^\/api\/audit-programme\/\d+\/submit$/, methods: ['POST'], roles: ['admin', 'head_of_operations_quality', 'quality_manager'] },
  { pattern: /^\/api\/audit-programme\/\d+\/approve$/, methods: ['POST'], roles: ['admin', 'head_of_operations_quality'] },
  { pattern: /^\/api\/audit-programme\/\d+\/reject$/, methods: ['POST'], roles: ['admin', 'head_of_operations_quality'] },
  { pattern: /^\/api\/audit-programme(\/\d+)?$/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'head_of_operations_quality', 'quality_manager'] },
  // Audit programme reads — governance roles and senior leadership only
  { pattern: /^\/api\/audit-programme/, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'executive'] },

  // Manual Audit Intake (off-platform audits) — Quality Manager is single-point intake.
  { pattern: /^\/api\/manual-audit-intake/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'head_of_operations_quality', 'quality_manager'] },

  // External Audits (regulatory, certification, surveillance) — GRC owns, QM contributes.
  { pattern: /^\/api\/external-audits/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager'] },

  { pattern: /^\/api\/compliance\/controls/, methods: ['POST', 'PUT', 'DELETE'], permission: 'can_edit_controls' },
  { pattern: /^\/api\/compliance\/capa/, methods: ['POST', 'PUT'], permission: 'can_create_capa' },
  { pattern: /^\/api\/compliance/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager'] },
  // Compliance reads — governance roles and senior leadership only
  { pattern: /^\/api\/compliance/, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'executive'] },

  { pattern: /^\/api\/vendors/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager'] },
  // Vendor reads — governance roles only (contract values, assessment findings, PII)
  { pattern: /^\/api\/vendors/, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager'] },

  // Management reviews — senior governance records (minutes, decisions, action items)
  { pattern: /^\/api\/management-reviews/, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'executive'] },
  { pattern: /^\/api\/management-reviews/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager'] },

  // GRC aggregated reports — governance roles and senior leadership only; department_viewer excluded
  { pattern: /^\/api\/reports\/capa-effectiveness$/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },
  { pattern: /^\/api\/reports\/compliance-posture$/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },

  // PDPL reports — admin-only (privacy inventory, incident history, security posture)
  { pattern: /^\/api\/reports\/pdpl-inventory/, methods: ['GET'], roles: ['admin'] },

  { pattern: /^\/api\/handoff\//, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager'] },

  { pattern: /^\/api\/roi/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'grc_manager', 'quality_manager', 'executive'] },

  { pattern: /^\/api\/migration/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin'] },

  { pattern: /^\/api\/users/, methods: ['POST', 'PUT', 'DELETE'], permission: 'can_manage_users' },
  { pattern: /^\/api\/invitations/, methods: ['POST', 'DELETE'], roles: ['admin', 'quality_manager'] },

  { pattern: /^\/api\/rbac/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin'] },

  { pattern: /^\/api\/call-intelligence/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'ai_specialist'] },

  { pattern: /^\/api\/event-logs/, methods: ['DELETE'], roles: ['admin'] },

  { pattern: /^\/api\/audit\/trigger$/, methods: ['POST'], roles: ['admin', 'quality_manager', 'grc_manager', 'team_lead', 'auditor', 'quality_specialist', 'department_viewer', 'ai_specialist', 'bu_owner', 'executive'] },

  { pattern: /^\/api\/team\//, methods: ['POST', 'PUT', 'PATCH', 'DELETE'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager'] },
  { pattern: /^\/api\/team$/, methods: ['POST', 'PUT', 'PATCH', 'DELETE'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager'] },
  { pattern: /^\/api\/audit-trail/, methods: ['POST', 'PUT', 'PATCH', 'DELETE'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager'] },

  { pattern: /^\/api\/onboarding\/stats$/, methods: ['GET'], roles: ['admin', 'head_of_operations_quality'] },
  { pattern: /^\/api\/onboarding\/demo-links$/, methods: ['GET'], roles: ['admin', 'head_of_operations_quality'] },
  { pattern: /^\/api\/onboarding\/demo-link/, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], roles: ['admin', 'head_of_operations_quality'] },

  // Trigger workflow actions: only reviewer-capable roles may action triggers.
  // The handler additionally verifies that the caller's role matches the
  // trigger's assigned_role (or is an admin-level role).
  { pattern: /^\/api\/triggers\/\d+\/action$/, methods: ['POST'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'team_lead', 'executive', 'bu_owner', 'ai_specialist'] },

  // Notification read: only reviewer-capable roles may mark notifications read.
  // The handler additionally verifies the notification belongs to the caller's role.
  { pattern: /^\/api\/notifications\/\d+\/read$/, methods: ['POST'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'team_lead', 'executive', 'bu_owner', 'ai_specialist'] },

  { pattern: /^\/api\/consultant\/chat(\/stream)?$/, methods: ['POST'], roles: ['admin', 'ai_specialist', 'grc_manager', 'head_of_operations_quality'] },
  { pattern: /^\/api\/consultant\/scan$/, methods: ['POST'], roles: ['admin', 'ai_specialist', 'grc_manager', 'head_of_operations_quality'] },
  { pattern: /^\/api\/consultant\/alerts\/\d+\/(acknowledge|resolve|dismiss)$/, methods: ['POST'], roles: ['admin', 'ai_specialist', 'grc_manager', 'head_of_operations_quality'] },

  { pattern: /^\/api\/knowledge\/upload$/, methods: ['POST'], roles: ['admin', 'ai_specialist', 'grc_manager'] },
  { pattern: /^\/api\/knowledge\/documents\/\d+$/, methods: ['DELETE'], roles: ['admin', 'grc_manager'] },

  // Sensitive GET read restrictions — enforce role boundaries on reads that expose CRM,
  // call intelligence, and governance data. department_viewer and custom roles are excluded.
  { pattern: /^\/api\/duplicates/, methods: ['GET'], roles: ['admin', 'grc_manager', 'ai_specialist', 'head_of_operations_quality', 'quality_manager', 'bu_owner', 'executive'] },
  { pattern: /^\/api\/policies/, methods: ['GET'], roles: ['admin', 'grc_manager', 'quality_manager', 'head_of_operations_quality', 'bu_owner', 'executive', 'quality_specialist', 'auditor', 'team_lead', 'ai_specialist'] },
  { pattern: /^\/api\/calls/, methods: ['GET'], roles: ['admin', 'ai_specialist', 'head_of_operations_quality', 'quality_manager', 'team_lead', 'grc_manager'] },

  // ─────────────────────────────────────────────────────────────────────────
  // KPI / Executive reporting / Scorecard / Analytics / Health-pulse /
  // Infographic — sensitive aggregated governance metrics. Locked to the
  // governance/executive role set; department_viewer and other low-privilege
  // roles are blocked.
  // ─────────────────────────────────────────────────────────────────────────

  // Admin-only KPI seeders (write fixture data into the platform).
  { pattern: /^\/api\/kpis\/seed-(mohammed|sdr)$/, methods: ['POST'], roles: ['admin'] },
  // KPI value entry — governance write roles only.
  { pattern: /^\/api\/kpis\/\d+\/values$/, methods: ['POST'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality'] },
  // KPI definition writes (create / update / delete) — governance write roles only.
  { pattern: /^\/api\/kpis(\/\d+)?$/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality'] },
  // KPI reads (definitions, summary, individual KPI, history) — governance roles + executive.
  { pattern: /^\/api\/kpis(\/(\d+(\/history)?|summary))?$/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },

  // Executive reports (MBR/QBR documents) and MBR data feed — governance + executive.
  { pattern: /^\/api\/executive\/reports(\/\d+)?$/, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality'] },
  { pattern: /^\/api\/executive\/reports(\/\d+)?$/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },
  { pattern: /^\/api\/executive\/mbr-data$/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },

  // Analytics — cycle times, agent compliance, CAPA recurrence, trends, executive digest.
  // Digest send (emails leadership) is restricted to admin + Head of Operations & Quality.
  { pattern: /^\/api\/analytics\/executive-digest\/send$/, methods: ['POST'], roles: ['admin', 'head_of_operations_quality'] },
  { pattern: /^\/api\/analytics\//, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },

  // Platform Health Pulse — admin only (operational diagnostics, secret presence,
  // dependency health, latency).  POST /run triggers an actual probe sweep.
  { pattern: /^\/api\/health\/pulse(\/(latest|run))?$/, methods: ['GET', 'POST'], roles: ['admin'] },

  // Scorecard — Mohammed-style governance scorecard (raw KPI calculations).
  // Snapshot save = governance write; reads = governance + executive.
  { pattern: /^\/api\/scorecard\/snapshot$/, methods: ['POST'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality'] },
  { pattern: /^\/api\/scorecard\//, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },

  // Infographics — governance-only renders.  Share-out (Slack / email) distributes
  // sensitive aggregated data externally and is restricted to governance write roles.
  { pattern: /^\/api\/infographic\/[^/]+\/share\/(slack|email)$/, methods: ['POST'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality'] },
  { pattern: /^\/api\/infographic(\/.+)?$/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },
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

/**
 * Pure permission-map lookup — no DB calls, no session parsing.
 * Used by unit tests to assert that the ROUTE_PERMISSION_MAP is correctly
 * configured for a given (role, path, method) triple.
 */
export function canAccessRoute(role: string, path: string, method: string): boolean {
  if (role === 'admin') return true;
  for (const rule of ROUTE_PERMISSION_MAP) {
    if (rule.pattern.test(path) && rule.methods.includes(method)) {
      if (rule.roles && !rule.roles.includes(role as UserRole)) {
        return false;
      }
      if (rule.roles && rule.roles.includes(role as UserRole)) {
        return true;
      }
    }
  }
  return true;
}
