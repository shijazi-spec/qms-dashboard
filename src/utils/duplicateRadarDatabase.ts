import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

export interface DuplicateCluster {
  id?: number;
  domain: string;
  company_name?: string;
  company_name_arabic?: string;
  company_name_normalized?: string;
  total_leads: number;
  total_deals: number;
  total_contacts: number;
  total_accounts: number;
  total_records: number;
  confidence_level: "high" | "medium" | "low";
  confidence_score: number;
  match_signals?: string[];
  first_record_date?: Date;
  latest_activity_date?: Date;
  owners_involved?: string[];
  estimated_pipeline_value?: number;
  status: "active" | "resolved" | "ignored";
  ai_recommendation?: string;
  resolved_by?: string;
  resolved_at?: Date;
  /** CS-pipeline-overlap verdict: block (active customer), review (within churn cool-off), warn (past cool-off, sales may re-engage), null (no overlap). */
  cs_overlap_verdict?: "block" | "review" | "warn" | null;
  /** Aggregated ARR exposure across the CS-pipeline deals in this cluster. */
  arr_exposure?: number;
  /** Strongest active CS phase observed in the cluster (onboarding > adoption > renewal > termination_recent > termination_old). */
  pipeline_lifecycle_state?:
    | "onboarding"
    | "adoption"
    | "renewal"
    | "termination_recent"
    | "termination_old"
    | null;
  /** Client sector derived from gov_type field or domain heuristic ("private" | "government"). */
  client_sector?: "private" | "government" | null;
  /** R3: post-merge Zoho verification outcome — 'verified' (records confirmed gone), 'failed' (records still in Zoho), or null (never verified). */
  verification_state?: "verified" | "failed" | "pending" | null;
  verification_at?: Date | null;
  verification_notes?: string | null;
  created_at?: Date;
  updated_at?: Date;
}

export interface DuplicateRecord {
  id?: number;
  cluster_id: number;
  record_type: "lead" | "deal" | "contact" | "account";
  zoho_record_id?: string;
  record_name: string;
  company_name?: string;
  email?: string;
  domain?: string;
  phone?: string;
  phone_normalized?: string;
  mobile?: string;
  mobile_normalized?: string;
  owner_name?: string;
  owner_email?: string;
  status?: string;
  stage?: string;
  deal_value?: number;
  source?: string;
  created_date?: Date;
  modified_date?: Date;
  is_primary: boolean;
  ai_recommendation?: string;
  confidence_score: number;
  match_signals?: string[];
  is_mock_data: boolean;
  raw_data?: any;
  layout_name?: string;
  layout_id?: string;
  zoho_module?: string;
  pipeline?: string;
  products?: string;
  contact_name?: string;
  account_name?: string;
  cr_number?: string;
  vat_number?: string;
  website?: string;
  country?: string;
  region?: string;
  industry?: string;
  no_of_employees?: number;
  title?: string;
  lead_type?: string;
  gov_type?: string;
  account_type?: string;
  created_at?: Date;
}

export interface ZohoSyncState {
  module: string;
  last_sync_at?: Date;
  total_synced: number;
  sync_status: "idle" | "syncing" | "completed" | "failed";
}

export interface DuplicateRecordTask {
  id?: number;
  zoho_task_id: string;
  related_record_id?: string;
  cluster_id?: number;
  subject?: string;
  due_date?: Date;
  status?: string;
  owner_name?: string;
  description?: string;
  created_at?: Date;
}

export interface DuplicateFilters {
  modules?: string[];
  owners?: string[];
  layouts?: string[];
  pipelines?: string[];
  stages?: string[];
  domain?: string;
  start_date?: string;
  end_date?: string;
  status?: string;
  confidence_level?: string;
}

export interface MergeAction {
  id?: number;
  cluster_id: number;
  primary_record_id: number;
  merged_record_ids: number[];
  action_type: "merge" | "resolve" | "ignore";
  performed_by?: string;
  notes?: string;
  created_at?: Date;
}

export interface OwnerAccountability {
  owner_name: string;
  owner_email: string;
  // Team / role badge sourced from SEED_USERS so coaching reports can group
  // owners by squad ("MP", "WO Sales", "CS", "MGMT", etc.). "Unassigned" when
  // the owner name doesn't match a known seed user.
  team: string;
  total_records: number;
  duplicate_records: number;
  duplicate_rate: number;
  clusters_involved: number;
  high_confidence_duplicates: number;
  estimated_waste_value: number;
  rag_status: "green" | "amber" | "red";
}

export interface DuplicateDetectionLog {
  id?: number;
  detection_type: "manual" | "scheduled" | "on_demand" | "interval-fallback";
  total_records_scanned: number;
  total_clusters_found: number;
  total_duplicates_detected: number;
  high_confidence_count: number;
  medium_confidence_count: number;
  low_confidence_count: number;
  estimated_pipeline_inflation?: number;
  detection_duration_ms?: number;
  triggered_by?: string;
  user_email?: string;
  status: "running" | "completed" | "failed";
  error_message?: string;
  detection_config?: any;
  created_at?: Date;
  completed_at?: Date;
}

export interface DuplicateExportLog {
  id?: number;
  export_type: "cluster" | "owner" | "time_period" | "all";
  filter_criteria?: any;
  total_records_exported: number;
  file_format: "excel" | "csv" | "xlsx";
  exported_by?: string;
  user_email?: string;
  created_at?: Date;
}

const PUBLIC_DOMAINS = [
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "aol.com",
  "live.com",
  "msn.com",
  "mail.com",
  "protonmail.com",
  "yandex.com",
  "zoho.com",
  "gmx.com",
  "fastmail.com",
  "stc.com.sa",
  "mobily.com.sa",
  "zain.com.sa",
];

// Full list (no LIMIT 5) for "View All" modals on the dashboard.
// Defaults to active clusters only so resolved/ignored false-positives are excluded;
// pass includeInactive=true to see all clusters regardless of status.
export async function getAllClustersByInflation(
  opts: { limit?: number; offset?: number; includeInactive?: boolean } = {},
): Promise<any[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000));
  const offset = Math.max(0, opts.offset ?? 0);
  const statusClause = opts.includeInactive ? "" : `AND status = 'active'`;
  const r = await pool.query(
    `SELECT id, domain, company_name, company_name_arabic,
            estimated_pipeline_value, total_records,
            total_leads, total_deals, total_contacts, total_accounts,
            confidence_score, confidence_level, status,
            cs_overlap_verdict, arr_exposure, pipeline_lifecycle_state, client_sector
       FROM duplicate_clusters
      WHERE estimated_pipeline_value > 0
        AND total_records > 1
        ${statusClause}
      ORDER BY estimated_pipeline_value DESC, total_records DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return r.rows;
}

// All clusters that include a given match signal (e.g. exact_email, phone_match).
// Same active-by-default behavior as getAllClustersByInflation.
export async function getClustersBySignal(
  signal: string,
  opts: { limit?: number; offset?: number; includeInactive?: boolean } = {},
): Promise<any[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000));
  const offset = Math.max(0, opts.offset ?? 0);
  const statusClause = opts.includeInactive ? "" : `AND status = 'active'`;
  const r = await pool.query(
    `SELECT id, domain, company_name, company_name_arabic,
            estimated_pipeline_value, total_records,
            total_leads, total_deals, total_contacts, total_accounts,
            confidence_score, confidence_level, status, match_signals,
            cs_overlap_verdict, arr_exposure, pipeline_lifecycle_state, client_sector
       FROM duplicate_clusters
      WHERE total_records > 1
        AND match_signals @> to_jsonb(ARRAY[$1::text])
        ${statusClause}
      ORDER BY confidence_score DESC, total_records DESC
      LIMIT $2 OFFSET $3`,
    [signal, limit, offset],
  );
  return r.rows;
}

export function extractDomain(email: string): string | null {
  if (!email || typeof email !== "string") return null;
  const match = email
    .toLowerCase()
    .trim()
    .match(/@([^@]+)$/);
  if (!match) return null;
  let domain = match[1].replace(/^www\./, "").trim();
  if (PUBLIC_DOMAINS.includes(domain)) return null;
  return domain;
}

export function normalizeDomain(domain: string): string {
  if (!domain) return "";
  return domain
    .toLowerCase()
    .replace(/^www\./, "")
    .trim();
}

export function calculateSimilarity(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  if (s1 === s2) return 100;

  const longer = s1.length > s2.length ? s1 : s2;

  if (longer.length === 0) return 100;

  const editDistance = levenshteinDistance(s1, s2);
  return Math.round((1 - editDistance / longer.length) * 100);
}

function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1;
      }
    }
  }
  return dp[m][n];
}

export function getConfidenceLevel(score: number): "high" | "medium" | "low" {
  if (score >= 90) return "high";
  if (score >= 60) return "medium";
  return "low";
}

export function normalizePhone(phone: string): string {
  if (!phone) return "";
  return phone
    .replace(/[\s\-\(\)\+\.]/g, "")
    .replace(/^00/, "")
    .replace(/^966/, "")
    .slice(-9);
}

export interface MatchResult {
  score: number;
  signals: string[];
}

/**
 * Multi-signal duplicate match scoring.
 *
 * Weights are calibrated for B2B Saudi data (gov + private sector). In observed
 * real-world data (see `docs/duplicate-radar-cs-overlap.md`), ~100% of true
 * duplicates share the same domain while only ~12% share email — so domain
 * carries more weight than email here. PUBLIC_DOMAINS callers should still
 * suppress the domain signal when both records are personal-email accounts.
 *
 * Override profile by env if a different shape is needed:
 *   DUPLICATE_RADAR_SCORING_PROFILE=b2b   (default, current weights)
 *   DUPLICATE_RADAR_SCORING_PROFILE=email_first  (legacy: email=40, domain=25)
 */
export function calculateMultiSignalScore(
  record1: {
    email?: string;
    domain?: string;
    phone?: string;
    company_name?: string;
  },
  record2: {
    email?: string;
    domain?: string;
    phone?: string;
    company_name?: string;
  },
): MatchResult {
  const profile =
    process.env.DUPLICATE_RADAR_SCORING_PROFILE === "email_first"
      ? "email_first"
      : "b2b";
  const weights =
    profile === "email_first"
      ? { email: 40, domain: 25, phone: 30, companyExact: 20, companyFuzzy: 10 }
      : { email: 30, domain: 50, phone: 30, companyExact: 20, companyFuzzy: 10 };

  const signals: string[] = [];
  let score = 0;

  if (
    record1.email &&
    record2.email &&
    record1.email.toLowerCase() === record2.email.toLowerCase()
  ) {
    score += weights.email;
    signals.push("exact_email");
  }

  if (record1.domain && record2.domain && record1.domain === record2.domain) {
    score += weights.domain;
    signals.push("domain_match");
  }

  if (record1.phone && record2.phone) {
    const p1 = normalizePhone(record1.phone);
    const p2 = normalizePhone(record2.phone);
    if (p1 && p2 && p1.length >= 7 && p1 === p2) {
      score += weights.phone;
      signals.push("phone_match");
    }
  }

  if (record1.company_name && record2.company_name) {
    const similarity = calculateSimilarity(
      normalizeCompanyName(record1.company_name),
      normalizeCompanyName(record2.company_name),
    );
    if (similarity >= 90) {
      score += weights.companyExact;
      signals.push("company_exact");
    } else if (similarity >= 75) {
      score += weights.companyFuzzy;
      signals.push("company_fuzzy");
    }
  }

  return { score: Math.min(score, 100), signals };
}

// Memoization handle for initDuplicateRadarTables.
//
// 6 route handlers in duplicateRadarRoutes.ts call this at the top of
// every request (recalculate-stats, account-hints/scan, packet, kpis,
// preflight, the lifecycle endpoints…). The init body executes ~30
// CREATE TABLE / ALTER TABLE / CREATE INDEX statements plus an optional
// pg_trgm extension install. They're idempotent (IF NOT EXISTS) but on
// a cold Replit container the first run takes 5–15s, and 6 endpoints
// firing in parallel from /duplicates' refreshData all race for the
// same work. Same cold-start failure mode as initCallIntelligenceTables
// before its memoization landed (see that file for the playbook).
//
// Fix: run the schema body exactly once per process lifetime. Subsequent
// calls await the cached promise (cheap) and return as soon as the
// first call finishes. Cached promise is cleared on failure so a
// transient connection blip doesn't pin the cache forever.
let _ddrInitPromise: Promise<void> | null = null;
let _ddrInitDone = false;

export async function initDuplicateRadarTables(): Promise<void> {
  if (_ddrInitDone) return;
  if (_ddrInitPromise) return _ddrInitPromise;
  _ddrInitPromise = (async () => {
    const startedAt = Date.now();
    try {
      await _doInitDuplicateRadarTables();
      _ddrInitDone = true;
      const ms = Date.now() - startedAt;
      // Loud above 2s so an operator tailing logs can spot a legitimate
      // cold start vs a recurring slow path (which would mean the
      // memoization broke).
      if (ms > 2000) {
        logger.warn(
          `[duplicateRadarDatabase] initDuplicateRadarTables took ${ms}ms (cold start)`,
        );
      } else {
        logger.info(
          `[duplicateRadarDatabase] initDuplicateRadarTables completed in ${ms}ms`,
        );
      }
    } catch (err) {
      _ddrInitPromise = null;
      throw err;
    }
  })();
  return _ddrInitPromise;
}

async function _doInitDuplicateRadarTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_clusters (
      id SERIAL PRIMARY KEY,
      domain VARCHAR(255) NOT NULL,
      company_name VARCHAR(500),
      company_name_arabic VARCHAR(500),
      company_name_normalized VARCHAR(500),
      total_leads INTEGER DEFAULT 0,
      total_deals INTEGER DEFAULT 0,
      total_contacts INTEGER DEFAULT 0,
      total_accounts INTEGER DEFAULT 0,
      total_records INTEGER DEFAULT 0,
      confidence_level VARCHAR(20) DEFAULT 'medium',
      confidence_score INTEGER DEFAULT 0,
      match_signals JSONB DEFAULT '[]',
      first_record_date TIMESTAMP,
      latest_activity_date TIMESTAMP,
      owners_involved JSONB DEFAULT '[]',
      estimated_pipeline_value DECIMAL(15,2) DEFAULT 0,
      status VARCHAR(50) DEFAULT 'active',
      ai_recommendation TEXT,
      resolved_by VARCHAR(255),
      resolved_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS total_contacts INTEGER DEFAULT 0`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS total_accounts INTEGER DEFAULT 0`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS match_signals JSONB DEFAULT '[]'`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(255)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS company_name_normalized VARCHAR(500)`,
  );

  // CS-pipeline overlap detection (sector-aware) — Phase 1
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS cs_overlap_verdict VARCHAR(16)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS arr_exposure DECIMAL(15,2) DEFAULT 0`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS pipeline_lifecycle_state VARCHAR(32)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS client_sector VARCHAR(16)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_clusters_cs_overlap ON duplicate_clusters(cs_overlap_verdict) WHERE cs_overlap_verdict IS NOT NULL`,
  );
  // R3 (quick-wins): post-merge verification state. When an operator clicks
  // "Mark Resolved + Verify" we check that the cluster's non-primary records
  // were actually deleted in Zoho and persist the outcome here so the
  // dashboard can surface a Verified / Failed badge.
  //   verification_state: NULL / 'verified' / 'failed' / 'pending'
  //   verification_at:    when we ran the check
  //   verification_notes: human-readable summary (X confirmed deleted, Y still present)
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS verification_state VARCHAR(16)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS verification_at TIMESTAMP`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS verification_notes TEXT`,
  );
  // R10 (medium-term): pre-merge snapshots. Cloudingo's flagship feature is
  // "Undo Merge" — we can't actually undo a Zoho merge (Zoho deletes the
  // record), but we can freeze a JSON copy of the cluster + every record
  // (including raw_data) at the moment "Mark Resolved" is clicked. The
  // forensic trail lets owners audit what was about to be lost if a
  // verification later flags the merge as wrong, or settle a dispute weeks
  // later when memories fade. ON DELETE SET NULL so the snapshot survives
  // even if the cluster row is purged in a cleanup job.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_cluster_snapshots (
      id              SERIAL PRIMARY KEY,
      cluster_id      INTEGER REFERENCES duplicate_clusters(id) ON DELETE SET NULL,
      snapshot_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      taken_by        VARCHAR(255),
      trigger         VARCHAR(64) NOT NULL,
      merge_action_id INTEGER,
      record_count    INTEGER NOT NULL DEFAULT 0,
      cluster_snapshot JSONB NOT NULL,
      records_snapshot JSONB NOT NULL,
      notes           TEXT
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_dr_cluster_snapshots_cluster ON duplicate_cluster_snapshots(cluster_id) WHERE cluster_id IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_dr_cluster_snapshots_at ON duplicate_cluster_snapshots(snapshot_at DESC)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_records (
      id SERIAL PRIMARY KEY,
      cluster_id INTEGER REFERENCES duplicate_clusters(id) ON DELETE CASCADE,
      record_type VARCHAR(20) NOT NULL,
      zoho_record_id VARCHAR(100),
      record_name VARCHAR(500),
      company_name VARCHAR(500),
      email VARCHAR(255),
      domain VARCHAR(255),
      phone VARCHAR(100),
      phone_normalized VARCHAR(50),
      owner_name VARCHAR(255),
      owner_email VARCHAR(255),
      status VARCHAR(100),
      stage VARCHAR(100),
      deal_value DECIMAL(15,2),
      source VARCHAR(255),
      created_date TIMESTAMP,
      modified_date TIMESTAMP,
      is_primary BOOLEAN DEFAULT FALSE,
      ai_recommendation TEXT,
      confidence_score INTEGER DEFAULT 0,
      match_signals JSONB DEFAULT '[]',
      is_mock_data BOOLEAN DEFAULT FALSE,
      raw_data JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS phone_normalized VARCHAR(50)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS match_signals JSONB DEFAULT '[]'`,
  );

  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS layout_name VARCHAR(255)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS layout_id VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS zoho_module VARCHAR(50)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS pipeline VARCHAR(255)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS products TEXT`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS mobile VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS mobile_normalized VARCHAR(50)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS contact_name VARCHAR(255)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS account_name VARCHAR(500)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS cr_number VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS vat_number VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS website VARCHAR(500)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS country VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS region VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS industry VARCHAR(255)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS no_of_employees INTEGER`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS title VARCHAR(255)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS lead_type VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS gov_type VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS account_type VARCHAR(100)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS zoho_sync_state (
      module VARCHAR(50) PRIMARY KEY,
      last_sync_at TIMESTAMP,
      total_synced INTEGER DEFAULT 0,
      sync_status VARCHAR(50) DEFAULT 'idle'
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_record_tasks (
      id SERIAL PRIMARY KEY,
      zoho_task_id VARCHAR(100) UNIQUE,
      related_record_id VARCHAR(100),
      cluster_id INTEGER REFERENCES duplicate_clusters(id) ON DELETE SET NULL,
      subject VARCHAR(500),
      due_date TIMESTAMP,
      status VARCHAR(100),
      owner_name VARCHAR(255),
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_merge_actions (
      id SERIAL PRIMARY KEY,
      cluster_id INTEGER REFERENCES duplicate_clusters(id) ON DELETE CASCADE,
      primary_record_id INTEGER REFERENCES duplicate_records(id),
      merged_record_ids JSONB DEFAULT '[]',
      action_type VARCHAR(20) NOT NULL DEFAULT 'resolve',
      performed_by VARCHAR(255),
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_detection_logs (
      id SERIAL PRIMARY KEY,
      detection_type VARCHAR(50) DEFAULT 'manual',
      total_records_scanned INTEGER DEFAULT 0,
      total_clusters_found INTEGER DEFAULT 0,
      total_duplicates_detected INTEGER DEFAULT 0,
      high_confidence_count INTEGER DEFAULT 0,
      medium_confidence_count INTEGER DEFAULT 0,
      low_confidence_count INTEGER DEFAULT 0,
      estimated_pipeline_inflation DECIMAL(15,2),
      detection_duration_ms INTEGER,
      triggered_by VARCHAR(255),
      user_email VARCHAR(255),
      status VARCHAR(50) DEFAULT 'running',
      error_message TEXT,
      detection_config JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_export_logs (
      id SERIAL PRIMARY KEY,
      export_type VARCHAR(50) DEFAULT 'all',
      filter_criteria JSONB,
      total_records_exported INTEGER DEFAULT 0,
      file_format VARCHAR(20) DEFAULT 'excel',
      exported_by VARCHAR(255),
      user_email VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_clusters_domain ON duplicate_clusters(domain)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_clusters_status ON duplicate_clusters(status)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_cluster ON duplicate_records(cluster_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_type ON duplicate_records(record_type)`,
  );

  // B6: Additional performance indexes
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_duplicate_records_zoho_id ON duplicate_records(zoho_record_id) WHERE zoho_record_id IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_email ON duplicate_records(LOWER(email)) WHERE email IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_phone_norm ON duplicate_records(phone_normalized) WHERE phone_normalized IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_domain ON duplicate_records(domain) WHERE domain IS NOT NULL`,
  );

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_layout ON duplicate_records(layout_name) WHERE layout_name IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_zoho_module ON duplicate_records(zoho_module) WHERE zoho_module IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_pipeline ON duplicate_records(pipeline) WHERE pipeline IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_owner ON duplicate_records(owner_name) WHERE owner_name IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_country ON duplicate_records(country) WHERE country IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_industry ON duplicate_records(industry) WHERE industry IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_modified ON duplicate_records(modified_date)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_mobile_norm ON duplicate_records(mobile_normalized) WHERE mobile_normalized IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_cr ON duplicate_records(cr_number) WHERE cr_number IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_vat ON duplicate_records(vat_number) WHERE vat_number IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_record_tasks_record ON duplicate_record_tasks(related_record_id)`,
  );

  // B4: pg_trgm for fuzzy matching
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_clusters_company_trgm ON duplicate_clusters USING GIN (company_name_normalized gin_trgm_ops)`,
    );
  } catch (e) {
    logger.info(
      "⚠️ [DuplicateRadar] pg_trgm not available, falling back to Levenshtein matching",
    );
  }

  // Account inference hints — see src/utils/accountInference.ts. Stored
  // suggestions for sales: "this deal looks like it belongs to Account X
  // because the contact's email domain matches". Sales work the queue from
  // the Account Hints tab.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_inference_hints (
      id SERIAL PRIMARY KEY,
      deal_record_id INTEGER NOT NULL REFERENCES duplicate_records(id) ON DELETE CASCADE,
      suggested_account_record_id INTEGER REFERENCES duplicate_records(id) ON DELETE CASCADE,
      suggested_account_name TEXT,
      suggested_domain TEXT,
      evidence_contact_record_id INTEGER REFERENCES duplicate_records(id) ON DELETE SET NULL,
      evidence_contact_email TEXT,
      confidence INTEGER DEFAULT 0,
      status VARCHAR(16) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (deal_record_id, suggested_account_record_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_account_inference_status ON account_inference_hints(status)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_account_inference_confidence ON account_inference_hints(confidence DESC) WHERE status = 'pending'`,
  );

  // R2 (per-owner Remediation Packet): cover-sheet text the operator
  // hands to a data-quality owner. Single-row key/value table — keeps the
  // dispute path + escalation contact editable without a code deploy and
  // without touching env vars. Seeded with sensible defaults if empty.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_radar_packet_settings (
      setting_key   VARCHAR(64) PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Seed defaults — ON CONFLICT DO NOTHING so existing installs that
  // customised these values are not overwritten. To CHANGE a live value:
  //   UPDATE duplicate_radar_packet_settings
  //     SET setting_value='<new>'
  //     WHERE setting_key='<key>';
  await pool.query(
    `INSERT INTO duplicate_radar_packet_settings (setting_key, setting_value) VALUES
       ('escalation_contact_name',  'Ahmad Amashah — Operations Quality'),
       ('escalation_contact_email', 'a.amashah@walaplus.com'),
       ('dispute_path',             'If a row should NOT be merged (e.g. intentional parallel deals for compliance reasons), flag it back to GRQ Quality with the Cluster ID and a one-line justification. Do not merge in Zoho until acknowledged.')
     ON CONFLICT (setting_key) DO NOTHING`,
  );
}

export interface PacketSettings {
  escalation_contact_name: string;
  escalation_contact_email: string;
  dispute_path: string;
}

export async function getPacketSettings(): Promise<PacketSettings> {
  const r = await pool.query(
    `SELECT setting_key, setting_value FROM duplicate_radar_packet_settings`,
  );
  const map: Record<string, string> = {};
  for (const row of r.rows) map[row.setting_key] = row.setting_value;
  return {
    escalation_contact_name:
      map.escalation_contact_name || "Ahmad Amashah — Operations Quality",
    escalation_contact_email:
      map.escalation_contact_email || "a.amashah@walaplus.com",
    dispute_path:
      map.dispute_path ||
      "If a row should NOT be merged, flag it back to GRQ Quality with the Cluster ID and a one-line justification. Do not merge in Zoho until acknowledged.",
  };
}

export async function createCluster(
  cluster: Omit<DuplicateCluster, "id" | "created_at" | "updated_at">,
): Promise<DuplicateCluster> {
  const companyNormalized = cluster.company_name
    ? normalizeCompanyName(cluster.company_name)
    : null;
  const result = await pool.query(
    `INSERT INTO duplicate_clusters 
     (domain, company_name, company_name_arabic, company_name_normalized, total_leads, total_deals, total_records, 
      confidence_level, confidence_score, first_record_date, latest_activity_date, 
      owners_involved, estimated_pipeline_value, status, ai_recommendation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      cluster.domain,
      cluster.company_name,
      cluster.company_name_arabic,
      companyNormalized,
      cluster.total_leads,
      cluster.total_deals,
      cluster.total_records,
      cluster.confidence_level,
      cluster.confidence_score,
      cluster.first_record_date,
      cluster.latest_activity_date,
      JSON.stringify(cluster.owners_involved || []),
      cluster.estimated_pipeline_value || 0,
      cluster.status,
      cluster.ai_recommendation,
    ],
  );
  return result.rows[0];
}

// A1: Incremental upsert for records (replaces destructive clearAllDuplicateData approach)
export async function upsertRecord(
  record: Omit<DuplicateRecord, "id" | "created_at">,
): Promise<DuplicateRecord> {
  const phoneNorm = record.phone ? normalizePhone(record.phone) : null;
  const mobileNorm = record.mobile ? normalizePhone(record.mobile) : null;
  const result = await pool.query(
    `INSERT INTO duplicate_records 
     (cluster_id, record_type, zoho_record_id, record_name, company_name, email, domain,
      phone, phone_normalized, mobile, mobile_normalized, owner_name, owner_email, status, stage, deal_value, source, created_date,
      modified_date, is_primary, ai_recommendation, confidence_score, is_mock_data, raw_data,
      layout_name, layout_id, zoho_module, pipeline, products, contact_name, account_name,
      cr_number, vat_number, website, country, region, industry, no_of_employees, title,
      lead_type, gov_type, account_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
             $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42)
     ON CONFLICT (zoho_record_id) WHERE zoho_record_id IS NOT NULL DO UPDATE SET
       cluster_id = EXCLUDED.cluster_id,
       record_name = EXCLUDED.record_name,
       company_name = EXCLUDED.company_name,
       email = EXCLUDED.email,
       domain = EXCLUDED.domain,
       phone = EXCLUDED.phone,
       phone_normalized = EXCLUDED.phone_normalized,
       mobile = EXCLUDED.mobile,
       mobile_normalized = EXCLUDED.mobile_normalized,
       owner_name = EXCLUDED.owner_name,
       owner_email = EXCLUDED.owner_email,
       status = EXCLUDED.status,
       stage = EXCLUDED.stage,
       deal_value = EXCLUDED.deal_value,
       source = EXCLUDED.source,
       modified_date = EXCLUDED.modified_date,
       raw_data = EXCLUDED.raw_data,
       layout_name = EXCLUDED.layout_name,
       layout_id = EXCLUDED.layout_id,
       zoho_module = EXCLUDED.zoho_module,
       pipeline = EXCLUDED.pipeline,
       products = EXCLUDED.products,
       contact_name = EXCLUDED.contact_name,
       account_name = EXCLUDED.account_name,
       cr_number = EXCLUDED.cr_number,
       vat_number = EXCLUDED.vat_number,
       website = EXCLUDED.website,
       country = EXCLUDED.country,
       region = EXCLUDED.region,
       industry = EXCLUDED.industry,
       no_of_employees = EXCLUDED.no_of_employees,
       title = EXCLUDED.title,
       lead_type = EXCLUDED.lead_type,
       gov_type = EXCLUDED.gov_type,
       account_type = EXCLUDED.account_type
     RETURNING *`,
    [
      record.cluster_id,
      record.record_type,
      record.zoho_record_id,
      record.record_name,
      record.company_name,
      record.email,
      record.domain,
      record.phone,
      phoneNorm,
      record.mobile,
      mobileNorm,
      record.owner_name,
      record.owner_email,
      record.status,
      record.stage,
      record.deal_value,
      record.source,
      record.created_date,
      record.modified_date,
      record.is_primary,
      record.ai_recommendation,
      record.confidence_score,
      record.is_mock_data,
      JSON.stringify(record.raw_data || {}),
      record.layout_name,
      record.layout_id,
      record.zoho_module,
      record.pipeline,
      record.products,
      record.contact_name,
      record.account_name,
      record.cr_number,
      record.vat_number,
      record.website,
      record.country,
      record.region,
      record.industry,
      record.no_of_employees,
      record.title,
      record.lead_type,
      record.gov_type,
      record.account_type,
    ],
  );
  return result.rows[0];
}

// A7: phone_normalized included directly in INSERT
export async function addRecordToCluster(
  record: Omit<DuplicateRecord, "id" | "created_at">,
): Promise<DuplicateRecord> {
  const phoneNorm = record.phone ? normalizePhone(record.phone) : null;
  const result = await pool.query(
    `INSERT INTO duplicate_records 
     (cluster_id, record_type, zoho_record_id, record_name, company_name, email, domain,
      phone, phone_normalized, owner_name, owner_email, status, stage, deal_value, source, created_date,
      modified_date, is_primary, ai_recommendation, confidence_score, is_mock_data, raw_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
     RETURNING *`,
    [
      record.cluster_id,
      record.record_type,
      record.zoho_record_id,
      record.record_name,
      record.company_name,
      record.email,
      record.domain,
      record.phone,
      phoneNorm,
      record.owner_name,
      record.owner_email,
      record.status,
      record.stage,
      record.deal_value,
      record.source,
      record.created_date,
      record.modified_date,
      record.is_primary,
      record.ai_recommendation,
      record.confidence_score,
      record.is_mock_data,
      JSON.stringify(record.raw_data || {}),
    ],
  );
  return result.rows[0];
}

// Build the shared WHERE clause for cluster listing/counting. Centralised so
// the new `layouts` filter (and any future ones) stay in lock-step between
// `getAllClusters` and `getClusterCount`.
function buildClusterFilterClause(
  filters:
    | {
        status?: string;
        confidence_level?: string;
        start_date?: string;
        end_date?: string;
        hide_hierarchies?: boolean;
        layouts?: string[];
      }
    | undefined,
  startIndex: number,
): { clause: string; params: any[]; nextIndex: number } {
  const params: any[] = [];
  let paramIndex = startIndex;
  let clause = "";

  if (filters?.status) {
    clause += ` AND status = $${paramIndex++}`;
    params.push(filters.status);
  }
  if (filters?.confidence_level) {
    clause += ` AND confidence_level = $${paramIndex++}`;
    params.push(filters.confidence_level);
  }
  if (filters?.start_date) {
    clause += ` AND created_at >= $${paramIndex++}`;
    params.push(filters.start_date);
  }
  if (filters?.end_date) {
    clause += ` AND created_at <= $${paramIndex++}`;
    params.push(filters.end_date + "T23:59:59Z");
  }
  if (filters?.hide_hierarchies) {
    clause += ` AND GREATEST(COALESCE(total_leads,0), COALESCE(total_deals,0), COALESCE(total_contacts,0), COALESCE(total_accounts,0)) > 1`;
  }
  // Layout filter: keep clusters that have at least one record in any of the
  // selected Zoho layouts (Corporate Accounts, Standard, Marketplace, ...).
  if (filters?.layouts && filters.layouts.length > 0) {
    clause += ` AND EXISTS (
      SELECT 1 FROM duplicate_records dr
       WHERE dr.cluster_id = duplicate_clusters.id
         AND dr.layout_name = ANY($${paramIndex++}::text[])
    )`;
    params.push(filters.layouts);
  }
  return { clause, params, nextIndex: paramIndex };
}

// Whitelisted sort columns. Only allow values mapped here to be interpolated
// into the ORDER BY — guards against SQL injection from the query string.
const CLUSTER_SORT_COLUMNS: Record<string, string> = {
  records:    "total_records",
  similarity: "confidence_score",
  domain:     "domain",
  company:    "company_name",
  status:     "status",
  inflation:  "estimated_pipeline_value",
  updated:    "updated_at",
};

export async function getAllClusters(filters?: {
  status?: string;
  confidence_level?: string;
  limit?: number;
  offset?: number;
  start_date?: string;
  end_date?: string;
  hide_hierarchies?: boolean;
  layouts?: string[];
  sort?: string;
  dir?: string;
}): Promise<Array<DuplicateCluster & { domain_count?: number }>> {
  const { clause, params, nextIndex } = buildClusterFilterClause(filters, 1);
  let paramIndex = nextIndex;
  // domain_count is a correlated subquery counting DISTINCT corporate-shaped
  // domains across the cluster's records. The frontend uses values >= 2 to
  // flag mixed clusters at the card level without an N+1 per-card fetch.
  // We approximate isCorporateDomain() in SQL by excluding empty values and
  // free-mail domains; the JS-side helper is authoritative for the modal,
  // this is just a cheap card-level hint.
  // domain_count is a correlated subquery that the frontend uses to flag
  // mixed-domain clusters at the card level (≥2 ⇒ mixed). We avoid a table
  // alias on the outer FROM because buildClusterFilterClause references
  // `duplicate_clusters.id` unqualified inside its EXISTS sub-clause for
  // the layouts filter.
  let query =
    `SELECT duplicate_clusters.*,
            (SELECT COUNT(DISTINCT LOWER(r.domain))
               FROM duplicate_records r
              WHERE r.cluster_id = duplicate_clusters.id
                AND r.domain IS NOT NULL
                AND r.domain <> ''
                AND LOWER(r.domain) NOT IN (
                  'gmail.com','yahoo.com','hotmail.com','outlook.com',
                  'live.com','aol.com','icloud.com','mail.com',
                  'protonmail.com','yandex.com','zoho.com'
                )
            ) AS domain_count
       FROM duplicate_clusters
      WHERE 1=1` + clause;

  const sortKey = filters?.sort && CLUSTER_SORT_COLUMNS[filters.sort]
    ? CLUSTER_SORT_COLUMNS[filters.sort]
    : "total_records";
  const dir = filters?.dir === "asc" ? "ASC" : "DESC";
  // Stable secondary sort so equal primary values don't churn between pages.
  query += ` ORDER BY ${sortKey} ${dir} NULLS LAST, id ASC`;

  if (filters?.limit) {
    query += ` LIMIT $${paramIndex++}`;
    params.push(filters.limit);
  }
  if (filters?.offset !== undefined && filters?.offset !== null) {
    query += ` OFFSET $${paramIndex++}`;
    params.push(filters.offset);
  }

  const result = await pool.query(query, params);
  return result.rows;
}

export async function getClusterCount(filters?: {
  status?: string;
  confidence_level?: string;
  start_date?: string;
  end_date?: string;
  hide_hierarchies?: boolean;
  layouts?: string[];
}): Promise<number> {
  const { clause, params } = buildClusterFilterClause(filters, 1);
  const query =
    "SELECT COUNT(*) as total FROM duplicate_clusters WHERE 1=1" + clause;
  const result = await pool.query(query, params);
  return parseInt(result.rows[0]?.total) || 0;
}

// Hard reset for the "Rebuild Clusters" admin action.
// Wipes all clusters + records so the next scan starts from a clean slate.
export async function truncateAllDuplicateData(): Promise<void> {
  logger.info(
    "🧨 [DuplicateRadar] Truncating all duplicate data for rebuild...",
  );
  await pool.query(
    "TRUNCATE duplicate_records, duplicate_clusters RESTART IDENTITY CASCADE",
  );
  logger.info("✅ [DuplicateRadar] Duplicate tables truncated");
}

export async function getClusterById(
  id: number,
): Promise<DuplicateCluster | null> {
  const result = await pool.query(
    "SELECT * FROM duplicate_clusters WHERE id = $1",
    [id],
  );
  return result.rows[0] || null;
}

export async function getRecordsByClusterId(
  clusterId: number,
): Promise<DuplicateRecord[]> {
  const result = await pool.query(
    "SELECT * FROM duplicate_records WHERE cluster_id = $1 ORDER BY is_primary DESC, created_date ASC",
    [clusterId],
  );
  return result.rows;
}

/**
 * Inspect a cluster's records and report any "mixed signal" — distinct
 * corporate domains or distinct normalized phone numbers found inside.
 * Two unrelated companies that share a generic name fragment can end up
 * in the same cluster (e.g. "Al Suwaidi Industrial Services" + "APEX
 * Industrial Services"). Surfacing this lets the operator review &
 * split before any merge/link is performed in Zoho.
 *
 * `domain_groups` maps each domain to the record IDs holding that
 * domain so the UI can offer a one-click "Split by domain" action.
 */
export async function getClusterMixedSignal(clusterId: number): Promise<{
  domains: string[];
  phones: string[];
  domain_groups: Record<string, number[]>;
}> {
  const records = await getRecordsByClusterId(clusterId);
  const domainGroups: Record<string, number[]> = {};
  const phoneSet = new Set<string>();
  for (const r of records) {
    const d = (r.domain || "").toLowerCase().trim();
    if (d && isCorporateDomain(d)) {
      if (!domainGroups[d]) domainGroups[d] = [];
      if (typeof r.id === "number") domainGroups[d].push(r.id);
    }
    const p = normalizePhone(r.phone || "");
    if (p && p.length >= 7) phoneSet.add(p);
  }
  return {
    domains: Object.keys(domainGroups).sort(),
    phones: Array.from(phoneSet).sort(),
    domain_groups: domainGroups,
  };
}

/**
 * Move a set of records out of `sourceClusterId` and into a freshly
 * created cluster. Returns both cluster IDs so the caller can recompute
 * stats and refresh the UI. The source cluster is left in place even if
 * it ends up empty — `updateClusterStats` will drive its counters to
 * zero and the existing orphan-cleanup pass will collect it later.
 */
/**
 * Transactional core of the cluster-split flow. Performs ONLY the
 * destructive writes (insert new cluster row + move records across) using
 * the supplied client, so callers can wrap multiple plans in a single
 * BEGIN/COMMIT and roll back on any failure.
 *
 * Stats refresh (confidence_score etc.) is intentionally NOT performed
 * here — it is idempotent and is run by the caller AFTER commit. This
 * keeps the transaction window small and avoids the heavy multi-query
 * stats recompute participating in the locking scope.
 *
 * Exported so the split route can compose plans atomically.
 */
export async function splitRecordsIntoNewClusterInTx(
  client: { query: (sql: string, params?: any[]) => Promise<any> },
  sourceClusterId: number,
  recordIds: number[],
  newClusterSeed: {
    company_name: string;
    domain?: string | null;
  },
): Promise<{ source_cluster_id: number; new_cluster_id: number }> {
  if (!Array.isArray(recordIds) || recordIds.length === 0) {
    throw new Error("recordIds must be a non-empty array");
  }

  // Pre-flight: every record must currently belong to the source cluster.
  // This catches concurrent splits/moves and prevents creating a fresh
  // cluster pointing at records that already drifted away.
  const ownership = await client.query(
    `SELECT id FROM duplicate_records
      WHERE cluster_id = $1 AND id = ANY($2::int[])`,
    [sourceClusterId, recordIds],
  );
  if (ownership.rows.length !== recordIds.length) {
    throw new Error(
      `Split aborted — ${recordIds.length - ownership.rows.length} record(s) no longer belong to cluster ${sourceClusterId} (concurrent move?)`,
    );
  }

  const companyNormalized = normalizeCompanyName(newClusterSeed.company_name);
  const seedDomain =
    newClusterSeed.domain ||
    companyNormalized.replace(/\s+/g, "-") + ".cluster";

  const inserted = await client.query(
    `INSERT INTO duplicate_clusters
       (domain, company_name, company_name_arabic, company_name_normalized,
        total_leads, total_deals, total_records, confidence_level,
        confidence_score, owners_involved, estimated_pipeline_value, status)
     VALUES ($1, $2, NULL, $3, 0, 0, 0, 'low', 0, '[]'::jsonb, 0, 'active')
     RETURNING id`,
    [seedDomain, newClusterSeed.company_name, companyNormalized],
  );
  const newClusterId = inserted.rows[0].id as number;

  await client.query(
    `UPDATE duplicate_records
        SET cluster_id = $1,
            is_primary = false
      WHERE cluster_id = $2
        AND id = ANY($3::int[])`,
    [newClusterId, sourceClusterId, recordIds],
  );

  // Clear stale "primary" flag on the source if its old primary just
  // moved out — leaves the source consistent until updateClusterStats
  // (post-commit) re-derives a new primary.
  await client.query(
    `UPDATE duplicate_records
        SET is_primary = false
      WHERE cluster_id = $1
        AND is_primary = true
        AND NOT EXISTS (
          SELECT 1 FROM duplicate_records dr2
           WHERE dr2.cluster_id = $1 AND dr2.is_primary = true
        )`,
    [sourceClusterId],
  );

  return {
    source_cluster_id: sourceClusterId,
    new_cluster_id: newClusterId,
  };
}

/**
 * Convenience single-plan wrapper that opens its own short-lived
 * transaction. Kept for ad-hoc / scripted use; the duplicates route
 * uses the lower-level `splitRecordsIntoNewClusterInTx` to batch
 * multiple plans atomically.
 */
export async function splitRecordsIntoNewCluster(
  sourceClusterId: number,
  recordIds: number[],
  newClusterSeed: {
    company_name: string;
    domain?: string | null;
  },
): Promise<{ source_cluster_id: number; new_cluster_id: number }> {
  const client = await (pool as any).connect();
  let result: { source_cluster_id: number; new_cluster_id: number };
  try {
    await client.query("BEGIN");
    result = await splitRecordsIntoNewClusterInTx(
      client,
      sourceClusterId,
      recordIds,
      newClusterSeed,
    );
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
  // Stats refresh runs OUTSIDE the transaction — idempotent and
  // best-effort; failures here do not invalidate the split itself.
  try {
    await updateClusterStats(sourceClusterId);
    await updateClusterStats(result.new_cluster_id);
  } catch (e) {
    logger.warn("Post-split stats refresh failed (non-fatal)", e as any);
  }
  return result;
}

export async function getClusterSummary(): Promise<{
  totalClusters: number;
  totalDuplicateLeads: number;
  totalDuplicateDeals: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  estimatedPipelineInflation: number;
  activeCount: number;
  resolvedCount: number;
}> {
  const result = await pool.query(`
    SELECT 
      COUNT(*) as total_clusters,
      COALESCE(SUM(total_leads), 0) as total_leads,
      COALESCE(SUM(total_deals), 0) as total_deals,
      COUNT(*) FILTER (WHERE confidence_level = 'high') as high_confidence,
      COUNT(*) FILTER (WHERE confidence_level = 'medium') as medium_confidence,
      COUNT(*) FILTER (WHERE confidence_level = 'low') as low_confidence,
      COALESCE(SUM(estimated_pipeline_value), 0) as pipeline_inflation,
      COUNT(*) FILTER (WHERE status = 'active') as active_count,
      COUNT(*) FILTER (WHERE status = 'resolved') as resolved_count
    FROM duplicate_clusters
  `);

  const row = result.rows[0];
  return {
    totalClusters: parseInt(row.total_clusters) || 0,
    totalDuplicateLeads: parseInt(row.total_leads) || 0,
    totalDuplicateDeals: parseInt(row.total_deals) || 0,
    highConfidence: parseInt(row.high_confidence) || 0,
    mediumConfidence: parseInt(row.medium_confidence) || 0,
    lowConfidence: parseInt(row.low_confidence) || 0,
    estimatedPipelineInflation: parseFloat(row.pipeline_inflation) || 0,
    activeCount: parseInt(row.active_count) || 0,
    resolvedCount: parseInt(row.resolved_count) || 0,
  };
}

export async function getDuplicatesByOwner(): Promise<
  Array<{
    owner_name: string;
    owner_email: string;
    lead_count: number;
    deal_count: number;
    total_duplicates: number;
  }>
> {
  const result = await pool.query(`
    SELECT 
      owner_name,
      owner_email,
      COUNT(*) FILTER (WHERE record_type = 'lead') as lead_count,
      COUNT(*) FILTER (WHERE record_type = 'deal') as deal_count,
      COUNT(*) as total_duplicates
    FROM duplicate_records
    WHERE owner_name IS NOT NULL
    GROUP BY owner_name, owner_email
    ORDER BY total_duplicates DESC
  `);
  return result.rows;
}

export async function getDuplicatesBySource(): Promise<
  Array<{
    source: string;
    lead_count: number;
    deal_count: number;
    total: number;
  }>
> {
  const result = await pool.query(`
    SELECT 
      COALESCE(source, 'Unknown') as source,
      COUNT(*) FILTER (WHERE record_type = 'lead') as lead_count,
      COUNT(*) FILTER (WHERE record_type = 'deal') as deal_count,
      COUNT(*) as total
    FROM duplicate_records
    GROUP BY source
    ORDER BY total DESC
  `);
  return result.rows;
}

export async function updateClusterStatus(
  id: number,
  status: string,
): Promise<DuplicateCluster | null> {
  const result = await pool.query(
    "UPDATE duplicate_clusters SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *",
    [status, id],
  );
  return result.rows[0] || null;
}

export async function createDetectionLog(
  log: Omit<DuplicateDetectionLog, "id" | "created_at">,
): Promise<DuplicateDetectionLog> {
  const result = await pool.query(
    `INSERT INTO duplicate_detection_logs 
     (detection_type, total_records_scanned, total_clusters_found, total_duplicates_detected,
      high_confidence_count, medium_confidence_count, low_confidence_count,
      estimated_pipeline_inflation, detection_duration_ms, triggered_by, user_email, 
      status, error_message, detection_config, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      log.detection_type,
      log.total_records_scanned,
      log.total_clusters_found,
      log.total_duplicates_detected,
      log.high_confidence_count,
      log.medium_confidence_count,
      log.low_confidence_count,
      log.estimated_pipeline_inflation,
      log.detection_duration_ms,
      log.triggered_by,
      log.user_email,
      log.status,
      log.error_message,
      JSON.stringify(log.detection_config || {}),
      log.completed_at,
    ],
  );
  return result.rows[0];
}

export async function updateDetectionLog(
  id: number,
  updates: Partial<DuplicateDetectionLog>,
): Promise<DuplicateDetectionLog | null> {
  const setClauses: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (updates.status !== undefined) {
    setClauses.push(`status = $${paramIndex++}`);
    params.push(updates.status);
  }
  if (updates.total_clusters_found !== undefined) {
    setClauses.push(`total_clusters_found = $${paramIndex++}`);
    params.push(updates.total_clusters_found);
  }
  if (updates.total_duplicates_detected !== undefined) {
    setClauses.push(`total_duplicates_detected = $${paramIndex++}`);
    params.push(updates.total_duplicates_detected);
  }
  if (updates.completed_at !== undefined) {
    setClauses.push(`completed_at = $${paramIndex++}`);
    params.push(updates.completed_at);
  }
  if (updates.detection_duration_ms !== undefined) {
    setClauses.push(`detection_duration_ms = $${paramIndex++}`);
    params.push(updates.detection_duration_ms);
  }
  if (updates.error_message !== undefined) {
    setClauses.push(`error_message = $${paramIndex++}`);
    params.push(updates.error_message);
  }

  if (setClauses.length === 0) return null;

  params.push(id);
  const result = await pool.query(
    `UPDATE duplicate_detection_logs SET ${setClauses.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    params,
  );
  return result.rows[0] || null;
}

export async function getDetectionLogs(
  limit: number = 50,
): Promise<DuplicateDetectionLog[]> {
  const result = await pool.query(
    "SELECT * FROM duplicate_detection_logs ORDER BY created_at DESC LIMIT $1",
    [limit],
  );
  return result.rows;
}

export async function createExportLog(
  log: Omit<DuplicateExportLog, "id" | "created_at">,
): Promise<DuplicateExportLog> {
  const result = await pool.query(
    `INSERT INTO duplicate_export_logs 
     (export_type, filter_criteria, total_records_exported, file_format, exported_by, user_email)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      log.export_type,
      JSON.stringify(log.filter_criteria || {}),
      log.total_records_exported,
      log.file_format,
      log.exported_by,
      log.user_email,
    ],
  );
  return result.rows[0];
}

export async function clearMockData(): Promise<void> {
  await pool.query("DELETE FROM duplicate_records WHERE is_mock_data = true");
  await pool.query(`
    DELETE FROM duplicate_clusters 
    WHERE id NOT IN (SELECT DISTINCT cluster_id FROM duplicate_records WHERE cluster_id IS NOT NULL)
  `);
}

export async function getKPIMetrics(): Promise<{
  duplicateLeadRate: number;
  duplicateDealRate: number;
  domainsWithMultipleDeals: number;
  duplicateBySource: any[];
  duplicateByOwner: any[];
}> {
  const totalLeadsResult = await pool.query(`
    SELECT COUNT(*) as count FROM duplicate_records WHERE record_type = 'lead'
  `);
  const totalDealsResult = await pool.query(`
    SELECT COUNT(*) as count FROM duplicate_records WHERE record_type = 'deal'
  `);
  const duplicateLeadsResult = await pool.query(`
    SELECT COUNT(*) as count FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dr.record_type = 'lead' AND dc.total_leads > 1 AND dr.is_primary = false
      AND dc.status = 'active'
  `);
  const duplicateDealsResult = await pool.query(`
    SELECT COUNT(*) as count FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dr.record_type = 'deal' AND dc.total_deals > 1 AND dr.is_primary = false
      AND dc.status = 'active'
  `);
  const multiDealDomainsResult = await pool.query(`
    SELECT COUNT(*) as count FROM duplicate_clusters WHERE total_deals > 1 AND status = 'active'
  `);

  const totalLeads = parseInt(totalLeadsResult.rows[0].count) || 1;
  const totalDeals = parseInt(totalDealsResult.rows[0].count) || 1;
  const duplicateLeads = parseInt(duplicateLeadsResult.rows[0].count) || 0;
  const duplicateDeals = parseInt(duplicateDealsResult.rows[0].count) || 0;

  return {
    duplicateLeadRate: Math.round((duplicateLeads / totalLeads) * 100),
    duplicateDealRate: Math.round((duplicateDeals / totalDeals) * 100),
    domainsWithMultipleDeals:
      parseInt(multiDealDomainsResult.rows[0].count) || 0,
    duplicateBySource: await getDuplicatesBySource(),
    duplicateByOwner: await getDuplicatesByOwner(),
  };
}

export async function findOrCreateClusterByDomain(
  domain: string,
): Promise<DuplicateCluster> {
  const existing = await pool.query(
    "SELECT * FROM duplicate_clusters WHERE domain = $1",
    [domain],
  );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  return await createCluster({
    domain,
    total_leads: 0,
    total_deals: 0,
    total_contacts: 0,
    total_accounts: 0,
    total_records: 0,
    confidence_level: "medium",
    confidence_score: 75,
    status: "active",
  });
}

export async function updateClusterStats(clusterId: number): Promise<void> {
  const statsResult = await pool.query(
    `
    SELECT 
      COUNT(*) FILTER (WHERE record_type = 'lead') as lead_count,
      COUNT(*) FILTER (WHERE record_type = 'deal') as deal_count,
      COUNT(*) FILTER (WHERE record_type = 'contact') as contact_count,
      COUNT(*) FILTER (WHERE record_type = 'account') as account_count,
      COUNT(*) as total_count,
      COALESCE(SUM(deal_value), 0) as total_value,
      MIN(created_date) as first_date,
      MAX(COALESCE(modified_date, created_date)) as latest_date,
      ARRAY_AGG(DISTINCT owner_name) FILTER (WHERE owner_name IS NOT NULL) as owners
    FROM duplicate_records WHERE cluster_id = $1
  `,
    [clusterId],
  );

  const stats = statsResult.rows[0];
  const totalRecords = parseInt(stats.total_count) || 0;

  const records = await pool.query(
    "SELECT email, domain, phone, phone_normalized, company_name FROM duplicate_records WHERE cluster_id = $1 LIMIT 50",
    [clusterId],
  );

  let bestScore = 0;
  const allSignals = new Set<string>();
  const recs = records.rows;

  if (recs.length > 1) {
    for (let i = 0; i < Math.min(recs.length, 20); i++) {
      for (let j = i + 1; j < Math.min(recs.length, 20); j++) {
        const match = calculateMultiSignalScore(recs[i], recs[j]);
        if (match.score > bestScore) bestScore = match.score;
        match.signals.forEach((s) => allSignals.add(s));
      }
    }
  }

  // A cluster has 2+ records of the same type → classic same-module duplicate
  // (merge candidate). A cluster with multiple records but ≤1 per type is a
  // cross-module overlap (e.g. 1 Lead + 1 Account for the same company) — Zoho
  // does NOT support cross-module merges, so the action is CONVERT (lead →
  // contact under the existing account) or LINK (set Account_Name on the
  // deal/contact). Either way these are real cleanup work and must be surfaced
  // on the Cross-Module tab with a real confidence score, not buried at 0.
  // The Cross-Module Overlaps query (getCrossModuleOverlaps) already accepts
  // any cluster spanning 2+ record types regardless of score, so the only
  // thing the previous `confidenceScore = 0` did was sort these clusters to
  // the bottom and tag them as "legitimate_hierarchy" (a misleading label —
  // they need action, just not via merge).
  const leadCount = parseInt(stats.lead_count) || 0;
  const dealCount = parseInt(stats.deal_count) || 0;
  const contactCount = parseInt(stats.contact_count) || 0;
  const accountCount = parseInt(stats.account_count) || 0;
  const maxOfSameType = Math.max(
    leadCount,
    dealCount,
    contactCount,
    accountCount,
  );
  const isCrossModuleOnly = totalRecords > 1 && maxOfSameType <= 1;

  let confidenceScore: number;
  if (totalRecords <= 1) {
    confidenceScore = 0;
  } else if (bestScore > 0) {
    confidenceScore = bestScore;
  } else {
    confidenceScore = totalRecords > 3 ? 65 : 55;
  }
  if (isCrossModuleOnly) {
    // Tag for the Cross-Module tab + the cluster-detail modal verdict logic.
    // Keep the legacy signal too so any historic dashboard filter still works.
    allSignals.add("cross_module_link_candidate");
    allSignals.add("legitimate_hierarchy");
  }

  const inflationResult = await pool.query(
    `
    SELECT COALESCE(SUM(deal_value), 0) as inflation
    FROM duplicate_records
    WHERE cluster_id = $1 AND record_type = 'deal' AND is_primary = false AND deal_value > 0
  `,
    [clusterId],
  );
  const pipelineInflation = parseFloat(inflationResult.rows[0]?.inflation) || 0;

  const primaryCheck = await pool.query(
    "SELECT COUNT(*) as cnt FROM duplicate_records WHERE cluster_id = $1 AND is_primary = true",
    [clusterId],
  );
  if (parseInt(primaryCheck.rows[0].cnt) === 0 && totalRecords > 0) {
    const earliest = await pool.query(
      "SELECT id FROM duplicate_records WHERE cluster_id = $1 ORDER BY created_date ASC NULLS LAST LIMIT 1",
      [clusterId],
    );
    if (earliest.rows[0]) {
      await pool.query(
        "UPDATE duplicate_records SET is_primary = true WHERE id = $1",
        [earliest.rows[0].id],
      );
    }
  }

  await pool.query(
    `
    UPDATE duplicate_clusters SET
      total_leads = $1,
      total_deals = $2,
      total_contacts = $3,
      total_accounts = $4,
      total_records = $5,
      estimated_pipeline_value = $6,
      first_record_date = $7,
      latest_activity_date = $8,
      owners_involved = $9,
      confidence_score = $10,
      confidence_level = $11,
      match_signals = $12,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $13
  `,
    [
      parseInt(stats.lead_count) || 0,
      parseInt(stats.deal_count) || 0,
      parseInt(stats.contact_count) || 0,
      parseInt(stats.account_count) || 0,
      totalRecords,
      pipelineInflation,
      stats.first_date,
      stats.latest_date,
      JSON.stringify(stats.owners || []),
      confidenceScore,
      confidenceScore === 0 ? "low" : getConfidenceLevel(confidenceScore),
      JSON.stringify(Array.from(allSignals)),
      clusterId,
    ],
  );
}

export interface DuplicateSearchParams {
  domain?: string;
  phone?: string;
  company_name?: string;
  contract_number?: string;
  email?: string;
  record_name?: string;
  owner_email?: string;
}

// A3: Fixed paramIndex bug for company_name
export async function searchDuplicates(params: DuplicateSearchParams): Promise<{
  records: DuplicateRecord[];
  clusters: DuplicateCluster[];
  total_records: number;
  search_params: DuplicateSearchParams;
}> {
  const conditions: string[] = [];
  const queryParams: any[] = [];
  let paramIndex = 1;

  if (params.domain?.trim()) {
    conditions.push(`LOWER(dr.domain) LIKE LOWER($${paramIndex++})`);
    queryParams.push(`%${params.domain.trim()}%`);
  }

  if (params.phone?.trim()) {
    conditions.push(
      `REGEXP_REPLACE(dr.phone, '[^0-9+]', '', 'g') LIKE $${paramIndex++}`,
    );
    queryParams.push(`%${params.phone.trim().replace(/[^0-9+]/g, "")}%`);
  }

  if (params.company_name?.trim()) {
    const pi = paramIndex++;
    conditions.push(
      `(LOWER(dr.company_name) LIKE LOWER($${pi}) OR LOWER(dc.company_name) LIKE LOWER($${pi}))`,
    );
    queryParams.push(`%${params.company_name.trim()}%`);
  }

  if (params.contract_number?.trim()) {
    conditions.push(`dr.zoho_record_id LIKE $${paramIndex++}`);
    queryParams.push(`%${params.contract_number.trim()}%`);
  }

  if (params.email?.trim()) {
    conditions.push(`LOWER(dr.email) LIKE LOWER($${paramIndex++})`);
    queryParams.push(`%${params.email.trim()}%`);
  }

  if (params.record_name?.trim()) {
    conditions.push(`LOWER(dr.record_name) LIKE LOWER($${paramIndex++})`);
    queryParams.push(`%${params.record_name.trim()}%`);
  }

  if (params.owner_email?.trim()) {
    conditions.push(`LOWER(dr.owner_email) LIKE LOWER($${paramIndex++})`);
    queryParams.push(`%${params.owner_email.trim()}%`);
  }

  if (conditions.length === 0) {
    return {
      records: [],
      clusters: [],
      total_records: 0,
      search_params: params,
    };
  }

  const whereClause = conditions.join(" OR ");

  const recordsResult = await pool.query(
    `
    SELECT dr.*, dc.domain as cluster_domain, dc.confidence_level, dc.total_records as cluster_total
    FROM duplicate_records dr
    LEFT JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE ${whereClause}
    ORDER BY dr.confidence_score DESC, dr.created_at DESC
    LIMIT 200
  `,
    queryParams,
  );

  const clusterIds = [
    ...new Set(recordsResult.rows.map((r) => r.cluster_id).filter(Boolean)),
  ];

  let clustersData: DuplicateCluster[] = [];
  if (clusterIds.length > 0) {
    const clustersResult = await pool.query(
      `
      SELECT * FROM duplicate_clusters 
      WHERE id = ANY($1)
      ORDER BY total_records DESC
    `,
      [clusterIds],
    );
    clustersData = clustersResult.rows;
  }

  return {
    records: recordsResult.rows,
    clusters: clustersData,
    total_records: recordsResult.rows.length,
    search_params: params,
  };
}

// A1: Replaced destructive clear with incremental approach
//
// IMPORTANT: in incremental mode we deliberately do NOT call markStaleRecords()
// any more. The previous behaviour was unsafe: an incremental Zoho fetch only
// returns recently-modified records (or the most-recent N), so every untouched
// record would be marked stale and then purged by cleanupStaleRecords() —
// silently corrupting the radar over time. Records that were truly deleted in
// Zoho are now caught by the deletion-detection pass in the scan flow
// (fetchDeletedZohoRecords + removeRecordsByZohoIds).
export async function clearAllDuplicateData(): Promise<void> {
  const scanMode = process.env.DUPLICATE_SCAN_MODE || "incremental";
  if (scanMode === "full") {
    logger.info(
      "🗑️ [DuplicateRadar] FULL mode: Clearing all duplicate data for fresh Zoho import...",
    );
    await pool.query("DELETE FROM duplicate_records");
    await pool.query("DELETE FROM duplicate_clusters");
    logger.info("✅ [DuplicateRadar] All duplicate data cleared");
  } else {
    logger.info(
      "♻️ [DuplicateRadar] INCREMENTAL mode: relying on upserts + Zoho deletion detection (no stale-marking)",
    );
  }
}

// Purge records by their Zoho ID (used when Zoho reports them as deleted/merged).
// Returns the cluster IDs that lost records so the caller can re-score them.
export async function removeRecordsByZohoIds(
  zohoIds: string[],
  opts?: { module?: string },
): Promise<{ removedCount: number; affectedClusterIds: number[] }> {
  if (!zohoIds || zohoIds.length === 0) {
    return { removedCount: 0, affectedClusterIds: [] };
  }
  const params: any[] = [zohoIds];
  let where = "zoho_record_id = ANY($1::text[])";
  if (opts?.module) {
    params.push(opts.module);
    where += ` AND zoho_module = $${params.length}`;
  }
  const affected = await pool.query(
    `SELECT DISTINCT cluster_id FROM duplicate_records WHERE ${where} AND cluster_id IS NOT NULL`,
    params,
  );
  const affectedClusterIds = affected.rows
    .map((r) => r.cluster_id)
    .filter((v): v is number => v != null);
  const del = await pool.query(
    `DELETE FROM duplicate_records WHERE ${where}`,
    params,
  );
  const removedCount = del.rowCount || 0;
  if (removedCount > 0) {
    logger.info(
      `🗑️ [DuplicateRadar] Removed ${removedCount} record(s) deleted/merged in Zoho` +
        (opts?.module ? ` (${opts.module})` : "") +
        ` — ${affectedClusterIds.length} cluster(s) affected`,
    );
  }
  return { removedCount, affectedClusterIds };
}

// A1: Mark records as stale before incremental scan
export async function markStaleRecords(): Promise<number> {
  const result = await pool.query(`
    UPDATE duplicate_records SET match_signals = match_signals || '["stale_pending"]'::jsonb
    WHERE is_mock_data = false AND NOT (match_signals @> '["stale_pending"]'::jsonb)
  `);
  logger.info(`📌 [DuplicateRadar] Marked ${result.rowCount} records as stale`);
  return result.rowCount || 0;
}

// A1: Remove records that were stale and not refreshed
export async function cleanupStaleRecords(): Promise<number> {
  const result = await pool.query(`
    DELETE FROM duplicate_records 
    WHERE match_signals @> '["stale_pending"]'::jsonb AND is_mock_data = false
  `);
  logger.info(
    `🧹 [DuplicateRadar] Cleaned up ${result.rowCount} stale records`,
  );
  return result.rowCount || 0;
}

// A1: Remove orphan clusters with no records
export async function cleanupOrphanClusters(): Promise<number> {
  const result = await pool.query(`
    DELETE FROM duplicate_clusters 
    WHERE id NOT IN (SELECT DISTINCT cluster_id FROM duplicate_records WHERE cluster_id IS NOT NULL)
  `);
  logger.info(
    `🧹 [DuplicateRadar] Cleaned up ${result.rowCount} orphan clusters`,
  );
  return result.rowCount || 0;
}

export function normalizeCompanyName(name: string): string {
  if (!name) return "";
  let n = name
    .toLowerCase()
    .replace(/[^\w\s\u0600-\u06FF]/g, " ")
    .replace(/\s+/g, " ")
    .replace(
      /\b(llc|ltd|inc|corp|corporation|company|group|holdings?|holding|co|sa|ksa|uae|ae)\b/gi,
      " ",
    );

  const arabicBoilerplate = [
    "شركة",
    "الشركة",
    "مؤسسة",
    "المؤسسة",
    "مجموعة",
    "المجموعة",
    "محدودة",
    "المحدودة",
    "القابضة",
    "قابضة",
    "للتجارة",
    "التجارية",
    "التجاري",
    "للمقاولات",
    "المقاولات",
    "للاستثمار",
    "الاستثمارية",
    "للخدمات",
    "الخدمات",
    "العامة",
    "المتحدة",
    "ذ.م.م",
    "ذمم",
    "ش.م.م",
    "شمم",
    "ش.م.ك",
    "شمك",
  ];
  const boilerplateRe = new RegExp(
    "(^|\\s)(" +
      arabicBoilerplate.map((w) => w.replace(/\./g, "\\.")).join("|") +
      ")(?=\\s|$)",
    "g",
  );
  n = n.replace(boilerplateRe, " ");

  return n.replace(/\s+/g, " ").trim();
}

// Free-mail providers we never treat as a "corporate domain" for the
// purpose of the conflict guard below. Mirrors the list already used in
// `src/utils/zohoCRM.ts`. Keep extending this if more providers appear.
const PUBLIC_EMAIL_DOMAINS = new Set<string>([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "aol.com",
  "icloud.com",
  "mail.com",
  "protonmail.com",
  "yandex.com",
  "zoho.com",
]);

function isCorporateDomain(d: string | null | undefined): boolean {
  if (!d) return false;
  const norm = d.toLowerCase().trim();
  if (!norm) return false;
  return !PUBLIC_EMAIL_DOMAINS.has(norm);
}

// Placeholder / sentinel company names that CS users type into Zoho when the
// real company name is unknown. These should never form identity-bearing
// clusters — two unrelated records both named "N/A" are not duplicates of
// each other. Records with these names get routed to a single quarantine
// cluster so CS can fix the names at source rather than seeing the dashboard
// fan them out into bogus "duplicate" groups.
const PLACEHOLDER_COMPANY_NAMES = new Set<string>([
  // English
  "n/a", "na", "n.a", "n.a.",
  "unknown", "tbd", "tba", "pending",
  "test", "testing", "demo",
  "none", "null", "no name",
  "-", "--", "---", "0",
  // Arabic
  "لا يوجد", "لايوجد", "غير معروف", "غير محدد", "تجريبي",
  "لا شيء", "بدون اسم", "اختبار",
]);

const PLACEHOLDER_CLUSTER_DOMAIN = "_placeholder.cluster";

export function isPlaceholderName(
  name: string | null | undefined,
): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  if (trimmed.length === 0) return true;
  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_COMPANY_NAMES.has(lower)) return true;
  if (PLACEHOLDER_COMPANY_NAMES.has(trimmed)) return true;
  return false;
}

/**
 * Returns true if `clusterId` already has at least one record whose
 * corporate domain differs from `candidateDomain`. Used as a guard so
 * that fuzzy / normalized-name matches do not fuse two unrelated
 * companies that happen to share a generic word ("Industrial Services",
 * "Trading", "Group" etc.).
 *
 * Public free-mail domains (gmail/yahoo/…) are ignored on both sides —
 * those cannot prove identity OR difference.
 */
async function clusterHasConflictingDomain(
  clusterId: number,
  candidateDomain: string,
): Promise<boolean> {
  if (!isCorporateDomain(candidateDomain)) return false;
  const candidate = candidateDomain.toLowerCase().trim();
  // Pull both the explicit domain column AND the email so we can derive
  // the corporate part of the email when Company_Domain is empty. Without
  // this, a cluster whose existing records have email-only identity
  // (Zoho Company_Domain blank) returns an empty conflict set and the
  // guard becomes a no-op.
  const res = await pool.query(
    `SELECT LOWER(domain) AS d, email
       FROM duplicate_records
      WHERE cluster_id = $1
        AND (
          (domain IS NOT NULL AND domain <> '')
          OR (email IS NOT NULL AND email <> '')
        )`,
    [clusterId],
  );
  const seen = new Set<string>();
  for (const row of res.rows) {
    const explicit = (row.d || "").trim();
    if (explicit && isCorporateDomain(explicit)) seen.add(explicit);
    const fromEmail = row.email ? extractDomain(row.email) : null;
    if (fromEmail && isCorporateDomain(fromEmail)) seen.add(fromEmail);
  }
  for (const d of seen) {
    if (d !== candidate) return true;
  }
  return false;
}

// B4: Fuzzy match using pg_trgm similarity() with fallback
export async function findOrCreateClusterByCompany(
  companyName: string,
  domain?: string,
  phone?: string,
  email?: string,
): Promise<DuplicateCluster> {
  const normalizedName = normalizeCompanyName(companyName);
  const normalizedPhone = phone ? normalizePhone(phone) : "";

  // Effective identity domain: prefer the explicit Company_Domain field, but
  // fall back to the corporate part of the email address. Without this fallback
  // a record whose Zoho Company_Domain is empty (but whose email is on a real
  // corporate domain) bypasses the conflict guard below and gets fused with
  // any same-named cluster — the root cause of mixed-cluster fan-outs on
  // generic Saudi/Arabic company names.
  const effectiveDomain = domain || (email ? extractDomain(email) : null);

  // Placeholder company names ("N/A", "لا يوجد", "TBD", …) are not identity
  // signals. Two records both named "N/A" are not duplicates of each other.
  // When we hit one, suppress the name-similarity branches entirely so the
  // record only fuses on real identity (domain / email / phone). If those
  // also fail, route the record to a single quarantine cluster instead of
  // creating one synthetic "n-a.cluster" per placeholder string.
  const placeholder = isPlaceholderName(companyName);

  if (domain) {
    const existingByDomain = await pool.query(
      "SELECT * FROM duplicate_clusters WHERE domain = $1",
      [domain],
    );
    if (existingByDomain.rows[0]) {
      // Same domain on the cluster row itself → identity is proven, no
      // need to run the conflict guard.
      return existingByDomain.rows[0];
    }
  }

  if (email) {
    const existingByEmail = await pool.query(
      `SELECT dc.* FROM duplicate_clusters dc
       JOIN duplicate_records dr ON dr.cluster_id = dc.id
       WHERE LOWER(dr.email) = LOWER($1) LIMIT 1`,
      [email],
    );
    if (existingByEmail.rows[0]) {
      return existingByEmail.rows[0];
    }
  }

  if (normalizedPhone && normalizedPhone.length >= 7) {
    const existingByPhone = await pool.query(
      `SELECT dc.* FROM duplicate_clusters dc
       JOIN duplicate_records dr ON dr.cluster_id = dc.id
       WHERE dr.phone_normalized = $1 LIMIT 1`,
      [normalizedPhone],
    );
    if (existingByPhone.rows[0]) {
      return existingByPhone.rows[0];
    }
  }

  // Only use a substring ILIKE shortcut when the normalized name is distinctive
  // enough (>= 5 chars). Short fragments like "شركة" or "ltd" (after partial
  // strips) used to match unrelated rows.
  if (!placeholder && normalizedName && normalizedName.length >= 5) {
    const existingByCompany = await pool.query(
      `SELECT * FROM duplicate_clusters 
       WHERE company_name_normalized = $1`,
      [normalizedName],
    );
    if (existingByCompany.rows[0]) {
      const candidate = existingByCompany.rows[0];
      // Domain conflict guard — calibrated, not absolute. Two unrelated
      // companies sharing a SHORT generic normalized name (e.g. "industrial
      // services", "alkhalij", "saudi group") with different corporate
      // domains are a real false-positive risk and must stay separate.
      // But LONG name matches (≥10 chars normalized) on different corporate
      // domains are far more likely to be a real duplicate where one record
      // has a stale, secondary, or typo'd domain — fuse them and let the
      // reviewer split via the UI if it's actually wrong.
      const domainsConflict =
        !!effectiveDomain &&
        isCorporateDomain(effectiveDomain) &&
        (await clusterHasConflictingDomain(candidate.id, effectiveDomain));
      const nameIsGeneric = normalizedName.length < 10;
      if (domainsConflict && nameIsGeneric) {
        // fall through to fuzzy step / new-cluster creation below
      } else {
        return candidate;
      }
    }
  }

  // B4: Try pg_trgm similarity() first, fallback to limited Levenshtein.
  // Threshold raised to 0.6 — at 0.4, unrelated Arabic LLCs sharing only the
  // boilerplate "شركة ... المحدودة" were being clustered together.
  if (!placeholder && normalizedName && normalizedName.length > 2) {
    try {
      // Pull the top few candidates so the domain guard can skip a bad
      // top hit (e.g. "alsuwaidi industrial services") and still pick a
      // legitimate sibling further down the list.
      const trgmResult = await pool.query(
        `SELECT *, similarity(company_name_normalized, $1) as sim
         FROM duplicate_clusters
         WHERE company_name_normalized IS NOT NULL AND company_name_normalized != ''
           AND similarity(company_name_normalized, $1) >= 0.6
         ORDER BY sim DESC LIMIT 5`,
        [normalizedName],
      );
      for (const candidate of trgmResult.rows) {
        if (!(candidate.sim >= 0.6)) continue;
        // Calibrated domain guard: skip the candidate only when both the
        // name-similarity is borderline (< 0.85) AND the domains conflict.
        // A very high trgm similarity (≥ 0.85) is strong enough evidence
        // to override the domain mismatch — typically a stale / secondary
        // / typo'd domain on one of the records.
        if (
          candidate.sim < 0.85 &&
          effectiveDomain &&
          isCorporateDomain(effectiveDomain) &&
          (await clusterHasConflictingDomain(candidate.id, effectiveDomain))
        ) {
          continue; // try next-best candidate
        }
        return candidate;
      }
    } catch {
      const fallbackLimit = Math.max(
        1,
        Number.parseInt(
          process.env.DUPLICATE_RADAR_FALLBACK_SCAN_LIMIT ?? "2000",
          10,
        ) || 2000,
      );
      const recentClusters = await pool.query(
        "SELECT * FROM duplicate_clusters ORDER BY updated_at DESC LIMIT $1",
        [fallbackLimit],
      );
      for (const cluster of recentClusters.rows) {
        const clusterNormalized = normalizeCompanyName(
          cluster.company_name || "",
        );
        if (
          clusterNormalized &&
          normalizedName &&
          clusterNormalized.length > 2 &&
          normalizedName.length > 2
        ) {
          const similarity = calculateSimilarity(
            clusterNormalized,
            normalizedName,
          );
          if (similarity >= 85) {
            // Calibrated domain guard for the Levenshtein fallback path —
            // matches the trgm path: only skip when name similarity is in
            // the 85–94 borderline band AND domains conflict. ≥95
            // overrides the domain mismatch.
            if (
              similarity < 95 &&
              effectiveDomain &&
              isCorporateDomain(effectiveDomain) &&
              (await clusterHasConflictingDomain(cluster.id, effectiveDomain))
            ) {
              continue;
            }
            return cluster;
          }
        }
      }
    }
  }

  // Placeholder-named record with no real identity → quarantine bucket.
  // Look up the existing quarantine cluster before creating a new one so
  // every subsequent placeholder record fuses there instead of fanning out.
  if (placeholder && !domain) {
    const existing = await pool.query(
      "SELECT * FROM duplicate_clusters WHERE domain = $1 LIMIT 1",
      [PLACEHOLDER_CLUSTER_DOMAIN],
    );
    if (existing.rows[0]) return existing.rows[0];
    return await createCluster({
      domain: PLACEHOLDER_CLUSTER_DOMAIN,
      company_name: "[Placeholder names — needs CS review]",
      total_leads: 0,
      total_deals: 0,
      total_contacts: 0,
      total_accounts: 0,
      total_records: 0,
      confidence_level: "low",
      confidence_score: 0,
      status: "active",
    });
  }

  return await createCluster({
    domain: domain || normalizedName.replace(/\s+/g, "-") + ".cluster",
    company_name: companyName,
    total_leads: 0,
    total_deals: 0,
    total_contacts: 0,
    total_accounts: 0,
    total_records: 0,
    confidence_level: "low",
    confidence_score: 0,
    status: "active",
  });
}

export async function markPrimaryRecord(
  clusterId: number,
  recordId: number,
): Promise<boolean> {
  await pool.query(
    "UPDATE duplicate_records SET is_primary = false WHERE cluster_id = $1",
    [clusterId],
  );
  const result = await pool.query(
    "UPDATE duplicate_records SET is_primary = true WHERE id = $1 AND cluster_id = $2 RETURNING id",
    [recordId, clusterId],
  );
  return result.rows.length > 0;
}

/**
 * R10 — Freeze the current cluster + record state into duplicate_cluster_snapshots
 * so that future audit / dispute / forensic queries can see exactly what the
 * cluster looked like at the moment of an action.
 *
 * Best-effort by design: callers should wrap calls in try/catch but a thrown
 * snapshot error must NOT block the operator's primary action (resolve,
 * split, etc). Returns the new snapshot id on success or null on failure.
 *
 * Trigger labels currently in use:
 *   'pre_resolve' — before resolveCluster mutates status to resolved/ignored
 */
export async function captureClusterSnapshot(
  clusterId: number,
  takenBy: string,
  trigger: string,
  opts: { mergeActionId?: number | null; notes?: string | null } = {},
): Promise<number | null> {
  try {
    const clusterR = await pool.query(
      "SELECT * FROM duplicate_clusters WHERE id = $1",
      [clusterId],
    );
    if (clusterR.rows.length === 0) {
      logger.warn(
        `[duplicate-radar/snapshot] cluster ${clusterId} not found; skipping snapshot`,
      );
      return null;
    }
    const recordsR = await pool.query(
      "SELECT * FROM duplicate_records WHERE cluster_id = $1 ORDER BY is_primary DESC, id ASC",
      [clusterId],
    );
    const result = await pool.query<{ id: number }>(
      `INSERT INTO duplicate_cluster_snapshots
         (cluster_id, taken_by, trigger, merge_action_id,
          record_count, cluster_snapshot, records_snapshot, notes)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
       RETURNING id`,
      [
        clusterId,
        takenBy,
        trigger,
        opts.mergeActionId ?? null,
        recordsR.rows.length,
        JSON.stringify(clusterR.rows[0]),
        JSON.stringify(recordsR.rows),
        opts.notes ?? null,
      ],
    );
    return result.rows[0]?.id ?? null;
  } catch (err) {
    logger.warn(
      `[duplicate-radar/snapshot] failed to capture snapshot for cluster ${clusterId} (trigger=${trigger}): ${(err as Error).message}`,
    );
    return null;
  }
}

export interface ClusterSnapshotSummary {
  id: number;
  cluster_id: number | null;
  snapshot_at: Date;
  taken_by: string | null;
  trigger: string;
  merge_action_id: number | null;
  record_count: number;
  notes: string | null;
}

export interface ClusterSnapshotFull extends ClusterSnapshotSummary {
  cluster_snapshot: any;
  records_snapshot: any[];
}

export async function listClusterSnapshots(
  clusterId: number,
): Promise<ClusterSnapshotSummary[]> {
  const r = await pool.query<ClusterSnapshotSummary>(
    `SELECT id, cluster_id, snapshot_at, taken_by, trigger,
            merge_action_id, record_count, notes
       FROM duplicate_cluster_snapshots
      WHERE cluster_id = $1
      ORDER BY snapshot_at DESC`,
    [clusterId],
  );
  return r.rows;
}

export async function getClusterSnapshot(
  snapshotId: number,
): Promise<ClusterSnapshotFull | null> {
  const r = await pool.query(
    `SELECT id, cluster_id, snapshot_at, taken_by, trigger,
            merge_action_id, record_count, notes,
            cluster_snapshot, records_snapshot
       FROM duplicate_cluster_snapshots
      WHERE id = $1`,
    [snapshotId],
  );
  return (r.rows[0] as ClusterSnapshotFull) ?? null;
}

export async function resolveCluster(
  clusterId: number,
  action: "resolve" | "ignore",
  performedBy: string,
  primaryRecordId?: number,
  notes?: string,
): Promise<MergeAction | null> {
  // R10: freeze the cluster + records BEFORE any mutation, including the
  // markPrimaryRecord call below. If the operator changes the primary as
  // part of this resolve action, the forensic snapshot must reflect the
  // PRE-decision state ("here's what we had before they chose X as
  // primary") not the post-mutation state. Best-effort — a snapshot
  // failure must not block the operator's primary action.
  await captureClusterSnapshot(clusterId, performedBy, "pre_resolve", {
    notes:
      action === "resolve"
        ? "Pre-resolve snapshot taken when operator clicked Mark Resolved"
        : "Pre-ignore snapshot taken when operator clicked Ignore",
  });

  if (primaryRecordId) {
    await markPrimaryRecord(clusterId, primaryRecordId);
  }

  const nonPrimary = await pool.query(
    "SELECT id FROM duplicate_records WHERE cluster_id = $1 AND is_primary = false",
    [clusterId],
  );
  const mergedIds = nonPrimary.rows.map((r) => r.id);

  const result = await pool.query(
    `
    INSERT INTO duplicate_merge_actions (cluster_id, primary_record_id, merged_record_ids, action_type, performed_by, notes)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `,
    [
      clusterId,
      primaryRecordId || null,
      JSON.stringify(mergedIds),
      action,
      performedBy,
      notes || null,
    ],
  );

  const newStatus = action === "resolve" ? "resolved" : "ignored";
  await pool.query(
    "UPDATE duplicate_clusters SET status = $1, resolved_by = $2, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $3",
    [newStatus, performedBy, clusterId],
  );

  return result.rows[0] || null;
}

export async function bulkResolve(
  clusterIds: number[],
  action: "resolve" | "ignore",
  performedBy: string,
): Promise<number> {
  let count = 0;
  for (const id of clusterIds) {
    await resolveCluster(id, action, performedBy);
    count++;
  }
  return count;
}

/**
 * R3 — Post-merge verification.
 *
 * After an operator marks a cluster resolved (asserting they merged the
 * duplicates in Zoho), check whether Zoho actually has the non-primary
 * records gone. We do per-record `searchZohoRecords(module, id:equals:RID)`
 * lookups — returning 0 rows means the record no longer exists in Zoho
 * (it was merged, deleted, or moved).
 *
 * Returns a structured result. The caller decides what to do with it
 * (write back verification_state, flip status, notify operator).
 *
 * Why per-record search and not the /deleted feed: the deleted feed has
 * an indeterminate lag (Zoho documents "up to a few minutes") so it's
 * unreliable in the seconds immediately after a merge. A search-by-id
 * returns 204/empty within the same request as the operator's action.
 *
 * Concurrency: at most 4 records are checked in parallel to stay polite
 * with Zoho's rate limiter. Most clusters have 2–5 records so we don't
 * fan out further.
 */
export interface ClusterVerificationResult {
  verified: boolean;
  confirmed_deleted: number;
  still_present: number;
  errors: number;
  notes: string;
  per_record: Array<{
    record_id: number;
    zoho_record_id: string | null;
    module: string;
    status: "deleted" | "still_present" | "error" | "skipped";
    detail?: string;
  }>;
}

export async function verifyClusterMergedInZoho(
  clusterId: number,
): Promise<ClusterVerificationResult> {
  const { searchZohoRecords } = await import("./zohoCRM");

  const rowsR = await pool.query<{
    id: number;
    zoho_record_id: string | null;
    zoho_module: string | null;
    record_type: string | null;
    is_primary: boolean;
  }>(
    `SELECT id, zoho_record_id, zoho_module, record_type, is_primary
       FROM duplicate_records
      WHERE cluster_id = $1`,
    [clusterId],
  );

  // Only the non-primary records are expected to be gone in Zoho.
  const nonPrimary = rowsR.rows.filter((r) => !r.is_primary);

  if (nonPrimary.length === 0) {
    return {
      verified: true,
      confirmed_deleted: 0,
      still_present: 0,
      errors: 0,
      notes:
        "No non-primary records in this cluster; nothing to verify against Zoho.",
      per_record: [],
    };
  }

  // Map record_type → Zoho module name. Records carry zoho_module directly
  // when ingested via the scanner; fall back to type-based mapping for
  // older rows that don't have it.
  const moduleFor = (
    r: (typeof nonPrimary)[number],
  ): string | null => {
    if (r.zoho_module && r.zoho_module.trim()) return r.zoho_module.trim();
    const t = (r.record_type ?? "").trim().toLowerCase();
    if (t === "lead") return "Leads";
    if (t === "deal") return "Deals";
    if (t === "contact") return "Contacts";
    if (t === "account") return "Accounts";
    return null;
  };

  const concurrency = 4;
  const perRecord: ClusterVerificationResult["per_record"] = [];

  // Run lookups in batches to bound Zoho API pressure.
  for (let i = 0; i < nonPrimary.length; i += concurrency) {
    const batch = nonPrimary.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (r) => {
        if (!r.zoho_record_id) {
          return {
            record_id: r.id,
            zoho_record_id: null,
            module: r.record_type ?? "unknown",
            status: "skipped" as const,
            detail: "Record has no zoho_record_id (synthetic / pre-sync row)",
          };
        }
        const mod = moduleFor(r);
        if (!mod) {
          return {
            record_id: r.id,
            zoho_record_id: r.zoho_record_id,
            module: r.record_type ?? "unknown",
            status: "skipped" as const,
            detail: `Unknown Zoho module for record_type=${r.record_type}`,
          };
        }
        try {
          const found = await searchZohoRecords(
            mod,
            `(id:equals:${r.zoho_record_id})`,
          );
          if (!found || found.length === 0) {
            return {
              record_id: r.id,
              zoho_record_id: r.zoho_record_id,
              module: mod,
              status: "deleted" as const,
            };
          }
          return {
            record_id: r.id,
            zoho_record_id: r.zoho_record_id,
            module: mod,
            status: "still_present" as const,
            detail: `Zoho still has this ${mod.slice(0, -1)} record`,
          };
        } catch (err: any) {
          return {
            record_id: r.id,
            zoho_record_id: r.zoho_record_id,
            module: mod,
            status: "error" as const,
            detail: String(err?.message ?? err),
          };
        }
      }),
    );
    perRecord.push(...results);
  }

  const confirmed = perRecord.filter((p) => p.status === "deleted").length;
  const stillPresent = perRecord.filter(
    (p) => p.status === "still_present",
  ).length;
  const errors = perRecord.filter((p) => p.status === "error").length;
  const skipped = perRecord.filter((p) => p.status === "skipped").length;

  // "Verified" = every non-primary record we could check is gone, AND no
  // errors. Skipped records (no zoho id) don't fail verification but they
  // do mean we couldn't fully confirm.
  const verified = stillPresent === 0 && errors === 0;
  const noteParts: string[] = [];
  if (confirmed > 0) noteParts.push(`${confirmed} confirmed deleted in Zoho`);
  if (stillPresent > 0)
    noteParts.push(`${stillPresent} still present in Zoho`);
  if (errors > 0) noteParts.push(`${errors} lookup error(s)`);
  if (skipped > 0) noteParts.push(`${skipped} skipped (no zoho id)`);
  const notes =
    noteParts.length > 0 ? noteParts.join("; ") : "No records to verify.";

  const newState = verified ? "verified" : "failed";
  await pool.query(
    `UPDATE duplicate_clusters
        SET verification_state = $1,
            verification_at    = CURRENT_TIMESTAMP,
            verification_notes = $2,
            updated_at         = CURRENT_TIMESTAMP
      WHERE id = $3`,
    [newState, notes, clusterId],
  );

  return {
    verified,
    confirmed_deleted: confirmed,
    still_present: stillPresent,
    errors,
    notes,
    per_record: perRecord,
  };
}

export async function getMergeHistory(
  clusterId?: number,
  limit: number = 50,
): Promise<MergeAction[]> {
  let query = "SELECT * FROM duplicate_merge_actions";
  const params: any[] = [];
  if (clusterId) {
    query += " WHERE cluster_id = $1";
    params.push(clusterId);
  }
  query += " ORDER BY created_at DESC LIMIT $" + (params.length + 1);
  params.push(limit);
  const result = await pool.query(query, params);
  return result.rows;
}

// C3: Enhanced owner accountability with RAG status against 2% KPI target.
// dc.status = 'active' is REQUIRED for parity with the packet route — without
// it, owners whose only clusters are archived/dismissed appear in the table
// with a Packet link but get an empty Action Items sheet (Cover still shows
// the stale duplicate counts). See pre-publish review MAJOR-1.
export async function getOwnerAccountability(): Promise<OwnerAccountability[]> {
  const result = await pool.query(`
    SELECT
      dr.owner_name,
      dr.owner_email,
      COUNT(*) as total_records,
      COUNT(*) FILTER (WHERE dc.total_records > 1 AND dr.is_primary = false) as duplicate_records,
      COUNT(DISTINCT dr.cluster_id) FILTER (WHERE dc.total_records > 1) as clusters_involved,
      COUNT(*) FILTER (WHERE dc.total_records > 1 AND dc.confidence_level = 'high' AND dr.is_primary = false) as high_confidence_duplicates,
      COALESCE(SUM(dr.deal_value) FILTER (WHERE dc.total_records > 1 AND dr.is_primary = false AND dr.record_type = 'deal'), 0) as estimated_waste_value
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dr.owner_name IS NOT NULL
      AND dr.owner_name != 'Unknown'
      AND dc.status = 'active'
    GROUP BY dr.owner_name, dr.owner_email
    HAVING COUNT(*) FILTER (WHERE dc.total_records > 1 AND dr.is_primary = false) > 0
    ORDER BY duplicate_records DESC
  `);

  // Resolve owner → team via the SEED_USERS roster so the UI can render a
  // role badge without an extra round-trip. Lazy-imported to avoid pulling
  // the static seed list into modules that don't touch the owner scorecard.
  const { findSeedUser } = await import("../data/seedUsers");

  return result.rows.map((r) => {
    const totalRecs = parseInt(r.total_records) || 0;
    const dupRecs = parseInt(r.duplicate_records) || 0;
    const dupRate = totalRecs > 0 ? Math.round((dupRecs / totalRecs) * 100) : 0;
    let ragStatus: "green" | "amber" | "red" = "green";
    if (dupRate > 5) ragStatus = "red";
    else if (dupRate > 2) ragStatus = "amber";

    const seed = findSeedUser(r.owner_name);
    const team = (seed && seed.team) || "Unassigned";

    return {
      owner_name: r.owner_name,
      owner_email: r.owner_email || "",
      team,
      total_records: totalRecs,
      duplicate_records: dupRecs,
      duplicate_rate: dupRate,
      clusters_involved: parseInt(r.clusters_involved) || 0,
      high_confidence_duplicates: parseInt(r.high_confidence_duplicates) || 0,
      estimated_waste_value: parseFloat(r.estimated_waste_value) || 0,
      rag_status: ragStatus,
    };
  });
}

export async function checkForDuplicates(params: {
  email?: string;
  phone?: string;
  company_name?: string;
}): Promise<{
  is_duplicate: boolean;
  confidence: number;
  signals: string[];
  matching_clusters: DuplicateCluster[];
  matching_records: DuplicateRecord[];
}> {
  const domain = params.email ? extractDomain(params.email) : null;
  const normalizedPhone = params.phone ? normalizePhone(params.phone) : "";
  const conditions: string[] = [];
  const queryParams: any[] = [];
  let idx = 1;

  if (params.email) {
    conditions.push(`LOWER(dr.email) = LOWER($${idx++})`);
    queryParams.push(params.email);
  }
  if (domain) {
    conditions.push(`dr.domain = $${idx++}`);
    queryParams.push(domain);
  }
  if (normalizedPhone && normalizedPhone.length >= 7) {
    conditions.push(`dr.phone_normalized = $${idx++}`);
    queryParams.push(normalizedPhone);
  }
  if (params.company_name) {
    conditions.push(`LOWER(dr.company_name) ILIKE LOWER($${idx++})`);
    queryParams.push(`%${params.company_name}%`);
  }

  if (conditions.length === 0) {
    return {
      is_duplicate: false,
      confidence: 0,
      signals: [],
      matching_clusters: [],
      matching_records: [],
    };
  }

  const result = await pool.query(
    `
    SELECT dr.*, dc.confidence_level, dc.confidence_score as cluster_confidence, dc.total_records as cluster_total
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dc.status = 'active' AND (${conditions.join(" OR ")})
    ORDER BY dr.confidence_score DESC
    LIMIT 20
  `,
    queryParams,
  );

  if (result.rows.length === 0) {
    return {
      is_duplicate: false,
      confidence: 0,
      signals: [],
      matching_clusters: [],
      matching_records: [],
    };
  }

  const matchSignals: string[] = [];
  let bestScore = 0;
  for (const row of result.rows) {
    const match = calculateMultiSignalScore(
      {
        email: params.email,
        domain: domain || undefined,
        phone: params.phone,
        company_name: params.company_name,
      },
      {
        email: row.email,
        domain: row.domain,
        phone: row.phone,
        company_name: row.company_name,
      },
    );
    if (match.score > bestScore) bestScore = match.score;
    match.signals.forEach((s) => {
      if (!matchSignals.includes(s)) matchSignals.push(s);
    });
  }

  const clusterIds = [...new Set(result.rows.map((r) => r.cluster_id))];
  const clustersResult = await pool.query(
    "SELECT * FROM duplicate_clusters WHERE id = ANY($1)",
    [clusterIds],
  );

  return {
    is_duplicate: bestScore >= 50,
    confidence: bestScore,
    signals: matchSignals,
    matching_clusters: clustersResult.rows,
    matching_records: result.rows,
  };
}

// A2: Fixed low_confidence count — only clusters with total_records > 1, added singletonCount
/**
 * R4 — Duplicate creation-rate trend.
 *
 * Industry-standard leading indicator: count NEW DUPLICATE records created
 * per bucket (week or day) — "are bad-data inputs still flowing into Zoho
 * at the same rate, or is prevention work moving the needle?" Stakeholders
 * care about the slope, not the absolute count.
 *
 * Definition of "new duplicate":
 *   - A record (lead / deal / contact / account) whose created_date falls
 *     in the bucket AND whose cluster has total_records > 1 (so the record
 *     is actually a duplicate, not a singleton).
 *   - Both primary AND non-primary records count — both are "new records
 *     that ended up in a duplicate cluster", which is the input rate we
 *     want to track regardless of which one survives the merge.
 *
 * Also returns the per-bucket TOTAL record creation count so the UI can
 * render a duplicate-rate ratio (new_duplicates / new_records) — the
 * percentage that is the headline number for prevention effectiveness.
 *
 * Bucket size: 'week' (default) uses DATE_TRUNC('week', …) which Postgres
 * anchors on Monday. 'day' uses DATE_TRUNC('day', …). Anything else falls
 * back to 'week' silently.
 *
 * `weeks` caps the window. Default 12 weeks. Clamped to [1, 52] to keep
 * the query bounded.
 */
export interface DuplicateCreationTrendBucket {
  bucket_start: string; // ISO date 'YYYY-MM-DD'
  new_records: number;
  new_duplicates: number;
  duplicate_rate_pct: number; // 0-100, rounded to 1 decimal
}

export async function getDuplicateCreationTrend(opts: {
  weeks?: number;
  granularity?: "week" | "day";
} = {}): Promise<{
  granularity: "week" | "day";
  window_weeks: number;
  buckets: DuplicateCreationTrendBucket[];
}> {
  const weeks = Math.min(
    52,
    Math.max(1, Math.floor(Number(opts.weeks ?? 12) || 12)),
  );
  const granularity: "week" | "day" =
    opts.granularity === "day" ? "day" : "week";
  const trunc = granularity === "day" ? "day" : "week";

  // Single query with FILTER for the duplicate subset. DATE_TRUNC handles
  // the bucketing in Postgres so the result set is tiny (≤ 52 rows).
  const sql = `
    SELECT
      TO_CHAR(DATE_TRUNC('${trunc}', dr.created_date)::date, 'YYYY-MM-DD') AS bucket_start,
      COUNT(*)::int AS new_records,
      COUNT(*) FILTER (WHERE dc.total_records > 1)::int AS new_duplicates
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dr.created_date >= NOW() - INTERVAL '${weeks} weeks'
      AND dr.created_date <= NOW()
    GROUP BY DATE_TRUNC('${trunc}', dr.created_date)
    ORDER BY bucket_start ASC
  `;
  const r = await pool.query<{
    bucket_start: string;
    new_records: number;
    new_duplicates: number;
  }>(sql);

  const buckets: DuplicateCreationTrendBucket[] = r.rows.map((row) => {
    const total = Number(row.new_records ?? 0);
    const dup = Number(row.new_duplicates ?? 0);
    const ratePct =
      total > 0 ? Math.round((dup / total) * 1000) / 10 : 0;
    return {
      bucket_start: row.bucket_start,
      new_records: total,
      new_duplicates: dup,
      duplicate_rate_pct: ratePct,
    };
  });

  return { granularity, window_weeks: weeks, buckets };
}

export async function getEnhancedSummary(): Promise<{
  totalClusters: number;
  trueDuplicateClusters: number;
  singletonCount: number;
  totalRecords: number;
  totalDuplicateLeads: number;
  totalDuplicateDeals: number;
  totalDuplicateContacts: number;
  totalDuplicateAccounts: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  estimatedPipelineInflation: number;
  activeCount: number;
  resolvedCount: number;
  ignoredCount: number;
  resolutionRate: number;
  topSignals: Record<string, number>;
  duplicateLeadRate: number;
  duplicateDealRate: number;
  topClustersByInflation: any[];
  lastScanInfo: any;
}> {
  const result = await pool.query(`
    SELECT 
      COUNT(*) as total_clusters,
      COUNT(*) FILTER (WHERE GREATEST(COALESCE(total_leads,0), COALESCE(total_deals,0), COALESCE(total_contacts,0), COALESCE(total_accounts,0)) > 1) as true_dup_clusters,
      COUNT(*) FILTER (WHERE total_records <= 1) as singleton_count,
      COALESCE(SUM(total_records), 0) as total_records,
      COALESCE(SUM(total_leads) FILTER (WHERE total_leads > 1), 0) as dup_leads,
      COALESCE(SUM(total_deals) FILTER (WHERE total_deals > 1), 0) as dup_deals,
      COALESCE(SUM(total_contacts) FILTER (WHERE total_contacts > 1), 0) as dup_contacts,
      COALESCE(SUM(total_accounts) FILTER (WHERE total_accounts > 1), 0) as dup_accounts,
      COUNT(*) FILTER (WHERE confidence_level = 'high' AND GREATEST(COALESCE(total_leads,0), COALESCE(total_deals,0), COALESCE(total_contacts,0), COALESCE(total_accounts,0)) > 1) as high_confidence,
      COUNT(*) FILTER (WHERE confidence_level = 'medium' AND GREATEST(COALESCE(total_leads,0), COALESCE(total_deals,0), COALESCE(total_contacts,0), COALESCE(total_accounts,0)) > 1) as medium_confidence,
      COUNT(*) FILTER (WHERE confidence_level = 'low' AND GREATEST(COALESCE(total_leads,0), COALESCE(total_deals,0), COALESCE(total_contacts,0), COALESCE(total_accounts,0)) > 1) as low_confidence,
      COALESCE(SUM(estimated_pipeline_value), 0) as pipeline_inflation,
      COUNT(*) FILTER (WHERE status = 'active') as active_count,
      COUNT(*) FILTER (WHERE status = 'resolved') as resolved_count,
      COUNT(*) FILTER (WHERE status = 'ignored') as ignored_count
    FROM duplicate_clusters
  `);

  const row = result.rows[0];
  const totalLeads = await pool.query(
    "SELECT COUNT(*) as cnt FROM duplicate_records WHERE record_type = 'lead'",
  );
  const totalDeals = await pool.query(
    "SELECT COUNT(*) as cnt FROM duplicate_records WHERE record_type = 'deal'",
  );
  const tLeads = parseInt(totalLeads.rows[0]?.cnt) || 1;
  const tDeals = parseInt(totalDeals.rows[0]?.cnt) || 1;
  const dupLeads = parseInt(row.dup_leads) || 0;
  const dupDeals = parseInt(row.dup_deals) || 0;

  const signalResult = await pool.query(`
    SELECT match_signals FROM duplicate_clusters
    WHERE total_records > 1 AND match_signals IS NOT NULL AND status = 'active'
  `);
  const topSignals: Record<string, number> = {};
  for (const r of signalResult.rows) {
    const signals = Array.isArray(r.match_signals) ? r.match_signals : [];
    for (const s of signals) {
      if (s !== "stale_pending") topSignals[s] = (topSignals[s] || 0) + 1;
    }
  }

  // D4: Top 5 clusters by pipeline inflation (active only — excludes resolved/ignored false positives)
  const topClustersResult = await pool.query(`
    SELECT id, domain, company_name, estimated_pipeline_value, total_records, confidence_score
    FROM duplicate_clusters
    WHERE estimated_pipeline_value > 0 AND total_records > 1 AND status = 'active'
    ORDER BY estimated_pipeline_value DESC
    LIMIT 5
  `);

  // D4: Last scan info
  const lastScanResult = await pool.query(`
    SELECT completed_at, detection_duration_ms, total_records_scanned, total_clusters_found, total_duplicates_detected
    FROM duplicate_detection_logs WHERE status = 'completed'
    ORDER BY completed_at DESC LIMIT 1
  `);

  const totalClusters = parseInt(row.total_clusters) || 0;
  const resolvedCount = parseInt(row.resolved_count) || 0;
  const ignoredCount = parseInt(row.ignored_count) || 0;
  const resolutionRate =
    totalClusters > 0
      ? Math.round(((resolvedCount + ignoredCount) / totalClusters) * 100)
      : 0;

  return {
    totalClusters,
    trueDuplicateClusters: parseInt(row.true_dup_clusters) || 0,
    singletonCount: parseInt(row.singleton_count) || 0,
    totalRecords: parseInt(row.total_records) || 0,
    totalDuplicateLeads: dupLeads,
    totalDuplicateDeals: dupDeals,
    totalDuplicateContacts: parseInt(row.dup_contacts) || 0,
    totalDuplicateAccounts: parseInt(row.dup_accounts) || 0,
    highConfidence: parseInt(row.high_confidence) || 0,
    mediumConfidence: parseInt(row.medium_confidence) || 0,
    lowConfidence: parseInt(row.low_confidence) || 0,
    estimatedPipelineInflation: parseFloat(row.pipeline_inflation) || 0,
    activeCount: parseInt(row.active_count) || 0,
    resolvedCount,
    ignoredCount,
    resolutionRate,
    topSignals,
    duplicateLeadRate: Math.round((dupLeads / tLeads) * 100),
    duplicateDealRate: Math.round((dupDeals / tDeals) * 100),
    topClustersByInflation: topClustersResult.rows,
    lastScanInfo: lastScanResult.rows[0] || null,
  };
}

export async function getLastScanDate(): Promise<Date | null> {
  const result = await pool.query(
    "SELECT completed_at FROM duplicate_detection_logs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1",
  );
  return result.rows[0]?.completed_at || null;
}

// B5: JOIN-based queries eliminating N+1 pattern
export async function getDuplicateRecordsByType(
  recordType: string,
  options?: {
    limit?: number;
    offset?: number;
    start_date?: string;
    end_date?: string;
    owners?: string[];
    layouts?: string[];
    pipelines?: string[];
    stages?: string[];
    confidence_level?: string;
    domain?: string;
  },
): Promise<{ groups: any[]; total: number }> {
  const countField =
    recordType === "lead"
      ? "total_leads"
      : recordType === "deal"
        ? "total_deals"
        : recordType === "contact"
          ? "total_contacts"
          : "total_accounts";

  // Date AND advanced-filter clauses constraining which records (and
  // therefore which clusters) are in scope. Placeholders start at $2 so the
  // fragment can be reused inside the EXISTS sub-queries below ($1 =
  // recordType). dc is the correlated outer cluster alias in those
  // sub-queries, so cluster-level predicates (confidence_level) are valid here.
  let dateFilter = "";
  const dateParams: any[] = [];
  if (options?.start_date) {
    dateFilter += ` AND dr.created_date >= $${dateParams.length + 2}`;
    dateParams.push(options.start_date);
  }
  if (options?.end_date) {
    dateFilter += ` AND dr.created_date <= $${dateParams.length + 2}`;
    dateParams.push(options.end_date + "T23:59:59Z");
  }
  if (options?.owners && options.owners.length > 0) {
    dateFilter += ` AND dr.owner_name = ANY($${dateParams.length + 2}::text[])`;
    dateParams.push(options.owners);
  }
  if (options?.layouts && options.layouts.length > 0) {
    dateFilter += ` AND dr.layout_name = ANY($${dateParams.length + 2}::text[])`;
    dateParams.push(options.layouts);
  }
  if (options?.pipelines && options.pipelines.length > 0) {
    dateFilter += ` AND dr.pipeline = ANY($${dateParams.length + 2}::text[])`;
    dateParams.push(options.pipelines);
  }
  if (options?.stages && options.stages.length > 0) {
    dateFilter += ` AND dr.stage = ANY($${dateParams.length + 2}::text[])`;
    dateParams.push(options.stages);
  }
  if (options?.confidence_level) {
    dateFilter += ` AND dc.confidence_level = $${dateParams.length + 2}`;
    dateParams.push(options.confidence_level);
  }
  if (options?.domain) {
    dateFilter += ` AND dr.domain ILIKE $${dateParams.length + 2}`;
    dateParams.push(`%${options.domain}%`);
  }

  const limit = options?.limit || 50;
  const offset = options?.offset || 0;

  // ── Paginate by CLUSTER, not by record. ────────────────────────────────
  //
  // This view groups records into duplicate clusters, so the unit of
  // pagination must be the cluster. The previous implementation applied
  // LIMIT/OFFSET to individual `duplicate_records` rows while computing the
  // page count from the DISTINCT cluster total. Because every duplicate
  // cluster holds >=2 records, there were always more record-pages than the
  // reported cluster-page count, so the low-confidence tail of clusters was
  // unreachable and any cluster whose records straddled a page boundary was
  // split into partial groups. We instead select the page of cluster ids
  // first, then fetch ALL in-scope records for exactly those clusters.
  const clusterPage = await pool.query(
    `
    SELECT dc.id
    FROM duplicate_clusters dc
    WHERE dc.${countField} > 1 AND dc.status = 'active'
      AND EXISTS (
        SELECT 1 FROM duplicate_records dr
        WHERE dr.cluster_id = dc.id AND dr.record_type = $1${dateFilter}
      )
    ORDER BY dc.confidence_score DESC, dc.id ASC
    LIMIT $${dateParams.length + 2} OFFSET $${dateParams.length + 3}
  `,
    [recordType, ...dateParams, limit, offset],
  );

  const clusterIds = clusterPage.rows.map((r) => r.id);

  const countResult = await pool.query(
    `
    SELECT COUNT(*) as total
    FROM duplicate_clusters dc
    WHERE dc.${countField} > 1 AND dc.status = 'active'
      AND EXISTS (
        SELECT 1 FROM duplicate_records dr
        WHERE dr.cluster_id = dc.id AND dr.record_type = $1${dateFilter}
      )
  `,
    [recordType, ...dateParams],
  );

  if (clusterIds.length === 0) {
    return { groups: [], total: parseInt(countResult.rows[0]?.total) || 0 };
  }

  // Records filter re-anchored to $3 ($1=recordType, $2=clusterIds). Mirrors
  // the cluster-scoping fragment above so only records matching the active
  // advanced filters are returned within each in-scope cluster. dc is JOINed
  // in the records query, so confidence_level is valid here too.
  let recDateFilter = "";
  const recDateParams: any[] = [];
  if (options?.start_date) {
    recDateFilter += ` AND dr.created_date >= $${recDateParams.length + 3}`;
    recDateParams.push(options.start_date);
  }
  if (options?.end_date) {
    recDateFilter += ` AND dr.created_date <= $${recDateParams.length + 3}`;
    recDateParams.push(options.end_date + "T23:59:59Z");
  }
  if (options?.owners && options.owners.length > 0) {
    recDateFilter += ` AND dr.owner_name = ANY($${recDateParams.length + 3}::text[])`;
    recDateParams.push(options.owners);
  }
  if (options?.layouts && options.layouts.length > 0) {
    recDateFilter += ` AND dr.layout_name = ANY($${recDateParams.length + 3}::text[])`;
    recDateParams.push(options.layouts);
  }
  if (options?.pipelines && options.pipelines.length > 0) {
    recDateFilter += ` AND dr.pipeline = ANY($${recDateParams.length + 3}::text[])`;
    recDateParams.push(options.pipelines);
  }
  if (options?.stages && options.stages.length > 0) {
    recDateFilter += ` AND dr.stage = ANY($${recDateParams.length + 3}::text[])`;
    recDateParams.push(options.stages);
  }
  if (options?.confidence_level) {
    recDateFilter += ` AND dc.confidence_level = $${recDateParams.length + 3}`;
    recDateParams.push(options.confidence_level);
  }
  if (options?.domain) {
    recDateFilter += ` AND dr.domain ILIKE $${recDateParams.length + 3}`;
    recDateParams.push(`%${options.domain}%`);
  }

  const result = await pool.query(
    `
    SELECT dr.*, dc.domain as cluster_domain, dc.company_name as cluster_company,
           dc.confidence_level, dc.confidence_score as cluster_confidence,
           dc.total_records as cluster_total, dc.estimated_pipeline_value,
           dc.id as cluster_id_ref
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dr.record_type = $1 AND dr.cluster_id = ANY($2::int[])${recDateFilter}
    ORDER BY dc.confidence_score DESC, dc.id ASC, dr.is_primary DESC, dr.created_date ASC
  `,
    [recordType, clusterIds, ...recDateParams],
  );

  const grouped: Record<number, any> = {};
  for (const row of result.rows) {
    const cid = row.cluster_id;
    if (!grouped[cid]) {
      grouped[cid] = {
        cluster: {
          id: cid,
          domain: row.cluster_domain,
          company_name: row.cluster_company,
          confidence_level: row.confidence_level,
          confidence_score: row.cluster_confidence,
          total_records: row.cluster_total,
          estimated_pipeline_value: row.estimated_pipeline_value,
        },
        [recordType + "s"]: [],
        duplicate_count: 0,
      };
    }
    grouped[cid][recordType + "s"].push(row);
    grouped[cid].duplicate_count++;
  }

  return {
    groups: Object.values(grouped),
    total: parseInt(countResult.rows[0]?.total) || 0,
  };
}

// B5: JOIN-based export eliminating N+1
export async function getExportRecords(filters?: {
  owner?: string;
  start_date?: string;
  end_date?: string;
  status?: string;
}): Promise<any[]> {
  let whereClause = "WHERE 1=1";
  const params: any[] = [];
  let pi = 1;

  if (filters?.status) {
    whereClause += ` AND dc.status = $${pi++}`;
    params.push(filters.status);
  } else {
    whereClause += ` AND dc.status = 'active'`;
  }
  if (filters?.owner) {
    whereClause += ` AND (dr.owner_name = $${pi++} OR dr.owner_email = $${pi - 1})`;
    params.push(filters.owner);
  }
  if (filters?.start_date) {
    whereClause += ` AND dr.created_date >= $${pi++}`;
    params.push(filters.start_date);
  }
  if (filters?.end_date) {
    whereClause += ` AND dr.created_date <= $${pi++}`;
    params.push(filters.end_date + "T23:59:59Z");
  }

  const result = await pool.query(
    `
    SELECT dr.*, dc.domain as cluster_domain, dc.confidence_level as cluster_confidence
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    ${whereClause}
    ORDER BY dc.total_records DESC, dr.cluster_id, dr.is_primary DESC
  `,
    params,
  );

  return result.rows;
}

// C5: Auto-resolution engine
export async function autoResolveClusters(): Promise<{
  singletonsIgnored: number;
  highConfidenceResolved: number;
  totalProcessed: number;
}> {
  let singletonsIgnored = 0;
  let highConfidenceResolved = 0;

  const singletons = await pool.query(`
    SELECT id FROM duplicate_clusters WHERE total_records <= 1 AND status = 'active'
  `);
  for (const row of singletons.rows) {
    await pool.query(
      "UPDATE duplicate_clusters SET status = 'ignored', resolved_by = 'auto-resolve', resolved_at = CURRENT_TIMESTAMP WHERE id = $1",
      [row.id],
    );
    singletonsIgnored++;
  }

  const highConf = await pool.query(`
    SELECT id FROM duplicate_clusters WHERE confidence_score >= 95 AND status = 'active' AND total_records > 1
  `);
  for (const row of highConf.rows) {
    const primary = await pool.query(
      "SELECT id FROM duplicate_records WHERE cluster_id = $1 AND is_primary = true LIMIT 1",
      [row.id],
    );
    if (primary.rows[0]) {
      await resolveCluster(
        row.id,
        "resolve",
        "auto-resolve",
        primary.rows[0].id,
        "Auto-resolved: confidence >= 95% with clear primary",
      );
      highConfidenceResolved++;
    }
  }

  return {
    singletonsIgnored,
    highConfidenceResolved,
    totalProcessed: singletonsIgnored + highConfidenceResolved,
  };
}

// C7: Smart AI recommendations considering completeness, deals, recency
// Zoho-correct recommendation engine.
//
// Zoho does NOT support cross-module merges (you cannot merge a Contact into an
// Account). The right action depends on the relationship between the record
// types in the cluster, not just on which one looks "best":
//
//   • same module as primary  → MERGE (native Zoho merge inside the module)
//   • Contact/Deal under an Account primary → LINK (set Account_Name field)
//   • Deal under a Contact primary          → LINK (set Contact_Name field)
//   • Lead when a real Account/Contact/Deal already exists → CLOSE/convert
//   • anything else (e.g. Deal vs Contact with no Account) → REVIEW manually
//
// Primary selection priority is by record type first
// (Account > Contact > Deal > Lead > Task), with quality-score breaking ties.
export type DuplicateActionType =
  | "keep"
  | "merge"
  | "link"
  | "close"
  | "review";

export interface SmartRecommendation {
  record_id: number;
  record_name: string;
  is_primary: boolean;
  recommendation: string;
  action_type: DuplicateActionType;
  confidence: number;
  reasons: string[];
}

const RECORD_TYPE_PRIORITY: Record<string, number> = {
  account: 5,
  contact: 4,
  deal: 3,
  lead: 2,
  task: 1,
};

export function generateSmartRecommendations(
  records: DuplicateRecord[],
): SmartRecommendation[] {
  if (records.length === 0) return [];

  const scored = records.map((r) => {
    let score = 0;
    const reasons: string[] = [];

    const fields = [
      r.email,
      r.phone,
      r.company_name,
      r.owner_name,
      r.source,
    ].filter(Boolean);
    const completeness = Math.round((fields.length / 5) * 100);
    score += completeness;
    if (completeness >= 80) reasons.push("High data completeness");

    if (r.record_type === "deal" && r.deal_value && r.deal_value > 0) {
      score += 30;
      reasons.push("Has active deal value");
    }

    if (r.modified_date) {
      const daysSinceModified =
        (Date.now() - new Date(r.modified_date).getTime()) /
        (1000 * 60 * 60 * 24);
      if (daysSinceModified < 30) {
        score += 20;
        reasons.push("Recently modified");
      } else if (daysSinceModified < 90) {
        score += 10;
        reasons.push("Modified in last 90 days");
      }
    }

    if (r.created_date) {
      const ageInDays =
        (Date.now() - new Date(r.created_date).getTime()) /
        (1000 * 60 * 60 * 24);
      if (ageInDays > 180) {
        score += 5;
        reasons.push("Established record (6mo+)");
      }
    }

    if (
      r.stage &&
      ["Closed Won", "Negotiation", "Proposal"].includes(r.stage)
    ) {
      score += 15;
      reasons.push(`Active deal stage: ${r.stage}`);
    }

    return { record: r, score, reasons };
  });

  // Pick primary by Zoho-module priority first, then by quality score.
  // Account beats Contact beats Deal beats Lead beats Task.
  scored.sort((a, b) => {
    const pa = RECORD_TYPE_PRIORITY[a.record.record_type] || 0;
    const pb = RECORD_TYPE_PRIORITY[b.record.record_type] || 0;
    if (pa !== pb) return pb - pa;
    return b.score - a.score;
  });

  const primary = scored[0].record;
  const primaryType = primary.record_type;
  const primaryScore = scored[0].score;
  const hasAccount = scored.some((s) => s.record.record_type === "account");
  const hasContact = scored.some((s) => s.record.record_type === "contact");
  const hasDeal = scored.some((s) => s.record.record_type === "deal");

  return scored.map((item, index) => {
    if (index === 0) {
      return {
        record_id: item.record.id!,
        record_name: item.record.record_name,
        is_primary: true,
        recommendation: `KEEP as primary ${primaryType} (best Zoho-priority + quality score)`,
        action_type: "keep" as const,
        confidence: 95,
        reasons: item.reasons,
      };
    }

    const t = item.record.record_type;
    let action: DuplicateActionType;
    let recommendation: string;

    if (t === primaryType) {
      action = "merge";
      recommendation = `MERGE into primary ${primaryType} (native Zoho merge — same module)`;
    } else if (
      primaryType === "account" &&
      ((t as string) === "contact" ||
        (t as string) === "deal" ||
        (t as string) === "task")
    ) {
      action = "link";
      const field =
        (t as string) === "contact" || (t as string) === "deal"
          ? "Account_Name"
          : "What_Id";
      recommendation = `LINK to primary account by setting ${field} on this ${t} (cross-module — do NOT merge)`;
    } else if (
      primaryType === "contact" &&
      ((t as string) === "deal" || (t as string) === "task")
    ) {
      action = "link";
      const field = t === "deal" ? "Contact_Name" : "Who_Id";
      recommendation = `LINK to primary contact by setting ${field} on this ${t} (cross-module — do NOT merge)`;
    } else if (t === "lead" && (hasAccount || hasContact || hasDeal)) {
      action = "close";
      recommendation =
        "CLOSE — a converted Account/Contact/Deal already exists for this company";
    } else {
      action = "review";
      recommendation = `REVIEW manually — cross-module pairing (${primaryType} ↔ ${t}) has no automatic Zoho action`;
    }

    return {
      record_id: item.record.id!,
      record_name: item.record.record_name,
      is_primary: false,
      recommendation,
      action_type: action,
      confidence: Math.min(95, 60 + Math.max(0, primaryScore - item.score)),
      reasons: item.reasons,
    };
  });
}

// Convenience: derive cluster-level metadata from a set of records, used by
// the cluster API responses so the UI can render cross-module banners and
// pick the right Resolve button label.
export function getClusterRecordTypeMeta(records: DuplicateRecord[]): {
  primary_type: string | null;
  is_cross_module: boolean;
  record_types: string[];
} {
  if (!records || records.length === 0) {
    return { primary_type: null, is_cross_module: false, record_types: [] };
  }
  const types = Array.from(
    new Set(records.map((r) => r.record_type).filter(Boolean)),
  );
  const sorted = [...records].sort(
    (a, b) =>
      (RECORD_TYPE_PRIORITY[b.record_type] || 0) -
      (RECORD_TYPE_PRIORITY[a.record_type] || 0),
  );
  return {
    primary_type: sorted[0].record_type,
    is_cross_module: types.length > 1,
    record_types: types,
  };
}

/**
 * R6 — Classify a cross-module cluster by which pair of record types
 * co-exist. Pure helper, exported for vitest.
 *
 * Industry context: a Lead at `acme.com` representing the same person /
 * company as a Contact under the existing ACME Account is the most common
 * cross-module duplicate. The fix is NOT "merge" (Zoho doesn't support
 * cross-module merges) — it's CONVERT (the Lead becomes the Contact) or
 * LINK (set Account_Name on the deal/contact). The generateSmartRecommendations
 * helper already emits the right per-record action; this classifier groups
 * clusters by pairing type so the Cross-Module tab can filter / KPI them.
 *
 * Returns one of:
 *   lead_contact   — Lead + Contact (most common — convert lead to contact)
 *   lead_account   — Lead + Account (close the lead, link to account)
 *   lead_deal      — Lead + Deal (close the lead, deal is canonical)
 *   contact_account — Contact + Account (link Contact's Account_Name)
 *   contact_deal   — Contact + Deal (link Deal's Contact_Name)
 *   deal_account   — Deal + Account (link Deal's Account_Name)
 *   mixed          — 3 or more distinct record types (compound case)
 *   null           — same-module / not actually cross-module
 *
 * Two-module pairings use an explicit canonical ordering (Lead first, then
 * Contact, then Deal, then Account) so the same pair always maps to the
 * same key. Lead-first ordering follows operational priority: Leads are
 * net-new pipeline that need disposition, so a "Lead + something" pair is
 * always read as "what do we do with the Lead?".
 */
export type CrossModulePairing =
  | "lead_contact"
  | "lead_account"
  | "lead_deal"
  | "contact_account"
  | "contact_deal"
  | "deal_account"
  | "mixed";

// Explicit lookup: hasLead × hasContact × hasAccount × hasDeal → key.
// Keeps the type union in lock-step with what the classifier returns.
const CROSS_MODULE_PAIRING_LOOKUP: Record<string, CrossModulePairing> = {
  "lead+contact": "lead_contact",
  "lead+account": "lead_account",
  "lead+deal": "lead_deal",
  "contact+account": "contact_account",
  "contact+deal": "contact_deal",
  "deal+account": "deal_account",
};

export function classifyCrossModulePairing(input: {
  total_leads: number;
  total_contacts: number;
  total_accounts: number;
  total_deals: number;
}): CrossModulePairing | null {
  const present: string[] = [];
  if ((input.total_leads ?? 0) > 0) present.push("lead");
  if ((input.total_contacts ?? 0) > 0) present.push("contact");
  if ((input.total_deals ?? 0) > 0) present.push("deal");
  if ((input.total_accounts ?? 0) > 0) present.push("account");
  if (present.length <= 1) return null;
  if (present.length >= 3) return "mixed";
  // Exactly two — the priority push order above (lead, contact, deal,
  // account) guarantees they're already in canonical order when joined.
  const key = present.join("+");
  return CROSS_MODULE_PAIRING_LOOKUP[key] ?? "mixed";
}

export interface CrossModuleClusterRow {
  id: number;
  domain: string | null;
  company_name: string | null;
  confidence_score: number;
  confidence_level: "high" | "medium" | "low";
  total_records: number;
  total_leads: number;
  total_contacts: number;
  total_accounts: number;
  total_deals: number;
  pairing: CrossModulePairing | null;
  estimated_pipeline_value: number;
  status: string;
  created_at: Date | null;
  updated_at: Date | null;
}

export interface CrossModuleOverlapsResponse {
  total: number;
  by_pairing: Record<string, number>;
  arr_exposure_total: number;
  clusters: CrossModuleClusterRow[];
}

/**
 * R6 — Fetch active clusters that span 2+ record types ("cross-module
 * overlaps") with per-pairing counts.
 *
 * Definition: at least two of total_leads/contacts/accounts/deals are > 0.
 * Filtering: status='active' so resolved/ignored clusters drop off the
 * triage queue. Optional `pairing` filter applies a post-query JS filter
 * (the SQL aggregates produce all pairings; trimming after is cheap given
 * the result set is bounded by `limit`).
 *
 * Limit defaults to 200, clamped [1, 1000]. Most tenants will have <200
 * cross-module clusters open at any time — this is a triage view, not a
 * pagination view.
 */
export async function getCrossModuleOverlaps(opts: {
  limit?: number;
  pairing?: CrossModulePairing | null;
} = {}): Promise<CrossModuleOverlapsResponse> {
  const limit = Math.min(1000, Math.max(1, Math.floor(opts.limit ?? 200) || 200));
  const r = await pool.query<CrossModuleClusterRow>(
    `
    SELECT
      id, domain, company_name,
      confidence_score, confidence_level,
      total_records,
      total_leads, total_contacts, total_accounts, total_deals,
      COALESCE(estimated_pipeline_value, 0)::numeric AS estimated_pipeline_value,
      status, created_at, updated_at
    FROM duplicate_clusters
    WHERE status = 'active'
      AND (
        (CASE WHEN total_leads > 0 THEN 1 ELSE 0 END +
         CASE WHEN total_contacts > 0 THEN 1 ELSE 0 END +
         CASE WHEN total_accounts > 0 THEN 1 ELSE 0 END +
         CASE WHEN total_deals > 0 THEN 1 ELSE 0 END
        ) >= 2
      )
    ORDER BY total_records DESC, confidence_score DESC
    LIMIT $1
    `,
    [limit],
  );

  const all = r.rows.map((row) => ({
    ...row,
    estimated_pipeline_value: Number(row.estimated_pipeline_value ?? 0),
    pairing: classifyCrossModulePairing({
      total_leads: Number(row.total_leads ?? 0),
      total_contacts: Number(row.total_contacts ?? 0),
      total_accounts: Number(row.total_accounts ?? 0),
      total_deals: Number(row.total_deals ?? 0),
    }),
  }));

  const filtered = opts.pairing
    ? all.filter((c) => c.pairing === opts.pairing)
    : all;

  const byPairing: Record<string, number> = {};
  let arrTotal = 0;
  for (const c of all) {
    const key = c.pairing ?? "unknown";
    byPairing[key] = (byPairing[key] ?? 0) + 1;
    arrTotal += Number(c.estimated_pipeline_value ?? 0);
  }

  return {
    total: filtered.length,
    by_pairing: byPairing,
    arr_exposure_total: arrTotal,
    clusters: filtered,
  };
}

/**
 * Follow-up 3 — Bulk-close lead records in cross-module clusters.
 *
 * Context: cross-module clusters (R6) have a Lead alongside a Contact /
 * Account / Deal for the same domain. Zoho doesn't support cross-module
 * merges, so the recommended action is to CLOSE the lead — the company
 * is already represented by the canonical Account / Contact / Deal.
 * Operators were doing this one-by-one in Zoho; this helper does it in
 * bulk via the Zoho update-record API.
 *
 * Per cluster:
 *   1. Fetch the cluster's lead records (record_type='lead', has zoho_record_id)
 *   2. For each lead, call Zoho `PUT /Leads/:id` with
 *      Lead_Status='Lost Lead' + a Description note explaining why.
 *      Already-Lost / already-Junk leads are skipped silently (idempotent).
 *   3. If every lead update succeeded, mark the cluster resolved via
 *      resolveCluster — this also captures a pre-resolve snapshot (R10)
 *      and logs the action in duplicate_merge_actions.
 *   4. If any lead update failed, the cluster is NOT marked resolved —
 *      partial-failure state is reported back so the operator can retry.
 *
 * Safety:
 *   - clusterIds is REQUIRED — callers explicitly enumerate which
 *     clusters to act on (no "close everything matching this filter").
 *   - maxClusters hard-clamps the batch size at 25 (default).
 *   - dryRun=true returns the per-cluster plan without writing.
 *   - Concurrency 3 — Zoho rate limits are real.
 */
export interface BulkCloseLeadResult {
  cluster_id: number;
  leads_closed: number;
  leads_skipped: number;
  leads_failed: number;
  cluster_resolved: boolean;
  errors: Array<{ zoho_lead_id: string; message: string }>;
  notes: string;
}

export async function bulkCloseLeadsInClusters(opts: {
  clusterIds: number[];
  performedBy: string;
  dryRun?: boolean;
  maxClusters?: number;
}): Promise<{
  dry_run: boolean;
  examined: number;
  total_leads_closed: number;
  total_leads_skipped: number;
  total_leads_failed: number;
  clusters_resolved: number;
  per_cluster: BulkCloseLeadResult[];
}> {
  const dryRun = !!opts.dryRun;
  const cap = Math.min(25, Math.max(1, opts.maxClusters ?? 25));
  const ids = Array.isArray(opts.clusterIds)
    ? opts.clusterIds.slice(0, cap)
    : [];

  if (ids.length === 0) {
    return {
      dry_run: dryRun,
      examined: 0,
      total_leads_closed: 0,
      total_leads_skipped: 0,
      total_leads_failed: 0,
      clusters_resolved: 0,
      per_cluster: [],
    };
  }

  const { updateZohoRecord } = await import("./zohoCRM");

  const closeOneLead = async (
    zohoLeadId: string,
    clusterId: number,
    currentStatus: string | null,
  ): Promise<{ status: "closed" | "skipped" | "failed"; message?: string }> => {
    // Idempotency: skip leads already in a Lost / Junk terminal state so
    // re-running the batch doesn't spam Zoho with no-op updates.
    const lower = (currentStatus ?? "").trim().toLowerCase();
    if (lower === "lost lead" || lower === "junk lead") {
      return { status: "skipped", message: `Already ${currentStatus}` };
    }
    if (dryRun) return { status: "closed" }; // count as "would-close" in dry run
    try {
      await updateZohoRecord("Leads", zohoLeadId, {
        Lead_Status: "Lost Lead",
        Description: `Closed by Duplicate Radar bulk-close on cross-module cluster #${clusterId}. The company is represented in another module (Account / Contact / Deal) and a duplicate Lead is no longer needed.`,
      });
      return { status: "closed" };
    } catch (err) {
      return {
        status: "failed",
        message: (err as Error)?.message ?? String(err),
      };
    }
  };

  const perCluster: BulkCloseLeadResult[] = [];

  for (const clusterId of ids) {
    const leadsR = await pool.query<{
      id: number;
      zoho_record_id: string | null;
      status: string | null;
    }>(
      `SELECT id, zoho_record_id, status
         FROM duplicate_records
        WHERE cluster_id = $1
          AND record_type = 'lead'
          AND zoho_record_id IS NOT NULL
          AND zoho_record_id <> ''`,
      [clusterId],
    );

    const leads = leadsR.rows;
    if (leads.length === 0) {
      perCluster.push({
        cluster_id: clusterId,
        leads_closed: 0,
        leads_skipped: 0,
        leads_failed: 0,
        cluster_resolved: false,
        errors: [],
        notes: "No lead records with zoho_record_id in this cluster",
      });
      continue;
    }

    const concurrency = 3;
    let closed = 0;
    let skipped = 0;
    let failed = 0;
    const errors: BulkCloseLeadResult["errors"] = [];

    for (let i = 0; i < leads.length; i += concurrency) {
      const batch = leads.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map((l) => closeOneLead(l.zoho_record_id!, clusterId, l.status)),
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j]!;
        const lead = batch[j]!;
        if (r.status === "closed") closed++;
        else if (r.status === "skipped") skipped++;
        else {
          failed++;
          errors.push({
            zoho_lead_id: lead.zoho_record_id ?? "",
            message: r.message ?? "Unknown error",
          });
        }
      }
    }

    // Mark cluster resolved only when every lead either closed cleanly
    // or was already-skipped. A single failure leaves the cluster active
    // so the operator can investigate / retry without losing visibility.
    let clusterResolved = false;
    const allClean = failed === 0;
    if (allClean && !dryRun) {
      try {
        await resolveCluster(
          clusterId,
          "resolve",
          opts.performedBy,
          undefined,
          `Bulk-close: closed ${closed} lead${closed === 1 ? "" : "s"} in Zoho (cross-module cluster — company represented in another module)`,
        );
        clusterResolved = true;
      } catch (err) {
        // resolveCluster failing after the Zoho writes succeeded is a
        // partial state; surface the error but the leads ARE closed in
        // Zoho already. Operator can mark the cluster resolved manually.
        errors.push({
          zoho_lead_id: "",
          message: `Cluster mark-resolved failed after Zoho updates: ${(err as Error).message}`,
        });
      }
    }

    perCluster.push({
      cluster_id: clusterId,
      leads_closed: closed,
      leads_skipped: skipped,
      leads_failed: failed,
      cluster_resolved: clusterResolved,
      errors,
      notes: dryRun
        ? `Dry run — would close ${closed} lead${closed === 1 ? "" : "s"} (${skipped} already-closed skipped)`
        : `Closed ${closed} lead${closed === 1 ? "" : "s"}, skipped ${skipped}, failed ${failed}`,
    });
  }

  const totalClosed = perCluster.reduce((a, c) => a + c.leads_closed, 0);
  const totalSkipped = perCluster.reduce((a, c) => a + c.leads_skipped, 0);
  const totalFailed = perCluster.reduce((a, c) => a + c.leads_failed, 0);
  const clustersResolved = perCluster.filter((c) => c.cluster_resolved).length;

  return {
    dry_run: dryRun,
    examined: ids.length,
    total_leads_closed: totalClosed,
    total_leads_skipped: totalSkipped,
    total_leads_failed: totalFailed,
    clusters_resolved: clustersResolved,
    per_cluster: perCluster,
  };
}

export async function getSyncState(
  module: string,
): Promise<ZohoSyncState | null> {
  const result = await pool.query(
    "SELECT * FROM zoho_sync_state WHERE module = $1",
    [module],
  );
  return result.rows[0] || null;
}

export async function getAllSyncStates(): Promise<ZohoSyncState[]> {
  // Tasks module was removed platform-wide; filter out any stale rows so the
  // Sync Status badges only reflect modules we actively sync.
  const result = await pool.query(
    "SELECT * FROM zoho_sync_state WHERE module NOT IN ('Tasks') ORDER BY module",
  );
  return result.rows;
}

export async function upsertSyncState(
  module: string,
  totalSynced: number,
  status: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO zoho_sync_state (module, last_sync_at, total_synced, sync_status)
     VALUES ($1, NOW(), $2, $3)
     ON CONFLICT (module) DO UPDATE SET last_sync_at = NOW(), total_synced = $2, sync_status = $3`,
    [module, totalSynced, status],
  );
}

export async function getDistinctOwners(): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT owner_name FROM duplicate_records WHERE owner_name IS NOT NULL AND owner_name != '' ORDER BY owner_name`,
  );
  return result.rows.map((r) => r.owner_name);
}

export async function getDistinctLayouts(): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT layout_name FROM duplicate_records WHERE layout_name IS NOT NULL AND layout_name != '' ORDER BY layout_name`,
  );
  return result.rows.map((r) => r.layout_name);
}

export async function getDistinctDomains(): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT domain FROM duplicate_records WHERE domain IS NOT NULL AND domain != '' ORDER BY domain LIMIT 200`,
  );
  return result.rows.map((r) => r.domain);
}

export async function getDistinctProducts(): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT products FROM duplicate_records WHERE products IS NOT NULL AND products != '' ORDER BY products`,
  );
  return result.rows.map((r) => r.products);
}

export async function getDistinctPipelines(): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT pipeline FROM duplicate_records WHERE pipeline IS NOT NULL AND pipeline != '' ORDER BY pipeline`,
  );
  return result.rows.map((r) => r.pipeline);
}

// Distinct Deal stages — restricted to the Deals module since stage only
// applies to Deal records. Used to populate the Stage filter dropdown.
export async function getDistinctStages(): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT stage FROM duplicate_records
       WHERE zoho_module = 'Deals' AND stage IS NOT NULL AND stage != ''
       ORDER BY stage`,
  );
  return result.rows.map((r) => r.stage);
}

export async function getFilteredClusters(
  filters: DuplicateFilters,
  limit = 30,
  offset = 0,
): Promise<{ clusters: DuplicateCluster[]; total: number }> {
  let whereConditions = ["c.status = $1"];
  let params: any[] = [filters.status || "active"];
  let paramIdx = 2;

  if (filters.confidence_level) {
    whereConditions.push(`c.confidence_level = $${paramIdx++}`);
    params.push(filters.confidence_level);
  }

  if (filters.start_date) {
    whereConditions.push(`c.created_at >= $${paramIdx++}`);
    params.push(filters.start_date);
  }

  if (filters.end_date) {
    whereConditions.push(`c.created_at <= $${paramIdx++}`);
    params.push(filters.end_date);
  }

  let joinNeeded = false;
  let recordConditions: string[] = [];

  if (filters.modules && filters.modules.length > 0) {
    joinNeeded = true;
    recordConditions.push(
      `r.zoho_module IN (${filters.modules.map((_, i) => `$${paramIdx + i}`).join(",")})`,
    );
    params.push(...filters.modules);
    paramIdx += filters.modules.length;
  }

  if (filters.owners && filters.owners.length > 0) {
    joinNeeded = true;
    recordConditions.push(
      `r.owner_name IN (${filters.owners.map((_, i) => `$${paramIdx + i}`).join(",")})`,
    );
    params.push(...filters.owners);
    paramIdx += filters.owners.length;
  }

  if (filters.layouts && filters.layouts.length > 0) {
    joinNeeded = true;
    recordConditions.push(
      `r.layout_name IN (${filters.layouts.map((_, i) => `$${paramIdx + i}`).join(",")})`,
    );
    params.push(...filters.layouts);
    paramIdx += filters.layouts.length;
  }

  if (filters.pipelines && filters.pipelines.length > 0) {
    joinNeeded = true;
    recordConditions.push(
      `r.pipeline IN (${filters.pipelines.map((_, i) => `$${paramIdx + i}`).join(",")})`,
    );
    params.push(...filters.pipelines);
    paramIdx += filters.pipelines.length;
  }

  if (filters.stages && filters.stages.length > 0) {
    joinNeeded = true;
    recordConditions.push(
      `r.stage IN (${filters.stages.map((_, i) => `$${paramIdx + i}`).join(",")})`,
    );
    params.push(...filters.stages);
    paramIdx += filters.stages.length;
  }

  if (filters.domain) {
    joinNeeded = true;
    recordConditions.push(`r.domain ILIKE $${paramIdx++}`);
    params.push(`%${filters.domain}%`);
  }

  const joinClause = joinNeeded
    ? "INNER JOIN duplicate_records r ON r.cluster_id = c.id"
    : "";
  const recordWhere =
    recordConditions.length > 0 ? "AND " + recordConditions.join(" AND ") : "";

  const countQuery = `SELECT COUNT(DISTINCT c.id) as total FROM duplicate_clusters c ${joinClause} WHERE ${whereConditions.join(" AND ")} ${recordWhere}`;
  const countResult = await pool.query(countQuery, params);
  const total = parseInt(countResult.rows[0].total);

  const dataParams = [...params, limit, offset];
  const dataQuery = `SELECT DISTINCT c.* FROM duplicate_clusters c ${joinClause} WHERE ${whereConditions.join(" AND ")} ${recordWhere} ORDER BY c.confidence_score DESC, c.total_records DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
  const dataResult = await pool.query(dataQuery, dataParams);

  return { clusters: dataResult.rows, total };
}

export async function getFilteredSummary(
  filters: DuplicateFilters,
): Promise<any> {
  let whereConditions = ["c.status = 'active'"];
  let params: any[] = [];
  let paramIdx = 1;

  let joinNeeded = false;
  let recordConditions: string[] = [];

  if (filters.modules && filters.modules.length > 0) {
    joinNeeded = true;
    recordConditions.push(
      `r.zoho_module IN (${filters.modules.map((_, i) => `$${paramIdx + i}`).join(",")})`,
    );
    params.push(...filters.modules);
    paramIdx += filters.modules.length;
  }

  if (filters.owners && filters.owners.length > 0) {
    joinNeeded = true;
    recordConditions.push(
      `r.owner_name IN (${filters.owners.map((_, i) => `$${paramIdx + i}`).join(",")})`,
    );
    params.push(...filters.owners);
    paramIdx += filters.owners.length;
  }

  if (filters.stages && filters.stages.length > 0) {
    joinNeeded = true;
    recordConditions.push(
      `r.stage IN (${filters.stages.map((_, i) => `$${paramIdx + i}`).join(",")})`,
    );
    params.push(...filters.stages);
    paramIdx += filters.stages.length;
  }

  if (filters.domain) {
    joinNeeded = true;
    recordConditions.push(`r.domain ILIKE $${paramIdx++}`);
    params.push(`%${filters.domain}%`);
  }

  const joinClause = joinNeeded
    ? "INNER JOIN duplicate_records r ON r.cluster_id = c.id"
    : "";
  const recordWhere =
    recordConditions.length > 0 ? "AND " + recordConditions.join(" AND ") : "";

  const query = `
    SELECT 
      COUNT(DISTINCT c.id) as total_clusters,
      COUNT(DISTINCT CASE WHEN c.confidence_level = 'high' THEN c.id END) as high_confidence,
      COUNT(DISTINCT CASE WHEN c.confidence_level = 'medium' THEN c.id END) as medium_confidence,
      COUNT(DISTINCT CASE WHEN c.confidence_level = 'low' THEN c.id END) as low_confidence,
      COALESCE(SUM(c.estimated_pipeline_value), 0) as pipeline_inflation
    FROM duplicate_clusters c ${joinClause}
    WHERE ${whereConditions.join(" AND ")} ${recordWhere}
  `;

  const result = await pool.query(query, params);
  const row = result.rows[0];

  return {
    totalClusters: parseInt(row.total_clusters),
    highConfidence: parseInt(row.high_confidence),
    mediumConfidence: parseInt(row.medium_confidence),
    lowConfidence: parseInt(row.low_confidence),
    estimatedPipelineInflation: parseFloat(row.pipeline_inflation),
  };
}

export async function upsertTask(
  task: Omit<DuplicateRecordTask, "id" | "created_at">,
): Promise<DuplicateRecordTask> {
  const result = await pool.query(
    `INSERT INTO duplicate_record_tasks (zoho_task_id, related_record_id, cluster_id, subject, due_date, status, owner_name, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (zoho_task_id) DO UPDATE SET
       subject = EXCLUDED.subject, due_date = EXCLUDED.due_date, status = EXCLUDED.status,
       owner_name = EXCLUDED.owner_name, description = EXCLUDED.description
     RETURNING *`,
    [
      task.zoho_task_id,
      task.related_record_id,
      task.cluster_id,
      task.subject,
      task.due_date,
      task.status,
      task.owner_name,
      task.description,
    ],
  );
  return result.rows[0];
}

export async function getTasksForRecords(
  recordIds: string[],
): Promise<DuplicateRecordTask[]> {
  if (recordIds.length === 0) return [];
  const placeholders = recordIds.map((_, i) => `$${i + 1}`).join(",");
  const result = await pool.query(
    `SELECT * FROM duplicate_record_tasks WHERE related_record_id IN (${placeholders}) ORDER BY due_date DESC`,
    recordIds,
  );
  return result.rows;
}

export async function getTaskCountForCluster(
  clusterId: number,
): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*) as cnt FROM duplicate_record_tasks WHERE cluster_id = $1`,
    [clusterId],
  );
  return parseInt(result.rows[0].cnt);
}

export async function calculateEnhancedScore(
  record1: DuplicateRecord,
  record2: DuplicateRecord,
): Promise<{ score: number; signals: string[] }> {
  const base = calculateMultiSignalScore(
    {
      email: record1.email,
      domain: record1.domain,
      phone: record1.phone,
      company_name: record1.company_name,
    },
    {
      email: record2.email,
      domain: record2.domain,
      phone: record2.phone,
      company_name: record2.company_name,
    },
  );

  let score = base.score;
  const signals = [...base.signals];

  if (record1.mobile && record2.mobile) {
    const m1 = normalizePhone(record1.mobile);
    const m2 = normalizePhone(record2.mobile);
    if (m1 && m2 && m1.length >= 7 && m1 === m2) {
      score += 25;
      signals.push("mobile_match");
    }
  }

  if (
    record1.cr_number &&
    record2.cr_number &&
    record1.cr_number === record2.cr_number
  ) {
    score += 35;
    signals.push("cr_number_match");
  }

  if (
    record1.vat_number &&
    record2.vat_number &&
    record1.vat_number === record2.vat_number
  ) {
    score += 30;
    signals.push("vat_number_match");
  }

  if (record1.website && record2.website) {
    const w1 = record1.website
      .toLowerCase()
      .replace(/^https?:\/\/(www\.)?/, "")
      .split("/")[0];
    const w2 = record2.website
      .toLowerCase()
      .replace(/^https?:\/\/(www\.)?/, "")
      .split("/")[0];
    if (w1 === w2) {
      score += 20;
      signals.push("website_match");
    }
  }

  return { score: Math.min(score, 100), signals };
}

export interface DataQualityResult {
  score: number;
  flags: string[];
  isJunk: boolean;
}

const GIBBERISH_REGEX = /^[a-zA-Z]{20,}$/;
const RANDOM_MIXED_REGEX = /^[a-zA-Z0-9]{25,}$/;
const CONSECUTIVE_CAPS_REGEX = /[A-Z]{8,}/;
const NAME_GARBAGE = [
  "test",
  "testing",
  "asdf",
  "qwerty",
  "xxx",
  "yyy",
  "zzz",
  "demo",
  "sample",
  "unknown",
  "n/a",
  "na",
  "-",
  ".",
  "..",
  "null",
];

function isGibberishName(name: string): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length < 2) return true;

  const words = trimmed.split(/\s+/);
  if (words.some((w) => w.length > 25 && /^[a-zA-Z]+$/.test(w))) return true;
  if (GIBBERISH_REGEX.test(trimmed.replace(/\s/g, ""))) return true;
  if (RANDOM_MIXED_REGEX.test(trimmed.replace(/\s/g, ""))) return true;

  const latinLetters = (trimmed.match(/[a-zA-Z]/g) || []).length;
  const upperCase = (trimmed.match(/[A-Z]/g) || []).length;
  if (latinLetters > 10 && upperCase / latinLetters > 0.6) return true;
  if (CONSECUTIVE_CAPS_REGEX.test(trimmed)) return true;

  const consonants = (
    trimmed.toLowerCase().match(/[bcdfghjklmnpqrstvwxyz]/g) || []
  ).length;
  const vowels = (trimmed.toLowerCase().match(/[aeiou]/g) || []).length;
  if (latinLetters > 10 && vowels === 0) return true;
  if (
    latinLetters > 15 &&
    consonants > 0 &&
    vowels > 0 &&
    consonants / vowels > 8
  )
    return true;

  return false;
}

function isSuspiciousEmail(email: string): boolean {
  if (!email) return false;
  const local = email.split("@")[0] || "";
  if (/\d{6,}/.test(local)) return true;
  if (local.length > 30 && /^[a-z0-9.]+$/.test(local)) {
    const dots = (local.match(/\./g) || []).length;
    if (dots > 4) return true;
  }
  return false;
}

export function assessDataQuality(record: {
  recordName?: string;
  companyName?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  ownerName?: string;
  domain?: string | null;
}): DataQualityResult {
  const flags: string[] = [];
  let score = 100;

  const name = record.recordName || "";
  const nameLower = name.toLowerCase().trim();
  if (!name || nameLower === "-" || nameLower === ".") {
    flags.push("missing_name");
    score -= 20;
  } else if (NAME_GARBAGE.includes(nameLower)) {
    flags.push("garbage_name");
    score -= 40;
  } else if (isGibberishName(name)) {
    flags.push("gibberish_name");
    score -= 50;
  }

  const company = record.companyName || "";
  if (!company || company === "Unknown") {
    flags.push("missing_company");
    score -= 15;
  } else if (isGibberishName(company)) {
    flags.push("gibberish_company");
    score -= 30;
  }

  if (!record.email) {
    flags.push("missing_email");
    score -= 10;
  } else if (isSuspiciousEmail(record.email)) {
    flags.push("suspicious_email");
    score -= 15;
  }

  const phoneNorm = record.phone ? normalizePhone(record.phone) : "";
  const mobileNorm = record.mobile ? normalizePhone(record.mobile) : "";
  if (!phoneNorm && !mobileNorm) {
    flags.push("missing_phone");
    score -= 10;
  }

  if (!record.ownerName || record.ownerName === "Unknown") {
    flags.push("missing_owner");
    score -= 5;
  }

  if (!record.domain) {
    flags.push("no_business_domain");
    score -= 5;
  }

  return {
    score: Math.max(0, score),
    flags,
    isJunk:
      score <= 20 ||
      flags.includes("gibberish_name") ||
      flags.includes("garbage_name"),
  };
}

export async function lookupRecordsByZohoIds(zohoIds: string[]): Promise<{
  [zohoId: string]: {
    clusterId: number;
    clusterDomain: string;
    clusterCompany: string | null;
    confidenceLevel: string;
    confidenceScore: number;
    totalInCluster: number;
    dataQualityScore: number;
    dataQualityFlags: string[];
    recordType: string;
    isJunk: boolean;
  };
}> {
  if (!zohoIds.length) return {};
  const result = await pool.query(
    `SELECT dr.zoho_record_id, dr.cluster_id, dr.record_type,
            dr.data_quality_score, dr.data_quality_flags,
            dc.domain, dc.company_name, dc.confidence_level,
            dc.confidence_score, dc.total_records
     FROM duplicate_records dr
     JOIN duplicate_clusters dc ON dc.id = dr.cluster_id
     WHERE dr.zoho_record_id = ANY($1)`,
    [zohoIds],
  );
  const map: Record<string, any> = {};
  for (const row of result.rows) {
    map[row.zoho_record_id] = {
      clusterId: row.cluster_id,
      clusterDomain: row.domain,
      clusterCompany: row.company_name,
      confidenceLevel: row.confidence_level,
      confidenceScore: row.confidence_score,
      totalInCluster: row.total_records,
      dataQualityScore: row.data_quality_score ?? 100,
      dataQualityFlags: row.data_quality_flags || [],
      recordType: row.record_type,
      isJunk: row.cluster_id && row.domain === "__JUNK_RECORDS__",
    };
  }
  return map;
}

export async function runLiveQualityCheck(
  records: Array<{
    id: string;
    Full_Name?: string;
    Last_Name?: string;
    First_Name?: string;
    Company?: string;
    Account_Name?: any;
    Deal_Name?: string;
    Email?: string;
    Phone?: string;
    Mobile?: string;
    Owner?: any;
  }>,
): Promise<{
  [id: string]: { score: number; flags: string[]; isJunk: boolean };
}> {
  const results: Record<string, any> = {};
  for (const r of records) {
    const name =
      r.Full_Name ||
      r.Deal_Name ||
      (r.First_Name
        ? `${r.First_Name} ${r.Last_Name || ""}`.trim()
        : r.Last_Name) ||
      "";
    const company =
      typeof r.Company === "string"
        ? r.Company
        : (typeof r.Account_Name === "object"
            ? r.Account_Name?.name
            : r.Account_Name) || "";
    const owner = typeof r.Owner === "object" ? r.Owner?.name : r.Owner || "";
    const email = r.Email || "";
    const phone = r.Phone || "";
    const mobile = r.Mobile || "";
    const domain = email.includes("@") ? email.split("@")[1] : undefined;
    const dq = assessDataQuality({
      recordName: name,
      companyName: company,
      email,
      phone,
      mobile,
      ownerName: owner,
      domain,
    });
    results[r.id] = { score: dq.score, flags: dq.flags, isJunk: dq.isJunk };
  }
  return results;
}

// ─── CS-pipeline overlap detection (Phase 1) ──────────────────────────────────
// Scans duplicate_records belonging to a cluster, classifies any Deal records
// whose raw_data exposes the Customer Success section (Phase + Churn Date),
// rolls up to a cluster-level verdict (BLOCK / REVIEW / WARN), and persists
// the verdict + ARR exposure + lifecycle state + sector on the cluster row.
// All thresholds and field names are env-configurable; see duplicateRadarCsOverlap.

import {
  classifyCsOverlap,
  extractCsFieldsFromRawData,
  rollupClusterVerdict,
  type CsLifecycleState,
  type CsOverlapClassification,
  type CsOverlapVerdict,
  type ClientSector,
} from "./duplicateRadarCsOverlap";

export interface CsOverlapScanResult {
  cluster_id: number;
  verdict: CsOverlapVerdict;
  lifecycle_state: CsLifecycleState;
  sector: ClientSector;
  arr_exposure: number;
  classified_records: number;
}

/**
 * Scan a single cluster's records and persist the cs_overlap verdict.
 * Returns the persisted summary, or { verdict: null } if no CS deals found.
 */
export async function scanClusterForCsOverlap(
  clusterId: number,
): Promise<CsOverlapScanResult> {
  const clusterRow = await pool.query(
    `SELECT id, domain FROM duplicate_clusters WHERE id = $1`,
    [clusterId],
  );
  if (clusterRow.rows.length === 0) {
    return {
      cluster_id: clusterId,
      verdict: null,
      lifecycle_state: null,
      sector: null,
      arr_exposure: 0,
      classified_records: 0,
    };
  }
  const domain = clusterRow.rows[0].domain as string;

  const recordsRow = await pool.query(
    `SELECT id, zoho_module, raw_data, gov_type
       FROM duplicate_records
       WHERE cluster_id = $1
         AND zoho_module = 'Deals'`,
    [clusterId],
  );

  const classifications: CsOverlapClassification[] = [];
  let arrTotal = 0;

  for (const rec of recordsRow.rows) {
    const fields = extractCsFieldsFromRawData(rec.raw_data, { domain });
    // gov_type column is preferred over raw_data lookup if present
    if (rec.gov_type) fields.gov_type = rec.gov_type;
    const cls = classifyCsOverlap(fields);
    classifications.push(cls);
    if (cls.verdict && fields.arr_value && fields.arr_value > 0) {
      arrTotal += fields.arr_value;
    }
  }

  const rollup = rollupClusterVerdict(classifications);

  await pool.query(
    `UPDATE duplicate_clusters
       SET cs_overlap_verdict       = $2,
           pipeline_lifecycle_state = $3,
           client_sector            = $4,
           arr_exposure             = $5,
           updated_at               = NOW()
       WHERE id = $1`,
    [
      clusterId,
      rollup.verdict,
      rollup.lifecycle_state,
      rollup.sector,
      arrTotal,
    ],
  );

  return {
    cluster_id: clusterId,
    verdict: rollup.verdict,
    lifecycle_state: rollup.lifecycle_state,
    sector: rollup.sector,
    arr_exposure: arrTotal,
    classified_records: classifications.filter((c) => c.verdict !== null).length,
  };
}

export interface CsOverlapBatchResult {
  scanned: number;
  flagged: number;
  block_count: number;
  review_count: number;
  warn_count: number;
  total_arr_exposure: number;
  duration_ms: number;
}

/**
 * Scan every cluster that has at least one Deal record. Idempotent — safe to
 * re-run any time (e.g. nightly, or on-demand after Zoho resync).
 */
export async function scanAllClustersForCsOverlap(): Promise<CsOverlapBatchResult> {
  const t0 = Date.now();
  const eligible = await pool.query(
    `SELECT DISTINCT c.id
       FROM duplicate_clusters c
       INNER JOIN duplicate_records r ON r.cluster_id = c.id
       WHERE r.zoho_module = 'Deals'`,
  );

  const out: CsOverlapBatchResult = {
    scanned: 0,
    flagged: 0,
    block_count: 0,
    review_count: 0,
    warn_count: 0,
    total_arr_exposure: 0,
    duration_ms: 0,
  };

  // Per-cluster scan was sequential, which gave us 3 DB round-trips × N clusters
  // and a 504 from the gateway on datasets with several hundred eligible
  // clusters. Run a small batch in parallel (6 ≤ default pg pool size 10, so
  // the route handler's own connection still has room) — wall time drops by
  // roughly the batch size.
  const CONCURRENCY = 6;
  for (let i = 0; i < eligible.rows.length; i += CONCURRENCY) {
    const batch = eligible.rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((row) => scanClusterForCsOverlap(row.id)),
    );
    for (const res of results) {
      out.scanned++;
      if (!res.verdict) continue;
      out.flagged++;
      if (res.verdict === "block") out.block_count++;
      else if (res.verdict === "review") out.review_count++;
      else if (res.verdict === "warn") out.warn_count++;
      out.total_arr_exposure += res.arr_exposure;
    }
  }

  out.duration_ms = Date.now() - t0;
  logger.info("[duplicateRadar] CS overlap scan complete", out);
  return out;
}

// ─── CS Lifecycle Compliance scan (Phase 4) ──────────────────────────────────
// Iterates every Deal record in duplicate_records and evaluates whether its
// Customer Success section violates any of the GRQ-defined CS process rules
// (onboarding duration, phase ↔ churn-date sync, phase-transition SLA).
// Pure computation in csLifecycleCompliance.ts; this layer only does the
// per-record fan-out and rollup.

import {
  evaluateCsLifecycle,
  summarizeViolations,
  type CsLifecycleEvaluation,
  type CsLifecycleSummary,
  type CsViolation,
  type CsViolationCode,
  type CsViolationSeverity,
} from "./csLifecycleCompliance";

export interface CsLifecycleViolationRow {
  record_id: number;
  cluster_id: number | null;
  zoho_record_id: string | null;
  account_name: string | null;
  domain: string | null;
  current_phase: string | null;
  days_since_modified: number | null;
  cs_owner_name: string | null;
  customer_since: string | null;
  renewal_date: string | null;
  churn_date: string | null;
  health: string | null;
  // ExtID (Admin) — Zoho custom field surfaced in the CS Lifecycle tab
  // (operator request 2026-05-30). Replaces the Health column in the
  // dashboard UI; Health stays on the row so existing CSV exports and
  // any future consumer keep both signals available.
  ext_id: string | null;
  violation: CsViolation;
}

export interface CsLifecycleScanResult {
  summary: CsLifecycleSummary;
  violations: CsLifecycleViolationRow[];
  duration_ms: number;
}

/**
 * Scan every Deal record under duplicate_records for CS lifecycle violations.
 * Returns the summary plus a flat array of violation rows. No persistence —
 * the scan is cheap enough to recompute on demand (data is bounded to deals
 * the radar already indexes).
 */
export async function scanCsLifecycleViolations(opts: {
  severity?: CsViolationSeverity;
  code?: CsViolationCode;
  limit?: number;
} = {}): Promise<CsLifecycleScanResult> {
  const t0 = Date.now();
  // Bumped default 2000 → 10000 and cap 5000 → 50000 so the scan covers
  // the full Deal corpus by default. The bulk Zoho sync currently caps
  // at 5,000 records per module, so 10000 comfortably scans every
  // synced Deal; the 50000 ceiling leaves headroom for a future Zoho
  // page-size bump without another deploy. Without this, the "CS Deals
  // Scanned" KPI was silently capped at the 2000 most-recently-modified
  // Deals — orgs with >2k Deals never saw every CS deal evaluated.
  const limit = Math.max(1, Math.min(opts.limit ?? 10000, 50000));

  const dealRows = await pool.query(
    `SELECT r.id, r.cluster_id, r.zoho_record_id, r.account_name,
            r.domain, r.modified_date, r.raw_data, r.gov_type
       FROM duplicate_records r
      WHERE r.zoho_module = 'Deals'
      ORDER BY r.modified_date DESC NULLS LAST
      LIMIT $1`,
    [limit],
  );

  const evaluations: CsLifecycleEvaluation[] = [];
  const violations: CsLifecycleViolationRow[] = [];

  for (const row of dealRows.rows) {
    const ev = evaluateCsLifecycle({
      raw_data: row.raw_data,
      modified_date: row.modified_date,
      domain: row.domain,
      gov_type: row.gov_type,
    });
    evaluations.push(ev);
    if (!ev.is_cs_deal) continue;

    // Pull the Customer Success section detail fields for display alongside
    // each violation (CS owner, customer-since, renewal/churn dates, health).
    // Same extractor evaluateCsLifecycle uses, so values stay consistent.
    const detail = extractCsFieldsFromRawData(row.raw_data, {
      domain: row.domain,
    });
    const fmtDate = (d: string | Date | null | undefined): string | null => {
      if (!d) return null;
      const s = typeof d === "string" ? d : d.toISOString();
      return s.slice(0, 10);
    };

    for (const v of ev.violations) {
      if (opts.severity && v.severity !== opts.severity) continue;
      if (opts.code && v.code !== opts.code) continue;
      // 2026-05-30 — operator request: the "Account" column on the CS
      // Lifecycle tab must be sourced from the Customer Success section's
      // Company custom field (the field the CS team curates) rather
      // than the Deal's standard Account_Name lookup that duplicate_records
      // .account_name was populated from at sync time. The two fields
      // are normally aligned, but if a CS team renames a customer in the
      // CS section without touching the top-level Account_Name lookup
      // the dashboard otherwise drifts from the CRM's CS view. Fall back
      // to the legacy Account_Name when the CS Company field is empty so
      // legacy data still shows something useful.
      const csAccountName =
        (detail.cs_company && detail.cs_company.trim()) ||
        row.account_name ||
        null;

      violations.push({
        record_id: row.id,
        cluster_id: row.cluster_id ?? null,
        zoho_record_id: row.zoho_record_id ?? null,
        account_name: csAccountName,
        domain: row.domain ?? null,
        current_phase: ev.current_phase,
        days_since_modified: ev.days_since_modified,
        cs_owner_name: detail.cs_owner_name ?? null,
        customer_since: fmtDate(detail.customer_since),
        renewal_date: fmtDate(detail.renewal_date),
        churn_date: fmtDate(detail.churn_date),
        health: detail.health ?? null,
        ext_id: detail.ext_id ?? null,
        violation: v,
      });
    }
  }

  // Severity ordering: critical → warning → info
  const sevOrder: Record<CsViolationSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  violations.sort((a, b) => {
    const s =
      sevOrder[a.violation.severity] - sevOrder[b.violation.severity];
    if (s !== 0) return s;
    return (b.days_since_modified ?? 0) - (a.days_since_modified ?? 0);
  });

  return {
    summary: summarizeViolations(evaluations),
    violations,
    duration_ms: Date.now() - t0,
  };
}

export { pool };
