import pg from "pg";
import { logger } from "./logger";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

let activityTablesReady: Promise<void> | null = null;
async function ensureActivityTables(): Promise<void> {
  if (activityTablesReady) return activityTablesReady;
  activityTablesReady = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_activities (
          id SERIAL PRIMARY KEY,
          action_type TEXT NOT NULL,
          action_description TEXT NOT NULL,
          target_type TEXT,
          target_id TEXT,
          target_name TEXT,
          actor_ip TEXT,
          metadata JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_admin_activities_created_at ON admin_activities(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_admin_activities_action_type ON admin_activities(action_type);

        CREATE TABLE IF NOT EXISTS workflow_runs (
          id SERIAL PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          workflow_name TEXT NOT NULL,
          run_id TEXT,
          status TEXT NOT NULL,
          trigger_type TEXT NOT NULL,
          trigger_source TEXT,
          input_data JSONB DEFAULT '{}'::jsonb,
          output_data JSONB,
          metadata JSONB DEFAULT '{}'::jsonb,
          started_at TIMESTAMPTZ DEFAULT NOW(),
          completed_at TIMESTAMPTZ,
          duration_ms INTEGER,
          error_message TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_runs_started_at ON workflow_runs(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

        CREATE TABLE IF NOT EXISTS system_events (
          id SERIAL PRIMARY KEY,
          event_type TEXT NOT NULL,
          event_category TEXT,
          description TEXT NOT NULL,
          severity TEXT NOT NULL DEFAULT 'info',
          source TEXT,
          metadata JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_system_events_created_at ON system_events(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_system_events_severity ON system_events(severity);
      `);
      logger.info(
        "[ActivityDB] admin_activities, workflow_runs, system_events tables ready",
      );
    } catch (err) {
      logger.error("[ActivityDB] Failed to ensure activity tables:", err);
      activityTablesReady = null;
      throw err;
    }
  })();
  return activityTablesReady;
}

export interface GovernanceDocument {
  id?: number;
  name: string;
  document_type: string;
  version: string;
  file_path?: string;
  content_text?: string;
  rules_json?: any;
  is_active: boolean;
  crm_module?: string;
  team_name?: string;
  created_at?: Date;
}

export interface QualityScorecard {
  id?: number;
  name: string;
  description?: string;
  dimensions: any;
  is_active: boolean;
  crm_module?: string;
  team_name?: string;
  governance_doc_id?: number;
  version?: string;
  created_by?: string;
}

export interface QualityAuditResult {
  id?: number;
  audit_date?: Date;
  scorecard_id?: number;
  governance_doc_id?: number;
  total_records_audited: number;
  total_issues_found: number;
  people_score: number;
  process_score: number;
  governance_score: number;
  overall_score: number;
  dimension_details?: any;
  issues_by_category?: any;
  recommendations?: any;
  calendar_events_count?: number;
  raw_audit_data?: any;
}

export async function getActiveGovernanceDocument(): Promise<GovernanceDocument | null> {
  const result = await pool.query(
    "SELECT * FROM governance_documents WHERE is_active = true ORDER BY created_at DESC LIMIT 1",
  );
  return result.rows[0] || null;
}

export async function getActiveScorecard(
  crmModule?: string,
  teamName?: string,
): Promise<QualityScorecard | null> {
  if (crmModule && teamName) {
    const result = await pool.query(
      "SELECT * FROM quality_scorecards WHERE crm_module = $1 AND team_name = $2 AND is_active = true ORDER BY created_at DESC LIMIT 1",
      [crmModule, teamName],
    );
    if (result.rows[0]) return result.rows[0];
  }

  if (crmModule) {
    const result = await pool.query(
      "SELECT * FROM quality_scorecards WHERE crm_module = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1",
      [crmModule],
    );
    if (result.rows[0]) return result.rows[0];
  }

  const result = await pool.query(
    "SELECT * FROM quality_scorecards WHERE is_active = true ORDER BY created_at DESC LIMIT 1",
  );
  return result.rows[0] || null;
}

export async function getScorecardByModule(
  crmModule: string,
): Promise<QualityScorecard | null> {
  const result = await pool.query(
    "SELECT * FROM quality_scorecards WHERE crm_module = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1",
    [crmModule],
  );
  return result.rows[0] || null;
}

export async function getActiveScorecardsAll(): Promise<QualityScorecard[]> {
  const result = await pool.query(
    "SELECT * FROM quality_scorecards WHERE is_active = true ORDER BY crm_module, created_at DESC",
  );
  return result.rows;
}

export async function saveGovernanceDocument(
  doc: GovernanceDocument,
): Promise<GovernanceDocument> {
  if (doc.crm_module) {
    await pool.query(
      "UPDATE governance_documents SET is_active = false WHERE crm_module = $1",
      [doc.crm_module],
    );
  } else {
    await pool.query(
      "UPDATE governance_documents SET is_active = false WHERE document_type = $1",
      [doc.document_type],
    );
  }

  const result = await pool.query(
    `INSERT INTO governance_documents (name, document_type, version, file_path, content_text, rules_json, is_active, crm_module, team_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      doc.name,
      doc.document_type,
      doc.version,
      doc.file_path,
      doc.content_text,
      JSON.stringify(doc.rules_json),
      doc.is_active,
      doc.crm_module || null,
      doc.team_name || null,
    ],
  );
  return result.rows[0];
}

export async function getGovernanceDocumentByModule(
  crmModule: string,
): Promise<GovernanceDocument | null> {
  const result = await pool.query(
    "SELECT * FROM governance_documents WHERE crm_module = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1",
    [crmModule],
  );
  return result.rows[0] || null;
}

export async function getActiveGovernanceDocumentsByModule(): Promise<
  GovernanceDocument[]
> {
  const result = await pool.query(
    "SELECT * FROM governance_documents WHERE is_active = true ORDER BY crm_module, created_at DESC",
  );
  return result.rows;
}

export async function saveScorecard(
  scorecard: QualityScorecard,
): Promise<QualityScorecard> {
  if (scorecard.crm_module) {
    await pool.query(
      "UPDATE quality_scorecards SET is_active = false WHERE crm_module = $1",
      [scorecard.crm_module],
    );
  } else {
    await pool.query(
      "UPDATE quality_scorecards SET is_active = false WHERE crm_module IS NULL",
    );
  }

  const result = await pool.query(
    `INSERT INTO quality_scorecards (name, description, dimensions, is_active, crm_module, team_name, governance_doc_id, version, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      scorecard.name,
      scorecard.description,
      JSON.stringify(scorecard.dimensions),
      scorecard.is_active,
      scorecard.crm_module || null,
      scorecard.team_name || null,
      scorecard.governance_doc_id || null,
      scorecard.version || "v1.0",
      scorecard.created_by || null,
    ],
  );
  return result.rows[0];
}

export async function saveAuditResult(
  audit: QualityAuditResult,
): Promise<QualityAuditResult> {
  const result = await pool.query(
    `INSERT INTO quality_audit_results 
     (scorecard_id, governance_doc_id, total_records_audited, total_issues_found, 
      people_score, process_score, governance_score, overall_score, 
      dimension_details, issues_by_category, recommendations, calendar_events_count, raw_audit_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      audit.scorecard_id,
      audit.governance_doc_id,
      audit.total_records_audited,
      audit.total_issues_found,
      audit.people_score,
      audit.process_score,
      audit.governance_score,
      audit.overall_score,
      JSON.stringify(audit.dimension_details),
      JSON.stringify(audit.issues_by_category),
      JSON.stringify(audit.recommendations),
      audit.calendar_events_count,
      JSON.stringify(audit.raw_audit_data),
    ],
  );

  const auditResult = result.rows[0];

  await saveTrendMetrics(auditResult.id, audit);

  return auditResult;
}

/**
 * Bulk insert helper — issues a single multi-row INSERT … VALUES (…),(…),…
 * chunked at `chunkSize` rows (default 500) to stay within Postgres parameter limits.
 *
 * Engineering SOP rule (Exports & Bulk Writes):
 *   All write paths that insert multiple rows MUST use this helper (or an
 *   equivalent) instead of looping single-row INSERTs.
 *
 * @param table     Target table name (trusted — never built from user input).
 * @param columns   Column names in insertion order.
 * @param rows      Objects whose keys match `columns`.
 * @param chunkSize Max rows per statement (default 500).
 */
export async function bulkInsert(
  table: string,
  columns: string[],
  rows: Record<string, any>[],
  {
    chunkSize = 500,
    _queryFn,
  }: {
    chunkSize?: number;
    /** For testing only: inject a mock query function instead of the real pool. */
    _queryFn?: (sql: string, values: any[]) => Promise<any>;
  } = {},
): Promise<void> {
  if (rows.length === 0) return;
  const queryFn =
    _queryFn ?? ((sql: string, values: any[]) => pool.query(sql, values));
  const n = columns.length;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values: any[] = [];
    const placeholders = chunk.map((row, ri) => {
      const ph = columns.map((col, ci) => {
        values.push(row[col] ?? null);
        return `$${ri * n + ci + 1}`;
      });
      return `(${ph.join(", ")})`;
    });
    await queryFn(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders.join(", ")}`,
      values,
    );
  }
}

async function saveTrendMetrics(auditId: number, audit: QualityAuditResult) {
  const metrics = [
    { name: "overall_score", value: audit.overall_score, dimension: "overall" },
    { name: "people_score", value: audit.people_score, dimension: "people" },
    { name: "process_score", value: audit.process_score, dimension: "process" },
    {
      name: "governance_score",
      value: audit.governance_score,
      dimension: "governance",
    },
    {
      name: "total_issues",
      value: audit.total_issues_found,
      dimension: "overall",
    },
    {
      name: "records_audited",
      value: audit.total_records_audited,
      dimension: "overall",
    },
  ];

  await bulkInsert(
    "quality_trends",
    ["audit_id", "metric_name", "metric_value", "dimension"],
    metrics.map((m) => ({
      audit_id: auditId,
      metric_name: m.name,
      metric_value: m.value,
      dimension: m.dimension,
    })),
  );
}

/**
 * Build the WHERE clause + params for the dashboard date filter.
 * The UI sends ISO date strings (YYYY-MM-DD). End date is treated as
 * inclusive end-of-day so a range like "04/27 → 04/27" still matches
 * audits run that same day. Returns an empty clause when no filter is
 * supplied so the caller can append it unconditionally.
 */
function buildAuditDateRangeClause(
  opts: { startDate?: string | null; endDate?: string | null } | undefined,
  startingParamIndex: number,
): { clause: string; params: any[] } {
  if (!opts) return { clause: "", params: [] };
  const params: any[] = [];
  const conds: string[] = [];
  if (opts.startDate) {
    params.push(opts.startDate);
    conds.push(`audit_date >= $${startingParamIndex + params.length - 1}`);
  }
  if (opts.endDate) {
    // Inclusive end-of-day, expressed as an exclusive upper bound on the
    // NEXT day. Avoids the `23:59:59.999` truncation bug — Postgres
    // timestamps support microseconds, so anything in the .999001-.999999
    // window would otherwise be silently dropped from the same-day range.
    params.push(opts.endDate);
    conds.push(
      `audit_date < ($${startingParamIndex + params.length - 1}::date + interval '1 day')`,
    );
  }
  const clause = conds.length > 0 ? ` WHERE ${conds.join(" AND ")}` : "";
  return { clause, params };
}

export async function getLatestAuditResult(opts?: {
  startDate?: string | null;
  endDate?: string | null;
}): Promise<QualityAuditResult | null> {
  const { clause, params } = buildAuditDateRangeClause(opts, 1);
  const result = await pool.query(
    `SELECT * FROM quality_audit_results${clause} ORDER BY audit_date DESC LIMIT 1`,
    params,
  );
  return result.rows[0] || null;
}

export async function getAuditHistory(
  limit: number = 10,
  opts?: { startDate?: string | null; endDate?: string | null },
): Promise<QualityAuditResult[]> {
  const { clause, params } = buildAuditDateRangeClause(opts, 1);
  params.push(limit);
  const result = await pool.query(
    `SELECT * FROM quality_audit_results${clause} ORDER BY audit_date DESC LIMIT $${params.length}`,
    params,
  );
  return result.rows;
}

export async function getTrendData(
  metricName: string,
  days: number = 30,
): Promise<any[]> {
  const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
  const result = await pool.query(
    `SELECT qt.metric_value, qt.recorded_at, qar.audit_date
     FROM quality_trends qt
     JOIN quality_audit_results qar ON qt.audit_id = qar.id
     WHERE qt.metric_name = $1 
     AND qt.recorded_at >= NOW() - make_interval(days => $2)
     ORDER BY qt.recorded_at ASC`,
    [metricName, safeDays],
  );
  return result.rows;
}

export async function getDashboardData(opts?: {
  startDate?: string | null;
  endDate?: string | null;
}): Promise<{
  latestAudit: QualityAuditResult | null;
  auditHistory: QualityAuditResult[];
  governance: GovernanceDocument | null;
  governanceDocs: GovernanceDocument[];
  scorecard: QualityScorecard | null;
  appliedDateRange: { startDate: string | null; endDate: string | null };
  trends: {
    overall: any[];
    people: any[];
    process: any[];
    governance: any[];
  };
}> {
  // When a date range is supplied, every headline KPI on the dashboard
  // (Overall / People / Process / Governance scores, Records Audited,
  // Issues Found, Compliance Rate) and the Audit History list are scoped
  // to audits whose `audit_date` falls within that window. The trend
  // sparklines below remain a 90-day rolling view by design.
  const range = {
    startDate: opts?.startDate || null,
    endDate: opts?.endDate || null,
  };
  const [latestAudit, auditHistory, governance, governanceDocs, scorecard] =
    await Promise.all([
      getLatestAuditResult(range),
      getAuditHistory(20, range),
      getActiveGovernanceDocument(),
      getActiveGovernanceDocumentsByModule(),
      getActiveScorecard(),
    ]);

  const [overallTrend, peopleTrend, processTrend, governanceTrend] =
    await Promise.all([
      getTrendData("overall_score", 90),
      getTrendData("people_score", 90),
      getTrendData("process_score", 90),
      getTrendData("governance_score", 90),
    ]);

  return {
    latestAudit,
    auditHistory,
    governance,
    governanceDocs,
    scorecard,
    appliedDateRange: range,
    trends: {
      overall: overallTrend,
      people: peopleTrend,
      process: processTrend,
      governance: governanceTrend,
    },
  };
}

export async function getAllGovernanceDocuments(): Promise<
  GovernanceDocument[]
> {
  const result = await pool.query(
    "SELECT * FROM governance_documents ORDER BY created_at DESC",
  );
  return result.rows;
}

export async function activateGovernanceDocument(id: number): Promise<void> {
  const docResult = await pool.query(
    "SELECT crm_module FROM governance_documents WHERE id = $1",
    [id],
  );
  const doc = docResult.rows[0];

  if (doc?.crm_module) {
    await pool.query(
      "UPDATE governance_documents SET is_active = false WHERE crm_module = $1",
      [doc.crm_module],
    );
  } else {
    await pool.query(
      "UPDATE governance_documents SET is_active = false WHERE crm_module IS NULL",
    );
  }
  await pool.query(
    "UPDATE governance_documents SET is_active = true WHERE id = $1",
    [id],
  );
}

export async function updateScorecardWeights(weights: {
  people: number;
  process: number;
  governance: number;
}): Promise<QualityScorecard | null> {
  const current = await getActiveScorecard();
  if (!current) return null;

  const dims =
    typeof current.dimensions === "string"
      ? JSON.parse(current.dimensions)
      : current.dimensions;

  if (dims.dimensions) {
    dims.dimensions.people.weight = weights.people;
    dims.dimensions.process.weight = weights.process;
    dims.dimensions.governance.weight = weights.governance;
  }

  const result = await pool.query(
    "UPDATE quality_scorecards SET dimensions = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
    [JSON.stringify(dims), current.id],
  );

  return result.rows[0] || null;
}

export async function addScorecardAttribute(attr: {
  name: string;
  description?: string;
  dimension: string;
  weight: number;
  target: number;
}): Promise<QualityScorecard | null> {
  const current = await getActiveScorecard();
  if (!current) return null;

  const dims =
    typeof current.dimensions === "string"
      ? JSON.parse(current.dimensions)
      : current.dimensions;

  if (dims.dimensions && dims.dimensions[attr.dimension]) {
    const newAttr = {
      name: attr.name,
      description: attr.description || "",
      weight: attr.weight,
      target: attr.target,
    };

    dims.dimensions[attr.dimension].attributes =
      dims.dimensions[attr.dimension].attributes || [];
    dims.dimensions[attr.dimension].attributes.push(newAttr);
  }

  const result = await pool.query(
    "UPDATE quality_scorecards SET dimensions = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
    [JSON.stringify(dims), current.id],
  );

  return result.rows[0] || null;
}

export async function linkScorecardToGovernanceDoc(
  governanceDocId: number,
  crmModule: string,
  teamName: string,
): Promise<QualityScorecard | null> {
  let scorecard = await getActiveScorecard(crmModule, teamName);

  if (!scorecard) {
    const defaultScorecard = await getActiveScorecard();
    if (!defaultScorecard) return null;

    const dims =
      typeof defaultScorecard.dimensions === "string"
        ? JSON.parse(defaultScorecard.dimensions)
        : defaultScorecard.dimensions;

    scorecard = await saveScorecard({
      name: `${teamName} Quality Scorecard`,
      description: `Quality scorecard for ${teamName} team managing ${crmModule}`,
      dimensions: dims,
      is_active: true,
      crm_module: crmModule,
      team_name: teamName,
      governance_doc_id: governanceDocId,
    });

    return scorecard;
  }

  const result = await pool.query(
    "UPDATE quality_scorecards SET governance_doc_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
    [governanceDocId, scorecard.id],
  );

  return result.rows[0] || null;
}

export interface ScorecardAttribute {
  id?: number;
  scorecard_id: number;
  dimension: string;
  attribute_name: string;
  description?: string;
  weight: number;
  severity?: string;
  evaluation_logic?: string;
  evidence_fields?: string;
  is_active: boolean;
  order_index: number;
  created_at?: Date;
  updated_at?: Date;
}

export async function getScorecardsByModuleAndTeam(
  crmModule?: string,
  teamName?: string,
): Promise<QualityScorecard[]> {
  if (crmModule && teamName) {
    const result = await pool.query(
      "SELECT * FROM quality_scorecards WHERE crm_module = $1 AND team_name = $2 ORDER BY is_active DESC, version DESC",
      [crmModule, teamName],
    );
    return result.rows;
  }
  if (crmModule) {
    const result = await pool.query(
      "SELECT * FROM quality_scorecards WHERE crm_module = $1 ORDER BY is_active DESC, version DESC",
      [crmModule],
    );
    return result.rows;
  }
  const result = await pool.query(
    "SELECT * FROM quality_scorecards ORDER BY is_active DESC, version DESC",
  );
  return result.rows;
}

export async function getScorecardById(
  id: number,
): Promise<QualityScorecard | null> {
  const result = await pool.query(
    "SELECT * FROM quality_scorecards WHERE id = $1",
    [id],
  );
  return result.rows[0] || null;
}

export async function createScorecard(scorecard: {
  name: string;
  description?: string;
  dimensions: any;
  crm_module: string;
  team_name: string;
  governance_doc_id?: number;
  version?: string;
  created_by?: string;
}): Promise<QualityScorecard> {
  const result = await pool.query(
    `INSERT INTO quality_scorecards (name, description, dimensions, is_active, crm_module, team_name, governance_doc_id, version, created_by)
     VALUES ($1, $2, $3, false, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      scorecard.name,
      scorecard.description,
      JSON.stringify(scorecard.dimensions),
      scorecard.crm_module,
      scorecard.team_name,
      scorecard.governance_doc_id || null,
      scorecard.version || "v1.0",
      scorecard.created_by || null,
    ],
  );
  return result.rows[0];
}

export async function updateScorecard(
  id: number,
  updates: Partial<QualityScorecard>,
): Promise<QualityScorecard | null> {
  const setClauses: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.name !== undefined) {
    setClauses.push(`name = $${paramIndex++}`);
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    setClauses.push(`description = $${paramIndex++}`);
    values.push(updates.description);
  }
  if (updates.dimensions !== undefined) {
    setClauses.push(`dimensions = $${paramIndex++}`);
    values.push(JSON.stringify(updates.dimensions));
  }
  if (updates.governance_doc_id !== undefined) {
    setClauses.push(`governance_doc_id = $${paramIndex++}`);
    values.push(updates.governance_doc_id);
  }
  if (updates.version !== undefined) {
    setClauses.push(`version = $${paramIndex++}`);
    values.push(updates.version);
  }

  if (setClauses.length === 0) return getScorecardById(id);

  setClauses.push(`updated_at = NOW()`);
  values.push(id);

  const result = await pool.query(
    `UPDATE quality_scorecards SET ${setClauses.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    values,
  );
  return result.rows[0] || null;
}

export async function deleteScorecard(id: number): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM quality_scorecards WHERE id = $1",
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function setActiveScorecardForTeam(
  id: number,
  crmModule: string,
  teamName: string,
): Promise<QualityScorecard | null> {
  await pool.query(
    "UPDATE quality_scorecards SET is_active = false WHERE crm_module = $1 AND team_name = $2",
    [crmModule, teamName],
  );
  const result = await pool.query(
    "UPDATE quality_scorecards SET is_active = true, updated_at = NOW() WHERE id = $1 RETURNING *",
    [id],
  );
  return result.rows[0] || null;
}

export async function cloneScorecard(
  id: number,
  newName: string,
  newVersion?: string,
): Promise<QualityScorecard | null> {
  const original = await getScorecardById(id);
  if (!original) return null;

  const result = await pool.query(
    `INSERT INTO quality_scorecards (name, description, dimensions, is_active, crm_module, team_name, governance_doc_id, version, created_by)
     VALUES ($1, $2, $3, false, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      newName,
      original.description,
      JSON.stringify(original.dimensions),
      original.crm_module,
      original.team_name,
      original.governance_doc_id,
      newVersion || "v1.0",
      null,
    ],
  );

  const newScorecard = result.rows[0];

  const attrsResult = await pool.query(
    "SELECT * FROM scorecard_attributes WHERE scorecard_id = $1 ORDER BY order_index",
    [id],
  );
  if (attrsResult.rows.length > 0) {
    await bulkInsert(
      "scorecard_attributes",
      [
        "scorecard_id",
        "dimension",
        "attribute_name",
        "description",
        "weight",
        "severity",
        "evaluation_logic",
        "evidence_fields",
        "is_active",
        "order_index",
      ],
      attrsResult.rows.map((attr) => ({
        scorecard_id: newScorecard.id,
        dimension: attr.dimension,
        attribute_name: attr.attribute_name,
        description: attr.description,
        weight: attr.weight,
        severity: attr.severity,
        evaluation_logic: attr.evaluation_logic,
        evidence_fields: attr.evidence_fields,
        is_active: attr.is_active,
        order_index: attr.order_index,
      })),
    );
  }

  return newScorecard;
}

export async function getScorecardAttributes(
  scorecardId: number,
): Promise<ScorecardAttribute[]> {
  const result = await pool.query(
    "SELECT * FROM scorecard_attributes WHERE scorecard_id = $1 ORDER BY order_index, id",
    [scorecardId],
  );
  return result.rows;
}

export async function createScorecardAttribute(
  attr: Omit<ScorecardAttribute, "id" | "created_at" | "updated_at">,
): Promise<ScorecardAttribute> {
  const result = await pool.query(
    `INSERT INTO scorecard_attributes (scorecard_id, dimension, attribute_name, description, weight, severity, evaluation_logic, evidence_fields, is_active, order_index)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      attr.scorecard_id,
      attr.dimension,
      attr.attribute_name,
      attr.description,
      attr.weight,
      attr.severity || "Minor",
      attr.evaluation_logic,
      attr.evidence_fields,
      attr.is_active,
      attr.order_index,
    ],
  );
  return result.rows[0];
}

export async function updateScorecardAttribute(
  id: number,
  updates: Partial<ScorecardAttribute>,
): Promise<ScorecardAttribute | null> {
  const setClauses: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.dimension !== undefined) {
    setClauses.push(`dimension = $${paramIndex++}`);
    values.push(updates.dimension);
  }
  if (updates.attribute_name !== undefined) {
    setClauses.push(`attribute_name = $${paramIndex++}`);
    values.push(updates.attribute_name);
  }
  if (updates.description !== undefined) {
    setClauses.push(`description = $${paramIndex++}`);
    values.push(updates.description);
  }
  if (updates.weight !== undefined) {
    setClauses.push(`weight = $${paramIndex++}`);
    values.push(updates.weight);
  }
  if (updates.severity !== undefined) {
    setClauses.push(`severity = $${paramIndex++}`);
    values.push(updates.severity);
  }
  if (updates.evaluation_logic !== undefined) {
    setClauses.push(`evaluation_logic = $${paramIndex++}`);
    values.push(updates.evaluation_logic);
  }
  if (updates.evidence_fields !== undefined) {
    setClauses.push(`evidence_fields = $${paramIndex++}`);
    values.push(updates.evidence_fields);
  }
  if (updates.is_active !== undefined) {
    setClauses.push(`is_active = $${paramIndex++}`);
    values.push(updates.is_active);
  }
  if (updates.order_index !== undefined) {
    setClauses.push(`order_index = $${paramIndex++}`);
    values.push(updates.order_index);
  }

  if (setClauses.length === 0) return null;

  setClauses.push(`updated_at = NOW()`);
  values.push(id);

  const result = await pool.query(
    `UPDATE scorecard_attributes SET ${setClauses.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    values,
  );
  return result.rows[0] || null;
}

export async function deleteScorecardAttribute(id: number): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM scorecard_attributes WHERE id = $1",
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function reorderScorecardAttributes(
  scorecardId: number,
  attributeIds: number[],
): Promise<void> {
  for (let i = 0; i < attributeIds.length; i++) {
    await pool.query(
      "UPDATE scorecard_attributes SET order_index = $1, updated_at = NOW() WHERE id = $2 AND scorecard_id = $3",
      [i, attributeIds[i], scorecardId],
    );
  }
}

export interface AdminActivity {
  id?: number;
  action_type: string;
  action_description: string;
  target_type?: string;
  target_id?: string;
  target_name?: string;
  actor_ip?: string;
  metadata?: any;
  created_at?: Date;
}

export interface WorkflowRun {
  id?: number;
  workflow_id: string;
  workflow_name: string;
  run_id?: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  trigger_type: "manual" | "scheduled" | "webhook" | "api";
  trigger_source?: string;
  started_at?: Date;
  completed_at?: Date;
  duration_ms?: number;
  input_data?: any;
  output_data?: any;
  error_message?: string;
  error_details?: any;
  metadata?: any;
}

export interface SystemEvent {
  id?: number;
  event_type: string;
  event_category: string;
  description: string;
  severity: "debug" | "info" | "warning" | "error" | "critical";
  source?: string;
  metadata?: any;
  created_at?: Date;
}

export async function logAdminActivity(
  activity: AdminActivity,
): Promise<AdminActivity> {
  try {
    await ensureActivityTables();
    const result = await pool.query(
      `INSERT INTO admin_activities 
       (action_type, action_description, target_type, target_id, target_name, actor_ip, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        activity.action_type,
        activity.action_description,
        activity.target_type || null,
        activity.target_id || null,
        activity.target_name || null,
        activity.actor_ip || null,
        JSON.stringify(activity.metadata || {}),
      ],
    );
    return result.rows[0];
  } catch (err) {
    logger.error(
      "[logAdminActivity] non-fatal write failure:",
      (err as Error).message,
    );
    return activity;
  }
}

export async function getAdminActivities(
  options: {
    limit?: number;
    offset?: number;
    action_type?: string;
    startDate?: Date;
    endDate?: Date;
  } = {},
): Promise<{ activities: AdminActivity[]; total: number }> {
  const { limit = 50, offset = 0, action_type, startDate, endDate } = options;

  let whereClause = "WHERE 1=1";
  const params: any[] = [];
  let paramIndex = 1;

  if (action_type) {
    whereClause += ` AND action_type = $${paramIndex}`;
    params.push(action_type);
    paramIndex++;
  }

  if (startDate) {
    whereClause += ` AND created_at >= $${paramIndex}`;
    params.push(startDate);
    paramIndex++;
  }

  if (endDate) {
    whereClause += ` AND created_at <= $${paramIndex}`;
    params.push(endDate);
    paramIndex++;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM admin_activities ${whereClause}`,
    params,
  );

  const result = await pool.query(
    `SELECT * FROM admin_activities ${whereClause} 
     ORDER BY created_at DESC 
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset],
  );

  return {
    activities: result.rows,
    total: parseInt(countResult.rows[0].count),
  };
}

export async function createWorkflowRun(
  run: WorkflowRun,
): Promise<WorkflowRun> {
  const result = await pool.query(
    `INSERT INTO workflow_runs 
     (workflow_id, workflow_name, run_id, status, trigger_type, trigger_source, input_data, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      run.workflow_id,
      run.workflow_name,
      run.run_id || null,
      run.status,
      run.trigger_type,
      run.trigger_source || null,
      JSON.stringify(run.input_data || {}),
      JSON.stringify(run.metadata || {}),
    ],
  );
  return result.rows[0];
}

export async function updateWorkflowRun(
  id: number,
  updates: Partial<WorkflowRun>,
): Promise<WorkflowRun | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.status !== undefined) {
    fields.push(`status = $${paramIndex}`);
    values.push(updates.status);
    paramIndex++;
  }

  if (updates.completed_at !== undefined) {
    fields.push(`completed_at = $${paramIndex}`);
    values.push(updates.completed_at);
    paramIndex++;
  }

  if (updates.duration_ms !== undefined) {
    fields.push(`duration_ms = $${paramIndex}`);
    values.push(updates.duration_ms);
    paramIndex++;
  }

  if (updates.output_data !== undefined) {
    fields.push(`output_data = $${paramIndex}`);
    values.push(JSON.stringify(updates.output_data));
    paramIndex++;
  }

  if (updates.error_message !== undefined) {
    fields.push(`error_message = $${paramIndex}`);
    values.push(updates.error_message);
    paramIndex++;
  }

  if (updates.error_details !== undefined) {
    fields.push(`error_details = $${paramIndex}`);
    values.push(JSON.stringify(updates.error_details));
    paramIndex++;
  }

  if (fields.length === 0) return null;

  values.push(id);

  const result = await pool.query(
    `UPDATE workflow_runs SET ${fields.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    values,
  );

  return result.rows[0] || null;
}

export async function updateWorkflowRunByRunId(
  runId: string,
  updates: Partial<WorkflowRun>,
): Promise<WorkflowRun | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.status !== undefined) {
    fields.push(`status = $${paramIndex}`);
    values.push(updates.status);
    paramIndex++;
  }

  if (updates.completed_at !== undefined) {
    fields.push(`completed_at = $${paramIndex}`);
    values.push(updates.completed_at);
    paramIndex++;
  }

  if (updates.duration_ms !== undefined) {
    fields.push(`duration_ms = $${paramIndex}`);
    values.push(updates.duration_ms);
    paramIndex++;
  }

  if (updates.output_data !== undefined) {
    fields.push(`output_data = $${paramIndex}`);
    values.push(JSON.stringify(updates.output_data));
    paramIndex++;
  }

  if (updates.error_message !== undefined) {
    fields.push(`error_message = $${paramIndex}`);
    values.push(updates.error_message);
    paramIndex++;
  }

  if (updates.error_details !== undefined) {
    fields.push(`error_details = $${paramIndex}`);
    values.push(JSON.stringify(updates.error_details));
    paramIndex++;
  }

  if (fields.length === 0) return null;

  values.push(runId);

  const result = await pool.query(
    `UPDATE workflow_runs SET ${fields.join(", ")} WHERE run_id = $${paramIndex} RETURNING *`,
    values,
  );

  return result.rows[0] || null;
}

export async function getWorkflowRuns(
  options: {
    limit?: number;
    offset?: number;
    workflow_id?: string;
    status?: string;
    startDate?: Date;
    endDate?: Date;
  } = {},
): Promise<{ runs: WorkflowRun[]; total: number }> {
  const {
    limit = 50,
    offset = 0,
    workflow_id,
    status,
    startDate,
    endDate,
  } = options;

  let whereClause = "WHERE 1=1";
  const params: any[] = [];
  let paramIndex = 1;

  if (workflow_id) {
    whereClause += ` AND workflow_id = $${paramIndex}`;
    params.push(workflow_id);
    paramIndex++;
  }

  if (status) {
    whereClause += ` AND status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }

  if (startDate) {
    whereClause += ` AND started_at >= $${paramIndex}`;
    params.push(startDate);
    paramIndex++;
  }

  if (endDate) {
    whereClause += ` AND started_at <= $${paramIndex}`;
    params.push(endDate);
    paramIndex++;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM workflow_runs ${whereClause}`,
    params,
  );

  const result = await pool.query(
    `SELECT * FROM workflow_runs ${whereClause} 
     ORDER BY started_at DESC 
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset],
  );

  return {
    runs: result.rows,
    total: parseInt(countResult.rows[0].count),
  };
}

export async function getWorkflowRunById(
  id: number,
): Promise<WorkflowRun | null> {
  const result = await pool.query("SELECT * FROM workflow_runs WHERE id = $1", [
    id,
  ]);
  return result.rows[0] || null;
}

export async function getWorkflowRunByRunId(
  runId: string,
): Promise<WorkflowRun | null> {
  const result = await pool.query(
    "SELECT * FROM workflow_runs WHERE run_id = $1",
    [runId],
  );
  return result.rows[0] || null;
}

export async function logSystemEvent(event: SystemEvent): Promise<SystemEvent> {
  const result = await pool.query(
    `INSERT INTO system_events 
     (event_type, event_category, description, severity, source, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      event.event_type,
      event.event_category,
      event.description,
      event.severity || "info",
      event.source || null,
      JSON.stringify(event.metadata || {}),
    ],
  );
  return result.rows[0];
}

export async function getSystemEvents(
  options: {
    limit?: number;
    offset?: number;
    event_type?: string;
    event_category?: string;
    severity?: string;
    startDate?: Date;
    endDate?: Date;
  } = {},
): Promise<{ events: SystemEvent[]; total: number }> {
  const {
    limit = 100,
    offset = 0,
    event_type,
    event_category,
    severity,
    startDate,
    endDate,
  } = options;

  let whereClause = "WHERE 1=1";
  const params: any[] = [];
  let paramIndex = 1;

  if (event_type) {
    whereClause += ` AND event_type = $${paramIndex}`;
    params.push(event_type);
    paramIndex++;
  }

  if (event_category) {
    whereClause += ` AND event_category = $${paramIndex}`;
    params.push(event_category);
    paramIndex++;
  }

  if (severity) {
    whereClause += ` AND severity = $${paramIndex}`;
    params.push(severity);
    paramIndex++;
  }

  if (startDate) {
    whereClause += ` AND created_at >= $${paramIndex}`;
    params.push(startDate);
    paramIndex++;
  }

  if (endDate) {
    whereClause += ` AND created_at <= $${paramIndex}`;
    params.push(endDate);
    paramIndex++;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM system_events ${whereClause}`,
    params,
  );

  const result = await pool.query(
    `SELECT * FROM system_events ${whereClause} 
     ORDER BY created_at DESC 
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset],
  );

  return {
    events: result.rows,
    total: parseInt(countResult.rows[0].count),
  };
}

export async function getActivityFeed(limit: number = 50): Promise<{
  activities: Array<{
    id: number;
    type: "admin" | "workflow" | "system";
    title: string;
    description: string;
    severity?: string;
    status?: string;
    timestamp: Date;
    metadata?: any;
  }>;
}> {
  const [adminResult, workflowResult, systemResult] = await Promise.all([
    pool.query(
      `SELECT id, action_type, action_description, target_name, created_at, metadata
       FROM admin_activities ORDER BY created_at DESC LIMIT $1`,
      [limit],
    ),
    pool.query(
      `SELECT id, workflow_name, status, trigger_type, started_at, duration_ms, error_message
       FROM workflow_runs ORDER BY started_at DESC LIMIT $1`,
      [limit],
    ),
    pool.query(
      `SELECT id, event_type, description, severity, source, created_at, metadata
       FROM system_events ORDER BY created_at DESC LIMIT $1`,
      [limit],
    ),
  ]);

  const activities: Array<{
    id: number;
    type: "admin" | "workflow" | "system";
    title: string;
    description: string;
    severity?: string;
    status?: string;
    timestamp: Date;
    metadata?: any;
  }> = [];

  for (const row of adminResult.rows) {
    activities.push({
      id: row.id,
      type: "admin",
      title: row.action_type,
      description: row.action_description,
      timestamp: row.created_at,
      metadata: row.metadata,
    });
  }

  for (const row of workflowResult.rows) {
    activities.push({
      id: row.id,
      type: "workflow",
      title: row.workflow_name,
      description: `${row.trigger_type} trigger - ${row.status}${row.duration_ms ? ` (${row.duration_ms}ms)` : ""}`,
      status: row.status,
      timestamp: row.started_at,
      metadata: { error_message: row.error_message },
    });
  }

  for (const row of systemResult.rows) {
    activities.push({
      id: row.id,
      type: "system",
      title: row.event_type,
      description: row.description,
      severity: row.severity,
      timestamp: row.created_at,
      metadata: row.metadata,
    });
  }

  activities.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return { activities: activities.slice(0, limit) };
}

export async function getActivityStats(): Promise<{
  adminActions: { today: number; week: number; month: number };
  workflowRuns: {
    total: number;
    completed: number;
    failed: number;
    running: number;
  };
  systemEvents: {
    info: number;
    warning: number;
    error: number;
    critical: number;
  };
}> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [adminStats, workflowStats, eventStats] = await Promise.all([
    pool.query(
      `
      SELECT 
        COUNT(*) FILTER (WHERE created_at >= $1) as today,
        COUNT(*) FILTER (WHERE created_at >= $2) as week,
        COUNT(*) FILTER (WHERE created_at >= $3) as month
      FROM admin_activities
    `,
      [startOfDay, startOfWeek, startOfMonth],
    ),

    pool.query(
      `
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COUNT(*) FILTER (WHERE status = 'running') as running
      FROM workflow_runs
      WHERE started_at >= $1
    `,
      [startOfMonth],
    ),

    pool.query(
      `
      SELECT 
        COUNT(*) FILTER (WHERE severity = 'info') as info,
        COUNT(*) FILTER (WHERE severity = 'warning') as warning,
        COUNT(*) FILTER (WHERE severity = 'error') as error,
        COUNT(*) FILTER (WHERE severity = 'critical') as critical
      FROM system_events
      WHERE created_at >= $1
    `,
      [startOfMonth],
    ),
  ]);

  return {
    adminActions: {
      today: parseInt(adminStats.rows[0].today) || 0,
      week: parseInt(adminStats.rows[0].week) || 0,
      month: parseInt(adminStats.rows[0].month) || 0,
    },
    workflowRuns: {
      total: parseInt(workflowStats.rows[0].total) || 0,
      completed: parseInt(workflowStats.rows[0].completed) || 0,
      failed: parseInt(workflowStats.rows[0].failed) || 0,
      running: parseInt(workflowStats.rows[0].running) || 0,
    },
    systemEvents: {
      info: parseInt(eventStats.rows[0].info) || 0,
      warning: parseInt(eventStats.rows[0].warning) || 0,
      error: parseInt(eventStats.rows[0].error) || 0,
      critical: parseInt(eventStats.rows[0].critical) || 0,
    },
  };
}

// ======================================================================
// Team Feedback Functions
// ======================================================================

export interface TeamFeedback {
  id?: number;
  submitter_name: string;
  submitter_role?: string;
  dashboard: string;
  rating: number;
  ease_of_use?: number;
  comments?: string;
  suggestions?: string;
  created_at?: Date;
}

async function ensureFeedbackTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_feedback (
      id SERIAL PRIMARY KEY,
      submitter_name VARCHAR(255) NOT NULL,
      submitter_role VARCHAR(100),
      dashboard VARCHAR(100) NOT NULL,
      rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      ease_of_use INTEGER CHECK (ease_of_use >= 1 AND ease_of_use <= 5),
      comments TEXT,
      suggestions TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(
    `ALTER TABLE team_feedback ADD COLUMN IF NOT EXISTS public_id UUID DEFAULT gen_random_uuid()`,
  );
  await pool.query(
    `UPDATE team_feedback SET public_id = gen_random_uuid() WHERE public_id IS NULL`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_team_feedback_public_id ON team_feedback(public_id)`,
  );
}

export async function submitFeedback(
  feedback: TeamFeedback,
): Promise<TeamFeedback> {
  await ensureFeedbackTable();
  const result = await pool.query(
    `INSERT INTO team_feedback (submitter_name, submitter_role, dashboard, rating, ease_of_use, comments, suggestions)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      feedback.submitter_name,
      feedback.submitter_role,
      feedback.dashboard,
      feedback.rating,
      feedback.ease_of_use,
      feedback.comments,
      feedback.suggestions,
    ],
  );
  return result.rows[0];
}

export async function getAllFeedback(filters?: {
  dashboard?: string;
  startDate?: string;
  endDate?: string;
}): Promise<TeamFeedback[]> {
  await ensureFeedbackTable();
  let query = "SELECT * FROM team_feedback WHERE 1=1";
  const params: any[] = [];
  let paramIndex = 1;

  if (filters?.dashboard) {
    query += ` AND dashboard = $${paramIndex++}`;
    params.push(filters.dashboard);
  }
  if (filters?.startDate) {
    query += ` AND created_at >= $${paramIndex++}`;
    params.push(filters.startDate);
  }
  if (filters?.endDate) {
    query += ` AND created_at <= $${paramIndex++}`;
    params.push(filters.endDate);
  }

  query += " ORDER BY created_at DESC";

  const result = await pool.query(query, params);
  return result.rows;
}

export async function getFeedbackStats(): Promise<{
  totalFeedback: number;
  avgRating: number;
  avgEaseOfUse: number;
  byDashboard: { dashboard: string; count: number; avgRating: number }[];
  recentFeedback: TeamFeedback[];
}> {
  await ensureFeedbackTable();
  const [totals, byDashboard, recent] = await Promise.all([
    pool.query(`
      SELECT 
        COUNT(*) as total,
        COALESCE(AVG(rating), 0) as avg_rating,
        COALESCE(AVG(ease_of_use), 0) as avg_ease
      FROM team_feedback
    `),
    pool.query(`
      SELECT 
        dashboard,
        COUNT(*) as count,
        AVG(rating) as avg_rating
      FROM team_feedback
      GROUP BY dashboard
      ORDER BY count DESC
    `),
    pool.query(`
      SELECT * FROM team_feedback 
      ORDER BY created_at DESC 
      LIMIT 10
    `),
  ]);

  return {
    totalFeedback: parseInt(totals.rows[0].total) || 0,
    avgRating: parseFloat(totals.rows[0].avg_rating) || 0,
    avgEaseOfUse: parseFloat(totals.rows[0].avg_ease) || 0,
    byDashboard: byDashboard.rows.map((r) => ({
      dashboard: r.dashboard,
      count: parseInt(r.count),
      avgRating: parseFloat(r.avg_rating),
    })),
    recentFeedback: recent.rows,
  };
}

export { pool };
