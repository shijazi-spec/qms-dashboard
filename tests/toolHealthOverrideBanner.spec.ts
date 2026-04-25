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

  // Task #333: the legacy single "Snooze 1h" button was replaced by a small
  // popover offering 30m / 1h / 4h. The behaviour is parameterised — each
  // duration must hide the banner for the chosen window, persist a
  // snoozedUntilMs ≈ that window from now, and (when rewound to the past)
  // re-show the banner and prune the stale localStorage record. We keep
  // the heavier reschedule/elapse follow-up on the 1h iteration so the
  // suite total runtime stays bounded but every duration still gets the
  // core hide + persist + reload assertions.
  const SNOOZE_DURATIONS = [
    {
      label: '30 min',
      menuItemTestid: 'button-tool-health-override-banner-snooze-30m',
      minutes: 30,
    },
    {
      label: '1 hour',
      menuItemTestid: 'button-tool-health-override-banner-snooze-1h',
      minutes: 60,
    },
    {
      label: '4 hours',
      menuItemTestid: 'button-tool-health-override-banner-snooze-4h',
      minutes: 240,
    },
  ];

  for (const { label, menuItemTestid, minutes } of SNOOZE_DURATIONS) {
    test(`Snooze popover: "${label}" hides banner, persists ~${minutes} min, and re-shows after elapse`, async ({ page }) => {
      if (!ADMIN_KEY) {
        test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
        return;
      }

      // Long-lived schedule (8h) so even the 4h cap leaves headroom for the
      // optional reschedule follow-up below and so no duration is trimmed
      // by the "remaining override lifetime" cap.
      await putConfig(apiCtx, {
        overrides: { [SEEDED_OVERRIDE_FIELD]: SEEDED_OVERRIDE_VALUE },
        expires_at: isoOffsetFromNow(8 * 60 * 60 * 1000),
        note: `Task #333 e2e — snooze ${label}`,
      });

      await page.goto(`${BASE_URL}/ai-ops`);
      await page.waitForLoadState('domcontentloaded');
      await expect(page.locator('[data-testid="banner-tool-health-override-expiry"]')).toBeVisible();

      // The trigger button toggles the popover; the popover should start hidden.
      const trigger = page.locator('[data-testid="button-tool-health-override-banner-snooze"]');
      const menu = page.locator('[data-testid="menu-tool-health-override-banner-snooze"]');
      await expect(trigger, 'snooze trigger has aria-haspopup="menu"').toHaveAttribute('aria-haspopup', 'menu');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(menu).toHaveClass(/hidden/);

      await trigger.click();
      await expect(menu, 'menu opens after trigger click').not.toHaveClass(/hidden/);
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');

      // All three options should be present so a missing item fails fast
      // rather than silently selecting the wrong duration.
      await expect(page.locator('[data-testid="button-tool-health-override-banner-snooze-30m"]')).toBeVisible();
      await expect(page.locator('[data-testid="button-tool-health-override-banner-snooze-1h"]')).toBeVisible();
      await expect(page.locator('[data-testid="button-tool-health-override-banner-snooze-4h"]')).toBeVisible();

      // Pick the duration under test → banner hides, popover closes, and the
      // snooze record is written to localStorage keyed to the current expires_at.
      await page.locator(`[data-testid="${menuItemTestid}"]`).click();
      await expect(page.locator('[data-testid="section-tool-health-override-banner"]'))
        .toHaveClass(/hidden/);
      await expect(menu, 'menu closes after picking a duration').toHaveClass(/hidden/);
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');

      const snoozedRaw = await page.evaluate(
        () => localStorage.getItem('wp.toolHealthOverrideBanner.snoozedUntilFor'),
      );
      expect(snoozedRaw, 'snooze record should be persisted to localStorage').toBeTruthy();
      const snoozedParsed = JSON.parse(snoozedRaw as string);
      expect(typeof snoozedParsed.expiresAtMs, 'snooze record carries expires_at ms').toBe('number');
      expect(typeof snoozedParsed.snoozedUntilMs, 'snooze record carries snoozed-until ms').toBe('number');
      // Allow a small fudge on either side: the request → DOM click → eval
      // round-trip can shave a few seconds, so we accept anything inside
      // (minutes - 5, minutes + 1) of the requested window.
      const remainingMs = snoozedParsed.snoozedUntilMs - Date.now();
      expect(remainingMs, `snooze should last ~${minutes} min (lower bound)`)
        .toBeGreaterThan((minutes - 5) * 60 * 1000);
      expect(remainingMs, `snooze should last ~${minutes} min (upper bound)`)
        .toBeLessThan((minutes + 1) * 60 * 1000);

      // Reload — same expires_at, snooze still in window → banner stays hidden.
      await page.reload();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForResponse(
        r => r.url().includes('/api/ai-ops/tool-health-config') && r.request().method() === 'GET',
        { timeout: 15000 },
      );
      await expect(page.locator('[data-testid="section-tool-health-override-banner"]'))
        .toHaveClass(/hidden/);

      // Simulate the chosen window elapsing by rewinding snoozedUntilMs into
      // the past (deterministic and instant; we don't want to wait 4h in CI).
      await page.evaluate(() => {
        const raw = localStorage.getItem('wp.toolHealthOverrideBanner.snoozedUntilFor');
        if (!raw) return;
        const parsed = JSON.parse(raw);
        parsed.snoozedUntilMs = Date.now() - 1000;
        localStorage.setItem('wp.toolHealthOverrideBanner.snoozedUntilFor', JSON.stringify(parsed));
      });
      await page.reload();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForResponse(
        r => r.url().includes('/api/ai-ops/tool-health-config') && r.request().method() === 'GET',
        { timeout: 15000 },
      );
      // Snooze elapsed → banner is back so the impending revert remains visible.
      await expect(page.locator('[data-testid="banner-tool-health-override-expiry"]')).toBeVisible();
      // The stale snooze record should also have been pruned to avoid quietly
      // suppressing some future window if its expires_at happens to match.
      const afterElapseRaw = await page.evaluate(
        () => localStorage.getItem('wp.toolHealthOverrideBanner.snoozedUntilFor'),
      );
      expect(afterElapseRaw, 'stale snooze record should be cleared').toBeNull();
    });
  }

  test('Snooze popover survives reschedule: rescheduling a new expires_at re-shows the banner', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }

    // Long-lived schedule first — pick a 1h snooze, then reschedule expires_at.
    await putConfig(apiCtx, {
      overrides: { [SEEDED_OVERRIDE_FIELD]: SEEDED_OVERRIDE_VALUE },
      expires_at: isoOffsetFromNow(8 * 60 * 60 * 1000),
      note: 'Task #333 e2e — snooze + reschedule',
    });

    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-testid="banner-tool-health-override-expiry"]')).toBeVisible();

    await page.locator('[data-testid="button-tool-health-override-banner-snooze"]').click();
    await page.locator('[data-testid="button-tool-health-override-banner-snooze-1h"]').click();
    await expect(page.locator('[data-testid="section-tool-health-override-banner"]'))
      .toHaveClass(/hidden/);

    // Reschedule expires_at — the snooze record is keyed to the previous
    // expires_at, so the new schedule must be treated as a fresh nudge and
    // the banner reappears (matching dismiss semantics).
    await putConfig(apiCtx, {
      overrides: { [SEEDED_OVERRIDE_FIELD]: SEEDED_OVERRIDE_VALUE },
      expires_at: isoOffsetFromNow(7 * 60 * 60 * 1000),
      note: 'Task #333 e2e — snooze + reschedule (new expiry)',
    });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-testid="banner-tool-health-override-expiry"]')).toBeVisible();
  });

  test('Cross-tab sync: dismiss, snooze, and fresh expires_at propagate to sibling tabs (Task #332)', async ({ browser }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }

    // Seed an override scheduled 6h out so the banner shows in both tabs
    // and the snooze cap (60 min) never trims the assertion windows below.
    await putConfig(apiCtx, {
      overrides: { [SEEDED_OVERRIDE_FIELD]: SEEDED_OVERRIDE_VALUE },
      expires_at: isoOffsetFromNow(6 * 60 * 60 * 1000),
      note: 'Task #332 e2e — cross-tab seed',
    });

    // Two browser contexts simulate two separate browser windows the same
    // operator has open (the realistic "dashboard in tab A, thresholds in
    // tab B" scenario the task is targeting). Same-context pages would
    // share localStorage but storage events DON'T fire in the writing tab,
    // so we'd only ever observe one direction. Distinct contexts also
    // mean we have to re-pin admin auth on each.
    const ctxA = await browser.newContext({
      extraHTTPHeaders: { 'X-Admin-Key': ADMIN_KEY },
    });
    const ctxB = await browser.newContext({
      extraHTTPHeaders: { 'X-Admin-Key': ADMIN_KEY },
    });

    try {
      const tabA = await ctxA.newPage();
      const tabB = await ctxB.newPage();

      await tabA.goto(`${BASE_URL}/ai-ops`);
      await tabB.goto(`${BASE_URL}/ai-ops`);
      await tabA.waitForLoadState('domcontentloaded');
      await tabB.waitForLoadState('domcontentloaded');

      // Both tabs see the seeded banner before any cross-tab traffic.
      await expect(tabA.locator('[data-testid="banner-tool-health-override-expiry"]')).toBeVisible();
      await expect(tabB.locator('[data-testid="banner-tool-health-override-expiry"]')).toBeVisible();

      // ---- Direction 0: Dismiss in tab A → tab B hides without reload ----
      // Same code path as snooze, but the dismiss key is a different
      // localStorage entry so we exercise it explicitly.
      await tabA.locator('[data-testid="button-tool-health-override-banner-dismiss"]').click();
      await expect(tabA.locator('[data-testid="section-tool-health-override-banner"]'))
        .toHaveClass(/hidden/);
      const dismissRecord = await tabA.evaluate(
        () => localStorage.getItem('wp.toolHealthOverrideBanner.dismissedFor'),
      );
      expect(dismissRecord, 'tab A should have persisted a dismiss record').toBeTruthy();

      await tabB.evaluate((raw) => {
        const KEY = 'wp.toolHealthOverrideBanner.dismissedFor';
        const oldValue = localStorage.getItem(KEY);
        localStorage.setItem(KEY, raw as string);
        window.dispatchEvent(new StorageEvent('storage', {
          key: KEY,
          oldValue,
          newValue: raw as string,
          storageArea: localStorage,
          url: location.href,
        }));
      }, dismissRecord);

      await expect(
        tabB.locator('[data-testid="section-tool-health-override-banner"]'),
        'tab B should auto-hide after sibling tab dismissed',
      ).toHaveClass(/hidden/, { timeout: 10000 });

      // Re-seed a fresh expires_at so the snooze step below has a
      // not-yet-dismissed window to act on (dismiss is sticky per-expiry).
      await putConfig(apiCtx, {
        overrides: { [SEEDED_OVERRIDE_FIELD]: SEEDED_OVERRIDE_VALUE },
        expires_at: isoOffsetFromNow(6 * 60 * 60 * 1000 + 30 * 60 * 1000),
        note: 'Task #332 e2e — cross-tab reseed for snooze',
      });
      // Bump configRevision so both tabs refetch and the banner reappears.
      const reseedStamp = String(Date.now());
      for (const tab of [tabA, tabB]) {
        await tab.evaluate((stamp) => {
          const KEY = 'wp.toolHealthOverrideBanner.configRevision';
          const oldValue = localStorage.getItem(KEY);
          localStorage.setItem(KEY, stamp);
          window.dispatchEvent(new StorageEvent('storage', {
            key: KEY,
            oldValue,
            newValue: stamp,
            storageArea: localStorage,
            url: location.href,
          }));
        }, reseedStamp);
      }
      await expect(tabA.locator('[data-testid="banner-tool-health-override-expiry"]')).toBeVisible({ timeout: 10000 });
      await expect(tabB.locator('[data-testid="banner-tool-health-override-expiry"]')).toBeVisible({ timeout: 10000 });

      // ---- Direction 1: Snooze in tab A → tab B hides without reload ----
      // Two separate contexts have independent localStorage, so the
      // browser won't fan the storage event across them on its own. We
      // mirror the snooze write into tab B's localStorage and dispatch a
      // synthetic StorageEvent — that's exactly what the same-origin
      // browser would do natively in a single profile, and it's the
      // contract our handler is coded against.
      // The snooze control is a split-button popover (Task #333): the
      // trigger opens the menu, the menu items pick a duration. We use
      // the 1h option here to preserve the original cross-tab assertion
      // window (~60 min) while still exercising the new code path.
      await tabA.locator('[data-testid="button-tool-health-override-banner-snooze"]').click();
      await tabA.locator('[data-testid="button-tool-health-override-banner-snooze-1h"]').click();
      await expect(tabA.locator('[data-testid="section-tool-health-override-banner"]'))
        .toHaveClass(/hidden/);
      const snoozeRecord = await tabA.evaluate(
        () => localStorage.getItem('wp.toolHealthOverrideBanner.snoozedUntilFor'),
      );
      expect(snoozeRecord, 'tab A should have persisted a snooze record').toBeTruthy();

      await tabB.evaluate((raw) => {
        const KEY = 'wp.toolHealthOverrideBanner.snoozedUntilFor';
        const oldValue = localStorage.getItem(KEY);
        localStorage.setItem(KEY, raw as string);
        window.dispatchEvent(new StorageEvent('storage', {
          key: KEY,
          oldValue,
          newValue: raw as string,
          storageArea: localStorage,
          url: location.href,
        }));
      }, snoozeRecord);

      // Tab B's storage handler should refetch the config and hide the
      // banner because the snooze key now matches the live expires_at.
      await expect(
        tabB.locator('[data-testid="section-tool-health-override-banner"]'),
        'tab B should auto-hide after sibling tab snoozed',
      ).toHaveClass(/hidden/, { timeout: 10000 });

      // ---- Direction 2: Reschedule in tab A's Thresholds tab → tab B re-shows ----
      // saveThresholds() bumps wp.toolHealthOverrideBanner.configRevision
      // after a successful PUT. We do the PUT directly here so the test
      // doesn't depend on the threshold form's full UI flow, then mirror
      // the configRevision bump into tab B (same cross-context caveat as
      // above) and confirm the banner reappears with the new expires_at.
      await putConfig(apiCtx, {
        overrides: { [SEEDED_OVERRIDE_FIELD]: SEEDED_OVERRIDE_VALUE },
        expires_at: isoOffsetFromNow(5 * 60 * 60 * 1000), // different value
        note: 'Task #332 e2e — cross-tab reschedule',
      });

      const revStamp = String(Date.now());
      await tabB.evaluate((stamp) => {
        const KEY = 'wp.toolHealthOverrideBanner.configRevision';
        const oldValue = localStorage.getItem(KEY);
        localStorage.setItem(KEY, stamp);
        window.dispatchEvent(new StorageEvent('storage', {
          key: KEY,
          oldValue,
          newValue: stamp,
          storageArea: localStorage,
          url: location.href,
        }));
      }, revStamp);

      // The new expires_at doesn't match the stored snooze key, so the
      // banner should come back into view in tab B.
      await expect(
        tabB.locator('[data-testid="banner-tool-health-override-expiry"]'),
        'tab B should re-show after sibling tab rescheduled expires_at',
      ).toBeVisible({ timeout: 10000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
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
