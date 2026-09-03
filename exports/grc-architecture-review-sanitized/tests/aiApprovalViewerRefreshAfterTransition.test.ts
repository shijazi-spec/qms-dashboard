/**
 * Task #299 — Viewer-list refresh after a status transition.
 *
 * Verifies that the `prior_viewers` panel surfaced by the AI-approvals
 * dashboard keeps tracking reviewer activity AFTER the action has been
 * approved/executed or rejected. Reviewers may legitimately re-open the
 * card to inspect the (redacted) execution_result or the rejection_reason,
 * and those view-audit rows must:
 *
 *   1. Be picked up by `getActionViewers(actionCode)` on the next
 *      detail-page fetch.
 *   2. Be picked up by `getActionViewersBatch([...])` (used by the
 *      dashboard's 30-second auto-refresh of the queue list).
 *
 * Why a dedicated test:
 *   `aiApprovalRoutesRedaction.test.ts` only proves prior_viewers is
 *   populated WHILE the action is still pending. It never re-views the
 *   card after the status flips, so a regression in either viewer query
 *   (or in the post-decision logEvent inside the route) would silently
 *   stop refreshing the chips. This file exercises both transitions and
 *   simulates the dashboard auto-refresh by re-calling GET /api/ai/approvals.
 *
 * Run:    npx tsx tests/aiApprovalViewerRefreshAfterTransition.test.ts
 * Wired:  tests/runIntegrationTests.ts (auto-discovered) + npm test.
 */

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || 'test-secret-viewer-refresh-after-transition';
// Point any incidentally-created pg Pool at a port that refuses fast so the
// bootstrap IIFE inside aiApprovalRoutes errors immediately instead of
// hanging the test.
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://localhost:1/none';

import crypto from 'crypto';
import pg from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';

/* ------------------------------------------------------------------ */
/* Stub the platform_users lookup performed by requireRole().         */
/* Mirrors aiApprovalRoutesRedaction.test.ts so the route's RBAC      */
/* gate accepts our two synthetic admin reviewers.                    */
/* ------------------------------------------------------------------ */
const TEST_PLATFORM_USERS: Record<string, { status: string; role: string }> = {
  'user@example.invalid': { status: 'active', role: 'admin' },
  'user@example.invalid': { status: 'active', role: 'quality_manager' },
  'user@example.invalid': { status: 'active', role: 'executive' },
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
  claimForApproval,
  recordExecutionResult,
  rejectAction,
  type PendingAction,
} from '../src/utils/aiApprovalDatabase';
import {
  pool as eventLogsPool,
  getActionViewers,
  getActionViewersBatch,
} from '../src/utils/eventLogsDatabase';
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
/* In-memory ai_pending_actions stub                                  */
/* ------------------------------------------------------------------ */
/* Keyed by action_code so we can drive multiple parallel rows (one   */
/* for the approve scenario and one for the reject scenario) through  */
/* the same suite without state bleed.                                 */
/* ------------------------------------------------------------------ */

const storedRows = new Map<string, PendingAction>();

type StubQuery = <R extends QueryResultRow>(
  sql: string,
  params?: ReadonlyArray<unknown>,
) => Promise<QueryResult<R>>;

const aiStubQuery: StubQuery = async <R extends QueryResultRow>(
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
    const code = String(params[0]);
    const row: PendingAction = {
      id: storedRows.size + 1,
      action_code: code,
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
    storedRows.set(code, row);
    return {
      ...empty,
      command: 'INSERT',
      rowCount: 1,
      rows: [row as unknown as R],
    };
  }

  if (/UPDATE ai_pending_actions/i.test(sql)) {
    const code = String(params[0]);
    const row = storedRows.get(code);
    if (!row) return empty;

    if (/SET\s+status\s*=\s*'approved'/i.test(sql)) {
      row.status = 'approved';
      row.reviewed_by_user_id = params[1] as number | null;
      row.reviewed_by_email = params[2] as string | null;
      row.reviewed_by_name = params[3] as string | null;
      row.reviewed_at = new Date();
      return { ...empty, command: 'UPDATE', rowCount: 1, rows: [row as unknown as R] };
    }

    if (/SET\s+status\s*=\s*'rejected'/i.test(sql)) {
      row.status = 'rejected';
      row.reviewed_by_user_id = params[1] as number | null;
      row.reviewed_by_email = params[2] as string | null;
      row.reviewed_by_name = params[3] as string | null;
      row.reviewed_at = new Date();
      row.rejection_reason = params[4] as string | null;
      return { ...empty, command: 'UPDATE', rowCount: 1, rows: [row as unknown as R] };
    }

    // recordExecutionResult: SET status = CASE WHEN $2 THEN 'executed' ELSE 'failed' END
    row.status = (params[1] === true ? 'executed' : 'failed') as PendingAction['status'];
    row.executed_at = new Date();
    row.execution_result = JSON.parse(String(params[2]));
    row.result_entity_type = params[3] as string | null;
    row.result_entity_id = params[4] as string | null;
    return { ...empty, command: 'UPDATE', rowCount: 1, rows: [row as unknown as R] };
  }

  if (/SELECT \* FROM ai_pending_actions WHERE action_code/i.test(sql)) {
    const row = storedRows.get(String(params[0]));
    return row ? { ...empty, rowCount: 1, rows: [row as unknown as R] } : empty;
  }

  if (/SELECT COUNT\(\*\)::text AS total FROM ai_pending_actions/i.test(sql)) {
    // listPendingActions count query. The first param is the status array.
    const statuses = (params[0] as string[]) || [];
    const matched = [...storedRows.values()].filter(r => statuses.includes(r.status));
    return {
      ...empty,
      rowCount: 1,
      rows: [{ total: String(matched.length) } as unknown as R],
    };
  }

  if (/SELECT \* FROM ai_pending_actions/i.test(sql)) {
    // listPendingActions row query. Status array is the first param.
    const statuses = (params[0] as string[]) || [];
    const matched = [...storedRows.values()]
      .filter(r => statuses.includes(r.status))
      .sort((a, b) => +b.created_at - +a.created_at);
    return {
      ...empty,
      rowCount: matched.length,
      rows: matched as unknown as R[],
    };
  }

  return empty;
};

aiApprovalPool.query = aiStubQuery as typeof aiApprovalPool.query;

/* ------------------------------------------------------------------ */
/* In-memory event_logs stub                                          */
/* ------------------------------------------------------------------ */

interface CapturedEventLog {
  user_id: number | null;
  user_name: string | null;
  user_email: string | null;
  user_role: string | null;
  action_type: string;
  entity_type: string;
  entity_id: string | null;
  entity_name: string | null;
  description: string | null;
  ai_involved: boolean;
  severity: string;
  correlation_id: string | null;
  module: string | null;
  timestamp: Date;
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
      user_name: params[1] as string | null,
      user_email: params[2] as string | null,
      user_role: params[3] as string | null,
      action_type: params[4] as string,
      entity_type: params[5] as string,
      entity_id: params[6] as string | null,
      entity_name: params[7] as string | null,
      description: params[8] as string | null,
      ai_involved: Boolean(params[11]),
      severity: params[12] as string,
      correlation_id: params[13] as string | null,
      module: params[16] as string | null,
      timestamp: new Date(),
    };
    capturedEventLogs.push(row);
    return {
      ...empty,
      command: 'INSERT',
      rowCount: 1,
      rows: [{ id: capturedEventLogs.length, ...row } as unknown as R],
    };
  }

  // getActionViewers — single-action lookup.
  if (/SELECT.*MAX\(timestamp\).*FROM event_logs.*WHERE correlation_id = \$1/is.test(sql)) {
    const code = String(params[0]);
    const viewEvents = capturedEventLogs.filter(
      e =>
        e.correlation_id === code &&
        e.action_type === 'AI_ACTION' &&
        /^Viewed/i.test(e.description ?? ''),
    );
    const byUser = new Map<string, { e: CapturedEventLog; count: number; last: Date }>();
    for (const e of viewEvents) {
      const key = `${e.user_id}|${e.user_email}|${e.user_name}|${e.user_role}`;
      const cur = byUser.get(key);
      if (!cur) {
        byUser.set(key, { e, count: 1, last: e.timestamp });
      } else {
        cur.count++;
        if (+e.timestamp > +cur.last) cur.last = e.timestamp;
      }
    }
    const rows = [...byUser.values()].map(v => ({
      user_id: v.e.user_id,
      user_email: v.e.user_email,
      user_name: v.e.user_name,
      user_role: v.e.user_role,
      last_viewed_at: v.last,
      view_count: String(v.count),
    }));
    return {
      ...empty,
      rowCount: rows.length,
      rows: rows as unknown as R[],
    };
  }

  // getActionViewersBatch — multi-action lookup (correlation_id = ANY($1)).
  if (/SELECT.*correlation_id.*MAX\(timestamp\).*FROM event_logs.*WHERE correlation_id = ANY/is.test(sql)) {
    const codes = (params[0] as string[]) || [];
    const rows: Array<{
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
      const byUser = new Map<string, { e: CapturedEventLog; count: number; last: Date }>();
      for (const e of viewEvents) {
        const key = `${e.user_id}|${e.user_email}|${e.user_name}|${e.user_role}`;
        const cur = byUser.get(key);
        if (!cur) {
          byUser.set(key, { e, count: 1, last: e.timestamp });
        } else {
          cur.count++;
          if (+e.timestamp > +cur.last) cur.last = e.timestamp;
        }
      }
      for (const v of byUser.values()) {
        rows.push({
          correlation_id: code,
          user_id: v.e.user_id,
          user_email: v.e.user_email,
          user_name: v.e.user_name,
          user_role: v.e.user_role,
          last_viewed_at: v.last,
          view_count: String(v.count),
        });
      }
    }
    return {
      ...empty,
      rowCount: rows.length,
      rows: rows as unknown as R[],
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

function cookieFor(user: {
  userId: number;
  email: string;
  name: string;
  role: string;
}): string {
  const token = signSession({
    userId: user.userId,
    email: user.email,
    name: user.name,
    role: user.role,
    exp: Date.now() + 3600_000,
  });
  return `ExampleOrg_session=${encodeURIComponent(token)}`;
}

const REVIEWER_A = {
  userId: 42,
  email: 'user@example.invalid',
  name: 'Reviewer A (admin)',
  role: 'admin',
};
const REVIEWER_B = {
  userId: 43,
  email: 'user@example.invalid',
  name: 'Reviewer B (quality_manager)',
  role: 'quality_manager',
};

interface FakeResponse {
  status: number;
  body: unknown;
}

function makeContext(opts: {
  url: string;
  param?: string;
  cookie: string;
  body?: unknown;
}): unknown {
  return {
    req: {
      url: opts.url,
      header: (name: string): string | undefined =>
        name.toLowerCase() === 'cookie' ? opts.cookie : undefined,
      param: (_name: string): string | undefined => opts.param,
      json: async () => opts.body ?? {},
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
  const route = aiApprovalRoutes.find(r => r.path === path && r.method === method);
  if (!route) throw new Error(`Route not registered: ${method} ${path}`);
  const handler = await route.createHandler();
  return (await handler(ctx as never)) as FakeResponse;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

interface PriorViewer {
  user_id: number | null;
  user_email: string | null;
  user_role: string | null;
  view_count: number;
}

interface ListResponseRow {
  action_code: string;
  status: string;
  prior_viewers: PriorViewer[];
}

async function fetchListPriorViewers(
  status: string,
  cookie: string,
): Promise<Map<string, PriorViewer[]>> {
  const res = await callRoute(
    '/api/ai/approvals',
    'GET',
    makeContext({
      url: `<REDACTED_URL>`,
      cookie,
    }),
  );
  if (res.status !== 200) {
    throw new Error(
      `GET /api/ai/approvals?status=${status} failed: status=${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`,
    );
  }
  const body = res.body as { success: boolean; rows: ListResponseRow[] };
  const map = new Map<string, PriorViewer[]>();
  for (const row of body.rows) map.set(row.action_code, row.prior_viewers || []);
  return map;
}

async function viewDetail(actionCode: string, cookie: string): Promise<FakeResponse> {
  return callRoute(
    '/api/ai/approvals/:code',
    'GET',
    makeContext({
      url: `<REDACTED_URL>`,
      param: actionCode,
      cookie,
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Test scenarios                                                      */
/* ------------------------------------------------------------------ */

async function runApproveScenario(): Promise<void> {
  console.log('\n--- Scenario A: viewer activity AFTER an approval ---');

  const action = await enqueuePendingAction({
    toolId: 'rotate_api_key',
    toolLabel: 'Rotate API Key',
    payload: { target_integration: 'zoho_books', reason: 'rotate-test' },
    payloadPreview: 'rotate zoho_books key',
    riskLevel: 'high',
    complianceRefs: ['ISO 27001:2022 A.5.34'],
    requestedByUserId: 99,
    requestedByEmail: 'user@example.invalid',
    requestedByName: 'Requester User',
    threadId: 'thr_viewer_refresh_approve',
  });

  // 1. Reviewer A opens the card while it's still pending.
  capturedEventLogs.length = 0;
  const beforeRes = await viewDetail(action.action_code, cookieFor(REVIEWER_A));
  assert(beforeRes.status === 200, 'Reviewer A pending-state detail GET → 200');
  const beforeBody = beforeRes.body as { prior_viewers: PriorViewer[] };
  assert(
    beforeBody.prior_viewers.length === 1 && beforeBody.prior_viewers[0]?.user_id === REVIEWER_A.userId,
    'pre-decision prior_viewers shows Reviewer A only',
  );

  // 2. Approve and execute the action so its status becomes 'executed'.
  const claimed = await claimForApproval(action.action_code, {
    userId: REVIEWER_A.userId,
    email: REVIEWER_A.email,
    name: REVIEWER_A.name,
  });
  assert(claimed?.status === 'approved', 'claimForApproval flips status to approved');
  await recordExecutionResult(action.action_code, {
    success: true,
    entityType: 'integration',
    entityId: 'zoho_books',
    data: { rotated: true, audit_note: 'ok' },
  });
  const stored = storedRows.get(action.action_code);
  assert(stored?.status === 'executed', 'recordExecutionResult flips status to executed');

  // 3. Reviewer B re-opens the (now executed) card. This MUST emit a
  //    "Viewed executed AI action ..." event_logs row tagged with
  //    correlation_id = action_code.
  const afterDetailRes = await viewDetail(action.action_code, cookieFor(REVIEWER_B));
  assert(afterDetailRes.status === 200, 'Reviewer B post-execution detail GET → 200');
  const afterDetailBody = afterDetailRes.body as { prior_viewers: PriorViewer[] };

  // The new event_logs row must already be visible to the very next call to
  // getActionViewers (within the same request even — the route awaits
  // logEvent before reading viewers).
  const viewersDirect = await getActionViewers(action.action_code);
  const reviewerBDirect = viewersDirect.find(v => v.user_id === REVIEWER_B.userId);
  assert(
    reviewerBDirect !== undefined,
    'getActionViewers picks up the post-execution view event for Reviewer B',
  );
  assert(
    viewersDirect.some(v => v.user_id === REVIEWER_A.userId),
    'getActionViewers retains the pre-decision view event for Reviewer A',
  );
  assert(
    viewersDirect.length === 2,
    `getActionViewers returns exactly 2 distinct viewers after the transition (got ${viewersDirect.length})`,
  );

  // The detail handler also returns the freshly-aggregated list including
  // Reviewer B. Reviewer B's own view must be included (the route writes
  // the audit row and re-reads viewers in the same request).
  assert(
    afterDetailBody.prior_viewers.length === 2,
    `post-execution detail prior_viewers shows both reviewers (got ${afterDetailBody.prior_viewers.length})`,
  );

  // 4. Simulate the dashboard's 30-second auto-refresh: re-fetch the queue
  //    list filtered to executed rows. The viewer chips for this card MUST
  //    now reflect both reviewers.
  const listMap = await fetchListPriorViewers('executed', cookieFor(REVIEWER_A));
  const listViewers = listMap.get(action.action_code) ?? [];
  assert(
    listViewers.length === 2,
    `dashboard auto-refresh list returns 2 prior_viewers for the executed card (got ${listViewers.length})`,
  );
  assert(
    listViewers.some(v => v.user_id === REVIEWER_A.userId) &&
      listViewers.some(v => v.user_id === REVIEWER_B.userId),
    'dashboard auto-refresh list includes BOTH the pre- and post-decision reviewer chips',
  );

  // 5. Cross-check via the batch helper that the list endpoint relies on.
  const batchMap = await getActionViewersBatch([action.action_code]);
  const batchViewers = batchMap[action.action_code] ?? [];
  assert(
    batchViewers.length === 2 &&
      batchViewers.some(v => v.user_id === REVIEWER_B.userId),
    'getActionViewersBatch reflects the post-execution viewer for the same action',
  );
}

async function runRejectScenario(): Promise<void> {
  console.log('\n--- Scenario B: viewer activity AFTER a rejection ---');

  const action = await enqueuePendingAction({
    toolId: 'rotate_api_key',
    toolLabel: 'Rotate API Key',
    payload: { target_integration: 'zoho_books', reason: 'reject-test' },
    payloadPreview: 'rotate zoho_books key (reject path)',
    riskLevel: 'high',
    complianceRefs: ['ISO 27001:2022 A.5.34'],
    requestedByUserId: 99,
    requestedByEmail: 'user@example.invalid',
    requestedByName: 'Requester User',
    threadId: 'thr_viewer_refresh_reject',
  });

  // 1. Reviewer A opens the card while it's pending.
  const beforeRes = await viewDetail(action.action_code, cookieFor(REVIEWER_A));
  assert(beforeRes.status === 200, 'Reviewer A pending-state detail GET → 200');

  // 2. Reject the action.
  const rejected = await rejectAction(
    action.action_code,
    { userId: REVIEWER_A.userId, email: REVIEWER_A.email, name: REVIEWER_A.name },
    'Not aligned with rotation policy this quarter.',
  );
  assert(rejected?.status === 'rejected', 'rejectAction flips status to rejected');

  // 3. Reviewer B re-opens the (now rejected) card.
  const afterDetailRes = await viewDetail(action.action_code, cookieFor(REVIEWER_B));
  assert(afterDetailRes.status === 200, 'Reviewer B post-rejection detail GET → 200');
  const afterDetailBody = afterDetailRes.body as { prior_viewers: PriorViewer[] };

  const viewersDirect = await getActionViewers(action.action_code);
  assert(
    viewersDirect.some(v => v.user_id === REVIEWER_B.userId),
    'getActionViewers picks up the post-rejection view event for Reviewer B',
  );
  assert(
    viewersDirect.some(v => v.user_id === REVIEWER_A.userId),
    'getActionViewers retains the pre-rejection view event for Reviewer A',
  );

  // The view-audit description must reflect the post-decision status so an
  // operator scanning event_logs can tell pre- vs post-rejection inspections
  // apart.
  const rejectedViewLog = capturedEventLogs.find(
    e =>
      e.correlation_id === action.action_code &&
      e.user_id === REVIEWER_B.userId &&
      /Viewed/i.test(e.description ?? ''),
  );
  assert(
    rejectedViewLog?.description?.includes('Viewed rejected AI action') === true,
    `view-audit description after rejection uses status-aware wording (got: "${rejectedViewLog?.description}")`,
  );

  assert(
    afterDetailBody.prior_viewers.length === 2,
    `post-rejection detail prior_viewers shows both reviewers (got ${afterDetailBody.prior_viewers.length})`,
  );

  // 4. Simulate the dashboard's 30-second auto-refresh against the rejected
  //    queue. Both reviewer chips must be present.
  const listMap = await fetchListPriorViewers('rejected', cookieFor(REVIEWER_A));
  const listViewers = listMap.get(action.action_code) ?? [];
  assert(
    listViewers.length === 2,
    `dashboard auto-refresh list returns 2 prior_viewers for the rejected card (got ${listViewers.length})`,
  );
  assert(
    listViewers.some(v => v.user_id === REVIEWER_A.userId) &&
      listViewers.some(v => v.user_id === REVIEWER_B.userId),
    'dashboard auto-refresh list includes BOTH the pre- and post-rejection reviewer chips',
  );
}

async function runRepeatViewIncrementsCount(): Promise<void> {
  console.log('\n--- Scenario C: repeat post-decision views increment view_count ---');

  // Re-use the executed row from Scenario A. Reviewer B opens it a second
  // time; the chip's view_count must climb from 1 → 2 without inventing a
  // new viewer entry.
  const executedAction = [...storedRows.values()].find(r => r.status === 'executed');
  if (!executedAction) {
    console.error('  ✗ pre-condition: no executed row carried over from Scenario A');
    failed++;
    return;
  }

  const before = (await getActionViewers(executedAction.action_code))
    .find(v => v.user_id === REVIEWER_B.userId);
  assert(
    before !== undefined && before.view_count >= 1,
    `Reviewer B already has a view_count >= 1 (got ${before?.view_count})`,
  );

  await viewDetail(executedAction.action_code, cookieFor(REVIEWER_B));

  const after = (await getActionViewers(executedAction.action_code))
    .find(v => v.user_id === REVIEWER_B.userId);
  assert(
    after !== undefined && (before?.view_count ?? 0) + 1 === after.view_count,
    `Reviewer B view_count incremented by exactly 1 (before=${before?.view_count}, after=${after?.view_count})`,
  );

  // The dashboard list refresh must also see the new count.
  const listMap = await fetchListPriorViewers('executed', cookieFor(REVIEWER_A));
  const listViewers = listMap.get(executedAction.action_code) ?? [];
  const reviewerBChip = listViewers.find(v => v.user_id === REVIEWER_B.userId);
  assert(
    reviewerBChip !== undefined && reviewerBChip.view_count === after?.view_count,
    `dashboard auto-refresh list reflects the updated view_count for Reviewer B (chip=${reviewerBChip?.view_count}, viewers=${after?.view_count})`,
  );
}

async function run(): Promise<void> {
  console.log('\n=== Task #299 — viewer-list refresh after approve/reject ===');
  await runApproveScenario();
  await runRejectScenario();
  await runRepeatViewIncrementsCount();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\n❌ Viewer-list refresh after status transition FAILED');
    process.exit(1);
  }
  console.log('\n✅ Viewer-list refresh after status transition verified');
}

run()
  .catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
  })
  .finally(() => {
    void aiApprovalPool.end().catch(() => { /* stubbed pool — ignore */ });
    // The route module's bootstrap IIFE opens incidental pg Pools that hold
    // handles open even after their queries fail; force-exit so the test
    // always terminates regardless of the bootstrap's lifecycle.
    setTimeout(() => process.exit(failed > 0 ? 1 : 0), 250).unref();
  });
