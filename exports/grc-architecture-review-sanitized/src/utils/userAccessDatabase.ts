import crypto from "crypto";
import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";
import { redactSensitiveDeep } from "./sensitiveRedaction";

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

// ──────────────────────────────────────────────────────────────────────────────
// UI language preference (Task #746)
//
// Moved out of `src/mastra/routes/i18nRoutes.ts` so the only INSERT/UPDATE
// against `platform_users.ui_language` lives next to the rest of the
// platform_users writes and the secret-leak coverage gate doesn't have to
// track that route file separately.
// ──────────────────────────────────────────────────────────────────────────────
export async function ensureUiLanguageColumn(): Promise<void> {
  try {
    await pool.query(
      `ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS ui_language VARCHAR(10) DEFAULT 'en'`,
    );
  } catch (_) {}
}

export async function getUserLanguagePreference(
  userId: number,
): Promise<string | null> {
  const result = await pool.query(
    "SELECT ui_language FROM platform_users WHERE id = $1",
    [userId],
  );
  return result.rows[0]?.ui_language ?? null;
}

export async function setUserLanguagePreference(
  userId: number,
  lang: string,
): Promise<void> {
  await pool.query(
    "UPDATE platform_users SET ui_language = $1 WHERE id = $2",
    [lang, userId],
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// OIDC upsert (Task #746)
//
// Moved out of `src/mastra/routes/authRoutes.ts`. authRoutes still re-exports
// `upsertOidcUser` from this module for back-compat with existing imports
// (e.g. its companion secret-leak test).
// ──────────────────────────────────────────────────────────────────────────────
let oidcAuthTablesReady: Promise<void> | null = null;
async function ensureOidcAuthTables(): Promise<void> {
  if (oidcAuthTablesReady) return oidcAuthTablesReady;
  oidcAuthTablesReady = pool
    .query(
      `
    ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS IdentityProvider_id VARCHAR(255);
    ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS picture TEXT;
    ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(50) DEFAULT 'local';
  `,
    )
    .then(() => undefined)
    .catch(async () => {
      await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        team VARCHAR(50) NOT NULL DEFAULT 'Other',
        role VARCHAR(50) NOT NULL DEFAULT 'department_viewer',
        status VARCHAR(30) DEFAULT 'active',
        password_hash VARCHAR(255),
        mfa_enabled BOOLEAN DEFAULT FALSE,
        mfa_secret VARCHAR(255),
        invitation_id INTEGER,
        access_reason TEXT,
        approved_by VARCHAR(255),
        approved_at TIMESTAMP,
        denied_by VARCHAR(255),
        denied_at TIMESTAMP,
        denial_reason TEXT,
        last_login_at TIMESTAMP,
        login_count INTEGER DEFAULT 0,
        IdentityProvider_id VARCHAR(255),
        picture TEXT,
        auth_provider VARCHAR(50) DEFAULT 'local',
        ui_language VARCHAR(10) DEFAULT 'en',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    });
  return oidcAuthTablesReady;
}

/**
 * Returns the lowercased set of admin emails declared via the
 * `ADMIN_BOOTSTRAP_EMAILS` environment variable (comma- or whitespace-
 * separated). Used by `upsertOidcUser()` to auto-promote configured
 * operators to `admin`/`active` on OIDC login so role state survives
 * fresh deployments and DB resets.
 *
 * Exported for unit tests; production callers should go through
 * `upsertOidcUser()`.
 */
export function getAdminBootstrapEmails(): Set<string> {
  const raw = process.env.ADMIN_BOOTSTRAP_EMAILS;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0 && e.includes("@")),
  );
}

/**
 * Upsert a `platform_users` row from an OIDC profile callback.
 *
 * Free-text fields are scrubbed via `redactSensitiveDeep()` BEFORE any
 * SELECT/INSERT/UPDATE so a hostile or misconfigured upstream IdP cannot
 * smuggle a `password_hash`, `access_token`, JWT, SourceControlProvider PAT (`ghp_…`) or
 * `sk-…` token into `full_name` / `picture`.
 *
 * Admin bootstrap: if the caller's email is listed in the
 * `ADMIN_BOOTSTRAP_EMAILS` env var (comma/space-separated), the row is
 * created or upgraded to `role='admin'` / `status='active'` instead of the
 * default `department_viewer` / `pending_approval`. This is the supported
 * way to seed admin access on a fresh production database — managing role
 * state via env vars keeps dev and prod in sync across republishes,
 * whereas DB-only role edits drift the first time prod is reseeded.
 */
export async function upsertOidcUser(profile: {
  sub: string;
  email: string;
  name: string;
  picture: string;
  /**
   * Which IdP the login came from — drives the audit trail
   * (platform_users.auth_provider). Optional for back-compat with older
   * callers that only ever ran on HostingPlatform; defaults to 'HostingPlatform' when
   * omitted.
   */
  authProvider?: "IdentityProvider" | "HostingPlatform" | "other";
}) {
  await ensureOidcAuthTables();

  const safeProfile = redactSensitiveDeep(profile) as typeof profile;
  const bootstrapEmails = getAdminBootstrapEmails();
  const isBootstrapAdmin = bootstrapEmails.has(
    safeProfile.email.toLowerCase(),
  );
  // Default to 'HostingPlatform' for back-compat: existing callers that don't
  // pass authProvider keep their historic behaviour. New auth routes pass
  // the inferred IdP name so post-migration logins are correctly
  // attributed in the platform_users.auth_provider column.
  const provider = profile.authProvider || "HostingPlatform";

  const existing = await pool.query(
    "SELECT * FROM platform_users WHERE email = $1",
    [safeProfile.email],
  );

  if (existing.rows.length > 0) {
    const existingUser = existing.rows[0];

    if (isBootstrapAdmin) {
      const result = await pool.query(
        `UPDATE platform_users
         SET IdentityProvider_id = $1, full_name = $2, picture = $3, auth_provider = $4,
             role = 'admin', status = 'active',
             last_login_at = NOW(), login_count = login_count + 1, updated_at = NOW()
         WHERE email = $5
         RETURNING *`,
        [
          safeProfile.sub,
          safeProfile.name,
          safeProfile.picture,
          provider,
          safeProfile.email,
        ],
      );
      return result.rows[0] || existingUser;
    }

    if (existingUser.status !== "active") {
      return existingUser;
    }
    const result = await pool.query(
      `UPDATE platform_users
       SET IdentityProvider_id = $1, full_name = $2, picture = $3, auth_provider = $4,
           last_login_at = NOW(), login_count = login_count + 1, updated_at = NOW()
       WHERE email = $5 AND status = 'active'
       RETURNING *`,
      [
        safeProfile.sub,
        safeProfile.name,
        safeProfile.picture,
        provider,
        safeProfile.email,
      ],
    );
    return result.rows[0] || existingUser;
  } else {
    const role = isBootstrapAdmin ? "admin" : "department_viewer";
    const status = isBootstrapAdmin ? "active" : "pending_approval";
    const result = await pool.query(
      `INSERT INTO platform_users (email, full_name, IdentityProvider_id, picture, auth_provider, team, role, status, mfa_enabled, login_count, last_login_at)
       VALUES ($1, $2, $3, $4, $5, 'Other', $6, $7, false, 0, NOW())
       RETURNING *`,
      [
        safeProfile.email,
        safeProfile.name,
        safeProfile.sub,
        safeProfile.picture,
        provider,
        role,
        status,
      ],
    );
    return result.rows[0];
  }
}

export type UserStatus =
  | "invited"
  | "pending_approval"
  | "active"
  | "denied"
  | "disabled";
export type UserRole =
  | "admin"
  | "quality_manager"
  | "quality_specialist"
  | "grc_manager"
  | "team_lead"
  | "department_viewer"
  | "auditor"
  | "ai_specialist"
  | "bu_owner"
  | "executive"
  | "custom";
export type TeamScope =
  | "SDR"
  | "Sales"
  | "Quality"
  | "GRC"
  | "Legal Specialist"
  | "Viewer"
  | "Other";
export type ModuleScope = "Leads" | "Deals" | "Accounts" | "Contacts" | "All";
export type PermissionAction =
  | "view"
  | "create"
  | "edit"
  | "delete"
  | "approve"
  | "assign"
  | "run_audit"
  | "export"
  | "upload"
  | "manage_settings"
  | "manage_users";

export interface UserInvitation {
  id?: number;
  email: string;
  full_name?: string;
  team: TeamScope;
  role: UserRole;
  token: string;
  token_expires_at: Date;
  require_mfa: boolean;
  invited_by: string;
  used: boolean;
  used_at?: Date;
  created_at?: Date;
}

export interface PlatformUser {
  id?: number;
  email: string;
  full_name: string;
  team: TeamScope;
  role: UserRole;
  status: UserStatus;
  password_hash?: string;
  mfa_enabled: boolean;
  mfa_secret?: string;
  invitation_id?: number;
  access_reason?: string;
  approved_by?: string;
  approved_at?: Date;
  denied_by?: string;
  denied_at?: Date;
  denial_reason?: string;
  last_login_at?: Date;
  login_count: number;
  created_at?: Date;
  updated_at?: Date;
}

export interface ScreenPermission {
  id?: number;
  user_id: number;
  screen_code: string;
  screen_name: string;
  can_view: boolean;
  can_create: boolean;
  can_edit: boolean;
  can_delete: boolean;
  can_approve: boolean;
  can_assign: boolean;
  can_run_audit: boolean;
  can_export: boolean;
  can_upload: boolean;
  can_manage_settings: boolean;
  can_manage_users: boolean;
  created_at?: Date;
  updated_at?: Date;
}

export interface DataScope {
  id?: number;
  user_id: number;
  team_scope: TeamScope[];
  module_scope: ModuleScope[];
  record_scope: "all" | "assigned" | "team";
  created_at?: Date;
  updated_at?: Date;
}

export interface AccessAuditLog {
  id?: number;
  event_type: string;
  user_email: string;
  target_email?: string;
  action: string;
  details: any;
  performed_by: string;
  ip_address?: string;
  created_at?: Date;
}

export const SCREEN_LIST = [
  { code: "governance_documents", name: "Governance Documents" },
  { code: "evaluation_scorecards", name: "Evaluation Scorecards" },
  { code: "run_ai_audit", name: "Run AI Audit" },
  { code: "audit_history", name: "Audit History" },
  { code: "issues_nc", name: "Issues / Nonconformances" },
  { code: "capa", name: "CAPA" },
  { code: "training", name: "Training" },
  { code: "framework", name: "Framework" },
  { code: "analytics", name: "Analytics" },
  { code: "kpi_engine", name: "KPI Engine" },
  { code: "executive_dashboard", name: "Executive Dashboard" },
  { code: "risk_register", name: "Risk Register" },
  { code: "policies", name: "Policies" },
  { code: "compliance", name: "Compliance" },
  { code: "vendors", name: "Vendor Management" },
  { code: "pdpl", name: "PDPL Compliance" },
  { code: "call_intelligence", name: "Call Intelligence" },
  { code: "roi_npv", name: "ROI & NPV" },
  { code: "team_performance", name: "Team Performance" },
  { code: "projects", name: "Projects" },
  { code: "settings", name: "Settings" },
  { code: "admin_users", name: "Admin - Users & Access" },
];

export const DEFAULT_ROLE_PERMISSIONS: Record<
  UserRole,
  Partial<ScreenPermission>
> = {
  admin: {
    can_view: true,
    can_create: true,
    can_edit: true,
    can_delete: true,
    can_approve: true,
    can_assign: true,
    can_run_audit: true,
    can_export: true,
    can_upload: true,
    can_manage_settings: true,
    can_manage_users: true,
  },
  quality_manager: {
    can_view: true,
    can_create: true,
    can_edit: true,
    can_delete: false,
    can_approve: true,
    can_assign: true,
    can_run_audit: true,
    can_export: true,
    can_upload: true,
    can_manage_settings: false,
    can_manage_users: false,
  },
  quality_specialist: {
    can_view: true,
    can_create: true,
    can_edit: true,
    can_delete: false,
    can_approve: false,
    can_assign: false,
    can_run_audit: true,
    can_export: true,
    can_upload: true,
    can_manage_settings: false,
    can_manage_users: false,
  },
  grc_manager: {
    can_view: true,
    can_create: true,
    can_edit: true,
    can_delete: false,
    can_approve: true,
    can_assign: true,
    can_run_audit: false,
    can_export: true,
    can_upload: true,
    can_manage_settings: false,
    can_manage_users: false,
  },
  team_lead: {
    can_view: true,
    can_create: false,
    can_edit: false,
    can_delete: false,
    can_approve: false,
    can_assign: false,
    can_run_audit: false,
    can_export: true,
    can_upload: false,
    can_manage_settings: false,
    can_manage_users: false,
  },
  department_viewer: {
    can_view: true,
    can_create: false,
    can_edit: false,
    can_delete: false,
    can_approve: false,
    can_assign: false,
    can_run_audit: false,
    can_export: false,
    can_upload: false,
    can_manage_settings: false,
    can_manage_users: false,
  },
  auditor: {
    can_view: true,
    can_create: false,
    can_edit: false,
    can_delete: false,
    can_approve: false,
    can_assign: false,
    can_run_audit: false,
    can_export: false,
    can_upload: false,
    can_manage_settings: false,
    can_manage_users: false,
  },
  custom: {
    can_view: false,
    can_create: false,
    can_edit: false,
    can_delete: false,
    can_approve: false,
    can_assign: false,
    can_run_audit: false,
    can_export: false,
    can_upload: false,
    can_manage_settings: false,
    can_manage_users: false,
  },
  ai_specialist: {
    can_view: true,
    can_create: true,
    can_edit: true,
    can_delete: false,
    can_approve: false,
    can_assign: false,
    can_run_audit: true,
    can_export: true,
    can_upload: true,
    can_manage_settings: false,
    can_manage_users: false,
  },
  bu_owner: {
    can_view: true,
    can_create: true,
    can_edit: true,
    can_delete: false,
    can_approve: true,
    can_assign: true,
    can_run_audit: false,
    can_export: true,
    can_upload: true,
    can_manage_settings: false,
    can_manage_users: false,
  },
  executive: {
    can_view: true,
    can_create: false,
    can_edit: false,
    can_delete: false,
    can_approve: true,
    can_assign: false,
    can_run_audit: false,
    can_export: true,
    can_upload: false,
    can_manage_settings: false,
    can_manage_users: false,
  },
};

export async function initUserAccessTables(): Promise<void> {
  logger.info("🔐 [UserAccess] Initializing user access tables...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_invitations (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      full_name VARCHAR(255),
      team VARCHAR(50) NOT NULL,
      role VARCHAR(50) NOT NULL,
      token VARCHAR(255) UNIQUE NOT NULL,
      token_expires_at TIMESTAMP NOT NULL,
      require_mfa BOOLEAN DEFAULT FALSE,
      invited_by VARCHAR(255) NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      full_name VARCHAR(255) NOT NULL,
      team VARCHAR(50) NOT NULL,
      role VARCHAR(50) NOT NULL,
      status VARCHAR(30) DEFAULT 'pending_approval',
      password_hash VARCHAR(255),
      mfa_enabled BOOLEAN DEFAULT FALSE,
      mfa_secret VARCHAR(255),
      invitation_id INTEGER REFERENCES user_invitations(id),
      access_reason TEXT,
      approved_by VARCHAR(255),
      approved_at TIMESTAMP,
      denied_by VARCHAR(255),
      denied_at TIMESTAMP,
      denial_reason TEXT,
      last_login_at TIMESTAMP,
      login_count INTEGER DEFAULT 0,
      ui_language VARCHAR(10) DEFAULT 'en',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS screen_permissions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES platform_users(id) ON DELETE CASCADE,
      screen_code VARCHAR(100) NOT NULL,
      screen_name VARCHAR(255) NOT NULL,
      can_view BOOLEAN DEFAULT FALSE,
      can_create BOOLEAN DEFAULT FALSE,
      can_edit BOOLEAN DEFAULT FALSE,
      can_delete BOOLEAN DEFAULT FALSE,
      can_approve BOOLEAN DEFAULT FALSE,
      can_assign BOOLEAN DEFAULT FALSE,
      can_run_audit BOOLEAN DEFAULT FALSE,
      can_export BOOLEAN DEFAULT FALSE,
      can_upload BOOLEAN DEFAULT FALSE,
      can_manage_settings BOOLEAN DEFAULT FALSE,
      can_manage_users BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, screen_code)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS data_scopes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES platform_users(id) ON DELETE CASCADE UNIQUE,
      team_scope TEXT[] DEFAULT '{}',
      module_scope TEXT[] DEFAULT '{}',
      record_scope VARCHAR(30) DEFAULT 'assigned',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_audit_log (
      id SERIAL PRIMARY KEY,
      event_type VARCHAR(100) NOT NULL,
      user_email VARCHAR(255),
      target_email VARCHAR(255),
      action VARCHAR(255) NOT NULL,
      details JSONB,
      performed_by VARCHAR(255) NOT NULL,
      ip_address VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_platform_users_status ON platform_users(status);
    CREATE INDEX IF NOT EXISTS idx_platform_users_email ON platform_users(email);
    CREATE INDEX IF NOT EXISTS idx_access_audit_log_event ON access_audit_log(event_type);
    CREATE INDEX IF NOT EXISTS idx_user_invitations_token ON user_invitations(token);
  `);

  logger.info("✅ [UserAccess] User access tables initialized");
}

function generateSecureToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export async function createInvitation(
  invitation: Omit<UserInvitation, "id" | "token" | "created_at">,
): Promise<UserInvitation> {
  const token = generateSecureToken();

  const result = await pool.query(
    `INSERT INTO user_invitations (email, full_name, team, role, token, token_expires_at, require_mfa, invited_by, used)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)
     RETURNING *`,
    [
      invitation.email,
      invitation.full_name,
      invitation.team,
      invitation.role,
      token,
      invitation.token_expires_at,
      invitation.require_mfa,
      invitation.invited_by,
    ],
  );

  await logAccessEvent({
    event_type: "INVITATION_CREATED",
    user_email: invitation.invited_by,
    target_email: invitation.email,
    action: `Invited ${invitation.email} as ${invitation.role}`,
    details: {
      team: invitation.team,
      role: invitation.role,
      expires: invitation.token_expires_at,
    },
    performed_by: invitation.invited_by,
  });

  logger.info(`📧 [UserAccess] Invitation created for ${invitation.email}`);
  return result.rows[0];
}

export async function validateInvitationToken(
  token: string,
): Promise<UserInvitation | null> {
  const result = await pool.query(
    `SELECT * FROM user_invitations WHERE token = $1 AND used = false AND token_expires_at > NOW()`,
    [token],
  );
  return result.rows[0] || null;
}

export async function acceptInvitation(
  token: string,
  userData: {
    full_name: string;
    password_hash?: string;
    access_reason?: string;
  },
): Promise<PlatformUser | null> {
  const invitation = await validateInvitationToken(token);
  if (!invitation) {
    return null;
  }

  await pool.query(
    `UPDATE user_invitations SET used = true, used_at = NOW() WHERE token = $1`,
    [token],
  );

  const result = await pool.query(
    `INSERT INTO platform_users (email, full_name, team, role, status, password_hash, mfa_enabled, invitation_id, access_reason)
     VALUES ($1, $2, $3, $4, 'pending_approval', $5, $6, $7, $8)
     RETURNING *`,
    [
      invitation.email,
      userData.full_name || invitation.full_name,
      invitation.team,
      invitation.role,
      userData.password_hash,
      invitation.require_mfa,
      invitation.id,
      userData.access_reason,
    ],
  );

  const user = result.rows[0];

  await createDefaultPermissions(user.id, invitation.role as UserRole);
  await createDefaultDataScope(user.id, invitation.team as TeamScope);

  await logAccessEvent({
    event_type: "INVITATION_ACCEPTED",
    user_email: invitation.email,
    target_email: invitation.email,
    action: "Accepted invitation and submitted access request",
    details: { invitation_id: invitation.id },
    performed_by: invitation.email,
  });

  logger.info(
    `✅ [UserAccess] Invitation accepted by ${invitation.email}, pending approval`,
  );
  return user;
}

export async function createDefaultPermissions(
  userId: number,
  role: UserRole,
): Promise<void> {
  const roleDefaults =
    DEFAULT_ROLE_PERMISSIONS[role] || DEFAULT_ROLE_PERMISSIONS.custom;

  for (const screen of SCREEN_LIST) {
    await pool.query(
      `INSERT INTO screen_permissions 
       (user_id, screen_code, screen_name, can_view, can_create, can_edit, can_delete, can_approve, can_assign, can_run_audit, can_export, can_upload, can_manage_settings, can_manage_users)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (user_id, screen_code) DO UPDATE SET
         can_view = $4, can_create = $5, can_edit = $6, can_delete = $7, can_approve = $8, can_assign = $9,
         can_run_audit = $10, can_export = $11, can_upload = $12, can_manage_settings = $13, can_manage_users = $14`,
      [
        userId,
        screen.code,
        screen.name,
        roleDefaults.can_view,
        roleDefaults.can_create,
        roleDefaults.can_edit,
        roleDefaults.can_delete,
        roleDefaults.can_approve,
        roleDefaults.can_assign,
        roleDefaults.can_run_audit,
        roleDefaults.can_export,
        roleDefaults.can_upload,
        roleDefaults.can_manage_settings,
        roleDefaults.can_manage_users,
      ],
    );
  }
}

export async function createDefaultDataScope(
  userId: number,
  team: TeamScope,
): Promise<void> {
  let teamScope: TeamScope[] = [team];
  let moduleScope: ModuleScope[] = [];
  let recordScope: "all" | "assigned" | "team" = "assigned";

  switch (team) {
    case "SDR":
      moduleScope = ["Leads"];
      recordScope = "team";
      break;
    case "Sales":
      moduleScope = ["Deals", "Accounts", "Contacts"];
      recordScope = "team";
      break;
    case "Quality":
      moduleScope = ["All"];
      recordScope = "all";
      teamScope = ["SDR", "Sales", "Quality", "GRC"];
      break;
    case "GRC":
      moduleScope = ["All"];
      recordScope = "all";
      break;
    case "Legal Specialist":
      // Legal team needs cross-module visibility (contracts, compliance
      // evidence, vendor records, governance docs). Matches the GRC
      // scope shape — Legal often partners with GRC on compliance work.
      moduleScope = ["All"];
      recordScope = "all";
      break;
    default:
      moduleScope = [];
      recordScope = "assigned";
  }

  await pool.query(
    `INSERT INTO data_scopes (user_id, team_scope, module_scope, record_scope)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       team_scope = $2, module_scope = $3, record_scope = $4, updated_at = NOW()`,
    [userId, teamScope, moduleScope, recordScope],
  );
}

export async function approveAccessRequest(
  userId: number,
  approvedBy: string,
  permissionOverrides?: Partial<ScreenPermission>[],
): Promise<PlatformUser | null> {
  const result = await pool.query(
    `UPDATE platform_users SET status = 'active', approved_by = $1, approved_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND status = 'pending_approval'
     RETURNING *`,
    [approvedBy, userId],
  );

  const user = result.rows[0];
  if (!user) return null;

  try {
    const { invalidatePlatformUserCache } = await import("./rbacMiddleware");
    invalidatePlatformUserCache(user.email);
  } catch {}

  if (permissionOverrides && permissionOverrides.length > 0) {
    for (const perm of permissionOverrides) {
      if (perm.screen_code) {
        await pool.query(
          `UPDATE screen_permissions SET
             can_view = COALESCE($1, can_view), can_create = COALESCE($2, can_create), can_edit = COALESCE($3, can_edit),
             can_delete = COALESCE($4, can_delete), can_approve = COALESCE($5, can_approve), can_assign = COALESCE($6, can_assign),
             can_run_audit = COALESCE($7, can_run_audit), can_export = COALESCE($8, can_export), can_upload = COALESCE($9, can_upload),
             can_manage_settings = COALESCE($10, can_manage_settings), can_manage_users = COALESCE($11, can_manage_users),
             updated_at = NOW()
           WHERE user_id = $12 AND screen_code = $13`,
          [
            perm.can_view,
            perm.can_create,
            perm.can_edit,
            perm.can_delete,
            perm.can_approve,
            perm.can_assign,
            perm.can_run_audit,
            perm.can_export,
            perm.can_upload,
            perm.can_manage_settings,
            perm.can_manage_users,
            userId,
            perm.screen_code,
          ],
        );
      }
    }
  }

  await logAccessEvent({
    event_type: "ACCESS_APPROVED",
    user_email: approvedBy,
    target_email: user.email,
    action: `Approved access for ${user.email}`,
    details: { user_id: userId, role: user.role },
    performed_by: approvedBy,
  });

  logger.info(
    `✅ [UserAccess] Access approved for ${user.email} by ${approvedBy}`,
  );
  return user;
}

export async function denyAccessRequest(
  userId: number,
  deniedBy: string,
  reason?: string,
): Promise<PlatformUser | null> {
  const result = await pool.query(
    `UPDATE platform_users SET status = 'denied', denied_by = $1, denied_at = NOW(), denial_reason = $2, updated_at = NOW()
     WHERE id = $3 AND status = 'pending_approval'
     RETURNING *`,
    [deniedBy, reason, userId],
  );

  const user = result.rows[0];
  if (!user) return null;

  try {
    const { invalidatePlatformUserCache } = await import("./rbacMiddleware");
    invalidatePlatformUserCache(user.email);
  } catch {}

  await logAccessEvent({
    event_type: "ACCESS_DENIED",
    user_email: deniedBy,
    target_email: user.email,
    action: `Denied access for ${user.email}`,
    details: { user_id: userId, reason },
    performed_by: deniedBy,
  });

  logger.info(`❌ [UserAccess] Access denied for ${user.email} by ${deniedBy}`);
  return user;
}

export async function disableUser(
  userId: number,
  disabledBy: string,
): Promise<PlatformUser | null> {
  const result = await pool.query(
    `UPDATE platform_users SET status = 'disabled', updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [userId],
  );

  const user = result.rows[0];
  if (!user) return null;

  try {
    const { invalidatePlatformUserCache } = await import("./rbacMiddleware");
    invalidatePlatformUserCache(user.email);
  } catch {}

  await logAccessEvent({
    event_type: "USER_DISABLED",
    user_email: disabledBy,
    target_email: user.email,
    action: `Disabled user ${user.email}`,
    details: { user_id: userId },
    performed_by: disabledBy,
  });

  return user;
}

export async function enableUser(
  userId: number,
  enabledBy: string,
): Promise<PlatformUser | null> {
  const result = await pool.query(
    `UPDATE platform_users SET status = 'active', updated_at = NOW()
     WHERE id = $1 AND status = 'disabled' RETURNING *`,
    [userId],
  );

  const user = result.rows[0];
  if (!user) return null;

  try {
    const { invalidatePlatformUserCache } = await import("./rbacMiddleware");
    invalidatePlatformUserCache(user.email);
  } catch {}

  await logAccessEvent({
    event_type: "USER_ENABLED",
    user_email: enabledBy,
    target_email: user.email,
    action: `Enabled user ${user.email}`,
    details: { user_id: userId },
    performed_by: enabledBy,
  });

  return user;
}

export async function updateUserRole(
  userId: number,
  newRole: UserRole,
  updatedBy: string,
): Promise<PlatformUser | null> {
  const result = await pool.query(
    `UPDATE platform_users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [newRole, userId],
  );

  const user = result.rows[0];
  if (!user) return null;

  try {
    const { invalidatePlatformUserCache } = await import("./rbacMiddleware");
    invalidatePlatformUserCache(user.email);
  } catch {}

  await createDefaultPermissions(userId, newRole);

  await logAccessEvent({
    event_type: "ROLE_CHANGED",
    user_email: updatedBy,
    target_email: user.email,
    action: `Changed role to ${newRole}`,
    details: { user_id: userId, new_role: newRole },
    performed_by: updatedBy,
  });

  return user;
}

export async function updateUserProfile(
  userId: number,
  patch: { full_name?: string; team?: string; role?: UserRole },
  updatedBy: string,
): Promise<PlatformUser | null> {
  const sets: string[] = [];
  const params: any[] = [];
  let i = 1;
  if (patch.full_name !== undefined) {
    sets.push(`full_name = $${i++}`);
    params.push(patch.full_name);
  }
  if (patch.team !== undefined) {
    sets.push(`team = $${i++}`);
    params.push(patch.team);
  }
  if (patch.role !== undefined) {
    sets.push(`role = $${i++}`);
    params.push(patch.role);
  }
  if (sets.length === 0) {
    return await getUserById(userId);
  }
  sets.push(`updated_at = NOW()`);
  params.push(userId);

  const result = await pool.query(
    `UPDATE platform_users SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    params,
  );
  const user = result.rows[0];
  if (!user) return null;

  try {
    const { invalidatePlatformUserCache } = await import("./rbacMiddleware");
    invalidatePlatformUserCache(user.email);
  } catch {}

  if (patch.role !== undefined) {
    await createDefaultPermissions(userId, patch.role);
  }

  await logAccessEvent({
    event_type: "USER_UPDATED",
    user_email: updatedBy,
    target_email: user.email,
    action: `Updated profile (${Object.keys(patch).join(", ")})`,
    details: { user_id: userId, patch },
    performed_by: updatedBy,
  });

  return user;
}

export async function deleteUser(
  userId: number,
  deletedBy: string,
): Promise<{ deleted: boolean; email: string | null }> {
  const existing = await getUserById(userId);
  if (!existing) return { deleted: false, email: null };

  await pool.query(`DELETE FROM platform_users WHERE id = $1`, [userId]);

  try {
    const { invalidatePlatformUserCache } = await import("./rbacMiddleware");
    invalidatePlatformUserCache(existing.email);
  } catch {}

  await logAccessEvent({
    event_type: "USER_DELETED",
    user_email: deletedBy,
    target_email: existing.email,
    action: `Hard-deleted user account`,
    details: { user_id: userId, email: existing.email },
    performed_by: deletedBy,
  });

  return { deleted: true, email: existing.email };
}

export async function updateUserPermissions(
  userId: number,
  permissions: Partial<ScreenPermission>[],
  updatedBy: string,
): Promise<void> {
  for (const perm of permissions) {
    if (perm.screen_code) {
      await pool.query(
        `UPDATE screen_permissions SET
           can_view = COALESCE($1, can_view), can_create = COALESCE($2, can_create), can_edit = COALESCE($3, can_edit),
           can_delete = COALESCE($4, can_delete), can_approve = COALESCE($5, can_approve), can_assign = COALESCE($6, can_assign),
           can_run_audit = COALESCE($7, can_run_audit), can_export = COALESCE($8, can_export), can_upload = COALESCE($9, can_upload),
           can_manage_settings = COALESCE($10, can_manage_settings), can_manage_users = COALESCE($11, can_manage_users),
           updated_at = NOW()
         WHERE user_id = $12 AND screen_code = $13`,
        [
          perm.can_view,
          perm.can_create,
          perm.can_edit,
          perm.can_delete,
          perm.can_approve,
          perm.can_assign,
          perm.can_run_audit,
          perm.can_export,
          perm.can_upload,
          perm.can_manage_settings,
          perm.can_manage_users,
          userId,
          perm.screen_code,
        ],
      );
    }
  }

  await logAccessEvent({
    event_type: "PERMISSIONS_CHANGED",
    user_email: updatedBy,
    target_email: (await getUserById(userId))?.email,
    action: "Updated screen permissions",
    details: {
      user_id: userId,
      screens_modified: permissions.map((p) => p.screen_code),
    },
    performed_by: updatedBy,
  });
}

export async function getPendingApprovals(): Promise<PlatformUser[]> {
  const result = await pool.query(
    `SELECT * FROM platform_users WHERE status = 'pending_approval' ORDER BY created_at DESC`,
  );
  return result.rows;
}

export async function getActiveUsers(): Promise<PlatformUser[]> {
  const result = await pool.query(
    `SELECT * FROM platform_users WHERE status = 'active' ORDER BY full_name`,
  );
  return result.rows;
}

export async function getAllUsers(): Promise<PlatformUser[]> {
  const result = await pool.query(
    `SELECT * FROM platform_users ORDER BY created_at DESC`,
  );
  return result.rows;
}

export async function getUserById(
  userId: number,
): Promise<PlatformUser | null> {
  const result = await pool.query(
    `SELECT * FROM platform_users WHERE id = $1`,
    [userId],
  );
  return result.rows[0] || null;
}

export async function getUserByEmail(
  email: string,
): Promise<PlatformUser | null> {
  const result = await pool.query(
    `SELECT * FROM platform_users WHERE email = $1`,
    [email],
  );
  return result.rows[0] || null;
}

export async function getUserPermissions(
  userId: number,
): Promise<ScreenPermission[]> {
  const result = await pool.query(
    `SELECT * FROM screen_permissions WHERE user_id = $1 ORDER BY screen_name`,
    [userId],
  );
  return result.rows;
}

export async function getUserDataScope(
  userId: number,
): Promise<DataScope | null> {
  const result = await pool.query(
    `SELECT * FROM data_scopes WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0] || null;
}

export async function getInvitations(): Promise<UserInvitation[]> {
  const result = await pool.query(
    `SELECT * FROM user_invitations ORDER BY created_at DESC`,
  );
  return result.rows;
}

export async function logAccessEvent(
  event: Omit<AccessAuditLog, "id" | "created_at">,
): Promise<void> {
  await pool.query(
    `INSERT INTO access_audit_log (event_type, user_email, target_email, action, details, performed_by, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      event.event_type,
      event.user_email,
      event.target_email,
      event.action,
      JSON.stringify(event.details || {}),
      event.performed_by,
      event.ip_address,
    ],
  );
}

export async function getAccessAuditLog(filters?: {
  event_type?: string;
  target_email?: string;
  limit?: number;
}): Promise<AccessAuditLog[]> {
  let query = "SELECT * FROM access_audit_log WHERE 1=1";
  const params: any[] = [];
  let idx = 1;

  if (filters?.event_type) {
    query += ` AND event_type = $${idx++}`;
    params.push(filters.event_type);
  }
  if (filters?.target_email) {
    query += ` AND target_email = $${idx++}`;
    params.push(filters.target_email);
  }

  query += " ORDER BY created_at DESC";

  if (filters?.limit) {
    query += ` LIMIT $${idx++}`;
    params.push(filters.limit);
  }

  const result = await pool.query(query, params);
  return result.rows;
}

export async function getUserStats(): Promise<{
  total: number;
  active: number;
  pending: number;
  denied: number;
  disabled: number;
  byRole: { role: string; count: number }[];
  byTeam: { team: string; count: number }[];
}> {
  const [totals, byRole, byTeam] = await Promise.all([
    pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'active') as active,
        COUNT(*) FILTER (WHERE status = 'pending_approval') as pending,
        COUNT(*) FILTER (WHERE status = 'denied') as denied,
        COUNT(*) FILTER (WHERE status = 'disabled') as disabled
      FROM platform_users
    `),
    pool.query(`
      SELECT role, COUNT(*) as count FROM platform_users GROUP BY role ORDER BY count DESC
    `),
    pool.query(`
      SELECT team, COUNT(*) as count FROM platform_users GROUP BY team ORDER BY count DESC
    `),
  ]);

  return {
    total: parseInt(totals.rows[0].total),
    active: parseInt(totals.rows[0].active),
    pending: parseInt(totals.rows[0].pending),
    denied: parseInt(totals.rows[0].denied),
    disabled: parseInt(totals.rows[0].disabled),
    byRole: byRole.rows.map((r) => ({
      role: r.role,
      count: parseInt(r.count),
    })),
    byTeam: byTeam.rows.map((r) => ({
      team: r.team,
      count: parseInt(r.count),
    })),
  };
}
