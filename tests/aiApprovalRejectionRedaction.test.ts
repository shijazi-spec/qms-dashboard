/**
 * Guards the AI approval-queue rejection-note free-text TEXT column against
 * leaking credential-shaped substrings that a reviewer pastes verbatim into
 * the reject dialog. The data layer must run the `reason` argument through
 * `redactSecretLikeStrings` BEFORE persisting so that no downstream read
 * endpoint (list, detail, count) and no audit export can re-leak the
 * original secret.
 *
 * Sibling to `tests/aiApprovalRoutesRedaction.test.ts` (which covers the
 * `payload` / `payload_preview` / `execution_result` columns).
 *
 * Run:    npx tsx tests/aiApprovalRejectionRedaction.test.ts
 * Wired:  scripts/post-merge.sh + .replit `secret-redaction` workflow
 */

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || 'test-secret-ai-approval-rejection-redaction';
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
  rejectAction,
  type PendingAction,
} from '../src/utils/aiApprovalDatabase';
import { REDACTED_SENTINEL } from '../src/utils/eventLogsDatabase';
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

  // The rejectAction UPDATE sets status='rejected' and writes the
  // (post-redaction) reason into rejection_reason. Match it on the SET
  // clause so we don't conflate it with the recordExecutionResult UPDATE.
  if (/UPDATE ai_pending_actions/i.test(sql) && /rejection_reason/i.test(sql)) {
    if (!storedRow || storedRow.action_code !== String(params[0])) return empty;
    if (storedRow.status !== 'pending') return empty;
    storedRow.status = 'rejected';
    storedRow.reviewed_by_user_id = params[1] as number | null;
    storedRow.reviewed_by_email = params[2] as string | null;
    storedRow.reviewed_by_name = params[3] as string | null;
    storedRow.reviewed_at = new Date();
    storedRow.rejection_reason = params[4] as string | null;
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

// One credential-shaped substring per regex family that
// `redactSecretLikeStrings` is supposed to catch when it appears inline in
// the reviewer's rejection prose. A regression in any single pattern is
// caught here.
const REASON_SK_KEY = 'sk-live-LEAK_DETECTOR_REJECTION_aabbccddeeff112233';
const REASON_GH_TOKEN = 'ghp_LEAKDETECTORREJECTIONghp1234567890abcdefghij';
const REASON_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJMRUFLREVURUNUT1JSRUpFQ1RJT04ifQ.LEAKDETECTORREJECTIONsignatureXYZ';
const REASON_BCRYPT =
  '$2b$12$ABCDEFGHIJKLMNOPQRSTUVLEAKDETECTORREJECTION12345678XYZ';

const SECRETS = [REASON_SK_KEY, REASON_GH_TOKEN, REASON_JWT, REASON_BCRYPT];

function findLeakedSecret(body: unknown): string | null {
  const text = JSON.stringify(body);
  for (const sec of SECRETS) {
    if (text.includes(sec)) return sec;
  }
  return null;
}

const REASON_PROSE_PREFIX =
  'Rejecting because the new key ';
const REASON =
  `${REASON_PROSE_PREFIX}${REASON_SK_KEY} is wrong; ` +
  `also the github token ${REASON_GH_TOKEN} was committed, ` +
  `the user-supplied jwt ${REASON_JWT} is invalid, ` +
  `and the legacy hash ${REASON_BCRYPT} must be rotated.`;

async function run(): Promise<void> {
  console.log(
    '\n=== AI approval-queue rejection-note — secret-leak guard ===\n',
  );

  const enqueued = await enqueuePendingAction({
    toolId: 'rotate_api_key',
    toolLabel: 'Rotate API Key',
    payload: {
      target_integration: 'zoho_books',
      reason: 'rotate-zoho-books-key',
    },
    payloadPreview: 'Rotate API key for zoho_books',
    riskLevel: 'high',
    // Intentionally NO `WP-*` codes here so the detail handler skips the
    // controlled-document DB lookup; this test must not depend on a
    // live policies table.
    complianceRefs: ['PCI-DSS-12.3.1', 'ISO 27001:2022 A.5.34'],
    requestedByUserId: 99,
    requestedByEmail: 'requester@walaplus.test',
    requestedByName: 'Requester User',
    threadId: 'thr_rejection_redaction_test',
  });

  // -----------------------------------------------------------------------
  // Sanity-check the data layer first: the rejection_reason returned from
  // the rejectAction call MUST already have every credential-shaped
  // substring replaced with the sentinel; otherwise the leak-guard
  // assertions below cannot distinguish a route-handler bug from a missing
  // store-side scrub.
  // -----------------------------------------------------------------------
  const rejected = await rejectAction(
    enqueued.action_code,
    {
      userId: 42,
      email: 'qm@walaplus.test',
      name: 'Quality Manager Test',
    },
    REASON,
  );

  assert(rejected !== null, 'rejectAction returned a row');
  assert(
    rejected?.status === 'rejected',
    'rejectAction transitioned the row to status=rejected',
  );
  assert(
    findLeakedSecret(rejected?.rejection_reason) === null,
    'baseline: rejectAction return value scrubs secret-shaped substrings',
  );
  assert(
    !!rejected?.rejection_reason &&
      rejected.rejection_reason.includes(REDACTED_SENTINEL),
    'baseline: rejection_reason contains the redaction sentinel',
  );
  assert(
    !!rejected?.rejection_reason &&
      rejected.rejection_reason.includes('Rejecting because the new key'),
    'baseline: rejection_reason retains human-readable prose around the sentinel',
  );

  /* ---------- GET /api/ai/approvals (list, includes rejected) ---------- */
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
    `GET /api/ai/approvals body contains no plaintext secret in rejection_reason (leaked: ${listLeak ?? 'none'})`,
  );
  assert(
    JSON.stringify(listRes.body).includes(REDACTED_SENTINEL),
    'GET /api/ai/approvals body propagates the redaction sentinel from rejection_reason',
  );
  const listBody = listRes.body as {
    rows: Array<{ rejection_reason: string | null; status: string }>;
  };
  assert(
    listBody.rows[0]?.status === 'rejected' &&
      typeof listBody.rows[0]?.rejection_reason === 'string',
    'GET /api/ai/approvals exposes the rejected row with a rejection_reason field',
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

  /* ---------- GET /api/ai/approvals/:code (rejected) ---------- */
  const detailRes = await callRoute(
    '/api/ai/approvals/:code',
    'GET',
    makeContext({
      url: `https://test.local/api/ai/approvals/${enqueued.action_code}`,
      param: enqueued.action_code,
    }),
  );
  assert(
    detailRes.status === 200,
    'GET /api/ai/approvals/:code (rejected) → 200',
  );
  const detailLeak = findLeakedSecret(detailRes.body);
  assert(
    detailLeak === null,
    `GET /api/ai/approvals/:code (rejected) contains no plaintext secret in rejection_reason (leaked: ${detailLeak ?? 'none'})`,
  );
  assert(
    JSON.stringify(detailRes.body).includes(REDACTED_SENTINEL),
    'GET /api/ai/approvals/:code (rejected) propagates the redaction sentinel from rejection_reason',
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\n❌ AI approval-queue rejection-note secret-leak guard FAILED');
    process.exit(1);
  }
  console.log('\n✅ Rejection notes are scrubbed before reaching any read endpoint');
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
