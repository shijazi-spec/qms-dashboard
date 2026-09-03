/**
 * Task #499 — regression guard: integration-test canary tools must stay
 * hidden from the production approvals dashboard.
 *
 * Task #349 added a server-side filter that excludes any
 * `ai_pending_actions` row whose `tool_id` starts with
 * `integration-test-` from the approvals list, the pending-count badge
 * and the credential-warning-count badge whenever
 * `process.env.NODE_ENV !== 'test'`. The two synthetic redaction-canary
 * tools registered by `src/utils/integrationTestFixtureTools.ts`
 * (`<REDACTED_SECRET>__ok` /
 *  `<REDACTED_SECRET>__throws`) are the live-HTTP
 * integration test's only legitimate use of that prefix. Without this
 * filter, an operator who pointed the integration test at a non-test
 * environment — or otherwise seeded a row for those IDs — would see
 * canary entries leak into the live approvals UI alongside real
 * approval requests.
 *
 * This test locks the behaviour in: it stubs the pg pool for the three
 * read endpoints, seeds one canary row + one real row, and verifies
 *   - in production NODE_ENV: only the real row is visible, and both
 *     count badges agree with the visible row count.
 *   - in test NODE_ENV: both rows are visible, and the count badges
 *     agree with the visible row count.
 *
 * If a future refactor of `aiApprovalRoutes.getExcludedToolIdPrefixes`
 * or of `aiApprovalDatabase.{listPendingActions,countPendingForUser,
 * countPendingWithCredentialWarnings,escapeLikeLiteral}` ever drops the
 * filter from any of those endpoints, this file will fail.
 *
 * Run:    npx tsx tests/aiApprovalIntegrationTestFilter.test.ts
 * Wired:  picked up automatically by `tests/runIntegrationTests.ts`
 */

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "<REDACTED_SECRET>";
// Point any incidentally-created pg Pool at a port that refuses fast so
// the bootstrap IIFE inside aiApprovalRoutes errors immediately instead
// of hanging the test (mirrors aiApprovalRoutesRedaction.test.ts).
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "<REDACTED_DSN>";

import crypto from "crypto";
import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";

/* ------------------------------------------------------------------ */
/* Stub the platform_users lookup performed by requireRole().         */
/* aiApprovalRoutes is wrapped in aiApprovalGate(), which calls       */
/* requireRole(c, AI_APPROVAL_*_ROLES). requireRole delegates to      */
/* getPlatformUser(email), which queries the private `platformPool`   */
/* inside rbacMiddleware. The per-instance pool stubs further down    */
/* shadow aiApprovalPool and eventLogsPool, but the platformPool is   */
/* not exported, so we patch `pg.Pool.prototype.query` to intercept   */
/* ONLY that catalog query and return a synthetic active-admin row.   */
/* ------------------------------------------------------------------ */
const TEST_PLATFORM_USERS: Record<string, { status: string; role: string }> = {
  "<REDACTED_EMAIL>": { status: "active", role: "admin" },
};
const _origPoolQuery = pg.Pool.prototype.query;
pg.Pool.prototype.query = function (this: pg.Pool, ...args: unknown[]): any {
  const sql = String((args[0] as { text?: string } | string | undefined) ?? "");
  if (
    /SELECT status, role FROM platform_users WHERE email\s*=\s*\$1/i.test(sql)
  ) {
    const params = args[1] as ReadonlyArray<unknown> | undefined;
    const email = String(params?.[0] ?? "");
    const row = TEST_PLATFORM_USERS[email];
    return Promise.resolve({
      command: "SELECT",
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
  type PendingAction,
} from "../src/utils/aiApprovalDatabase";
import { pool as eventLogsPool } from "../src/utils/eventLogsDatabase";
import { aiApprovalRoutes } from "../src/mastra/routes/aiApprovalRoutes";
import { INT_TEST_OK_TOOL_ID } from "../src/utils/integrationTestFixtureTools";

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
/* Seed rows                                                          */
/*   1. canary row — tool_id starts with `integration-test-`          */
/*   2. real row   — tool_id is a real gated tool ID                  */
/* Both are pending, non-expired, and carry one credential warning,   */
/* so all three badge endpoints must count them when the filter is    */
/* off and exclude only the canary when the filter is on.             */
/* ------------------------------------------------------------------ */
const NOW = Date.now();
const FUTURE = new Date(NOW + 24 * 3600 * 1000);

function seedRow(overrides: Partial<PendingAction>): PendingAction {
  return {
    id: 0,
    action_code: "",
    tool_id: "",
    tool_label: "",
    payload: {},
    payload_preview: "preview",
    payload_checksum: "sum",
    risk_level: "high",
    compliance_refs: [],
    requested_by_user_id: 99,
    requested_by_email: "<REDACTED_EMAIL>",
    requested_by_name: "Requester",
    thread_id: null,
    status: "pending",
    reviewed_by_user_id: null,
    reviewed_by_email: null,
    reviewed_by_name: null,
    reviewed_at: null,
    rejection_reason: null,
    executed_at: null,
    execution_result: null,
    result_entity_type: null,
    result_entity_id: null,
    created_at: new Date(NOW),
    expires_at: FUTURE,
    credential_warnings: <REDACTED_SECRET>
      {
        path: "payload.note",
        kind: "api_key",
      } as unknown as PendingAction["credential_warnings"][number],
    ],
    ...overrides,
  };
}

const ROWS: PendingAction[] = [
  seedRow({
    id: 1,
    action_code: "APR-CANARY-0001",
    tool_id: INT_TEST_OK_TOOL_ID,
    tool_label: "[Integration-Test] Canary OK",
  }),
  seedRow({
    id: 2,
    action_code: "APR-REAL-0001",
    tool_id: "rotate_api_key",
    tool_label: "Rotate API Key",
  }),
];

/* ------------------------------------------------------------------ */
/* SQL stub helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Apply the production-side `tool_id NOT LIKE $N ESCAPE '\\'` filter
 * inside the stub by parsing the SQL for those clauses and removing
 * any rows whose tool_id starts with the corresponding param prefix.
 *
 * Implementing the LIKE evaluation here (instead of just trusting that
 * the route passed the right config) is what makes this a regression
 * test of the FULL chain: route -> DB helper -> escapeLikeLiteral ->
 * ESCAPE-clause SQL. Drop the filter at any step and the canary row
 * survives this filter and the assertions break.
 */
function applyExcludePrefixFilter(
  rows: PendingAction[],
  sql: string,
  params: ReadonlyArray<unknown>,
): PendingAction[] {
  const re = /tool_id\s+NOT\s+LIKE\s+\$(\d+)\s+ESCAPE\s+'\\'/gi;
  let result = rows;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const idx = parseInt(m[1], 10) - 1;
    const raw = String(params[idx] ?? "");
    if (!raw.endsWith("%")) continue;
    // Strip the trailing % then unescape the `\` that escapeLikeLiteral
    // inserted in front of `_`, `%`, and `\`.
    const literal = raw.slice(0, -1).replace(/\\(.)/g, "$1");
    if (literal.length === 0) continue;
    result = result.filter((r) => !r.tool_id.startsWith(literal));
  }
  return result;
}

type StubQuery = <R extends QueryResultRow>(
  sql: string,
  params?: ReadonlyArray<unknown>,
) => Promise<QueryResult<R>>;

const stubQuery: StubQuery = async <R extends QueryResultRow>(
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<QueryResult<R>> => {
  const empty: QueryResult<R> = {
    command: "",
    rowCount: 0,
    oid: 0,
    fields: [],
    rows: [],
  };

  // Schema bootstrap and other DDL — harmless no-ops.
  if (
    /^\s*(CREATE|ALTER|DROP|TRUNCATE)\s/i.test(sql) ||
    /^\s*BEGIN|COMMIT|ROLLBACK\s*/i.test(sql)
  ) {
    return empty;
  }

  // listPendingActions COUNT — drives the `total` field on the list response.
  if (/SELECT COUNT\(\*\)::text AS total FROM ai_pending_actions/i.test(sql)) {
    let rows = ROWS.filter((r) => r.status === "pending");
    rows = applyExcludePrefixFilter(rows, sql, params);
    return {
      ...empty,
      rowCount: 1,
      rows: [{ total: String(rows.length) } as unknown as R],
    };
  }

  // countPendingForUser / countPendingWithCredentialWarnings — both shape
  // the result column as `n`. Disambiguate by the presence of the
  // credential_warnings clause.
  if (/SELECT COUNT\(\*\)::text AS n FROM ai_pending_actions/i.test(sql)) {
    let rows = ROWS.filter(
      (r) => r.status === "pending" && r.expires_at.getTime() > Date.now(),
    );
    const userId = Number(params[0] ?? 0);
    if (userId !== 0) {
      rows = rows.filter((r) => r.requested_by_user_id === userId);
    }
    if (/jsonb_array_length\(credential_warnings\)\s*>\s*0/i.test(sql)) {
      rows = rows.filter((r) => (r.credential_warnings ?? []).length > 0);
    }
    rows = applyExcludePrefixFilter(rows, sql, params);
    return {
      ...empty,
      rowCount: 1,
      rows: [{ n: String(rows.length) } as unknown as R],
    };
  }

  // listPendingActions SELECT * — drives the `rows` field on the list response.
  if (/SELECT \* FROM ai_pending_actions/i.test(sql)) {
    let rows = ROWS.filter((r) => r.status === "pending");
    rows = applyExcludePrefixFilter(rows, sql, params);
    return { ...empty, rowCount: rows.length, rows: rows as unknown as R[] };
  }

  return empty;
};

aiApprovalPool.query = stubQuery as typeof aiApprovalPool.query;

/* ------------------------------------------------------------------ */
/* event_logs pool stub — getActionViewersBatch is called inside the  */
/* GET /api/ai/approvals handler. We do not exercise viewer history   */
/* here, so return empty for the ANY($1) lookup and ignore everything */
/* else.                                                              */
/* ------------------------------------------------------------------ */
const eventLogsStub: StubQuery = async <R extends QueryResultRow>() => ({
  command: "",
  rowCount: 0,
  oid: 0,
  fields: [],
  rows: [] as R[],
});
eventLogsPool.query = eventLogsStub as typeof eventLogsPool.query;

/* ------------------------------------------------------------------ */
/* Hono context + cookie helpers                                      */
/* ------------------------------------------------------------------ */

function signSession(payload: Record<string, unknown>): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", process.env.SESSION_SECRET!)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

function adminCookie(): string {
  const token = signSession({
    userId: 42,
    email: "<REDACTED_EMAIL>",
    name: "Quality Manager Test",
    role: "admin",
    exp: Date.now() + 3600_000,
  });
  return `ExampleOrg_session=${encodeURIComponent(token)}`;
}

interface FakeResponse {
  status: number;
  body: any;
}

function makeContext(url: string): unknown {
  const cookie = adminCookie();
  return {
    req: {
      url,
      header: (name: string): string | undefined =>
        name.toLowerCase() === "cookie" ? cookie : undefined,
      param: (_name: string): string | undefined => undefined,
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
  method: "GET" | "POST",
  url: string,
): Promise<FakeResponse> {
  const route = aiApprovalRoutes.find(
    (r) => r.path === path && r.method === method,
  );
  if (!route) throw new Error(`Route not registered: ${method} ${path}`);
  const handler = await route.createHandler();
  return (await handler(makeContext(url) as never)) as FakeResponse;
}

/* ------------------------------------------------------------------ */
/* Per-environment exercise                                           */
/* ------------------------------------------------------------------ */

interface Snapshot {
  listStatus: number;
  listTotal: number;
  listRows: PendingAction[];
  pendingCount: number;
  credentialWarningCount: <REDACTED_SECRET>
}

async function snapshotForEnv(nodeEnv: string): Promise<Snapshot> {
  process.env.NODE_ENV = nodeEnv;

  const listRes = await callRoute(
    "/api/ai/approvals",
    "GET",
    "<REDACTED_URL>",
  );
  const pendingRes = await callRoute(
    "/api/ai/approvals/pending-count",
    "GET",
    "<REDACTED_URL>",
  );
  const credRes = await callRoute(
    "/api/ai/approvals/credential-warning-count",
    "GET",
    "<REDACTED_URL>",
  );

  return {
    listStatus: listRes.status,
    listTotal: Number(listRes.body?.total ?? -1),
    listRows: (listRes.body?.rows ?? []) as PendingAction[],
    pendingCount: Number(pendingRes.body?.count ?? -1),
    credentialWarningCount: <REDACTED_SECRET>
  };
}

async function main(): Promise<void> {
  const originalNodeEnv = process.env.NODE_ENV;

  try {
    /* ---------------- production: filter ENABLED ---------------- */
    const prod = await snapshotForEnv("production");
    assert(prod.listStatus === 200, "production: GET /api/ai/approvals → 200");
    assert(
      prod.listRows.length === 1,
      `production: list returns exactly 1 row (got ${prod.listRows.length})`,
    );
    assert(
      prod.listRows.every((r) => !r.tool_id.startsWith("integration-test-")),
      "production: list excludes every integration-test-* canary row",
    );
    assert(
      prod.listRows.some((r) => r.tool_id === "rotate_api_key"),
      "production: list still includes the real rotate_api_key row",
    );
    assert(
      prod.listTotal === prod.listRows.length,
      `production: list "total" matches visible row count (total=${prod.listTotal}, rows=${prod.listRows.length})`,
    );
    assert(
      prod.pendingCount === prod.listRows.length,
      `production: pending-count badge matches visible rows (badge=${prod.pendingCount}, rows=${prod.listRows.length})`,
    );
    assert(
      prod.credentialWarningCount === prod.listRows.length,
      `production: credential-warning-count badge matches visible rows (badge=${prod.credentialWarningCount}, rows=${prod.listRows.length})`,
    );

    /* ---------------- test: filter DISABLED --------------------- */
    const test = await snapshotForEnv("test");
    assert(test.listStatus === 200, "test: GET /api/ai/approvals → 200");
    assert(
      test.listRows.length === 2,
      `test: list returns both seeded rows (got ${test.listRows.length})`,
    );
    assert(
      test.listRows.some((r) => r.tool_id === INT_TEST_OK_TOOL_ID),
      "test: list includes the integration-test canary row",
    );
    assert(
      test.listRows.some((r) => r.tool_id === "rotate_api_key"),
      "test: list still includes the real rotate_api_key row",
    );
    assert(
      test.listTotal === test.listRows.length,
      `test: list "total" matches visible row count (total=${test.listTotal}, rows=${test.listRows.length})`,
    );
    assert(
      test.pendingCount === test.listRows.length,
      `test: pending-count badge matches visible rows (badge=${test.pendingCount}, rows=${test.listRows.length})`,
    );
    assert(
      test.credentialWarningCount === test.listRows.length,
      `test: credential-warning-count badge matches visible rows (badge=${test.credentialWarningCount}, rows=${test.listRows.length})`,
    );

    /* ---------------- cross-env diff sanity check --------------- */
    // The whole point of the filter is that production and test see
    // different totals, so explicitly assert the gap.
    assert(
      prod.listRows.length < test.listRows.length,
      "production list is strictly smaller than test list (filter actually discriminates)",
    );
    assert(
      prod.pendingCount < test.pendingCount,
      "production pending-count is strictly smaller than test pending-count",
    );
    assert(
      prod.credentialWarningCount < test.credentialWarningCount,
      "production credential-warning-count is strictly smaller than test credential-warning-count",
    );
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;

    void aiApprovalPool.end().catch(() => {
      /* stubbed pool — ignore */
    });
    void eventLogsPool.end().catch(() => {
      /* stubbed pool — ignore */
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
