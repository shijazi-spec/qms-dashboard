/**
 * E2E test for the per-check SVG sparkline rendered inside each expanded
 * check row on the Health Pulse dashboard (Task #760).
 *
 * Task #509 added a unit test for the backend `buildPerCheckHistory`
 * helper, but the dashboard rendering of the SVG sparkline (markup, data
 * wiring from /api/health/pulse, hover tooltip) was uncovered. This spec
 * mocks the pulse payload, expands a check row, and asserts:
 *   1. The full-size <svg> sparkline is rendered with one <rect> per
 *      historical run, in the colour mapped to that run's status.
 *   2. Each rect carries a native <title> tooltip whose text reflects
 *      the run timestamp + status, and the tooltip text is observable
 *      after hovering the rect.
 *
 * Run:
 *   npx playwright test tests/healthPulsePerCheckSparkline.spec.ts --reporter=line
 */

import { test, expect, request as pwRequest } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || '<REDACTED_URL>';
const ADMIN_KEY = process.env.ADMIN_API_KEY || process.env.TEST_ADMIN_KEY || '';
const PULSE_PATH = '/api/health/pulse';

function shouldSkip(): boolean {
  return !ADMIN_KEY;
}

const FAILING_CHECK_ID = 'fixture.sparkline-failing';
const PASSING_CHECK_ID = 'fixture.sparkline-passing';

const FAIL_HISTORY = [
  { run_at: new Date(Date.now() - 5 * 60_000).toISOString(), status: 'pass' },
  { run_at: new Date(Date.now() - 4 * 60_000).toISOString(), status: 'pass' },
  { run_at: new Date(Date.now() - 3 * 60_000).toISOString(), status: 'warn' },
  { run_at: new Date(Date.now() - 2 * 60_000).toISOString(), status: 'fail' },
  { run_at: new Date(Date.now() - 1 * 60_000).toISOString(), status: 'fail' },
];

const PASS_HISTORY = [
  { run_at: new Date(Date.now() - 3 * 60_000).toISOString(), status: 'pass' },
  { run_at: new Date(Date.now() - 2 * 60_000).toISOString(), status: 'pass' },
  { run_at: new Date(Date.now() - 1 * 60_000).toISOString(), status: 'pass' },
];

const MOCK_PULSE_PAYLOAD = {
  latest: {
    id: 999760,
    run_at: new Date().toISOString(),
    duration_ms: 137,
    overall_status: 'critical',
    pass_count: 1,
    warn_count: 0,
    fail_count: 1,
    skipped_count: 0,
    checks: [
      {
        id: FAILING_CHECK_ID,
        label: 'Synthetic failing sparkline check',
        category: 'infrastructure',
        status: 'fail',
        duration_ms: 14,
        message: 'Synthetic failure for Task #760 sparkline e2e',
        details: { reason: 'fixture' },
      },
      {
        id: PASSING_CHECK_ID,
        label: 'Synthetic passing sparkline check',
        category: 'infrastructure',
        status: 'pass',
        duration_ms: 7,
        message: null,
        details: null,
      },
    ],
  },
  history: [
    {
      run_at: new Date(Date.now() - 60_000).toISOString(),
      pass_count: 1,
      warn_count: 0,
      fail_count: 1,
    },
  ],
  perCheckHistory: {
    [FAILING_CHECK_ID]: FAIL_HISTORY,
    [PASSING_CHECK_ID]: PASS_HISTORY,
  },
};

const STATUS_BAR_COLOR: Record<string, string> = {
  pass: '#10B981',
  warn: '#F59E0B',
  fail: '#EF4444',
  skipped: '#9CA3AF',
};

test.describe('Health Pulse — per-check expanded sparkline (Task #760)', () => {
  let apiCtx: Awaited<ReturnType<typeof pwRequest.newContext>>;

  test.beforeAll(async () => {
    if (shouldSkip()) return;
    apiCtx = await pwRequest.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { 'X-Admin-Key': ADMIN_KEY },
    });
    let authRes = await apiCtx.post('/api/admin/auth', {
      data: { key: ADMIN_KEY },
      headers: { 'Content-Type': 'application/json' },
    });
    if (authRes.status() === 429) {
      await new Promise((r) => setTimeout(r, 65_000));
      authRes = await apiCtx.post('/api/admin/auth', {
        data: { key: ADMIN_KEY },
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (authRes.status() !== 200) {
      throw new Error(`/api/admin/auth login returned HTTP ${authRes.status()}`);
    }
  });

  test.afterAll(async () => {
    if (apiCtx) await apiCtx.dispose();
  });

  test.use({
    extraHTTPHeaders: ADMIN_KEY ? { 'X-Admin-Key': ADMIN_KEY } : {},
  });

  test.beforeEach(async ({ page }) => {
    if (shouldSkip()) return;
    // Same i18n-race guard as healthPulseCopyCheckLink.spec.ts: hold the
    // mocked pulse fetch until ExampleOrgI18n has loaded its strings,
    // otherwise sparkline labels render raw key fallbacks.
    await page.route(`**${PULSE_PATH}`, async (route) => {
      try {
        await page.waitForFunction(
          () =>
            typeof (window as any).ExampleOrgI18n !== 'undefined' &&
            (window as any).ExampleOrgI18n.t('dyn.health.sparkline_label', { count: 5 }) ===
              'Last 5 runs',
          undefined,
          { timeout: 5_000 }
        );
      } catch {
        /* best-effort */
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_PULSE_PAYLOAD),
      });
    });
  });

  test('Expanded check row renders an SVG sparkline with one <rect> per historical run', async ({ page }) => {
    if (shouldSkip()) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }
    await page.goto(`${BASE_URL}/dashboard/health`);
    await expect(page.locator('[data-testid="list-checks"]')).toBeVisible({ timeout: 15_000 });

    const row = page.locator(`[data-testid="row-check-${FAILING_CHECK_ID}"]`);
    await expect(row).toBeVisible();

    // The full-size sparkline lives inside the expanded body of the
    // <details>. Open the row to make it queryable.
    await row.locator('summary').click();
    expect(await row.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);

    const sparkline = page.locator(`[data-testid="sparkline-${FAILING_CHECK_ID}"]`);
    await expect(sparkline).toBeVisible();

    // SVG element with role="img" and an aria-label referencing this check.
    const tagName = await sparkline.evaluate((el) => el.tagName.toLowerCase());
    expect(tagName).toBe('svg');
    const ariaLabel = await sparkline.getAttribute('aria-label');
    expect(ariaLabel || '').toContain(FAILING_CHECK_ID);

    // One <rect> per historical run, coloured per status.
    const rects = sparkline.locator('rect');
    await expect(rects).toHaveCount(FAIL_HISTORY.length);
    for (let i = 0; i < FAIL_HISTORY.length; i++) {
      const fill = await rects.nth(i).getAttribute('fill');
      expect(fill).toBe(STATUS_BAR_COLOR[FAIL_HISTORY[i].status]);
    }
  });

  test('Hovering a sparkline rect reveals the run timestamp + status tooltip', async ({ page }) => {
    if (shouldSkip()) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }
    await page.goto(`${BASE_URL}/dashboard/health`);
    await expect(page.locator('[data-testid="list-checks"]')).toBeVisible({ timeout: 15_000 });

    const row = page.locator(`[data-testid="row-check-${FAILING_CHECK_ID}"]`);
    await row.locator('summary').click();
    await expect(row).toHaveJSProperty('open', true);

    const sparkline = page.locator(`[data-testid="sparkline-${FAILING_CHECK_ID}"]`);
    await expect(sparkline).toBeVisible();

    // Hover the most recent rect (last in the row, status === 'fail').
    const rects = sparkline.locator('rect');
    const lastRect = rects.last();
    await lastRect.hover();

    // SVG <title> child is what the browser surfaces as the native
    // tooltip on hover. Asserting its textContent both verifies the
    // tooltip is wired to the right run AND matches what the user sees
    // after hover (no separate DOM popover to query for SVG <title>).
    const title = lastRect.locator('title');
    await expect(title).toHaveCount(1);
    const tooltipText = (await title.textContent()) || '';
    expect(tooltipText).toContain('FAIL');
    // Timestamp portion: "<localized date> — FAIL". The exact format
    // depends on the test runner locale, but a year is always present.
    expect(tooltipText).toMatch(/\d{4}/);

    // Cross-check: a non-failing rect's tooltip carries its own status.
    const firstRect = rects.first();
    await firstRect.hover();
    const firstTooltipText = (await firstRect.locator('title').textContent()) || '';
    expect(firstTooltipText).toContain(FAIL_HISTORY[0].status.toUpperCase());
  });
});
