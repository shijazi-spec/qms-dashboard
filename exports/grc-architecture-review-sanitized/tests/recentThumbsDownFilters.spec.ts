/**
 * E2E test for the prompt-version / client-surface filter dropdowns on the
 * AI Operations dashboard's "Recent Thumbs-Down" panel (Task #753).
 *
 * What this spec covers (and why this lives at the playwright layer):
 *   The SQL plumbing for the new filters is already covered by the helper
 *   suite in src/utils/__tests__/aiFeedbackRecentFilters.test.ts. What
 *   that suite *cannot* catch is a regression in the wiring between the
 *   markup, the dropdown change handler, the AJAX query string, the
 *   server-side metadata->>'client_surface' WHERE clause, and the URL
 *   sync. A future refactor of dashboard/ai-ops.html or the consultant
 *   feedback route could silently break any one of those without the
 *   helper tests noticing — this spec is the regression alarm for the
 *   user-facing filter contract.
 *
 * What this spec does:
 *   1. Authenticates as admin via /api/admin/auth and pins X-Admin-Key on
 *      every browser request (same pattern as promptVersionTab.spec.ts).
 *   2. Seeds three thumbs-down rows directly into ai_response_feedback
 *      with distinct combinations of prompt_version + client_surface so
 *      each filter combination has a uniquely-identifiable row.
 *   3. Loads /ai-ops, switches to the Consultant Feedback tab, and
 *      asserts:
 *        a. With no filters, all three seeded cards render.
 *        b. Selecting a client_surface narrows the list to the matching
 *           seeded row(s) and removes the others, AND the URL gains a
 *           ?client_surface=... param.
 *        c. Selecting a prompt_version on top of (b) narrows further to
 *           a single seeded row, AND the URL gains a ?prompt_version=...
 *           param.
 *        d. Clicking "Clear" empties both selects, restores all three
 *           seeded cards, and removes both query params from the URL.
 *   4. Cleans up the seeded rows on teardown.
 *
 * Requirements:
 *   - Dev server running at BASE_URL (default <REDACTED_URL>
 *   - ADMIN_API_KEY (or TEST_ADMIN_KEY) set so /api/admin/auth succeeds.
 *   - DATABASE_URL set so the seed/cleanup can write directly.
 *
 * Run:
 *   npx playwright test tests/recentThumbsDownFilters.spec.ts --reporter=line
 */

import { test, expect, type Page } from '@playwright/test';
import * as pg from 'pg';

const BASE_URL = process.env.BASE_URL || '<REDACTED_URL>';
const ADMIN_KEY = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

// Unique per-run suffix so parallel/repeated runs don't collide and the
// per-row WHERE clauses on cleanup are unambiguous.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// Plain alphabetic labels (no high-entropy hex tail) so the
// wrapPoolForRedaction guard in src/utils/redactedPool.ts doesn't
// mistake the synthetic test value for a credential and replace it
// with `***REDACTED***` mid-write — that would silently break the
// per-version assertions below. Mirrors the convention used by the
// "qms-consultant@feedbacktest" labels in tests/consultantRoutes.test.ts.
const PROMPT_VERSION_A = `qms-consultant@filtertestaprompt${RUN_ID.replace(/[^a-z]/g, '')}`;
const PROMPT_VERSION_B = `qms-consultant@filtertestbprompt${RUN_ID.replace(/[^a-z]/g, '')}`;

// Seeded row identifiers. Each row has a unique (prompt_version,
// client_surface) tuple so the filter combinations below select an
// unambiguous subset.
const ROW_A_WEB = `e2e-recent-filter-A-web-${RUN_ID}`;
const ROW_A_MOBILE = `e2e-recent-filter-A-mobile-${RUN_ID}`;
const ROW_B_WEB = `e2e-recent-filter-B-web-${RUN_ID}`;

let pool: pg.Pool | null = null;
const seededMessageIds: string[] = [ROW_A_WEB, ROW_A_MOBILE, ROW_B_WEB];

async function seedFeedbackRows(): Promise<void> {
  if (!pool) throw new Error('pool not initialized');

  const rows: Array<{
    messageId: string;
    promptVersion: string;
    clientSurface: 'web' | 'mobile' | 'slack';
  }> = [
    { messageId: ROW_A_WEB, promptVersion: PROMPT_VERSION_A, clientSurface: 'web' },
    { messageId: ROW_A_MOBILE, promptVersion: PROMPT_VERSION_A, clientSurface: 'mobile' },
    { messageId: ROW_B_WEB, promptVersion: PROMPT_VERSION_B, clientSurface: 'web' },
  ];

  for (const r of rows) {
    await pool.query(
      `INSERT INTO ai_response_feedback (message_id, agent, rating, category, metadata)
       VALUES ($1, 'qmsConsultantAgent', 'down', 'incorrect', $2::jsonb)`,
      [
        r.messageId,
        JSON.stringify({
          prompt_version: r.promptVersion,
          rating_source: 'inline_thumbs',
          client_surface: r.clientSurface,
        }),
      ],
    );
  }
}

async function cleanupFeedbackRows(): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(
      `DELETE FROM ai_response_feedback WHERE message_id = ANY($1::text[])`,
      [seededMessageIds],
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[recentThumbsDownFilters] cleanup failed:', err);
  }
}

async function authenticateAsAdmin(page: Page): Promise<void> {
  // Drops the admin_key cookie on the browser context so a human watching
  // headed mode is signed in too. The X-Admin-Key header (set via
  // context.extraHTTPHeaders below) is what actually authorizes both the
  // page request and the AJAX calls fired by ai-ops.html.
  const res = await page.request.post(`${BASE_URL}/api/admin/auth`, {
    data: { key: ADMIN_KEY },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(res.status(), 'admin /api/admin/auth login should succeed').toBe(200);
}

async function findSeededIds(page: Page): Promise<{
  rowAWeb: string | null;
  rowAMobile: string | null;
  rowBWeb: string | null;
}> {
  // The card data-testid uses the ai_response_feedback row's serial id,
  // not the message_id — so to assert visibility we need to look up
  // those numeric ids by message_id. We do this via the same pool the
  // suite uses, not via the DOM, so the assertion is robust to whatever
  // ordering the API returns.
  if (!pool) throw new Error('pool not initialized');
  const res = await pool.query(
    `SELECT message_id, id FROM ai_response_feedback
     WHERE message_id = ANY($1::text[])`,
    [seededMessageIds],
  );
  const byMessageId: Record<string, string> = {};
  for (const row of res.rows) {
    byMessageId[String(row.message_id)] = String(row.id);
  }
  return {
    rowAWeb: byMessageId[ROW_A_WEB] ?? null,
    rowAMobile: byMessageId[ROW_A_MOBILE] ?? null,
    rowBWeb: byMessageId[ROW_B_WEB] ?? null,
  };
}

test.describe('AI Ops — Recent Thumbs-Down filters (Task #753)', () => {
  test.beforeAll(async () => {
    if (!ADMIN_KEY || !DATABASE_URL) return;
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    // initAIFeedbackTable() runs at module-load time inside
    // consultantRoutes.ts, so by the time the dev server is accepting
    // requests at all, the ai_response_feedback table already exists.
    // No /api/* warmup is needed — unlike the ai_call_metrics-based
    // specs which depend on the lazy ensureAiMetricsTable() path.
    await seedFeedbackRows();
  });

  test.afterAll(async () => {
    try {
      await cleanupFeedbackRows();
    } finally {
      await pool?.end().catch(() => {});
      pool = null;
    }
  });

  test.use({
    extraHTTPHeaders: ADMIN_KEY ? { 'X-Admin-Key': ADMIN_KEY } : {},
  });

  test('dropdowns filter the recent list server-side and sync the URL', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }
    if (!DATABASE_URL) {
      test.skip(true, 'DATABASE_URL not set in environment');
      return;
    }

    const ids = await findSeededIds(page);
    expect(ids.rowAWeb, 'seed row A/web should have a numeric id').not.toBeNull();
    expect(ids.rowAMobile, 'seed row A/mobile should have a numeric id').not.toBeNull();
    expect(ids.rowBWeb, 'seed row B/web should have a numeric id').not.toBeNull();

    await authenticateAsAdmin(page);
    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');

    // Open the Consultant Feedback tab. The tab handler calls
    // loadAIFeedback() which fetches /api/consultant/feedback/stats and
    // renders the recent thumbs-down cards into #ai-ops-feedback-recent.
    const feedbackTab = page.locator('[data-testid="tab-feedback"]');
    await expect(feedbackTab).toBeVisible({ timeout: 10000 });
    await feedbackTab.click();

    const cardA_Web = page.locator(`[data-testid="card-recent-thumbs-down-${ids.rowAWeb}"]`);
    const cardA_Mobile = page.locator(`[data-testid="card-recent-thumbs-down-${ids.rowAMobile}"]`);
    const cardB_Web = page.locator(`[data-testid="card-recent-thumbs-down-${ids.rowBWeb}"]`);

    // -----------------------------------------------------------------
    // (a) No filters → all three seeded cards render.
    // -----------------------------------------------------------------
    await expect(cardA_Web, 'row A/web should render with no filter').toBeVisible({ timeout: 15000 });
    await expect(cardA_Mobile, 'row A/mobile should render with no filter').toBeVisible();
    await expect(cardB_Web, 'row B/web should render with no filter').toBeVisible();

    const surfaceSelect = page.locator('[data-testid="select-feedback-client-surface"]');
    const promptSelect = page.locator('[data-testid="select-feedback-prompt-version"]');
    await expect(surfaceSelect, 'client-surface dropdown should render').toBeVisible();
    await expect(promptSelect, 'prompt-version dropdown should render').toBeVisible();

    // -----------------------------------------------------------------
    // (b) client_surface=mobile → only A/mobile remains, URL gains the
    //     query param so the view is shareable.
    // -----------------------------------------------------------------
    const responseMobile = page.waitForResponse((r) =>
      r.url().includes('/api/consultant/feedback/stats') &&
      r.url().includes('client_surface=mobile'),
    );
    await surfaceSelect.selectOption('mobile');
    await responseMobile;

    await expect(cardA_Mobile, 'row A/mobile should still render under client_surface=mobile').toBeVisible();
    await expect(cardA_Web, 'row A/web should be filtered out under client_surface=mobile').toHaveCount(0);
    await expect(cardB_Web, 'row B/web should be filtered out under client_surface=mobile').toHaveCount(0);

    await expect.poll(() => new URL(page.url()).searchParams.get('client_surface'),
      { message: 'URL should carry client_surface=mobile after the dropdown commits' })
      .toBe('mobile');

    // -----------------------------------------------------------------
    // (c) Add prompt_version=A on top of client_surface=mobile → still
    //     only A/mobile remains (the row already matched both filters),
    //     and now the URL carries BOTH query params.
    // -----------------------------------------------------------------
    const responsePromptA = page.waitForResponse((r) =>
      r.url().includes('/api/consultant/feedback/stats') &&
      r.url().includes('prompt_version=') &&
      r.url().includes('client_surface=mobile'),
    );
    await promptSelect.selectOption(PROMPT_VERSION_A);
    await responsePromptA;

    await expect(cardA_Mobile, 'row A/mobile should remain under combined filters').toBeVisible();
    await expect(cardA_Web, 'row A/web should be filtered out under combined filters').toHaveCount(0);
    await expect(cardB_Web, 'row B/web should be filtered out under combined filters').toHaveCount(0);

    await expect.poll(() => new URL(page.url()).searchParams.get('prompt_version'),
      { message: 'URL should carry prompt_version=A after the dropdown commits' })
      .toBe(PROMPT_VERSION_A);
    await expect.poll(() => new URL(page.url()).searchParams.get('client_surface'),
      { message: 'URL should still carry client_surface=mobile' })
      .toBe('mobile');

    // -----------------------------------------------------------------
    // (d) Clear → both selects empty, all three cards return, URL
    //     params drop.
    // -----------------------------------------------------------------
    const responseCleared = page.waitForResponse((r) => {
      const url = r.url();
      return url.includes('/api/consultant/feedback/stats') &&
        !url.includes('prompt_version=') &&
        !url.includes('client_surface=');
    });
    await page.locator('[data-testid="button-feedback-filters-clear"]').click();
    await responseCleared;

    await expect(surfaceSelect).toHaveValue('');
    await expect(promptSelect).toHaveValue('');

    await expect(cardA_Web, 'row A/web should return after clearing filters').toBeVisible();
    await expect(cardA_Mobile, 'row A/mobile should return after clearing filters').toBeVisible();
    await expect(cardB_Web, 'row B/web should return after clearing filters').toBeVisible();

    await expect.poll(() => new URL(page.url()).searchParams.get('prompt_version'),
      { message: 'URL prompt_version should be cleared' })
      .toBeNull();
    await expect.poll(() => new URL(page.url()).searchParams.get('client_surface'),
      { message: 'URL client_surface should be cleared' })
      .toBeNull();
  });
});
