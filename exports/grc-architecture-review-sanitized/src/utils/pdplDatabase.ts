import { pool as basePool } from "./database";
import { wrapPoolForRedaction } from "./redactedPool";
import crypto from "crypto";
import { logger } from "./logger";

const pool = wrapPoolForRedaction(basePool);

export type DataCategory = "personal" | "sensitive" | "business" | "public";
export type RetentionStatus =
  | "active"
  | "pending_deletion"
  | "anonymized"
  | "deleted";
export type DSARType =
  | "access"
  | "correction"
  | "deletion"
  | "restriction"
  | "portability";
export type DSARStatus =
  | "received"
  | "in_progress"
  | "pending_approval"
  | "completed"
  | "rejected";
export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type IncidentStatus =
  | "detected"
  | "contained"
  | "investigating"
  | "resolved"
  | "closed";

export interface DataInventoryItem {
  id?: number;
  field_name: string;
  field_description?: string;
  data_category: DataCategory;
  module: string;
  table_name: string;
  purpose: string;
  legal_basis?: string;
  storage_location: string;
  access_roles: string[];
  retention_days: number;
  is_encrypted: boolean;
  is_masked: boolean;
  pii_type?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface DSARRequest {
  id?: number;
  request_id: string;
  request_type: DSARType;
  subject_name: string;
  subject_email: string;
  subject_identifier?: string;
  request_description: string;
  status: DSARStatus;
  assigned_to?: string;
  received_date: Date;
  due_date: Date;
  completed_date?: Date;
  response_summary?: string;
  evidence_files?: string[];
  created_at?: Date;
  updated_at?: Date;
}

export interface RetentionPolicy {
  id?: number;
  policy_name: string;
  data_category: DataCategory;
  module: string;
  table_name: string;
  retention_days: number;
  action_on_expiry: "delete" | "anonymize" | "archive";
  is_active: boolean;
  last_run?: Date;
  records_processed?: number;
  created_at?: Date;
  updated_at?: Date;
}

export interface DataIncident {
  id?: number;
  incident_id: string;
  title: string;
  description: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  data_types_affected: string[];
  records_affected?: number;
  detected_date: Date;
  contained_date?: Date;
  resolved_date?: Date;
  root_cause?: string;
  containment_actions?: string[];
  remediation_actions?: string[];
  notification_required: boolean;
  notification_sent?: boolean;
  notification_date?: Date;
  assigned_to?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface AIGuardrailConfig {
  id?: number;
  field_name: string;
  mask_pattern: string;
  replacement: string;
  is_active: boolean;
  module?: string;
  created_at?: Date;
}

export async function initPdplTables(): Promise<void> {
  logger.info("🔒 [PDPL] Initializing PDPL compliance tables...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS data_inventory (
      id SERIAL PRIMARY KEY,
      field_name VARCHAR(255) NOT NULL,
      field_description TEXT,
      data_category VARCHAR(50) NOT NULL DEFAULT 'personal',
      module VARCHAR(100) NOT NULL,
      table_name VARCHAR(100) NOT NULL,
      purpose TEXT NOT NULL,
      legal_basis VARCHAR(255),
      storage_location VARCHAR(255) NOT NULL DEFAULT 'PostgreSQL',
      access_roles JSONB DEFAULT '[]',
      retention_days INTEGER NOT NULL DEFAULT 365,
      is_encrypted BOOLEAN DEFAULT true,
      is_masked BOOLEAN DEFAULT false,
      pii_type VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(field_name, table_name, module)
    );
    CREATE INDEX IF NOT EXISTS idx_data_inventory_module ON data_inventory(module);
    CREATE INDEX IF NOT EXISTS idx_data_inventory_category ON data_inventory(data_category);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dsar_requests (
      id SERIAL PRIMARY KEY,
      request_id VARCHAR(50) UNIQUE NOT NULL,
      request_type VARCHAR(30) NOT NULL,
      subject_name VARCHAR(255) NOT NULL,
      subject_email VARCHAR(255) NOT NULL,
      subject_identifier VARCHAR(255),
      request_description TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'received',
      assigned_to VARCHAR(255),
      received_date TIMESTAMP NOT NULL DEFAULT NOW(),
      due_date TIMESTAMP NOT NULL,
      completed_date TIMESTAMP,
      response_summary TEXT,
      evidence_files JSONB DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dsar_status ON dsar_requests(status);
    CREATE INDEX IF NOT EXISTS idx_dsar_type ON dsar_requests(request_type);
    CREATE INDEX IF NOT EXISTS idx_dsar_due ON dsar_requests(due_date);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS retention_policies (
      id SERIAL PRIMARY KEY,
      policy_name VARCHAR(255) NOT NULL,
      data_category VARCHAR(50) NOT NULL,
      module VARCHAR(100) NOT NULL,
      table_name VARCHAR(100) NOT NULL,
      retention_days INTEGER NOT NULL,
      action_on_expiry VARCHAR(30) NOT NULL DEFAULT 'delete',
      is_active BOOLEAN DEFAULT true,
      last_run TIMESTAMP,
      records_processed INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(table_name, module)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS data_incidents (
      id SERIAL PRIMARY KEY,
      incident_id VARCHAR(50) UNIQUE NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      severity VARCHAR(30) NOT NULL DEFAULT 'medium',
      status VARCHAR(30) NOT NULL DEFAULT 'detected',
      data_types_affected JSONB DEFAULT '[]',
      records_affected INTEGER,
      detected_date TIMESTAMP NOT NULL DEFAULT NOW(),
      contained_date TIMESTAMP,
      resolved_date TIMESTAMP,
      root_cause TEXT,
      containment_actions JSONB DEFAULT '[]',
      remediation_actions JSONB DEFAULT '[]',
      notification_required BOOLEAN DEFAULT false,
      notification_sent BOOLEAN DEFAULT false,
      notification_date TIMESTAMP,
      assigned_to VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_status ON data_incidents(status);
    CREATE INDEX IF NOT EXISTS idx_incidents_severity ON data_incidents(severity);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_guardrails (
      id SERIAL PRIMARY KEY,
      field_name VARCHAR(255) NOT NULL,
      mask_pattern VARCHAR(500) NOT NULL,
      replacement VARCHAR(255) NOT NULL DEFAULT '[REDACTED]',
      is_active BOOLEAN DEFAULT true,
      module VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pdpl_audit_log (
      id SERIAL PRIMARY KEY,
      action_type VARCHAR(50) NOT NULL,
      entity_type VARCHAR(50) NOT NULL,
      entity_id VARCHAR(100),
      user_email VARCHAR(255),
      description TEXT,
      metadata JSONB DEFAULT '{}',
      checksum VARCHAR(64) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pdpl_audit_action ON pdpl_audit_log(action_type);
    CREATE INDEX IF NOT EXISTS idx_pdpl_audit_entity ON pdpl_audit_log(entity_type);
  `);

  await seedDefaultData();
  logger.info("✅ [PDPL] PDPL compliance tables initialized");
}

async function seedDefaultData(): Promise<void> {
  const existingInventory = await pool.query(
    "SELECT COUNT(*) FROM data_inventory",
  );
  if (parseInt(existingInventory.rows[0].count) === 0) {
    logger.info("🌱 [PDPL] Seeding default data inventory...");

    const defaultInventory: Partial<DataInventoryItem>[] = [
      {
        field_name: "Email",
        data_category: "personal",
        module: "CRM",
        table_name: "leads",
        purpose: "Lead contact and communication",
        access_roles: ["admin", "quality_manager", "grc_manager"],
        retention_days: 730,
        is_encrypted: true,
        is_masked: true,
        pii_type: "email",
      },
      {
        field_name: "Phone",
        data_category: "personal",
        module: "CRM",
        table_name: "leads",
        purpose: "Lead contact for sales calls",
        access_roles: ["admin", "quality_manager"],
        retention_days: 730,
        is_encrypted: true,
        is_masked: true,
        pii_type: "phone",
      },
      {
        field_name: "First_Name",
        data_category: "personal",
        module: "CRM",
        table_name: "leads",
        purpose: "Lead identification",
        access_roles: ["admin", "quality_manager", "grc_manager", "bu_owner"],
        retention_days: 730,
        is_encrypted: false,
        is_masked: false,
        pii_type: "name",
      },
      {
        field_name: "Last_Name",
        data_category: "personal",
        module: "CRM",
        table_name: "leads",
        purpose: "Lead identification",
        access_roles: ["admin", "quality_manager", "grc_manager", "bu_owner"],
        retention_days: 730,
        is_encrypted: false,
        is_masked: false,
        pii_type: "name",
      },
      {
        field_name: "Company",
        data_category: "business",
        module: "CRM",
        table_name: "leads",
        purpose: "Lead company association",
        access_roles: ["admin", "quality_manager", "grc_manager", "bu_owner"],
        retention_days: 1095,
        is_encrypted: false,
        is_masked: false,
      },
      {
        field_name: "Owner",
        data_category: "business",
        module: "CRM",
        table_name: "leads",
        purpose: "Lead assignment tracking",
        access_roles: ["admin", "quality_manager", "grc_manager"],
        retention_days: 1095,
        is_encrypted: false,
        is_masked: false,
      },
      {
        field_name: "Email",
        data_category: "personal",
        module: "CRM",
        table_name: "deals",
        purpose: "Deal contact and communication",
        access_roles: ["admin", "quality_manager", "grc_manager"],
        retention_days: 1095,
        is_encrypted: true,
        is_masked: true,
        pii_type: "email",
      },
      {
        field_name: "Contact_Name",
        data_category: "personal",
        module: "CRM",
        table_name: "deals",
        purpose: "Deal contact identification",
        access_roles: ["admin", "quality_manager", "grc_manager", "bu_owner"],
        retention_days: 1095,
        is_encrypted: false,
        is_masked: false,
        pii_type: "name",
      },
      {
        field_name: "user_email",
        data_category: "personal",
        module: "System",
        table_name: "system_users",
        purpose: "User authentication and audit",
        access_roles: ["admin"],
        retention_days: 2555,
        is_encrypted: false,
        is_masked: false,
        pii_type: "email",
      },
      {
        field_name: "user_name",
        data_category: "personal",
        module: "System",
        table_name: "event_logs",
        purpose: "Audit trail accountability",
        access_roles: ["admin", "grc_manager"],
        retention_days: 2555,
        is_encrypted: false,
        is_masked: false,
        pii_type: "name",
      },
    ];

    for (const item of defaultInventory) {
      await pool.query(
        `INSERT INTO data_inventory (field_name, data_category, module, table_name, purpose, access_roles, retention_days, is_encrypted, is_masked, pii_type, storage_location)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (field_name, table_name, module) DO NOTHING`,
        [
          item.field_name,
          item.data_category,
          item.module,
          item.table_name,
          item.purpose,
          JSON.stringify(item.access_roles),
          item.retention_days,
          item.is_encrypted,
          item.is_masked,
          item.pii_type,
          "PostgreSQL",
        ],
      );
    }
  }

  const existingGuardrails = await pool.query(
    "SELECT COUNT(*) FROM ai_guardrails",
  );
  if (parseInt(existingGuardrails.rows[0].count) === 0) {
    logger.info("🌱 [PDPL] Seeding default AI guardrails...");

    const defaultGuardrails = [
      {
        field_name: "email",
        mask_pattern: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
        replacement: "[EMAIL_REDACTED]",
      },
      {
        field_name: "phone",
        mask_pattern: "\\+?[0-9]{10,15}",
        replacement: "[PHONE_REDACTED]",
      },
      {
        field_name: "national_id",
        mask_pattern: "[0-9]{10}",
        replacement: "[ID_REDACTED]",
      },
      {
        field_name: "credit_card",
        mask_pattern: "[0-9]{13,19}",
        replacement: "[CARD_REDACTED]",
      },
    ];

    for (const guardrail of defaultGuardrails) {
      await pool.query(
        `INSERT INTO ai_guardrails (field_name, mask_pattern, replacement, is_active)
         VALUES ($1, $2, $3, true)`,
        [guardrail.field_name, guardrail.mask_pattern, guardrail.replacement],
      );
    }
  }

  const existingPolicies = await pool.query(
    "SELECT COUNT(*) FROM retention_policies",
  );
  if (parseInt(existingPolicies.rows[0].count) === 0) {
    logger.info("🌱 [PDPL] Seeding default retention policies...");

    const defaultPolicies = [
      {
        policy_name: "CRM Leads Retention",
        data_category: "personal",
        module: "CRM",
        table_name: "leads",
        retention_days: 730,
        action_on_expiry: "anonymize",
      },
      {
        policy_name: "CRM Deals Retention",
        data_category: "personal",
        module: "CRM",
        table_name: "deals",
        retention_days: 1095,
        action_on_expiry: "archive",
      },
      {
        policy_name: "Audit Logs Retention",
        data_category: "business",
        module: "System",
        table_name: "event_logs",
        retention_days: 2555,
        action_on_expiry: "archive",
      },
      {
        policy_name: "Quality Audits Retention",
        data_category: "business",
        module: "QMS",
        table_name: "quality_audit_results",
        retention_days: 1825,
        action_on_expiry: "archive",
      },
    ];

    for (const policy of defaultPolicies) {
      await pool.query(
        `INSERT INTO retention_policies (policy_name, data_category, module, table_name, retention_days, action_on_expiry, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, true)`,
        [
          policy.policy_name,
          policy.data_category,
          policy.module,
          policy.table_name,
          policy.retention_days,
          policy.action_on_expiry,
        ],
      );
    }
  }
}

function generatePdplChecksum(<REDACTED_SCHEME> any): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(data) + new Date().toISOString())
    .digest("hex");
}

async function logPdplAction(
  actionType: string,
  entityType: string,
  entityId: string,
  userEmail: string,
  description: string,
  metadata?: any,
): Promise<void> {
  const checksum = generatePdplChecksum({
    actionType,
    entityType,
    entityId,
    userEmail,
    description,
  });
  await pool.query(
    `INSERT INTO pdpl_audit_log (action_type, entity_type, entity_id, user_email, description, metadata, checksum)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      actionType,
      entityType,
      entityId,
      userEmail,
      description,
      JSON.stringify(metadata || {}),
      checksum,
    ],
  );
}

export async function getDataInventory(filters?: {
  module?: string;
  category?: string;
}): Promise<DataInventoryItem[]> {
  let query = "SELECT * FROM data_inventory WHERE 1=1";
  const params: any[] = [];

  if (filters?.module) {
    params.push(filters.module);
    query += ` AND module = $${params.length}`;
  }
  if (filters?.category) {
    params.push(filters.category);
    query += ` AND data_category = $${params.length}`;
  }

  query += " ORDER BY module, table_name, field_name";
  const result = await pool.query(query, params);
  return result.rows;
}

export async function addDataInventoryItem(
  item: DataInventoryItem,
  userEmail: string,
): Promise<DataInventoryItem> {
  const result = await pool.query(
    `INSERT INTO data_inventory (field_name, field_description, data_category, module, table_name, purpose, legal_basis, storage_location, access_roles, retention_days, is_encrypted, is_masked, pii_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      item.field_name,
      item.field_description,
      item.data_category,
      item.module,
      item.table_name,
      item.purpose,
      item.legal_basis,
      item.storage_location,
      JSON.stringify(item.access_roles),
      item.retention_days,
      item.is_encrypted,
      item.is_masked,
      item.pii_type,
    ],
  );

  await logPdplAction(
    "CREATE",
    "DATA_INVENTORY",
    result.rows[0].id.toString(),
    userEmail,
    `Added data inventory item: ${item.field_name}`,
    item,
  );
  return result.rows[0];
}

export async function updateDataInventoryItem(
  id: number,
  updates: Partial<DataInventoryItem>,
  userEmail: string,
): Promise<DataInventoryItem | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.field_description !== undefined) {
    fields.push(`field_description = $${paramIndex++}`);
    values.push(updates.field_description);
  }
  if (updates.data_category) {
    fields.push(`data_category = $${paramIndex++}`);
    values.push(updates.data_category);
  }
  if (updates.purpose) {
    fields.push(`purpose = $${paramIndex++}`);
    values.push(updates.purpose);
  }
  if (updates.legal_basis !== undefined) {
    fields.push(`legal_basis = $${paramIndex++}`);
    values.push(updates.legal_basis);
  }
  if (updates.access_roles) {
    fields.push(`access_roles = $${paramIndex++}`);
    values.push(JSON.stringify(updates.access_roles));
  }
  if (updates.retention_days !== undefined) {
    fields.push(`retention_days = $${paramIndex++}`);
    values.push(updates.retention_days);
  }
  if (updates.is_encrypted !== undefined) {
    fields.push(`is_encrypted = $${paramIndex++}`);
    values.push(updates.is_encrypted);
  }
  if (updates.is_masked !== undefined) {
    fields.push(`is_masked = $${paramIndex++}`);
    values.push(updates.is_masked);
  }

  if (fields.length === 0) return null;

  fields.push(`updated_at = NOW()`);
  values.push(id);

  const result = await pool.query(
    `UPDATE data_inventory SET ${fields.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    values,
  );

  if (result.rows[0]) {
    await logPdplAction(
      "UPDATE",
      "DATA_INVENTORY",
      id.toString(),
      userEmail,
      `Updated data inventory item`,
      updates,
    );
  }
  return result.rows[0] || null;
}

export async function getDSARRequests(filters?: {
  status?: DSARStatus;
  type?: DSARType;
}): Promise<DSARRequest[]> {
  let query = "SELECT * FROM dsar_requests WHERE 1=1";
  const params: any[] = [];

  if (filters?.status) {
    params.push(filters.status);
    query += ` AND status = $${params.length}`;
  }
  if (filters?.type) {
    params.push(filters.type);
    query += ` AND request_type = $${params.length}`;
  }

  query += " ORDER BY due_date ASC, created_at DESC";
  const result = await pool.query(query, params);
  return result.rows;
}

export async function createDSARRequest(
  request: Partial<DSARRequest>,
  userEmail: string,
): Promise<DSARRequest> {
  const requestId = `DSAR-${Date.now().toString(36).toUpperCase()}`;
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);

  const result = await pool.query(
    `INSERT INTO dsar_requests (request_id, request_type, subject_name, subject_email, subject_identifier, request_description, status, assigned_to, received_date, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
     RETURNING *`,
    [
      requestId,
      request.request_type,
      request.subject_name,
      request.subject_email,
      request.subject_identifier,
      request.request_description,
      "received",
      request.assigned_to,
      dueDate,
    ],
  );

  await logPdplAction(
    "CREATE",
    "DSAR",
    requestId,
    userEmail,
    `Created DSAR request: ${request.request_type} for ${request.subject_email}`,
    request,
  );
  return result.rows[0];
}

export async function updateDSARRequest(
  id: number,
  updates: Partial<DSARRequest>,
  userEmail: string,
): Promise<DSARRequest | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.status) {
    fields.push(`status = $${paramIndex++}`);
    values.push(updates.status);
    if (updates.status === "completed") {
      fields.push(`completed_date = NOW()`);
    }
  }
  if (updates.assigned_to !== undefined) {
    fields.push(`assigned_to = $${paramIndex++}`);
    values.push(updates.assigned_to);
  }
  if (updates.response_summary !== undefined) {
    fields.push(`response_summary = $${paramIndex++}`);
    values.push(updates.response_summary);
  }
  if (updates.evidence_files) {
    fields.push(`evidence_files = $${paramIndex++}`);
    values.push(JSON.stringify(updates.evidence_files));
  }

  if (fields.length === 0) return null;

  fields.push(`updated_at = NOW()`);
  values.push(id);

  const result = await pool.query(
    `UPDATE dsar_requests SET ${fields.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    values,
  );

  if (result.rows[0]) {
    await logPdplAction(
      "UPDATE",
      "DSAR",
      result.rows[0].request_id,
      userEmail,
      `Updated DSAR request: ${updates.status || "details updated"}`,
      updates,
    );
  }
  return result.rows[0] || null;
}

export async function getRetentionPolicies(): Promise<RetentionPolicy[]> {
  const result = await pool.query(
    "SELECT * FROM retention_policies ORDER BY module, table_name",
  );
  return result.rows;
}

export async function updateRetentionPolicy(
  id: number,
  updates: Partial<RetentionPolicy>,
  userEmail: string,
): Promise<RetentionPolicy | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.retention_days !== undefined) {
    fields.push(`retention_days = $${paramIndex++}`);
    values.push(updates.retention_days);
  }
  if (updates.action_on_expiry) {
    fields.push(`action_on_expiry = $${paramIndex++}`);
    values.push(updates.action_on_expiry);
  }
  if (updates.is_active !== undefined) {
    fields.push(`is_active = $${paramIndex++}`);
    values.push(updates.is_active);
  }

  if (fields.length === 0) return null;

  fields.push(`updated_at = NOW()`);
  values.push(id);

  const result = await pool.query(
    `UPDATE retention_policies SET ${fields.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    values,
  );

  if (result.rows[0]) {
    await logPdplAction(
      "UPDATE",
      "RETENTION_POLICY",
      id.toString(),
      userEmail,
      `Updated retention policy`,
      updates,
    );
  }
  return result.rows[0] || null;
}

export async function getDataIncidents(filters?: {
  status?: IncidentStatus;
  severity?: IncidentSeverity;
}): Promise<DataIncident[]> {
  let query = "SELECT * FROM data_incidents WHERE 1=1";
  const params: any[] = [];

  if (filters?.status) {
    params.push(filters.status);
    query += ` AND status = $${params.length}`;
  }
  if (filters?.severity) {
    params.push(filters.severity);
    query += ` AND severity = $${params.length}`;
  }

  query += " ORDER BY detected_date DESC";
  const result = await pool.query(query, params);
  return result.rows;
}

export async function createDataIncident(
  incident: Partial<DataIncident>,
  userEmail: string,
): Promise<DataIncident> {
  const incidentId = `INC-${Date.now().toString(36).toUpperCase()}`;

  const result = await pool.query(
    `INSERT INTO data_incidents (incident_id, title, description, severity, status, data_types_affected, records_affected, notification_required, assigned_to)
     VALUES ($1, $2, $3, $4, 'detected', $5, $6, $7, $8)
     RETURNING *`,
    [
      incidentId,
      incident.title,
      incident.description,
      incident.severity || "medium",
      JSON.stringify(incident.data_types_affected || []),
      incident.records_affected,
      incident.notification_required || false,
      incident.assigned_to,
    ],
  );

  await logPdplAction(
    "CREATE",
    "INCIDENT",
    incidentId,
    userEmail,
    `Created data incident: ${incident.title}`,
    incident,
  );
  return result.rows[0];
}

export async function updateDataIncident(
  id: number,
  updates: Partial<DataIncident>,
  userEmail: string,
): Promise<DataIncident | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.status) {
    fields.push(`status = $${paramIndex++}`);
    values.push(updates.status);
    if (updates.status === "contained") fields.push(`contained_date = NOW()`);
    if (updates.status === "resolved" || updates.status === "closed")
      fields.push(`resolved_date = NOW()`);
  }
  if (updates.root_cause !== undefined) {
    fields.push(`root_cause = $${paramIndex++}`);
    values.push(updates.root_cause);
  }
  if (updates.containment_actions) {
    fields.push(`containment_actions = $${paramIndex++}`);
    values.push(JSON.stringify(updates.containment_actions));
  }
  if (updates.remediation_actions) {
    fields.push(`remediation_actions = $${paramIndex++}`);
    values.push(JSON.stringify(updates.remediation_actions));
  }
  if (updates.notification_sent !== undefined) {
    fields.push(`notification_sent = $${paramIndex++}`);
    values.push(updates.notification_sent);
    if (updates.notification_sent) fields.push(`notification_date = NOW()`);
  }
  if (updates.assigned_to !== undefined) {
    fields.push(`assigned_to = $${paramIndex++}`);
    values.push(updates.assigned_to);
  }

  if (fields.length === 0) return null;

  fields.push(`updated_at = NOW()`);
  values.push(id);

  const result = await pool.query(
    `UPDATE data_incidents SET ${fields.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    values,
  );

  if (result.rows[0]) {
    await logPdplAction(
      "UPDATE",
      "INCIDENT",
      result.rows[0].incident_id,
      userEmail,
      `Updated incident: ${updates.status || "details updated"}`,
      updates,
    );
  }
  return result.rows[0] || null;
}

export async function getAIGuardrails(): Promise<AIGuardrailConfig[]> {
  const result = await pool.query(
    "SELECT * FROM ai_guardrails WHERE is_active = true ORDER BY field_name",
  );
  return result.rows;
}

export async function addAIGuardrail(
  guardrail: Partial<AIGuardrailConfig>,
  userEmail: string,
): Promise<AIGuardrailConfig> {
  const result = await pool.query(
    `INSERT INTO ai_guardrails (field_name, mask_pattern, replacement, is_active, module)
     VALUES ($1, $2, $3, true, $4)
     RETURNING *`,
    [
      guardrail.field_name,
      guardrail.mask_pattern,
      guardrail.replacement || "[REDACTED]",
      guardrail.module,
    ],
  );

  await logPdplAction(
    "CREATE",
    "AI_GUARDRAIL",
    result.rows[0].id.toString(),
    userEmail,
    `Added AI guardrail: ${guardrail.field_name}`,
  );
  return result.rows[0];
}

export function maskPIIForAI(
  text: string,
  guardrails: AIGuardrailConfig[],
): { masked: string; maskedCount: number } {
  let masked = text;
  let maskedCount = 0;

  for (const guardrail of guardrails) {
    try {
      const regex = new RegExp(guardrail.mask_pattern, "gi");
      const matches = masked.match(regex);
      if (matches) {
        maskedCount += matches.length;
        masked = masked.replace(regex, guardrail.replacement);
      }
    } catch (e) {
      logger.error(`Invalid guardrail pattern: ${guardrail.mask_pattern}`);
    }
  }

  return { masked, maskedCount };
}

export async function getPdplComplianceStatus(): Promise<{
  dataInventory: {
    total: number;
    byCategory: Record<string, number>;
    byModule: Record<string, number>;
  };
  dsar: {
    total: number;
    pending: number;
    overdue: number;
    completedThisMonth: number;
  };
  retention: { activePolicies: number; totalRecordsManaged: number };
  incidents: { total: number; open: number; critical: number };
  aiGuardrails: { active: number };
  complianceScore: number;
}> {
  const inventory = await pool.query(`
    SELECT 
      COUNT(*) as total,
      data_category,
      module
    FROM data_inventory
    GROUP BY data_category, module
  `);

  const dsarStats = await pool.query(`
    SELECT 
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status IN ('received', 'in_progress', 'pending_approval')) as pending,
      COUNT(*) FILTER (WHERE due_date < NOW() AND status NOT IN ('completed', 'rejected')) as overdue,
      COUNT(*) FILTER (WHERE status = 'completed' AND completed_date >= DATE_TRUNC('month', NOW())) as completed_this_month
    FROM dsar_requests
  `);

  const retentionStats = await pool.query(`
    SELECT 
      COUNT(*) FILTER (WHERE is_active = true) as active_policies,
      COALESCE(SUM(records_processed), 0) as total_records
    FROM retention_policies
  `);

  const incidentStats = await pool.query(`
    SELECT 
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status NOT IN ('resolved', 'closed')) as open,
      COUNT(*) FILTER (WHERE severity = 'critical' AND status NOT IN ('resolved', 'closed')) as critical
    FROM data_incidents
  `);

  const guardrailStats = await pool.query(
    `SELECT COUNT(*) as active FROM ai_guardrails WHERE is_active = true`,
  );

  const byCategory: Record<string, number> = {};
  const byModule: Record<string, number> = {};
  let totalInventory = 0;

  for (const row of inventory.rows) {
    byCategory[row.data_category] =
      (byCategory[row.data_category] || 0) + parseInt(row.total);
    byModule[row.module] = (byModule[row.module] || 0) + parseInt(row.total);
    totalInventory += parseInt(row.total);
  }

  const hasInventory = totalInventory > 0 ? 20 : 0;
  const hasRetention =
    parseInt(retentionStats.rows[0].active_policies) > 0 ? 20 : 0;
  const hasGuardrails = parseInt(guardrailStats.rows[0].active) > 0 ? 20 : 0;
  const noOverdueDSAR = parseInt(dsarStats.rows[0].overdue) === 0 ? 20 : 10;
  const noCriticalIncidents =
    parseInt(incidentStats.rows[0].critical) === 0 ? 20 : 5;
  const complianceScore =
    hasInventory +
    hasRetention +
    hasGuardrails +
    noOverdueDSAR +
    noCriticalIncidents;

  return {
    dataInventory: { total: totalInventory, byCategory, byModule },
    dsar: {
      total: parseInt(dsarStats.rows[0].total),
      pending: parseInt(dsarStats.rows[0].pending),
      overdue: parseInt(dsarStats.rows[0].overdue),
      completedThisMonth: parseInt(dsarStats.rows[0].completed_this_month),
    },
    retention: {
      activePolicies: parseInt(retentionStats.rows[0].active_policies),
      totalRecordsManaged: parseInt(retentionStats.rows[0].total_records),
    },
    incidents: {
      total: parseInt(incidentStats.rows[0].total),
      open: parseInt(incidentStats.rows[0].open),
      critical: parseInt(incidentStats.rows[0].critical),
    },
    aiGuardrails: { active: parseInt(guardrailStats.rows[0].active) },
    complianceScore,
  };
}

export async function getPdplAuditLog(limit: number = 100): Promise<any[]> {
  const result = await pool.query(
    "SELECT * FROM pdpl_audit_log ORDER BY created_at DESC LIMIT $1",
    [limit],
  );
  return result.rows;
}
