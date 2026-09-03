import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

export type UserRole =
  | "admin"
  | "head_of_operations_quality"
  | "quality_manager"
  | "quality_specialist"
  | "grc_manager"
  | "team_lead"
  | "department_viewer"
  // `viewer` is a generic read-only role admitted by many GET rules in
  // ROUTE_PERMISSION_MAP (rbacMiddleware.ts) but was missing from this
  // canonical union, which caused ~80 TS2322 errors at every site that
  // listed it. Added so the type matches the runtime contract used by
  // the middleware and the platform_users table. The other UserRole
  // definition in userAccessDatabase.ts already includes it.
  | "viewer"
  | "auditor"
  | "ai_specialist"
  | "bu_owner"
  | "executive"
  | "custom";

export interface SystemUser {
  id?: number;
  email: string;
  name: string;
  role: UserRole;
  department?: string;
  is_active: boolean;
  permissions?: string[];
  created_at?: Date;
  updated_at?: Date;
}

export interface BuProcess {
  id?: number;
  process_code: string;
  process_name: string;
  department: string;
  owner_name?: string;
  owner_email?: string;
  description?: string;
  is_active: boolean;
  linked_control_ids?: number[];
  created_at?: Date;
  updated_at?: Date;
}

export interface RolePermission {
  role: UserRole;
  can_accept_risk: boolean;
  can_approve_policy: boolean;
  can_close_finding: boolean;
  can_manage_users: boolean;
  can_view_executive: boolean;
  can_edit_controls: boolean;
  can_create_capa: boolean;
  can_submit_evidence: boolean;
}

const ROLE_PERMISSIONS: RolePermission[] = [
  // Head of Operations & Quality — signs off annual audit programme (ISO 19011 §5.2).
  // Full audit-side powers (close findings, edit controls, create CAPA) and
  // executive visibility, but not general user admin.
  {
    role: "head_of_operations_quality",
    can_accept_risk: true,
    can_approve_policy: true,
    can_close_finding: true,
    can_manage_users: false,
    can_view_executive: true,
    can_edit_controls: true,
    can_create_capa: true,
    can_submit_evidence: true,
  },
  {
    role: "quality_manager",
    can_accept_risk: false,
    can_approve_policy: false,
    can_close_finding: true,
    can_manage_users: false,
    can_view_executive: false,
    can_edit_controls: true,
    can_create_capa: true,
    can_submit_evidence: true,
  },
  {
    role: "grc_manager",
    can_accept_risk: true,
    can_approve_policy: true,
    can_close_finding: true,
    can_manage_users: false,
    can_view_executive: true,
    can_edit_controls: true,
    can_create_capa: true,
    can_submit_evidence: true,
  },
  {
    role: "ai_specialist",
    can_accept_risk: false,
    can_approve_policy: false,
    can_close_finding: false,
    can_manage_users: false,
    can_view_executive: true,
    can_edit_controls: false,
    can_create_capa: false,
    can_submit_evidence: false,
  },
  {
    role: "bu_owner",
    can_accept_risk: false,
    can_approve_policy: false,
    can_close_finding: false,
    can_manage_users: false,
    can_view_executive: false,
    can_edit_controls: false,
    can_create_capa: false,
    can_submit_evidence: true,
  },
  {
    role: "executive",
    can_accept_risk: false,
    can_approve_policy: false,
    can_close_finding: false,
    can_manage_users: false,
    can_view_executive: true,
    can_edit_controls: false,
    can_create_capa: false,
    can_submit_evidence: false,
  },
  {
    role: "admin",
    can_accept_risk: true,
    can_approve_policy: true,
    can_close_finding: true,
    can_manage_users: true,
    can_view_executive: true,
    can_edit_controls: true,
    can_create_capa: true,
    can_submit_evidence: true,
  },
];

export async function initRbacTables(): Promise<void> {
  logger.info("🔐 [RBAC] Initializing RBAC tables...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'bu_owner',
      department VARCHAR(100),
      is_active BOOLEAN DEFAULT TRUE,
      permissions JSONB DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bu_processes (
      id SERIAL PRIMARY KEY,
      process_code VARCHAR(50) UNIQUE NOT NULL,
      process_name VARCHAR(255) NOT NULL,
      department VARCHAR(100) NOT NULL,
      owner_name VARCHAR(255),
      owner_email VARCHAR(255),
      description TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      linked_control_ids INTEGER[],
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      id SERIAL PRIMARY KEY,
      role VARCHAR(50) UNIQUE NOT NULL,
      can_accept_risk BOOLEAN DEFAULT FALSE,
      can_approve_policy BOOLEAN DEFAULT FALSE,
      can_close_finding BOOLEAN DEFAULT FALSE,
      can_manage_users BOOLEAN DEFAULT FALSE,
      can_view_executive BOOLEAN DEFAULT FALSE,
      can_edit_controls BOOLEAN DEFAULT FALSE,
      can_create_capa BOOLEAN DEFAULT FALSE,
      can_submit_evidence BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS escalation_log (
      id SERIAL PRIMARY KEY,
      source_type VARCHAR(50) NOT NULL,
      source_id INTEGER NOT NULL,
      escalation_reason VARCHAR(255) NOT NULL,
      escalated_to VARCHAR(255),
      status VARCHAR(20) DEFAULT 'pending',
      resolved_at TIMESTAMP,
      resolved_by VARCHAR(255),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await addPolicyDualOwnership();
  await addControlReadinessFields();
  await addRiskRbacFields();
  await seedDefaultUsers();
  await seedDefaultProcesses();
  await seedRolePermissions();

  logger.info("✅ [RBAC] RBAC tables initialized");
}

async function addPolicyDualOwnership(): Promise<void> {
  logger.info("📋 [RBAC] Adding dual ownership fields to policies...");

  const columns = [
    { name: "operational_owner", type: "VARCHAR(255)" },
    { name: "operational_owner_email", type: "VARCHAR(255)" },
    { name: "compliance_owner", type: "VARCHAR(255)" },
    { name: "compliance_owner_email", type: "VARCHAR(255)" },
    { name: "compliance_approved", type: "BOOLEAN DEFAULT FALSE" },
    { name: "compliance_approved_by", type: "VARCHAR(255)" },
    { name: "compliance_approved_at", type: "TIMESTAMP" },
    { name: "approval_blocked_reason", type: "TEXT" },
  ];

  for (const col of columns) {
    try {
      await pool.query(
        `ALTER TABLE policies ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`,
      );
    } catch (e: any) {
      if (!e.message?.includes("already exists"))
        logger.error(`Error adding ${col.name}:`, e.message);
    }
  }
}

async function addControlReadinessFields(): Promise<void> {
  logger.info("📋 [RBAC] Adding control readiness fields...");

  const columns = [
    { name: "linked_bu_process_ids", type: "INTEGER[]" },
    { name: "evidence_status", type: "VARCHAR(20) DEFAULT 'none'" },
    { name: "readiness_status", type: "VARCHAR(20) DEFAULT 'not_ready'" },
    { name: "last_evidence_date", type: "TIMESTAMP" },
    { name: "testing_method", type: "VARCHAR(100)" },
  ];

  for (const col of columns) {
    try {
      await pool.query(
        `ALTER TABLE control_mappings ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`,
      );
    } catch (e: any) {
      if (!e.message?.includes("already exists"))
        logger.error(`Error adding ${col.name}:`, e.message);
    }
  }
}

async function addRiskRbacFields(): Promise<void> {
  logger.info("📋 [RBAC] Adding RBAC fields to enterprise_risks...");

  const columns = [
    { name: "accepted_by", type: "VARCHAR(255)" },
    { name: "accepted_by_role", type: "VARCHAR(50)" },
    { name: "accepted_at", type: "TIMESTAMP" },
    { name: "acceptance_justification", type: "TEXT" },
    { name: "grc_approval_required", type: "BOOLEAN DEFAULT TRUE" },
  ];

  for (const col of columns) {
    try {
      await pool.query(
        `ALTER TABLE enterprise_risks ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`,
      );
    } catch (e: any) {
      if (!e.message?.includes("already exists"))
        logger.error(`Error adding ${col.name}:`, e.message);
    }
  }
}

async function seedDefaultUsers(): Promise<void> {
  const existing = await pool.query("SELECT COUNT(*) FROM system_users");
  if (parseInt(existing.rows[0].count) > 0) return;

  logger.info("👤 [RBAC] Seeding default system users...");

  const users: SystemUser[] = [
    {
      email: "<REDACTED_EMAIL>",
      name: "Head of Operations & Quality",
      role: "head_of_operations_quality",
      department: "Operations & Quality",
      is_active: true,
    },
    {
      email: "<REDACTED_EMAIL>",
      name: "Sample User Al-Qahtani",
      role: "quality_manager",
      department: "Quality",
      is_active: true,
    },
    {
      email: "<REDACTED_EMAIL>",
      name: "Sample User Al-Rashid",
      role: "grc_manager",
      department: "GRC",
      is_active: true,
    },
    {
      email: "<REDACTED_EMAIL>",
      name: "System Admin",
      role: "admin",
      department: "IT",
      is_active: true,
    },
    {
      email: "<REDACTED_EMAIL>",
      name: "CEO Executive",
      role: "executive",
      department: "Executive",
      is_active: true,
    },
    {
      email: "<REDACTED_EMAIL>",
      name: "AI Specialist",
      role: "ai_specialist",
      department: "Technology",
      is_active: true,
    },
    {
      email: "<REDACTED_EMAIL>",
      name: "Operations Lead",
      role: "bu_owner",
      department: "Operations",
      is_active: true,
    },
  ];

  for (const user of users) {
    await pool.query(
      `INSERT INTO system_users (email, name, role, department, is_active) VALUES ($1, $2, $3, $4, $5)`,
      [user.email, user.name, user.role, user.department, user.is_active],
    );
  }
}

async function seedDefaultProcesses(): Promise<void> {
  const existing = await pool.query("SELECT COUNT(*) FROM bu_processes");
  if (parseInt(existing.rows[0].count) > 0) return;

  logger.info("📋 [RBAC] Seeding default BU processes...");

  const processes: BuProcess[] = [
    {
      process_code: "BU-OPS-001",
      process_name: "Customer Service Operations",
      department: "Operations",
      owner_name: "Sample User",
      is_active: true,
    },
    {
      process_code: "BU-SAL-001",
      process_name: "Sales Pipeline Management",
      department: "Sales",
      owner_name: "Sample User",
      is_active: true,
    },
    {
      process_code: "BU-FIN-001",
      process_name: "Financial Reporting",
      department: "Finance",
      owner_name: "Sample User",
      is_active: true,
    },
    {
      process_code: "BU-HR-001",
      process_name: "Employee Onboarding",
      department: "HR",
      owner_name: "Sample User",
      is_active: true,
    },
    {
      process_code: "BU-IT-001",
      process_name: "IT Change Management",
      department: "IT",
      owner_name: "Sample User",
      is_active: true,
    },
    {
      process_code: "BU-QA-001",
      process_name: "Quality Assurance Review",
      department: "Quality",
      owner_name: "Sample User",
      is_active: true,
    },
  ];

  for (const proc of processes) {
    await pool.query(
      `INSERT INTO bu_processes (process_code, process_name, department, owner_name, is_active) VALUES ($1, $2, $3, $4, $5)`,
      [
        proc.process_code,
        proc.process_name,
        proc.department,
        proc.owner_name,
        proc.is_active,
      ],
    );
  }
}

async function seedRolePermissions(): Promise<void> {
  for (const perm of ROLE_PERMISSIONS) {
    await pool.query(
      `
      INSERT INTO role_permissions (role, can_accept_risk, can_approve_policy, can_close_finding, can_manage_users, can_view_executive, can_edit_controls, can_create_capa, can_submit_evidence)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (role) DO UPDATE SET
        can_accept_risk = $2, can_approve_policy = $3, can_close_finding = $4, can_manage_users = $5,
        can_view_executive = $6, can_edit_controls = $7, can_create_capa = $8, can_submit_evidence = $9
    `,
      [
        perm.role,
        perm.can_accept_risk,
        perm.can_approve_policy,
        perm.can_close_finding,
        perm.can_manage_users,
        perm.can_view_executive,
        perm.can_edit_controls,
        perm.can_create_capa,
        perm.can_submit_evidence,
      ],
    );
  }
}

export async function getSystemUsers(filters?: {
  role?: UserRole;
  department?: string;
  active_only?: boolean;
}): Promise<SystemUser[]> {
  let query = "SELECT * FROM system_users WHERE 1=1";
  const params: any[] = [];
  let paramIndex = 1;

  if (filters?.role) {
    query += ` AND role = $${paramIndex++}`;
    params.push(filters.role);
  }
  if (filters?.department) {
    query += ` AND department = $${paramIndex++}`;
    params.push(filters.department);
  }
  if (filters?.active_only) {
    query += " AND is_active = TRUE";
  }

  query += " ORDER BY name";
  const result = await pool.query(query, params);
  return result.rows;
}

export async function getUserByEmail(
  email: string,
): Promise<SystemUser | null> {
  const result = await pool.query(
    "SELECT * FROM system_users WHERE email = $1",
    [email],
  );
  return result.rows[0] || null;
}

export async function createSystemUser(user: SystemUser): Promise<SystemUser> {
  logger.info("👤 [RBAC] Creating system user:", user.email);
  const result = await pool.query(
    `INSERT INTO system_users (email, name, role, department, is_active, permissions)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      user.email,
      user.name,
      user.role,
      user.department || null,
      user.is_active,
      JSON.stringify(user.permissions || []),
    ],
  );
  return result.rows[0];
}

export async function updateSystemUser(
  id: number,
  updates: Partial<SystemUser>,
): Promise<SystemUser> {
  logger.info("👤 [RBAC] Updating system user ID:", id);
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  const allowedFields = [
    "name",
    "role",
    "department",
    "is_active",
    "permissions",
  ];
  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      fields.push(`${key} = $${paramIndex++}`);
      values.push(key === "permissions" ? JSON.stringify(value) : value);
    }
  }

  fields.push("updated_at = NOW()");
  values.push(id);

  const result = await pool.query(
    `UPDATE system_users SET ${fields.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    values,
  );
  return result.rows[0];
}

export async function getRolePermissions(
  role: UserRole,
): Promise<RolePermission | null> {
  const result = await pool.query(
    "SELECT * FROM role_permissions WHERE role = $1",
    [role],
  );
  return result.rows[0] || null;
}

export async function checkPermission(
  userEmail: string,
  permission: keyof RolePermission,
): Promise<boolean> {
  logger.info(`🔐 [RBAC] Checking permission ${permission} for ${userEmail}`);
  const user = await getUserByEmail(userEmail);
  if (!user) {
    logger.info(`🔐 [RBAC] User not found: ${userEmail}`);
    return false;
  }

  const rolePerms = await getRolePermissions(user.role);
  if (!rolePerms) {
    logger.info(`🔐 [RBAC] Role permissions not found for: ${user.role}`);
    return false;
  }

  const hasPermission = rolePerms[permission] === true;
  logger.info(
    `🔐 [RBAC] Permission ${permission} for ${userEmail}: ${hasPermission}`,
  );
  return hasPermission;
}

export async function getBuProcesses(filters?: {
  department?: string;
  active_only?: boolean;
}): Promise<BuProcess[]> {
  let query = "SELECT * FROM bu_processes WHERE 1=1";
  const params: any[] = [];
  let paramIndex = 1;

  if (filters?.department) {
    query += ` AND department = $${paramIndex++}`;
    params.push(filters.department);
  }
  if (filters?.active_only) {
    query += " AND is_active = TRUE";
  }

  query += " ORDER BY process_code";
  const result = await pool.query(query, params);
  return result.rows;
}

export async function createBuProcess(process: BuProcess): Promise<BuProcess> {
  logger.info("📋 [RBAC] Creating BU process:", process.process_code);
  const result = await pool.query(
    `INSERT INTO bu_processes (process_code, process_name, department, owner_name, owner_email, description, is_active, linked_control_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      process.process_code,
      process.process_name,
      process.department,
      process.owner_name,
      process.owner_email,
      process.description,
      process.is_active,
      process.linked_control_ids || [],
    ],
  );
  return result.rows[0];
}

export async function updateBuProcess(
  id: number,
  updates: Partial<BuProcess>,
): Promise<BuProcess> {
  logger.info("📋 [RBAC] Updating BU process ID:", id);
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  const allowedFields = [
    "process_name",
    "department",
    "owner_name",
    "owner_email",
    "description",
    "is_active",
    "linked_control_ids",
  ];
  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      fields.push(`${key} = $${paramIndex++}`);
      values.push(value);
    }
  }

  fields.push("updated_at = NOW()");
  values.push(id);

  const result = await pool.query(
    `UPDATE bu_processes SET ${fields.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    values,
  );
  return result.rows[0];
}

export async function calculateControlReadiness(): Promise<{
  updated: number;
  not_ready: number;
  ready: number;
}> {
  logger.info("📊 [RBAC] Calculating control readiness...");

  const result = await pool.query(`
    UPDATE control_mappings 
    SET 
      readiness_status = CASE 
        WHEN last_evidence_date IS NULL THEN 'not_ready'
        WHEN last_evidence_date < NOW() - INTERVAL '90 days' THEN 'needs_review'
        ELSE 'ready'
      END,
      evidence_status = CASE 
        WHEN last_evidence_date IS NULL THEN 'none'
        WHEN last_evidence_date < NOW() - INTERVAL '90 days' THEN 'stale'
        ELSE 'current'
      END,
      updated_at = NOW()
    RETURNING readiness_status
  `);

  const stats = { updated: result.rowCount || 0, not_ready: 0, ready: 0 };
  for (const row of result.rows) {
    if (
      row.readiness_status === "not_ready" ||
      row.readiness_status === "needs_review"
    ) {
      stats.not_ready++;
    } else {
      stats.ready++;
    }
  }

  logger.info(
    `📊 [RBAC] Control readiness: ${stats.ready} ready, ${stats.not_ready} not ready`,
  );
  return stats;
}

export async function escalateOverdueActions(): Promise<{ escalated: number }> {
  logger.info("⚠️ [RBAC] Checking for overdue actions to escalate...");

  const overdueCapas = await pool.query(`
    SELECT id, capa_number, title, assigned_to, target_date 
    FROM capa_records 
    WHERE status NOT IN ('closed', 'cancelled') 
    AND target_date < NOW() 
    AND id NOT IN (SELECT source_id FROM escalation_log WHERE source_type = 'capa' AND status = 'pending')
  `);

  let escalated = 0;
  for (const capa of overdueCapas.rows) {
    await pool.query(
      `
      INSERT INTO escalation_log (source_type, source_id, escalation_reason, escalated_to, status)
      VALUES ('capa', $1, $2, 'executive_dashboard', 'pending')
    `,
      [
        capa.id,
        `CAPA ${capa.capa_number} is overdue (due: ${capa.target_date})`,
      ],
    );
    escalated++;
  }

  const overdueActions = await pool.query(`
    SELECT id, action_title, assigned_to, due_date, risk_id
    FROM risk_treatment_actions 
    WHERE status NOT IN ('completed', 'cancelled') 
    AND due_date < NOW() 
    AND id NOT IN (SELECT source_id FROM escalation_log WHERE source_type = 'risk_action' AND status = 'pending')
  `);

  for (const action of overdueActions.rows) {
    await pool.query(
      `
      INSERT INTO escalation_log (source_type, source_id, escalation_reason, escalated_to, status)
      VALUES ('risk_action', $1, $2, 'executive_dashboard', 'pending')
    `,
      [
        action.id,
        `Risk treatment action "${action.action_title}" is overdue (due: ${action.due_date})`,
      ],
    );
    escalated++;
  }

  logger.info(`⚠️ [RBAC] Escalated ${escalated} overdue actions`);
  return { escalated };
}

export async function getEscalationLog(filters?: {
  status?: string;
  source_type?: string;
}): Promise<any[]> {
  let query = `
    SELECT el.*, 
      CASE 
        WHEN el.source_type = 'capa' THEN (SELECT title FROM capa_records WHERE id = el.source_id)
        WHEN el.source_type = 'risk_action' THEN (SELECT action_title FROM risk_treatment_actions WHERE id = el.source_id)
        ELSE NULL
      END as source_name
    FROM escalation_log el WHERE 1=1
  `;
  const params: any[] = [];
  let paramIndex = 1;

  if (filters?.status) {
    query += ` AND el.status = $${paramIndex++}`;
    params.push(filters.status);
  }
  if (filters?.source_type) {
    query += ` AND el.source_type = $${paramIndex++}`;
    params.push(filters.source_type);
  }

  query += " ORDER BY el.created_at DESC";
  const result = await pool.query(query, params);
  return result.rows;
}

export async function resolveEscalation(
  id: number,
  resolvedBy: string,
  notes?: string,
): Promise<void> {
  await pool.query(
    `
    UPDATE escalation_log 
    SET status = 'resolved', resolved_at = NOW(), resolved_by = $2, notes = $3
    WHERE id = $1
  `,
    [id, resolvedBy, notes || null],
  );
}
