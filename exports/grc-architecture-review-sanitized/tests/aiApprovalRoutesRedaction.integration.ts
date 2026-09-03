/**
 * Integration test — AI approval-queue HTTP endpoints redact secrets.
 *
 * The companion in-process test (`tests/aiApprovalRoutesRedaction.test.ts`)
 * stubs out the database to exercise route handlers directly. That covers
 * the handler logic but not the full HTTP / middleware stack (auth wiring,
 * response shaping, JSON serializers, edge framing).
 *
 * This script closes that gap: it seeds rows through the real
 * `enqueuePendingAction` against the live database, signs a quality-manager
 * session cookie with the same `SESSION_SECRET` the server uses, then drives:
 *
 *   GET  /api/ai/approvals                — list endpoint
 *   GET  /api/ai/approvals/pending-count  — badge count
 *   GET  /api/ai/approvals/:code          — detail (pending then executed)
 *   GET  /api/ai/approvals?status=executed
 *   POST /api/ai/approvals/:code/approve  — success path (fresh secrets in result)
 *   POST /api/ai/approvals/:code/approve  — throw path  (secret in error.message)
 *
 * Assertions:
 *   - None of the seeded plaintext secrets appear in any response body.
 *   - The redaction sentinel does appear (the row was surfaced, not silently
 *     empty).
 *   - POST /approve preserves the safe `audit_note` field and echoes back
 *     `actionCode`.
 *
 * All seeded rows are cleaned up in a `finally` block.
 *
 * POST /approve notes
 * -------------------
 * The POST path is the most dangerous exposure point: the route executes the
 * gated tool synchronously and returns the fresh result directly to the
 * browser before it is masked on the way into ai_pending_actions. Two
 * synthetic no-op canary tools are registered in the server at startup
 * when NODE_ENV !== 'production' (src/utils/integrationTestFixtureTools.ts):
 *
 *   integration-test-redaction-canary__ok     — returns credential-shaped values
 *   integration-test-redaction-canary__throws — throws Error with secret message
 *
 * These tools are present in the running dev/test server's wrappedRegistry so
 * the integration test can drive the full approve execution path without
 * touching any production data.
 *
 * Run:  npx tsx tests/aiApprovalRoutesRedaction.integration.ts
 * Env:  DATABASE_URL   — Postgres connection string (required)
 *       SESSION_SECRET — HMAC key used to sign session cookies (required)
 *       BASE_URL       — defaults to <REDACTED_URL>
 *       NODE_ENV       — must NOT be 'production' for the canary tools to be
 *                        active in the target server (default: development)
 */

import crypto from 'crypto';
import {
  enqueuePendingAction,
  recordExecutionResult,
  aiApprovalPool,
} from '../src/utils/aiApprovalDatabase';
import { REDACTED_SENTINEL } from '../src/utils/eventLogsDatabase';
import {
  INT_TEST_OK_TOOL_ID,
  INT_TEST_THROW_TOOL_ID,
  INT_APPROVE_RESULT_SK_KEY,
  INT_APPROVE_RESULT_GH_TOKEN,
  INT_APPROVE_RESULT_BCRYPT,
  INT_APPROVE_RESULT_ACCESS,
  INT_APPROVE_THROW_SK_KEY,
} from '../src/utils/integrationTestFixtureTools';

const TEST_QM_EMAIL = 'user@example.invalid';
const TEST_QM_NAME = 'Redaction Integration QM';

const BASE_URL = process.env.BASE_URL || '<REDACTED_URL>';
const SESSION_SECRET = process.env.SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SESSION_SECRET) {
  console.error('❌ SESSION_SECRET env var is required');
  process.exit(2);
}
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL env var is required');
  process.exit(2);
}

/* ------------------------------------------------------------------ */
/* Session cookie                                                     */
/* ------------------------------------------------------------------ */

function signSession(payload: Record<string, unknown>): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET!)
    .update(data)
    .digest('base64url');
  return `${data}.${sig}`;
}

function makeQualityManagerCookie(): string {
  // Privileged role so the list endpoint returns rows requested by *any*
  // user (the seeded row is "owned" by a synthetic id below). The global
  // API middleware additionally re-verifies that this email exists with
  // status='active' in platform_users, so the harness seeds that row in
  // setupTestUser() and removes it in the finally block.
  const token = signSession({
    userId: 998001,
    email: TEST_QM_EMAIL,
    name: TEST_QM_NAME,
    role: 'quality_manager',
    exp: Date.now() + 3600_000,
  });
  return `ExampleOrg_session=${encodeURIComponent(token)}`;
}

async function setupTestUser(): Promise<void> {
  // Insert (or refresh) the quality-manager row used by the signed session.
  // The middleware's `checkPlatformUserActive` consults platform_users and
  // refuses requests whose email is missing or whose status is not 'active',
  // so without this seed every endpoint would return 403.
  await aiApprovalPool.query(
    `INSERT INTO platform_users (email, full_name, role, status, team)
     VALUES ($1, $2, 'quality_manager', 'active', 'Other')
     ON CONFLICT (email) DO UPDATE
       SET role   = 'quality_manager',
           status = 'active'`,
    [TEST_QM_EMAIL, TEST_QM_NAME],
  );
}

async function cleanupTestUser(): Promise<void> {
  await aiApprovalPool.query(
    'DELETE FROM platform_users WHERE email = $1',
    [TEST_QM_EMAIL],
  );
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                       */
/* ------------------------------------------------------------------ */

interface HttpResult {
  status: number;
  text: string;
  body: unknown;
}

async function httpGet(path: string, cookie: string): Promise<HttpResult> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Cookie: cookie, Accept: 'application/json' },
    redirect: 'manual',
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, text, body };
}

async function httpPost(
  path: string,
  cookie: string,
  payload: Record<string, unknown> = {},
): Promise<HttpResult> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    redirect: 'manual',
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, text, body };
}

/* ------------------------------------------------------------------ */
/* Assertions                                                         */
/* ------------------------------------------------------------------ */

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
/* Secrets — all distinct strings so we can detect leaks precisely    */
/* ------------------------------------------------------------------ */

const PAYLOAD_API_KEY = '<REDACTED_TOKEN>';
const PAYLOAD_REFRESH = 'rt_LEAK_DETECTOR_INT_REFRESH_qwertyuiopas';
const PAYLOAD_BCRYPT =
  '$2b$12$abcdefghijklmnopqrstuvLEAKDETECTORINTHASH1234567890ABCDE';
const RESULT_API_KEY = '<REDACTED_TOKEN>';
const RESULT_ACCESS_TOKEN = 'eyJhbGciLEAKDETECTORINTACCESS_freshtoken';

// POST /approve test secrets — imported from the fixture tools module so
// this file and the server-side tool definitions stay in sync.
const APPROVE_SECRETS = [
  INT_APPROVE_RESULT_SK_KEY,
  INT_APPROVE_RESULT_GH_TOKEN,
  INT_APPROVE_RESULT_BCRYPT,
  INT_APPROVE_RESULT_ACCESS,
  INT_APPROVE_THROW_SK_KEY,
];

const ALL_SECRETS = [
  PAYLOAD_API_KEY,
  PAYLOAD_REFRESH,
  PAYLOAD_BCRYPT,
  RESULT_API_KEY,
  RESULT_ACCESS_TOKEN,
  ...APPROVE_SECRETS,
];

function findLeakedSecret(text: string): string | null {
  for (const sec of ALL_SECRETS) {
    if (text.includes(sec)) return sec;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Typed shape of POST /approve response body                         */
/* ------------------------------------------------------------------ */

interface ApproveOkResult {
  success?: boolean;
  rotated?: boolean;
  new_api_key?: string;
  access_token?: string;
  nested?: {
    free_form_note?: string;
    legacy_password_hash_blob?: string;
  };
  audit_note?: string;
}

interface ApproveResponseBody {
  success?: boolean;
  actionCode?: string;
  entityType?: string;
  entityId?: string;
  result?: ApproveOkResult;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log('\n=== AI approval-queue HTTP — secret-leak integration test ===\n');
  console.log(`Target: ${BASE_URL}\n`);

  // Quick reachability probe so we fail fast with a useful message instead
  // of looking like a route-handler bug.
  try {
    await fetch(`${BASE_URL}/`, { redirect: 'manual' });
  } catch (err: any) {
    console.error(`❌ Cannot reach ${BASE_URL} — is the server running?`);
    console.error(`   ${err?.message ?? err}`);
    process.exit(2);
  }

  let actionCode: string | null = null;
  let approveOkCode: string | null = null;
  let approveThrowCode: string | null = null;

  await setupTestUser();

  try {
    /* ---------- Seed a real ai_pending_actions row ---------- */
    const enqueued = await enqueuePendingAction({
      toolId: 'rotate_api_key',
      toolLabel: 'Rotate API Key (integration leak guard)',
      payload: {
        target_integration: 'zoho_books',
        api_key: PAYLOAD_API_KEY,
        refresh_token: PAYLOAD_REFRESH,
        nested: {
          password_hash: PAYLOAD_BCRYPT,
          username: 'user@example.invalid',
        },
        reason: 'integration-leak-guard',
      },
      payloadPreview: 'Rotate API key for zoho_books (integration test)',
      riskLevel: 'high',
      // No WP-* codes -> route skips the controlled-document join, keeping
      // the test independent of the policies registry contents.
      complianceRefs: ['PCI-DSS-12.3.1', 'ISO 27001:2022 A.5.34'],
      requestedByUserId: 998999,
      requestedByEmail: 'user@example.invalid',
      requestedByName: 'Redaction Integration Requester',
      threadId: 'thr_redaction_integration_test',
    });
    actionCode = enqueued.action_code;

    assert(
      enqueued.payload?.api_key === REDACTED_SENTINEL,
      'baseline: enqueuePendingAction stored a redacted payload (sanity check)',
    );

    const cookie = makeQualityManagerCookie();

    /* ---------- GET /api/ai/approvals (pending) ---------- */
    const listRes = await httpGet(
      '/api/ai/approvals?status=pending,approved,executed,failed,rejected,expired&limit=200',
      cookie,
    );
    assert(listRes.status === 200, `GET /api/ai/approvals → 200 (got ${listRes.status})`);
    const listLeak = findLeakedSecret(listRes.text);
    assert(
      listLeak === null,
      `GET /api/ai/approvals body contains no plaintext secret (leaked: ${listLeak ?? 'none'})`,
    );
    const listBody = listRes.body as {
      success?: boolean;
      rows?: Array<{ action_code: string; payload?: Record<string, unknown> }>;
    };
    const seededInList = listBody.rows?.find(r => r.action_code === actionCode);
    assert(!!seededInList, 'GET /api/ai/approvals returns the seeded row');
    if (seededInList) {
      assert(
        JSON.stringify(seededInList).includes(REDACTED_SENTINEL),
        'GET /api/ai/approvals seeded row contains the redaction sentinel',
      );
      assert(
        seededInList.payload?.target_integration === 'zoho_books',
        'GET /api/ai/approvals preserves non-sensitive payload fields',
      );
    }

    /* ---------- GET /api/ai/approvals/pending-count ---------- */
    const countRes = await httpGet('/api/ai/approvals/pending-count', cookie);
    assert(
      countRes.status === 200,
      `GET /api/ai/approvals/pending-count → 200 (got ${countRes.status})`,
    );
    assert(
      findLeakedSecret(countRes.text) === null,
      'GET /api/ai/approvals/pending-count body contains no plaintext secret',
    );
    const countBody = countRes.body as { success?: boolean; count?: number };
    assert(
      typeof countBody.count === 'number' && countBody.count >= 1,
      `GET /api/ai/approvals/pending-count reflects at least the seeded row (got ${countBody.count})`,
    );

    /* ---------- GET /api/ai/approvals/:code (pending) ---------- */
    const detailPendingRes = await httpGet(
      `/api/ai/approvals/${encodeURIComponent(actionCode)}`,
      cookie,
    );
    assert(
      detailPendingRes.status === 200,
      `GET /api/ai/approvals/:code (pending) → 200 (got ${detailPendingRes.status})`,
    );
    const detailPendingLeak = findLeakedSecret(detailPendingRes.text);
    assert(
      detailPendingLeak === null,
      `GET /api/ai/approvals/:code (pending) contains no plaintext secret (leaked: ${detailPendingLeak ?? 'none'})`,
    );
    assert(
      detailPendingRes.text.includes(REDACTED_SENTINEL),
      'GET /api/ai/approvals/:code (pending) contains the redaction sentinel',
    );

    /* ---------- Record an execution result with secret-shaped data ---------- */
    await recordExecutionResult(actionCode, {
      success: true,
      entityType: 'integration',
      entityId: 'zoho_books',
      data: {
        rotated: true,
        new_api_key: RESULT_API_KEY,
        access_token: RESULT_ACCESS_TOKEN,
        audit_note: 'Integration rotation completed successfully',
      },
    });

    /* ---------- GET /api/ai/approvals/:code (executed) ---------- */
    const detailExecRes = await httpGet(
      `/api/ai/approvals/${encodeURIComponent(actionCode)}`,
      cookie,
    );
    assert(
      detailExecRes.status === 200,
      `GET /api/ai/approvals/:code (executed) → 200 (got ${detailExecRes.status})`,
    );
    const detailExecLeak = findLeakedSecret(detailExecRes.text);
    assert(
      detailExecLeak === null,
      `GET /api/ai/approvals/:code (executed) contains no plaintext secret (leaked: ${detailExecLeak ?? 'none'})`,
    );
    assert(
      detailExecRes.text.includes(REDACTED_SENTINEL),
      'GET /api/ai/approvals/:code (executed) execution_result contains the redaction sentinel',
    );
    assert(
      detailExecRes.text.includes('Integration rotation completed successfully'),
      'GET /api/ai/approvals/:code (executed) preserves the safe audit_note field',
    );

    /* ---------- GET /api/ai/approvals?status=executed ---------- */
    const listExecRes = await httpGet(
      '/api/ai/approvals?status=executed&limit=200',
      cookie,
    );
    assert(
      listExecRes.status === 200,
      `GET /api/ai/approvals?status=executed → 200 (got ${listExecRes.status})`,
    );
    const listExecLeak = findLeakedSecret(listExecRes.text);
    assert(
      listExecLeak === null,
      `GET /api/ai/approvals?status=executed contains no plaintext secret (leaked: ${listExecLeak ?? 'none'})`,
    );
    const listExecBody = listExecRes.body as {
      rows?: Array<{ action_code: string }>;
    };
    const seededInExecList = listExecBody.rows?.find(
      r => r.action_code === actionCode,
    );
    assert(
      !!seededInExecList,
      'GET /api/ai/approvals?status=executed returns the seeded row after execution',
    );
    assert(
      JSON.stringify(seededInExecList ?? {}).includes(REDACTED_SENTINEL),
      'GET /api/ai/approvals?status=executed seeded row contains the redaction sentinel for execution_result',
    );

    /* ============================================================ */
    /* POST /approve — success path                                 */
    /* ============================================================ */
    console.log('\n--- POST /approve (success path) ---');

    // Seed a pending action for the canary "ok" tool.  The QM user (userId
    // 998001) is not the requester (998999), so segregation-of-duties passes.
    const okEnqueued = await enqueuePendingAction({
      toolId: INT_TEST_OK_TOOL_ID,
      toolLabel: '[Integration-Test] Redaction Canary (success)',
      payload: { target_integration: 'redaction_int_test', reason: 'approve-path-test' },
      payloadPreview: 'Redaction canary — success path (integration test)',
      riskLevel: 'high',
      complianceRefs: ['REDACTION-INTEGRATION-TEST'],
      requestedByUserId: 998999,
      requestedByEmail: 'user@example.invalid',
      requestedByName: 'Redaction Integration Requester',
      threadId: 'thr_redaction_int_approve_ok',
    });
    approveOkCode = okEnqueued.action_code;

    const approveOkRes = await httpPost(
      `/api/ai/approvals/${encodeURIComponent(approveOkCode)}/approve`,
      cookie,
    );

    assert(
      approveOkRes.status === 200,
      `POST /approve (success) → 200 (got ${approveOkRes.status}, body=${JSON.stringify(approveOkRes.body).slice(0, 300)})`,
    );
    const approveOkLeak = findLeakedSecret(approveOkRes.text);
    assert(
      approveOkLeak === null,
      `POST /approve (success) response contains no plaintext secret (leaked: ${approveOkLeak ?? 'none'})`,
    );
    assert(
      approveOkRes.text.includes(REDACTED_SENTINEL),
      'POST /approve (success) response contains the redaction sentinel',
    );
    assert(
      approveOkRes.text.includes('Integration-test canary rotation completed'),
      'POST /approve (success) response preserves the safe audit_note field',
    );

    const approveOkBody = approveOkRes.body as ApproveResponseBody;
    assert(
      approveOkBody.success === true,
      `POST /approve (success) response.success === true (got ${approveOkBody.success})`,
    );
    assert(
      approveOkBody.actionCode === approveOkCode,
      `POST /approve (success) response.actionCode echoed back (got ${approveOkBody.actionCode})`,
    );

    // Per-field redaction assertions — each attack surface must be scrubbed.
    const okResult = approveOkBody.result;
    assert(
      okResult?.new_api_key === REDACTED_SENTINEL,
      `POST /approve (success) key-deny-list redacts result.new_api_key (got: ${okResult?.new_api_key})`,
    );
    assert(
      okResult?.access_token === REDACTED_SENTINEL,
      `POST /approve (success) key-deny-list redacts result.access_token (got: ${okResult?.access_token})`,
    );
    assert(
      typeof okResult?.nested?.free_form_note === 'string' &&
        okResult.nested.free_form_note.includes(REDACTED_SENTINEL) &&
        !okResult.nested.free_form_note.includes(INT_APPROVE_RESULT_GH_TOKEN),
      `POST /approve (success) regex-deny-list scrubs interpolated GH token in free-form string (got: ${okResult?.nested?.free_form_note})`,
    );
    assert(
      okResult?.nested?.legacy_password_hash_blob === REDACTED_SENTINEL,
      `POST /approve (success) key-deny-list redacts nested *_hash field (got: ${okResult?.nested?.legacy_password_hash_blob})`,
    );

    /* ============================================================ */
    /* POST /approve — throw path                                   */
    /* ============================================================ */
    console.log('\n--- POST /approve (throw path) ---');

    // Seed a pending action for the canary "throws" tool.
    const throwEnqueued = await enqueuePendingAction({
      toolId: INT_TEST_THROW_TOOL_ID,
      toolLabel: '[Integration-Test] Redaction Canary (throws)',
      payload: { target_integration: 'redaction_int_test', reason: 'throw-path-test' },
      payloadPreview: 'Redaction canary — throw path (integration test)',
      riskLevel: 'high',
      complianceRefs: ['REDACTION-INTEGRATION-TEST'],
      requestedByUserId: 998999,
      requestedByEmail: 'user@example.invalid',
      requestedByName: 'Redaction Integration Requester',
      threadId: 'thr_redaction_int_approve_throw',
    });
    approveThrowCode = throwEnqueued.action_code;

    const approveThrowRes = await httpPost(
      `/api/ai/approvals/${encodeURIComponent(approveThrowCode)}/approve`,
      cookie,
    );

    // executeApprovedAction catches the thrown error and returns ok=false with
    // the (unredacted) error message; the route handler then scrubs it before
    // including it in the 500 response.
    assert(
      approveThrowRes.status === 500,
      `POST /approve (throw) → 500 (got ${approveThrowRes.status}, body=${JSON.stringify(approveThrowRes.body).slice(0, 300)})`,
    );
    const approveThrowLeak = findLeakedSecret(approveThrowRes.text);
    assert(
      approveThrowLeak === null,
      `POST /approve (throw) response contains no plaintext secret (leaked: ${approveThrowLeak ?? 'none'})`,
    );

    const approveThrowBody = approveThrowRes.body as ApproveResponseBody;
    assert(
      approveThrowBody.success === false,
      `POST /approve (throw) response.success === false (got ${approveThrowBody.success})`,
    );
    assert(
      typeof approveThrowBody.error === 'string' &&
        approveThrowBody.error.includes(REDACTED_SENTINEL),
      `POST /approve (throw) response.error contains the redaction sentinel (got: ${approveThrowBody.error})`,
    );
    assert(
      !approveThrowBody.error?.includes(INT_APPROVE_THROW_SK_KEY),
      `POST /approve (throw) response.error does not contain the raw secret (got: ${approveThrowBody.error})`,
    );

    console.log(`\n${passed} passed, ${failed} failed`);

    if (failed > 0) {
      console.error('\n❌ AI approval-queue HTTP secret-leak integration test FAILED');
      process.exit(1);
    }
    console.log('\n✅ All AI approval-queue HTTP endpoints (GET + POST approve) redact secrets');
  } finally {
    // Clean up all seeded rows regardless of test outcome.
    const codesToDelete = [actionCode, approveOkCode, approveThrowCode].filter(Boolean);
    for (const code of codesToDelete) {
      try {
        await aiApprovalPool.query(
          'DELETE FROM ai_pending_actions WHERE action_code = $1',
          [code],
        );
      } catch (err) {
        console.error(`⚠ Failed to clean up seeded row ${code}:`, err);
      }
    }
    try {
      await cleanupTestUser();
    } catch (err) {
      console.error('⚠ Failed to clean up seeded test user:', err);
    }
    await aiApprovalPool.end().catch(() => { /* already closed */ });
  }
}

main().catch(err => {
  console.error('❌ Unexpected error:', err);
  void aiApprovalPool.end().catch(() => { /* ignore */ });
  process.exit(1);
});
