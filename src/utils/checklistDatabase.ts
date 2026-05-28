import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";

/**
 * Validates a WHERE-clause fragment from stored checklist config.
 *
 * SQL-injection risk: for count_check / existence_check / threshold_check the
 * `condition` and `column` fields are interpolated directly into SQL. Even
 * after module-level RBAC the values could contain subqueries or correlated
 * queries against restricted tables (e.g. `(SELECT secret FROM pdpl_data_inventory LIMIT 1) > 0`).
 *
 * This function rejects any string that contains SQL keywords commonly used to
 * reach outside the target table. It errs on the side of rejection: if the
 * expression looks like it contains a nested query, a table reference, or a
 * DML/DDL statement, it is blocked.
 */
function validateChecklistCondition(condition: string): { ok: true } | { ok: false; reason: string } {
  if (!condition || condition.trim() === "") return { ok: true };

  const upper = condition.toUpperCase();

  const BLOCKED_PATTERNS: Array<[RegExp, string]> = [
    [/\bSELECT\b/,             "SELECT subquery not allowed in condition"],
    [/\bFROM\b/,               "FROM clause not allowed in condition"],
    [/\bJOIN\b/,               "JOIN not allowed in condition"],
    [/\bUNION\b/,              "UNION not allowed in condition"],
    [/\bINTERSECT\b/,          "INTERSECT not allowed in condition"],
    [/\bEXCEPT\b/,             "EXCEPT not allowed in condition"],
    [/\bINSERT\b/,             "INSERT not allowed in condition"],
    [/\bUPDATE\b/,             "UPDATE not allowed in condition"],
    [/\bDELETE\b/,             "DELETE not allowed in condition"],
    [/\bDROP\b/,               "DROP not allowed in condition"],
    [/\bTRUNCATE\b/,           "TRUNCATE not allowed in condition"],
    [/\bALTER\b/,              "ALTER not allowed in condition"],
    [/\bGRANT\b/,              "GRANT not allowed in condition"],
    [/\bEXECUTE\b/,            "EXECUTE not allowed in condition"],
    [/\bPG_/,                  "pg_ system functions not allowed in condition"],
    [/\bINFORMATION_SCHEMA\b/, "information_schema not allowed in condition"],
    [/\bPG_CATALOG\b/,         "pg_catalog not allowed in condition"],
    [/\(\s*SELECT/i,           "subquery not allowed in condition"],
  ];

  for (const [pattern, reason] of BLOCKED_PATTERNS) {
    if (pattern.test(upper)) {
      return { ok: false, reason };
    }
  }

  return { ok: true };
}

/**
 * Validates a column-name fragment from stored checklist config.
 * Only simple SQL identifiers are permitted — no function calls, subqueries,
 * or expressions that could reference other tables.
 */
function validateChecklistColumn(column: string): { ok: true } | { ok: false; reason: string } {
  if (!column || column.trim() === "") return { ok: true };
  if (!/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(column.trim())) {
    return { ok: false, reason: `Column name '${column}' contains invalid characters; only simple identifiers are permitted` };
  }
  return { ok: true };
}

// Mirrors queryPlatformDataTool's MODULE_ROLE_ALLOWLIST so that automated
// checklist items cannot be used as a shadow reporting channel that bypasses
// the per-module RBAC enforced on normal REST API routes.
// pdpl and event_logs are intentionally absent — those tables must never be
// reachable through the checklist engine by non-admin roles.
export const CHECKLIST_MODULE_ROLE_ALLOWLIST: Record<string, string[]> = {
  nonconformances: ["admin"],
  capas:           ["admin"],
  risks:           ["admin", "head_of_operations_quality", "grc_manager", "quality_manager", "executive"],
  policies:        ["admin", "grc_manager", "quality_manager", "head_of_operations_quality", "bu_owner", "executive", "quality_specialist", "auditor", "team_lead", "ai_specialist"],
  audits:          ["admin", "head_of_operations_quality", "grc_manager", "quality_manager", "executive"],
  compliance:      ["admin", "head_of_operations_quality", "grc_manager", "quality_manager", "executive"],
  kpis:            ["admin", "quality_manager", "grc_manager", "head_of_operations_quality", "executive"],
  vendors:         ["admin", "head_of_operations_quality", "grc_manager", "quality_manager"],
  training:        ["admin"],
};

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

export interface ComplianceChecklist {
  id?: number;
  name: string;
  description?: string;
  standard: string;
  version?: string;
  category?: string;
  is_active?: boolean;
  created_by?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface ChecklistItem {
  id?: number;
  checklist_id: number;
  item_number: number;
  clause_reference?: string;
  question: string;
  expected_result?: string;
  check_type:
    | "data_query"
    | "count_check"
    | "existence_check"
    | "threshold_check"
    | "manual";
  module_to_query?: string;
  query_config?: any;
  weight?: number;
  is_critical?: boolean;
  created_at?: Date;
}

export interface ChecklistRun {
  id?: number;
  checklist_id: number;
  run_date?: Date;
  overall_score: number;
  total_items: number;
  passed_items: number;
  failed_items: number;
  na_items: number;
  item_results: any;
  run_by?: string;
  notes?: string;
  created_at?: Date;
}

export async function initChecklistTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS compliance_checklists (
      id SERIAL PRIMARY KEY,
      name VARCHAR(500) NOT NULL,
      description TEXT,
      standard VARCHAR(100) NOT NULL,
      version VARCHAR(50) DEFAULT '1.0',
      category VARCHAR(100),
      is_active BOOLEAN DEFAULT true,
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS checklist_items (
      id SERIAL PRIMARY KEY,
      checklist_id INTEGER REFERENCES compliance_checklists(id) ON DELETE CASCADE,
      item_number INTEGER NOT NULL,
      clause_reference VARCHAR(100),
      question TEXT NOT NULL,
      expected_result TEXT,
      check_type VARCHAR(30) NOT NULL DEFAULT 'manual',
      module_to_query VARCHAR(50),
      query_config JSONB DEFAULT '{}'::jsonb,
      weight DECIMAL(3,2) DEFAULT 1.0,
      is_critical BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_checklist_items_checklist ON checklist_items(checklist_id)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS checklist_runs (
      id SERIAL PRIMARY KEY,
      checklist_id INTEGER REFERENCES compliance_checklists(id) ON DELETE CASCADE,
      run_date TIMESTAMP DEFAULT NOW(),
      overall_score DECIMAL(5,2) NOT NULL DEFAULT 0,
      total_items INTEGER NOT NULL DEFAULT 0,
      passed_items INTEGER NOT NULL DEFAULT 0,
      failed_items INTEGER NOT NULL DEFAULT 0,
      na_items INTEGER NOT NULL DEFAULT 0,
      item_results JSONB NOT NULL DEFAULT '[]'::jsonb,
      run_by VARCHAR(255),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_checklist_runs_checklist ON checklist_runs(checklist_id)`,
  );

  logger.info("[ChecklistDB] Tables initialized");
}

export async function createChecklist(
  checklist: Omit<ComplianceChecklist, "id" | "created_at" | "updated_at">,
): Promise<ComplianceChecklist> {
  const result = await pool.query(
    `INSERT INTO compliance_checklists (name, description, standard, version, category, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      checklist.name,
      checklist.description || null,
      checklist.standard,
      checklist.version || "1.0",
      checklist.category || null,
      checklist.is_active !== false,
      checklist.created_by || "system",
    ],
  );
  return result.rows[0];
}

export async function addChecklistItems(
  checklistId: number,
  items: Omit<ChecklistItem, "id" | "checklist_id" | "created_at">[],
): Promise<ChecklistItem[]> {
  if (items.length === 0) return [];
  const COLS = [
    "checklist_id",
    "item_number",
    "clause_reference",
    "question",
    "expected_result",
    "check_type",
    "module_to_query",
    "query_config",
    "weight",
    "is_critical",
  ] as const;
  const chunkSize = 500;
  const allRows: ChecklistItem[] = [];
  for (let start = 0; start < items.length; start += chunkSize) {
    const chunk = items.slice(start, start + chunkSize);
    const n = COLS.length;
    const values: any[] = [];
    const placeholders = chunk.map((item, ri) => {
      values.push(
        checklistId,
        item.item_number,
        item.clause_reference || null,
        item.question,
        item.expected_result || null,
        item.check_type || "manual",
        item.module_to_query || null,
        item.query_config ? JSON.stringify(item.query_config) : "{}",
        item.weight ?? 1.0,
        item.is_critical || false,
      );
      return `(${COLS.map((_, ci) => `$${ri * n + ci + 1}`).join(", ")})`;
    });
    const result = await pool.query(
      `INSERT INTO checklist_items (${COLS.join(", ")}) VALUES ${placeholders.join(", ")} RETURNING *`,
      values,
    );
    allRows.push(...result.rows);
  }
  return allRows;
}

export async function getChecklists(filters?: {
  standard?: string;
  is_active?: boolean;
}): Promise<ComplianceChecklist[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters?.standard) {
    conditions.push(`standard = $${idx++}`);
    params.push(filters.standard);
  }
  if (filters?.is_active !== undefined) {
    conditions.push(`is_active = $${idx++}`);
    params.push(filters.is_active);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pool.query(
    `SELECT * FROM compliance_checklists ${where} ORDER BY standard, name`,
    params,
  );
  return result.rows;
}

export async function getChecklistById(
  id: number,
): Promise<{ checklist: ComplianceChecklist; items: ChecklistItem[] } | null> {
  const checklistResult = await pool.query(
    `SELECT * FROM compliance_checklists WHERE id = $1`,
    [id],
  );
  if (checklistResult.rows.length === 0) return null;

  const itemsResult = await pool.query(
    `SELECT * FROM checklist_items WHERE checklist_id = $1 ORDER BY item_number`,
    [id],
  );
  return { checklist: checklistResult.rows[0], items: itemsResult.rows };
}

export async function deleteChecklist(id: number): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM compliance_checklists WHERE id = $1 RETURNING id`,
    [id],
  );
  return result.rows.length > 0;
}

export async function saveChecklistRun(
  run: Omit<ChecklistRun, "id" | "created_at">,
): Promise<ChecklistRun> {
  const result = await pool.query(
    `INSERT INTO checklist_runs (checklist_id, overall_score, total_items, passed_items, failed_items, na_items, item_results, run_by, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      run.checklist_id,
      run.overall_score,
      run.total_items,
      run.passed_items,
      run.failed_items,
      run.na_items,
      JSON.stringify(run.item_results),
      run.run_by || "ai_consultant",
      run.notes || null,
    ],
  );
  return result.rows[0];
}

export async function getChecklistRuns(
  checklistId: number,
  limit: number = 10,
): Promise<ChecklistRun[]> {
  const result = await pool.query(
    `SELECT * FROM checklist_runs WHERE checklist_id = $1 ORDER BY run_date DESC LIMIT $2`,
    [checklistId, limit],
  );
  return result.rows;
}

export async function executeChecklistItem(
  item: ChecklistItem,
  callerRole?: string,
): Promise<{
  status: "pass" | "fail" | "na" | "error";
  actual_value: any;
  details: string;
}> {
  try {
    if (item.check_type === "manual") {
      return {
        status: "na",
        actual_value: null,
        details: "Manual verification required",
      };
    }

    const config = item.query_config || {};
    const module = item.module_to_query;

    if (!module) {
      return {
        status: "na",
        actual_value: null,
        details: "No module configured for automated check",
      };
    }

    // pdpl and event_logs are restricted to admin-only API routes and must
    // never be reachable through the checklist engine.
    const tableMap: Record<string, string> = {
      nonconformances: "nonconformance_records",
      capas: "capa_records",
      risks: "enterprise_risks",
      policies: "policies",
      compliance: "obligations",
      kpis: "kpi_definitions",
      training: "training_assignments",
      vendors: "vendors",
      audits: "quality_audit_results",
    };

    // Enforce per-module RBAC — default-deny.
    // callerRole must be a known role string; if it is absent (undefined) the
    // execution context could not be verified and we refuse rather than fail open.
    const allowedRoles = CHECKLIST_MODULE_ROLE_ALLOWLIST[module];
    if (!callerRole || !allowedRoles || !allowedRoles.includes(callerRole)) {
      logger.warn("[ChecklistDB] Role not permitted for module in checklist item", {
        module,
        callerRole: callerRole ?? "(none)",
      });
      return {
        status: "na",
        actual_value: null,
        details: callerRole
          ? `Access denied: role '${callerRole}' is not permitted to query the '${module}' module`
          : "Access denied: no verified role context available for automated checklist execution",
      };
    }

    // data_query executes arbitrary stored SQL — restrict to admin only.
    if (item.check_type === "data_query" && callerRole !== "admin") {
      return {
        status: "na",
        actual_value: null,
        details: "data_query checks require administrator role",
      };
    }

    const table = tableMap[module];
    if (!table) {
      return {
        status: "na",
        actual_value: null,
        details: `Unknown module: ${module}`,
      };
    }

    if (item.check_type === "count_check") {
      const condition = config.condition || "";
      if (condition) {
        const v = validateChecklistCondition(condition);
        if (!v.ok) {
          return { status: "error", actual_value: null, details: `Invalid condition: ${v.reason}` };
        }
      }
      const query = condition
        ? `SELECT COUNT(*)::int as count FROM ${table} WHERE ${condition}`
        : `SELECT COUNT(*)::int as count FROM ${table}`;
      const result = await pool.query(query);
      const count = result.rows[0]?.count || 0;
      const threshold = config.min_count ?? 0;
      const maxAllowed = config.max_count;

      if (maxAllowed !== undefined) {
        const passed = count <= maxAllowed;
        return {
          status: passed ? "pass" : "fail",
          actual_value: count,
          details: `Found ${count} records (max allowed: ${maxAllowed})`,
        };
      }
      const passed = count >= threshold;
      return {
        status: passed ? "pass" : "fail",
        actual_value: count,
        details: `Found ${count} records (minimum required: ${threshold})`,
      };
    }

    if (item.check_type === "existence_check") {
      const condition = config.condition || "1=1";
      if (condition !== "1=1") {
        const v = validateChecklistCondition(condition);
        if (!v.ok) {
          return { status: "error", actual_value: null, details: `Invalid condition: ${v.reason}` };
        }
      }
      const result = await pool.query(
        `SELECT EXISTS(SELECT 1 FROM ${table} WHERE ${condition}) as exists_flag`,
      );
      const exists = result.rows[0]?.exists_flag || false;
      const shouldExist = config.should_exist !== false;
      const passed = exists === shouldExist;
      return {
        status: passed ? "pass" : "fail",
        actual_value: exists,
        details: exists ? "Records found" : "No records found",
      };
    }

    if (item.check_type === "threshold_check") {
      const column = config.column || "id";
      const condition = config.condition || "";
      const colCheck = validateChecklistColumn(column);
      if (!colCheck.ok) {
        return { status: "error", actual_value: null, details: `Invalid column: ${colCheck.reason}` };
      }
      if (condition) {
        const condCheck = validateChecklistCondition(condition);
        if (!condCheck.ok) {
          return { status: "error", actual_value: null, details: `Invalid condition: ${condCheck.reason}` };
        }
      }
      const query = condition
        ? `SELECT AVG(${column})::numeric as avg_val FROM ${table} WHERE ${condition}`
        : `SELECT AVG(${column})::numeric as avg_val FROM ${table}`;
      const result = await pool.query(query);
      const avgVal = parseFloat(result.rows[0]?.avg_val) || 0;
      const minThreshold = config.min_threshold ?? 0;
      const passed = avgVal >= minThreshold;
      return {
        status: passed ? "pass" : "fail",
        actual_value: avgVal,
        details: `Average: ${avgVal.toFixed(2)} (threshold: ${minThreshold})`,
      };
    }

    if (item.check_type === "data_query") {
      const query = config.sql;
      if (!query)
        return {
          status: "na",
          actual_value: null,
          details: "No SQL query configured",
        };
      const result = await pool.query(query);
      const value = result.rows[0];
      const evalFn = config.eval;
      if (evalFn === "zero_is_pass") {
        const count = parseInt(value?.count) || 0;
        return {
          status: count === 0 ? "pass" : "fail",
          actual_value: count,
          details: `Found ${count} (expected 0)`,
        };
      }
      if (evalFn === "nonzero_is_pass") {
        const count = parseInt(value?.count) || 0;
        return {
          status: count > 0 ? "pass" : "fail",
          actual_value: count,
          details: `Found ${count} (expected > 0)`,
        };
      }
      return {
        status: "pass",
        actual_value: value,
        details: "Query executed successfully",
      };
    }

    return {
      status: "na",
      actual_value: null,
      details: `Unsupported check type: ${item.check_type}`,
    };
  } catch (err) {
    return {
      status: "error",
      actual_value: null,
      details: `Check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runChecklist(
  checklistId: number,
  runBy?: string,
  callerRole?: string,
): Promise<ChecklistRun> {
  const data = await getChecklistById(checklistId);
  if (!data) throw new Error(`Checklist ${checklistId} not found`);

  const { checklist, items } = data;
  const itemResults: any[] = [];
  let passed = 0,
    failed = 0,
    na = 0;

  for (const item of items) {
    const result = await executeChecklistItem(item, callerRole);
    itemResults.push({
      item_number: item.item_number,
      clause_reference: item.clause_reference,
      question: item.question,
      expected_result: item.expected_result,
      check_type: item.check_type,
      is_critical: item.is_critical,
      ...result,
    });
    if (result.status === "pass") passed++;
    else if (result.status === "fail") failed++;
    else na++;
  }

  const scorable = passed + failed;
  const score =
    scorable > 0 ? Math.round((passed / scorable) * 10000) / 100 : 0;

  const run = await saveChecklistRun({
    checklist_id: checklistId,
    overall_score: score,
    total_items: items.length,
    passed_items: passed,
    failed_items: failed,
    na_items: na,
    item_results: itemResults,
    run_by: runBy || "ai_consultant",
  });

  return run;
}
