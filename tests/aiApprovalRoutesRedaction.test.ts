/**
 * Guards every AI approval-queue read endpoint against leaking the
 * plaintext payload / execution_result secrets that the data layer
 * already masks at write time.
 *
 * Run:    npx tsx tests/aiApprovalRoutesRedaction.test.ts
 * Wired:  scripts/post-merge.sh + .replit `secret-redaction` workflow
 */

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || 'test-secret-ai-approval-redaction';
// Point any incidentally-created pg Pool at a port that refuses fast so
// the bootstrap IIFE inside aiApprovalRoutes errors immediately instead
// of hanging the test.
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://localhost:1/none';

import crypto from 'crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import {
  aiApprovalPool,
  enqueuePendingAction,
  recordExecutionResult,
  type PendingAction,
} from '../src/utils/aiApprovalDatabase';
import { REDACTED_SENTINEL, pool as eventLogsPool } from '../src/utils/eventLogsDatabase';
import { aiApprovalRoutes } from '../src/mastra/routes/aiApprovalRoutes';

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
    email: 'qm@walaplus.test',
    name: 'Quality Manager Test',
    role: 'admin',
    exp: Date.now() + 3600_000,
  });
  return `walaplus_session=${encodeURIComponent(token)}`;
}

function requesterCookie(): string {
  // Same userId as `requestedByUserId` on the enqueued action below (99) so
  // this viewer is the requester themselves — the view-audit gate must skip.
  const token = signSession({
    userId: 99,
    email: 'requester@walaplus.test',
    name: 'Requester User',
    role: 'engineer',
    exp: Date.now() + 3600_000,
  });
  return `walaplus_session=${encodeURIComponent(token)}`;
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

const PAYLOAD_API_KEY = 'sk-live-LEAK_DETECTOR_PAYLOAD_9z8y7x6w5v';
const PAYLOAD_REFRESH = 'rt_LEAK_DETECTOR_REFRESH_qwertyuiopas';
const PAYLOAD_BCRYPT =
  '$2b$12$abcdefghijklmnopqrstuvLEAKDETECTORHASH1234567890ABCDE';

const RESULT_API_KEY = 'sk-live-LEAK_DETECTOR_RESULT_FRESHKEY_4321';
const RESULT_ACCESS_TOKEN = 'eyJhbGciLEAKDETECTORACCESS_freshtoken';

// Credential-shaped substrings interpolated into the FREE-FORM payload_preview
// TEXT column. These reach the row through a different code path than the
// JSONB `payload` deny-list (a tool's buildPreview() callback can paste
// arbitrary strings into the human-readable summary line). Each one targets
// a distinct regex in SECRET_LIKE_PATTERNS so a regression in any single
// pattern is caught here.
const PREVIEW_SK_KEY = 'sk-live-LEAK_DETECTOR_PREVIEW_aabbccddeeff112233';
const PREVIEW_GH_TOKEN = 'ghp_LEAKDETECTORPREVIEWghp1234567890abcdefghij';
const PREVIEW_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJMRUFLREVURUNUT1JQUkVWSUVXIn0.LEAKDETECTORPREVIEWsignatureXYZ';
const PREVIEW_BCRYPT =
  '$2b$12$ABCDEFGHIJKLMNOPQRSTUVLEAKDETECTORPREVIEW1234567890XYZ';

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

async function run(): Promise<void> {
  console.log('\n=== AI approval-queue HTTP endpoints — secret-leak guard ===\n');

  const enqueued = await enqueuePendingAction({
    toolId: 'rotate_api_key',
    toolLabel: 'Rotate API Key',
    payload: {
      target_integration: 'zoho_books',
      api_key: PAYLOAD_API_KEY,
      refresh_token: PAYLOAD_REFRESH,
      nested: {
        password_hash: PAYLOAD_BCRYPT,
        username: 'svc-zoho@walaplus.test',
      },
      reason: 'rotate-zoho-books-key',
    },
    payloadPreview:
      `Rotate API key for zoho_books — new=${PREVIEW_SK_KEY}, ` +
      `gh=${PREVIEW_GH_TOKEN}, jwt=${PREVIEW_JWT}, ` +
      `legacy_hash=${PREVIEW_BCRYPT}`,
    riskLevel: 'high',
    // Intentionally NO `WP-*` codes here so the detail handler skips the
    // controlled-document DB lookup; this test must not depend on a
    // live policies table.
    complianceRefs: ['PCI-DSS-12.3.1', 'ISO 27001:2022 A.5.34'],
    requestedByUserId: 99,
    requestedByEmail: 'requester@walaplus.test',
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
      enqueued.payload_preview.includes('zoho_books'),
    'baseline: payload_preview retains human-readable prose around the sentinel',
  );

  /* ---------- GET /api/ai/approvals (list) ---------- */
  const listRes = await callRoute(
    '/api/ai/approvals',
    'GET',
    makeContext({
      url: 'https://test.local/api/ai/approvals?status=pending,approved,executed,failed,rejected,expired',
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
    listBody.rows[0]?.payload?.target_integration === 'zoho_books',
    'GET /api/ai/approvals preserves non-sensitive payload fields',
  );

  /* ---------- GET /api/ai/approvals/pending-count ---------- */
  const countRes = await callRoute(
    '/api/ai/approvals/pending-count',
    'GET',
    makeContext({ url: 'https://test.local/api/ai/approvals/pending-count' }),
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
      url: `https://test.local/api/ai/approvals/${enqueued.action_code}`,
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
    viewEvent?.user_id === 42 && viewEvent?.user_email === 'qm@walaplus.test',
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

  /* ---- Requester self-view must NOT trigger a view-audit (gated) ---- */
  capturedEventLogs.length = 0;
  const detailRequesterRes = await callRoute(
    '/api/ai/approvals/:code',
    'GET',
    makeContext({
      url: `https://test.local/api/ai/approvals/${enqueued.action_code}`,
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
      url: `https://test.local/api/ai/approvals/${enqueued.action_code}`,
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
    entityId: 'zoho_books',
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
      url: `https://test.local/api/ai/approvals/${enqueued.action_code}`,
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
      url: 'https://test.local/api/ai/approvals?status=executed',
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
