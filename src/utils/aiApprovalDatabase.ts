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
import { redactSensitiveFields, redactSecretLikeStrings } from './eventLogsDatabase';

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
        expires_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
      );

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
    console.log('[AIApproval] ai_pending_actions table ready');
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
  // Strip every deny-listed field BEFORE the value reaches the JSONB column,
  // BEFORE it is checksummed, and BEFORE it is returned to any caller — so
  // that no downstream consumer (audit dashboard, /approvals API, audit log
  // backfill) can re-leak the original secret.
  const safePayload = redactSensitiveFields(input.payload);
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
          expires_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW() + ($13 || ' hours')::interval)
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

export interface ListFilters {
  status?: ApprovalStatus | ApprovalStatus[];
  requestedByUserId?: number;
  toolId?: string;
  riskLevel?: RiskLevel;
  threadId?: string;
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
    [code, reviewer.userId, reviewer.email, reviewer.name, reason]
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
  // OAuth-refresh tool returns access/refresh token pairs, etc.  Run
  // result.data through the same deny-list helper used for `payload` and
  // the audit log so the JSONB column never stores raw credentials.
  const safeExecutionResult = JSON.stringify({
    data: redactSensitiveFields(result.data),
    error: result.error,
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
