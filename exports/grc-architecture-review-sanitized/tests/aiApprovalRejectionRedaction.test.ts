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
 * Wired:  scripts/post-merge.sh + .HostingPlatform `secret-redaction` workflow
 */

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || 'test-secret-ai-approval-rejection-redaction';
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
/* (Mirrors the fix in tests/aiApprovalRoutesRedaction.test.ts.)      */
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
  rejectAction,
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
      credential_warnings: [],
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
    email: '<REDACTED_EMAIL>',
    name: 'Quality Manager Test',
    role: 'admin',
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

// One credential-shaped substring per regex family that
// `redactSecretLikeStrings` is supposed to catch when it appears inline in
// the reviewer's rejection prose. A regression in any single pattern is
// caught here.
const REASON_SK_KEY = '<REDACTED_TOKEN>';
const REASON_GH_TOKEN = '<REDACTED_SECRET>';
const REASON_JWT =
  '<REDACTED_TOKEN>';
const REASON_BCRYPT =
  '<REDACTED_PASSWORD_HASH>';

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
  `also the SourceControlProvider token ${REASON_GH_TOKEN} was committed, ` +
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
      target_integration: 'CRMProvider_books',
      reason: 'rotate-CRMProvider-books-key',
    },
    payloadPreview: 'Rotate API key for CRMProvider_books',
    riskLevel: 'high',
    // Intentionally NO `WP-*` codes here so the detail handler skips the
    // controlled-document DB lookup; this test must not depend on a
    // live policies table.
    complianceRefs: ['PCI-DSS-12.3.1', 'ISO 27001:2022 A.5.34'],
    requestedByUserId: 99,
    requestedByEmail: '<REDACTED_EMAIL>',
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
      email: '<REDACTED_EMAIL>',
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
      url: '<REDACTED_URL>',
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
    makeContext({ url: '<REDACTED_URL>' }),
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
      url: `<REDACTED_URL>`,
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

  /* ---------- POST /api/ai/approvals/:code/reject — audit-log description ----------
   * Reset the stored row to 'pending' so the reject handler will accept it,
   * then intercept the event_logs INSERT to verify the description that
   * reaches the audit trail is scrubbed rather than the raw reason string.
   * -------------------------------------------------------------------------*/
  console.log('\n--- audit-log description redaction (reject route handler) ---');

  if (storedRow) storedRow.status = 'pending';

  // Cast the initializer to keep TS from narrowing the variable's type to
  // `undefined` (which would make the `typeof === 'string'` check below
   // refine to `never` since assignments inside the async closure aren't
   // tracked by control-flow analysis).
  let capturedEventLogDescription = undefined as string | null | undefined;

  const originalEventLogQuery = eventLogsPool.query.bind(eventLogsPool);
  // Intercept event_logs INSERTs to capture the description that reaches the
  // audit trail.  The stub is cast through `unknown` — not `any` — because pg's
  // Pool.query is a heavily overloaded function whose full signature cannot be
  // fully satisfied by a simple async stub without a double-cast.
  const eventLogStub = async (
    sql: string | { text: string },
    params?: ReadonlyArray<unknown>,
  ): Promise<QueryResult<QueryResultRow>> => {
    const sqlText = typeof sql === 'string' ? sql : sql.text;
    if (/INSERT INTO event_logs/i.test(sqlText) && Array.isArray(params)) {
      capturedEventLogDescription = params[8] as string | null;
      return {
        command: 'INSERT',
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: [{ id: 999, timestamp: new Date(), created_at: new Date() }],
      };
    }
    return { command: '', rowCount: 0, oid: 0, fields: [], rows: [] };
  };
  eventLogsPool.query = eventLogStub as unknown as typeof eventLogsPool.query;

  const rejectCtx = {
    req: {
      url: `<REDACTED_URL>`,
      header: (name: string): string | undefined =>
        name.toLowerCase() === 'cookie' ? adminCookie() : undefined,
      param: (_name: string): string => enqueued.action_code,
      json: async () => ({ reason: REASON }),
    },
    json(body: unknown, status = 200) { return { status, body }; },
    html(body: string) { return { status: 200, body }; },
    text(body: string, status = 200) { return { status, body }; },
  };

  const rejectRoute = aiApprovalRoutes.find(
    r => r.path === '/api/ai/approvals/:code/reject' && r.method === 'POST',
  );
  if (!rejectRoute) throw new Error('Reject route not found');
  const rejectHandler = await rejectRoute.createHandler();
  let rejectRes: { status: number; body: unknown } = { status: 0, body: null };
  try {
    rejectRes = (await rejectHandler(rejectCtx as never)) as { status: number; body: unknown };
  } finally {
    eventLogsPool.query = originalEventLogQuery;
  }

  assert(rejectRes.status === 200, 'POST /api/ai/approvals/:code/reject → 200');
  assert(
    capturedEventLogDescription !== undefined,
    'reject handler called logEvent (event_logs INSERT was intercepted)',
  );
  const descriptionLeak = findLeakedSecret(capturedEventLogDescription);
  assert(
    descriptionLeak === null,
    `audit-log description contains no plaintext secret (leaked: ${descriptionLeak ?? 'none'})`,
  );
  assert(
    typeof capturedEventLogDescription === 'string' &&
      capturedEventLogDescription.includes(REDACTED_SENTINEL),
    'audit-log description contains the redaction sentinel',
  );
  assert(
    typeof capturedEventLogDescription === 'string' &&
      capturedEventLogDescription.includes('Rejecting because the new key'),
    'audit-log description retains human-readable prose around the sentinel',
  );

  /* ---------- POST /api/ai/approvals/:code/reject — error.message redaction ----------
   * Force the reject handler into its catch block by making c.req.param()
   * throw a credential-bearing exception, then verify the 500 response's
   * `details` field has been scrubbed by `redactSecretLikeStrings`. This is
   * the leak surface task-278 closes: the handler used to echo
   * `error.message` verbatim, which would expose any secret a thrown
   * exception happened to interpolate into its message.
   * -------------------------------------------------------------------------*/
  console.log('\n--- catch-block details redaction (reject route handler) ---');

  // One credential-shaped substring per regex family this guard covers.
  const ERR_SK_KEY = '<REDACTED_TOKEN>';
  const ERR_GH_TOKEN = '<REDACTED_SECRET>';
  const ERR_JWT =
    '<REDACTED_TOKEN>';
  const ERR_BCRYPT =
    '<REDACTED_PASSWORD_HASH>';
  const ERR_SECRETS = [ERR_SK_KEY, ERR_GH_TOKEN, ERR_JWT, ERR_BCRYPT];

  function findErrLeak(body: unknown): string | null {
    const text = JSON.stringify(body);
    for (const sec of ERR_SECRETS) {
      if (text.includes(sec)) return sec;
    }
    return null;
  }

  const errMessage =
    `DB connection refused while loading approval ` +
    `(api_key=${ERR_SK_KEY}, gh=${ERR_GH_TOKEN}, ` +
    `jwt=${ERR_JWT}, legacy_hash=${ERR_BCRYPT})`;

  const throwCtx = {
    req: {
      url: '<REDACTED_URL>',
      header: (name: string): string | undefined =>
        name.toLowerCase() === 'cookie' ? adminCookie() : undefined,
      // Force the handler into its catch block with a message that bundles
      // every credential-shaped substring the redactor is supposed to strip.
      param: (_name: string): string => {
        throw new Error(errMessage);
      },
      json: async () => ({ reason: REASON }),
    },
    json(body: unknown, status = 200) { return { status, body }; },
    html(body: string) { return { status: 200, body }; },
    text(body: string, status = 200) { return { status, body }; },
  };

  const throwRes = (await rejectHandler(throwCtx as never)) as { status: number; body: unknown };

  assert(
    throwRes.status === 500,
    `POST /api/ai/approvals/:code/reject (catch path) → 500 (got ${throwRes.status})`,
  );

  const errBody = throwRes.body as { error?: string; details?: string };
  assert(
    errBody.error === 'Failed to reject',
    `catch-path response carries the generic error label (got: ${errBody.error})`,
  );

  const errLeak = findErrLeak(throwRes.body);
  assert(
    errLeak === null,
    `catch-path response.details contains no plaintext secret (leaked: ${errLeak ?? 'none'})`,
  );
  assert(
    typeof errBody.details === 'string' &&
      errBody.details.includes(REDACTED_SENTINEL),
    `catch-path response.details contains the redaction sentinel (got: ${errBody.details})`,
  );
  assert(
    typeof errBody.details === 'string' &&
      errBody.details.includes('DB connection refused'),
    `catch-path response.details retains human-readable prose around the sentinel (got: ${errBody.details})`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\n❌ AI approval-queue rejection-note secret-leak guard FAILED');
    process.exit(1);
  }
  console.log('\n✅ Rejection notes are scrubbed before reaching any read endpoint or audit log');
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
