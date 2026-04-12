import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
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
  check_type: 'data_query' | 'count_check' | 'existence_check' | 'threshold_check' | 'manual';
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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_checklist_items_checklist ON checklist_items(checklist_id)`);

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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_checklist_runs_checklist ON checklist_runs(checklist_id)`);

  console.log('[ChecklistDB] Tables initialized');
}

export async function createChecklist(checklist: Omit<ComplianceChecklist, 'id' | 'created_at' | 'updated_at'>): Promise<ComplianceChecklist> {
  const result = await pool.query(
    `INSERT INTO compliance_checklists (name, description, standard, version, category, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [checklist.name, checklist.description || null, checklist.standard, checklist.version || '1.0',
     checklist.category || null, checklist.is_active !== false, checklist.created_by || 'system']
  );
  return result.rows[0];
}

export async function addChecklistItems(checklistId: number, items: Omit<ChecklistItem, 'id' | 'checklist_id' | 'created_at'>[]): Promise<ChecklistItem[]> {
  const results: ChecklistItem[] = [];
  for (const item of items) {
    const result = await pool.query(
      `INSERT INTO checklist_items (checklist_id, item_number, clause_reference, question, expected_result, check_type, module_to_query, query_config, weight, is_critical)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [checklistId, item.item_number, item.clause_reference || null, item.question,
       item.expected_result || null, item.check_type || 'manual', item.module_to_query || null,
       item.query_config ? JSON.stringify(item.query_config) : '{}', item.weight || 1.0, item.is_critical || false]
    );
    results.push(result.rows[0]);
  }
  return results;
}

export async function getChecklists(filters?: { standard?: string; is_active?: boolean }): Promise<ComplianceChecklist[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters?.standard) { conditions.push(`standard = $${idx++}`); params.push(filters.standard); }
  if (filters?.is_active !== undefined) { conditions.push(`is_active = $${idx++}`); params.push(filters.is_active); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(`SELECT * FROM compliance_checklists ${where} ORDER BY standard, name`, params);
  return result.rows;
}

export async function getChecklistById(id: number): Promise<{ checklist: ComplianceChecklist; items: ChecklistItem[] } | null> {
  const checklistResult = await pool.query(`SELECT * FROM compliance_checklists WHERE id = $1`, [id]);
  if (checklistResult.rows.length === 0) return null;

  const itemsResult = await pool.query(`SELECT * FROM checklist_items WHERE checklist_id = $1 ORDER BY item_number`, [id]);
  return { checklist: checklistResult.rows[0], items: itemsResult.rows };
}

export async function deleteChecklist(id: number): Promise<boolean> {
  const result = await pool.query(`DELETE FROM compliance_checklists WHERE id = $1 RETURNING id`, [id]);
  return result.rows.length > 0;
}

export async function saveChecklistRun(run: Omit<ChecklistRun, 'id' | 'created_at'>): Promise<ChecklistRun> {
  const result = await pool.query(
    `INSERT INTO checklist_runs (checklist_id, overall_score, total_items, passed_items, failed_items, na_items, item_results, run_by, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [run.checklist_id, run.overall_score, run.total_items, run.passed_items, run.failed_items,
     run.na_items, JSON.stringify(run.item_results), run.run_by || 'ai_consultant', run.notes || null]
  );
  return result.rows[0];
}

export async function getChecklistRuns(checklistId: number, limit: number = 10): Promise<ChecklistRun[]> {
  const result = await pool.query(
    `SELECT * FROM checklist_runs WHERE checklist_id = $1 ORDER BY run_date DESC LIMIT $2`,
    [checklistId, limit]
  );
  return result.rows;
}

export async function executeChecklistItem(item: ChecklistItem): Promise<{ status: 'pass' | 'fail' | 'na' | 'error'; actual_value: any; details: string }> {
  try {
    if (item.check_type === 'manual') {
      return { status: 'na', actual_value: null, details: 'Manual verification required' };
    }

    const config = item.query_config || {};
    const module = item.module_to_query;

    if (!module) {
      return { status: 'na', actual_value: null, details: 'No module configured for automated check' };
    }

    const tableMap: Record<string, string> = {
      nonconformances: 'nonconformance_records',
      capas: 'capa_records',
      risks: 'enterprise_risks',
      policies: 'policies',
      compliance: 'obligations',
      kpis: 'kpi_definitions',
      training: 'training_assignments',
      pdpl: 'pdpl_data_inventory',
      vendors: 'vendors',
      audits: 'quality_audit_results',
      event_logs: 'event_logs',
    };

    const table = tableMap[module];
    if (!table) {
      return { status: 'na', actual_value: null, details: `Unknown module: ${module}` };
    }

    if (item.check_type === 'count_check') {
      const condition = config.condition || '';
      const query = condition
        ? `SELECT COUNT(*)::int as count FROM ${table} WHERE ${condition}`
        : `SELECT COUNT(*)::int as count FROM ${table}`;
      const result = await pool.query(query);
      const count = result.rows[0]?.count || 0;
      const threshold = config.min_count ?? 0;
      const maxAllowed = config.max_count;

      if (maxAllowed !== undefined) {
        const passed = count <= maxAllowed;
        return { status: passed ? 'pass' : 'fail', actual_value: count, details: `Found ${count} records (max allowed: ${maxAllowed})` };
      }
      const passed = count >= threshold;
      return { status: passed ? 'pass' : 'fail', actual_value: count, details: `Found ${count} records (minimum required: ${threshold})` };
    }

    if (item.check_type === 'existence_check') {
      const condition = config.condition || '1=1';
      const result = await pool.query(`SELECT EXISTS(SELECT 1 FROM ${table} WHERE ${condition}) as exists_flag`);
      const exists = result.rows[0]?.exists_flag || false;
      const shouldExist = config.should_exist !== false;
      const passed = exists === shouldExist;
      return { status: passed ? 'pass' : 'fail', actual_value: exists, details: exists ? 'Records found' : 'No records found' };
    }

    if (item.check_type === 'threshold_check') {
      const column = config.column || 'id';
      const condition = config.condition || '';
      const query = condition
        ? `SELECT AVG(${column})::numeric as avg_val FROM ${table} WHERE ${condition}`
        : `SELECT AVG(${column})::numeric as avg_val FROM ${table}`;
      const result = await pool.query(query);
      const avgVal = parseFloat(result.rows[0]?.avg_val) || 0;
      const minThreshold = config.min_threshold ?? 0;
      const passed = avgVal >= minThreshold;
      return { status: passed ? 'pass' : 'fail', actual_value: avgVal, details: `Average: ${avgVal.toFixed(2)} (threshold: ${minThreshold})` };
    }

    if (item.check_type === 'data_query') {
      const query = config.sql;
      if (!query) return { status: 'na', actual_value: null, details: 'No SQL query configured' };
      const result = await pool.query(query);
      const value = result.rows[0];
      const evalFn = config.eval;
      if (evalFn === 'zero_is_pass') {
        const count = parseInt(value?.count) || 0;
        return { status: count === 0 ? 'pass' : 'fail', actual_value: count, details: `Found ${count} (expected 0)` };
      }
      if (evalFn === 'nonzero_is_pass') {
        const count = parseInt(value?.count) || 0;
        return { status: count > 0 ? 'pass' : 'fail', actual_value: count, details: `Found ${count} (expected > 0)` };
      }
      return { status: 'pass', actual_value: value, details: 'Query executed successfully' };
    }

    return { status: 'na', actual_value: null, details: `Unsupported check type: ${item.check_type}` };
  } catch (err) {
    return { status: 'error', actual_value: null, details: `Check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function runChecklist(checklistId: number, runBy?: string): Promise<ChecklistRun> {
  const data = await getChecklistById(checklistId);
  if (!data) throw new Error(`Checklist ${checklistId} not found`);

  const { checklist, items } = data;
  const itemResults: any[] = [];
  let passed = 0, failed = 0, na = 0;

  for (const item of items) {
    const result = await executeChecklistItem(item);
    itemResults.push({
      item_number: item.item_number,
      clause_reference: item.clause_reference,
      question: item.question,
      expected_result: item.expected_result,
      check_type: item.check_type,
      is_critical: item.is_critical,
      ...result,
    });
    if (result.status === 'pass') passed++;
    else if (result.status === 'fail') failed++;
    else na++;
  }

  const scorable = passed + failed;
  const score = scorable > 0 ? Math.round((passed / scorable) * 10000) / 100 : 0;

  const run = await saveChecklistRun({
    checklist_id: checklistId,
    overall_score: score,
    total_items: items.length,
    passed_items: passed,
    failed_items: failed,
    na_items: na,
    item_results: itemResults,
    run_by: runBy || 'ai_consultant',
  });

  return run;
}
