/**
 * E2E test for the "Prompt Version" tab on /ai-ops.
 *
 * Background:
 *   The Prompt Version tab is rendered client-side from the
 *   `GET /api/ai-ops/prompt-versions` endpoint, which itself is backed by
 *   `getFeedbackRateByPromptVersion()` in src/utils/aiTelemetry.ts. A
 *   previous Playwright run that exercised the rendered UI timed out, so
 *   the tab's wiring (markup ↔ aggregate ↔ rendering) only had API-level
 *   coverage.
 *
 * What this test does:
 *   1. Authenticates as admin via /api/admin/auth and pins
 *      `X-Admin-Key` on every request the browser makes (so both the page
 *      load and its AJAX calls are admin-authorized).
 *   2. Seeds two prompt-version cohorts for one synthetic agent in
 *      ai_call_metrics + ai_call_feedback:
 *        - "v_best_e2e"      → 5 calls, all thumbs_up   (rate 100%)
 *        - "v_regressed_e2e" → 5 calls, all thumbs_down (rate 0%)
 *      Five votes per cohort meets the dashboard's small-sample floor
 *      (DEFAULT_PROMPT_VERSION_MIN_FEEDBACK = 5 in src/utils/aiTelemetry.ts).
 *      That gap (100 vs 0) is comfortably above the 10pp regression
 *      threshold the dashboard uses, and forces a "best" highlight on
 *      one row and a "regressed" highlight on the other.
 *   3. Opens /ai-ops, clicks the Prompt Version tab, asserts both rows
 *      appear in the agent's table, the best row carries the ★ badge
 *      with the green-rate styling, and the regressed row carries the
 *      red-rate styling.
 *   4. Cleans up every metric/feedback row it seeded on teardown
 *      (feedback is deleted by ON DELETE CASCADE on call_id).
 *
 * Requirements:
 *   - The dev server must be running at BASE_URL (default
 *     http://localhost:5000) — same convention as tests/i18n.spec.ts.
 *   - ADMIN_API_KEY (or TEST_ADMIN_KEY) must be set in the environment so
 *     the test can authenticate; otherwise the suite is skipped.
 *   - DATABASE_URL must point at the same Postgres the server uses so
 *     the seed/cleanup can write directly.
 *
 * Run:
 *   npx playwright test tests/promptVersionTab.spec.ts --reporter=line
 */

import { test, expect, type Page } from '@playwright/test';
import * as pg from 'pg';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const ADMIN_KEY = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

// Unique per-run suffix so parallel/repeated runs don't collide and so
// our cleanup WHERE clause is safe to run unconditionally.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const AGENT_NAME = `e2e_prompt_version_${RUN_ID}`;
const VERSION_BEST = 'v_best_e2e';
const VERSION_REGRESSED = 'v_regressed_e2e';

let pool: pg.Pool | null = null;
const seededCallIds: number[] = [];

async function seedPromptVersionRows(): Promise<void> {
  if (!pool) throw new Error('pool not initialized');

  // Five "good" calls under v_best_e2e, all thumbs-up → 100% feedback rate.
  // Five "bad"  calls under v_regressed_e2e, all thumbs-down → 0% rate.
  // We seed five (not three) per cohort so each version clears the
  // small-sample floor (default 5 votes) the dashboard now requires
  // before it will flag a row as "best ★" or as a regression — see
  // DEFAULT_PROMPT_VERSION_MIN_FEEDBACK in src/utils/aiTelemetry.ts.
  // tool_name MUST be NULL because getFeedbackRateByPromptVersion filters
  // tool-call children out of the aggregate.
  const cohorts: Array<{ version: string; rating: 'thumbs_up' | 'thumbs_down'; latencyMs: number }> = [
    { version: VERSION_BEST,      rating: 'thumbs_up',   latencyMs: 800 },
    { version: VERSION_BEST,      rating: 'thumbs_up',   latencyMs: 900 },
    { version: VERSION_BEST,      rating: 'thumbs_up',   latencyMs: 1000 },
    { version: VERSION_BEST,      rating: 'thumbs_up',   latencyMs: 1050 },
    { version: VERSION_BEST,      rating: 'thumbs_up',   latencyMs: 1100 },
    { version: VERSION_REGRESSED, rating: 'thumbs_down', latencyMs: 1200 },
    { version: VERSION_REGRESSED, rating: 'thumbs_down', latencyMs: 1300 },
    { version: VERSION_REGRESSED, rating: 'thumbs_down', latencyMs: 1400 },
    { version: VERSION_REGRESSED, rating: 'thumbs_down', latencyMs: 1450 },
    { version: VERSION_REGRESSED, rating: 'thumbs_down', latencyMs: 1500 },
  ];

  for (let i = 0; i < cohorts.length; i++) {
    const { version, rating, latencyMs } = cohorts[i];
    const metricRes = await pool.query(
      `INSERT INTO ai_call_metrics
         (agent_name, tool_name, model, latency_ms, success, metadata, started_at)
       VALUES ($1, NULL, 'gpt-4o', $2, TRUE, $3::jsonb, NOW())
       RETURNING id`,
      [AGENT_NAME, latencyMs, JSON.stringify({ prompt_version: version })],
    );
    const callId = Number(metricRes.rows[0].id);
    seededCallIds.push(callId);

    // user_hash must be unique per (call_id, user_hash); using the call id
    // keeps it unique across the suite without colliding with real users.
    await pool.query(
      `INSERT INTO ai_call_feedback (call_id, rating, user_hash)
       VALUES ($1, $2, $3)`,
      [callId, rating, `e2e-${RUN_ID}-${i}`],
    );
  }
}

async function cleanupPromptVersionRows(): Promise<void> {
  if (!pool) return;
  // ai_call_feedback has ON DELETE CASCADE on call_id, so removing the
  // metrics rows is enough — but we also do an explicit agent-name sweep
  // in case the test crashed mid-seed and we need a belt-and-braces
  // cleanup pass.
  if (seededCallIds.length > 0) {
    await pool.query(
      `DELETE FROM ai_call_metrics WHERE id = ANY($1::bigint[])`,
      [seededCallIds],
    );
    seededCallIds.length = 0;
  }
  await pool.query(
    `DELETE FROM ai_call_metrics WHERE agent_name = $1`,
    [AGENT_NAME],
  );
}

async function authenticateAsAdmin(page: Page): Promise<void> {
  // Drops the admin_key cookie on the browser context as a courtesy so a
  // human watching headed mode is signed in too. The X-Admin-Key header
  // (set via context.extraHTTPHeaders) is what actually authorizes both
  // the page request and the AJAX calls fired by ai-ops.html.
  const res = await page.request.post(`${BASE_URL}/api/admin/auth`, {
    data: { key: ADMIN_KEY },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(res.status(), 'admin /api/admin/auth login should succeed').toBe(200);
}

test.describe('AI Ops — Prompt Version tab', () => {
  test.beforeAll(async () => {
    if (!ADMIN_KEY || !DATABASE_URL) return;
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await seedPromptVersionRows();
  });

  test.afterAll(async () => {
    try {
      await cleanupPromptVersionRows();
    } finally {
      await pool?.end().catch(() => {});
      pool = null;
    }
  });

  test.use({
    extraHTTPHeaders: ADMIN_KEY ? { 'X-Admin-Key': ADMIN_KEY } : {},
  });

  test('renders both seeded prompt versions with best ★ badge and regression highlight', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }
    if (!DATABASE_URL) {
      test.skip(true, 'DATABASE_URL not set in environment');
      return;
    }

    await authenticateAsAdmin(page);

    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');

    // Click the Prompt Version tab. The tab handler calls loadPromptVersions()
    // which fetches /api/ai-ops/prompt-versions?days=30 by default.
    const promptsTab = page.locator('[data-testid="tab-prompts"]');
    await expect(promptsTab).toBeVisible({ timeout: 10000 });
    await promptsTab.click();

    // The agent block is keyed by agent name; its existence proves the
    // aggregate is reaching the DOM for our seeded data.
    const agentBlock = page.locator(`[data-testid="block-prompt-agent-${AGENT_NAME}"]`);
    await expect(agentBlock).toBeVisible({ timeout: 15000 });

    const bestRow = page.locator(`[data-testid="row-prompt-${AGENT_NAME}-${VERSION_BEST}"]`);
    const regressedRow = page.locator(`[data-testid="row-prompt-${AGENT_NAME}-${VERSION_REGRESSED}"]`);

    await expect(bestRow, 'best prompt-version row should render').toBeVisible();
    await expect(regressedRow, 'regressed prompt-version row should render').toBeVisible();

    // The best row's feedback-rate cell carries the ★ badge plus the
    // green-rate class; the regressed row carries the red-rate class.
    const bestRate = page.locator(`[data-testid="text-prompt-feedback-rate-${VERSION_BEST}"]`);
    const regressedRate = page.locator(`[data-testid="text-prompt-feedback-rate-${VERSION_REGRESSED}"]`);

    await expect(bestRate, 'best row should show the ★ badge').toContainText('★');
    await expect(bestRate, 'best row should render the 100% feedback rate').toContainText('100%');

    const bestRateInner = bestRate.locator('span').first();
    await expect(bestRateInner).toHaveClass(/text-green-700/);

    await expect(regressedRate, 'regressed row should render the 0% feedback rate').toContainText('0%');
    await expect(regressedRate, 'regressed row should not show the ★ badge').not.toContainText('★');
    const regressedRateInner = regressedRate.locator('span').first();
    await expect(regressedRateInner).toHaveClass(/text-red-600/);
  });
});
