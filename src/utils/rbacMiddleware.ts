import pg from "pg";
const { Pool } = pg;
import { getSessionFromCookie } from "../mastra/routes/authRoutes";
import {
  getUserByEmail,
  checkPermission,
  type UserRole,
  type RolePermission,
} from "./rbacDatabase";

import { logger } from "./logger";

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

const platformStatusCache = new Map<
  string,
  { status: string; role: string; fetchedAt: number }
>();
const PLATFORM_STATUS_CACHE_TTL = 30_000;

export async function getPlatformUser(
  email: string,
): Promise<{ status: string; role: string } | null> {
  const cached = platformStatusCache.get(email);
  if (cached && Date.now() - cached.fetchedAt < PLATFORM_STATUS_CACHE_TTL) {
    return { status: cached.status, role: cached.role };
  }
  try {
    const result = await platformPool.query(
      "SELECT status, role FROM platform_users WHERE email = $1",
      [email],
    );
    if (result.rows.length > 0) {
      const { status, role } = result.rows[0];
      platformStatusCache.set(email, { status, role, fetchedAt: Date.now() });
      return { status, role };
    }
  } catch {}
  return null;
}

export async function checkPlatformUserActive(email: string): Promise<boolean> {
  const user = await getPlatformUser(email);
  if (!user) return false;
  return user.status === "active";
}

export function invalidatePlatformUserCache(email: string): void {
  platformStatusCache.delete(email);
  dbRoleCache.delete(email);
}

export async function getVerifiedRole(
  email: string,
  tokenRole: string,
): Promise<string> {
  const cached = dbRoleCache.get(email);
  if (cached && Date.now() - cached.fetchedAt < DB_ROLE_CACHE_TTL) {
    return cached.role;
  }
  try {
    const platformUser = await getPlatformUser(email);
    if (platformUser) {
      dbRoleCache.set(email, {
        role: platformUser.role,
        fetchedAt: Date.now(),
      });
      return platformUser.role;
    }
    const dbUser = await getUserByEmail(email);
    if (dbUser) {
      dbRoleCache.set(email, { role: dbUser.role, fetchedAt: Date.now() });
      return dbUser.role;
    }
  } catch {}
  return tokenRole;
}

export function getSessionUser(c: any): SessionUser | null {
  const session = getSessionFromCookie(c.req.header("Cookie"));
  if (session) {
    return {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
      picture: session.picture,
    };
  }
  // The X-Admin-Key header is intentionally NOT accepted here.  It is a
  // server-to-server credential scoped to /api/admin/* routes and to route
  // handlers that explicitly call requireAdminOrKey().  Synthesising an admin
  // identity from the key here would grant it universal access to every
  // application route that calls getSessionUser(), which violates the intended
  // trust boundary.  Browser/application routes require a real OIDC session.
  return null;
}

export function requireAuth(c: any): SessionUser | null {
  const user = getSessionUser(c);
  if (!user) return null;
  return user;
}

export async function requireRole(
  c: any,
  allowedRoles: UserRole[],
): Promise<SessionUser | null> {
  const user = getSessionUser(c);
  if (!user) return null;
  // Always verify the live platform role from the DB — the cookie role is not
  // trusted for access control decisions (a role demotion must take effect
  // on the next request even if the cookie is still valid).
  const platformUser = await getPlatformUser(user.email);
  if (!platformUser || platformUser.status !== "active") return null;
  user.role = platformUser.role;
  if (!allowedRoles.includes(user.role as UserRole)) return null;
  return user;
}

export async function requirePermission(
  c: any,
  permission: keyof RolePermission,
): Promise<SessionUser | null> {
  const user = getSessionUser(c);
  if (!user) return null;
  const hasPermission = await checkPermission(user.email, permission);
  if (!hasPermission) return null;
  return user;
}

export function unauthorizedResponse(c: any) {
  return c.json({ error: "Authentication required" }, 401);
}

export function forbiddenResponse(c: any, detail?: string) {
  return c.json({ error: detail || "Insufficient permissions" }, 403);
}

const WRITE_ROLES: UserRole[] = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
  "ai_specialist",
  "bu_owner",
  "executive",
];
const READ_ONLY_ROLES: UserRole[] = ["department_viewer"];

export function requireWriteRole(c: any): SessionUser | null {
  const user = getSessionUser(c);
  if (!user) return null;
  if (READ_ONLY_ROLES.includes(user.role as UserRole)) return null;
  if (!WRITE_ROLES.includes(user.role as UserRole)) return null;
  return user;
}

export function isDepartmentViewer(c: any): boolean {
  const user = getSessionUser(c);
  return user?.role === "department_viewer";
}

/**
 * Returns the raw ADMIN_API_KEY presented via the X-Admin-Key request header,
 * or null if the header is absent.  This covers server-to-server / CLI calls
 * (curl, internal tooling) where the caller has legitimate access to the raw
 * secret.
 *
 * Browser sessions are NOT accepted here.  The raw admin-key browser cookie
 * path was removed in Task #831: browsers must authenticate through the OIDC
 * login flow and be assigned the `admin` platform role.
 */
export function getAdminKey(c: any): string | null {
  return c.req.header("X-Admin-Key") ?? null;
}

/**
 * Returns true when the caller presents a valid raw ADMIN_API_KEY via the
 * X-Admin-Key request header.  This covers only the server-to-server / CLI
 * trust path (curl, internal automation, Inngest, monitoring tools).
 *
 * Browser sessions are NOT accepted here: browsers must authenticate through
 * the OIDC login flow and be assigned the `admin` platform role. The browser
 * admin-key cookie path has been removed because a global shared secret must
 * not be convertible into a reusable, device-independent browser session.
 */
export function hasValidAdminApiKey(c: any): boolean {
  const expectedKey = process.env.ADMIN_API_KEY;
  if (!expectedKey) return false;
  const headerKey = getAdminKey(c);
  return !!(headerKey && headerKey === expectedKey);
}

/**
 * Minimum acceptable length for ADMIN_API_KEY. Matches the rotation runbook
 * in `docs/Security_Operations_SOP.md` §5.7, which prescribes
 * `openssl rand -hex 32` (64 hex chars / 256 bits of entropy). We allow any
 * key ≥ 32 characters so non-hex generators (base64url, urandom-derived
 * tokens) are still acceptable as long as they carry a comparable length.
 */
export const ADMIN_API_KEY_MIN_LENGTH = 32;

/**
 * Minimum number of distinct characters in ADMIN_API_KEY. A high-entropy
 * 64-hex string typically uses all 16 hex symbols, so a 10-distinct-char
 * floor catches obviously degenerate values like "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
 * or "passwordpasswordpasswordpassword" without rejecting reasonable random
 * tokens.
 */
export const ADMIN_API_KEY_MIN_DISTINCT_CHARS = 10;

export interface AdminApiKeyValidation {
  ok: boolean;
  reasons: string[];
  length: number;
  distinctChars: number;
}

/**
 * Validate the strength of a candidate ADMIN_API_KEY value.
 *
 * Returns `{ ok: true }` only if the key is non-empty, ≥ ADMIN_API_KEY_MIN_LENGTH
 * characters long, and contains ≥ ADMIN_API_KEY_MIN_DISTINCT_CHARS distinct
 * characters. Otherwise returns `{ ok: false }` along with one human-readable
 * reason per failed criterion (so operators see every problem at once, not
 * just the first one).
 *
 * Used at startup by `assertAdminApiKeyStrengthOrThrow()` in `src/mastra/index.ts`
 * to refuse to boot when a weak rotation value would otherwise quietly weaken
 * `/api/admin/*` authentication.
 */
export function validateAdminApiKeyStrength(
  key: string | undefined | null,
): AdminApiKeyValidation {
  const reasons: string[] = [];
  if (!key) {
    return {
      ok: false,
      reasons: ["ADMIN_API_KEY is not set"],
      length: 0,
      distinctChars: 0,
    };
  }
  const length = key.length;
  const distinctChars = new Set(key).size;
  if (length < ADMIN_API_KEY_MIN_LENGTH) {
    reasons.push(
      `ADMIN_API_KEY length is ${length}; require at least ${ADMIN_API_KEY_MIN_LENGTH} characters`,
    );
  }
  if (distinctChars < ADMIN_API_KEY_MIN_DISTINCT_CHARS) {
    reasons.push(
      `ADMIN_API_KEY has ${distinctChars} distinct character${distinctChars === 1 ? "" : "s"}; require at least ${ADMIN_API_KEY_MIN_DISTINCT_CHARS}`,
    );
  }
  return { ok: reasons.length === 0, reasons, length, distinctChars };
}

/**
 * Startup gate for ADMIN_API_KEY. Behaviour:
 *
 *   - If ADMIN_API_KEY is unset, returns silently. The dashboard's
 *     "Setup Required" pages already handle the unconfigured-platform case
 *     (`isAdminKeyConfigured()` above), and refusing to boot in that mode
 *     would break first-run onboarding.
 *
 *   - If ADMIN_API_KEY is set but fails `validateAdminApiKeyStrength`, this
 *     logs every failed criterion and throws, aborting bootstrap *before*
 *     `new Mastra({...})` registers any `/api/admin/*` route. A weak key can
 *     therefore never serve a single request — the process exits instead.
 *
 * The thrown error message references §5.7 of `docs/Security_Operations_SOP.md`
 * so on-call engineers see the rotation runbook in the crash log.
 */
export function assertAdminApiKeyStrengthOrThrow(): void {
  const key = process.env.ADMIN_API_KEY;
  if (!key) return;
  const result = validateAdminApiKeyStrength(key);
  if (result.ok) return;
  logger.error(
    "🛑 [Bootstrap] ADMIN_API_KEY failed strength check; refusing to start.",
  );
  for (const reason of result.reasons) {
    logger.error(`  - ${reason}`);
  }
  logger.error(
    `Required: length ≥ ${ADMIN_API_KEY_MIN_LENGTH}, distinct chars ≥ ${ADMIN_API_KEY_MIN_DISTINCT_CHARS}. ` +
      "See docs/Security_Operations_SOP.md §5.7 (Secrets Rotation Log) for the rotation procedure " +
      "(generate with `openssl rand -hex 32`).",
  );
  throw new Error(
    `ADMIN_API_KEY does not meet minimum strength requirements ` +
      `(length ≥ ${ADMIN_API_KEY_MIN_LENGTH}, distinct chars ≥ ${ADMIN_API_KEY_MIN_DISTINCT_CHARS}). ` +
      `See docs/Security_Operations_SOP.md §5.7.`,
  );
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
  const session = getSessionFromCookie(c.req.header("Cookie"));
  return session?.role === "admin";
}

export async function requireAdminOrKey(c: any): Promise<SessionUser | null> {
  if (hasValidAdminApiKey(c)) {
    return {
      userId: 0,
      email: "api-key@system",
      name: "API Key Access",
      role: "admin",
    };
  }
  const user = getSessionUser(c);
  if (!user) return null;
  const platformUser = await getPlatformUser(user.email);
  if (!platformUser || platformUser.status !== "active") return null;
  if (platformUser.role !== "admin") return null;
  user.role = platformUser.role;
  return user;
}

export async function requireRoleOrKey(
  c: any,
  allowedRoles: UserRole[],
): Promise<SessionUser | null> {
  // X-Admin-Key is NOT accepted here.  The shared admin key is scoped to
  // /api/admin/* and to handlers that call requireAdminOrKey() explicitly.
  // Accepting it here would silently grant admin-level access to every
  // role-gated application route, bypassing intended RBAC boundaries.
  return requireRole(c, allowedRoles);
}

export function requireAuthOrKey(c: any): SessionUser | null {
  // X-Admin-Key is NOT accepted here.  Use requireAdminOrKey() for routes
  // that are explicitly designed to accept the shared server-to-server key.
  // Accepting it here bypasses authentication checks on ordinary app routes.
  return getSessionUser(c);
}

/**
 * QMS roles that may perform write actions and access sensitive history/approval
 * endpoints.  Mirrors the role set used by risk read endpoints.
 */
export const QMS_ROLES: UserRole[] = [
  "admin",
  "quality_manager",
  "head_of_operations_quality",
  "grc_manager",
];

export function gateApiRoute<
  T extends {
    path: string;
    roles?: UserRole[];
    createHandler: (deps: any) => any | Promise<any>;
  },
>(route: T): T {
  if (!route.path.startsWith("/api/")) return route;
  const originalCreate = route.createHandler;
  const allowedRoles = route.roles;
  return {
    ...route,
    createHandler: async (deps: any) => {
      const inner = await originalCreate(deps);
      return async (c: any) => {
        const user = requireAuthOrKey(c);
        if (!user) return unauthorizedResponse(c);
        if (allowedRoles && !allowedRoles.includes(user.role as UserRole)) {
          return forbiddenResponse(c);
        }
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
  { pattern: /^\/api\/logs/, methods: ["GET"], roles: ["admin"] },
  { pattern: /^\/api\/event-logs/, methods: ["GET"], roles: ["admin"] },

  // Executive digest — XLSX export of issues (analytics read-side; mirrors other analytics reads)
  {
    pattern: /^\/api\/digest\/issues\.xlsx$/,
    methods: ["GET"],
    roles: ["admin", "quality_manager", "grc_manager", "head_of_operations_quality", "executive"],
  },
  // Executive digest — outbox processor (write/send-side; admin + ops only, mirrors DIGEST_SEND_ROLES)
  {
    pattern: /^\/api\/analytics\/executive-digest\/outbox\/process$/,
    methods: ["POST"],
    roles: ["admin", "head_of_operations_quality"],
  },

  {
    pattern: /^\/api\/risks\/\d+\/close$/,
    methods: ["POST"],
    permission: "can_close_finding",
  },
  {
    pattern: /^\/api\/risks\/\d+\/accept$/,
    methods: ["POST"],
    permission: "can_accept_risk",
  },
  {
    pattern: /^\/api\/risks\/\d+\/escalate$/,
    methods: ["POST"],
    permission: "can_accept_risk",
  },
  {
    pattern: /^\/api\/risks\/\d+\/treatment$/,
    methods: ["POST"],
    roles: ["admin", "grc_manager", "quality_manager"],
  },
  {
    pattern: /^\/api\/risks\/treatment\/\d+$/,
    methods: ["PUT"],
    roles: ["admin", "grc_manager", "quality_manager"],
  },
  {
    pattern: /^\/api\/risks(\/\d+)?$/,
    methods: ["POST", "PUT", "DELETE"],
    roles: ["admin", "grc_manager", "quality_manager"],
  },
  // Risk register reads — governance roles and senior leadership only
  {
    pattern: /^\/api\/risks/,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "executive",
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Fraud Management Module (PRD-FRD-001)
  // Reads: governance roles + executive (mirrors risks).
  // Writes: admin, head_of_operations_quality, grc_manager
  //   (per the recommended position on PRD §15 Q1 — extend grc_manager
  //   instead of introducing a fraud_admin role; can be tightened later).
  // ─────────────────────────────────────────────────────────────────────────
  {
    pattern: /^\/api\/fraud\//,
    methods: ["POST", "PUT", "DELETE"],
    roles: ["admin", "head_of_operations_quality", "grc_manager"],
  },
  {
    pattern: /^\/api\/fraud\//,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "executive",
    ],
  },

  {
    pattern: /^\/api\/policies\/\d+\/transition$/,
    methods: ["POST"],
    permission: "can_approve_policy",
  },
  {
    pattern: /^\/api\/policies\/\d+\/grc-approval$/,
    methods: ["POST"],
    permission: "can_approve_policy",
  },
  {
    pattern: /^\/api\/policies\/\d+\/publish$/,
    methods: ["POST"],
    permission: "can_approve_policy",
  },
  {
    pattern: /^\/api\/policies\/\d+\/set-owners$/,
    methods: ["POST"],
    roles: ["admin", "grc_manager"],
  },
  {
    pattern: /^\/api\/policies\/\d+\/acknowledge$/,
    methods: ["POST"],
    roles: ["admin", "grc_manager", "quality_manager", "bu_owner"],
  },
  {
    pattern: /^\/api\/policies\/\d+\/upload$/,
    methods: ["POST"],
    roles: ["admin", "grc_manager", "quality_manager"],
  },
  {
    pattern: /^\/api\/policies\/review-cycles\/\d+$/,
    methods: ["PUT"],
    roles: ["admin", "grc_manager", "quality_manager"],
  },
  {
    pattern: /^\/api\/policies(\/\d+)?$/,
    methods: ["POST", "PUT", "DELETE"],
    roles: ["admin", "grc_manager", "quality_manager"],
  },

  {
    pattern: /^\/api\/audits\/findings(\/\d+)?$/,
    methods: ["POST", "PUT"],
    permission: "can_close_finding",
  },
  {
    pattern: /^\/api\/audits\/evidence-packs$/,
    methods: ["POST"],
    permission: "can_submit_evidence",
  },
  {
    pattern: /^\/api\/audits\/\d+\/checklist$/,
    methods: ["PUT"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
    ],
  },
  {
    pattern: /^\/api\/audits\/checklist\/\d+$/,
    methods: ["PUT"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
    ],
  },
  {
    pattern: /^\/api\/audits(\/\d+)?$/,
    methods: ["POST", "PUT", "DELETE"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
    ],
  },
  // Audit reads — governance roles and senior leadership only
  {
    pattern: /^\/api\/audits/,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "executive",
    ],
  },

  // Audit Programme (ISO 19011 §5.2). Quality Manager can draft; only
  // Head of Operations & Quality (or admin) can approve via the HITL sign-off.
  {
    pattern: /^\/api\/audit-programme\/\d+\/submit$/,
    methods: ["POST"],
    roles: ["admin", "head_of_operations_quality", "quality_manager"],
  },
  {
    pattern: /^\/api\/audit-programme\/\d+\/approve$/,
    methods: ["POST"],
    roles: ["admin", "head_of_operations_quality"],
  },
  {
    pattern: /^\/api\/audit-programme\/\d+\/reject$/,
    methods: ["POST"],
    roles: ["admin", "head_of_operations_quality"],
  },
  {
    pattern: /^\/api\/audit-programme(\/\d+)?$/,
    methods: ["POST", "PUT", "DELETE"],
    roles: ["admin", "head_of_operations_quality", "quality_manager"],
  },
  // Audit programme reads — governance roles and senior leadership only
  {
    pattern: /^\/api\/audit-programme/,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "executive",
    ],
  },

  // Manual Audit Intake (off-platform audits) — Quality Manager is single-point intake.
  {
    pattern: /^\/api\/manual-audit-intake/,
    methods: ["POST", "PUT", "DELETE"],
    roles: ["admin", "head_of_operations_quality", "quality_manager"],
  },

  // External Audits (regulatory, certification, surveillance) — GRC owns, QM contributes.
  {
    pattern: /^\/api\/external-audits/,
    methods: ["POST", "PUT", "DELETE"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
    ],
  },

  {
    pattern: /^\/api\/compliance\/controls/,
    methods: ["POST", "PUT", "DELETE"],
    permission: "can_edit_controls",
  },
  {
    pattern: /^\/api\/compliance\/capa/,
    methods: ["POST", "PUT"],
    permission: "can_create_capa",
  },
  // Phase 1-3 of compliance-mapping feature — link/unlink/judge/apply-mapping
  // need head_of_operations_quality in addition to the existing GRC roles.
  // This rule MUST come before the general write-roles rule below so it wins.
  {
    pattern:
      /^\/api\/compliance\/(documents|obligations\/[^/]+\/(documents|judge|suggest-documents|bulk-upload))/,
    methods: ["POST", "DELETE"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
    ],
  },
  // Audit-readiness PDF download — restricted (no executive read like the
  // CSV export endpoint).
  {
    pattern: /^\/api\/compliance\/regulations\/[^/]+\/audit-readiness\/pdf/,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
    ],
  },
  {
    pattern: /^\/api\/compliance/,
    methods: ["POST", "PUT", "DELETE"],
    roles: ["admin", "grc_manager", "quality_manager"],
  },
  // Compliance export endpoints carry the same governance-write restriction as
  // other QMS exports — executive may not download raw compliance export data.
  {
    pattern: /^\/api\/compliance\/export/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },
  // Compliance reads — governance roles and senior leadership only
  {
    pattern: /^\/api\/compliance/,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "executive",
    ],
  },

  {
    pattern: /^\/api\/vendors/,
    methods: ["POST", "PUT", "DELETE"],
    roles: ["admin", "grc_manager", "quality_manager"],
  },
  // Vendor reads — governance roles only (contract values, assessment findings, PII)
  {
    pattern: /^\/api\/vendors/,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
    ],
  },

  // Management reviews — senior governance records (minutes, decisions, action items)
  {
    pattern: /^\/api\/management-reviews/,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "executive",
    ],
  },
  {
    pattern: /^\/api\/management-reviews/,
    methods: ["POST", "PUT", "DELETE"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
    ],
  },

  // GRC aggregated reports — governance roles and senior leadership only; department_viewer excluded
  {
    pattern: /^\/api\/reports\/capa-effectiveness$/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },
  {
    pattern: /^\/api\/reports\/compliance-posture$/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },

  // PDPL reports — admin-only (privacy inventory, incident history, security posture)
  {
    pattern: /^\/api\/reports\/pdpl-inventory/,
    methods: ["GET"],
    roles: ["admin"],
  },

  {
    pattern: /^\/api\/handoff\//,
    methods: ["POST", "PUT", "DELETE"],
    roles: ["admin", "grc_manager", "quality_manager"],
  },

  {
    pattern: /^\/api\/roi/,
    methods: ["POST", "PUT", "DELETE"],
    roles: ["admin", "grc_manager", "quality_manager", "executive"],
  },

  {
    pattern: /^\/api\/migration/,
    methods: ["POST", "PUT", "DELETE"],
    roles: ["admin"],
  },

  {
    pattern: /^\/api\/users/,
    methods: ["POST", "PUT", "DELETE"],
    permission: "can_manage_users",
  },
  {
    pattern: /^\/api\/invitations/,
    methods: ["POST", "DELETE"],
    roles: ["admin", "quality_manager"],
  },

  {
    pattern: /^\/api\/rbac/,
    methods: ["POST", "PUT", "DELETE"],
    roles: ["admin"],
  },

  {
    pattern: /^\/api\/call-intelligence/,
    methods: ["POST", "PUT", "DELETE"],
    roles: ["admin", "ai_specialist"],
  },

  { pattern: /^\/api\/event-logs/, methods: ["DELETE"], roles: ["admin"] },

  {
    pattern: /^\/api\/audit\/trigger$/,
    methods: ["POST"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "team_lead",
      "auditor",
      "quality_specialist",
      "ai_specialist",
      "bu_owner",
      "executive",
    ],
  },

  {
    pattern: /^\/api\/team\//,
    methods: ["POST", "PUT", "PATCH", "DELETE"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
    ],
  },
  {
    pattern: /^\/api\/team$/,
    methods: ["POST", "PUT", "PATCH", "DELETE"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
    ],
  },
  {
    pattern: /^\/api\/audit-trail/,
    methods: ["POST", "PUT", "PATCH", "DELETE"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
    ],
  },

  {
    pattern: /^\/api\/onboarding\/stats$/,
    methods: ["GET"],
    roles: ["admin", "head_of_operations_quality"],
  },
  {
    pattern: /^\/api\/onboarding\/demo-links$/,
    methods: ["GET"],
    roles: ["admin", "head_of_operations_quality"],
  },
  {
    pattern: /^\/api\/onboarding\/demo-link/,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    roles: ["admin", "head_of_operations_quality"],
  },

  // Trigger workflow actions: only reviewer-capable roles may action triggers.
  // The handler additionally verifies that the caller's role matches the
  // trigger's assigned_role (or is an admin-level role).
  {
    pattern: /^\/api\/triggers\/\d+\/action$/,
    methods: ["POST"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "team_lead",
      "executive",
      "bu_owner",
      "ai_specialist",
    ],
  },

  // Notification read: only reviewer-capable roles may mark notifications read.
  // The handler additionally verifies the notification belongs to the caller's role.
  {
    pattern: /^\/api\/notifications\/\d+\/read$/,
    methods: ["POST"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "team_lead",
      "executive",
      "bu_owner",
      "ai_specialist",
    ],
  },

  {
    // AI Consultant chat — intentionally open to every authenticated role.
    // Per product decision (May 2026) the consultant is a self-service team
    // helper, not an admin-only tool. The data-access tools the consultant
    // invokes still apply their own per-module RBAC, so lower-privilege
    // callers can chat but the consultant only surfaces data they are
    // already entitled to see. Keep this list in sync with CONSULTANT_ROLES
    // in src/mastra/routes/consultantRoutes.ts.
    pattern: /^\/api\/consultant\/chat(\/stream)?$/,
    methods: ["POST"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "quality_manager",
      "quality_specialist",
      "grc_manager",
      "team_lead",
      "department_viewer",
      "auditor",
      "ai_specialist",
      "bu_owner",
      "executive",
      "custom",
    ],
  },
  {
    pattern: /^\/api\/consultant\/scan$/,
    methods: ["POST"],
    roles: [
      "admin",
      "ai_specialist",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },
  {
    pattern: /^\/api\/consultant\/alerts\/\d+\/(acknowledge|resolve|dismiss)$/,
    methods: ["POST"],
    roles: [
      "admin",
      "ai_specialist",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },

  {
    pattern: /^\/api\/knowledge\/upload$/,
    methods: ["POST"],
    roles: ["admin", "ai_specialist", "grc_manager"],
  },
  {
    pattern: /^\/api\/knowledge\/documents\/\d+$/,
    methods: ["DELETE"],
    roles: ["admin", "grc_manager"],
  },

  // Sensitive GET read restrictions — enforce role boundaries on reads that expose CRM,
  // call intelligence, and governance data. department_viewer and custom roles are excluded.
  {
    pattern: /^\/api\/duplicates/,
    methods: ["GET"],
    roles: [
      "admin",
      "grc_manager",
      "ai_specialist",
      "head_of_operations_quality",
      "quality_manager",
      "bu_owner",
      "executive",
    ],
  },
  {
    pattern: /^\/api\/policies/,
    methods: ["GET"],
    roles: [
      "admin",
      "grc_manager",
      "quality_manager",
      "head_of_operations_quality",
      "bu_owner",
      "executive",
      "quality_specialist",
      "auditor",
      "team_lead",
      "ai_specialist",
    ],
  },
  {
    pattern: /^\/api\/calls/,
    methods: ["GET"],
    roles: [
      "admin",
      "ai_specialist",
      "head_of_operations_quality",
      "quality_manager",
      "team_lead",
      "grc_manager",
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // KPI / Executive reporting / Scorecard / Analytics / Health-pulse /
  // Infographic — sensitive aggregated governance metrics. Locked to the
  // governance/executive role set; department_viewer and other low-privilege
  // roles are blocked.
  // ─────────────────────────────────────────────────────────────────────────

  // Admin-only KPI seeders (write fixture data into the platform).
  {
    pattern: /^\/api\/kpis\/seed-(mohammed|sdr)$/,
    methods: ["POST"],
    roles: ["admin"],
  },
  // KPI value entry — governance write roles only.
  {
    pattern: /^\/api\/kpis\/\d+\/values$/,
    methods: ["POST"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },
  // KPI definition writes (create / update / delete) — governance write roles only.
  {
    pattern: /^\/api\/kpis(\/\d+)?$/,
    methods: ["POST", "PUT", "DELETE"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },
  // KPI reads (definitions, summary, individual KPI, history) — governance roles + executive.
  {
    pattern: /^\/api\/kpis(\/(\d+(\/history)?|summary))?$/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },

  // Executive reports (MBR/QBR documents) and MBR data feed — governance + executive.
  {
    pattern: /^\/api\/executive\/reports(\/\d+)?$/,
    methods: ["POST", "PUT", "DELETE"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },
  {
    pattern: /^\/api\/executive\/reports(\/\d+)?$/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },
  {
    pattern: /^\/api\/executive\/mbr-data$/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },

  // Analytics — cycle times, agent compliance, CAPA recurrence, trends, executive digest.
  // Digest send (emails leadership) is restricted to admin + Head of Operations & Quality.
  {
    pattern: /^\/api\/analytics\/executive-digest\/send$/,
    methods: ["POST"],
    roles: ["admin", "head_of_operations_quality"],
  },
  {
    pattern: /^\/api\/analytics\//,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },

  // Platform Health Pulse — admin only (operational diagnostics, secret presence,
  // dependency health, latency).  POST /run triggers an actual probe sweep.
  {
    pattern: /^\/api\/health\/pulse(\/(latest|run))?$/,
    methods: ["GET", "POST"],
    roles: ["admin"],
  },

  // Scorecard — Mohammed-style governance scorecard (raw KPI calculations).
  // Snapshot save = governance write; reads = governance + executive.
  {
    pattern: /^\/api\/scorecard\/snapshot$/,
    methods: ["POST"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },
  {
    pattern: /^\/api\/scorecard\//,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },

  // Infographics — governance-only renders.  Share-out (Slack / email) distributes
  // sensitive aggregated data externally and is restricted to governance write roles.
  {
    pattern: /^\/api\/infographic\/[^/]+\/share\/(slack|email)$/,
    methods: ["POST"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },
  {
    pattern: /^\/api\/infographic(\/.+)?$/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // PMP (Project Management Portfolio) — project, risk, milestone, stakeholder,
  // procurement, and change-request data.  BU owners participate in
  // project governance for their own business unit.
  // AI charter generation additionally requires ai_specialist access.
  // ─────────────────────────────────────────────────────────────────────────
  {
    pattern: /^\/api\/pmp\/generate-charter$/,
    methods: ["POST"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "ai_specialist",
      "bu_owner",
    ],
  },
  {
    pattern: /^\/api\/pmp\//,
    methods: ["POST", "PUT", "DELETE"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "bu_owner",
    ],
  },
  {
    pattern: /^\/api\/pmp\//,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "executive",
      "bu_owner",
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // TableF (Department COPC KPI scorecard) — department-level performance
  // KPIs, actuals, snapshots, and user assignments.
  // BU owners may read their department data; only quality/governance roles
  // may write.
  // ─────────────────────────────────────────────────────────────────────────
  {
    pattern: /^\/api\/tablef\//,
    methods: ["POST", "PUT", "DELETE"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "quality_manager",
      "grc_manager",
    ],
  },
  {
    pattern: /^\/api\/tablef\//,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "quality_manager",
      "grc_manager",
      "executive",
      "bu_owner",
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // AI Approvals (HITL governance queue) — pending, detail, approve, reject.
  // The handler enforces per-user row filtering and segregation of duties;
  // ROUTE_PERMISSION_MAP prevents department_viewer reaching the handler at
  // all.  Approve is restricted to governance write roles; reject is broader
  // to allow requesters to cancel their own draft (handler enforces SoD).
  // ─────────────────────────────────────────────────────────────────────────
  {
    pattern: /^\/api\/ai\/approvals\/[^/]+\/approve$/,
    methods: ["POST"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },
  {
    pattern: /^\/api\/ai\/approvals\/[^/]+\/reject$/,
    methods: ["POST"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "ai_specialist",
      "bu_owner",
      "executive",
      "quality_specialist",
      "auditor",
      "team_lead",
    ],
  },
  {
    pattern: /^\/api\/ai\/approvals/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "ai_specialist",
      "bu_owner",
      "executive",
      "quality_specialist",
      "auditor",
      "team_lead",
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // QMS Enhanced — evidence records, QMS exports, NC/CAPA closure approvals.
  // PDPL export exposes the full PII data inventory — admin only.
  // QMS NC/CAPA CSV/XLSX exports stream large sensitive datasets — governance
  // write roles only.  Evidence records are ISO 9001 §7.5 audit evidence;
  // auditors and quality specialists may read and attach, but only governance
  // roles may delete (to protect audit-trail integrity).
  // ─────────────────────────────────────────────────────────────────────────
  { pattern: /^\/api\/pdpl\/export/, methods: ["GET"], roles: ["admin"] },
  {
    pattern: /^\/api\/qms\/nc\/export/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },
  {
    pattern: /^\/api\/qms\/capa-export-xlsx/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },
  {
    pattern: /^\/api\/qms\/capa\/export/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },
  {
    pattern: /^\/api\/kpis\/export/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },
  {
    pattern: /^\/api\/qms\/(nc|capa)\/bulk-update$/,
    methods: ["POST"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },
  {
    pattern: /^\/api\/qms\/(nc|capa)\/[^/]+\/history$/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },
  {
    pattern: /^\/api\/qms\/nc\/\d+\/approve-closure$/,
    methods: ["POST"],
    roles: ["admin", "quality_manager", "head_of_operations_quality"],
  },
  {
    pattern: /^\/api\/qms\/capa\/\d+\/(approve-closure|effectiveness)$/,
    methods: ["POST"],
    roles: ["admin", "quality_manager", "head_of_operations_quality"],
  },
  {
    pattern: /^\/api\/qms\/capa\/\d+$/,
    methods: ["PATCH"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "auditor",
    ],
  },
  {
    pattern: /^\/api\/evidence-pack$/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "auditor",
      "quality_specialist",
    ],
  },
  {
    pattern: /^\/api\/evidence-summary$/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "auditor",
      "quality_specialist",
    ],
  },
  {
    pattern: /^\/api\/evidence\/\w/,
    methods: ["DELETE"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },
  {
    pattern: /^\/api\/evidence/,
    methods: ["GET", "POST"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Dashboard & audit — quality KPIs, audit history, scorecard, governance
  // document, CRM data, and agent performance.  All are governance-read
  // (admin / quality managers / GRC / head-of-ops / executive).  Write
  // operations (audit trigger, CRM enrich) require governance-write.
  // /api/inngest is an internal Inngest webhook and is excluded from RBAC
  // (Inngest itself validates the signing key).
  // ─────────────────────────────────────────────────────────────────────────
  {
    pattern: /^\/api\/audit\//,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },
  {
    pattern: /^\/api\/dashboard\//,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },
  {
    pattern: /^\/api\/dashboard$/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },
  {
    pattern: /^\/api\/scorecards$/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },
  {
    pattern: /^\/api\/scorecard$/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },
  {
    pattern: /^\/api\/governance$/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },
  {
    pattern: /^\/api\/crm\/enrich$/,
    methods: ["POST"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },
  {
    pattern: /^\/api\/crm\/data$/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },
  {
    pattern: /^\/api\/agents\/performance$/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },
  {
    pattern: /^\/api\/integrations\/status$/,
    methods: ["GET"],
    roles: [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "executive",
    ],
  },

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
  { pattern: /^\/api\/activity\//, methods: ["GET"], roles: ["admin"] },
  { pattern: /^\/api\/system\//, methods: ["GET"], roles: ["admin"] },
  {
    pattern: /^\/api\/workflow\/runs(\/\d+)?$/,
    methods: ["GET"],
    roles: ["admin"],
  },

  // AI Ops — agent observability, prompt versions, tool-health alerts/config.
  // Tool-health-config writes are admin-only (TOOL_HEALTH_CONFIG_WRITE_ROLES).
  // All other endpoints use AI_OPS_ROLES.
  {
    pattern: /^\/api\/ai-ops\/tool-health-config$/,
    methods: ["PUT"],
    roles: ["admin"],
  },
  {
    pattern: /^\/api\/ai-ops\//,
    methods: ["GET", "POST", "PUT", "PATCH"],
    roles: [
      "admin",
      "ai_specialist",
      "grc_manager",
      "head_of_operations_quality",
      "quality_manager",
    ],
  },

  // Audit checklist POST (PUT already covered above).
  {
    pattern: /^\/api\/audits\/\d+\/checklist$/,
    methods: ["POST"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
    ],
  },

  // Call Intelligence writes — admin-only via `verifyAdminKey`
  // (calls/ingest, /analyze, /compliance POST, /upload, /upload-audio,
  // /bulk-upload, /five9/*, /:id/evaluate, /:id/sdr-evaluate, /:id/sync-zoho,
  // meetings/mom POST, quality-scorecards POST/PUT).
  {
    pattern: /^\/api\/calls\/(ingest|upload|upload-audio|bulk-upload)$/,
    methods: ["POST"],
    roles: ["admin"],
  },
  { pattern: /^\/api\/calls\/five9\//, methods: ["POST"], roles: ["admin"] },
  {
    pattern:
      /^\/api\/calls\/[^/]+\/(analyze|compliance|sync-zoho|evaluate|sdr-evaluate)$/,
    methods: ["POST"],
    roles: ["admin"],
  },
  {
    pattern: /^\/api\/calls\/mcp\/leads\/match-phone$/,
    methods: ["POST"],
    roles: [
      "admin",
      "ai_specialist",
      "head_of_operations_quality",
      "quality_manager",
      "team_lead",
      "grc_manager",
    ],
  },
  {
    pattern: /^\/api\/calls\/mcp\/drive-import$/,
    methods: ["POST"],
    roles: ["admin"],
  },
  { pattern: /^\/api\/meetings\/mom$/, methods: ["POST"], roles: ["admin"] },
  {
    pattern: /^\/api\/quality-scorecards(\/\d+)?$/,
    methods: ["POST", "PUT"],
    roles: ["admin"],
  },

  // Call Intelligence reads with no inner role gate — any authenticated user.
  {
    pattern: /^\/api\/meetings\/mom\//,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
      "department_viewer",
    ],
  },
  {
    pattern: /^\/api\/sdr-scorecards\//,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
      "department_viewer",
    ],
  },
  {
    pattern: /^\/api\/ai-training\//,
    methods: ["GET", "POST"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
      "department_viewer",
    ],
  },
  {
    pattern: /^\/api\/quality-scorecards$/,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
      "department_viewer",
    ],
  },

  // Consultant — alerts/feedback (CONSULTANT_ROLES; stats/trend = AI insiders).
  {
    pattern: /^\/api\/consultant\/alerts(\/count)?$/,
    methods: ["GET"],
    roles: [
      "admin",
      "ai_specialist",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },
  {
    pattern: /^\/api\/consultant\/feedback$/,
    methods: ["POST"],
    roles: [
      "admin",
      "ai_specialist",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },
  {
    pattern: /^\/api\/consultant\/feedback\/(stats|trend)$/,
    methods: ["GET"],
    roles: ["admin", "ai_specialist"],
  },
  {
    pattern: /^\/api\/consultant\/scan-stream$/,
    methods: ["GET"],
    roles: [
      "admin",
      "ai_specialist",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },

  // Duplicate Radar writes — DUPLICATE_RADAR_READ_ROLES (single gate covers
  // every action; see `requireDuplicateRadarAccess` in duplicateRadarRoutes).
  {
    pattern: /^\/api\/duplicates\//,
    methods: ["POST", "PATCH", "DELETE"],
    roles: [
      "admin",
      "grc_manager",
      "ai_specialist",
      "head_of_operations_quality",
      "quality_manager",
      "bu_owner",
      "executive",
    ],
  },

  // Pipeline Aging (Task #825) — mirrors Duplicate Radar read set; handlers
  // also enforce the same allowlist via `requirePipelineAgingAccess`.
  {
    pattern: /^\/api\/zoho\/(deals|leads)\/[^/]+\/(stage|status)-aging$/,
    methods: ["GET"],
    roles: [
      "admin",
      "grc_manager",
      "ai_specialist",
      "head_of_operations_quality",
      "quality_manager",
      "bu_owner",
      "executive",
    ],
  },
  {
    pattern: /^\/api\/zoho\/(deals|leads)\/aging$/,
    methods: ["GET"],
    roles: [
      "admin",
      "grc_manager",
      "ai_specialist",
      "head_of_operations_quality",
      "quality_manager",
      "bu_owner",
      "executive",
    ],
  },
  {
    pattern: /^\/api\/zoho\/aging\/config$/,
    methods: ["GET"],
    roles: [
      "admin",
      "grc_manager",
      "ai_specialist",
      "head_of_operations_quality",
      "quality_manager",
      "bu_owner",
      "executive",
    ],
  },

  // External Audit reads — handler uses `getSessionUser` only (any auth).
  {
    pattern: /^\/api\/external-audits/,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
      "department_viewer",
    ],
  },

  // Feedback API — no inner role gate (any auth).
  {
    pattern: /^\/api\/feedback(\/stats)?$/,
    methods: ["GET", "POST"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
      "department_viewer",
    ],
  },

  // Handoff GET endpoints — handlers use `getSessionUser` (any auth);
  // writes are already covered by the `/api/handoff/` POST/PUT/DELETE rule.
  {
    pattern: /^\/api\/handoff\//,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
      "department_viewer",
    ],
  },

  // Knowledge reads — KNOWLEDGE_READ_ROLES (already covered: upload write,
  // delete).  Checklists have no inner role gate (any auth).
  {
    pattern: /^\/api\/knowledge\/(documents|search)/,
    methods: ["GET"],
    roles: [
      "admin",
      "ai_specialist",
      "grc_manager",
      "head_of_operations_quality",
      "quality_manager",
    ],
  },
  {
    pattern: /^\/api\/checklists(\/.*)?$/,
    methods: ["GET", "POST"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
      "department_viewer",
    ],
  },

  // Manual Audit Intake reads — handler uses `getSessionUser` only.
  {
    pattern: /^\/api\/manual-audit-intake/,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
      "department_viewer",
    ],
  },

  // Migration GETs — admin only (writes already admin via existing rule).
  { pattern: /^\/api\/migration\//, methods: ["GET"], roles: ["admin"] },

  // Notifications — handlers have no inner role check (any auth).
  // Specific /:id/read POST is covered by an existing reviewer-roles rule.
  {
    pattern: /^\/api\/notifications(\/count)?$/,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
      "department_viewer",
    ],
  },
  {
    pattern: /^\/api\/notifications\/\d+\/dismiss$/,
    methods: ["POST"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
    ],
  },

  // Onboarding status / tour / tooltips — `requireAuthOrKey` (any auth).
  {
    pattern: /^\/api\/onboarding\/(status|tour-steps|tooltips)$/,
    methods: ["GET", "POST"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
      "department_viewer",
    ],
  },
  {
    pattern: /^\/api\/onboarding\/tooltip\//,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
      "department_viewer",
    ],
  },

  // PDPL — `requireAdminOrKey` for every endpoint (admin only).
  // /api/pdpl/export is already covered above for GET; this catches the rest.
  {
    pattern: /^\/api\/pdpl\//,
    methods: ["GET", "POST", "PUT", "DELETE"],
    roles: ["admin"],
  },

  // Policies — link & review-cycles writes (governance roles).
  {
    pattern: /^\/api\/policies\/\d+\/link$/,
    methods: ["POST"],
    roles: ["admin", "grc_manager", "quality_manager"],
  },
  {
    pattern: /^\/api\/policies\/review-cycles$/,
    methods: ["POST"],
    roles: ["admin", "grc_manager", "quality_manager"],
  },

  // QMS API (qmsApiRoutes.ts) — every endpoint gated by `isAdminAuthorized`
  // (admin user OR X-Admin-Key).
  {
    pattern: /^\/api\/qms\/(dashboard|evaluations|capa|nc|training|framework)/,
    methods: ["GET", "POST"],
    roles: ["admin"],
  },

  // RBAC GET endpoints — admin only (writes already covered).
  { pattern: /^\/api\/rbac\//, methods: ["GET"], roles: ["admin"] },

  // ROI reads — handlers use `getSessionUser` (any auth); writes covered.
  {
    pattern: /^\/api\/roi(\/.*)?$/,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
      "department_viewer",
    ],
  },

  // Sandbox API — every endpoint uses `requireSandboxAuth` (any auth).
  {
    pattern: /^\/api\/sandbox\//,
    methods: ["GET", "POST"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
      "department_viewer",
    ],
  },

  // Team management reads & audit-trail — TEAM_MGMT_ROLES.
  {
    pattern: /^\/api\/team\//,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
    ],
  },
  {
    pattern: /^\/api\/audit-trail$/,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
    ],
  },

  // QMS document library (uploaded governance artefacts). Order matters:
  // the DELETE rule for `/api/qms-docs/:id` must precede the broader GET
  // rule below so its narrower role set wins for delete traffic.
  {
    pattern: /^\/api\/qms-docs\/\d+$/,
    methods: ["DELETE"],
    roles: ["admin", "grc_manager"],
  },
  {
    pattern: /^\/api\/qms-docs\/upload$/,
    methods: ["POST"],
    roles: ["admin", "grc_manager", "quality_manager"],
  },
  {
    pattern: /^\/api\/qms-docs\/bulk-upload$/,
    methods: ["POST"],
    roles: ["admin", "grc_manager", "quality_manager"],
  },
  // List, counts, single-doc fetch, and binary download all share the same
  // governance + executive read set as the page shell at /qms-docs.
  {
    pattern: /^\/api\/qms-docs(\/.*)?$/,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "executive",
    ],
  },

  // Trigger reads (list / stats / by-audit) — TRIGGER_REVIEWER_ROLES.
  {
    pattern: /^\/api\/triggers/,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "team_lead",
      "executive",
      "bu_owner",
      "ai_specialist",
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Task #436 — coverage backfill for `/api/*` routes that previously fell
  // through every rule above and were therefore denied by the deny-by-default
  // fallback. Discovered by `tests/rbacRouteCoverage.test.ts`, which scans
  // `src/mastra/routes/**` and `src/triggers/**` and asserts every live
  // route has an explicit ROUTE_PERMISSION_MAP rule.
  // ─────────────────────────────────────────────────────────────────────────

  // Consultant feedback by message — handler uses `requireRole(c, CONSULTANT_ROLES)`.
  {
    pattern: /^\/api\/consultant\/feedback\/[^/]+$/,
    methods: ["GET"],
    roles: [
      "admin",
      "ai_specialist",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },

  // Consultant chat history by thread — handler uses
  // `requireRole(c, CONSULTANT_ROLES)`. Same role set as the sibling
  // /api/consultant/feedback/:messageId rule above; backfilled here so the
  // rebac route-coverage gate (Task #436) passes for the route added in
  // src/mastra/routes/consultantRoutes.ts:139.
  {
    pattern: /^\/api\/consultant\/history\/[^/]+$/,
    methods: ["GET"],
    roles: [
      "admin",
      "ai_specialist",
      "grc_manager",
      "head_of_operations_quality",
    ],
  },

  // Recent-downloads tracker — per-user list/insert/clear via `getSessionUser`
  // (any authenticated caller). Used by the streaming-download UI to surface
  // each user's own recent export history.
  {
    pattern: /^\/api\/exports\/recent-downloads$/,
    methods: ["GET", "POST", "DELETE"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
      "department_viewer",
    ],
  },

  // Health-index aggregated quality metrics — handler enforces
  // `requireRoleOrKey(c, HEALTH_INDEX_ROLES)` (see notificationRoutes.ts).
  // Restricted to governance-oriented roles that are already permitted to
  // read the underlying modules (audit, NC, CAPA, KPI, compliance). Mirrors
  // REPORT_ALLOWED_ROLES in reportRoutes.ts, which queries the same tables.
  {
    pattern: /^\/api\/health-index$/,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "executive",
    ],
  },

  // SOP document API + download — handler enforces session-or-admin-key
  // (`isAuthorizedForSop`); any authenticated caller may read.
  {
    pattern: /^\/api\/sop(\/download)?$/,
    methods: ["GET"],
    roles: [
      "admin",
      "head_of_operations_quality",
      "grc_manager",
      "quality_manager",
      "auditor",
      "quality_specialist",
      "team_lead",
      "bu_owner",
      "ai_specialist",
      "executive",
      "department_viewer",
    ],
  },

  { pattern: /^\/api\/users\/stats$/, methods: ["GET"], roles: ["admin"] },
  { pattern: /^\/api\/users\/\d+$/, methods: ["GET"], roles: ["admin"] },
  // PATCH on a specific user — admin-only (handler also enforces
  // verifyAdminKey). Map-level rule is required because the broader
  // `^/api/users` POST/PUT/DELETE permission rule above doesn't cover
  // PATCH, so without this entry the deny-by-default fallback in
  // `enforceRoutePermission` would swallow PATCH before the handler
  // could run. DELETE is already covered by the `can_manage_users`
  // rule above; intentionally not duplicated here so first-match
  // semantics keep that policy authoritative.
  {
    pattern: /^\/api\/users\/\d+$/,
    methods: ["PATCH"],
    roles: ["admin"],
  },
  // Mobile consultant feedback (callId + messageId variants) — same
  // allowlist as the web consultant chat (CONSULTANT_ROLES). See
  // src/mastra/routes/mobileRoutes.ts:MOBILE_CONSULTANT_ROLES.
  {
    pattern: /^\/api\/mobile\/consultant\/(feedback|message-feedback)$/,
    methods: ["POST"],
    roles: ["admin", "ai_specialist", "grc_manager", "head_of_operations_quality"],
  },
  {
    pattern: /^\/api\/users$/,
    methods: ["GET"],
    roles: ["admin", "quality_manager"],
  },
  { pattern: /^\/api\/invitations$/, methods: ["GET"], roles: ["admin"] },
  { pattern: /^\/api\/access-audit/, methods: ["GET"], roles: ["admin"] },
  { pattern: /^\/api\/screens$/, methods: ["GET"], roles: ["admin"] },
  { pattern: /^\/api\/roles\/defaults$/, methods: ["GET"], roles: ["admin"] },
];

export async function enforceRoutePermission(
  c: any,
  path: string,
  method: string,
): Promise<{ allowed: boolean; error?: string }> {
  const user = getSessionUser(c);
  if (!user) return { allowed: false, error: "Authentication required" };

  const verifiedRole = await getVerifiedRole(user.email, user.role);
  user.role = verifiedRole;

  for (const rule of ROUTE_PERMISSION_MAP) {
    if (rule.pattern.test(path) && rule.methods.includes(method)) {
      if (user.role === "admin") return { allowed: true };
      if (rule.roles && rule.roles.includes(user.role as UserRole)) {
        return { allowed: true };
      }
    }
  }

  if (
    user.role === "department_viewer" &&
    ["POST", "PUT", "PATCH", "DELETE"].includes(method)
  ) {
    return {
      allowed: false,
      error: "Read-only access: write operations not permitted",
    };
  }

  for (const rule of ROUTE_PERMISSION_MAP) {
    if (rule.pattern.test(path) && rule.methods.includes(method)) {
      if (user.role === "admin") return { allowed: true };

      if (rule.roles && !rule.roles.includes(user.role as UserRole)) {
        return {
          allowed: false,
          error: "Insufficient permissions for this operation",
        };
      }

      if (rule.permission) {
        const hasPermission = await checkPermission(
          user.email,
          rule.permission,
        );
        if (!hasPermission) {
          return {
            allowed: false,
            error: "Insufficient permissions for this operation",
          };
        }
      }

      return { allowed: true };
    }
  }

  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    if (!WRITE_ROLES.includes(user.role as UserRole)) {
      return {
        allowed: false,
        error: "Insufficient role for write operations",
      };
    }
  }

  // Task #352 — deny-by-default for `/api/*` paths.  Routes that fall through
  // every ROUTE_PERMISSION_MAP entry above are denied so that newly-added
  // `/api/*` endpoints are fail-closed until an explicit map rule covers them.
  // Non-API paths (page handlers under `/projects`, `/onboarding`, etc.) keep
  // the previous permissive default and rely on the page-auth middleware.
  if (path.startsWith("/api/")) {
    return { allowed: false, error: "Route not authorised by RBAC policy" };
  }

  return { allowed: true };
}

/**
 * Pure permission-map lookup — returns the role allowlist of the FIRST
 * `ROUTE_PERMISSION_MAP` entry whose pattern matches `path` and whose
 * `methods` includes `method`. Mirrors the first-match semantics of
 * `canAccessRoute` and the dominant rule used by `enforceRoutePermission`.
 *
 * Returns:
 *   - the matching rule's `roles` array (cloned) when the rule has a static
 *     allowlist; or
 *   - `null` when no rule matches, OR when the matching rule uses a
 *     dynamic `permission` ACL instead of a static `roles` list (the
 *     latter cannot be statically mirrored by a page-shell gate).
 *
 * Public so the page-shell <-> API allowlist drift test in
 * `tests/staticPageRoleAllowlistDrift.test.ts` can compute the effective
 * GET allowlist for each gated dashboard route's backing `/api/*` path
 * without re-parsing `ROUTE_PERMISSION_MAP` itself.
 */
export function getRouteRoleAllowlist(
  path: string,
  method: string,
): readonly UserRole[] | null {
  for (const rule of ROUTE_PERMISSION_MAP) {
    if (rule.pattern.test(path) && rule.methods.includes(method)) {
      return rule.roles ? [...rule.roles] : null;
    }
  }
  return null;
}

/**
 * Pure permission-map lookup — no DB calls, no session parsing.
 * Used by unit tests to assert that the ROUTE_PERMISSION_MAP is correctly
 * configured for a given (role, path, method) triple.
 */
export function canAccessRoute(
  role: string,
  path: string,
  method: string,
): boolean {
  // Task #352 — admin bypass only fires when a ROUTE_PERMISSION_MAP rule
  // matches.  Mirrors `enforceRoutePermission`, where the admin shortcut
  // lives inside the rule-match loop, so an unmatched `/api/*` path is
  // denied for every role (including admin) by the deny-by-default
  // fallback below.
  for (const rule of ROUTE_PERMISSION_MAP) {
    if (rule.pattern.test(path) && rule.methods.includes(method)) {
      if (role === "admin") return true;
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
  if (path.startsWith("/api/")) {
    return false;
  }
  return true;
}
