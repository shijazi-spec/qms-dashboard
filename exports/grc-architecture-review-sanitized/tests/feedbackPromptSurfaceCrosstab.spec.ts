/**
 * E2E coverage for Task #732: per-(prompt_version × client_surface)
 * cross-tab and Surface badge distribution on the AI Ops Consultant
 * Feedback tab. Also closes the #749/#800 Surface-badge gap.
 *
 * Run: npx playwright test tests/feedbackPromptSurfaceCrosstab.spec.ts
 */

import { test, expect, type Page } from '@playwright/test';
import * as pg from 'pg';

const BASE_URL = process.env.BASE_URL || '<REDACTED_URL>';
const ADMIN_KEY = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

// Unique per-run suffix so parallel/repeated runs don't collide.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// Plain alphabetic labels so wrapPoolForRedaction doesn't redact them.
const PROMPT_VERSION_A = `<REDACTED_EMAIL>${RUN_ID.replace(/[^a-z]/g, '')}`;
const PROMPT_VERSION_B = `<REDACTED_EMAIL>${RUN_ID.replace(/[^a-z]/g, '')}`;

const ROW_A_MOBILE_DOWN = `e2e-xtab-A-mobile-down-${RUN_ID}`;
const ROW_A_WEB_UP = `e2e-xtab-A-web-up-${RUN_ID}`;
const ROW_B_ChatProvider_UP = `e2e-xtab-B-ChatProvider-up-${RUN_ID}`;
const ROW_LEGACY_DOWN = `e2e-xtab-legacy-down-${RUN_ID}`;
const ROW_B_WEB_DOWN = `e2e-xtab-B-web-down-${RUN_ID}`;
const ROW_A_MOBILE_DOWN_2 = `e2e-xtab-A-mobile-down-2-${RUN_ID}`;

let pool: pg.Pool | null = null;
const seededMessageIds: string[] = [
  ROW_A_MOBILE_DOWN,
  ROW_A_WEB_UP,
  ROW_B_ChatProvider_UP,
  ROW_LEGACY_DOWN,
  ROW_B_WEB_DOWN,
  ROW_A_MOBILE_DOWN_2,
];

async function seedFeedbackRows(): Promise<void> {
  if (!pool) throw new Error('pool not initialized');

  const rows: Array<{
    messageId: string;
    rating: 'up' | 'down';
    metadata: Record<string, string> | null;
  }> = [
    {
      messageId: ROW_A_MOBILE_DOWN,
      rating: 'down',
      metadata: { prompt_version: PROMPT_VERSION_A, client_surface: 'mobile' },
    },
    {
      messageId: ROW_A_WEB_UP,
      rating: 'up',
      metadata: { prompt_version: PROMPT_VERSION_A, client_surface: 'web' },
    },
    {
      messageId: ROW_B_ChatProvider_UP,
      rating: 'up',
      metadata: { prompt_version: PROMPT_VERSION_B, client_surface: 'ChatProvider' },
    },
    // Extra down rows give the negative list a badge distribution of
    // mobile×2, web×1, none×1 (legacy `{}` metadata).
    {
      messageId: ROW_B_WEB_DOWN,
      rating: 'down',
      metadata: { prompt_version: PROMPT_VERSION_B, client_surface: 'web' },
    },
    {
      messageId: ROW_A_MOBILE_DOWN_2,
      rating: 'down',
      metadata: { prompt_version: PROMPT_VERSION_A, client_surface: 'mobile' },
    },
    { messageId: ROW_LEGACY_DOWN, rating: 'down', metadata: null },
  ];

  for (const r of rows) {
    await pool.query(
      `INSERT INTO ai_response_feedback (message_id, agent, rating, category, metadata)
       VALUES ($1, 'qmsConsultantAgent', $2, 'incorrect', $3::jsonb)`,
      [r.messageId, r.rating, JSON.stringify(r.metadata ?? {})],
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
    console.warn('[feedbackPromptSurfaceCrosstab] cleanup failed:', err);
  }
}

async function authenticateAsAdmin(page: Page): Promise<void> {
  const res = await page.request.post(`${BASE_URL}/api/admin/auth`, {
    data: { key: ADMIN_KEY },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(res.status(), 'admin /api/admin/auth login should succeed').toBe(200);
}

async function findSeededIds(): Promise<Record<string, string | null>> {
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
    mobileDown: byMessageId[ROW_A_MOBILE_DOWN] ?? null,
    mobileDown2: byMessageId[ROW_A_MOBILE_DOWN_2] ?? null,
    webDown: byMessageId[ROW_B_WEB_DOWN] ?? null,
    ChatProviderUp: byMessageId[ROW_B_ChatProvider_UP] ?? null,
    legacyDown: byMessageId[ROW_LEGACY_DOWN] ?? null,
  };
}

test.describe('AI Ops — Consultant Feedback prompt × surface cross-tab (Task #732)', () => {
  test.beforeAll(async () => {
    if (!ADMIN_KEY || !DATABASE_URL) return;
    pool = new pg.Pool({ connectionString: DATABASE_URL });
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

  test('Surface badges and prompt × surface cross-tab render with expected cells', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }
    if (!DATABASE_URL) {
      test.skip(true, 'DATABASE_URL not set in environment');
      return;
    }

    const ids = await findSeededIds();
    expect(ids.mobileDown, 'A/mobile down seed should have a numeric id').not.toBeNull();
    expect(ids.mobileDown2, 'A/mobile down #2 seed should have a numeric id').not.toBeNull();
    expect(ids.webDown, 'B/web down seed should have a numeric id').not.toBeNull();
    expect(ids.legacyDown, 'legacy down seed should have a numeric id').not.toBeNull();

    await authenticateAsAdmin(page);
    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');

    const feedbackTab = page.locator('[data-testid="tab-feedback"]');
    await expect(feedbackTab).toBeVisible({ timeout: 10000 });
    await feedbackTab.click();

    // (a) Surface badge distribution on negative-feedback rows
    // (closes #749 / #800 gap).
    const mobileBadge1 = page.locator(`[data-testid="badge-recent-client-surface-${ids.mobileDown}"]`);
    const mobileBadge2 = page.locator(`[data-testid="badge-recent-client-surface-${ids.mobileDown2}"]`);
    const webBadge = page.locator(`[data-testid="badge-recent-client-surface-${ids.webDown}"]`);
    const legacyBadge = page.locator(`[data-testid="badge-recent-client-surface-${ids.legacyDown}"]`);

    await expect(mobileBadge1, 'first mobile-down row should render its surface badge').toBeVisible({ timeout: 15000 });
    await expect(mobileBadge1).toHaveText('mobile');
    await expect(mobileBadge2, 'second mobile-down row should render its own surface badge (not deduped)').toBeVisible();
    await expect(mobileBadge2).toHaveText('mobile');
    await expect(webBadge, 'web-down row should render its surface badge').toBeVisible();
    await expect(webBadge).toHaveText('web');
    await expect(legacyBadge, 'legacy row with `{}` metadata should NOT carry a surface badge').toHaveCount(0);

    // Aggregate distribution check across the seeded down rows.
    const seededRowIds = [ids.mobileDown, ids.mobileDown2, ids.webDown, ids.legacyDown].filter(Boolean) as string[];
    const seededBadgeTexts = await Promise.all(
      seededRowIds.map(async (id) => {
        const loc = page.locator(`[data-testid="badge-recent-client-surface-${id}"]`);
        return (await loc.count()) > 0 ? (await loc.innerText()).trim() : null;
      }),
    );
    const counts: Record<string, number> = {};
    for (const txt of seededBadgeTexts) {
      if (txt) counts[txt] = (counts[txt] ?? 0) + 1;
    }
    expect(counts.mobile ?? 0, 'two mobile-down seeds should yield two `mobile` badges').toBe(2);
    expect(counts.web ?? 0, 'one web-down seed should yield one `web` badge').toBe(1);
    expect(counts.ChatProvider ?? 0, 'the ChatProvider seed was thumbs-up so it must not appear in the negative list').toBe(0);
    expect(seededBadgeTexts.filter((t) => t === null).length, 'legacy `{}`-metadata row must contribute exactly one badge-less down row').toBe(1);

    // (b) Cross-tab cells (rows = prompt versions, cols = client surfaces).
    const xtab = page.locator('[data-testid="table-feedback-prompt-version-surfaces"]');
    await expect(xtab, 'cross-tab table should render').toBeVisible();

    const cellAMobile = page.locator(`[data-testid="cell-feedback-prompt-surface-${PROMPT_VERSION_A}-mobile"]`);
    const cellAWeb = page.locator(`[data-testid="cell-feedback-prompt-surface-${PROMPT_VERSION_A}-web"]`);
    const cellBChatProvider = page.locator(`[data-testid="cell-feedback-prompt-surface-${PROMPT_VERSION_B}-ChatProvider"]`);
    const cellUnknown = page.locator('[data-testid="cell-feedback-prompt-surface-unknown-unknown"]');

    // (A, mobile): two thumbs-down → 0% ratio with red colour.
    await expect(cellAMobile, '(A, mobile) cell should render').toBeVisible();
    await expect(cellAMobile).toContainText('0%');
    await expect(cellAMobile).toHaveClass(/text-red-600/);

    // (A, web): one thumbs-up → 100% ratio with green colour.
    await expect(cellAWeb, '(A, web) cell should render').toBeVisible();
    await expect(cellAWeb).toContainText('100%');
    await expect(cellAWeb).toHaveClass(/text-green-700/);

    // (B, ChatProvider): one thumbs-up → 100% ratio with green colour.
    await expect(cellBChatProvider, '(B, ChatProvider) cell should render').toBeVisible();
    await expect(cellBChatProvider).toContainText('100%');
    await expect(cellBChatProvider).toHaveClass(/text-green-700/);

    // (unknown, unknown): one thumbs-down → 0% ratio (red) — locks in
    // that the COALESCE-to-'unknown' fallback for legacy `{}` metadata
    // is still in place on both axes.
    await expect(cellUnknown, '(unknown, unknown) cell should render for the legacy row').toBeVisible();
    await expect(cellUnknown).toContainText('0%');
    await expect(cellUnknown).toHaveClass(/text-red-600/);
  });
});
