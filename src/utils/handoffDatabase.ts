import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

export interface HandoffRule {
  id?: number;
  rule_code: string;
  name: string;
  description?: string;
  source_module: "qms" | "calls" | "team" | "sandbox";
  target_module: "risks" | "compliance" | "audits" | "vendors";
  trigger_type: "threshold" | "pattern" | "manual" | "scheduled";
  trigger_condition: string;
  action_type:
    | "create_risk"
    | "create_finding"
    | "create_obligation"
    | "notify"
    | "escalate";
  action_config?: string;
  priority: "critical" | "high" | "medium" | "low";
  is_active: boolean;
  last_triggered?: Date;
  trigger_count?: number;
  created_by?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface HandoffEvent {
  id?: number;
  rule_id: number;
  source_record_id: string;
  source_module: string;
  target_module: string;
  action_type: string;
  target_record_id?: string;
  status: "pending" | "processing" | "completed" | "failed";
  details?: string;
  error_message?: string;
  processed_by?: string;
  created_at?: Date;
  processed_at?: Date;
}

export interface ControlMapping {
  id?: number;
  control_id: string;
  control_name: string;
  control_type: "preventive" | "detective" | "corrective";
  source_domain: string;
  linked_risks?: number[];
  linked_policies?: number[];
  linked_compliance?: number[];
  linked_audits?: number[];
  effectiveness_score?: number;
  last_tested?: Date;
  test_frequency: string;
  owner_name?: string;
  is_active: boolean;
  created_at?: Date;
  updated_at?: Date;
}

export async function initHandoffTables(): Promise<void> {
  logger.info("📋 [HandoffDB] Initializing handoff tables...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS handoff_rules (
      id SERIAL PRIMARY KEY,
      rule_code VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(500) NOT NULL,
      description TEXT,
      source_module VARCHAR(50) NOT NULL,
      target_module VARCHAR(50) NOT NULL,
      trigger_type VARCHAR(30) NOT NULL,
      trigger_condition JSONB NOT NULL,
      action_type VARCHAR(50) NOT NULL,
      action_config JSONB,
      priority VARCHAR(20) DEFAULT 'medium',
      is_active BOOLEAN DEFAULT true,
      last_triggered TIMESTAMP,
      trigger_count INTEGER DEFAULT 0,
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS handoff_events (
      id SERIAL PRIMARY KEY,
      rule_id INTEGER REFERENCES handoff_rules(id) ON DELETE SET NULL,
      source_record_id VARCHAR(100) NOT NULL,
      source_module VARCHAR(50) NOT NULL,
      target_module VARCHAR(50) NOT NULL,
      action_type VARCHAR(50) NOT NULL,
      target_record_id VARCHAR(100),
      status VARCHAR(20) DEFAULT 'pending',
      details JSONB,
      error_message TEXT,
      processed_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      processed_at TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS control_mappings (
      id SERIAL PRIMARY KEY,
      control_id VARCHAR(50) UNIQUE NOT NULL,
      control_name VARCHAR(500) NOT NULL,
      control_type VARCHAR(30) NOT NULL,
      source_domain VARCHAR(100),
      linked_risks INTEGER[],
      linked_policies INTEGER[],
      linked_compliance INTEGER[],
      linked_audits INTEGER[],
      effectiveness_score INTEGER,
      last_tested TIMESTAMP,
      test_frequency VARCHAR(50),
      owner_name VARCHAR(255),
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await seedHandoffRules();
  await seedControlMappings();
  logger.info("✅ [HandoffDB] Handoff tables initialized");
}

async function seedHandoffRules(): Promise<void> {
  const existing = await pool.query("SELECT COUNT(*) FROM handoff_rules");
  if (parseInt(existing.rows[0].count) > 0) return;

  logger.info("📝 [HandoffDB] Seeding handoff rules...");

  const rules = [
    {
      rule_code: "QMS-RISK-001",
      name: "Critical CAPA to Risk Register",
      description: "Automatically create risk when CAPA is marked as critical",
      source_module: "qms",
      target_module: "risks",
      trigger_type: "threshold",
      trigger_condition: JSON.stringify({
        field: "priority",
        operator: "equals",
        value: "critical",
      }),
      action_type: "create_risk",
      action_config: JSON.stringify({
        category: "operational",
        likelihood: 4,
        impact: 4,
      }),
      priority: "critical",
    },
    {
      rule_code: "CALL-COMP-001",
      name: "Low Sentiment Score Alert",
      description:
        "Flag compliance review when call sentiment is below threshold",
      source_module: "calls",
      target_module: "compliance",
      trigger_type: "threshold",
      trigger_condition: JSON.stringify({
        field: "sentiment_score",
        operator: "less_than",
        value: 0.3,
      }),
      action_type: "notify",
      priority: "high",
    },
    {
      rule_code: "QMS-AUD-001",
      name: "Nonconformance to Audit Finding",
      description: "Create audit finding from recurring nonconformances",
      source_module: "qms",
      target_module: "audits",
      trigger_type: "pattern",
      trigger_condition: JSON.stringify({
        pattern: "recurring",
        min_occurrences: 3,
        timeframe_days: 90,
      }),
      action_type: "create_finding",
      priority: "medium",
    },
    {
      rule_code: "TEAM-COMP-001",
      name: "Training Expiry Compliance",
      description: "Create compliance obligation when certifications expire",
      source_module: "team",
      target_module: "compliance",
      trigger_type: "scheduled",
      trigger_condition: JSON.stringify({
        check: "certification_expiry",
        days_before: 30,
      }),
      action_type: "create_obligation",
      priority: "medium",
    },
  ];

  for (const rule of rules) {
    await pool.query(
      `INSERT INTO handoff_rules (rule_code, name, description, source_module, target_module, trigger_type, trigger_condition, action_type, action_config, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        rule.rule_code,
        rule.name,
        rule.description,
        rule.source_module,
        rule.target_module,
        rule.trigger_type,
        rule.trigger_condition,
        rule.action_type,
        rule.action_config || null,
        rule.priority,
      ],
    );
  }
}

async function seedControlMappings(): Promise<void> {
  // RETIRED - no longer seeds anything.
  //
  // control_mappings was a five-row demo seed (CTRL-001 "Access Control Policy"
  // through CTRL-005) with no relationship to any framework clause, so it could
  // not answer the only question a control register exists to answer: which
  // obligations does this control satisfy. It rendered on the Control Tower as
  // five permanently "Not tested" rows and produced no compliance signal
  // anywhere on the page.
  //
  // `controls` + `control_clause_mappings` (controlsCrosswalk.ts) is now the
  // single control register. It maps a control to clauses across frameworks,
  // which is what lets one control be evidenced once and inherited by ISO
  // 27001, NCA ECC and SOC 2 together.
  //
  // Deliberately a no-op rather than a DELETE: rows already in a deployed
  // database are left untouched. Nothing reads them now that the panel reads
  // the crosswalk, so they are inert - and dropping real rows from a production
  // table is not something a function called "seed" should do. The previous
  // body is in git history if the data is ever wanted.
}

export async function createHandoffRule(
  rule: HandoffRule,
): Promise<HandoffRule> {
  logger.info("📝 [HandoffDB] Creating handoff rule:", rule.name);

  const result = await pool.query(
    `
    INSERT INTO handoff_rules (
      rule_code, name, description, source_module, target_module,
      trigger_type, trigger_condition, action_type, action_config,
      priority, is_active, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING *
  `,
    [
      rule.rule_code,
      rule.name,
      rule.description,
      rule.source_module,
      rule.target_module,
      rule.trigger_type,
      rule.trigger_condition,
      rule.action_type,
      rule.action_config,
      rule.priority || "medium",
      rule.is_active !== false,
      rule.created_by,
    ],
  );

  return result.rows[0];
}

export async function updateHandoffRule(
  id: number,
  updates: Partial<HandoffRule>,
): Promise<HandoffRule> {
  const setClause: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  const allowedFields = [
    "name",
    "description",
    "trigger_condition",
    "action_config",
    "priority",
    "is_active",
  ];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      setClause.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
  }

  setClause.push("updated_at = NOW()");
  values.push(id);

  const result = await pool.query(
    `UPDATE handoff_rules SET ${setClause.join(", ")} WHERE id = $${paramCount} RETURNING *`,
    values,
  );
  return result.rows[0];
}

export async function getAllHandoffRules(filters?: {
  source_module?: string;
  is_active?: boolean;
}): Promise<{ rules: HandoffRule[]; total: number }> {
  let query = "SELECT * FROM handoff_rules WHERE 1=1";
  const values: any[] = [];
  let paramCount = 1;

  if (filters?.source_module) {
    query += ` AND source_module = $${paramCount}`;
    values.push(filters.source_module);
    paramCount++;
  }
  if (filters?.is_active !== undefined) {
    query += ` AND is_active = $${paramCount}`;
    values.push(filters.is_active);
    paramCount++;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM handoff_rules WHERE 1=1` +
      query.replace("SELECT * FROM handoff_rules WHERE 1=1", ""),
    values,
  );

  query += " ORDER BY priority DESC, created_at DESC";
  const result = await pool.query(query, values);

  return { rules: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function createHandoffEvent(
  event: HandoffEvent,
): Promise<HandoffEvent> {
  logger.info("📝 [HandoffDB] Creating handoff event");

  const result = await pool.query(
    `
    INSERT INTO handoff_events (
      rule_id, source_record_id, source_module, target_module, action_type, status, details
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `,
    [
      event.rule_id,
      event.source_record_id,
      event.source_module,
      event.target_module,
      event.action_type,
      event.status || "pending",
      event.details ? JSON.stringify(event.details) : null,
    ],
  );

  await pool.query(
    "UPDATE handoff_rules SET last_triggered = NOW(), trigger_count = COALESCE(trigger_count, 0) + 1 WHERE id = $1",
    [event.rule_id],
  );

  return result.rows[0];
}

export async function getHandoffEvents(filters?: {
  status?: string;
  source_module?: string;
}): Promise<{ events: HandoffEvent[]; total: number }> {
  let query =
    "SELECT e.*, r.name as rule_name, r.rule_code FROM handoff_events e LEFT JOIN handoff_rules r ON e.rule_id = r.id WHERE 1=1";
  const values: any[] = [];
  let paramCount = 1;

  if (filters?.status) {
    query += ` AND e.status = $${paramCount}`;
    values.push(filters.status);
    paramCount++;
  }
  if (filters?.source_module) {
    query += ` AND e.source_module = $${paramCount}`;
    values.push(filters.source_module);
    paramCount++;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM handoff_events e WHERE 1=1` +
      query.replace(
        /SELECT e\.\*, r\.name as rule_name, r\.rule_code FROM handoff_events e LEFT JOIN handoff_rules r ON e\.rule_id = r\.id WHERE 1=1/,
        "",
      ),
    values,
  );

  query += " ORDER BY e.created_at DESC LIMIT 100";
  const result = await pool.query(query, values);

  return { events: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function getAllControlMappings(): Promise<ControlMapping[]> {
  const result = await pool.query(
    "SELECT * FROM control_mappings WHERE is_active = true ORDER BY control_id",
  );
  return result.rows;
}

export async function updateControlMapping(
  id: number,
  updates: Partial<ControlMapping>,
): Promise<ControlMapping> {
  const setClause: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  const allowedFields = [
    "control_name",
    "control_type",
    "source_domain",
    "linked_risks",
    "linked_policies",
    "linked_compliance",
    "linked_audits",
    "effectiveness_score",
    "last_tested",
    "test_frequency",
    "owner_name",
    "is_active",
  ];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      setClause.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
  }

  setClause.push("updated_at = NOW()");
  values.push(id);

  const result = await pool.query(
    `UPDATE control_mappings SET ${setClause.join(", ")} WHERE id = $${paramCount} RETURNING *`,
    values,
  );
  return result.rows[0];
}

export async function getHandoffSummary(): Promise<any> {
  logger.info("📊 [HandoffDB] Generating handoff summary...");

  const ruleStats = await pool.query(`
    SELECT 
      COUNT(*) as total_rules,
      COUNT(*) FILTER (WHERE is_active = true) as active_rules,
      SUM(trigger_count) as total_triggers
    FROM handoff_rules
  `);

  const eventStats = await pool.query(`
    SELECT 
      COUNT(*) as total_events,
      COUNT(*) FILTER (WHERE status = 'pending') as pending,
      COUNT(*) FILTER (WHERE status = 'processing') as processing,
      COUNT(*) FILTER (WHERE status = 'completed') as completed,
      COUNT(*) FILTER (WHERE status = 'failed') as failed
    FROM handoff_events
  `);

  const bySourceModule = await pool.query(`
    SELECT source_module, COUNT(*) as count
    FROM handoff_events
    GROUP BY source_module
    ORDER BY count DESC
  `);

  const byTargetModule = await pool.query(`
    SELECT target_module, COUNT(*) as count
    FROM handoff_events
    GROUP BY target_module
    ORDER BY count DESC
  `);

  const recentEvents = await pool.query(`
    SELECT e.*, r.name as rule_name, r.rule_code
    FROM handoff_events e
    LEFT JOIN handoff_rules r ON e.rule_id = r.id
    ORDER BY e.created_at DESC
    LIMIT 5
  `);

  const controlStats = await pool.query(`
    SELECT 
      COUNT(*) as total_controls,
      COUNT(*) FILTER (WHERE effectiveness_score >= 80) as effective,
      COUNT(*) FILTER (WHERE effectiveness_score BETWEEN 60 AND 79) as moderate,
      COUNT(*) FILTER (WHERE effectiveness_score < 60 OR effectiveness_score IS NULL) as needs_improvement
    FROM control_mappings
    WHERE is_active = true
  `);

  return {
    rule_stats: ruleStats.rows[0],
    events: eventStats.rows[0],
    by_source_module: bySourceModule.rows,
    by_target_module: byTargetModule.rows,
    recent_events: recentEvents.rows,
    controls: controlStats.rows[0],
  };
}
