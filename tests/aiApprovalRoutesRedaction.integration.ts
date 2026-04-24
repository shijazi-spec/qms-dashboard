/**
 * Integration test — AI approval-queue HTTP read endpoints redact secrets.
 *
 * The companion in-process test (`tests/aiApprovalRoutesRedaction.test.ts`)
 * stubs out the database to exercise route handlers directly. That covers
 * the handler logic but not the full HTTP / middleware stack (auth wiring,
 * response shaping, JSON serializers, edge framing).
 *
 * This script closes that gap: it seeds a row through the real
 * `enqueuePendingAction` against the live database, signs a quality-manager
 * session cookie with the same `SESSION_SECRET` the server uses, then drives
 * `GET /api/ai/approvals`, `GET /api/ai/approvals/pending-count`, and
 * `GET /api/ai/approvals/:code` over HTTP and asserts that:
 *   - none of the seeded plaintext secrets appears in any response body, AND
 *   - the redaction sentinel does appear (so we know the row was actually
 *     surfaced and not silently empty).
 *
 * The seeded row is cleaned up in a `finally` block.
 *
 * Run:  npx tsx tests/aiApprovalRoutesRedaction.integration.ts
 * Env:  DATABASE_URL   — Postgres connection string (required)
 *       SESSION_SECRET — HMAC key used to sign session cookies (required)
 *       BASE_URL       — defaults to http://localhost:5000
 */

import crypto from 'crypto';
import {
  enqueuePendingAction,
  recordExecutionResult,
  aiApprovalPool,
} from '../src/utils/aiApprovalDatabase';
import { REDACTED_SENTINEL } from '../src/utils/eventLogsDatabase';

const TEST_QM_EMAIL = 'redaction-int-qm@walaplus-test.invalid';
const TEST_QM_NAME = 'Redaction Integration QM';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
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
  return `walaplus_session=${encodeURIComponent(token)}`;
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
/* HTTP helper                                                        */
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
/* Secrets — distinct strings so we can detect leaks unambiguously    */
/* ------------------------------------------------------------------ */

const PAYLOAD_API_KEY = 'sk-live-LEAK_DETECTOR_INT_PAYLOAD_9z8y7x6w5v';
const PAYLOAD_REFRESH = 'rt_LEAK_DETECTOR_INT_REFRESH_qwertyuiopas';
const PAYLOAD_BCRYPT =
  '$2b$12$abcdefghijklmnopqrstuvLEAKDETECTORINTHASH1234567890ABCDE';
const RESULT_API_KEY = 'sk-live-LEAK_DETECTOR_INT_RESULT_FRESHKEY_4321';
const RESULT_ACCESS_TOKEN = 'eyJhbGciLEAKDETECTORINTACCESS_freshtoken';

const SECRETS = [
  PAYLOAD_API_KEY,
  PAYLOAD_REFRESH,
  PAYLOAD_BCRYPT,
  RESULT_API_KEY,
  RESULT_ACCESS_TOKEN,
];

function findLeakedSecret(text: string): string | null {
  for (const sec of SECRETS) {
    if (text.includes(sec)) return sec;
  }
  return null;
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
          username: 'svc-zoho@walaplus.test',
        },
        reason: 'integration-leak-guard',
      },
      payloadPreview: 'Rotate API key for zoho_books (integration test)',
      riskLevel: 'high',
      // No WP-* codes -> route skips the controlled-document join, keeping
      // the test independent of the policies registry contents.
      complianceRefs: ['PCI-DSS-12.3.1', 'ISO 27001:2022 A.5.34'],
      requestedByUserId: 998999,
      requestedByEmail: 'redaction-int-requester@walaplus-test.invalid',
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

    console.log(`\n${passed} passed, ${failed} failed`);

    if (failed > 0) {
      console.error('\n❌ AI approval-queue HTTP secret-leak integration test FAILED');
      process.exit(1);
    }
    console.log('\n✅ All AI approval-queue HTTP read endpoints redact secrets');
  } finally {
    if (actionCode) {
      try {
        await aiApprovalPool.query(
          'DELETE FROM ai_pending_actions WHERE action_code = $1',
          [actionCode],
        );
      } catch (err) {
        console.error(`⚠ Failed to clean up seeded row ${actionCode}:`, err);
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
