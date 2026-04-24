/**
 * E2E tests for the "auto-revert in N hours" banner on the AI Ops Tool
 * Health dashboard (Task #212).
 *
 * Background:
 *   The Alert Thresholds tab can schedule a time-boxed override (Task #191)
 *   that silently reverts the override to the env baseline when its
 *   `expires_at` elapses. Until this task, the only place that schedule
 *   surfaced was a small line of helper text inside the Alert Thresholds
 *   editor — operators landing on the main Tool Health view had no cue
 *   that current alert noise was being suppressed by an expiring override.
 *
 *   The banner added in dashboard/ai-ops.html addresses that gap:
 *     • Visible at the top of the page whenever
 *       /api/ai-ops/tool-health-config returns an `expires_at` in the
 *       future and the operator hasn't dismissed *that specific* expiry.
 *     • Color flips amber when <30 min remain so the impending revert is
 *       hard to miss while triaging an incident.
 *     • Clicking the body deep-links to the Alert Thresholds tab so the
 *       operator can extend or clear the schedule in one click.
 *
 * What this spec does:
 *   1. Authenticates as admin via /api/admin/auth + pinned X-Admin-Key
 *      (same pattern as tests/aiOpsTabs.spec.ts) so the dashboard page
 *      load AND its AJAX calls are authorized.
 *   2. For each scenario, PUTs /api/ai-ops/tool-health-config to seed the
 *      desired `expires_at` (and a single override so the row materially
 *      exists), then loads /ai-ops and asserts the banner state.
 *   3. Cleans up the override + expires_at on teardown so subsequent runs
 *      (and ambient dev usage) start from a known state.
 *
 * Scenarios covered:
 *   A. Neutral banner — expires_at ~2h away, blue color classes present,
 *      countdown text matches /(in \d+h(?:\s\d+m)?)/, absolute UTC string
 *      ends in "UTC".
 *   B. Deep-link click — clicking the banner switches to the
 *      "Alert Thresholds" tab (tab-thresholds gets `tab-active`).
 *   C. Dismiss persists per-expiry — clicking dismiss hides the banner;
 *      after a full reload it stays hidden because localStorage records
 *      the dismissed `expires_at`.
 *   D. Re-scheduling re-shows — PUTting a *different* expires_at causes
 *      the banner to reappear after reload (dismissal was keyed to the
 *      previous timestamp).
 *   E. Amber color — expires_at ~10 min away surfaces amber color
 *      classes and a minute-only countdown.
 *
 * Requirements:
 *   - Dev server must be running at BASE_URL (default http://localhost:5000).
 *   - ADMIN_API_KEY (or TEST_ADMIN_KEY) must be set; otherwise skipped.
 *
 * Run:
 *   npx playwright test tests/toolHealthOverrideBanner.spec.ts --reporter=line
 */

import { test, expect, request as pwRequest } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const ADMIN_KEY = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY || '';

const TOOL_HEALTH_CONFIG_PATH = '/api/ai-ops/tool-health-config';

// Picked from the canonical THRESHOLD_FIELDS list — `errorRateCriticalPct`
// is the top-of-band cutoff (0..100). The PUT route enforces
// errorRateHighPct < errorRateCriticalPct, so we pick a value comfortably
// above the env baseline default for "high" (50) and well within bounds.
// The teardown step (afterAll) restores it to null to keep subsequent
// runs and ambient dev usage unaffected.
const SEEDED_OVERRIDE_FIELD = 'errorRateCriticalPct';
const SEEDED_OVERRIDE_VALUE = 95;

async function putConfig(
  apiCtx: Awaited<ReturnType<typeof pwRequest.newContext>>,
  body: Record<string, unknown>,
) {
  const res = await apiCtx.put(TOOL_HEALTH_CONFIG_PATH, {
    data: body,
    headers: { 'Content-Type': 'application/json' },
  });
  expect(
    res.status(),
    `PUT ${TOOL_HEALTH_CONFIG_PATH} should succeed (body=${JSON.stringify(body)})`,
  ).toBe(200);
  return res.json();
}

function isoOffsetFromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

test.describe('AI Ops — tool-health override auto-revert banner (Task #212)', () => {
  let apiCtx: Awaited<ReturnType<typeof pwRequest.newContext>>;

  test.beforeAll(async () => {
    if (!ADMIN_KEY) return;
    apiCtx = await pwRequest.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { 'X-Admin-Key': ADMIN_KEY },
    });
    // Single suite-level login; per-test logins would trip the
    // /api/admin/auth rate limiter (5 attempts / minute).
    const authRes = await apiCtx.post('/api/admin/auth', {
      data: { key: ADMIN_KEY },
      headers: { 'Content-Type': 'application/json' },
    });
    if (authRes.status() !== 200) {
      throw new Error(`/api/admin/auth login returned HTTP ${authRes.status()}`);
    }
  });

  test.afterAll(async () => {
    if (!apiCtx) return;
    try {
      // Wipe the override + any scheduled expiry so subsequent runs and
      // ambient dev usage don't inherit our seed values.
      await apiCtx.put(TOOL_HEALTH_CONFIG_PATH, {
        data: {
          overrides: { [SEEDED_OVERRIDE_FIELD]: null },
          expires_at: null,
          note: 'tests/toolHealthOverrideBanner.spec.ts teardown',
        },
        headers: { 'Content-Type': 'application/json' },
      });
    } finally {
      await apiCtx.dispose();
    }
  });

  // Pin admin auth on every page request so the page load AND its AJAX
  // calls (including GET /api/ai-ops/tool-health-config) are admin-authorized.
  test.use({
    extraHTTPHeaders: ADMIN_KEY ? { 'X-Admin-Key': ADMIN_KEY } : {},
  });

  test('Neutral banner shows countdown + UTC absolute when expires_at is hours away', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }

    await putConfig(apiCtx, {
      overrides: { [SEEDED_OVERRIDE_FIELD]: SEEDED_OVERRIDE_VALUE },
      expires_at: isoOffsetFromNow(2 * 60 * 60 * 1000), // 2h out
      note: 'Task #212 e2e — neutral',
    });

    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');

    const section = page.locator('[data-testid="section-tool-health-override-banner"]');
    await expect(section, 'banner section should be visible').toBeVisible();

    const banner = page.locator('[data-testid="banner-tool-health-override-expiry"]');
    const cls = (await banner.getAttribute('class')) || '';
    expect(cls, 'neutral banner uses blue color classes').toContain('bg-blue-50');
    expect(cls, 'neutral banner uses blue border').toContain('border-blue-200');
    expect(cls, 'neutral banner does NOT use amber color').not.toContain('bg-amber-50');

    const absolute = await page.locator('[data-testid="text-tool-health-override-expiry-absolute"]').textContent();
    expect(absolute || '', 'absolute text should include UTC').toMatch(/UTC/);

    const countdown = await page.locator('[data-testid="text-tool-health-override-expiry-countdown"]').textContent();
    expect(countdown || '', 'countdown shows hours-and-minutes for a 2h schedule').toMatch(/\(in \d+h( \d+m)?\)/);

    await expect(page.locator('[data-testid="button-tool-health-override-banner-deeplink"]')).toBeVisible();
    await expect(page.locator('[data-testid="button-tool-health-override-banner-dismiss"]')).toBeVisible();
  });

  test('Banner deep-links to the Alert Thresholds tab', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }

    await putConfig(apiCtx, {
      overrides: { [SEEDED_OVERRIDE_FIELD]: SEEDED_OVERRIDE_VALUE },
      expires_at: isoOffsetFromNow(3 * 60 * 60 * 1000), // 3h out
      note: 'Task #212 e2e — deep-link',
    });

    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('[data-testid="banner-tool-health-override-expiry"]')).toBeVisible();
    // The Alert Thresholds tab should NOT be active before the click.
    const thresholdsTab = page.locator('[data-testid="tab-thresholds"]');
    expect((await thresholdsTab.getAttribute('class')) || '').not.toContain('tab-active');

    await page.locator('[data-testid="button-tool-health-override-banner-deeplink"]').click();

    // After click, the Alert Thresholds tab is active and its content is
    // visible (the expires-in select is unique to that tab).
    await expect(thresholdsTab).toHaveClass(/tab-active/);
    await expect(page.locator('[data-testid="select-threshold-expires-in"]')).toBeVisible();
    // The deep-link must NOT also dismiss the banner — operators rely on
    // it staying put so they can come back to the main view later.
    await expect(page.locator('[data-testid="banner-tool-health-override-expiry"]')).toBeVisible();
  });

  test('Dismiss hides the banner and persists per-expiry across reloads; new expiry re-shows', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }

    // First scheduled expiry — banner appears, gets dismissed.
    await putConfig(apiCtx, {
      overrides: { [SEEDED_OVERRIDE_FIELD]: SEEDED_OVERRIDE_VALUE },
      expires_at: isoOffsetFromNow(4 * 60 * 60 * 1000), // 4h out
      note: 'Task #212 e2e — dismiss',
    });

    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-testid="banner-tool-health-override-expiry"]')).toBeVisible();

    await page.locator('[data-testid="button-tool-health-override-banner-dismiss"]').click();
    await expect(page.locator('[data-testid="section-tool-health-override-banner"]'))
      .toHaveClass(/hidden/);

    // Reload — same expires_at value still applies, so localStorage keeps
    // the banner suppressed.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    // Wait briefly for the GET /tool-health-config call to settle so we
    // don't flake on a not-yet-rendered banner.
    await page.waitForResponse(
      r => r.url().includes('/api/ai-ops/tool-health-config') && r.request().method() === 'GET',
      { timeout: 15000 },
    );
    await expect(page.locator('[data-testid="section-tool-health-override-banner"]'))
      .toHaveClass(/hidden/);

    // Reschedule with a *different* expires_at — banner should reappear
    // because the dismissal is keyed to the previous timestamp.
    await putConfig(apiCtx, {
      overrides: { [SEEDED_OVERRIDE_FIELD]: SEEDED_OVERRIDE_VALUE },
      expires_at: isoOffsetFromNow(5 * 60 * 60 * 1000), // 5h out
      note: 'Task #212 e2e — re-scheduled',
    });

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-testid="section-tool-health-override-banner"]')).toBeVisible();
    await expect(page.locator('[data-testid="banner-tool-health-override-expiry"]')).toBeVisible();
  });

  test('Banner turns amber when <30 minutes remain', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }

    await putConfig(apiCtx, {
      overrides: { [SEEDED_OVERRIDE_FIELD]: SEEDED_OVERRIDE_VALUE },
      expires_at: isoOffsetFromNow(10 * 60 * 1000), // 10 min out
      note: 'Task #212 e2e — amber',
    });

    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');

    const banner = page.locator('[data-testid="banner-tool-health-override-expiry"]');
    await expect(banner).toBeVisible();

    const cls = (await banner.getAttribute('class')) || '';
    expect(cls, 'amber banner uses amber background class').toContain('bg-amber-50');
    expect(cls, 'amber banner uses amber border class').toContain('border-amber-300');
    expect(cls, 'amber banner does NOT keep blue color').not.toContain('bg-blue-50');

    const countdown = await page.locator('[data-testid="text-tool-health-override-expiry-countdown"]').textContent();
    expect(countdown || '', 'countdown is minute-only when <1h remains').toMatch(/\(in \d{1,2}m\)/);
  });
});
