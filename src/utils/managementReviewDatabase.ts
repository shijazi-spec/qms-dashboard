import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

export interface ManagementReview {
  id?: number;
  review_number: string;
  title: string;
  review_date: string;
  chair: string;
  attendees: string[];
  status: "planned" | "in_progress" | "completed" | "cancelled";
  agenda_items?: AgendaItem[];
  minutes?: string;
  decisions?: ReviewDecision[];
  action_items?: ReviewAction[];
  input_summary?: ReviewInputSummary;
  output_summary?: string;
  next_review_date?: string;
  created_by?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface AgendaItem {
  topic: string;
  presenter?: string;
  duration_minutes?: number;
  notes?: string;
}

export interface ReviewDecision {
  decision: string;
  rationale?: string;
  decided_by: string;
  priority: "high" | "medium" | "low";
}

export interface ReviewAction {
  id?: number;
  review_id?: number;
  action_number: number;
  description: string;
  assigned_to: string;
  due_date: string;
  status: "open" | "in_progress" | "completed" | "overdue" | "cancelled";
  completion_date?: string;
  completion_notes?: string;
  priority: "critical" | "high" | "medium" | "low";
  created_at?: Date;
  updated_at?: Date;
}

export interface ReviewInputSummary {
  nc_summary?: { open: number; closed: number; total: number };
  capa_summary?: {
    open: number;
    closed: number;
    effective: number;
    not_effective: number;
  };
  audit_score?: number;
  kpi_status?: { green: number; amber: number; red: number };
  risk_status?: { critical: number; high: number; medium: number; low: number };
  customer_feedback?: string;
  process_changes?: string;
  resource_needs?: string;
}

async function safeQuery(sql: string, params: any[] = []): Promise<any[]> {
  try {
    const result = await pool.query(sql, params);
    return result.rows;
  } catch (error) {
    logger.error(
      "[MgmtReview DB] Query error:",
      error instanceof Error ? error.message : error,
    );
    throw error;
  }
}

export async function initManagementReviewTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS management_reviews (
      id SERIAL PRIMARY KEY,
      review_number VARCHAR(50) UNIQUE NOT NULL,
      title VARCHAR(255) NOT NULL,
      review_date DATE NOT NULL,
      chair VARCHAR(255) NOT NULL,
      attendees JSONB DEFAULT '[]',
      status VARCHAR(50) DEFAULT 'planned',
      agenda_items JSONB DEFAULT '[]',
      minutes TEXT,
      decisions JSONB DEFAULT '[]',
      input_summary JSONB DEFAULT '{}',
      output_summary TEXT,
      next_review_date DATE,
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS management_review_actions (
      id SERIAL PRIMARY KEY,
      review_id INTEGER REFERENCES management_reviews(id) ON DELETE CASCADE,
      action_number INTEGER NOT NULL,
      description TEXT NOT NULL,
      assigned_to VARCHAR(255) NOT NULL,
      due_date DATE NOT NULL,
      status VARCHAR(50) DEFAULT 'open',
      completion_date DATE,
      completion_notes TEXT,
      priority VARCHAR(50) DEFAULT 'medium',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function generateReviewNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const rows = await safeQuery(
    `SELECT COUNT(*) as cnt FROM management_reviews WHERE review_number LIKE $1`,
    [`MR-${year}-%`],
  );
  const seq = (parseInt(rows[0]?.cnt || "0") + 1).toString().padStart(3, "0");
  return `MR-${year}-${seq}`;
}

export async function createReview(
  data: Partial<ManagementReview>,
): Promise<ManagementReview> {
  await initManagementReviewTables();
  const reviewNumber = data.review_number || (await generateReviewNumber());
  const rows = await safeQuery(
    `INSERT INTO management_reviews (review_number, title, review_date, chair, attendees, status, agenda_items, minutes, decisions, input_summary, output_summary, next_review_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      reviewNumber,
      data.title || "Management Review",
      data.review_date,
      data.chair || "Quality Manager",
      JSON.stringify(data.attendees || []),
      data.status || "planned",
      JSON.stringify(data.agenda_items || []),
      data.minutes || null,
      JSON.stringify(data.decisions || []),
      JSON.stringify(data.input_summary || {}),
      data.output_summary || null,
      data.next_review_date || null,
      data.created_by || null,
    ],
  );
  return rows[0];
}

export async function getReviews(filters?: {
  status?: string;
  year?: number;
  limit?: number;
  offset?: number;
}): Promise<{ reviews: ManagementReview[]; total: number }> {
  await initManagementReviewTables();
  let where = "WHERE 1=1";
  const params: any[] = [];
  let idx = 1;

  if (filters?.status) {
    where += ` AND status = $${idx++}`;
    params.push(filters.status);
  }
  if (filters?.year) {
    where += ` AND EXTRACT(YEAR FROM review_date) = $${idx++}`;
    params.push(filters.year);
  }

  const countRows = await safeQuery(
    `SELECT COUNT(*) as total FROM management_reviews ${where}`,
    params,
  );
  const total = parseInt(countRows[0]?.total || "0");

  const limit = filters?.limit || 50;
  const offset = filters?.offset || 0;
  const reviews = await safeQuery(
    `SELECT * FROM management_reviews ${where} ORDER BY review_date DESC LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset],
  );

  return { reviews, total };
}

export async function getReviewById(
  id: number,
): Promise<ManagementReview | null> {
  await initManagementReviewTables();
  const rows = await safeQuery(
    `SELECT * FROM management_reviews WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const review = rows[0];
  const actions = await safeQuery(
    `SELECT * FROM management_review_actions WHERE review_id = $1 ORDER BY action_number`,
    [id],
  );
  review.action_items = actions;
  return review;
}

export async function updateReview(
  id: number,
  data: Partial<ManagementReview>,
): Promise<ManagementReview | null> {
  const fields: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (data.title !== undefined) {
    fields.push(`title = $${idx++}`);
    params.push(data.title);
  }
  if (data.review_date !== undefined) {
    fields.push(`review_date = $${idx++}`);
    params.push(data.review_date);
  }
  if (data.chair !== undefined) {
    fields.push(`chair = $${idx++}`);
    params.push(data.chair);
  }
  if (data.attendees !== undefined) {
    fields.push(`attendees = $${idx++}`);
    params.push(JSON.stringify(data.attendees));
  }
  if (data.status !== undefined) {
    fields.push(`status = $${idx++}`);
    params.push(data.status);
  }
  if (data.agenda_items !== undefined) {
    fields.push(`agenda_items = $${idx++}`);
    params.push(JSON.stringify(data.agenda_items));
  }
  if (data.minutes !== undefined) {
    fields.push(`minutes = $${idx++}`);
    params.push(data.minutes);
  }
  if (data.decisions !== undefined) {
    fields.push(`decisions = $${idx++}`);
    params.push(JSON.stringify(data.decisions));
  }
  if (data.input_summary !== undefined) {
    fields.push(`input_summary = $${idx++}`);
    params.push(JSON.stringify(data.input_summary));
  }
  if (data.output_summary !== undefined) {
    fields.push(`output_summary = $${idx++}`);
    params.push(data.output_summary);
  }
  if (data.next_review_date !== undefined) {
    fields.push(`next_review_date = $${idx++}`);
    params.push(data.next_review_date);
  }

  if (fields.length === 0) return getReviewById(id);
  fields.push(`updated_at = NOW()`);

  const rows = await safeQuery(
    `UPDATE management_reviews SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
    [...params, id],
  );
  return rows.length > 0 ? rows[0] : null;
}

export async function deleteReview(id: number): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM management_reviews WHERE id = $1`,
    [id],
  );
  return (result.rowCount || 0) > 0;
}

export async function addReviewAction(
  reviewId: number,
  data: Partial<ReviewAction>,
): Promise<ReviewAction> {
  const countRows = await safeQuery(
    `SELECT COALESCE(MAX(action_number), 0) + 1 as next FROM management_review_actions WHERE review_id = $1`,
    [reviewId],
  );
  const actionNumber =
    data.action_number || parseInt(countRows[0]?.next || "1");

  const rows = await safeQuery(
    `INSERT INTO management_review_actions (review_id, action_number, description, assigned_to, due_date, status, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      reviewId,
      actionNumber,
      data.description,
      data.assigned_to,
      data.due_date,
      data.status || "open",
      data.priority || "medium",
    ],
  );
  return rows[0];
}

export async function updateReviewAction(
  actionId: number,
  data: Partial<ReviewAction>,
): Promise<ReviewAction | null> {
  const fields: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (data.description !== undefined) {
    fields.push(`description = $${idx++}`);
    params.push(data.description);
  }
  if (data.assigned_to !== undefined) {
    fields.push(`assigned_to = $${idx++}`);
    params.push(data.assigned_to);
  }
  if (data.due_date !== undefined) {
    fields.push(`due_date = $${idx++}`);
    params.push(data.due_date);
  }
  if (data.status !== undefined) {
    fields.push(`status = $${idx++}`);
    params.push(data.status);
  }
  if (data.completion_date !== undefined) {
    fields.push(`completion_date = $${idx++}`);
    params.push(data.completion_date);
  }
  if (data.completion_notes !== undefined) {
    fields.push(`completion_notes = $${idx++}`);
    params.push(data.completion_notes);
  }
  if (data.priority !== undefined) {
    fields.push(`priority = $${idx++}`);
    params.push(data.priority);
  }

  if (fields.length === 0) return null;
  fields.push(`updated_at = NOW()`);

  const rows = await safeQuery(
    `UPDATE management_review_actions SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
    [...params, actionId],
  );
  return rows.length > 0 ? rows[0] : null;
}

export async function getReviewActionsSummary(): Promise<{
  total: number;
  open: number;
  overdue: number;
  completed: number;
}> {
  await initManagementReviewTables();
  const rows = await safeQuery(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status IN ('open', 'in_progress')) as open,
      COUNT(*) FILTER (WHERE status = 'open' AND due_date < CURRENT_DATE) as overdue,
      COUNT(*) FILTER (WHERE status = 'completed') as completed
    FROM management_review_actions
  `);
  return {
    total: parseInt(rows[0]?.total || "0"),
    open: parseInt(rows[0]?.open || "0"),
    overdue: parseInt(rows[0]?.overdue || "0"),
    completed: parseInt(rows[0]?.completed || "0"),
  };
}

export async function gatherReviewInputs(): Promise<ReviewInputSummary> {
  const summary: ReviewInputSummary = {};

  try {
    const ncRows = await safeQuery(`
      SELECT
        COUNT(*) FILTER (WHERE status NOT IN ('closed', 'rejected')) as open,
        COUNT(*) FILTER (WHERE status = 'closed') as closed,
        COUNT(*) as total
      FROM nonconformance_records
    `);
    summary.nc_summary = {
      open: parseInt(ncRows[0]?.open || "0"),
      closed: parseInt(ncRows[0]?.closed || "0"),
      total: parseInt(ncRows[0]?.total || "0"),
    };
  } catch {
    /* table may not exist */
  }

  try {
    const capaRows = await safeQuery(`
      SELECT
        COUNT(*) FILTER (WHERE status NOT IN ('closed', 'cancelled')) as open,
        COUNT(*) FILTER (WHERE status = 'closed') as closed,
        COUNT(*) FILTER (WHERE effectiveness_result = 'effective') as effective,
        COUNT(*) FILTER (WHERE effectiveness_result = 'not_effective') as not_effective
      FROM capa_records
    `);
    summary.capa_summary = {
      open: parseInt(capaRows[0]?.open || "0"),
      closed: parseInt(capaRows[0]?.closed || "0"),
      effective: parseInt(capaRows[0]?.effective || "0"),
      not_effective: parseInt(capaRows[0]?.not_effective || "0"),
    };
  } catch {
    /* table may not exist */
  }

  try {
    const auditRows = await safeQuery(
      `SELECT overall_score FROM quality_audits ORDER BY audit_date DESC LIMIT 1`,
    );
    summary.audit_score = parseFloat(auditRows[0]?.overall_score || "0");
  } catch {
    /* table may not exist */
  }

  try {
    const kpiRows = await safeQuery(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'green' OR status = 'on_track') as green,
        COUNT(*) FILTER (WHERE status = 'amber' OR status = 'at_risk') as amber,
        COUNT(*) FILTER (WHERE status = 'red' OR status = 'off_track') as red
      FROM kpi_entries
    `);
    summary.kpi_status = {
      green: parseInt(kpiRows[0]?.green || "0"),
      amber: parseInt(kpiRows[0]?.amber || "0"),
      red: parseInt(kpiRows[0]?.red || "0"),
    };
  } catch {
    /* table may not exist */
  }

  try {
    const riskRows = await safeQuery(`
      SELECT
        COUNT(*) FILTER (WHERE (likelihood * impact) >= 20) as critical,
        COUNT(*) FILTER (WHERE (likelihood * impact) >= 15 AND (likelihood * impact) < 20) as high,
        COUNT(*) FILTER (WHERE (likelihood * impact) >= 8 AND (likelihood * impact) < 15) as medium,
        COUNT(*) FILTER (WHERE (likelihood * impact) < 8) as low
      FROM risk_register
    `);
    summary.risk_status = {
      critical: parseInt(riskRows[0]?.critical || "0"),
      high: parseInt(riskRows[0]?.high || "0"),
      medium: parseInt(riskRows[0]?.medium || "0"),
      low: parseInt(riskRows[0]?.low || "0"),
    };
  } catch {
    /* table may not exist */
  }

  return summary;
}
