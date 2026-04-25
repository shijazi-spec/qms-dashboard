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
 *   1. Logs in via POST /api/admin/auth so the shared admin auth contract
 *      is honoured (and the rate limiter is hit at most once per suite).
 *   2. Issues GET /api/ai-ops/prompt-versions, which under the hood calls
 *      `getFeedbackRateByPromptVersion()` and so triggers BOTH
 *      `ensureAiMetricsTable()` and `ensureFeedbackTable()`. This is a
 *      strict superset of what `/api/ai-ops/summary` ensures, so a single
 *      call covers every spec that has needed a warmup so far.
 *
 * Throws if either request returns a non-200 status so suite setup fails
 * loudly instead of silently leaving tables uncreated.
 */

import { request as pwRequest } from '@playwright/test';

export async function warmupAiOpsTables(
  adminKey: string,
  baseUrl: string,
): Promise<void> {
  const apiCtx = await pwRequest.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { 'X-Admin-Key': adminKey },
  });
  try {
    const authRes = await apiCtx.post('/api/admin/auth', {
      data: { key: adminKey },
      headers: { 'Content-Type': 'application/json' },
    });
    if (authRes.status() !== 200) {
      throw new Error(
        `/api/admin/auth login returned HTTP ${authRes.status()}`,
      );
    }

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
  }
}
