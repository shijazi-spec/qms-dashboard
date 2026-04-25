/**
 * ai_pending_actions table + CRUD.
 *
 * Stores every AI write-tool invocation that requires human approval before
 * being executed. This is the core data structure of the Human-in-the-Loop
 * (HITL) gate and the evidence trail for:
 *
 *   - PDPL Art. 16 (human review of automated decisions affecting data subjects)
 *   - PCI DSS v4.0 §12.3.1 (documented approval process for changes)
 *   - ISO 27001:2022 A.5.37 (documented operating procedures)
 *   - ISO 9001:2015 §8.5.1 / §7.5.3 (control of production / documented info)
 *
 * Status machine (forward-only):
 *   pending -> approved -> executed | failed
 *   pending -> rejected
 *   pending -> expired   (auto after expires_at)
 *
 * All transitions are immutable facts: we never DELETE rows from this table;
 * that preserves audit-trail integrity for external auditors.
 */

import { Pool } from 'pg';
import * as crypto from 'crypto';
import {
  redactSensitiveDeep,
  redactSecretLikeStrings,
  detectCredentialLikeFields,
  type CredentialWarning,
} from './eventLogsDatabase';
import { logger } from './logger';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'failed'
  | 'expired';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface PendingAction {
  id: number;
  action_code: string;
  tool_id: string;
  tool_label: string;
  payload: any;
  payload_preview: string;
  risk_level: RiskLevel;
  compliance_refs: string[];
  requested_by_user_id: number | null;
  requested_by_email: string | null;
  requested_by_name: string | null;
  thread_id: string | null;
  status: ApprovalStatus;
  reviewed_by_user_id: number | null;
  reviewed_by_email: string | null;
  reviewed_by_name: string | null;
  reviewed_at: Date | null;
  rejection_reason: string | null;
  executed_at: Date | null;
  execution_result: any | null;
  result_entity_type: string | null;
  result_entity_id: string | null;
  created_at: Date;
  expires_at: Date;
  payload_checksum: string;
  /**
   * Structured warnings emitted by `detectCredentialLikeFields()` at
   * submission time (Task #477). One entry per offending field path so
   * the operator approval UI can highlight which payload value(s) look
   * like credentials and recommend routing the real secret through the
   * secret store instead of through chat. Always present (defaults to
   * `[]`) on rows enqueued after the migration; legacy rows hydrate to
   * `[]` through the column default.
   */
  credential_warnings: CredentialWarning[];
}

export interface EnqueueInput {
  toolId: string;
  toolLabel: string;
  payload: any;
  payloadPreview: string;
  riskLevel: RiskLevel;
  complianceRefs: string[];
  requestedByUserId: number | null;
  requestedByEmail: string | null;
  requestedByName: string | null;
  threadId: string | null;
  ttlHours?: number;
}

let initPromise: Promise<void> | null = null;

export async function initAIApprovalTable(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_pending_actions (
        id                     SERIAL PRIMARY KEY,
        action_code            VARCHAR(40)  NOT NULL UNIQUE,
        tool_id                VARCHAR(100) NOT NULL,
        tool_label             VARCHAR(255) NOT NULL,
        payload                JSONB        NOT NULL,
        payload_preview        TEXT         NOT NULL,
        payload_checksum       VARCHAR(64)  NOT NULL,
        risk_level             VARCHAR(20)  NOT NULL DEFAULT 'medium',
        compliance_refs        JSONB        NOT NULL DEFAULT '[]'::jsonb,

        requested_by_user_id   INTEGER,
        requested_by_email     VARCHAR(255),
        requested_by_name      VARCHAR(255),
        thread_id              VARCHAR(255),

        status                 VARCHAR(20)  NOT NULL DEFAULT 'pending',
        reviewed_by_user_id    INTEGER,
        reviewed_by_email      VARCHAR(255),
        reviewed_by_name       VARCHAR(255),
        reviewed_at            TIMESTAMPTZ,
        rejection_reason       TEXT,

        executed_at            TIMESTAMPTZ,
        execution_result       JSONB,
        result_entity_type     VARCHAR(50),
        result_entity_id       VARCHAR(100),

        created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        expires_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '24 hours',

        -- Task #477: structured warnings emitted by the AI tool boundary
        -- when the submitted payload contains values that look like
        -- credentials. Stored as JSONB so the operator approval UI can
        -- enumerate the offending field paths. Defaults to '[]' so
        -- pre-migration rows hydrate to an empty list.
        credential_warnings    JSONB        NOT NULL DEFAULT '[]'::jsonb
      );

      -- Backfill the column on existing deployments where CREATE TABLE
      -- was a no-op (the table already existed with the older schema).
      ALTER TABLE ai_pending_actions
        ADD COLUMN IF NOT EXISTS credential_warnings JSONB NOT NULL DEFAULT '[]'::jsonb;

      CREATE INDEX IF NOT EXISTS idx_ai_pending_actions_status_created
        ON ai_pending_actions(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_pending_actions_user_created
        ON ai_pending_actions(requested_by_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_pending_actions_thread
        ON ai_pending_actions(thread_id);
      CREATE INDEX IF NOT EXISTS idx_ai_pending_actions_tool
        ON ai_pending_actions(tool_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_pending_actions_expires
        ON ai_pending_actions(expires_at) WHERE status = 'pending';
    `);
    logger.info('[AIApproval] ai_pending_actions table ready');
  })();
  return initPromise;
}

/**
 * Generates a human-readable ticket code. Format: APR-YYYYMMDD-XXXXXX
 * where XXXXXX is 6 upper-case base32 chars. Collision probability ~1 in 10^9
 * over the 24-hour expiry window; we still rely on the UNIQUE constraint as
 * the final guard and retry on collision.
 */
function generateActionCode(): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const random = crypto.randomBytes(4).readUInt32BE(0);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Crockford-style, no look-alikes
  let suffix = '';
  let n = random;
  for (let i = 0; i < 6; i++) {
    suffix += alphabet[n & 31];
    n = n >>> 5 | (crypto.randomBytes(1)[0] << 27);
  }
  return `APR-${ymd}-${suffix}`;
}

function checksumPayload(payload: any): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');
}

export async function enqueuePendingAction(input: EnqueueInput): Promise<PendingAction> {
  await initAIApprovalTable();

  const ttlHours = input.ttlHours ?? 24;

  // SECURITY (PDPL Art. 16 / PCI DSS §3.5 / ISO 27001 A.5.34):
  // The tool-invocation context can contain credentials (e.g. an API-key
  // rotation tool whose payload is the new key, a refresh-token swap, etc.).
  // `redactSensitiveDeep` applies BOTH defenses in one pass:
  //   1. Key-based deny list — values under sensitive field names (api_key,
  //      password, token, …) are replaced with REDACTED_SENTINEL.
  //   2. Regex deny list — every string leaf is scrubbed of credential-shaped
  //      substrings (sk-…, ghp_…, JWT, bcrypt, AWS, …) so a tool author who
  //      embeds a secret in an innocuous field like `note`, `message`,
  //      `config_diff`, or `curl_example` is also covered (Task #102).
  // This happens BEFORE the value reaches the JSONB column, BEFORE it is
  // checksummed, and BEFORE it is returned to any caller — so no downstream
  // consumer (audit dashboard, /approvals API, audit log backfill) can
  // re-leak the original secret.
  // SECURITY (Task #477 — catch credential leaks at the AI tool boundary):
  // Run the structural detector against the ORIGINAL (pre-redaction)
  // payload + preview so we can surface a "this submission contained
  // credential-shaped values" warning to the human reviewer alongside the
  // usual scrubbing. The redaction below removes the secrets from the
  // persisted row, but without these warnings the operator would never
  // know the submitter accidentally pasted a key — so they couldn't
  // coach the requester to use the secret store next time.
  const credentialWarnings = detectCredentialLikeFields(
    input.payload,
    input.payloadPreview ?? null,
  );

  const safePayload = redactSensitiveDeep(input.payload);
  const checksum = checksumPayload(safePayload);

  // SECURITY: payload_preview is a free-form TEXT column built by each tool's
  // policy.buildPreview() callback in withApprovalGate.ts. The key-based
  // redactor above cannot see secrets that a tool author interpolated into
  // that human-readable string. Run the preview through the regex deny-list
  // so credential-shaped substrings (sk-…, ghp_…, JWT, bcrypt, AWS, etc.)
  // are replaced with the sentinel before they hit the database.
  const safePayloadPreview = redactSecretLikeStrings(input.payloadPreview ?? '') as string;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateActionCode();
    try {
      const res = await pool.query<PendingAction>(
        `INSERT INTO ai_pending_actions (
          action_code, tool_id, tool_label, payload, payload_preview, payload_checksum,
          risk_level, compliance_refs,
          requested_by_user_id, requested_by_email, requested_by_name, thread_id,
          expires_at, credential_warnings
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW() + ($13 || ' hours')::interval, $14)
        RETURNING *`,
        [
          code,
          input.toolId,
          input.toolLabel,
          JSON.stringify(safePayload),
          safePayloadPreview,
          checksum,
          input.riskLevel,
          JSON.stringify(input.complianceRefs || []),
          input.requestedByUserId,
          input.requestedByEmail,
          input.requestedByName,
          input.threadId,
          String(ttlHours),
          JSON.stringify(credentialWarnings),
        ]
      );
      return res.rows[0];
    } catch (err: any) {
      // unique_violation on action_code -> retry with a new code
      if (err?.code === '23505' && attempt < 4) continue;
      throw err;
    }
  }
  throw new Error('Failed to allocate unique action_code after 5 attempts');
}

export async function getPendingActionByCode(code: string): Promise<PendingAction | null> {
  const res = await pool.query<PendingAction>(
    'SELECT * FROM ai_pending_actions WHERE action_code = $1 LIMIT 1',
    [code]
  );
  return res.rows[0] || null;
}

/**
 * Task #298: review-status filter for the approval queue. Lets reviewers
 * narrow the list to either:
 *   - 'unreviewed_by_me' — actions the current reviewer has never opened
 *     the detail page for (NOT EXISTS view-audit row matching their user_id)
 *   - 'no_reviewers'     — actions nobody has opened yet (NOT EXISTS any
 *     view-audit row at all). True "blind spots" in a multi-reviewer team.
 *
 * Both modes look at event_logs rows written by the GET /:code handler in
 * `aiApprovalRoutes.ts` (action_type = 'AI_ACTION', description starts with
 * 'Viewed'). The view audit intentionally skips the requester's own
 * self-views, so a requester filtering by 'unreviewed_by_me' will still
 * see their own pending submissions — which matches the operator
 * expectation that "I haven't reviewed it" includes "I never opened the
 * detail page", regardless of who originally submitted it.
 */
export type ReviewFilter = 'unreviewed_by_me' | 'no_reviewers';

export interface ListFilters {
  status?: ApprovalStatus | ApprovalStatus[];
  requestedByUserId?: number;
  toolId?: string;
  riskLevel?: RiskLevel;
  threadId?: string;
  /**
   * Task #298: filter by view-audit history. When set to
   * 'unreviewed_by_me', `reviewerUserId` MUST also be provided so the
   * NOT EXISTS sub-query knows whose viewer rows to exclude.
   */
  reviewFilter?: ReviewFilter;
  /**
   * The viewer's user_id, used by `reviewFilter='unreviewed_by_me'`. Only
   * required for that mode; ignored otherwise.
   */
  reviewerUserId?: number;
  limit?: number;
  offset?: number;
}

export async function listPendingActions(filters: ListFilters = {}): Promise<{
  rows: PendingAction[];
  total: number;
}> {
  const where: string[] = [];
  const params: any[] = [];

  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    params.push(statuses);
    where.push(`status = ANY($${params.length})`);
  }
  if (filters.requestedByUserId != null) {
    params.push(filters.requestedByUserId);
    where.push(`requested_by_user_id = $${params.length}`);
  }
  if (filters.toolId) {
    params.push(filters.toolId);
    where.push(`tool_id = $${params.length}`);
  }
  if (filters.riskLevel) {
    params.push(filters.riskLevel);
    where.push(`risk_level = $${params.length}`);
  }
  if (filters.threadId) {
    params.push(filters.threadId);
    where.push(`thread_id = $${params.length}`);
  }

  // Task #298: review-status filter. Both branches use NOT EXISTS against
  // event_logs view-audit rows (action_type='AI_ACTION', description like
  // 'Viewed%') correlated by event_logs.correlation_id = action_code. The
  // view-audit row schema is owned by `getActionViewers` in
  // `eventLogsDatabase.ts`; this filter is the inverse of that query.
  //
  // SQL design notes:
  //   - We use NOT EXISTS (rather than LEFT JOIN ... WHERE viewer.id IS NULL)
  //     because Postgres can short-circuit NOT EXISTS on the first match,
  //     whereas LEFT JOIN materializes every viewer row before filtering.
  //   - `description ILIKE 'Viewed%'` matches both wording variants the
  //     route uses ("Viewed pending AI action ..." and the post-decision
  //     "Viewed approved/executed/rejected/... AI action ...").
  if (filters.reviewFilter === 'unreviewed_by_me') {
    if (filters.reviewerUserId == null) {
      throw new Error(
        "listPendingActions: reviewFilter='unreviewed_by_me' requires reviewerUserId",
      );
    }
    params.push(filters.reviewerUserId);
    where.push(
      `NOT EXISTS (
         SELECT 1 FROM event_logs el
          WHERE el.correlation_id = ai_pending_actions.action_code
            AND el.action_type    = 'AI_ACTION'
            AND el.description    ILIKE 'Viewed%'
            AND el.user_id        = $${params.length}
       )`,
    );
  } else if (filters.reviewFilter === 'no_reviewers') {
    where.push(
      `NOT EXISTS (
         SELECT 1 FROM event_logs el
          WHERE el.correlation_id = ai_pending_actions.action_code
            AND el.action_type    = 'AI_ACTION'
            AND el.description    ILIKE 'Viewed%'
       )`,
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(filters.limit ?? 50, 500);
  const offset = filters.offset ?? 0;

  const countRes = await pool.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM ai_pending_actions ${whereSql}`,
    params
  );
  const total = parseInt(countRes.rows[0].total, 10);

  params.push(limit, offset);
  const res = await pool.query<PendingAction>(
    `SELECT * FROM ai_pending_actions ${whereSql}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { rows: res.rows, total };
}

export async function countPendingForUser(userId: number): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ai_pending_actions
      WHERE status = 'pending'
        AND (requested_by_user_id = $1 OR $1 = 0)
        AND expires_at > NOW()`,
    [userId]
  );
  return parseInt(res.rows[0].n, 10);
}

/**
 * Task #481: count pending approvals whose payload was flagged with
 * credential-shaped values by the AI tool boundary. Drives the
 * "credential warnings" badge on the approval queue header so the badge
 * stays accurate regardless of which subset of rows the page is currently
 * showing. Mirrors the visibility rules of `countPendingForUser`:
 *   - userId === 0 → all pending rows (admin / quality_manager)
 *   - userId  > 0 → only pending rows requested by that user
 */
export async function countPendingWithCredentialWarnings(userId: number): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ai_pending_actions
      WHERE status = 'pending'
        AND (requested_by_user_id = $1 OR $1 = 0)
        AND expires_at > NOW()
        AND jsonb_array_length(credential_warnings) > 0`,
    [userId]
  );
  return parseInt(res.rows[0].n, 10);
}

export async function claimForApproval(
  code: string,
  reviewer: { userId: number | null; email: string | null; name: string | null }
): Promise<PendingAction | null> {
  // Atomic status transition: pending -> approved. Only succeeds if row is
  // still pending AND not expired. This prevents double-approval races and
  // approving an action the expiry cron has just killed.
  const res = await pool.query<PendingAction>(
    `UPDATE ai_pending_actions
        SET status              = 'approved',
            reviewed_by_user_id = $2,
            reviewed_by_email   = $3,
            reviewed_by_name    = $4,
            reviewed_at         = NOW()
      WHERE action_code = $1
        AND status = 'pending'
        AND expires_at > NOW()
      RETURNING *`,
    [code, reviewer.userId, reviewer.email, reviewer.name]
  );
  return res.rows[0] || null;
}

export async function rejectAction(
  code: string,
  reviewer: { userId: number | null; email: string | null; name: string | null },
  reason: string
): Promise<PendingAction | null> {
  // SECURITY (PDPL Art. 16 / PCI DSS §3.5 / ISO 27001 A.5.34):
  // The rejection note is a free-form TEXT column that reviewers populate
  // verbatim from a dialog box. A reviewer who pastes prose like "rejecting
  // because the new key sk_live_… is wrong" would otherwise leak that
  // credential to every other reviewer (via /api/ai/approvals reads) and to
  // the audit export. Run the reason through the same regex deny-list used
  // for `payload_preview` so credential-shaped substrings (sk-…, ghp_…,
  // JWT, bcrypt, AWS, etc.) are replaced with the sentinel before they
  // hit the database.
  const safeReason = redactSecretLikeStrings(reason ?? '') as string;

  const res = await pool.query<PendingAction>(
    `UPDATE ai_pending_actions
        SET status              = 'rejected',
            reviewed_by_user_id = $2,
            reviewed_by_email   = $3,
            reviewed_by_name    = $4,
            reviewed_at         = NOW(),
            rejection_reason    = $5
      WHERE action_code = $1
        AND status = 'pending'
      RETURNING *`,
    [code, reviewer.userId, reviewer.email, reviewer.name, safeReason]
  );
  return res.rows[0] || null;
}

export async function recordExecutionResult(
  code: string,
  result: {
    success: boolean;
    entityType?: string;
    entityId?: string;
    data?: any;
    error?: string;
  }
): Promise<PendingAction | null> {
  // SECURITY: the tool's return value is just as sensitive as its input —
  // a "rotate API key" tool will hand back the freshly-minted key, an
  // OAuth-refresh tool returns access/refresh token pairs, etc.  Apply
  // the same consolidated `redactSensitiveDeep` helper used for `payload`:
  //   1. Key-based deny list   — masks values stored under sensitively-named
  //      keys (access_token, api_key, password, …).
  //   2. Regex deny list       — scrubs credential-shaped substrings from
  //      every string leaf regardless of key name (e.g. a `curl_example`
  //      field containing a Bearer token, or an `error_detail` that echoes
  //      the new secret).
  const safeExecutionResult = JSON.stringify({
    data: redactSensitiveDeep(result.data),
    // `error` is a plain string but can still contain credential-shaped text —
    // e.g. an upstream runtime error that echoes a bearer token or new key.
    // Apply the same regex deny-list used for payload_preview so the string
    // leaf is scrubbed before it hits the database (Task #102).
    error: result.error != null ? (redactSecretLikeStrings(result.error) as string) : result.error,
  });

  const res = await pool.query<PendingAction>(
    `UPDATE ai_pending_actions
        SET status             = CASE WHEN $2 THEN 'executed' ELSE 'failed' END,
            executed_at        = NOW(),
            execution_result   = $3,
            result_entity_type = $4,
            result_entity_id   = $5
      WHERE action_code = $1
      RETURNING *`,
    [
      code,
      result.success,
      safeExecutionResult,
      result.entityType || null,
      result.entityId || null,
    ]
  );
  return res.rows[0] || null;
}

/**
 * Marks all pending actions past their expires_at as 'expired'.
 * Called by the nightly Inngest cron.
 */
export async function expireStalePendingActions(): Promise<number> {
  const res = await pool.query(
    `UPDATE ai_pending_actions
        SET status = 'expired'
      WHERE status = 'pending' AND expires_at <= NOW()`
  );
  return res.rowCount || 0;
}

export { pool as aiApprovalPool };
