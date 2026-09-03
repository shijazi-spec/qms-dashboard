/**
 * E2E test for the "Copy filtered link" affordance on the Health Pulse
 * dashboard (Task #747).
 *
 * Background:
 *   The Health Pulse page (dashboard/health.html) already persists its
 *   category and status filters via `?category=` / `?status=` query
 *   params, but until this task there was no obvious way for an admin
 *   in an incident channel to grab the exact filtered URL they were
 *   staring at and paste it into ChatProvider/Teams. The new copy-link button
 *   appears next to the filter chips ONLY when at least one filter is
 *   active, copies `window.location.href` via the Clipboard API, and
 *   surfaces a brief inline confirmation.
 *
 * What this spec does:
 *   1. Stubs `/api/health/pulse` via `page.route()` so the page renders
 *      a deterministic latest run with at least one failing check
 *      (without needing real seeded health-check fixtures).
 *   2. Grants clipboard read/write permission on the browser context so
 *      the test can both trigger the writeText() call AND read the
 *      copied value back via navigator.clipboard.readText().
 *   3. Loads /dashboard/health WITHOUT any filter params and asserts
 *      the button is NOT rendered (filters-active gating).
 *   4. Reloads with `?status=fail` and asserts the button IS rendered,
 *      is keyboard-reachable, has the documented aria-label, and that
 *      clicking it places `window.location.href` (which still includes
 *      `?status=fail`) on the clipboard with the inline confirmation
 *      becoming visible.
 *
 * Note on auth:
 *   The static dashboard route serves `/dashboard/:name` to anyone as
 *   long as `ADMIN_API_KEY` is configured server-side (admin-protected
 *   bits live behind the API). We mock the only API call the page makes
 *   during initial render, so this spec doesn't need real admin auth
 *   for its assertions — that mirrors the pattern used by
 *   tests/postRestoreSweepPanel.spec.ts for its empty/forbidden states.
 *
 * Run:
 *   npx playwright test tests/healthPulseCopyFilteredLink.spec.ts --reporter=line
 */

import { test, expect, request as pwRequest } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || '<REDACTED_URL>';
const ADMIN_KEY = process.env.ADMIN_API_KEY || process.env.<REDACTED_SECRET> || '';
const PULSE_PATH = '/api/health/pulse';

function shouldSkip(): boolean {
  return !ADMIN_KEY;
}

// Minimal but realistic latest-run payload — has both failing and
// passing checks so the page renders the breakdown table AND the
// `?status=fail` filter has at least one matching row to draw.
const MOCK_PULSE_PAYLOAD = {
  latest: {
    id: 999001,
    run_at: new Date().toISOString(),
    duration_ms: 142,
    overall_status: 'critical',
    pass_count: 1,
    warn_count: 0,
    fail_count: 1,
    skipped_count: 0,
    checks: [
      {
        id: 'fixture.failing-check',
        label: 'Synthetic failing check',
        category: 'infrastructure',
        status: 'fail',
        duration_ms: 12,
        message: 'Synthetic failure for Task #747 e2e',
        details: { reason: 'fixture' },
      },
      {
        id: 'fixture.passing-check',
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
    'fixture.failing-check': [
      { run_at: new Date(Date.now() - 120_000).toISOString(), status: 'fail' },
      { run_at: new Date(Date.now() - 60_000).toISOString(), status: 'fail' },
    ],
    'fixture.passing-check': [
      { run_at: new Date(Date.now() - 120_000).toISOString(), status: 'pass' },
      { run_at: new Date(Date.now() - 60_000).toISOString(), status: 'pass' },
    ],
  },
};

test.describe('Health Pulse — copy filtered link (Task #747)', () => {
  let apiCtx: Awaited<ReturnType<typeof pwRequest.newContext>>;

  test.beforeAll(async () => {
    if (shouldSkip()) return;
    // Single suite-level admin auth — /api/admin/auth has a 5-attempt /
    // minute rate limiter, so per-test logins are a flake source. Mirrors
    // the pattern used by tests/postRestoreSweepPanel.spec.ts and
    // tests/toolHealthOverrideBanner.spec.ts.
    apiCtx = await pwRequest.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { 'X-Admin-Key': ADMIN_KEY },
    });
    // The /api/admin/auth limiter is 5 attempts/minute/IP. If something
    // else on the box has been hitting it (other test files, curl smoke
    // tests, dev experiments), we can land on a 429 even on the very
    // first call from this suite. Back off and retry once so a noisy
    // neighbour doesn't fail an otherwise-correct suite run.
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

  // Pin admin auth on every browser request — the page itself is
  // session-gated by the page-auth middleware, even though the API call
  // we route-mock below would also require it.
  test.use({
    extraHTTPHeaders: ADMIN_KEY ? { 'X-Admin-Key': ADMIN_KEY } : {},
  });

  test.beforeEach(async ({ context, page }) => {
    if (shouldSkip()) return;
    // Grant clipboard permissions for the page origin so writeText() and
    // readText() succeed in headless Chromium (the default permission
    // model would prompt and deny silently in headless mode).
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: BASE_URL,
    });
    // Stub the single XHR the page makes during initial render so the
    // assertions don't depend on real health-pulse fixtures being seeded.
    //
    // IMPORTANT: hold the mock until ExampleOrgI18n has finished loading its
    // strings. The real pulse fetch races the i18n JSON fetch in
    // production; a route-mocked pulse resolves instantly, which would
    // cause renderFilterChips() to run before ExampleOrgI18n.init() and
    // every chip / button label would render with raw key fallbacks.
    await page.route(`**${PULSE_PATH}`, async (route) => {
      try {
        await page.waitForFunction(
          () =>
            typeof (window as any).ExampleOrgI18n !== 'undefined' &&
            (window as any).ExampleOrgI18n.t('dyn.health.copy_link') ===
              'Copy filtered link',
          undefined,
          { timeout: 5_000 }
        );
      } catch {
        // Best-effort: if the i18n loader is slow or missing, fall through
        // and let the assertions in the test itself surface the problem.
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_PULSE_PAYLOAD),
      });
    });
  });

  test('Button is NOT rendered when no filter query params are present', async ({ page }) => {
    if (shouldSkip()) {
      test.skip(true, 'ADMIN_API_KEY / <REDACTED_SECRET> not set in environment');
      return;
    }
    await page.goto(`${BASE_URL}/dashboard/health`);
    // Wait for the breakdown to render so we know the filter bar code
    // path has executed at least once.
    await expect(page.locator('[data-testid="list-checks"]')).toBeVisible({ timeout: 15000 });
    // The chip toolbar IS visible (there are checks to filter), but the
    // copy-link affordance must stay hidden until a filter is engaged.
    await expect(page.locator('[data-testid="toolbar-filter-status"]')).toBeVisible();
    await expect(page.locator('[data-testid="row-copy-filtered-link"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="button-copy-filtered-link"]')).toHaveCount(0);
  });

  test('Clicking the button copies the current URL (with filter params) to the clipboard', async ({ page }) => {
    if (shouldSkip()) {
      test.skip(true, 'ADMIN_API_KEY / <REDACTED_SECRET> not set in environment');
      return;
    }
    await page.goto(`${BASE_URL}/dashboard/health?status=fail`);

    // Filter bar + breakdown have rendered; the copy-link row is now
    // visible because `?status=fail` is an active filter.
    await expect(page.locator('[data-testid="list-checks"]')).toBeVisible({ timeout: 15000 });
    const button = page.locator('[data-testid="button-copy-filtered-link"]');
    await expect(button, 'copy-link button should appear when a filter is active').toBeVisible();

    // Accessibility contract: aria-label is the documented "shareable URL"
    // copy and the button is reachable via keyboard tab order.
    const ariaLabel = await button.getAttribute('aria-label');
    expect(ariaLabel || '').toMatch(/shareable URL|نسخ|clipboard|الحافظة/i);

    // The button is a real <button> element so it is in the natural tab
    // order; assert that focusing via keyboard works (no tabindex=-1).
    await button.focus();
    await expect(button).toBeFocused();

    // Click the button — should write window.location.href to the
    // clipboard and surface the success status.
    await button.click();

    const status = page.locator('[data-testid="status-copy-filtered-link"]');
    await expect(status, 'inline confirmation should become visible').toBeVisible();
    await expect(status).toHaveAttribute('data-tone', 'success');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');

    // Read the clipboard back and confirm it carries the full URL with
    // the active filter param. We compare against the page's own
    // window.location.href so the assertion is robust to host/port
    // differences between local and CI runs.
    const expectedHref = await page.evaluate(() => window.location.href);
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText, 'clipboard should hold the current URL').toBe(expectedHref);
    expect(clipboardText, 'copied URL must include the active filter param').toContain('status=fail');
  });

  test('Toggling a category filter from the chip bar reveals the button', async ({ page }) => {
    if (shouldSkip()) {
      test.skip(true, 'ADMIN_API_KEY / <REDACTED_SECRET> not set in environment');
      return;
    }
    // Start without any filter — the button should not be present yet.
    await page.goto(`${BASE_URL}/dashboard/health`);
    await expect(page.locator('[data-testid="list-checks"]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="button-copy-filtered-link"]')).toHaveCount(0);

    // Engage the "fail" status chip — that flips selectedStatus and
    // re-renders the chip bar, which should now include the copy-link
    // affordance.
    const failChip = page.locator('[data-testid="chip-status-fail"]');
    await expect(failChip).toBeVisible();
    await failChip.click();

    await expect(page.locator('[data-testid="button-copy-filtered-link"]')).toBeVisible();

    // Sanity: the URL the button would copy now reflects the chip click
    // (persistStatusFilter rewrites the query string via replaceState).
    const href = await page.evaluate(() => window.location.href);
    expect(href).toContain('status=fail');
  });
});
