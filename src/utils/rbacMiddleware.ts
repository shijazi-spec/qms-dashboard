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
  if (adminCookie) return adminCookie.slice(adminCookie.indexOf('=') + 1) || null;
  return null;
}

export function hasValidAdminApiKey(c: any): boolean {
  const adminKey = getAdminKey(c);
  const expectedKey = process.env.ADMIN_API_KEY;
  return !!(expectedKey && adminKey === expectedKey);
}

/**
 * Returns true when an ADMIN_API_KEY environment value is configured for
 * this deployment. This is a *platform-configuration* check — it tells you
 * whether admin operations are wired up at all. It does NOT verify that
 * the current caller is an admin (use `isAdminAuthorized` or
 * `requireAdminOrKey` for that).
 *
 * Intended use: gating static page handlers (e.g. `/users`, `/qms`) that
 * render dashboards whose backing APIs perform their own per-route RBAC.
 * The page should only be shown once the platform has been configured;
 * the API layer is the source of truth for "may this user actually see
 * this data?".
 */
export function isAdminKeyConfigured(): boolean {
  return !!process.env.ADMIN_API_KEY;
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

/**
 * Wraps a route definition's `createHandler` with a per-handler
 * `requireAuthOrKey` gate so unauthenticated callers always receive a 401
 * — even when the global middleware in `src/mastra/middleware/index.ts`
 * is not in front of the handler (e.g. when the handler is invoked
 * directly from an integration test via tests/_helpers/fakeContext.ts).
 *
 * Routes whose path does not start with `/api/` are returned untouched —
 * static page handlers (`/projects`, `/onboarding`, etc.) fall through
 * to the page-auth middleware which redirects to `/login` rather than
 * returning a JSON 401.
 *
 * Inner role checks (e.g. `requireAdminOrKey` on XLSX export endpoints)
 * still execute for authenticated callers, so admin-only routes remain
 * admin-only.
 */
export function gateApiRoute<T extends { path: string; createHandler: (deps: any) => any | Promise<any> }>(route: T): T {
  if (!route.path.startsWith('/api/')) return route;
  const originalCreate = route.createHandler;
  return {
    ...route,
    createHandler: async (deps: any) => {
      const inner = await originalCreate(deps);
      return async (c: any) => {
        if (!requireAuthOrKey(c)) return unauthorizedResponse(c);
        return inner(c);
      };
    },
  };
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
  // Compliance export endpoints carry the same governance-write restriction as
  // other QMS exports — executive may not download raw compliance export data.
  { pattern: /^\/api\/compliance\/export/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality'] },
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

  { pattern: /^\/api\/audit\/trigger$/, methods: ['POST'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'team_lead', 'auditor', 'quality_specialist', 'ai_specialist', 'bu_owner', 'executive'] },

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

  // ─────────────────────────────────────────────────────────────────────────
  // PMP (Project Management Portfolio) — project, risk, milestone, stakeholder,
  // procurement, and change-request data.  BU owners participate in
  // project governance for their own business unit.
  // AI charter generation additionally requires ai_specialist access.
  // ─────────────────────────────────────────────────────────────────────────
  { pattern: /^\/api\/pmp\/generate-charter$/, methods: ['POST'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'ai_specialist', 'bu_owner'] },
  { pattern: /^\/api\/pmp\//, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'bu_owner'] },
  { pattern: /^\/api\/pmp\//, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'executive', 'bu_owner'] },

  // ─────────────────────────────────────────────────────────────────────────
  // TableF (Department COPC KPI scorecard) — department-level performance
  // KPIs, actuals, snapshots, and user assignments.
  // BU owners may read their department data; only quality/governance roles
  // may write.
  // ─────────────────────────────────────────────────────────────────────────
  { pattern: /^\/api\/tablef\//, methods: ['POST', 'PUT', 'DELETE'], roles: ['admin', 'head_of_operations_quality', 'quality_manager', 'grc_manager'] },
  { pattern: /^\/api\/tablef\//, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'quality_manager', 'grc_manager', 'executive', 'bu_owner'] },

  // ─────────────────────────────────────────────────────────────────────────
  // AI Approvals (HITL governance queue) — pending, detail, approve, reject.
  // The handler enforces per-user row filtering and segregation of duties;
  // ROUTE_PERMISSION_MAP prevents department_viewer reaching the handler at
  // all.  Approve is restricted to governance write roles; reject is broader
  // to allow requesters to cancel their own draft (handler enforces SoD).
  // ─────────────────────────────────────────────────────────────────────────
  { pattern: /^\/api\/ai\/approvals\/[^/]+\/approve$/, methods: ['POST'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality'] },
  { pattern: /^\/api\/ai\/approvals\/[^/]+\/reject$/, methods: ['POST'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'ai_specialist', 'bu_owner', 'executive', 'quality_specialist', 'auditor', 'team_lead'] },
  { pattern: /^\/api\/ai\/approvals/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'ai_specialist', 'bu_owner', 'executive', 'quality_specialist', 'auditor', 'team_lead'] },

  // ─────────────────────────────────────────────────────────────────────────
  // QMS Enhanced — evidence records, QMS exports, NC/CAPA closure approvals.
  // PDPL export exposes the full PII data inventory — admin only.
  // QMS NC/CAPA CSV/XLSX exports stream large sensitive datasets — governance
  // write roles only.  Evidence records are ISO 9001 §7.5 audit evidence;
  // auditors and quality specialists may read and attach, but only governance
  // roles may delete (to protect audit-trail integrity).
  // ─────────────────────────────────────────────────────────────────────────
  { pattern: /^\/api\/pdpl\/export/, methods: ['GET'], roles: ['admin'] },
  { pattern: /^\/api\/qms\/nc\/export/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality'] },
  { pattern: /^\/api\/qms\/capa-export-xlsx/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality'] },
  { pattern: /^\/api\/qms\/capa\/export/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality'] },
  { pattern: /^\/api\/kpis\/export/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },
  { pattern: /^\/api\/qms\/(nc|capa)\/bulk-update$/, methods: ['POST'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality'] },
  { pattern: /^\/api\/qms\/(nc|capa)\/[^/]+\/history$/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality'] },
  { pattern: /^\/api\/qms\/nc\/\d+\/approve-closure$/, methods: ['POST'], roles: ['admin', 'quality_manager', 'head_of_operations_quality'] },
  { pattern: /^\/api\/qms\/capa\/\d+\/(approve-closure|effectiveness)$/, methods: ['POST'], roles: ['admin', 'quality_manager', 'head_of_operations_quality'] },
  { pattern: /^\/api\/qms\/capa\/\d+$/, methods: ['PATCH'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'auditor'] },
  { pattern: /^\/api\/evidence-pack$/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'auditor', 'quality_specialist'] },
  { pattern: /^\/api\/evidence-summary$/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'auditor', 'quality_specialist'] },
  { pattern: /^\/api\/evidence\/\w/, methods: ['DELETE'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality'] },
  { pattern: /^\/api\/evidence/, methods: ['GET', 'POST'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'auditor', 'quality_specialist', 'team_lead', 'bu_owner', 'ai_specialist', 'executive'] },

  // ─────────────────────────────────────────────────────────────────────────
  // Dashboard & audit — quality KPIs, audit history, scorecard, governance
  // document, CRM data, and agent performance.  All are governance-read
  // (admin / quality managers / GRC / head-of-ops / executive).  Write
  // operations (audit trigger, CRM enrich) require governance-write.
  // /api/inngest is an internal Inngest webhook and is excluded from RBAC
  // (Inngest itself validates the signing key).
  // ─────────────────────────────────────────────────────────────────────────
  { pattern: /^\/api\/audit\//, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },
  { pattern: /^\/api\/dashboard\//, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },
  { pattern: /^\/api\/dashboard$/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },
  { pattern: /^\/api\/scorecards$/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },
  { pattern: /^\/api\/scorecard$/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },
  { pattern: /^\/api\/governance$/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },
  { pattern: /^\/api\/crm\/enrich$/, methods: ['POST'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality'] },
  { pattern: /^\/api\/crm\/data$/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },
  { pattern: /^\/api\/agents\/performance$/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },
  { pattern: /^\/api\/integrations\/status$/, methods: ['GET'], roles: ['admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality', 'executive'] },

  // ─────────────────────────────────────────────────────────────────────────
  // Task #352 — explicit ROUTE_PERMISSION_MAP entries for every currently-
  // live `/api/*` route that previously relied on the permissive
  // `return { allowed: true }` fallback.  Added before the fallback was
  // flipped to deny-by-default so existing access patterns are preserved.
  //
  // Role-list selection rules:
  //   * Mirror the inner-handler role check when one exists (e.g.
  //     `requireRole(c, AI_OPS_ROLES)`).
  //   * For handlers whose only auth gate is `requireAuthOrKey` /
  //     `getSessionUser` (any authenticated caller), use ANY_AUTH so the
  //     current "any logged-in user" behaviour is preserved.  The
  //     department_viewer write-block earlier in `enforceRoutePermission`
  //     still keeps writes locked down for that role.
  // ─────────────────────────────────────────────────────────────────────────

  // Admin-only operational diagnostics (activity feed/stats, system events,
  // workflow run history) — `isAdminAuthorized` in `adminApiRoutes.ts`.
  { pattern: /^\/api\/activity\//, methods: ['GET'], roles: ['admin'] },
  { pattern: /^\/api\/system\//, methods: ['GET'], roles: ['admin'] },
  { pattern: /^\/api\/workflow\/runs(\/\d+)?$/, methods: ['GET'], roles: ['admin'] },

  // AI Ops — agent observability, prompt versions, tool-health alerts/config.
  // Tool-health-config writes are admin-only (TOOL_HEALTH_CONFIG_WRITE_ROLES).
  // All other endpoints use AI_OPS_ROLES.
  { pattern: /^\/api\/ai-ops\/tool-health-config$/, methods: ['PUT'], roles: ['admin'] },
  { pattern: /^\/api\/ai-ops\//, methods: ['GET', 'POST', 'PUT', 'PATCH'], roles: ['admin', 'ai_specialist', 'grc_manager', 'head_of_operations_quality'] },

  // Audit checklist POST (PUT already covered above).
  { pattern: /^\/api\/audits\/\d+\/checklist$/, methods: ['POST'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager'] },

  // Call Intelligence writes — admin-only via `verifyAdminKey`
  // (calls/ingest, /analyze, /compliance POST, /upload, /upload-audio,
  // /bulk-upload, /five9/*, /:id/evaluate, /:id/sdr-evaluate, /:id/sync-zoho,
  // meetings/mom POST, quality-scorecards POST/PUT).
  { pattern: /^\/api\/calls\/(ingest|upload|upload-audio|bulk-upload)$/, methods: ['POST'], roles: ['admin'] },
  { pattern: /^\/api\/calls\/five9\//, methods: ['POST'], roles: ['admin'] },
  { pattern: /^\/api\/calls\/[^/]+\/(analyze|compliance|sync-zoho|evaluate|sdr-evaluate)$/, methods: ['POST'], roles: ['admin'] },
  { pattern: /^\/api\/meetings\/mom$/, methods: ['POST'], roles: ['admin'] },
  { pattern: /^\/api\/quality-scorecards(\/\d+)?$/, methods: ['POST', 'PUT'], roles: ['admin'] },

  // Call Intelligence reads with no inner role gate — any authenticated user.
  { pattern: /^\/api\/meetings\/mom\//, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'quality_specialist', 'team_lead', 'bu_owner', 'ai_specialist', 'executive', 'department_viewer'] },
  { pattern: /^\/api\/sdr-scorecards\//, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'quality_specialist', 'team_lead', 'bu_owner', 'ai_specialist', 'executive', 'department_viewer'] },
  { pattern: /^\/api\/ai-training\//, methods: ['GET', 'POST'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'quality_specialist', 'team_lead', 'bu_owner', 'ai_specialist', 'executive', 'department_viewer'] },
  { pattern: /^\/api\/quality-scorecards$/, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'quality_specialist', 'team_lead', 'bu_owner', 'ai_specialist', 'executive', 'department_viewer'] },

  // Consultant — alerts/feedback (CONSULTANT_ROLES; stats/trend = AI insiders).
  { pattern: /^\/api\/consultant\/alerts(\/count)?$/, methods: ['GET'], roles: ['admin', 'ai_specialist', 'grc_manager', 'head_of_operations_quality'] },
  { pattern: /^\/api\/consultant\/feedback$/, methods: ['POST'], roles: ['admin', 'ai_specialist', 'grc_manager', 'head_of_operations_quality'] },
  { pattern: /^\/api\/consultant\/feedback\/(stats|trend)$/, methods: ['GET'], roles: ['admin', 'ai_specialist'] },
  { pattern: /^\/api\/consultant\/scan-stream$/, methods: ['GET'], roles: ['admin', 'ai_specialist', 'grc_manager', 'head_of_operations_quality'] },

  // Duplicate Radar writes — DUPLICATE_RADAR_READ_ROLES (single gate covers
  // every action; see `requireDuplicateRadarAccess` in duplicateRadarRoutes).
  { pattern: /^\/api\/duplicates\//, methods: ['POST', 'PATCH', 'DELETE'], roles: ['admin', 'grc_manager', 'ai_specialist', 'head_of_operations_quality', 'quality_manager', 'bu_owner', 'executive'] },

  // External Audit reads — handler uses `getSessionUser` only (any auth).
  { pattern: /^\/api\/external-audits/, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'quality_specialist', 'team_lead', 'bu_owner', 'ai_specialist', 'executive', 'department_viewer'] },

  // Feedback API — no inner role gate (any auth).
  { pattern: /^\/api\/feedback(\/stats)?$/, methods: ['GET', 'POST'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'quality_specialist', 'team_lead', 'bu_owner', 'ai_specialist', 'executive', 'department_viewer'] },

  // Handoff GET endpoints — handlers use `getSessionUser` (any auth);
  // writes are already covered by the `/api/handoff/` POST/PUT/DELETE rule.
  { pattern: /^\/api\/handoff\//, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'quality_specialist', 'team_lead', 'bu_owner', 'ai_specialist', 'executive', 'department_viewer'] },

  // Knowledge reads — KNOWLEDGE_READ_ROLES (already covered: upload write,
  // delete).  Checklists have no inner role gate (any auth).
  { pattern: /^\/api\/knowledge\/(documents|search)/, methods: ['GET'], roles: ['admin', 'ai_specialist', 'grc_manager', 'head_of_operations_quality', 'quality_manager'] },
  { pattern: /^\/api\/checklists(\/.*)?$/, methods: ['GET', 'POST'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'quality_specialist', 'team_lead', 'bu_owner', 'ai_specialist', 'executive', 'department_viewer'] },

  // Manual Audit Intake reads — handler uses `getSessionUser` only.
  { pattern: /^\/api\/manual-audit-intake/, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'quality_specialist', 'team_lead', 'bu_owner', 'ai_specialist', 'executive', 'department_viewer'] },

  // Migration GETs — admin only (writes already admin via existing rule).
  { pattern: /^\/api\/migration\//, methods: ['GET'], roles: ['admin'] },

  // Notifications — handlers have no inner role check (any auth).
  // Specific /:id/read POST is covered by an existing reviewer-roles rule.
  { pattern: /^\/api\/notifications(\/count)?$/, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'quality_specialist', 'team_lead', 'bu_owner', 'ai_specialist', 'executive', 'department_viewer'] },
  { pattern: /^\/api\/notifications\/\d+\/dismiss$/, methods: ['POST'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'quality_specialist', 'team_lead', 'bu_owner', 'ai_specialist', 'executive'] },

  // Onboarding status / tour / tooltips — `requireAuthOrKey` (any auth).
  { pattern: /^\/api\/onboarding\/(status|tour-steps|tooltips)$/, methods: ['GET', 'POST'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'quality_specialist', 'team_lead', 'bu_owner', 'ai_specialist', 'executive', 'department_viewer'] },
  { pattern: /^\/api\/onboarding\/tooltip\//, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'quality_specialist', 'team_lead', 'bu_owner', 'ai_specialist', 'executive', 'department_viewer'] },

  // PDPL — `requireAdminOrKey` for every endpoint (admin only).
  // /api/pdpl/export is already covered above for GET; this catches the rest.
  { pattern: /^\/api\/pdpl\//, methods: ['GET', 'POST', 'PUT', 'DELETE'], roles: ['admin'] },

  // Policies — link & review-cycles writes (governance roles).
  { pattern: /^\/api\/policies\/\d+\/link$/, methods: ['POST'], roles: ['admin', 'grc_manager', 'quality_manager'] },
  { pattern: /^\/api\/policies\/review-cycles$/, methods: ['POST'], roles: ['admin', 'grc_manager', 'quality_manager'] },

  // QMS API (qmsApiRoutes.ts) — every endpoint gated by `isAdminAuthorized`
  // (admin user OR X-Admin-Key).
  { pattern: /^\/api\/qms\/(dashboard|evaluations|capa|nc|training|framework)/, methods: ['GET', 'POST'], roles: ['admin'] },

  // RBAC GET endpoints — admin only (writes already covered).
  { pattern: /^\/api\/rbac\//, methods: ['GET'], roles: ['admin'] },

  // ROI reads — handlers use `getSessionUser` (any auth); writes covered.
  { pattern: /^\/api\/roi(\/.*)?$/, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'quality_specialist', 'team_lead', 'bu_owner', 'ai_specialist', 'executive', 'department_viewer'] },

  // Sandbox API — every endpoint uses `requireSandboxAuth` (any auth).
  { pattern: /^\/api\/sandbox\//, methods: ['GET', 'POST'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'quality_specialist', 'team_lead', 'bu_owner', 'ai_specialist', 'executive', 'department_viewer'] },

  // Team management reads & audit-trail — TEAM_MGMT_ROLES.
  { pattern: /^\/api\/team\//, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager'] },
  { pattern: /^\/api\/audit-trail$/, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager'] },

  // Trigger reads (list / stats / by-audit) — TRIGGER_REVIEWER_ROLES.
  { pattern: /^\/api\/triggers/, methods: ['GET'], roles: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'auditor', 'team_lead', 'executive', 'bu_owner', 'ai_specialist'] },

  // User access reads — fine-grained (admin-only diagnostics; admin+QM list).
  // Order matters: more specific patterns must precede the broad
  // `/api/users(/...)?$ GET` rule below.
  { pattern: /^\/api\/users\/stats$/, methods: ['GET'], roles: ['admin'] },
  { pattern: /^\/api\/users\/\d+$/, methods: ['GET'], roles: ['admin'] },
  { pattern: /^\/api\/users$/, methods: ['GET'], roles: ['admin', 'quality_manager'] },
  { pattern: /^\/api\/invitations$/, methods: ['GET'], roles: ['admin'] },
  { pattern: /^\/api\/access-audit/, methods: ['GET'], roles: ['admin'] },
  { pattern: /^\/api\/screens$/, methods: ['GET'], roles: ['admin'] },
  { pattern: /^\/api\/roles\/defaults$/, methods: ['GET'], roles: ['admin'] },
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

  // Task #352 — deny-by-default for `/api/*` paths.  Routes that fall through
  // every ROUTE_PERMISSION_MAP entry above are denied so that newly-added
  // `/api/*` endpoints are fail-closed until an explicit map rule covers them.
  // Non-API paths (page handlers under `/projects`, `/onboarding`, etc.) keep
  // the previous permissive default and rely on the page-auth middleware.
  if (path.startsWith('/api/')) {
    return { allowed: false, error: 'Route not authorised by RBAC policy' };
  }

  return { allowed: true };
}

/**
 * Pure permission-map lookup — no DB calls, no session parsing.
 * Used by unit tests to assert that the ROUTE_PERMISSION_MAP is correctly
 * configured for a given (role, path, method) triple.
 */
export function canAccessRoute(role: string, path: string, method: string): boolean {
  // Task #352 — admin bypass only fires when a ROUTE_PERMISSION_MAP rule
  // matches.  Mirrors `enforceRoutePermission`, where the admin shortcut
  // lives inside the rule-match loop, so an unmatched `/api/*` path is
  // denied for every role (including admin) by the deny-by-default
  // fallback below.
  for (const rule of ROUTE_PERMISSION_MAP) {
    if (rule.pattern.test(path) && rule.methods.includes(method)) {
      if (role === 'admin') return true;
      if (rule.roles && !rule.roles.includes(role as UserRole)) {
        return false;
      }
      if (rule.roles && rule.roles.includes(role as UserRole)) {
        return true;
      }
    }
  }
  // Task #352 — deny-by-default for `/api/*` paths.  Mirrors the runtime
  // `enforceRoutePermission` fallback so unit tests catch any newly-added
  // `/api/*` endpoint that lacks an explicit ROUTE_PERMISSION_MAP entry.
  if (path.startsWith('/api/')) {
    return false;
  }
  return true;
}
