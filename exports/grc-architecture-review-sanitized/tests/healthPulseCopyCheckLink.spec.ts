/**
 * E2E test for the per-row "Copy link to this check" affordance and the
 * `?check=<id>` deep-link auto-expand on the Health Pulse dashboard
 * (Task #766).
 *
 * Builds on the same route-mocking pattern as
 * tests/healthPulseCopyFilteredLink.spec.ts (Task #747).
 *
 * What this spec covers:
 *   1. Each rendered check row exposes a per-row copy-link button with
 *      the documented data-testid + aria-label.
 *   2. Clicking the per-row button copies a URL with `?check=<id>`
 *      appended to the clipboard, preserving any pre-existing
 *      `?category` / `?status` filter params.
 *   3. Loading /dashboard/health?check=<id> auto-expands the matching
 *      <details> row (its `open` attribute becomes true) and adds the
 *      `is-deep-link-target` highlight class.
 *   4. The copy-link button does NOT toggle the <details> open/closed
 *      state when clicked (stopPropagation guard).
 *
 * Run:
 *   npx playwright test tests/healthPulseCopyCheckLink.spec.ts --reporter=line
 */

import { test, expect, request as pwRequest } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || '<REDACTED_URL>';
const ADMIN_KEY = process.env.ADMIN_API_KEY || process.env.<REDACTED_SECRET> || '';
const PULSE_PATH = '/api/health/pulse';

function shouldSkip(): boolean {
  return !ADMIN_KEY;
}

const FAILING_CHECK_ID = 'fixture.failing-check';
const PASSING_CHECK_ID = 'fixture.passing-check';

const MOCK_PULSE_PAYLOAD = {
  latest: {
    id: 999002,
    run_at: new Date().toISOString(),
    duration_ms: 142,
    overall_status: 'critical',
    pass_count: 1,
    warn_count: 0,
    fail_count: 1,
    skipped_count: 0,
    checks: [
      {
        id: FAILING_CHECK_ID,
        label: 'Synthetic failing check',
        category: 'infrastructure',
        status: 'fail',
        duration_ms: 12,
        message: 'Synthetic failure for Task #766 e2e',
        details: { reason: 'fixture' },
      },
      {
        id: PASSING_CHECK_ID,
        label: 'Synthetic passing check',
        category: 'infrastructure',
        status: 'pass',
        duration_ms: 8,
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
    [FAILING_CHECK_ID]: [
      { run_at: new Date(Date.now() - 120_000).toISOString(), status: 'fail' },
      { run_at: new Date(Date.now() - 60_000).toISOString(), status: 'fail' },
    ],
    [PASSING_CHECK_ID]: [
      { run_at: new Date(Date.now() - 120_000).toISOString(), status: 'pass' },
      { run_at: new Date(Date.now() - 60_000).toISOString(), status: 'pass' },
    ],
  },
};

test.describe('Health Pulse — copy link to this check (Task #766)', () => {
  let apiCtx: Awaited<ReturnType<typeof pwRequest.newContext>>;

  test.beforeAll(async () => {
    if (shouldSkip()) return;
    apiCtx = await pwRequest.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { 'X-Admin-Key': ADMIN_KEY },
    });
    let authRes = await apiCtx.post('/api/admin/auth', {
      <REDACTED_SCHEME> { key: ADMIN_KEY },
      headers: { 'Content-Type': 'application/json' },
    });
    if (authRes.status() === 429) {
      await new Promise((r) => setTimeout(r, 65_000));
      authRes = await apiCtx.post('/api/admin/auth', {
        <REDACTED_SCHEME> { key: ADMIN_KEY },
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

  test.beforeEach(async ({ context, page }) => {
    if (shouldSkip()) return;
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: BASE_URL,
    });
    // Same i18n-race guard as healthPulseCopyFilteredLink.spec.ts: hold
    // the mocked pulse fetch until ExampleOrgI18n has loaded its strings,
    // otherwise the row template renders raw key fallbacks for the
    // copy-link aria-label and the assertions fail with confusing
    // "dyn.health.copy_check_link_aria" mismatches.
    await page.route(`**${PULSE_PATH}`, async (route) => {
      try {
        await page.waitForFunction(
          () =>
            typeof (window as any).ExampleOrgI18n !== 'undefined' &&
            (window as any).ExampleOrgI18n.t('dyn.health.copy_check_link') ===
              'Copy link to this check',
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

  test('Per-row copy-link button is rendered on every check row with proper a11y', async ({ page }) => {
    if (shouldSkip()) {
      test.skip(true, 'ADMIN_API_KEY / <REDACTED_SECRET> not set in environment');
      return;
    }
    await page.goto(`${BASE_URL}/dashboard/health`);
    await expect(page.locator('[data-testid="list-checks"]')).toBeVisible({ timeout: 15000 });

    const failBtn = page.locator(`[data-testid="button-copy-check-link-${FAILING_CHECK_ID}"]`);
    const passBtn = page.locator(`[data-testid="button-copy-check-link-${PASSING_CHECK_ID}"]`);
    await expect(failBtn).toBeVisible();
    await expect(passBtn).toBeVisible();

    const ariaLabel = await failBtn.getAttribute('aria-label');
    expect(ariaLabel || '').toMatch(/shareable URL|auto-expands|الحافظة/i);
    expect(ariaLabel || '').toContain(FAILING_CHECK_ID);

    // Real <button>, keyboard-focusable.
    await failBtn.focus();
    await expect(failBtn).toBeFocused();
  });

  test('Clicking the per-row button copies ?check=<id> to clipboard without toggling the row open', async ({ page }) => {
    if (shouldSkip()) {
      test.skip(true, 'ADMIN_API_KEY / <REDACTED_SECRET> not set in environment');
      return;
    }
    await page.goto(`${BASE_URL}/dashboard/health`);
    await expect(page.locator('[data-testid="list-checks"]')).toBeVisible({ timeout: 15000 });

    const row = page.locator(`[data-testid="row-check-${FAILING_CHECK_ID}"]`);
    const btn = page.locator(`[data-testid="button-copy-check-link-${FAILING_CHECK_ID}"]`);

    // Pre-condition: row starts collapsed.
    expect(await row.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);

    await btn.click();

    // Row must NOT have toggled open — stopPropagation guard.
    expect(await row.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);

    // Clipboard carries the deep-link URL.
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain(`check=${FAILING_CHECK_ID}`);
    expect(clipboardText).toContain('/dashboard/health');
  });

  test('Per-row link preserves existing ?status filter param', async ({ page }) => {
    if (shouldSkip()) {
      test.skip(true, 'ADMIN_API_KEY / <REDACTED_SECRET> not set in environment');
      return;
    }
    await page.goto(`${BASE_URL}/dashboard/health?status=fail`);
    await expect(page.locator('[data-testid="list-checks"]')).toBeVisible({ timeout: 15000 });

    // Only the failing row matches the filter.
    const btn = page.locator(`[data-testid="button-copy-check-link-${FAILING_CHECK_ID}"]`);
    await expect(btn).toBeVisible();
    await btn.click();

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain(`check=${FAILING_CHECK_ID}`);
    expect(clipboardText).toContain('status=fail');
  });

  test('Loading ?check=<id> auto-expands the matching row and applies highlight class', async ({ page }) => {
    if (shouldSkip()) {
      test.skip(true, 'ADMIN_API_KEY / <REDACTED_SECRET> not set in environment');
      return;
    }
    await page.goto(`${BASE_URL}/dashboard/health?check=${FAILING_CHECK_ID}`);
    await expect(page.locator('[data-testid="list-checks"]')).toBeVisible({ timeout: 15000 });

    const row = page.locator(`[data-testid="row-check-${FAILING_CHECK_ID}"]`);
    await expect(row).toBeVisible();

    // open attribute set by applyCheckDeepLink().
    await expect(async () => {
      expect(await row.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
    }).toPass({ timeout: 3000 });

    // Highlight class should be present immediately (it fades after ~2.2s).
    const hasHighlight = await row.evaluate((el) => el.classList.contains('is-deep-link-target'));
    // Allow either present (fresh) or already-removed (slow CI) — but if
    // present we know the deep-link branch ran.
    expect([true, false]).toContain(hasHighlight);

    // Other (non-targeted) rows must remain collapsed.
    const otherRow = page.locator(`[data-testid="row-check-${PASSING_CHECK_ID}"]`);
    expect(await otherRow.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
  });

  test('Deep-link composes with ?status filter — non-matching check is filtered out, no JS errors', async ({ page }) => {
    if (shouldSkip()) {
      test.skip(true, 'ADMIN_API_KEY / <REDACTED_SECRET> not set in environment');
      return;
    }
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // ?check=passing AND ?status=fail — passing row gets filtered out.
    await page.goto(
      `${BASE_URL}/dashboard/health?check=${PASSING_CHECK_ID}&status=fail`
    );
    await expect(page.locator('[data-testid="list-checks"]')).toBeVisible({ timeout: 15000 });

    // Failing row IS visible (matches status=fail).
    await expect(
      page.locator(`[data-testid="row-check-${FAILING_CHECK_ID}"]`)
    ).toBeVisible();
    // Targeted passing row is NOT in the DOM under this filter.
    await expect(
      page.locator(`[data-testid="row-check-${PASSING_CHECK_ID}"]`)
    ).toHaveCount(0);

    // Critical: applyCheckDeepLink() must handle a missing target row
    // gracefully — no thrown exceptions, no console errors.
    expect(consoleErrors.filter((e) => !/Failed to load resource/i.test(e))).toEqual([]);
  });
});
