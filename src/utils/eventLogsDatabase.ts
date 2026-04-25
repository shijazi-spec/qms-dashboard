import { Pool } from 'pg';
import * as crypto from 'crypto';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/* -------------------------------------------------------------------------
 * Sensitive-field redaction
 * -------------------------------------------------------------------------
 * DENY LIST — any key that matches one of these patterns will have its value
 * replaced with REDACTED_SENTINEL before it is written to event_logs or
 * change_history.  New patterns must be added here; the allow-list is
 * "everything not on the deny list".
 *
 * Pattern rules (matched case-insensitively against the field / key name):
 *   1. Exact names listed in SENSITIVE_EXACT_FIELDS
 *   2. Suffix patterns: key ends with one of SENSITIVE_SUFFIXES
 *   3. Prefix patterns: key starts with one of SENSITIVE_PREFIXES
 * -------------------------------------------------------------------------*/

export const REDACTED_SENTINEL = '***REDACTED***';

const SENSITIVE_EXACT_FIELDS = new Set([
  'password',
  'password_hash',
  'passwordhash',
  'hashed_password',
  'mfa_secret',
  'mfa_code',
  'mfa_token',
  'mfa_backup_codes',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'bot_token',
  'api_key',
  'apikey',
  'client_secret',
  'private_key',
  'signing_key',
  'session_secret',
  'encryption_key',
  'zoho_refresh_token',
  'zoho_access_token',
  'slack_bot_token',
  'resend_api_key',
  'openai_api_key',
]);

const SENSITIVE_SUFFIXES = [
  '_token',
  '_secret',
  '_key',
  '_hash',
  '_password',
  '_credential',
  '_credentials',
];

const SENSITIVE_PREFIXES = [
  'password',
  'mfa_',
  'secret_',
  'token_',
];

/* -------------------------------------------------------------------------
 * String-aware secret redaction
 * -------------------------------------------------------------------------
 * The deny-list above operates on object KEYS — it only protects payloads
 * whose author thought to name a field `password`, `api_key`, etc.  Several
 * of our write paths (notably `ai_pending_actions.payload_preview`, which is
 * a free-form human-readable description built by each tool's `buildPreview`
 * callback in `withApprovalGate.ts`) persist arbitrary STRINGS.  If a tool
 * author ever interpolates a credential into that preview string, the
 * key-based helper above is blind to it.
 *
 * `redactSecretLikeStrings()` runs a regex deny-list against the raw text to
 * catch credential-shaped substrings before they reach the database.  The
 * patterns are conservative — they target token formats with distinctive
 * structure (vendor prefix + length + alphabet) so they should not match
 * ordinary prose, IDs, or UUIDs.
 *
 * New patterns must be added here AND covered by a test in
 * `redactSensitiveFields.test.ts` / `aiApprovalRedaction.test.ts`.
 * -------------------------------------------------------------------------*/

interface SecretPattern {
  name: string;
  regex: RegExp;
}

const SECRET_LIKE_PATTERNS: SecretPattern[] = [
  // bcrypt hash:  $2a$ / $2b$ / $2y$  + cost + 53-char salt+hash (base64-ish)
  // Match this BEFORE the generic patterns because the literal `$` chars are
  // distinctive and we don't want some other rule to consume part of it.
  { name: 'bcrypt', regex: /\$2[aby]\$\d{1,2}\$[./A-Za-z0-9]{53}/g },
  // JSON Web Token:  three base64url segments separated by dots, header
  // always starts `eyJ` (base64 of `{"`).
  { name: 'jwt', regex: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.+/=-]{8,}/g },
  // Stripe / OpenAI / Anthropic style:  sk-…, sk_live_…, sk_test_…
  // Also covers `sk-ant-…` (Anthropic) and `sk-proj-…` (OpenAI project keys).
  { name: 'sk-key', regex: /\bsk[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{20,}\b/g },
  // Stripe publishable / restricted keys
  { name: 'stripe-pk', regex: /\b(?:pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  // GitHub tokens:  ghp_ (PAT), gho_ (OAuth), ghu_ (user-to-server),
  // ghs_ (server-to-server), ghr_ (refresh)
  { name: 'github', regex: /\bgh[porsu]_[A-Za-z0-9]{30,}\b/g },
  // GitLab personal access token
  { name: 'gitlab', regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  // Slack tokens (bot, user, app, workspace, refresh)
  { name: 'slack', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  // Google API key
  { name: 'google-api', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Google OAuth token
  { name: 'google-oauth', regex: /\bya29\.[0-9A-Za-z_-]{20,}\b/g },
  // AWS Access Key ID (also matches the temporary ASIA prefix)
  { name: 'aws-akid', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // HTTP "Authorization: Bearer …" header style
  { name: 'bearer', regex: /\bBearer\s+[A-Za-z0-9_\-.=+/]{20,}/gi },
];

/* -------------------------------------------------------------------------
 * Heuristic detectors: password-shaped and high-entropy substrings
 * -------------------------------------------------------------------------
 * The vendor-prefix regexes above only catch credentials with a distinctive
 * shape (`sk-…`, `ghp_…`, AKIA…, JWT, bcrypt, etc.). They are blind to a
 * secret that looks like ordinary prose — most importantly, a free-form
 * password buried in an innocuously-named field like `assignedTo`,
 * `description`, or `note` (e.g. 'P@ssw0rd!_plaintext'). The key-name
 * deny-list is also blind to these because the surrounding key name is not
 * on the sensitive list.
 *
 * Two heuristics close that gap (Task #463):
 *
 *   1. Password-strength tokens — a non-whitespace token of 12-80 chars
 *      that contains uppercase, lowercase, digit, and at least one
 *      "strong" special char from `!@#$%^&*()+={}[]|\:;"'<>?~``. The
 *      "strong" set deliberately excludes `,` `.` `-` `_` because those
 *      appear constantly in prose, slugs ("Test-Project-2026"), filenames,
 *      and acronym lists — including them would generate false positives.
 *
 *   2. High-entropy tokens — a non-whitespace token of 24-80 chars drawn
 *      from the base64/base64url alphabet `[A-Za-z0-9+/=_-]` that contains
 *      AT LEAST 3 of {upper, lower, digit} and has Shannon entropy
 *      >= 4.5 bits/char. This catches random session IDs and base64
 *      tokens without a vendor prefix. The "3 classes" floor filters out
 *      hex hashes (lowercase + digit only) and UUIDs (same), and the 4.5
 *      threshold is comfortably below random-base64 (~5.5+) but above the
 *      ceiling of mixed slugs like "Test-Project-2026-Final-v3" (~4.05).
 *
 * False-positive scope (verified against existing test fixtures):
 *   - English prose, emails, URLs, ISO dates, UUIDs, SHA hashes, slug
 *     identifiers, and ordinary alphanumeric IDs do NOT match either rule.
 *
 * New patterns must be covered by additions in `aiApprovalRedaction.test.ts`
 * and `aiToolPolicyBuildPreview.test.ts`.
 * -------------------------------------------------------------------------*/

const STRONG_SPECIAL_CHAR_RE = /[!@#$%^&*()+={}\[\]|\\:;"'<>?~`]/;
const TRIM_LEAD_RE = /^[("'`\[{<,]+/;
const TRIM_TAIL_RE = /[)"'`\]}>,.]+$/;
const ENTROPY_ALPHABET_RE = /^[A-Za-z0-9+/=_\-]+$/;

function isPasswordLikeToken(token: string): boolean {
  const len = token.length;
  if (len < 12 || len > 80) return false;
  if (!/[A-Z]/.test(token)) return false;
  if (!/[a-z]/.test(token)) return false;
  if (!/\d/.test(token)) return false;
  if (!STRONG_SPECIAL_CHAR_RE.test(token)) return false;
  return true;
}

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
  const len = s.length;
  let h = 0;
  for (const n of counts.values()) {
    const p = n / len;
    h -= p * Math.log2(p);
  }
  return h;
}

function isHighEntropyToken(token: string): boolean {
  const len = token.length;
  if (len < 24 || len > 80) return false;
  if (!ENTROPY_ALPHABET_RE.test(token)) return false;
  let classes = 0;
  if (/[A-Z]/.test(token)) classes++;
  if (/[a-z]/.test(token)) classes++;
  if (/\d/.test(token)) classes++;
  if (classes < 3) return false;
  return shannonEntropy(token) >= 4.5;
}

/**
 * Scans a string for non-whitespace tokens that match the password-strength
 * or high-entropy heuristic and replaces them with REDACTED_SENTINEL. Trims
 * one run of common surrounding punctuation (quotes, parens, commas) so a
 * credential wrapped in prose-quoting like `"P@ssw0rd!"` is still caught.
 *
 * Exported for direct unit testing; production code reaches it indirectly
 * through `redactSecretLikeStrings()`.
 */
export function redactCredentialLikeTokens(input: unknown): unknown {
  if (typeof input !== 'string' || input.length === 0) return input;
  return input.replace(/\S+/g, (token) => {
    if (token.length < 12 || token.length > 80) return token;
    if (isPasswordLikeToken(token) || isHighEntropyToken(token)) {
      return REDACTED_SENTINEL;
    }
    const lead = TRIM_LEAD_RE.exec(token)?.[0] ?? '';
    const tail = TRIM_TAIL_RE.exec(token)?.[0] ?? '';
    if (lead.length > 0 || tail.length > 0) {
      const core = token.slice(lead.length, token.length - tail.length);
      if (core.length >= 12 && core.length <= 80 &&
          (isPasswordLikeToken(core) || isHighEntropyToken(core))) {
        return lead + REDACTED_SENTINEL + tail;
      }
    }
    return token;
  });
}

/**
 * Replaces credential-shaped substrings inside a free-form string with
 * REDACTED_SENTINEL.  Non-string inputs (and null/undefined) are returned
 * unchanged so callers can pipe optional values through unconditionally.
 *
 * Layered defense:
 *   1. Vendor-prefix regexes  — sk-…, ghp_…, JWT, bcrypt, AKIA, …
 *   2. Heuristic token scanner — password-strength + high-entropy tokens
 *      that the regex layer cannot match because they have no distinctive
 *      shape (Task #463).
 */
export function redactSecretLikeStrings(input: unknown): unknown {
  if (typeof input !== 'string' || input.length === 0) return input;
  let out = input;
  for (const { regex } of SECRET_LIKE_PATTERNS) {
    out = out.replace(regex, REDACTED_SENTINEL);
  }
  out = redactCredentialLikeTokens(out) as string;
  return out;
}

/**
 * Recursively walks a JSON-serialisable payload and applies
 * `redactSecretLikeStrings` to every string leaf.  Object keys are NOT
 * altered (they are field names, not user data); only values are scrubbed.
 *
 * Used by `logEvent()` to defend against callers that build human-readable
 * audit summaries via string interpolation and accidentally embed a
 * credential in a value that the key-based deny-list cannot catch (because
 * the surrounding key is something innocuous like `summary` or `note`).
 */
export function deepRedactSecretLikeStrings(payload: any): any {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === 'string') return redactSecretLikeStrings(payload);
  if (Array.isArray(payload)) return payload.map(item => deepRedactSecretLikeStrings(item));
  if (typeof payload === 'object') {
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(payload)) {
      out[key] = deepRedactSecretLikeStrings(value);
    }
    return out;
  }
  return payload;
}

export function isSensitiveField(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_EXACT_FIELDS.has(lower)) return true;
  for (const suffix of SENSITIVE_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  for (const prefix of SENSITIVE_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Recursively walks a payload object and replaces the *values* of any keys
 * that match the deny list with REDACTED_SENTINEL.  Non-object primitives are
 * returned unchanged.  Arrays are walked element-by-element.
 *
 * @param payload   - The value to sanitize (may be any JSON-serialisable type)
 * @param fieldName - When the payload IS the secret (e.g. a plain string
 *                    stored under a sensitive column name in change_history),
 *                    pass the column name here and the whole value is redacted.
 */
export function redactSensitiveFields(payload: any, fieldName?: string): any {
  if (payload === null || payload === undefined) return payload;

  if (fieldName && isSensitiveField(fieldName)) {
    return REDACTED_SENTINEL;
  }

  if (Array.isArray(payload)) {
    return payload.map(item => redactSensitiveFields(item));
  }

  if (typeof payload === 'object') {
    const redacted: Record<string, any> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (isSensitiveField(key)) {
        redacted[key] = REDACTED_SENTINEL;
      } else if (value !== null && typeof value === 'object') {
        redacted[key] = redactSensitiveFields(value);
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  return payload;
}

/**
 * Deep redaction that combines BOTH defenses in a single pass:
 *   1. Key-based deny list (`isSensitiveField`)        — values under
 *      sensitive field names are replaced with REDACTED_SENTINEL.
 *   2. Regex deny list (`SECRET_LIKE_PATTERNS`)        — every string leaf
 *      is scrubbed of credential-shaped substrings.
 *
 * Use this whenever a value leaves the server in a context where BOTH
 * a tool/library author may have named a field carelessly (e.g. `apiKey`
 * vs `api_key`) AND free-form strings may contain interpolated secrets
 * (e.g. an error message that includes the new token, or a `notes` field
 * that pasted the credential into prose).
 *
 * Invariant: this function returns a NEW value graph; the input is never
 * mutated, so it is safe to apply to objects shared with other callers.
 */
export function redactSensitiveDeep(payload: any, fieldName?: string): any {
  if (payload === null || payload === undefined) return payload;

  if (fieldName && isSensitiveField(fieldName)) {
    return REDACTED_SENTINEL;
  }

  if (typeof payload === 'string') {
    return redactSecretLikeStrings(payload);
  }

  if (Array.isArray(payload)) {
    return payload.map(item => redactSensitiveDeep(item));
  }

  if (typeof payload === 'object') {
    const redacted: Record<string, any> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (isSensitiveField(key)) {
        redacted[key] = REDACTED_SENTINEL;
      } else {
        redacted[key] = redactSensitiveDeep(value);
      }
    }
    return redacted;
  }

  return payload;
}

export interface EventLog {
  id: number;
  timestamp: Date;
  user_id?: number;
  user_name?: string;
  user_email?: string;
  user_role?: string;
  action_type: 'CREATE' | 'UPDATE' | 'DELETE' | 'STATUS_CHANGE' | 'ASSIGN' | 'AI_ACTION' | 'LOGIN' | 'LOGOUT' | 'VIEW' | 'EXPORT' | 'CALCULATE';
  entity_type: 'PROJECT' | 'TRAINING' | 'ROI' | 'USER' | 'ROLE' | 'CALL' | 'KPI' | 'CAPA' | 'DOCUMENT' | 'SYSTEM' | 'SESSION';
  entity_id?: string;
  entity_name?: string;
  description?: string;
  old_value?: any;
  new_value?: any;
  ai_involved: boolean;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  correlation_id?: string;
  ip_address?: string;
  user_agent?: string;
  module?: string;
  checksum?: string;
  created_at: Date;
}

export interface EventLogInput {
  userId?: number;
  userName?: string;
  userEmail?: string;
  userRole?: string;
  actionType: EventLog['action_type'];
  entityType: EventLog['entity_type'];
  entityId?: string;
  entityName?: string;
  description?: string;
  oldValue?: any;
  newValue?: any;
  aiInvolved?: boolean;
  severity?: EventLog['severity'];
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;
  module?: string;
}

export interface EventLogFilters {
  page?: number;
  pageSize?: number;
  userId?: number;
  userName?: string;
  actionType?: string;
  entityType?: string;
  module?: string;
  severity?: string;
  aiInvolved?: boolean;
  fromDate?: string;
  toDate?: string;
  search?: string;
  correlationId?: string;
}

function generateChecksum(data: Partial<EventLogInput>): string {
  const checksumData = JSON.stringify({
    userId: data.userId,
    actionType: data.actionType,
    entityType: data.entityType,
    entityId: data.entityId,
    description: data.description,
    oldValue: data.oldValue,
    newValue: data.newValue,
    timestamp: new Date().toISOString()
  });
  return crypto.createHash('sha256').update(checksumData).digest('hex');
}

async function createMonthlyPartition(year: number, month: number): Promise<void> {
  const partitionName = `event_logs_y${year}m${String(month).padStart(2, '0')}`;
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 1);
  
  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];
  
  try {
    const checkResult = await pool.query(`
      SELECT EXISTS (
        SELECT FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename = $1
      )
    `, [partitionName]);
    
    // Defensive: bail out if the catalog query returned no rows (stubbed pool).
    if (checkResult.rows.length === 0) return;
    if (!checkResult.rows[0].exists) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${partitionName} PARTITION OF event_logs
        FOR VALUES FROM ('${startStr}') TO ('${endStr}')
      `);
      console.log(`📋 [EventLogs] Created partition: ${partitionName}`);
    }
  } catch (error: any) {
    if (!error.message?.includes('already exists')) {
      console.error(`📋 [EventLogs] Error creating partition ${partitionName}:`, error);
    }
  }
}

async function isTablePartitioned(): Promise<boolean> {
  try {
    const result = await pool.query(`
      SELECT pt.relkind = 'p' as is_partitioned
      FROM pg_class pt
      JOIN pg_namespace pn ON pt.relnamespace = pn.oid
      WHERE pt.relname = 'event_logs' 
      AND pn.nspname = 'public'
    `);
    return result.rows.length > 0 && result.rows[0].is_partitioned === true;
  } catch {
    return false;
  }
}

async function migrateToPartitionedTable(): Promise<void> {
  console.log('📋 [EventLogs] Migrating non-partitioned table to partitioned structure...');
  
  const backupExists = await pool.query(`
    SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'event_logs_backup')
  `);
  
  // Defensive: if the pool returned no rows (e.g. a test stub that hasn't
  // been wired for this catalog query), abort the migration rather than
  // crashing on `rows[0].exists`. The init was best-effort anyway.
  if (backupExists.rows.length === 0) {
    console.warn('📋 [EventLogs] Skipping migration: pg_tables check returned no rows (likely a stubbed pool).');
    return;
  }

  if (backupExists.rows[0].exists) {
    await pool.query(`DROP TABLE IF EXISTS event_logs_backup CASCADE`);
  }
  
  await pool.query(`ALTER TABLE event_logs RENAME TO event_logs_backup`);
  console.log('📋 [EventLogs] Backed up existing table to event_logs_backup');
  
  await pool.query(`DROP SEQUENCE IF EXISTS event_logs_id_seq CASCADE`);
  
  await pool.query(`
    CREATE TABLE event_logs (
      id SERIAL,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      user_id INTEGER,
      user_name VARCHAR(255),
      user_email VARCHAR(255),
      user_role VARCHAR(50),
      action_type VARCHAR(50) NOT NULL,
      entity_type VARCHAR(50) NOT NULL,
      entity_id VARCHAR(100),
      entity_name VARCHAR(255),
      description TEXT,
      old_value JSONB,
      new_value JSONB,
      ai_involved BOOLEAN DEFAULT FALSE,
      severity VARCHAR(20) DEFAULT 'INFO',
      correlation_id VARCHAR(100),
      ip_address VARCHAR(45),
      user_agent TEXT,
      module VARCHAR(50),
      checksum VARCHAR(64),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (id, timestamp)
    ) PARTITION BY RANGE (timestamp)
  `);
  console.log('📋 [EventLogs] Created new partitioned parent table');
}

async function copyBackupDataToPartitions(): Promise<void> {
  console.log('📋 [EventLogs] Checking for backup data to migrate...');
  
  const backupExists = await pool.query(`
    SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'event_logs_backup')
  `);
  
  // Defensive: bail out if catalog query returned no rows (stubbed pool).
  if (backupExists.rows.length === 0 || !backupExists.rows[0].exists) {
    return;
  }
  
  const countResult = await pool.query(`SELECT COUNT(*) as count FROM event_logs_backup`);
  const backupCount = parseInt(countResult.rows[0].count, 10);
  
  if (backupCount === 0) {
    console.log('📋 [EventLogs] No backup data to migrate');
    await pool.query(`DROP TABLE IF EXISTS event_logs_backup CASCADE`);
    return;
  }
  
  console.log(`📋 [EventLogs] Migrating ${backupCount} records from backup...`);
  
  const distinctMonths = await pool.query(`
    SELECT DISTINCT 
      EXTRACT(YEAR FROM COALESCE(timestamp, created_at, NOW()))::integer as year,
      EXTRACT(MONTH FROM COALESCE(timestamp, created_at, NOW()))::integer as month
    FROM event_logs_backup
    ORDER BY year, month
  `);
  
  for (const row of distinctMonths.rows) {
    await createMonthlyPartition(row.year, row.month);
  }
  
  await pool.query(`
    INSERT INTO event_logs (
      timestamp, user_id, user_name, user_email, user_role,
      action_type, entity_type, entity_id, entity_name,
      description, old_value, new_value, ai_involved,
      severity, correlation_id, ip_address, user_agent,
      module, checksum, created_at
    )
    SELECT 
      COALESCE(timestamp, created_at, NOW()),
      user_id, user_name, user_email, user_role,
      action_type, entity_type, entity_id, entity_name,
      description, old_value, new_value, COALESCE(ai_involved, false),
      COALESCE(severity, 'INFO'), correlation_id, ip_address, user_agent,
      module, checksum, COALESCE(created_at, NOW())
    FROM event_logs_backup
  `);
  
  const newCount = await pool.query(`SELECT COUNT(*) as count FROM event_logs`);
  console.log(`📋 [EventLogs] Successfully migrated ${newCount.rows[0].count} records`);
  
  await pool.query(`DROP TABLE IF EXISTS event_logs_backup CASCADE`);
  console.log('📋 [EventLogs] Dropped backup table after successful migration');
}

export async function initializeEventLogsTable(): Promise<void> {
  console.log('📋 [EventLogs] Initializing event_logs partitioned table...');
  try {
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename = 'event_logs'
      )
    `);

    // Defensive: if the pool returned no rows (e.g. a test stub that hasn't
    // been wired for this catalog query), abort init rather than crashing on
    // `rows[0].exists`. The init was best-effort — tests stub all reads they
    // need and don't rely on the real catalog at all.
    if (tableCheck.rows.length === 0) {
      console.warn('📋 [EventLogs] Skipping init: pg_tables check returned no rows (likely a stubbed pool).');
      return;
    }

    if (tableCheck.rows[0].exists) {
      const isPartitioned = await isTablePartitioned();
      if (!isPartitioned) {
        await migrateToPartitionedTable();
      }
    } else {
      await pool.query(`
        CREATE TABLE event_logs (
          id SERIAL,
          timestamp TIMESTAMPTZ DEFAULT NOW(),
          user_id INTEGER,
          user_name VARCHAR(255),
          user_email VARCHAR(255),
          user_role VARCHAR(50),
          action_type VARCHAR(50) NOT NULL,
          entity_type VARCHAR(50) NOT NULL,
          entity_id VARCHAR(100),
          entity_name VARCHAR(255),
          description TEXT,
          old_value JSONB,
          new_value JSONB,
          ai_involved BOOLEAN DEFAULT FALSE,
          severity VARCHAR(20) DEFAULT 'INFO',
          correlation_id VARCHAR(100),
          ip_address VARCHAR(45),
          user_agent TEXT,
          module VARCHAR(50),
          checksum VARCHAR(64),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (id, timestamp)
        ) PARTITION BY RANGE (timestamp)
      `);
      console.log('📋 [EventLogs] Created partitioned parent table');
    }

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    
    await createMonthlyPartition(currentYear, currentMonth);
    
    const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
    const nextYear = currentMonth === 12 ? currentYear + 1 : currentYear;
    await createMonthlyPartition(nextYear, nextMonth);
    
    const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
    await createMonthlyPartition(prevYear, prevMonth);

    await copyBackupDataToPartitions();

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_event_logs_timestamp ON event_logs(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_event_logs_user_id ON event_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_event_logs_action_type ON event_logs(action_type);
      CREATE INDEX IF NOT EXISTS idx_event_logs_entity_type ON event_logs(entity_type);
      CREATE INDEX IF NOT EXISTS idx_event_logs_module ON event_logs(module);
      CREATE INDEX IF NOT EXISTS idx_event_logs_severity ON event_logs(severity);
      CREATE INDEX IF NOT EXISTS idx_event_logs_correlation_id ON event_logs(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_event_logs_created_at ON event_logs(created_at DESC);
    `);
    
    console.log('📋 [EventLogs] Partitioned table and indexes created successfully');
  } catch (error) {
    console.error('📋 [EventLogs] Error initializing partitioned table:', error);
    throw error;
  }
}

export async function logEvent(input: EventLogInput): Promise<EventLog> {
  console.log('📋 [EventLogs] Logging event:', input.actionType, input.entityType, input.entityId || 'N/A');
  
  try {
    // Free-form TEXT columns (description, entity_name) are populated by
    // callers that often interpolate runtime data into a human-readable
    // summary.  redactSensitiveFields() is key-based and cannot see inside a
    // string — run the regex scrubber here so a leaked credential in a
    // summary string never reaches the database.  The same scrubber is
    // applied recursively to string leaves inside oldValue/newValue JSON
    // after the key-based redaction has masked the obvious cases.
    const safeEntityName =
      input.entityName != null ? (redactSecretLikeStrings(input.entityName) as string) : null;
    const safeDescription =
      input.description != null ? (redactSecretLikeStrings(input.description) as string) : null;
    const safeOldValue = input.oldValue
      ? deepRedactSecretLikeStrings(redactSensitiveFields(input.oldValue))
      : null;
    const safeNewValue = input.newValue
      ? deepRedactSecretLikeStrings(redactSensitiveFields(input.newValue))
      : null;

    const checksum = generateChecksum({
      ...input,
      entityName: safeEntityName ?? undefined,
      description: safeDescription ?? undefined,
      oldValue: safeOldValue,
      newValue: safeNewValue,
    });
    console.log('📋 [EventLogs] Generated checksum:', checksum.substring(0, 16) + '...');

    const result = await pool.query(
      `INSERT INTO event_logs (
        user_id, user_name, user_email, user_role,
        action_type, entity_type, entity_id, entity_name,
        description, old_value, new_value, ai_involved,
        severity, correlation_id, ip_address, user_agent,
        module, checksum
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *`,
      [
        input.userId || null,
        input.userName || null,
        input.userEmail || null,
        input.userRole || null,
        input.actionType,
        input.entityType,
        input.entityId || null,
        safeEntityName,
        safeDescription,
        safeOldValue ? JSON.stringify(safeOldValue) : null,
        safeNewValue ? JSON.stringify(safeNewValue) : null,
        input.aiInvolved || false,
        input.severity || 'INFO',
        input.correlationId || null,
        input.ipAddress || null,
        input.userAgent || null,
        input.module || null,
        checksum
      ]
    );

    const eventLog = result.rows[0] as EventLog;
    console.log('📋 [EventLogs] Event logged successfully with ID:', eventLog.id);
    return eventLog;
  } catch (error) {
    console.error('📋 [EventLogs] Error logging event:', error);
    throw error;
  }
}

export async function getEventLogs(filters: EventLogFilters): Promise<{
  logs: EventLog[];
  total: number;
  page: number;
  pageSize: number;
}> {
  console.log('📋 [EventLogs] Fetching event logs with filters:', JSON.stringify(filters));
  
  const page = filters.page || 1;
  const pageSize = filters.pageSize || 50;
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (filters.userId) {
    conditions.push(`user_id = $${paramIndex++}`);
    params.push(filters.userId);
  }

  if (filters.userName) {
    conditions.push(`user_name ILIKE $${paramIndex++}`);
    params.push(`%${filters.userName}%`);
  }

  if (filters.actionType) {
    conditions.push(`action_type = $${paramIndex++}`);
    params.push(filters.actionType);
  }

  if (filters.entityType) {
    conditions.push(`entity_type = $${paramIndex++}`);
    params.push(filters.entityType);
  }

  if (filters.module) {
    conditions.push(`module = $${paramIndex++}`);
    params.push(filters.module);
  }

  if (filters.severity) {
    conditions.push(`severity = $${paramIndex++}`);
    params.push(filters.severity);
  }

  if (filters.aiInvolved !== undefined) {
    conditions.push(`ai_involved = $${paramIndex++}`);
    params.push(filters.aiInvolved);
  }

  if (filters.fromDate) {
    conditions.push(`timestamp >= $${paramIndex++}`);
    params.push(filters.fromDate);
  }

  if (filters.toDate) {
    conditions.push(`timestamp <= $${paramIndex++}`);
    params.push(filters.toDate);
  }

  if (filters.correlationId) {
    conditions.push(`correlation_id = $${paramIndex++}`);
    params.push(filters.correlationId);
  }

  if (filters.search) {
    conditions.push(`(
      description ILIKE $${paramIndex} OR 
      entity_name ILIKE $${paramIndex} OR 
      user_name ILIKE $${paramIndex}
    )`);
    params.push(`%${filters.search}%`);
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM event_logs ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const logsResult = await pool.query(
      `SELECT * FROM event_logs ${whereClause} 
       ORDER BY timestamp DESC 
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...params, pageSize, offset]
    );

    console.log('📋 [EventLogs] Retrieved', logsResult.rows.length, 'logs out of', total, 'total');

    return {
      logs: logsResult.rows as EventLog[],
      total,
      page,
      pageSize
    };
  } catch (error) {
    console.error('📋 [EventLogs] Error fetching event logs:', error);
    throw error;
  }
}

export async function getEventLogById(id: number): Promise<EventLog | null> {
  console.log('📋 [EventLogs] Fetching event log by ID:', id);
  
  try {
    const result = await pool.query(
      'SELECT * FROM event_logs WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      console.log('📋 [EventLogs] No event log found with ID:', id);
      return null;
    }

    console.log('📋 [EventLogs] Found event log:', result.rows[0].action_type, result.rows[0].entity_type);
    return result.rows[0] as EventLog;
  } catch (error) {
    console.error('📋 [EventLogs] Error fetching event log by ID:', error);
    throw error;
  }
}

export async function getEventLogStats(): Promise<{
  totalLogs: number;
  byModule: Record<string, number>;
  byActionType: Record<string, number>;
  bySeverity: Record<string, number>;
  last24Hours: number;
  criticalEvents: number;
  aiActions: number;
  activityByDay: { date: string; count: number }[];
}> {
  console.log('📋 [EventLogs] Calculating event log statistics...');
  
  try {
    const totalResult = await pool.query('SELECT COUNT(*) as total FROM event_logs');
    const totalLogs = parseInt(totalResult.rows[0].total, 10);

    const moduleResult = await pool.query(`
      SELECT COALESCE(module, 'UNKNOWN') as module, COUNT(*) as count 
      FROM event_logs 
      GROUP BY module
    `);
    const byModule: Record<string, number> = {};
    for (const row of moduleResult.rows) {
      byModule[row.module] = parseInt(row.count, 10);
    }

    const actionResult = await pool.query(`
      SELECT action_type, COUNT(*) as count 
      FROM event_logs 
      GROUP BY action_type
    `);
    const byActionType: Record<string, number> = {};
    for (const row of actionResult.rows) {
      byActionType[row.action_type] = parseInt(row.count, 10);
    }

    const severityResult = await pool.query(`
      SELECT severity, COUNT(*) as count 
      FROM event_logs 
      GROUP BY severity
    `);
    const bySeverity: Record<string, number> = {};
    for (const row of severityResult.rows) {
      bySeverity[row.severity] = parseInt(row.count, 10);
    }

    const last24Result = await pool.query(`
      SELECT COUNT(*) as count 
      FROM event_logs 
      WHERE timestamp >= NOW() - INTERVAL '24 hours'
    `);
    const last24Hours = parseInt(last24Result.rows[0].count, 10);

    const criticalResult = await pool.query(`
      SELECT COUNT(*) as count 
      FROM event_logs 
      WHERE severity = 'CRITICAL'
    `);
    const criticalEvents = parseInt(criticalResult.rows[0].count, 10);

    const aiResult = await pool.query(`
      SELECT COUNT(*) as count 
      FROM event_logs 
      WHERE ai_involved = true
    `);
    const aiActions = parseInt(aiResult.rows[0].count, 10);

    const activityResult = await pool.query(`
      SELECT DATE(timestamp) as date, COUNT(*) as count 
      FROM event_logs 
      WHERE timestamp >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(timestamp)
      ORDER BY date ASC
    `);
    const activityByDay = activityResult.rows.map(row => ({
      date: row.date.toISOString().split('T')[0],
      count: parseInt(row.count, 10)
    }));

    console.log('📋 [EventLogs] Stats calculated - Total:', totalLogs, 'Last 24h:', last24Hours, 'Critical:', criticalEvents, 'AI:', aiActions);

    return {
      totalLogs,
      byModule,
      byActionType,
      bySeverity,
      last24Hours,
      criticalEvents,
      aiActions,
      activityByDay
    };
  } catch (error) {
    console.error('📋 [EventLogs] Error calculating stats:', error);
    throw error;
  }
}

export async function exportEventLogs(filters: EventLogFilters): Promise<EventLog[]> {
  console.log('📋 [EventLogs] Exporting event logs with filters:', JSON.stringify(filters));
  
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (filters.userId) {
    conditions.push(`user_id = $${paramIndex++}`);
    params.push(filters.userId);
  }

  if (filters.userName) {
    conditions.push(`user_name ILIKE $${paramIndex++}`);
    params.push(`%${filters.userName}%`);
  }

  if (filters.actionType) {
    conditions.push(`action_type = $${paramIndex++}`);
    params.push(filters.actionType);
  }

  if (filters.entityType) {
    conditions.push(`entity_type = $${paramIndex++}`);
    params.push(filters.entityType);
  }

  if (filters.module) {
    conditions.push(`module = $${paramIndex++}`);
    params.push(filters.module);
  }

  if (filters.severity) {
    conditions.push(`severity = $${paramIndex++}`);
    params.push(filters.severity);
  }

  if (filters.aiInvolved !== undefined) {
    conditions.push(`ai_involved = $${paramIndex++}`);
    params.push(filters.aiInvolved);
  }

  if (filters.fromDate) {
    conditions.push(`timestamp >= $${paramIndex++}`);
    params.push(filters.fromDate);
  }

  if (filters.toDate) {
    conditions.push(`timestamp <= $${paramIndex++}`);
    params.push(filters.toDate);
  }

  if (filters.correlationId) {
    conditions.push(`correlation_id = $${paramIndex++}`);
    params.push(filters.correlationId);
  }

  if (filters.search) {
    conditions.push(`(
      description ILIKE $${paramIndex} OR 
      entity_name ILIKE $${paramIndex} OR 
      user_name ILIKE $${paramIndex}
    )`);
    params.push(`%${filters.search}%`);
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await pool.query(
      `SELECT * FROM event_logs ${whereClause} ORDER BY timestamp DESC`,
      params
    );

    console.log('📋 [EventLogs] Exported', result.rows.length, 'event logs');
    return result.rows as EventLog[];
  } catch (error) {
    console.error('📋 [EventLogs] Error exporting event logs:', error);
    throw error;
  }
}

/* -------------------------------------------------------------------------
 * getActionViewers / getActionViewersBatch
 * -------------------------------------------------------------------------
 * Returns distinct reviewers who opened a pending-AI-action detail page,
 * sourced from the view-audit events written by Task #70.
 *
 * Each row is a distinct (user_id, user_email, user_name, user_role) tuple
 * with the last-viewed timestamp and a total view count for that user.
 * The caller receives a safe summary — no payload values are included.
 * -------------------------------------------------------------------------*/

export interface ActionViewer {
  user_id: number | null;
  user_email: string | null;
  user_name: string | null;
  user_role: string | null;
  last_viewed_at: Date;
  view_count: number;
}

/**
 * Returns the distinct prior-viewer list for a single action code.
 * Never throws — returns [] on DB error so callers stay non-fatal.
 */
export async function getActionViewers(actionCode: string): Promise<ActionViewer[]> {
  try {
    const result = await pool.query<ActionViewer & { view_count: string }>(
      `SELECT user_id, user_email, user_name, user_role,
              MAX(timestamp) AS last_viewed_at,
              COUNT(*)::text AS view_count
       FROM event_logs
       WHERE correlation_id = $1
         AND action_type = 'AI_ACTION'
         AND description ILIKE 'Viewed%'
       GROUP BY user_id, user_email, user_name, user_role
       ORDER BY MAX(timestamp) DESC`,
      [actionCode],
    );
    return result.rows.map(r => ({
      user_id: r.user_id,
      user_email: r.user_email,
      user_name: r.user_name,
      user_role: r.user_role,
      last_viewed_at: r.last_viewed_at,
      view_count: parseInt(String(r.view_count), 10),
    }));
  } catch (error) {
    console.error('[EventLogs] getActionViewers error:', error);
    return [];
  }
}

/**
 * Batch variant — fetches prior-viewer summaries for multiple action codes
 * in a single DB round-trip.  Returns a map keyed by action_code.
 * Never throws — returns {} on DB error so callers stay non-fatal.
 */
export async function getActionViewersBatch(
  actionCodes: string[],
): Promise<Record<string, ActionViewer[]>> {
  if (actionCodes.length === 0) return {};
  try {
    const result = await pool.query<
      ActionViewer & { correlation_id: string; view_count: string }
    >(
      `SELECT correlation_id, user_id, user_email, user_name, user_role,
              MAX(timestamp) AS last_viewed_at,
              COUNT(*)::text AS view_count
       FROM event_logs
       WHERE correlation_id = ANY($1)
         AND action_type = 'AI_ACTION'
         AND description ILIKE 'Viewed%'
       GROUP BY correlation_id, user_id, user_email, user_name, user_role
       ORDER BY correlation_id, MAX(timestamp) DESC`,
      [actionCodes],
    );
    const map: Record<string, ActionViewer[]> = {};
    for (const row of result.rows) {
      const code = row.correlation_id;
      if (!map[code]) map[code] = [];
      map[code].push({
        user_id: row.user_id,
        user_email: row.user_email,
        user_name: row.user_name,
        user_role: row.user_role,
        last_viewed_at: row.last_viewed_at,
        view_count: parseInt(String(row.view_count), 10),
      });
    }
    return map;
  } catch (error) {
    console.error('[EventLogs] getActionViewersBatch error:', error);
    return {};
  }
}

console.log('📋 [EventLogs] Module loaded, initializing table...');
initializeEventLogsTable().catch(err => {
  console.error('📋 [EventLogs] Failed to initialize table on module load:', err);
});
