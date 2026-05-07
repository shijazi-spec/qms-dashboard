import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

export interface Policy {
  id?: number;
  policy_number: string;
  title: string;
  description?: string;
  category:
    | "governance"
    | "operational"
    | "hr"
    | "it"
    | "compliance"
    | "security"
    | "quality"
    | "finance";
  document_type?: "policy" | "sop" | "form" | "document" | "control";
  document_number?: string;
  version: string;
  status:
    | "draft"
    | "review"
    | "approval"
    | "published"
    | "archived"
    | "retired";
  owner_name?: string;
  owner_department?: string;
  approver_name?: string;
  operational_owner?: string;
  operational_owner_email?: string;
  compliance_owner?: string;
  compliance_owner_email?: string;
  compliance_approved?: boolean;
  compliance_approved_by?: string;
  compliance_approved_at?: Date;
  approval_blocked_reason?: string;
  effective_date?: Date;
  review_date?: Date;
  expiry_date?: Date;
  content_text?: string;
  file_path?: string;
  file_name?: string;
  file_size?: number;
  file_mime_type?: string;
  confidentiality?: "public" | "internal" | "confidential" | "restricted";
  retention_period?: string;
  distribution_list?: string[];
  supersedes_id?: number;
  tags?: string[];
  linked_risk_ids?: number[];
  linked_control_ids?: number[];
  linked_regulation_ids?: number[];
  requires_acknowledgment?: boolean;
  acknowledgment_frequency?: "once" | "annual" | "semi_annual" | "quarterly";
  parent_policy_id?: number;
  change_summary?: string;
  created_by?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface PolicyVersion {
  id?: number;
  policy_id: number;
  version: string;
  content_text?: string;
  file_path?: string;
  change_summary?: string;
  changed_by: string;
  created_at?: Date;
  status_at_version: string;
}

export interface PolicyAcknowledgment {
  id?: number;
  policy_id: number;
  user_id?: string;
  user_name: string;
  user_email?: string;
  department?: string;
  acknowledged_at?: Date;
  acknowledgment_method?: "electronic" | "manual";
  expires_at?: Date;
}

export interface PolicyReviewCycle {
  id?: number;
  policy_id: number;
  scheduled_date: Date;
  actual_date?: Date;
  reviewer_name?: string;
  review_outcome?: "no_change" | "minor_update" | "major_revision" | "retire";
  review_notes?: string;
  next_scheduled_date?: Date;
  status: "scheduled" | "in_progress" | "completed" | "overdue";
}

export async function initPolicyTables(): Promise<void> {
  logger.info("📋 [PolicyDB] Initializing policy governance tables...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS policies (
      id SERIAL PRIMARY KEY,
      policy_number VARCHAR(50) UNIQUE NOT NULL,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      category VARCHAR(50) NOT NULL,
      version VARCHAR(20) DEFAULT '1.0',
      status VARCHAR(20) DEFAULT 'draft',
      owner_name VARCHAR(255),
      owner_department VARCHAR(100),
      approver_name VARCHAR(255),
      effective_date TIMESTAMP,
      review_date TIMESTAMP,
      expiry_date TIMESTAMP,
      content_text TEXT,
      file_path VARCHAR(500),
      linked_risk_ids INTEGER[],
      linked_control_ids INTEGER[],
      linked_regulation_ids INTEGER[],
      requires_acknowledgment BOOLEAN DEFAULT FALSE,
      acknowledgment_frequency VARCHAR(20) DEFAULT 'annual',
      parent_policy_id INTEGER REFERENCES policies(id),
      change_summary TEXT,
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS policy_versions (
      id SERIAL PRIMARY KEY,
      policy_id INTEGER REFERENCES policies(id) ON DELETE CASCADE,
      version VARCHAR(20) NOT NULL,
      content_text TEXT,
      file_path VARCHAR(500),
      change_summary TEXT,
      changed_by VARCHAR(255) NOT NULL,
      status_at_version VARCHAR(20),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS policy_acknowledgments (
      id SERIAL PRIMARY KEY,
      policy_id INTEGER REFERENCES policies(id) ON DELETE CASCADE,
      user_id VARCHAR(100),
      user_name VARCHAR(255) NOT NULL,
      user_email VARCHAR(255),
      department VARCHAR(100),
      acknowledged_at TIMESTAMP DEFAULT NOW(),
      acknowledgment_method VARCHAR(20) DEFAULT 'electronic',
      expires_at TIMESTAMP,
      UNIQUE(policy_id, user_email)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS policy_review_cycles (
      id SERIAL PRIMARY KEY,
      policy_id INTEGER REFERENCES policies(id) ON DELETE CASCADE,
      scheduled_date TIMESTAMP NOT NULL,
      actual_date TIMESTAMP,
      reviewer_name VARCHAR(255),
      review_outcome VARCHAR(20),
      review_notes TEXT,
      next_scheduled_date TIMESTAMP,
      status VARCHAR(20) DEFAULT 'scheduled',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(
    `ALTER TABLE policies ADD COLUMN IF NOT EXISTS public_id UUID DEFAULT gen_random_uuid()`,
  );
  await pool.query(
    `UPDATE policies SET public_id = gen_random_uuid() WHERE public_id IS NULL`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_policies_public_id ON policies(public_id)`,
  );

  await pool.query(
    `ALTER TABLE policies ADD COLUMN IF NOT EXISTS document_type VARCHAR(20) DEFAULT 'policy'`,
  );
  await pool.query(
    `ALTER TABLE policies ADD COLUMN IF NOT EXISTS document_number VARCHAR(50)`,
  );
  await pool.query(
    `ALTER TABLE policies ADD COLUMN IF NOT EXISTS file_name VARCHAR(500)`,
  );
  await pool.query(
    `ALTER TABLE policies ADD COLUMN IF NOT EXISTS file_size INTEGER`,
  );
  await pool.query(
    `ALTER TABLE policies ADD COLUMN IF NOT EXISTS file_mime_type VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE policies ADD COLUMN IF NOT EXISTS confidentiality VARCHAR(20) DEFAULT 'internal'`,
  );
  await pool.query(
    `ALTER TABLE policies ADD COLUMN IF NOT EXISTS retention_period VARCHAR(50)`,
  );
  await pool.query(
    `ALTER TABLE policies ADD COLUMN IF NOT EXISTS distribution_list TEXT[]`,
  );
  await pool.query(
    `ALTER TABLE policies ADD COLUMN IF NOT EXISTS supersedes_id INTEGER`,
  );
  await pool.query(`ALTER TABLE policies ADD COLUMN IF NOT EXISTS tags TEXT[]`);

  logger.info("✅ [PolicyDB] Policy governance tables initialized");
}

export async function createPolicy(policy: Policy): Promise<Policy> {
  logger.info("📝 [PolicyDB] Creating new policy:", policy.title);

  const result = await pool.query(
    `
    INSERT INTO policies (
      policy_number, title, description, category, document_type, document_number,
      version, status,
      owner_name, owner_department, approver_name,
      effective_date, review_date, expiry_date,
      content_text, file_path, file_name, file_size, file_mime_type,
      confidentiality, retention_period, distribution_list, supersedes_id, tags,
      linked_risk_ids, linked_control_ids, linked_regulation_ids,
      requires_acknowledgment, acknowledgment_frequency,
      parent_policy_id, change_summary, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
    RETURNING *
  `,
    [
      policy.policy_number,
      policy.title,
      policy.description,
      policy.category,
      policy.document_type || "policy",
      policy.document_number,
      policy.version || "1.0",
      policy.status || "draft",
      policy.owner_name,
      policy.owner_department,
      policy.approver_name,
      policy.effective_date,
      policy.review_date,
      policy.expiry_date,
      policy.content_text,
      policy.file_path,
      policy.file_name,
      policy.file_size,
      policy.file_mime_type,
      policy.confidentiality || "internal",
      policy.retention_period,
      policy.distribution_list,
      policy.supersedes_id,
      policy.tags,
      policy.linked_risk_ids,
      policy.linked_control_ids,
      policy.linked_regulation_ids,
      policy.requires_acknowledgment || false,
      policy.acknowledgment_frequency || "annual",
      policy.parent_policy_id,
      policy.change_summary,
      policy.created_by,
    ],
  );

  await pool.query(
    `
    INSERT INTO policy_versions (policy_id, version, content_text, file_path, change_summary, changed_by, status_at_version)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `,
    [
      result.rows[0].id,
      policy.version || "1.0",
      policy.content_text,
      policy.file_path,
      "Initial version",
      policy.created_by || "System",
      policy.status || "draft",
    ],
  );

  logger.info("✅ [PolicyDB] Policy created with ID:", result.rows[0].id);
  return result.rows[0];
}

export async function updatePolicy(
  id: number,
  policy: Partial<Policy>,
  updatedBy: string,
): Promise<Policy> {
  logger.info("📝 [PolicyDB] Updating policy ID:", id);

  const existing = await getPolicyById(id);
  if (!existing) {
    throw new Error(`Policy with ID ${id} not found`);
  }

  const updateFields: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  const allowedFields = [
    "title",
    "description",
    "category",
    "document_type",
    "document_number",
    "version",
    "status",
    "owner_name",
    "owner_department",
    "approver_name",
    "operational_owner",
    "operational_owner_email",
    "compliance_owner",
    "compliance_owner_email",
    "compliance_approved",
    "compliance_approved_by",
    "compliance_approved_at",
    "approval_blocked_reason",
    "effective_date",
    "review_date",
    "expiry_date",
    "content_text",
    "file_path",
    "file_name",
    "file_size",
    "file_mime_type",
    // NOTE: file_path is here for internal use by upload handler only - API routes must NOT allow external callers to set file_path directly
    "confidentiality",
    "retention_period",
    "distribution_list",
    "supersedes_id",
    "tags",
    "linked_risk_ids",
    "linked_control_ids",
    "linked_regulation_ids",
    "requires_acknowledgment",
    "acknowledgment_frequency",
    "change_summary",
  ];

  for (const [key, value] of Object.entries(policy)) {
    if (allowedFields.includes(key) && value !== undefined) {
      updateFields.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
  }

  updateFields.push(`updated_at = NOW()`);
  values.push(id);

  const result = await pool.query(
    `
    UPDATE policies 
    SET ${updateFields.join(", ")}
    WHERE id = $${paramCount}
    RETURNING *
  `,
    values,
  );

  if (policy.version && policy.version !== existing.version) {
    await pool.query(
      `
      INSERT INTO policy_versions (policy_id, version, content_text, file_path, change_summary, changed_by, status_at_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
      [
        id,
        policy.version,
        policy.content_text || existing.content_text,
        policy.file_path || existing.file_path,
        policy.change_summary || "Version update",
        updatedBy,
        policy.status || existing.status,
      ],
    );
  }

  logger.info("✅ [PolicyDB] Policy updated:", id);
  return result.rows[0];
}

export async function getPolicyById(id: number): Promise<Policy | null> {
  const result = await pool.query("SELECT * FROM policies WHERE id = $1", [id]);
  return result.rows[0] || null;
}

export async function getAllPolicies(filters?: {
  status?: string;
  category?: string;
  document_type?: string;
  owner_department?: string;
  search?: string;
  limit?: number;
  offset?: number;
  allowedConfidentiality?: string[];
}): Promise<{ policies: Policy[]; total: number }> {
  logger.info("📊 [PolicyDB] Fetching policies with filters:", filters);

  let whereConditions: string[] = [];
  let values: any[] = [];
  let paramCount = 1;

  if (filters?.status) {
    whereConditions.push(`status = $${paramCount}`);
    values.push(filters.status);
    paramCount++;
  }
  if (filters?.category) {
    whereConditions.push(`category = $${paramCount}`);
    values.push(filters.category);
    paramCount++;
  }
  if (filters?.document_type) {
    whereConditions.push(`document_type = $${paramCount}`);
    values.push(filters.document_type);
    paramCount++;
  }
  if (filters?.owner_department) {
    whereConditions.push(`owner_department = $${paramCount}`);
    values.push(filters.owner_department);
    paramCount++;
  }
  if (filters?.search) {
    whereConditions.push(
      `(title ILIKE $${paramCount} OR policy_number ILIKE $${paramCount} OR document_number ILIKE $${paramCount})`,
    );
    values.push(`%${filters.search}%`);
    paramCount++;
  }
  if (
    filters?.allowedConfidentiality &&
    filters.allowedConfidentiality.length > 0
  ) {
    whereConditions.push(`confidentiality = ANY($${paramCount}::text[])`);
    values.push(filters.allowedConfidentiality);
    paramCount++;
  }

  const whereClause =
    whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM policies ${whereClause}`,
    values,
  );
  const total = parseInt(countResult.rows[0].count);

  const limit = filters?.limit || 50;
  const offset = filters?.offset || 0;
  values.push(limit, offset);

  const result = await pool.query(
    `
    SELECT * FROM policies 
    ${whereClause}
    ORDER BY updated_at DESC
    LIMIT $${paramCount} OFFSET $${paramCount + 1}
  `,
    values,
  );

  logger.info("✅ [PolicyDB] Found", result.rows.length, "policies");
  return { policies: result.rows, total };
}

export async function getPolicySummaryStats(): Promise<any> {
  logger.info("📊 [PolicyDB] Generating policy summary statistics...");

  const stats = await pool.query(`
    SELECT 
      COUNT(*) as total_policies,
      COUNT(*) FILTER (WHERE status = 'draft') as draft_count,
      COUNT(*) FILTER (WHERE status = 'review') as in_review,
      COUNT(*) FILTER (WHERE status = 'approval') as pending_approval,
      COUNT(*) FILTER (WHERE status = 'published') as published,
      COUNT(*) FILTER (WHERE status = 'archived') as archived,
      COUNT(*) FILTER (WHERE review_date < NOW() AND status = 'published') as overdue_reviews,
      COUNT(*) FILTER (WHERE expiry_date < NOW() AND status = 'published') as expired,
      COUNT(*) FILTER (WHERE requires_acknowledgment = true) as requires_ack
    FROM policies
  `);

  const byCategory = await pool.query(`
    SELECT category, COUNT(*) as count
    FROM policies
    WHERE status NOT IN ('retired', 'archived')
    GROUP BY category
    ORDER BY count DESC
  `);

  const byDepartment = await pool.query(`
    SELECT owner_department, COUNT(*) as count
    FROM policies
    WHERE status NOT IN ('retired', 'archived') AND owner_department IS NOT NULL
    GROUP BY owner_department
    ORDER BY count DESC
  `);

  const upcomingReviews = await pool.query(`
    SELECT id, policy_number, title, review_date, owner_name
    FROM policies
    WHERE status = 'published' 
    AND review_date BETWEEN NOW() AND NOW() + INTERVAL '30 days'
    ORDER BY review_date ASC
    LIMIT 10
  `);

  logger.info("✅ [PolicyDB] Summary statistics generated");
  return {
    ...stats.rows[0],
    by_category: byCategory.rows,
    by_department: byDepartment.rows,
    upcoming_reviews: upcomingReviews.rows,
  };
}

export async function getPolicyVersions(
  policyId: number,
): Promise<PolicyVersion[]> {
  const result = await pool.query(
    `
    SELECT * FROM policy_versions
    WHERE policy_id = $1
    ORDER BY created_at DESC
  `,
    [policyId],
  );
  return result.rows;
}

export async function acknowledgePolicy(
  ack: PolicyAcknowledgment,
): Promise<PolicyAcknowledgment> {
  logger.info(
    "📝 [PolicyDB] Recording policy acknowledgment for policy:",
    ack.policy_id,
  );

  const policy = await getPolicyById(ack.policy_id);
  let expiresAt: Date | null = null;

  if (policy && policy.acknowledgment_frequency) {
    const now = new Date();
    switch (policy.acknowledgment_frequency) {
      case "annual":
        expiresAt = new Date(now.setFullYear(now.getFullYear() + 1));
        break;
      case "semi_annual":
        expiresAt = new Date(now.setMonth(now.getMonth() + 6));
        break;
      case "quarterly":
        expiresAt = new Date(now.setMonth(now.getMonth() + 3));
        break;
      default:
        expiresAt = null;
    }
  }

  const result = await pool.query(
    `
    INSERT INTO policy_acknowledgments (policy_id, user_id, user_name, user_email, department, acknowledgment_method, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (policy_id, user_email) 
    DO UPDATE SET acknowledged_at = NOW(), expires_at = $7
    RETURNING *
  `,
    [
      ack.policy_id,
      ack.user_id,
      ack.user_name,
      ack.user_email,
      ack.department,
      ack.acknowledgment_method || "electronic",
      expiresAt,
    ],
  );

  logger.info("✅ [PolicyDB] Acknowledgment recorded");
  return result.rows[0];
}

export async function getPolicyAcknowledgments(
  policyId: number,
): Promise<PolicyAcknowledgment[]> {
  const result = await pool.query(
    `
    SELECT * FROM policy_acknowledgments
    WHERE policy_id = $1
    ORDER BY acknowledged_at DESC
  `,
    [policyId],
  );
  return result.rows;
}

export async function getAcknowledgmentStats(policyId: number): Promise<any> {
  const result = await pool.query(
    `
    SELECT 
      COUNT(*) as total_acknowledged,
      COUNT(*) FILTER (WHERE expires_at > NOW() OR expires_at IS NULL) as current,
      COUNT(*) FILTER (WHERE expires_at <= NOW()) as expired
    FROM policy_acknowledgments
    WHERE policy_id = $1
  `,
    [policyId],
  );
  return result.rows[0];
}

export async function transitionPolicyStatus(
  id: number,
  newStatus: string,
  transitionedBy: string,
): Promise<Policy> {
  logger.info(
    "📝 [PolicyDB] Transitioning policy",
    id,
    "to status:",
    newStatus,
  );

  const policy = await getPolicyById(id);
  if (!policy) {
    throw new Error(`Policy with ID ${id} not found`);
  }

  const validTransitions: Record<string, string[]> = {
    draft: ["review"],
    review: ["draft", "approval"],
    approval: ["review", "published"],
    published: ["review", "archived", "retired"],
    archived: ["published"],
    retired: [],
  };

  const allowed = validTransitions[policy.status] || [];
  if (!allowed.includes(newStatus)) {
    throw new Error(`Cannot transition from ${policy.status} to ${newStatus}`);
  }

  const updates: any = { status: newStatus };

  if (newStatus === "published" && !policy.effective_date) {
    updates.effective_date = new Date();
  }

  if (newStatus === "published" && !policy.review_date) {
    const reviewDate = new Date();
    reviewDate.setFullYear(reviewDate.getFullYear() + 1);
    updates.review_date = reviewDate;
  }

  return updatePolicy(id, updates, transitionedBy);
}

export async function getOverduePolicies(): Promise<Policy[]> {
  logger.info("📊 [PolicyDB] Fetching overdue policies...");

  const result = await pool.query(`
    SELECT * FROM policies
    WHERE status = 'published'
    AND (review_date < NOW() OR expiry_date < NOW())
    ORDER BY COALESCE(review_date, expiry_date) ASC
  `);

  logger.info("✅ [PolicyDB] Found", result.rows.length, "overdue policies");
  return result.rows;
}

export async function getPendingAcknowledgments(
  department?: string,
): Promise<any[]> {
  logger.info("📊 [PolicyDB] Fetching policies pending acknowledgment...");

  let query = `
    SELECT p.id, p.policy_number, p.title, p.category, p.owner_department,
           (SELECT COUNT(*) FROM policy_acknowledgments WHERE policy_id = p.id) as ack_count
    FROM policies p
    WHERE p.requires_acknowledgment = true
    AND p.status = 'published'
  `;

  const params: any[] = [];
  if (department) {
    query += ` AND p.owner_department = $1`;
    params.push(department);
  }

  query += ` ORDER BY p.updated_at DESC`;

  const result = await pool.query(query, params);
  return result.rows;
}

export async function deletePolicy(id: number): Promise<boolean> {
  logger.info("🗑️ [PolicyDB] Deleting policy ID:", id);
  const result = await pool.query("DELETE FROM policies WHERE id = $1", [id]);
  return (result.rowCount || 0) > 0;
}

export async function linkPolicyToEntities(
  policyId: number,
  links: {
    risk_ids?: number[];
    control_ids?: number[];
    regulation_ids?: number[];
  },
): Promise<Policy> {
  const updates: any = {};
  if (links.risk_ids) updates.linked_risk_ids = links.risk_ids;
  if (links.control_ids) updates.linked_control_ids = links.control_ids;
  if (links.regulation_ids)
    updates.linked_regulation_ids = links.regulation_ids;
  return updatePolicy(policyId, updates, "system");
}

export async function getDocumentsByTypeSummary(): Promise<any[]> {
  const result = await pool.query(`
    SELECT 
      COALESCE(document_type, 'policy') as document_type,
      COUNT(*) as count,
      COUNT(*) FILTER (WHERE status = 'published') as published,
      COUNT(*) FILTER (WHERE status = 'draft') as draft,
      COUNT(*) FILTER (WHERE status = 'review') as in_review,
      COUNT(*) FILTER (WHERE status = 'approval') as pending_approval
    FROM policies
    GROUP BY COALESCE(document_type, 'policy')
    ORDER BY count DESC
  `);
  return result.rows;
}

export async function getReviewCycles(
  policyId?: number,
): Promise<PolicyReviewCycle[]> {
  let query =
    "SELECT prc.*, p.title as policy_title, p.policy_number FROM policy_review_cycles prc JOIN policies p ON prc.policy_id = p.id";
  const params: any[] = [];
  if (policyId) {
    query += " WHERE prc.policy_id = $1";
    params.push(policyId);
  }
  query += " ORDER BY prc.scheduled_date DESC";
  const result = await pool.query(query, params);
  return result.rows;
}

export async function createReviewCycle(
  cycle: PolicyReviewCycle,
): Promise<PolicyReviewCycle> {
  const result = await pool.query(
    `
    INSERT INTO policy_review_cycles (policy_id, scheduled_date, reviewer_name, status)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `,
    [
      cycle.policy_id,
      cycle.scheduled_date,
      cycle.reviewer_name,
      cycle.status || "scheduled",
    ],
  );
  return result.rows[0];
}

export async function updateReviewCycle(
  id: number,
  updates: Partial<PolicyReviewCycle>,
): Promise<PolicyReviewCycle> {
  const setClause: string[] = [];
  const values: any[] = [];
  let paramCount = 1;
  const allowed = [
    "actual_date",
    "reviewer_name",
    "review_outcome",
    "review_notes",
    "next_scheduled_date",
    "status",
  ];
  for (const [key, value] of Object.entries(updates)) {
    if (allowed.includes(key) && value !== undefined) {
      setClause.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
  }
  values.push(id);
  const result = await pool.query(
    `UPDATE policy_review_cycles SET ${setClause.join(", ")} WHERE id = $${paramCount} RETURNING *`,
    values,
  );
  return result.rows[0];
}
