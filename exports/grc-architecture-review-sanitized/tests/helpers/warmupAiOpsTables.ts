/**
 * Shared warmup helper for AI Ops e2e specs that seed rows directly via the
 * Postgres pool.
 *
 * Why this exists:
 *   Several AI Ops tables (ai_call_metrics, ai_call_feedback, ...) are
 *   created lazily by `ensureAiMetricsTable()` / `ensureFeedbackTable()` in
 *   src/utils/aiTelemetry.ts on the first request that needs them. A spec
 *   that opens a `pg.Pool` and INSERTs seed rows BEFORE the server has had
 *   a chance to run those CREATE TABLE IF NOT EXISTS statements will crash
 *   on a cold/dev DB with `relation "ai_call_metrics" does not exist`.
 *
 *   Both `tests/aiOpsTabs.spec.ts` and `tests/promptVersionTab.spec.ts`
 *   used to copy/paste an inline `beforeAll` block that authenticated as
 *   admin and then GET'd an AI Ops endpoint to trigger the lazy table
 *   creation. Centralising that block here means future seed-based specs
 *   can `await warmupAiOpsTables(...)` and not have to remember the
 *   pattern (or accidentally pick a warmup endpoint that only ensures
 *   some of the tables).
 *
 * What this does:
 *   1. Signs a `ExampleOrg_session` cookie (HMAC-SHA256 over a base64url
 *      payload, keyed by SESSION_SECRET) for a synthetic admin email and
 *      seeds an active `platform_users` row for that email. Security
 *      hardening (Task #855/#831) scoped X-Admin-Key to /api/admin/* and
 *      /api/inngest* only, and requireRole() now ALWAYS performs a live
 *      getPlatformUser() lookup, so /api/ai-ops/* routes need a real
 *      session cookie backed by an active platform_users row.
 *   2. Issues GET /api/ai-ops/prompt-versions, which under the hood calls
 *      `getFeedbackRateByPromptVersion()` and so triggers BOTH
 *      `ensureAiMetricsTable()` and `ensureFeedbackTable()`. This is a
 *      strict superset of what `/api/ai-ops/summary` ensures, so a single
 *      call covers every spec that has needed a warmup so far.
 *
 * Throws if the warmup request returns a non-200 status so suite setup fails
 * loudly instead of silently leaving tables uncreated.
 */

import { request as pwRequest } from '@playwright/test';
import pg from 'pg';
import crypto from 'crypto';

const SESSION_SECRET = process.env.SESSION_SECRET || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

// Synthetic admin identity used purely for AI Ops warmup. The signed cookie
// and the seeded platform_users row share this email so the live
// getPlatformUser() lookup in requireRole() resolves to an active admin.
const WARMUP_SESSION_EMAIL = 'user@example.invalid';

function signWarmupSession(): string {
  if (!SESSION_SECRET) return '';
  const payload = {
    userId: 0,
    email: WARMUP_SESSION_EMAIL,
    name: 'AI Ops Warmup Admin',
    role: 'admin',
    exp: Date.now() + 86_400_000,
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export async function warmupAiOpsTables(
  _adminKey: string,
  baseUrl: string,
): Promise<void> {
  const token = signWarmupSession();
  if (!token) {
    throw new Error(
      'warmupAiOpsTables: SESSION_SECRET is not set — cannot sign a ExampleOrg_session cookie for AI Ops warmup',
    );
  }
  const sessionCookie = `ExampleOrg_session=${encodeURIComponent(token)}`;

  // Seed an active platform_users row for the warmup session email so the live
  // getPlatformUser() lookup in requireRole() passes for /api/ai-ops/* routes.
  let pool: pg.Pool | null = null;
  if (DATABASE_URL) {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query(
      `INSERT INTO platform_users (email, full_name, role, status)
       VALUES ($1, 'AI Ops Warmup Admin', 'admin', 'active')
       ON CONFLICT (email) DO UPDATE SET role = 'admin', status = 'active'`,
      [WARMUP_SESSION_EMAIL],
    );
  }

  const apiCtx = await pwRequest.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { Cookie: sessionCookie },
  });
  try {
    // /api/ai-ops/prompt-versions runs getFeedbackRateByPromptVersion(),
    // which calls both ensureAiMetricsTable() and ensureFeedbackTable().
    // That covers every AI Ops table any current seed-based spec needs,
    // so a single warmup endpoint suffices.
    const warmupRes = await apiCtx.get('/api/ai-ops/prompt-versions');
    if (warmupRes.status() !== 200) {
      throw new Error(
        `/api/ai-ops/prompt-versions warmup returned HTTP ${warmupRes.status()}`,
      );
    }
  } finally {
    await apiCtx.dispose();
    if (pool) await pool.end();
  }
}
