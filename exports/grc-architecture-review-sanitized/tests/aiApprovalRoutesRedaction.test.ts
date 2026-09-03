/**
 * Guards every AI approval-queue read endpoint against leaking the
 * plaintext payload / execution_result secrets that the data layer
 * already masks at write time.
 *
 * Run:    npx tsx tests/aiApprovalRoutesRedaction.test.ts
 * Wired:  scripts/post-merge.sh + .HostingPlatform `secret-redaction` workflow
 */

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || 'test-secret-ai-approval-redaction';
// Point any incidentally-created pg Pool at a port that refuses fast so
// the bootstrap IIFE inside aiApprovalRoutes errors immediately instead
// of hanging the test.
process.env.DATABASE_URL =
  process.env.DATABASE_URL || '<REDACTED_DSN>';

import crypto from 'crypto';
import pg from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';

/* ------------------------------------------------------------------ */
/* Stub the platform_users lookup performed by requireRole().         */
/* aiApprovalRoutes is now wrapped in aiApprovalGate() (Task #60),    */
/* which calls requireRole(c, AI_APPROVAL_*_ROLES). requireRole       */
/* delegates to getPlatformUser(email), which queries the private     */
/* `platformPool` inside rbacMiddleware via                           */
/*    SELECT status, role FROM platform_users WHERE email = $1        */
/* The per-instance pool stubs below shadow aiApprovalPool and        */
/* eventLogsPool, but the platformPool is not exported, so we patch   */
/* `pg.Pool.prototype.query` to intercept ONLY that catalog query and */
/* return a synthetic active-role row for the two test identities.    */
/* All other pools have their `.query` shadowed at the instance level */
/* and therefore bypass this prototype patch.                          */
/* ------------------------------------------------------------------ */
const TEST_PLATFORM_USERS: Record<string, { status: string; role: string }> = {
  '<REDACTED_EMAIL>':        { status: 'active', role: 'admin' },
  '<REDACTED_EMAIL>': { status: 'active', role: 'executive' },
};
const _origPoolQuery = pg.Pool.prototype.query;
pg.Pool.prototype.query = function (this: pg.Pool, ...args: unknown[]): any {
  const sql = String((args[0] as { text?: string } | string | undefined) ?? '');
  if (/SELECT status, role FROM platform_users WHERE email\s*=\s*\$1/i.test(sql)) {
    const params = args[1] as ReadonlyArray<unknown> | undefined;
    const email = String(params?.[0] ?? '');
    const row = TEST_PLATFORM_USERS[email];
    return Promise.resolve({
      command: 'SELECT',
      rowCount: row ? 1 : 0,
      oid: 0,
      fields: [],
      rows: row ? [row] : [],
    } as QueryResult<QueryResultRow>);
  }
  return (_origPoolQuery as any).apply(this, args);
} as typeof pg.Pool.prototype.query;

import {
  aiApprovalPool,
  enqueuePendingAction,
  recordExecutionResult,
  type PendingAction,
} from '../src/utils/aiApprovalDatabase';
import { REDACTED_SENTINEL, pool as eventLogsPool } from '../src/utils/eventLogsDatabase';
import { aiApprovalRoutes } from '../src/mastra/routes/aiApprovalRoutes';
import { TOOL_GOVERNANCE_POLICIES } from '../src/utils/aiToolGovernance';
import { withApprovalGate } from '../src/utils/withApprovalGate';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

/* ------------------------------------------------------------------ */
/* In-memory pg stub                                                  */
/* ------------------------------------------------------------------ */

let storedRow: PendingAction | null = null;

type StubQuery = <R extends QueryResultRow>(
  sql: string,
  params?: ReadonlyArray<unknown>,
) => Promise<QueryResult<R>>;

const stubQuery: StubQuery = async <R extends QueryResultRow>(
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<QueryResult<R>> => {
  const empty: QueryResult<R> = {
    command: '',
    rowCount: 0,
    oid: 0,
    fields: [],
    rows: [],
  };

  if (/^\s*CREATE\s+TABLE/i.test(sql) || /^\s*CREATE\s+INDEX/i.test(sql)) {
    return empty;
  }

  if (/INSERT INTO ai_pending_actions/i.test(sql)) {
    storedRow = {
      id: 1,
      action_code: String(params[0]),
      tool_id: String(params[1]),
      tool_label: String(params[2]),
      payload: JSON.parse(String(params[3])),
      payload_preview: String(params[4]),
      payload_checksum: String(params[5]),
      risk_level: params[6] as PendingAction['risk_level'],
      compliance_refs: JSON.parse(String(params[7])),
      requested_by_user_id: params[8] as number | null,
      requested_by_email: params[9] as string | null,
      requested_by_name: params[10] as string | null,
      thread_id: params[11] as string | null,
      status: 'pending',
      reviewed_by_user_id: null,
      reviewed_by_email: null,
      reviewed_by_name: null,
      reviewed_at: null,
      rejection_reason: null,
      executed_at: null,
      execution_result: null,
      result_entity_type: null,
      result_entity_id: null,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 24 * 3600 * 1000),
      credential_warnings: [],
    };
    return {
      ...empty,
      command: 'INSERT',
      rowCount: 1,
      rows: [storedRow as unknown as R],
    };
  }

  if (/UPDATE ai_pending_actions/i.test(sql)) {
    if (!storedRow || storedRow.action_code !== String(params[0])) return empty;
    // claimForApproval: SET status = 'approved', reviewed_by_user_id = $2, ...
    if (/SET\s+status\s*=\s*'approved'/i.test(sql)) {
      storedRow.status = 'approved';
      storedRow.reviewed_by_user_id = params[1] as number | null;
      storedRow.reviewed_by_email = params[2] as string | null;
      storedRow.reviewed_by_name = params[3] as string | null;
      storedRow.reviewed_at = new Date();
      return {
        ...empty,
        command: 'UPDATE',
        rowCount: 1,
        rows: [storedRow as unknown as R],
      };
    }
    // recordExecutionResult: SET status = CASE WHEN $2 THEN 'executed' ELSE 'failed' END
    storedRow.status = (params[1] === true ? 'executed' : 'failed') as PendingAction['status'];
    storedRow.executed_at = new Date();
    storedRow.execution_result = JSON.parse(String(params[2]));
    storedRow.result_entity_type = params[3] as string | null;
    storedRow.result_entity_id = params[4] as string | null;
    return {
      ...empty,
      command: 'UPDATE',
      rowCount: 1,
      rows: [storedRow as unknown as R],
    };
  }

  if (/SELECT \* FROM ai_pending_actions WHERE action_code/i.test(sql)) {
    if (storedRow && storedRow.action_code === String(params[0])) {
      return { ...empty, rowCount: 1, rows: [storedRow as unknown as R] };
    }
    return empty;
  }

  if (/SELECT COUNT\(\*\)::text AS total FROM ai_pending_actions/i.test(sql)) {
    return {
      ...empty,
      rowCount: 1,
      rows: [{ total: storedRow ? '1' : '0' } as unknown as R],
    };
  }

  if (/SELECT COUNT\(\*\)::text AS n FROM ai_pending_actions/i.test(sql)) {
    return {
      ...empty,
      rowCount: 1,
      rows: [{ n: storedRow ? '1' : '0' } as unknown as R],
    };
  }

  // Dedup probe added to enqueuePendingAction():
  //   SELECT * FROM ai_pending_actions
  //    WHERE tool_id = $1 AND payload_checksum = $2 AND status = 'pending' ...
  // It early-returns the matching pending row to collapse duplicate requests.
  // In this test each scenario re-seeds `storedRow` and then approves it, so
  // we must NOT collapse onto a previously-stored (possibly executed) twin —
  // otherwise approve sees a non-pending row and returns 409. Return empty so
  // every enqueue creates a genuinely fresh PENDING row.
  if (
    /SELECT \* FROM ai_pending_actions/i.test(sql) &&
    /payload_checksum/i.test(sql) &&
    /status\s*=\s*'pending'/i.test(sql)
  ) {
    return empty;
  }

  if (/SELECT \* FROM ai_pending_actions/i.test(sql)) {
    return storedRow
      ? { ...empty, rowCount: 1, rows: [storedRow as unknown as R] }
      : empty;
  }

  return empty;
};

aiApprovalPool.query = stubQuery as typeof aiApprovalPool.query;

/* ------------------------------------------------------------------ */
/* event_logs pool stub — captures view-audit writes                  */
/* ------------------------------------------------------------------ */

interface CapturedEventLog {
  user_id: number | null;
  user_email: string | null;
  user_role: string | null;
  action_type: string;
  entity_type: string;
  entity_id: string | null;
  entity_name: string | null;
  description: string | null;
  old_value: string | null;
  new_value: string | null;
  ai_involved: boolean;
  severity: string;
  correlation_id: string | null;
  module: string | null;
}

const capturedEventLogs: CapturedEventLog[] = [];

const eventLogsStubQuery: StubQuery = async <R extends QueryResultRow>(
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<QueryResult<R>> => {
  const empty: QueryResult<R> = {
    command: '',
    rowCount: 0,
    oid: 0,
    fields: [],
    rows: [],
  };

  if (/INSERT INTO event_logs/i.test(sql)) {
    const row: CapturedEventLog = {
      user_id: params[0] as number | null,
      user_email: params[2] as string | null,
      user_role: params[3] as string | null,
      action_type: params[4] as string,
      entity_type: params[5] as string,
      entity_id: params[6] as string | null,
      entity_name: params[7] as string | null,
      description: params[8] as string | null,
      old_value: params[9] as string | null,
      new_value: params[10] as string | null,
      ai_involved: Boolean(params[11]),
      severity: params[12] as string,
      correlation_id: params[13] as string | null,
      module: params[16] as string | null,
    };
    capturedEventLogs.push(row);
    return {
      ...empty,
      command: 'INSERT',
      rowCount: 1,
      rows: [{ id: capturedEventLogs.length, ...row } as unknown as R],
    };
  }

  // getActionViewers — single action code lookup.
  // Returns distinct viewer summaries derived from capturedEventLogs.
  if (/SELECT.*MAX\(timestamp\).*FROM event_logs.*WHERE correlation_id = \$1/is.test(sql)) {
    const code = String(params[0]);
    const viewEvents = capturedEventLogs.filter(
      e =>
        e.correlation_id === code &&
        e.action_type === 'AI_ACTION' &&
        /^Viewed/i.test(e.description ?? ''),
    );
    // Aggregate by (user_id, user_email, user_name, user_role).
    const byUser = new Map<string, CapturedEventLog & { view_count: number }>();
    for (const e of viewEvents) {
      const key = `${e.user_id}|${e.user_email}|${e.user_role}`;
      if (!byUser.has(key)) {
        byUser.set(key, { ...e, view_count: 1 });
      } else {
        byUser.get(key)!.view_count++;
      }
    }
    const viewerRows = [...byUser.values()].map(v => ({
      user_id: v.user_id,
      user_email: v.user_email,
      user_name: null as string | null,
      user_role: v.user_role,
      last_viewed_at: new Date(),
      view_count: String(v.view_count),
    }));
    return {
      ...empty,
      rowCount: viewerRows.length,
      rows: viewerRows as unknown as R[],
    };
  }

  // getActionViewersBatch — multiple action codes via ANY($1).
  if (/SELECT.*correlation_id.*MAX\(timestamp\).*FROM event_logs.*WHERE correlation_id = ANY/is.test(sql)) {
    const codes = (params[0] as string[]) || [];
    const viewerRows: Array<{
      correlation_id: string;
      user_id: number | null;
      user_email: string | null;
      user_name: string | null;
      user_role: string | null;
      last_viewed_at: Date;
      view_count: string;
    }> = [];
    for (const code of codes) {
      const viewEvents = capturedEventLogs.filter(
        e =>
          e.correlation_id === code &&
          e.action_type === 'AI_ACTION' &&
          /^Viewed/i.test(e.description ?? ''),
      );
      const byUser = new Map<string, CapturedEventLog & { view_count: number }>();
      for (const e of viewEvents) {
        const key = `${e.user_id}|${e.user_email}|${e.user_role}`;
        if (!byUser.has(key)) {
          byUser.set(key, { ...e, view_count: 1 });
        } else {
          byUser.get(key)!.view_count++;
        }
      }
      for (const v of byUser.values()) {
        viewerRows.push({
          correlation_id: code,
          user_id: v.user_id,
          user_email: v.user_email,
          user_name: null,
          user_role: v.user_role,
          last_viewed_at: new Date(),
          view_count: String(v.view_count),
        });
      }
    }
    return {
      ...empty,
      rowCount: viewerRows.length,
      rows: viewerRows as unknown as R[],
    };
  }

  return empty;
};

eventLogsPool.query = eventLogsStubQuery as typeof eventLogsPool.query;

/* ------------------------------------------------------------------ */
/* Hono context shim                                                  */
/* ------------------------------------------------------------------ */

function signSession(payload: Record<string, unknown>): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', process.env.SESSION_SECRET!)
    .update(data)
    .digest('base64url');
  return `${data}.${sig}`;
}

function adminCookie(): string {
  const token = signSession({
    userId: 42,
    email: '<REDACTED_EMAIL>',
    name: 'Quality Manager Test',
    role: 'admin',
    exp: Date.now() + 3600_000,
  });
  return `ExampleOrg_session=${encodeURIComponent(token)}`;
}

function requesterCookie(): string {
  // Same userId as `requestedByUserId` on the enqueued action below (99) so
  // this viewer is the requester themselves — the view-audit gate must skip.
  const token = signSession({
    userId: 99,
    email: '<REDACTED_EMAIL>',
    name: 'Requester User',
    role: 'engineer',
    exp: Date.now() + 3600_000,
  });
  return `ExampleOrg_session=${encodeURIComponent(token)}`;
}

interface FakeResponse {
  status: number;
  body: unknown;
}

function makeContext(opts: {
  url: string;
  param?: string;
  cookie?: string;
}): unknown {
  const cookie = opts.cookie ?? adminCookie();
  return {
    req: {
      url: opts.url,
      header: (name: string): string | undefined =>
        name.toLowerCase() === 'cookie' ? cookie : undefined,
      param: (_name: string): string | undefined => opts.param,
      json: async () => ({}),
    },
    json(body: unknown, status = 200): FakeResponse {
      return { status, body };
    },
    html(body: string): FakeResponse {
      return { status: 200, body };
    },
    text(body: string, status = 200): FakeResponse {
      return { status, body };
    },
  };
}

async function callRoute(
  path: string,
  method: 'GET' | 'POST',
  ctx: unknown,
): Promise<FakeResponse> {
  const route = aiApprovalRoutes.find(
    r => r.path === path && r.method === method,
  );
  if (!route) throw new Error(`Route not registered: ${method} ${path}`);
  const handler = await route.createHandler();
  const result = (await handler(ctx as never)) as FakeResponse;
  return result;
}

/* ------------------------------------------------------------------ */
/* Test                                                                */
/* ------------------------------------------------------------------ */

const PAYLOAD_API_KEY = '<REDACTED_SECRET>';
const PAYLOAD_REFRESH = 'rt_LEAK_DETECTOR_REFRESH_qwertyuiopas';
const PAYLOAD_BCRYPT =
  '<REDACTED_PASSWORD_HASH>';

const RESULT_API_KEY = '<REDACTED_SECRET>';
const RESULT_ACCESS_TOKEN = '<REDACTED_SECRET>';

// Credential-shaped substrings interpolated into the FREE-FORM payload_preview
// TEXT column. These reach the row through a different code path than the
// JSONB `payload` deny-list (a tool's buildPreview() callback can paste
// arbitrary strings into the human-readable summary line). Each one targets
// a distinct regex in SECRET_LIKE_PATTERNS so a regression in any single
// pattern is caught here.
const PREVIEW_SK_KEY = '<REDACTED_TOKEN>';
const PREVIEW_GH_TOKEN = '<REDACTED_SECRET>';
const PREVIEW_JWT =
  '<REDACTED_TOKEN>';
const PREVIEW_BCRYPT =
  '<REDACTED_PASSWORD_HASH>';

const SECRETS = [
  PAYLOAD_API_KEY,
  PAYLOAD_REFRESH,
  PAYLOAD_BCRYPT,
  RESULT_API_KEY,
  RESULT_ACCESS_TOKEN,
  PREVIEW_SK_KEY,
  PREVIEW_GH_TOKEN,
  PREVIEW_JWT,
  PREVIEW_BCRYPT,
];

function findLeakedSecret(body: unknown, allowed: string[] = []): string | null {
  const text = JSON.stringify(body);
  for (const sec of SECRETS) {
    if (allowed.includes(sec)) continue;
    if (text.includes(sec)) return sec;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* POST /approve — synthetic gated tool that returns FRESH secrets.   */
/* ------------------------------------------------------------------ */
/* These secrets are intentionally distinct from SECRETS[] above so   */
/* the guard can pinpoint exactly which path leaked, and so the read- */
/* path tests cannot accidentally satisfy the approve-path assertion. */
/* ------------------------------------------------------------------ */

const APPROVE_RESULT_SK_KEY = '<REDACTED_TOKEN>';
const APPROVE_RESULT_GH_TOKEN = '<REDACTED_SECRET>';
// 53 chars after `<REDACTED_PASSWORD_HASH>` so it matches the bcrypt regex exactly.
const APPROVE_RESULT_BCRYPT =
  '<REDACTED_PASSWORD_HASH>';
const APPROVE_RESULT_ACCESS_TOKEN = '<REDACTED_SECRET>';
const APPROVE_THROW_SK_KEY = '<REDACTED_TOKEN>';

const APPROVE_SECRETS = [
  APPROVE_RESULT_SK_KEY,
  APPROVE_RESULT_GH_TOKEN,
  APPROVE_RESULT_BCRYPT,
  APPROVE_RESULT_ACCESS_TOKEN,
  APPROVE_THROW_SK_KEY,
];

function findApproveLeak(body: unknown): string | null {
  const text = JSON.stringify(body);
  for (const sec of APPROVE_SECRETS) {
    if (text.includes(sec)) return sec;
  }
  return null;
}

const APPROVE_OK_TOOL_ID = 'rotate-fake-secret-key__redaction-test-ok';
const APPROVE_THROW_TOOL_ID = 'rotate-fake-secret-key__redaction-test-throws';

function registerFakeGatedTools(): void {
  // Add minimal governance entries so withApprovalGate accepts the wrap.
  // Both are 'high' risk so any role check downstream sees a realistic gate.
  TOOL_GOVERNANCE_POLICIES[APPROVE_OK_TOOL_ID] = {
    toolId: APPROVE_OK_TOOL_ID,
    label: 'Test: Rotate Fake Secret Key (success)',
    riskLevel: 'high',
    requiresApproval: true,
    complianceRefs: ['REDACTION-TEST'],
    entityType: 'integration',
    buildPreview: () => 'Rotate fake secret key (redaction test)',
  };
  TOOL_GOVERNANCE_POLICIES[APPROVE_THROW_TOOL_ID] = {
    toolId: APPROVE_THROW_TOOL_ID,
    label: 'Test: Rotate Fake Secret Key (throws)',
    riskLevel: 'high',
    requiresApproval: true,
    complianceRefs: ['REDACTION-TEST'],
    entityType: 'integration',
    buildPreview: () => 'Rotate fake secret key (throw path)',
  };

  // Synthetic tool whose returned `data` carries fresh secrets across BOTH
  // attack surfaces: object keys flagged by the deny list (`new_api_key`,
  // `access_token`) AND free-form string leaves whose interpolated content
  // is credential-shaped (caught only by the regex deny list).
  withApprovalGate({
    id: APPROVE_OK_TOOL_ID,
    description: 'redaction test tool — returns fresh credentials',
    execute: async () => ({
      success: true,
      rotated: true,
      // Key-deny-list path: `_key` suffix and `access_token` exact match.
      new_api_key: APPROVE_RESULT_SK_KEY,
      access_token: APPROVE_RESULT_ACCESS_TOKEN,
      nested: {
        // String-deny-list path: a non-sensitive key whose VALUE happens to
        // contain a credential-shaped substring (the most realistic leak —
        // a tool author dumps the response body into a `notes` field).
        free_form_note: `Vendor returned: ${APPROVE_RESULT_GH_TOKEN}`,
        legacy_password_hash_blob: APPROVE_RESULT_BCRYPT,
      },
      audit_note: 'Approve-response rotation completed',
    }),
  });

  // Synthetic tool that throws; the catch block must scrub `error.message`
  // so a thrown exception cannot smuggle the secret out as `details`.
  withApprovalGate({
    id: APPROVE_THROW_TOOL_ID,
    description: 'redaction test tool — throws with secret in message',
    execute: async () => {
      throw new Error(`Vendor refused rotation; offending key was ${APPROVE_THROW_SK_KEY}`);
    },
  });
}

async function makePostContext(opts: {
  url: string;
  param: string;
}): Promise<unknown> {
  return {
    req: {
      url: opts.url,
      header: (name: string): string | undefined =>
        name.toLowerCase() === 'cookie' ? adminCookie() : undefined,
      param: (_name: string): string | undefined => opts.param,
      json: async () => ({}),
    },
    json(body: unknown, status = 200): FakeResponse {
      return { status, body };
    },
    html(body: string): FakeResponse {
      return { status: 200, body };
    },
    text(body: string, status = 200): FakeResponse {
      return { status, body };
    },
  };
}

async function runApproveResponseLeakTests(): Promise<void> {
  registerFakeGatedTools();

  /* ---------- Happy path: tool succeeds, returns fresh secrets ---------- */
  // Reset storedRow by enqueuing a fresh action for the success-tool.
  // enqueuePendingAction overwrites storedRow, so the prior 'executed' row
  // from the read-path tests no longer interferes.
  const okAction = await enqueuePendingAction({
    toolId: APPROVE_OK_TOOL_ID,
    toolLabel: 'Test: Rotate Fake Secret Key (success)',
    payload: { target_integration: 'redaction_test', reason: 'approve-test' },
    payloadPreview: 'rotate fake key',
    riskLevel: 'high',
    complianceRefs: ['REDACTION-TEST'],
    requestedByUserId: 99, // != admin (42) → SOD passes
    requestedByEmail: '<REDACTED_EMAIL>',
    requestedByName: 'Requester User',
    threadId: 'thr_approve_redaction_test',
  });

  const okPostRes = await callRoute(
    '/api/ai/approvals/:code/approve',
    'POST',
    await makePostContext({
      url: `<REDACTED_URL>`,
      param: okAction.action_code,
    }),
  );

  assert(
    okPostRes.status === 200,
    `POST /api/ai/approvals/:code/approve (success) → 200 (got ${okPostRes.status}, body=${JSON.stringify(okPostRes.body).slice(0, 200)})`,
  );

  const okBodyText = JSON.stringify(okPostRes.body);
  const okLeak = findApproveLeak(okPostRes.body);
  assert(
    okLeak === null,
    `POST /approve response contains no plaintext secret (leaked: ${okLeak ?? 'none'})`,
  );
  assert(
    okBodyText.includes(REDACTED_SENTINEL),
    'POST /approve response contains the redaction sentinel',
  );
  assert(
    okBodyText.includes('Approve-response rotation completed'),
    'POST /approve response preserves the safe audit_note field',
  );

  // Defense-in-depth — every distinct attack surface is exercised.
  const okBody = okPostRes.body as {
    success: boolean;
    actionCode: string;
    result?: { new_api_key?: string; access_token?: string; nested?: { free_form_note?: string; legacy_password_hash_blob?: string } };
  };
  assert(
    okBody.success === true && okBody.actionCode === okAction.action_code,
    'POST /approve response success=true with actionCode echoed back',
  );
  assert(
    okBody.result?.new_api_key === REDACTED_SENTINEL,
    `POST /approve key-deny-list redacts result.new_api_key (got: ${okBody.result?.new_api_key})`,
  );
  assert(
    okBody.result?.access_token === REDACTED_SENTINEL,
    `POST /approve key-deny-list redacts result.access_token (got: ${okBody.result?.access_token})`,
  );
  assert(
    okBody.result?.nested?.free_form_note?.includes(REDACTED_SENTINEL) === true &&
      okBody.result?.nested?.free_form_note?.includes(APPROVE_RESULT_GH_TOKEN) === false,
    `POST /approve regex-deny-list scrubs interpolated GH token in free-form string (got: ${okBody.result?.nested?.free_form_note})`,
  );
  assert(
    okBody.result?.nested?.legacy_password_hash_blob === REDACTED_SENTINEL,
    `POST /approve key-deny-list redacts nested *_hash field (got: ${okBody.result?.nested?.legacy_password_hash_blob})`,
  );

  /* ---------- Throw path: tool throws with secret in message ---------- */
  const throwAction = await enqueuePendingAction({
    toolId: APPROVE_THROW_TOOL_ID,
    toolLabel: 'Test: Rotate Fake Secret Key (throws)',
    payload: { target_integration: 'redaction_test', reason: 'throw-test' },
    payloadPreview: 'rotate fake key (throws)',
    riskLevel: 'high',
    complianceRefs: ['REDACTION-TEST'],
    requestedByUserId: 99,
    requestedByEmail: '<REDACTED_EMAIL>',
    requestedByName: 'Requester User',
    threadId: 'thr_approve_redaction_throw',
  });

  const throwPostRes = await callRoute(
    '/api/ai/approvals/:code/approve',
    'POST',
    await makePostContext({
      url: `<REDACTED_URL>`,
      param: throwAction.action_code,
    }),
  );

  // executeApprovedAction catches inner errors and returns ok=false with
  // error=message, so the route returns 500 with `success:false`. The body
  // must NOT contain the plaintext secret embedded in the exception.
  assert(
    throwPostRes.status === 500,
    `POST /approve (tool throws) → 500 (got ${throwPostRes.status})`,
  );
  const throwLeak = findApproveLeak(throwPostRes.body);
  assert(
    throwLeak === null,
    `POST /approve (tool throws) response contains no plaintext secret (leaked: ${throwLeak ?? 'none'})`,
  );
  const throwBody = throwPostRes.body as { success: boolean; error?: string };
  assert(
    throwBody.success === false,
    'POST /approve (tool throws) response success=false',
  );
  assert(
    typeof throwBody.error === 'string' &&
      throwBody.error.includes(REDACTED_SENTINEL) &&
      !throwBody.error.includes(APPROVE_THROW_SK_KEY),
    `POST /approve (tool throws) response.error scrubs the embedded secret (got: ${throwBody.error})`,
  );
}

async function run(): Promise<void> {
  console.log('\n=== AI approval-queue HTTP endpoints — secret-leak guard ===\n');

  const enqueued = await enqueuePendingAction({
    toolId: 'rotate_api_key',
    toolLabel: 'Rotate API Key',
    payload: {
      target_integration: 'CRMProvider_books',
      api_key: PAYLOAD_API_KEY,
      refresh_token: PAYLOAD_REFRESH,
      nested: {
        password_hash: PAYLOAD_BCRYPT,
        username: '<REDACTED_EMAIL>',
      },
      reason: 'rotate-CRMProvider-books-key',
    },
    payloadPreview:
      `Rotate API key for CRMProvider_books — new=${PREVIEW_SK_KEY}, ` +
      `gh=${PREVIEW_GH_TOKEN}, jwt=${PREVIEW_JWT}, ` +
      `legacy_hash=${PREVIEW_BCRYPT}`,
    riskLevel: 'high',
    // Intentionally NO `WP-*` codes here so the detail handler skips the
    // controlled-document DB lookup; this test must not depend on a
    // live policies table.
    complianceRefs: ['PCI-DSS-12.3.1', 'ISO 27001:2022 A.5.34'],
    requestedByUserId: 99,
    requestedByEmail: '<REDACTED_EMAIL>',
    requestedByName: 'Requester User',
    threadId: 'thr_redaction_test',
  });

  assert(
    enqueued.payload?.api_key === REDACTED_SENTINEL,
    'baseline: enqueuePendingAction returns redacted payload (sanity check)',
  );

  // Sanity-check the preview scrubber at the data layer before exercising the
  // HTTP surface. Each credential-shaped substring must already be replaced
  // with the sentinel; otherwise the leak-guard assertions below cannot
  // distinguish a route bug from a missing scrub.
  assert(
    findLeakedSecret(enqueued.payload_preview) === null,
    'baseline: enqueued payload_preview is scrubbed of secret-shaped substrings',
  );
  assert(
    enqueued.payload_preview.includes(REDACTED_SENTINEL) &&
      enqueued.payload_preview.includes('CRMProvider_books'),
    'baseline: payload_preview retains human-readable prose around the sentinel',
  );

  /* ---------- GET /api/ai/approvals (list) ---------- */
  const listRes = await callRoute(
    '/api/ai/approvals',
    'GET',
    makeContext({
      url: '<REDACTED_URL>',
    }),
  );

  assert(listRes.status === 200, 'GET /api/ai/approvals → 200');
  const listLeak = findLeakedSecret(listRes.body);
  assert(
    listLeak === null,
    `GET /api/ai/approvals body contains no plaintext secret (leaked: ${listLeak ?? 'none'})`,
  );
  assert(
    JSON.stringify(listRes.body).includes(REDACTED_SENTINEL),
    'GET /api/ai/approvals body contains the redaction sentinel',
  );
  const listBody = listRes.body as {
    success: boolean;
    rows: Array<{
      payload: { target_integration?: string };
      action_code: string;
    }>;
  };
  assert(
    listBody.rows[0]?.payload?.target_integration === 'CRMProvider_books',
    'GET /api/ai/approvals preserves non-sensitive payload fields',
  );

  /* ---------- GET /api/ai/approvals/pending-count ---------- */
  const countRes = await callRoute(
    '/api/ai/approvals/pending-count',
    'GET',
    makeContext({ url: '<REDACTED_URL>' }),
  );
  assert(countRes.status === 200, 'GET /api/ai/approvals/pending-count → 200');
  assert(
    findLeakedSecret(countRes.body) === null,
    'GET /api/ai/approvals/pending-count body contains no plaintext secret',
  );

  /* ---------- GET /api/ai/approvals/:code (pending) ---------- */
  // Reset the captured event-log buffer so the assertions below count only
  // the writes produced by this specific reviewer view.
  capturedEventLogs.length = 0;

  const detailPendingRes = await callRoute(
    '/api/ai/approvals/:code',
    'GET',
    makeContext({
      url: `<REDACTED_URL>`,
      param: enqueued.action_code,
    }),
  );
  assert(detailPendingRes.status === 200, 'GET /api/ai/approvals/:code (pending) → 200');
  const detailPendingLeak = findLeakedSecret(detailPendingRes.body);
  assert(
    detailPendingLeak === null,
    `GET /api/ai/approvals/:code (pending) contains no plaintext secret (leaked: ${detailPendingLeak ?? 'none'})`,
  );
  assert(
    JSON.stringify(detailPendingRes.body).includes(REDACTED_SENTINEL),
    'GET /api/ai/approvals/:code (pending) contains the redaction sentinel',
  );

  /* ---- View-audit trail (Task #70 / PDPL Art. 16, ISO 27001 A.5.37) ---- */
  // The admin viewer is NOT the requester (admin userId=42, requester userId=99)
  // so the GET must have written exactly one AI_ACTION event log carrying
  // the reviewer identity, no payload values, and correlation_id = action_code.
  const viewAuditEvents = capturedEventLogs.filter(
    e => e.action_type === 'AI_ACTION' && /Viewed/i.test(e.description ?? ''),
  );
  assert(
    viewAuditEvents.length === 1,
    `GET /api/ai/approvals/:code by non-requester writes exactly one view-audit event (got ${viewAuditEvents.length})`,
  );

  const viewEvent = viewAuditEvents[0];
  assert(
    viewEvent?.user_id === 42 && viewEvent?.user_email === '<REDACTED_EMAIL>',
    'view-audit event captures reviewer identity (user_id + email)',
  );
  assert(
    viewEvent?.user_role === 'admin',
    'view-audit event captures reviewer role',
  );
  assert(
    viewEvent?.correlation_id === enqueued.action_code,
    'view-audit event correlation_id = action_code (joins approve/reject trail)',
  );
  assert(
    viewEvent?.entity_type === 'SYSTEM' && viewEvent?.entity_id === enqueued.action_code,
    'view-audit event entity_type=SYSTEM and entity_id=action_code',
  );
  assert(
    viewEvent?.severity === 'INFO',
    'view-audit event uses low severity (INFO)',
  );
  assert(
    viewEvent?.module === 'ai-governance' && viewEvent?.ai_involved === true,
    'view-audit event tagged module=ai-governance, ai_involved=true',
  );

  // Critical: the audit row itself must never embed the raw payload values.
  // We serialize EVERY captured field and run it through the same secret
  // detector used for the HTTP responses.
  const viewEventLeak = findLeakedSecret(viewEvent);
  assert(
    viewEventLeak === null,
    `view-audit event row contains no plaintext payload secret (leaked: ${viewEventLeak ?? 'none'})`,
  );
  assert(
    viewEvent?.old_value === null && viewEvent?.new_value === null,
    'view-audit event carries no old/new value blobs (description-only entry)',
  );

  /* ---- prior_viewers field (Task #86) ---- */
  // The admin viewer already triggered the logEvent above (awaited), so the
  // capturedEventLogs buffer already contains the view event. The stub query
  // returns those logs as viewer summaries, so prior_viewers must be populated.
  const detailBody = detailPendingRes.body as {
    success: boolean;
    action: unknown;
    prior_viewers?: Array<{
      user_id: number | null;
      user_email: string | null;
      user_role: string | null;
      view_count: number;
    }>;
  };
  assert(
    Array.isArray(detailBody.prior_viewers),
    'GET /api/ai/approvals/:code response includes prior_viewers array',
  );
  assert(
    (detailBody.prior_viewers?.length ?? 0) >= 1,
    `prior_viewers contains at least one entry after admin view (got ${detailBody.prior_viewers?.length ?? 0})`,
  );
  const adminViewer = detailBody.prior_viewers?.find(v => v.user_id === 42);
  assert(
    adminViewer !== undefined,
    'prior_viewers includes the admin reviewer (user_id=42)',
  );
  assert(
    adminViewer?.user_email === '<REDACTED_EMAIL>',
    `prior_viewers entry has correct email (got: ${adminViewer?.user_email})`,
  );
  assert(
    adminViewer?.user_role === 'admin',
    `prior_viewers entry has correct role (got: ${adminViewer?.user_role})`,
  );
  assert(
    typeof adminViewer?.view_count === 'number' && adminViewer.view_count >= 1,
    `prior_viewers entry has numeric view_count >= 1 (got: ${adminViewer?.view_count})`,
  );
  // Security: the prior_viewers summary must contain no payload secrets.
  const priorViewersLeak = findLeakedSecret(detailBody.prior_viewers);
  assert(
    priorViewersLeak === null,
    `prior_viewers contains no plaintext payload secret (leaked: ${priorViewersLeak ?? 'none'})`,
  );

  /* ---- Requester self-view must NOT trigger a view-audit (gated) ---- */
  capturedEventLogs.length = 0;
  const detailRequesterRes = await callRoute(
    '/api/ai/approvals/:code',
    'GET',
    makeContext({
      url: `<REDACTED_URL>`,
      param: enqueued.action_code,
      cookie: requesterCookie(),
    }),
  );
  assert(
    detailRequesterRes.status === 200,
    'GET /api/ai/approvals/:code (requester self-view) → 200',
  );
  const requesterViewEvents = capturedEventLogs.filter(
    e => e.action_type === 'AI_ACTION' && /Viewed/i.test(e.description ?? ''),
  );
  assert(
    requesterViewEvents.length === 0,
    `requester self-view does NOT emit a view-audit event (got ${requesterViewEvents.length}, gate failed)`,
  );

  /* ---- Idempotency-per-call: a second non-requester GET writes one more event ---- */
  capturedEventLogs.length = 0;
  await callRoute(
    '/api/ai/approvals/:code',
    'GET',
    makeContext({
      url: `<REDACTED_URL>`,
      param: enqueued.action_code,
    }),
  );
  const secondViewEvents = capturedEventLogs.filter(
    e => e.action_type === 'AI_ACTION' && /Viewed/i.test(e.description ?? ''),
  );
  assert(
    secondViewEvents.length === 1,
    `each non-requester reviewer view emits exactly one view-audit event (got ${secondViewEvents.length})`,
  );

  /* Record an execution result whose returned `data` also contains fresh
     credentials, then re-fetch via every read endpoint. */
  await recordExecutionResult(enqueued.action_code, {
    success: true,
    entityType: 'integration',
    entityId: 'CRMProvider_books',
    data: {
      rotated: true,
      new_api_key: RESULT_API_KEY,
      access_token: RESULT_ACCESS_TOKEN,
      audit_note: 'Rotation completed successfully',
    },
  });

  /* ---------- GET /api/ai/approvals/:code (executed) ---------- */
  capturedEventLogs.length = 0;
  const detailExecRes = await callRoute(
    '/api/ai/approvals/:code',
    'GET',
    makeContext({
      url: `<REDACTED_URL>`,
      param: enqueued.action_code,
    }),
  );
  assert(detailExecRes.status === 200, 'GET /api/ai/approvals/:code (executed) → 200');
  const detailExecText = JSON.stringify(detailExecRes.body);
  const detailExecLeak = findLeakedSecret(detailExecRes.body);
  assert(
    detailExecLeak === null,
    `GET /api/ai/approvals/:code (executed) contains no plaintext secret (leaked: ${detailExecLeak ?? 'none'})`,
  );
  assert(
    detailExecText.includes(REDACTED_SENTINEL),
    'GET /api/ai/approvals/:code (executed) execution_result contains the redaction sentinel',
  );
  assert(
    detailExecText.includes('Rotation completed successfully'),
    'GET /api/ai/approvals/:code (executed) preserves the safe audit_note field',
  );

  /* ---- View-audit on a non-pending row uses status-aware wording ---- */
  const execViewEvents = capturedEventLogs.filter(
    e => e.action_type === 'AI_ACTION' && /Viewed/i.test(e.description ?? ''),
  );
  assert(
    execViewEvents.length === 1,
    `non-requester GET on executed action also writes one view-audit event (got ${execViewEvents.length})`,
  );
  assert(
    execViewEvents[0]?.description?.includes('Viewed executed AI action') === true,
    `view-audit description reflects current status (got: "${execViewEvents[0]?.description}")`,
  );

  /* ---------- GET /api/ai/approvals (after execution) ---------- */
  const listExecRes = await callRoute(
    '/api/ai/approvals',
    'GET',
    makeContext({
      url: '<REDACTED_URL>',
    }),
  );
  assert(listExecRes.status === 200, 'GET /api/ai/approvals?status=executed → 200');
  const listExecLeak = findLeakedSecret(listExecRes.body);
  assert(
    listExecLeak === null,
    `GET /api/ai/approvals?status=executed contains no plaintext secret (leaked: ${listExecLeak ?? 'none'})`,
  );
  assert(
    JSON.stringify(listExecRes.body).includes(REDACTED_SENTINEL),
    'GET /api/ai/approvals?status=executed contains the redaction sentinel for execution_result',
  );

  /* ================================================================== */
  /* POST /api/ai/approvals/:code/approve                                */
  /* ------------------------------------------------------------------ */
  /* The approve handler echoes the underlying tool's return value back  */
  /* to the browser. For rotation/refresh tools that means the freshly-  */
  /* minted credential is one synchronous response away from the         */
  /* attacker. The DB-side `recordExecutionResult` already redacts the   */
  /* JSONB column, but the HTTP response is the most-fresh, most-        */
  /* dangerous exposure of the same value, so it MUST also be scrubbed.  */
  /* ================================================================== */

  await runApproveResponseLeakTests();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\n❌ AI approval-queue secret-leak guard FAILED');
    process.exit(1);
  }
  console.log('\n✅ All AI approval-queue read endpoints redact secrets');
}

run()
  .catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
  })
  .finally(() => {
    void aiApprovalPool.end().catch(() => { /* stubbed pool — ignore */ });
    // The route module's bootstrap IIFE opens incidental pg Pools
    // (policies, controlled-doc registry) that hold handles open even
    // after their queries fail; force-exit so the test always terminates.
    setTimeout(() => process.exit(failed > 0 ? 1 : 0), 250).unref();
  });
