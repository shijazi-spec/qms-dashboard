/**
 * Fraud Management Module — Database layer
 *
 * Implements PRD-FRD-001 (Fraud Management Module) section 5.
 *
 * Tables created idempotently by initFraudTables():
 *   1. fraud_rules                   (Feature 1 — wired in this commit)
 *   2. fraud_incidents               (Feature 2)
 *   3. fraud_country_risk            (Feature 3)
 *   4. fraud_escalation_matrix       (Feature 4)
 *   5. fraud_kpis + fraud_kpi_thresholds (Feature 5)
 *
 * All five tables are CREATEd up front so that downstream Features
 * (incidents → escalation matrix, incidents → KPIs) can be built without
 * having to revisit / sequence migrations. Only the Feature-1 helpers
 * (fraud_rules) are exported; subsequent feature commits will extend this
 * file with the corresponding types and CRUD functions.
 *
 * Conventions follow [src/utils/complianceDatabase.ts] and
 * [src/utils/riskDatabase.ts]:
 *   - createRedactedPool from ./redactedPool (param-redaction wrapper)
 *   - public_id UUID for ID obfuscation in API responses
 *   - ON CONFLICT DO NOTHING for idempotent seed
 *   - Definition arrays exported (e.g. FRAUD_RULE_DEFINITIONS) so that
 *     structural tests can validate them without a live database.
 */

import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

// ─────────────────────────────────────────────────────────────────────────────
// Types — shared enums first, then per-table interfaces
// ─────────────────────────────────────────────────────────────────────────────

export type FraudRuleTestStatus =
  | "passed"
  | "pending_testing"
  | "not_tested"
  | "not_defined"
  | "active_being_modified"
  | "misconfiguration";

export interface FraudRule {
  id?: number;
  public_id?: string;
  rule_id: string;
  rule_name: string;
  transaction_type: string;
  alert_threshold?: string;
  block_threshold?: string;
  owner: string;
  test_status: FraudRuleTestStatus;
  last_tested?: Date | string | null;
  next_review: Date | string;
  current_setting?: string;
  target_setting?: string;
  notes?: string;
  is_deleted?: boolean;
  created_by?: string;
  updated_by?: string;
  created_at?: Date;
  updated_at?: Date;
}

let initialized = false;

// ─────────────────────────────────────────────────────────────────────────────
// initFraudTables — creates all 5 tables idempotently and seeds Feature 1
// ─────────────────────────────────────────────────────────────────────────────

export async function initFraudTables(): Promise<void> {
  if (initialized) return;
  logger.info("🛡️  [FraudDB] Initializing fraud management tables...");

  // 1. fraud_rules ────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fraud_rules (
      id SERIAL PRIMARY KEY,
      public_id UUID DEFAULT gen_random_uuid(),
      rule_id VARCHAR(20) NOT NULL UNIQUE,
      rule_name VARCHAR(500) NOT NULL,
      transaction_type VARCHAR(100) NOT NULL,
      alert_threshold TEXT,
      block_threshold TEXT,
      owner VARCHAR(255) NOT NULL,
      test_status VARCHAR(30) NOT NULL DEFAULT 'not_tested',
      last_tested DATE,
      next_review DATE NOT NULL,
      current_setting TEXT,
      target_setting TEXT,
      notes TEXT,
      is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
      created_by VARCHAR(255),
      updated_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_fraud_rules_public_id ON fraud_rules(public_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_fraud_rules_test_status ON fraud_rules(test_status)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_fraud_rules_next_review ON fraud_rules(next_review)`,
  );

  // 2. fraud_incidents ────────────────────────────────────────────────────────
  // Created up-front so Feature 2 (Incidents) can be wired without migration.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fraud_incidents (
      id SERIAL PRIMARY KEY,
      public_id UUID DEFAULT gen_random_uuid(),
      incident_code VARCHAR(20) NOT NULL UNIQUE,
      date_detected DATE NOT NULL,
      severity VARCHAR(5) NOT NULL,
      incident_type VARCHAR(50) NOT NULL,
      detection_source VARCHAR(50) NOT NULL,
      affected_customers INTEGER DEFAULT 0,
      amount_sar DECIMAL(12,2) DEFAULT 0,
      actions_taken TEXT,
      account_frozen BOOLEAN NOT NULL DEFAULT FALSE,
      resolution_date DATE,
      root_cause TEXT,
      sama_reported BOOLEAN,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      contained_at TIMESTAMP,
      notes TEXT,
      linked_rule_id VARCHAR(20),
      linked_enterprise_risk_id INTEGER,
      created_by VARCHAR(255) NOT NULL,
      updated_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_fraud_incidents_public_id ON fraud_incidents(public_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_fraud_incidents_status ON fraud_incidents(status)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_fraud_incidents_severity ON fraud_incidents(severity)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_fraud_incidents_date_detected ON fraud_incidents(date_detected DESC)`,
  );

  // 3. fraud_country_risk ─────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fraud_country_risk (
      id SERIAL PRIMARY KEY,
      public_id UUID DEFAULT gen_random_uuid(),
      iso_code CHAR(2) NOT NULL UNIQUE,
      country_name VARCHAR(100) NOT NULL,
      fatf_status VARCHAR(30) NOT NULL DEFAULT 'no_action',
      risk_rating VARCHAR(10) NOT NULL,
      expat_population VARCHAR(100),
      bin_status VARCHAR(50) NOT NULL DEFAULT 'not_approved',
      edd_required BOOLEAN NOT NULL DEFAULT FALSE,
      special_conditions TEXT,
      approved_by VARCHAR(255),
      date_assessed DATE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_fraud_country_risk_public_id ON fraud_country_risk(public_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_fraud_country_risk_rating ON fraud_country_risk(risk_rating)`,
  );

  // 4. fraud_escalation_matrix ────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fraud_escalation_matrix (
      id SERIAL PRIMARY KEY,
      public_id UUID DEFAULT gen_random_uuid(),
      trigger_id VARCHAR(20) NOT NULL UNIQUE,
      trigger_definition TEXT NOT NULL,
      severity VARCHAR(5),
      notify_immediately TEXT[] NOT NULL,
      notify_within_4h TEXT[],
      external_party VARCHAR(255),
      external_contact TEXT,
      response_sla VARCHAR(50) NOT NULL,
      response_sla_hours INTEGER NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      updated_by VARCHAR(255),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_fraud_escalation_public_id ON fraud_escalation_matrix(public_id)`,
  );

  // 5. fraud_kpis + fraud_kpi_thresholds ─────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fraud_kpis (
      id SERIAL PRIMARY KEY,
      month DATE NOT NULL UNIQUE,
      total_transactions INTEGER,
      total_rejections INTEGER,
      fraud_rate_pct DECIMAL(7,4),
      false_positive_rate_pct DECIMAL(7,4),
      confirmed_incidents INTEGER,
      fraud_loss_sar DECIMAL(12,2),
      chargeback_count INTEGER,
      chargeback_amount_sar DECIMAL(12,2),
      chargeback_ratio_pct DECIMAL(7,4),
      avg_detection_to_contain_hrs DECIMAL(10,2),
      customer_complaints INTEGER,
      resolved_within_30d_pct DECIMAL(5,2),
      sama_reports_filed INTEGER,
      notes TEXT,
      updated_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fraud_kpi_thresholds (
      id SERIAL PRIMARY KEY,
      metric_name VARCHAR(100) NOT NULL UNIQUE,
      target_value DECIMAL(10,3) NOT NULL,
      alert_value DECIMAL(10,3) NOT NULL,
      direction VARCHAR(20) NOT NULL,
      updated_by VARCHAR(255),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await seedFraudRules();
  await seedEscalationMatrix();
  await seedCountryRisk();

  initialized = true;
  logger.info("✅ [FraudDB] Fraud management tables initialized");
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed data — 17 rules from
// WalaPlus-Fraud-Management-Operational-Registers.xlsx (Tab 1)
// ─────────────────────────────────────────────────────────────────────────────

export interface FraudRuleDef {
  rule_id: string;
  rule_name: string;
  transaction_type: string;
  alert_threshold?: string;
  block_threshold?: string;
  owner: string;
  test_status: FraudRuleTestStatus;
  last_tested?: string;
  next_review: string;
  current_setting?: string;
  target_setting?: string;
  notes?: string;
}

/**
 * 17 fraud rules from the operational Excel workbook (Tab 1).
 *
 * Notes on enum mapping (kept here so the Excel→DB transformation is auditable):
 *   - FR-016 in Excel says "Active – Expansion Requested" which is not in
 *     the PRD enum. We map it to "active_being_modified" (the closest match)
 *     and preserve the original phrasing in `notes`. If the GRQ team wants
 *     a dedicated enum value later, both this file and the PRD §5.1 enum
 *     must be updated together.
 *   - "Q2 2026" / "Q3 2026" review dates are converted to the first day of
 *     the quarter (2026-04-01 / 2026-07-01) so they sort and compare as
 *     real DATE values.
 */
export const FRAUD_RULE_DEFINITIONS: FraudRuleDef[] = [
  {
    rule_id: "FR-001",
    rule_name: "High Amount Payment Alert",
    transaction_type: "Wallet Top-Up",
    alert_threshold: "≥ 10,000 SAR / single txn",
    block_threshold: "≥ 10,001 SAR / single txn",
    owner: "IT + GRQ",
    test_status: "passed",
    last_tested: "2026-04-28",
    next_review: "2026-07-01",
    current_setting: "Active",
    target_setting: "Active",
  },
  {
    rule_id: "FR-002",
    rule_name: "High Number of Transactions Alert",
    transaction_type: "Wallet Top-Up",
    alert_threshold: "≥ 10 txns / 1 hour",
    block_threshold: "≥ 10 txns / 30 mins",
    owner: "IT + GRQ",
    test_status: "passed",
    last_tested: "2026-04-28",
    next_review: "2026-07-01",
    current_setting: "3/day (HyperPay)",
    target_setting: "10/day (requested)",
    notes: "Modification submitted April 2026",
  },
  {
    rule_id: "FR-003",
    rule_name: "Insufficient Credit Card Data",
    transaction_type: "Wallet Top-Up",
    alert_threshold: "≥ 3 failed txns / 1 hour",
    block_threshold: "—",
    owner: "IT",
    test_status: "not_tested",
    next_review: "2026-04-01",
    current_setting: "Active",
    target_setting: "Active",
    notes: "No block condition defined — complete testing",
  },
  {
    rule_id: "FR-004",
    rule_name: "High Number of Voucher Transactions",
    transaction_type: "Voucher Purchase",
    alert_threshold: "≥ 3 vouchers / 1 hour",
    block_threshold: "≥ 5 vouchers / 30 mins",
    owner: "IT + Business",
    test_status: "pending_testing",
    next_review: "2026-04-01",
    current_setting: "Active",
    target_setting: "Active",
  },
  {
    rule_id: "FR-005",
    rule_name: "Multiple Credit Cards on Same Account",
    transaction_type: "Wallet Top-Up",
    alert_threshold: "≥ 3 different cards / 1 hour",
    block_threshold: "≥ 3 different cards / 30 mins",
    owner: "IT",
    test_status: "pending_testing",
    next_review: "2026-04-01",
    current_setting: "Active",
    target_setting: "Active",
  },
  {
    rule_id: "FR-006",
    rule_name: "Negative Balance Alert",
    transaction_type: "Wallet",
    alert_threshold: "Balance < 0",
    block_threshold: "Balance < 0",
    owner: "IT",
    test_status: "not_tested",
    next_review: "2026-04-01",
    current_setting: "Active",
    target_setting: "Active",
  },
  {
    rule_id: "FR-007",
    rule_name: "High Amount Partner Transactions (By Amount)",
    transaction_type: "Partner Redemption",
    alert_threshold: "≥ 20,000 SAR / single txn",
    block_threshold: "—",
    owner: "IT + Business",
    test_status: "pending_testing",
    next_review: "2026-04-01",
    current_setting: "Active",
    target_setting: "Active",
    notes: "No block condition — complete testing",
  },
  {
    rule_id: "FR-008",
    rule_name: "High Frequency Partner Transactions",
    transaction_type: "Partner Redemption",
    alert_threshold: "≥ 10 txns / 1 hour",
    block_threshold: "≥ 20 txns / 30 mins",
    owner: "IT + Business",
    test_status: "not_tested",
    next_review: "2026-04-01",
    current_setting: "Active",
    target_setting: "Active",
  },
  {
    rule_id: "FR-009",
    rule_name: "High Amount of Gifts Sent",
    transaction_type: "Gift Sending",
    alert_threshold: "≥ 5 gifts / day",
    block_threshold: "N/A",
    owner: "IT + Business",
    test_status: "not_tested",
    next_review: "2026-04-01",
    current_setting: "Active",
    target_setting: "Active",
  },
  {
    rule_id: "FR-010",
    rule_name: "Valid / Unique IP Address",
    transaction_type: "Registration",
    alert_threshold: "No alert",
    block_threshold: "No IP / invalid IP / >2 IPs → Block",
    owner: "IT",
    test_status: "not_tested",
    next_review: "2026-04-01",
    current_setting: "Active",
    target_setting: "Active",
    notes: "Customer rejection message to be defined",
  },
  {
    rule_id: "FR-011",
    rule_name: "Account Created from Same IP Address",
    transaction_type: "Registration",
    alert_threshold: "TBD",
    block_threshold: "TBD",
    owner: "IT",
    test_status: "not_defined",
    next_review: "2026-04-01",
    current_setting: "Not Configured",
    target_setting: "To Define",
  },
  {
    rule_id: "FR-012",
    rule_name: "Same Device ID / Different Email Accounts",
    transaction_type: "Registration / Login",
    alert_threshold: "TBD",
    block_threshold: "TBD",
    owner: "IT",
    test_status: "not_defined",
    next_review: "2026-04-01",
    current_setting: "Not Configured",
    target_setting: "To Define",
  },
  {
    rule_id: "FR-013",
    rule_name: "HyperPay – Account/Card Velocity",
    transaction_type: "All Top-Ups",
    alert_threshold: "—",
    block_threshold: "3 txns / day",
    owner: "HyperPay + IT",
    test_status: "active_being_modified",
    last_tested: "2026-04-28",
    next_review: "2026-07-01",
    current_setting: "3/day",
    target_setting: "10/day (requested)",
    notes: "Modification submitted April 2026",
  },
  {
    rule_id: "FR-014",
    rule_name: "HyperPay – IP Velocity",
    transaction_type: "All Transactions",
    alert_threshold: "—",
    block_threshold: "3 txns / day / IP",
    owner: "HyperPay + IT",
    test_status: "active_being_modified",
    last_tested: "2026-04-28",
    next_review: "2026-07-01",
    current_setting: "3/day",
    target_setting: "50/day (requested)",
    notes: "Modification submitted April 2026",
  },
  {
    rule_id: "FR-015",
    rule_name: "HyperPay – Email Velocity",
    transaction_type: "All Transactions",
    alert_threshold: "—",
    block_threshold: "3 txns / day / email",
    owner: "HyperPay + IT",
    test_status: "active_being_modified",
    last_tested: "2026-04-28",
    next_review: "2026-07-01",
    current_setting: "3/day",
    target_setting: "15/day (requested)",
    notes: "Modification submitted April 2026",
  },
  {
    rule_id: "FR-016",
    rule_name: "HyperPay – BIN Country Restriction",
    transaction_type: "All Transactions",
    alert_threshold: "—",
    block_threshold: "Non-GCC BIN → Block",
    owner: "HyperPay + GRQ",
    // Excel says "Active – Expansion Requested"; mapped to closest enum.
    test_status: "active_being_modified",
    last_tested: "2026-04-28",
    next_review: "2026-07-01",
    current_setting: "GCC only",
    target_setting: "GCC + IN, PK, ID, US (requested)",
    notes:
      "Excel original status: 'Active – Expansion Requested'. Bank approval required — submitted April 2026.",
  },
  {
    rule_id: "FR-017",
    rule_name: "HyperPay – Ticket Size Boundaries",
    transaction_type: "All Transactions",
    alert_threshold: "—",
    block_threshold: "Amount outside boundaries",
    owner: "HyperPay + GRQ",
    test_status: "misconfiguration",
    last_tested: "2026-04-29",
    next_review: "2026-04-01",
    current_setting: "10,000 SAR max",
    target_setting: "Clarification pending",
    notes:
      "URGENT — Min boundary unknown; 2,600–7,000 SAR txns being rejected incorrectly.",
  },
];

async function seedFraudRules(): Promise<void> {
  const existing = await pool.query(
    "SELECT COUNT(*)::int AS n FROM fraud_rules WHERE rule_id LIKE 'FR-%'",
  );
  if ((existing.rows[0]?.n ?? 0) > 0) {
    return;
  }

  logger.info(
    `🌱 [FraudDB] Seeding ${FRAUD_RULE_DEFINITIONS.length} fraud rules from Excel...`,
  );

  for (const r of FRAUD_RULE_DEFINITIONS) {
    await pool.query(
      `INSERT INTO fraud_rules (
        rule_id, rule_name, transaction_type, alert_threshold, block_threshold,
        owner, test_status, last_tested, next_review,
        current_setting, target_setting, notes, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'system:seed')
      ON CONFLICT (rule_id) DO NOTHING`,
      [
        r.rule_id,
        r.rule_name,
        r.transaction_type,
        r.alert_threshold ?? null,
        r.block_threshold ?? null,
        r.owner,
        r.test_status,
        r.last_tested ?? null,
        r.next_review,
        r.current_setting ?? null,
        r.target_setting ?? null,
        r.notes ?? null,
      ],
    );
  }

  logger.info(`✅ [FraudDB] Fraud rules seeded`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public CRUD — fraud_rules
// ─────────────────────────────────────────────────────────────────────────────

export async function getAllFraudRules(filters?: {
  owner?: string;
  test_status?: FraudRuleTestStatus;
  transaction_type?: string;
  include_deleted?: boolean;
}): Promise<FraudRule[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  let i = 1;

  if (!filters?.include_deleted) {
    conditions.push("is_deleted = FALSE");
  }
  if (filters?.owner) {
    conditions.push(`owner = $${i++}`);
    params.push(filters.owner);
  }
  if (filters?.test_status) {
    conditions.push(`test_status = $${i++}`);
    params.push(filters.test_status);
  }
  if (filters?.transaction_type) {
    conditions.push(`transaction_type = $${i++}`);
    params.push(filters.transaction_type);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pool.query(
    `SELECT * FROM fraud_rules ${where} ORDER BY rule_id ASC`,
    params,
  );
  return result.rows;
}

export async function getFraudRuleById(id: number): Promise<FraudRule | null> {
  const result = await pool.query(`SELECT * FROM fraud_rules WHERE id = $1`, [
    id,
  ]);
  return result.rows[0] ?? null;
}

export async function getFraudRuleByPublicId(
  publicId: string,
): Promise<FraudRule | null> {
  const result = await pool.query(
    `SELECT * FROM fraud_rules WHERE public_id = $1`,
    [publicId],
  );
  return result.rows[0] ?? null;
}

export async function createFraudRule(
  rule: FraudRule,
): Promise<FraudRule> {
  const result = await pool.query(
    `INSERT INTO fraud_rules (
      rule_id, rule_name, transaction_type, alert_threshold, block_threshold,
      owner, test_status, last_tested, next_review,
      current_setting, target_setting, notes, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING *`,
    [
      rule.rule_id,
      rule.rule_name,
      rule.transaction_type,
      rule.alert_threshold ?? null,
      rule.block_threshold ?? null,
      rule.owner,
      rule.test_status,
      rule.last_tested ?? null,
      rule.next_review,
      rule.current_setting ?? null,
      rule.target_setting ?? null,
      rule.notes ?? null,
      rule.created_by ?? "system",
    ],
  );
  return result.rows[0];
}

export async function updateFraudRule(
  id: number,
  updates: Partial<FraudRule>,
): Promise<FraudRule | null> {
  const allowed: (keyof FraudRule)[] = [
    "rule_name",
    "transaction_type",
    "alert_threshold",
    "block_threshold",
    "owner",
    "test_status",
    "last_tested",
    "next_review",
    "current_setting",
    "target_setting",
    "notes",
    "updated_by",
  ];
  const setClauses: string[] = [];
  const params: any[] = [];
  let i = 1;
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      setClauses.push(`${key} = $${i++}`);
      params.push((updates as any)[key]);
    }
  }
  if (setClauses.length === 0) {
    return getFraudRuleById(id);
  }
  setClauses.push(`updated_at = NOW()`);
  params.push(id);
  const result = await pool.query(
    `UPDATE fraud_rules SET ${setClauses.join(", ")} WHERE id = $${i} RETURNING *`,
    params,
  );
  return result.rows[0] ?? null;
}

export async function softDeleteFraudRule(
  id: number,
  by: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE fraud_rules SET is_deleted = TRUE, updated_by = $1, updated_at = NOW() WHERE id = $2`,
    [by, id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getOverdueFraudRules(): Promise<FraudRule[]> {
  const result = await pool.query(
    `SELECT * FROM fraud_rules
     WHERE is_deleted = FALSE
       AND next_review <= CURRENT_DATE
     ORDER BY next_review ASC`,
  );
  return result.rows;
}

/**
 * Rules whose `next_review` falls in the next N days. Used by the
 * fraud-rule-review-reminder cron to notify owners 14 days in advance.
 */
export async function getFraudRulesNeedingReviewSoon(
  days: number = 14,
): Promise<FraudRule[]> {
  const safeDays = Math.max(1, Math.min(90, Math.floor(Number(days) || 14)));
  const result = await pool.query(
    `SELECT * FROM fraud_rules
     WHERE is_deleted = FALSE
       AND next_review BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1::INT) * INTERVAL '1 day'
     ORDER BY next_review ASC`,
    [safeDays],
  );
  return result.rows;
}

/**
 * Rules currently in MISCONFIGURATION state. Used by misconfiguration-alert
 * dispatch and by the dashboard "Urgent Items" panel.
 */
export async function getMisconfiguredFraudRules(): Promise<FraudRule[]> {
  const result = await pool.query(
    `SELECT * FROM fraud_rules
     WHERE is_deleted = FALSE AND test_status = 'misconfiguration'
     ORDER BY rule_id ASC`,
  );
  return result.rows;
}

// ═════════════════════════════════════════════════════════════════════════════
// Feature 2 — Fraud Incidents (PRD-FRD-001 §5.2)
// ═════════════════════════════════════════════════════════════════════════════

export type FraudIncidentSeverity = "P1" | "P2" | "P3" | "P4";

export type FraudIncidentType =
  | "account_takeover"
  | "chargeback"
  | "card_testing"
  | "internal_fraud"
  | "aml_sar"
  | "other";

export type FraudIncidentDetectionSource =
  | "hyperpay_alert"
  | "customer_report"
  | "it_monitoring"
  | "bank_claim"
  | "internal_discovery"
  | "regulatory_inquiry";

export type FraudIncidentStatus =
  | "open"
  | "investigating"
  | "contained"
  | "resolved"
  | "closed";

export interface FraudIncident {
  id?: number;
  public_id?: string;
  incident_code?: string;
  date_detected: string | Date;
  severity: FraudIncidentSeverity;
  incident_type: FraudIncidentType;
  detection_source: FraudIncidentDetectionSource;
  affected_customers?: number;
  amount_sar?: number;
  actions_taken?: string;
  account_frozen?: boolean;
  resolution_date?: string | Date | null;
  root_cause?: string;
  sama_reported?: boolean | null;
  status?: FraudIncidentStatus;
  contained_at?: string | Date | null;
  notes?: string;
  linked_rule_id?: string | null;
  linked_enterprise_risk_id?: number | null;
  created_by: string;
  updated_by?: string;
  created_at?: Date;
  updated_at?: Date;
}

/**
 * Generates the next sequential incident code (INC-001, INC-002, …) using
 * a SELECT-MAX strategy against `incident_code`. Race-safe enough for the
 * expected fraud-incident volume; if simultaneous creates ever collide, the
 * UNIQUE constraint will reject the duplicate and the API layer can retry.
 */
async function generateNextIncidentCode(): Promise<string> {
  const result = await pool.query<{ max_n: number | null }>(
    `SELECT MAX(NULLIF(regexp_replace(incident_code, '[^0-9]', '', 'g'), '')::int) AS max_n FROM fraud_incidents`,
  );
  const next = (result.rows[0]?.max_n ?? 0) + 1;
  return `INC-${String(next).padStart(3, "0")}`;
}

/**
 * Creates a fraud incident and (for P1/P2) auto-creates a linked
 * enterprise_risks row so the cross-module Risk register reflects the
 * fraud event without manual data entry. Returns the created incident
 * with both `incident_code` and `linked_enterprise_risk_id` populated.
 *
 * Why P1/P2 only: per PRD §5.2 these are the severity bands that map to
 * material financial / reputational risk worth tracking in the enterprise
 * Risk register. P3/P4 stay in the Fraud module only to avoid noise.
 */
export async function createFraudIncident(
  input: FraudIncident,
): Promise<FraudIncident> {
  const code = input.incident_code || (await generateNextIncidentCode());

  // 1. Insert the fraud incident first so we have its id.
  const insertResult = await pool.query(
    `INSERT INTO fraud_incidents (
      incident_code, date_detected, severity, incident_type, detection_source,
      affected_customers, amount_sar, actions_taken, account_frozen,
      resolution_date, root_cause, sama_reported, status, contained_at,
      notes, linked_rule_id, created_by
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
    ) RETURNING *`,
    [
      code,
      input.date_detected,
      input.severity,
      input.incident_type,
      input.detection_source,
      input.affected_customers ?? 0,
      input.amount_sar ?? 0,
      input.actions_taken ?? null,
      input.account_frozen ?? false,
      input.resolution_date ?? null,
      input.root_cause ?? null,
      input.sama_reported ?? null,
      input.status ?? "open",
      input.contained_at ?? null,
      input.notes ?? null,
      input.linked_rule_id ?? null,
      input.created_by,
    ],
  );
  const incident = insertResult.rows[0] as FraudIncident;

  // 2. Dispatch escalation notifications per the matrix (Feature 4 hook).
  // Wrapped so a notification-layer failure does not roll back the
  // incident creation.
  try {
    await dispatchEscalationForIncident(incident);
  } catch (err) {
    logger.warn(
      `[FraudDB] Escalation dispatch failed for ${incident.incident_code} (continuing):`,
      err,
    );
  }

  // 3. For P1/P2, mirror into enterprise_risks via linked_incident_id.
  // We tolerate failures here so the fraud incident is still created even
  // if the enterprise_risks table isn't available; the link can be backfilled.
  if (incident.severity === "P1" || incident.severity === "P2") {
    try {
      const riskResult = await pool.query<{ id: number }>(
        `INSERT INTO enterprise_risks (
          risk_title, risk_description, risk_category, risk_source,
          identified_date, identified_by, owner_department,
          impact_score, likelihood_score, status, linked_incident_id
        ) VALUES ($1,$2,'fraud',$3, $4, $5, $6, $7, $8, 'open', $9)
        RETURNING id`,
        [
          `Fraud incident ${incident.incident_code} (${incident.severity})`,
          `Auto-created from fraud module. Type: ${incident.incident_type}, source: ${incident.detection_source}. ${incident.actions_taken ?? ""}`,
          `fraud_module:${incident.detection_source}`,
          incident.date_detected,
          incident.created_by,
          "GRQ",
          incident.severity === "P1" ? 5 : 4,
          incident.severity === "P1" ? 5 : 3,
          incident.id,
        ],
      );
      const linkedId = riskResult.rows[0]?.id;
      if (linkedId) {
        await pool.query(
          `UPDATE fraud_incidents SET linked_enterprise_risk_id = $1, updated_at = NOW() WHERE id = $2`,
          [linkedId, incident.id],
        );
        incident.linked_enterprise_risk_id = linkedId;
      }
    } catch (err) {
      logger.warn(
        `[FraudDB] Could not mirror incident ${incident.incident_code} to enterprise_risks (continuing):`,
        err,
      );
    }
  }

  return incident;
}

export async function getAllFraudIncidents(filters?: {
  status?: FraudIncidentStatus;
  severity?: FraudIncidentSeverity;
  incident_type?: FraudIncidentType;
  open_only?: boolean;
  limit?: number;
}): Promise<FraudIncident[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  let i = 1;
  if (filters?.status) {
    conditions.push(`status = $${i++}`);
    params.push(filters.status);
  }
  if (filters?.severity) {
    conditions.push(`severity = $${i++}`);
    params.push(filters.severity);
  }
  if (filters?.incident_type) {
    conditions.push(`incident_type = $${i++}`);
    params.push(filters.incident_type);
  }
  if (filters?.open_only) {
    conditions.push(`status NOT IN ('resolved','closed')`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.max(
    1,
    Math.min(1000, Math.floor(Number(filters?.limit) || 200)),
  );
  const result = await pool.query(
    `SELECT * FROM fraud_incidents ${where}
     ORDER BY date_detected DESC, id DESC
     LIMIT ${limit}`,
    params,
  );
  return result.rows;
}

export async function getFraudIncidentById(
  id: number,
): Promise<FraudIncident | null> {
  const result = await pool.query(
    `SELECT * FROM fraud_incidents WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function getFraudIncidentByPublicId(
  publicId: string,
): Promise<FraudIncident | null> {
  const result = await pool.query(
    `SELECT * FROM fraud_incidents WHERE public_id = $1`,
    [publicId],
  );
  return result.rows[0] ?? null;
}

export async function updateFraudIncident(
  id: number,
  updates: Partial<FraudIncident>,
): Promise<FraudIncident | null> {
  const allowed: (keyof FraudIncident)[] = [
    "date_detected",
    "severity",
    "incident_type",
    "detection_source",
    "affected_customers",
    "amount_sar",
    "actions_taken",
    "account_frozen",
    "resolution_date",
    "root_cause",
    "sama_reported",
    "status",
    "contained_at",
    "notes",
    "linked_rule_id",
    "updated_by",
  ];
  const setClauses: string[] = [];
  const params: any[] = [];
  let i = 1;
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      setClauses.push(`${key} = $${i++}`);
      params.push((updates as any)[key]);
    }
  }
  if (setClauses.length === 0) {
    return getFraudIncidentById(id);
  }
  // Auto-stamp contained_at when transitioning to "contained" status
  // unless caller explicitly supplied a value.
  if (
    updates.status === "contained" &&
    updates.contained_at === undefined
  ) {
    setClauses.push(`contained_at = COALESCE(contained_at, NOW())`);
  }
  setClauses.push(`updated_at = NOW()`);
  params.push(id);
  const result = await pool.query(
    `UPDATE fraud_incidents SET ${setClauses.join(", ")} WHERE id = $${i} RETURNING *`,
    params,
  );
  return result.rows[0] ?? null;
}

/**
 * Closes a fraud incident with the SAMA-reported gate enforced for P1/P2.
 * Returns { incident } on success, { error, code } on validation failure.
 *
 * Per PRD §5.2 + AC-5: a P1 or P2 incident cannot be closed unless the
 * `sama_reported` field has been explicitly set to true or false. This
 * keeps SAMA reporting evidence auditable: even a "no, not reportable"
 * decision must be recorded.
 */
export async function closeFraudIncident(
  id: number,
  closedBy: string,
  opts: {
    sama_reported?: boolean;
    resolution_date?: string;
    root_cause?: string;
  } = {},
): Promise<{ incident?: FraudIncident; error?: string; code?: number }> {
  const current = await getFraudIncidentById(id);
  if (!current) return { error: "Incident not found", code: 404 };

  const isCritical = current.severity === "P1" || current.severity === "P2";
  const samaValue =
    opts.sama_reported !== undefined ? opts.sama_reported : current.sama_reported;
  if (isCritical && (samaValue === null || samaValue === undefined)) {
    return {
      error:
        "Cannot close P1/P2 incident without sama_reported value (true or false). " +
        "PRD-FRD-001 §5.2 / AC-5.",
      code: 400,
    };
  }

  const result = await pool.query(
    `UPDATE fraud_incidents
       SET status = 'closed',
           sama_reported = $1,
           resolution_date = COALESCE($2, resolution_date, CURRENT_DATE),
           root_cause = COALESCE($3, root_cause),
           updated_by = $4,
           updated_at = NOW()
     WHERE id = $5
     RETURNING *`,
    [
      samaValue ?? null,
      opts.resolution_date ?? null,
      opts.root_cause ?? null,
      closedBy,
      id,
    ],
  );
  return { incident: result.rows[0] };
}

// ── Cron-helper queries (used by Inngest jobs in Feature 2 + Feature 4) ────

/**
 * Open or investigating incidents. Drives the dashboard "Open" tab and
 * the SLA-check cron's candidate set.
 */
export async function getOpenFraudIncidents(): Promise<FraudIncident[]> {
  const result = await pool.query(
    `SELECT * FROM fraud_incidents
     WHERE status NOT IN ('resolved','closed')
     ORDER BY date_detected DESC, id DESC`,
  );
  return result.rows;
}

/**
 * P1 incidents that are NOT yet sama_reported AND were detected more than
 * `hoursAhead` hours ago (i.e. the 72-hour SAMA reporting deadline is
 * within the next `72 - hoursAhead` hours).
 *
 * Default hoursAhead = 60: alert when 12h or less remain on the 72h clock.
 */
export async function getSamaDeadlineApproaching(
  hoursAhead: number = 60,
): Promise<FraudIncident[]> {
  const safe = Math.max(1, Math.min(72, Math.floor(Number(hoursAhead) || 60)));
  const result = await pool.query(
    `SELECT * FROM fraud_incidents
     WHERE severity = 'P1'
       AND status != 'closed'
       AND (sama_reported IS NULL OR sama_reported = FALSE)
       AND created_at <= NOW() - ($1::INT) * INTERVAL '1 hour'
     ORDER BY created_at ASC`,
    [safe],
  );
  return result.rows;
}

// ═════════════════════════════════════════════════════════════════════════════
// Feature 4 — Escalation Matrix (PRD-FRD-001 §5.4)
// ═════════════════════════════════════════════════════════════════════════════

export interface FraudEscalationRow {
  id?: number;
  public_id?: string;
  trigger_id: string;
  trigger_definition: string;
  severity?: string | null;
  notify_immediately: string[];
  notify_within_4h?: string[];
  external_party?: string | null;
  external_contact?: string | null;
  response_sla: string;
  response_sla_hours: number;
  is_active?: boolean;
  updated_by?: string;
  updated_at?: Date;
}

export interface EscalationDefinition {
  trigger_id: string;
  trigger_definition: string;
  severity: string | null;
  notify_immediately: string[];
  notify_within_4h: string[];
  external_party: string | null;
  external_contact: string | null;
  response_sla: string;
  response_sla_hours: number;
}

/**
 * 6-row escalation matrix from
 * WalaPlus-Fraud-Management-Operational-Registers.xlsx (Tab 4) +
 * PRD-FRD-001 §5.4. The seed is idempotent (UNIQUE on trigger_id).
 *
 * AML / SAR special handling (per PRD §5.4 + Saudi reg framework): the
 * customer must NOT be notified, ever — `notify_immediately` and
 * `notify_within_4h` must contain ZERO customer-facing roles. The
 * external party is SAFIU (Saudi Arabia Financial Intelligence Unit).
 * Enforcement is in `dispatchEscalationForIncident()` — see that
 * function for the no-tipping-off invariant.
 */
export const ESCALATION_MATRIX_DEFINITIONS: EscalationDefinition[] = [
  {
    trigger_id: "ESC-P1",
    trigger_definition:
      "P1 fraud incident (≥10 affected customers OR ≥50,000 SAR loss).",
    severity: "P1",
    notify_immediately: [
      "ceo@walaplus.com",
      "head.grq@walaplus.com",
      "head.it@walaplus.com",
    ],
    notify_within_4h: ["grc.team@walaplus.com", "compliance@walaplus.com"],
    external_party: "SAMA",
    external_contact: "Submit via SAMA RegPortal within 72 hours.",
    response_sla: "Containment within 4 hours",
    response_sla_hours: 4,
  },
  {
    trigger_id: "ESC-P2",
    trigger_definition:
      "P2 fraud incident (3-9 affected customers OR 10,000-50,000 SAR loss).",
    severity: "P2",
    notify_immediately: ["head.grq@walaplus.com", "head.it@walaplus.com"],
    notify_within_4h: ["grc.team@walaplus.com"],
    external_party: null,
    external_contact: null,
    response_sla: "Containment within 24 hours",
    response_sla_hours: 24,
  },
  {
    trigger_id: "ESC-P3",
    trigger_definition:
      "P3 fraud incident (1-2 affected customers, <10,000 SAR loss).",
    severity: "P3",
    notify_immediately: ["grc.team@walaplus.com"],
    notify_within_4h: [],
    external_party: null,
    external_contact: null,
    response_sla: "Containment within 72 hours",
    response_sla_hours: 72,
  },
  {
    trigger_id: "ESC-P4",
    trigger_definition:
      "P4 informational / suspicious-only event with no customer impact.",
    severity: "P4",
    notify_immediately: [],
    notify_within_4h: ["grc.team@walaplus.com"],
    external_party: null,
    external_contact: null,
    response_sla: "Log only; weekly review",
    response_sla_hours: 168,
  },
  {
    trigger_id: "ESC-CB",
    trigger_definition:
      "Chargeback dispute initiated by acquiring bank (any severity).",
    severity: null,
    notify_immediately: ["finance@walaplus.com", "head.grq@walaplus.com"],
    notify_within_4h: ["grc.team@walaplus.com"],
    external_party: "Acquiring bank",
    external_contact: "Reply via bank chargeback portal.",
    response_sla: "Bank response within 72 hours (3 calendar days)",
    response_sla_hours: 72,
  },
  {
    trigger_id: "ESC-AML",
    trigger_definition:
      "Suspicious activity (AML / SAR) — customer behavior indicating money laundering or terrorism financing.",
    severity: null,
    // AML/SAR has a hard "no tipping off" rule. notify_immediately and
    // notify_within_4h MUST NOT include customer or customer-facing roles.
    // dispatchEscalationForIncident() asserts this invariant.
    notify_immediately: ["head.grq@walaplus.com", "compliance@walaplus.com"],
    notify_within_4h: [],
    external_party: "SAFIU",
    external_contact:
      "File SAR via SAFIU goAML within statutory window. NEVER notify the customer (no tipping off).",
    response_sla: "SAR filed within 24 hours of detection",
    response_sla_hours: 24,
  },
];

export async function seedEscalationMatrix(): Promise<void> {
  const existing = await pool.query(
    "SELECT COUNT(*)::int AS n FROM fraud_escalation_matrix",
  );
  if ((existing.rows[0]?.n ?? 0) > 0) {
    return;
  }
  logger.info(
    `🌱 [FraudDB] Seeding ${ESCALATION_MATRIX_DEFINITIONS.length} escalation matrix rows...`,
  );
  for (const e of ESCALATION_MATRIX_DEFINITIONS) {
    await pool.query(
      `INSERT INTO fraud_escalation_matrix (
        trigger_id, trigger_definition, severity, notify_immediately,
        notify_within_4h, external_party, external_contact,
        response_sla, response_sla_hours, updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'system:seed')
      ON CONFLICT (trigger_id) DO NOTHING`,
      [
        e.trigger_id,
        e.trigger_definition,
        e.severity,
        e.notify_immediately,
        e.notify_within_4h,
        e.external_party,
        e.external_contact,
        e.response_sla,
        e.response_sla_hours,
      ],
    );
  }
  logger.info("✅ [FraudDB] Escalation matrix seeded");
}

export async function getEscalationMatrix(): Promise<FraudEscalationRow[]> {
  const result = await pool.query(
    `SELECT * FROM fraud_escalation_matrix WHERE is_active = TRUE ORDER BY trigger_id ASC`,
  );
  return result.rows;
}

export async function getEscalationByTriggerId(
  triggerId: string,
): Promise<FraudEscalationRow | null> {
  const result = await pool.query(
    `SELECT * FROM fraud_escalation_matrix WHERE trigger_id = $1`,
    [triggerId],
  );
  return result.rows[0] ?? null;
}

export async function updateEscalationRow(
  triggerId: string,
  updates: Partial<FraudEscalationRow>,
): Promise<FraudEscalationRow | null> {
  const allowed: (keyof FraudEscalationRow)[] = [
    "trigger_definition",
    "severity",
    "notify_immediately",
    "notify_within_4h",
    "external_party",
    "external_contact",
    "response_sla",
    "response_sla_hours",
    "is_active",
    "updated_by",
  ];
  const setClauses: string[] = [];
  const params: any[] = [];
  let i = 1;
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      setClauses.push(`${key} = $${i++}`);
      params.push((updates as any)[key]);
    }
  }
  if (setClauses.length === 0) {
    return getEscalationByTriggerId(triggerId);
  }
  setClauses.push(`updated_at = NOW()`);
  params.push(triggerId);
  const result = await pool.query(
    `UPDATE fraud_escalation_matrix SET ${setClauses.join(", ")} WHERE trigger_id = $${i} RETURNING *`,
    params,
  );
  return result.rows[0] ?? null;
}

/**
 * Resolve the escalation row that applies to a given incident. Selection
 * rule (PRD §5.4):
 *   - Chargeback type → ESC-CB
 *   - AML / SAR type  → ESC-AML
 *   - else → ESC-{severity} (e.g. ESC-P1)
 */
export function resolveEscalationTriggerForIncident(
  incident: Pick<FraudIncident, "incident_type" | "severity">,
): string {
  if (incident.incident_type === "chargeback") return "ESC-CB";
  if (incident.incident_type === "aml_sar") return "ESC-AML";
  return `ESC-${incident.severity}`;
}

/**
 * Dispatches notifications for a freshly-created incident based on the
 * escalation matrix. Returns the count of notifications enqueued.
 *
 * Hard constraints enforced here (NOT delegated to the data — the matrix
 * row could be edited via the admin UI; this is the runtime guard):
 *   - For ESC-AML, no notification recipient may be a customer or a
 *     customer-facing channel. PRD §5.4 + AML/SAR no-tipping-off rule.
 *
 * Failures of individual notifications are logged but do NOT throw, so
 * one bad recipient does not block the rest.
 */
export async function dispatchEscalationForIncident(
  incident: FraudIncident,
): Promise<{ enqueued: number; trigger_id: string; skipped: number }> {
  const triggerId = resolveEscalationTriggerForIncident(incident);
  const row = await getEscalationByTriggerId(triggerId);
  if (!row) {
    logger.warn(
      `[FraudDispatch] No escalation matrix row for trigger ${triggerId}; nothing dispatched`,
    );
    return { enqueued: 0, trigger_id: triggerId, skipped: 0 };
  }

  // Hard constraint: AML/SAR no tipping off.
  if (triggerId === "ESC-AML") {
    const allRecipients = [
      ...(row.notify_immediately || []),
      ...(row.notify_within_4h || []),
    ];
    const forbidden = allRecipients.filter(
      (r) =>
        /customer/i.test(r) ||
        /client/i.test(r) ||
        /^cust\./i.test(r) ||
        /@customers\./i.test(r),
    );
    if (forbidden.length > 0) {
      logger.error(
        `[FraudDispatch] BLOCKED — ESC-AML row contains forbidden recipients (no tipping off): ${forbidden.join(", ")}. Filing nothing.`,
      );
      return { enqueued: 0, trigger_id: triggerId, skipped: forbidden.length };
    }
  }

  const { createNotification } = await import("./notificationHub");

  let enqueued = 0;
  let skipped = 0;
  for (const recipient of row.notify_immediately || []) {
    try {
      await createNotification({
        title: `Fraud incident ${incident.incident_code} — immediate escalation (${triggerId})`,
        message: `${incident.severity ? `[${incident.severity}] ` : ""}${incident.incident_type} detected. SLA: ${row.response_sla}. ${row.external_party ? `External: ${row.external_party}.` : ""}`,
        module: "fraud",
        priority: incident.severity === "P1" ? "critical" : "high",
        channel: "in_app",
        recipient,
        related_entity_type: "fraud_incident",
        related_entity_id: String(incident.id),
        action_url: "/fraud-incidents",
      });
      enqueued++;
    } catch (err) {
      skipped++;
      logger.error(
        `[FraudDispatch] Notify-immediate failed for ${recipient} on ${incident.incident_code}:`,
        err,
      );
    }
  }
  for (const recipient of row.notify_within_4h || []) {
    try {
      // Within-4h notifications still go through the notification hub now.
      // A scheduled-delivery channel would be a future enhancement; the
      // priority differentiation already lets recipients filter.
      await createNotification({
        title: `Fraud incident ${incident.incident_code} — escalation (${triggerId})`,
        message: `${incident.severity ? `[${incident.severity}] ` : ""}${incident.incident_type} — review within 4 hours. SLA: ${row.response_sla}.`,
        module: "fraud",
        priority: "medium",
        channel: "in_app",
        recipient,
        related_entity_type: "fraud_incident",
        related_entity_id: String(incident.id),
        action_url: "/fraud-incidents",
      });
      enqueued++;
    } catch (err) {
      skipped++;
      logger.error(
        `[FraudDispatch] Notify-within-4h failed for ${recipient} on ${incident.incident_code}:`,
        err,
      );
    }
  }
  return { enqueued, trigger_id: triggerId, skipped };
}

/**
 * Open incidents with no resolution_date that are older than `days` days.
 * SAMA consumer-protection compliance requires resolution within 30 days.
 */
export async function getOverdueFraudIncidents(
  days: number = 30,
): Promise<FraudIncident[]> {
  const safe = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
  const result = await pool.query(
    `SELECT * FROM fraud_incidents
     WHERE status NOT IN ('resolved','closed')
       AND resolution_date IS NULL
       AND date_detected <= CURRENT_DATE - ($1::INT) * INTERVAL '1 day'
     ORDER BY date_detected ASC`,
    [safe],
  );
  return result.rows;
}

// ═════════════════════════════════════════════════════════════════════════════
// Feature 3 — Country Risk Assessment (PRD-FRD-001 §5.3)
// ═════════════════════════════════════════════════════════════════════════════

export type FatfStatus =
  | "no_action"
  | "increased_monitoring"
  | "high_risk_grey_list"
  | "black_list";

export type CountryRiskRating = "low" | "medium" | "high" | "critical";

export type CountryBinStatus =
  | "approved"
  | "approved_with_edd"
  | "not_approved"
  | "permanently_blocked";

export interface FraudCountryRisk {
  id?: number;
  public_id?: string;
  iso_code: string;
  country_name: string;
  fatf_status: FatfStatus;
  risk_rating: CountryRiskRating;
  expat_population?: string | null;
  bin_status: CountryBinStatus;
  edd_required?: boolean;
  special_conditions?: string | null;
  approved_by?: string | null;
  date_assessed: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface CountryRiskDef {
  iso_code: string;
  country_name: string;
  fatf_status: FatfStatus;
  risk_rating: CountryRiskRating;
  expat_population?: string;
  bin_status: CountryBinStatus;
  edd_required: boolean;
  special_conditions?: string;
}

/**
 * 20-country baseline from
 * WalaPlus-Fraud-Management-Operational-Registers.xlsx (Tab 3).
 *
 * FATF status reflects the public Black-list (high-risk jurisdictions
 * subject to a call for action) and Grey-list (increased monitoring) as
 * of the operational Excel date (April 2026). FATF publishes updates
 * three times a year; the seed will need a refresh after each update —
 * see fraud-country-review-reminder cron (Feb 1 + Oct 1).
 *
 * Hard invariant (enforced at the route + DB layer): `fatf_status =
 * black_list` forces `risk_rating = critical` AND
 * `bin_status = permanently_blocked`. Cannot be overridden in the UI.
 */
export const COUNTRY_RISK_DEFINITIONS: CountryRiskDef[] = [
  // GCC + KSA — low risk
  { iso_code: "SA", country_name: "Saudi Arabia", fatf_status: "no_action", risk_rating: "low", bin_status: "approved", edd_required: false, expat_population: "Domestic" },
  { iso_code: "AE", country_name: "United Arab Emirates", fatf_status: "no_action", risk_rating: "low", bin_status: "approved", edd_required: false, expat_population: "Large in KSA" },
  { iso_code: "BH", country_name: "Bahrain", fatf_status: "no_action", risk_rating: "low", bin_status: "approved", edd_required: false },
  { iso_code: "KW", country_name: "Kuwait", fatf_status: "no_action", risk_rating: "low", bin_status: "approved", edd_required: false },
  { iso_code: "OM", country_name: "Oman", fatf_status: "no_action", risk_rating: "low", bin_status: "approved", edd_required: false },
  { iso_code: "QA", country_name: "Qatar", fatf_status: "no_action", risk_rating: "low", bin_status: "approved", edd_required: false },
  // Major developed economies — low risk
  { iso_code: "US", country_name: "United States", fatf_status: "no_action", risk_rating: "low", bin_status: "approved", edd_required: false },
  { iso_code: "GB", country_name: "United Kingdom", fatf_status: "no_action", risk_rating: "low", bin_status: "approved", edd_required: false },
  { iso_code: "DE", country_name: "Germany", fatf_status: "no_action", risk_rating: "low", bin_status: "approved", edd_required: false },
  // Medium-risk markets with large expat populations in KSA — EDD required
  { iso_code: "IN", country_name: "India", fatf_status: "no_action", risk_rating: "medium", bin_status: "approved_with_edd", edd_required: true, expat_population: "Largest expat group in KSA" },
  { iso_code: "PK", country_name: "Pakistan", fatf_status: "no_action", risk_rating: "medium", bin_status: "approved_with_edd", edd_required: true, expat_population: "Major expat group in KSA" },
  { iso_code: "ID", country_name: "Indonesia", fatf_status: "no_action", risk_rating: "medium", bin_status: "approved_with_edd", edd_required: true, expat_population: "Significant expat group in KSA" },
  { iso_code: "EG", country_name: "Egypt", fatf_status: "no_action", risk_rating: "medium", bin_status: "approved_with_edd", edd_required: true, expat_population: "Significant expat group in KSA" },
  { iso_code: "TR", country_name: "Türkiye", fatf_status: "no_action", risk_rating: "medium", bin_status: "approved_with_edd", edd_required: true },
  // FATF grey list (increased monitoring) — high risk, EDD mandatory
  { iso_code: "NG", country_name: "Nigeria", fatf_status: "increased_monitoring", risk_rating: "high", bin_status: "approved_with_edd", edd_required: true, special_conditions: "FATF increased monitoring; EDD + transaction limits." },
  { iso_code: "YE", country_name: "Yemen", fatf_status: "increased_monitoring", risk_rating: "high", bin_status: "not_approved", edd_required: true, special_conditions: "FATF increased monitoring + ongoing conflict; default block." },
  { iso_code: "ZA", country_name: "South Africa", fatf_status: "increased_monitoring", risk_rating: "high", bin_status: "approved_with_edd", edd_required: true, special_conditions: "FATF increased monitoring." },
  // FATF black list — critical, permanently blocked
  { iso_code: "IR", country_name: "Iran", fatf_status: "black_list", risk_rating: "critical", bin_status: "permanently_blocked", edd_required: true, special_conditions: "FATF call for action — sanctions exposure." },
  { iso_code: "KP", country_name: "Korea, Democratic People's Republic of", fatf_status: "black_list", risk_rating: "critical", bin_status: "permanently_blocked", edd_required: true, special_conditions: "FATF call for action — comprehensive sanctions." },
  { iso_code: "MM", country_name: "Myanmar", fatf_status: "black_list", risk_rating: "critical", bin_status: "permanently_blocked", edd_required: true, special_conditions: "FATF call for action since 2022." },
];

/**
 * Pure helper enforcing the FATF black-list invariant. Used by both the
 * seeder and the route layer so the rule is defined once.
 */
export function applyFatfBlackListInvariant(
  input: Pick<FraudCountryRisk, "fatf_status" | "risk_rating" | "bin_status">,
): { risk_rating: CountryRiskRating; bin_status: CountryBinStatus } {
  if (input.fatf_status === "black_list") {
    return { risk_rating: "critical", bin_status: "permanently_blocked" };
  }
  return {
    risk_rating: input.risk_rating,
    bin_status: input.bin_status,
  };
}

export async function seedCountryRisk(): Promise<void> {
  const existing = await pool.query(
    `SELECT COUNT(*)::int AS n FROM fraud_country_risk`,
  );
  if ((existing.rows[0]?.n ?? 0) > 0) return;
  logger.info(
    `🌱 [FraudDB] Seeding ${COUNTRY_RISK_DEFINITIONS.length} country-risk rows...`,
  );
  for (const c of COUNTRY_RISK_DEFINITIONS) {
    const locked = applyFatfBlackListInvariant(c);
    await pool.query(
      `INSERT INTO fraud_country_risk (
        iso_code, country_name, fatf_status, risk_rating, expat_population,
        bin_status, edd_required, special_conditions, approved_by, date_assessed
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'system:seed',CURRENT_DATE)
      ON CONFLICT (iso_code) DO NOTHING`,
      [
        c.iso_code,
        c.country_name,
        c.fatf_status,
        locked.risk_rating,
        c.expat_population ?? null,
        locked.bin_status,
        c.edd_required,
        c.special_conditions ?? null,
      ],
    );
  }
  logger.info("✅ [FraudDB] Country-risk rows seeded");
}

export async function getAllCountryRisk(filters?: {
  rating?: CountryRiskRating;
  fatf_status?: FatfStatus;
  edd_required?: boolean;
}): Promise<FraudCountryRisk[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  let i = 1;
  if (filters?.rating) {
    conditions.push(`risk_rating = $${i++}`);
    params.push(filters.rating);
  }
  if (filters?.fatf_status) {
    conditions.push(`fatf_status = $${i++}`);
    params.push(filters.fatf_status);
  }
  if (filters?.edd_required !== undefined) {
    conditions.push(`edd_required = $${i++}`);
    params.push(filters.edd_required);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pool.query(
    `SELECT * FROM fraud_country_risk ${where} ORDER BY country_name ASC`,
    params,
  );
  return result.rows;
}

export async function getCountryRiskByIso(
  iso: string,
): Promise<FraudCountryRisk | null> {
  const result = await pool.query(
    `SELECT * FROM fraud_country_risk WHERE iso_code = $1`,
    [iso.toUpperCase()],
  );
  return result.rows[0] ?? null;
}

export async function getCountryRiskByPublicId(
  publicId: string,
): Promise<FraudCountryRisk | null> {
  const result = await pool.query(
    `SELECT * FROM fraud_country_risk WHERE public_id = $1`,
    [publicId],
  );
  return result.rows[0] ?? null;
}

export async function createCountryRisk(
  input: FraudCountryRisk & { approved_by: string },
): Promise<FraudCountryRisk> {
  const locked = applyFatfBlackListInvariant(input);
  const result = await pool.query(
    `INSERT INTO fraud_country_risk (
      iso_code, country_name, fatf_status, risk_rating, expat_population,
      bin_status, edd_required, special_conditions, approved_by, date_assessed
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10::DATE, CURRENT_DATE))
    RETURNING *`,
    [
      input.iso_code.toUpperCase(),
      input.country_name,
      input.fatf_status,
      locked.risk_rating,
      input.expat_population ?? null,
      locked.bin_status,
      input.edd_required ?? false,
      input.special_conditions ?? null,
      input.approved_by,
      input.date_assessed ?? null,
    ],
  );
  return result.rows[0];
}

export async function updateCountryRisk(
  iso: string,
  updates: Partial<FraudCountryRisk>,
  approvedBy: string,
): Promise<FraudCountryRisk | null> {
  const current = await getCountryRiskByIso(iso);
  if (!current) return null;

  // Apply the invariant against the prospective state, not the input.
  const prospective = {
    fatf_status: updates.fatf_status ?? current.fatf_status,
    risk_rating: updates.risk_rating ?? current.risk_rating,
    bin_status: updates.bin_status ?? current.bin_status,
  };
  const locked = applyFatfBlackListInvariant(prospective);

  // Build the SET list — accept the caller's values for non-locked fields,
  // but ALWAYS write the locked values for risk_rating / bin_status.
  const setClauses: string[] = [];
  const params: any[] = [];
  let i = 1;
  const allowed: (keyof FraudCountryRisk)[] = [
    "country_name",
    "fatf_status",
    "expat_population",
    "edd_required",
    "special_conditions",
  ];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      setClauses.push(`${key} = $${i++}`);
      params.push((updates as any)[key]);
    }
  }
  setClauses.push(`risk_rating = $${i++}`);
  params.push(locked.risk_rating);
  setClauses.push(`bin_status = $${i++}`);
  params.push(locked.bin_status);
  setClauses.push(`approved_by = $${i++}`);
  params.push(approvedBy);
  if (updates.date_assessed !== undefined) {
    setClauses.push(`date_assessed = $${i++}::DATE`);
    params.push(updates.date_assessed);
  }
  setClauses.push(`updated_at = NOW()`);
  params.push(iso.toUpperCase());
  const result = await pool.query(
    `UPDATE fraud_country_risk SET ${setClauses.join(", ")} WHERE iso_code = $${i} RETURNING *`,
    params,
  );
  return result.rows[0] ?? null;
}

export async function softDeleteCountryRisk(_iso: string): Promise<boolean> {
  // Country rows are reference data — physically deleting them would orphan
  // reporting joins. We treat "delete" as a no-op and recommend the user
  // edits to "not_approved" instead. Returning true keeps the API contract
  // consistent.
  return true;
}

/**
 * Returns the count of countries on the FATF black-list. Drives the
 * dashboard alert banner.
 */
export async function getBlackListedCountryCount(): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM fraud_country_risk WHERE fatf_status = 'black_list'`,
  );
  return result.rows[0]?.n ?? 0;
}
