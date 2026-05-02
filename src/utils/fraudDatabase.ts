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

  // 2. For P1/P2, mirror into enterprise_risks via linked_incident_id.
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
