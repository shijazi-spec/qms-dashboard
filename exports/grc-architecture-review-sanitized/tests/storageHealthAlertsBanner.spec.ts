/**
 * E2E test for the storage-health alerts banner on /ai-ops (Task #578).
 *
 * Background:
 *   tests/aiOpsTabs.spec.ts already covers the four other AI Ops tabs but
 *   does not exercise the storage-health banner that renders open
 *   `storage_health` alerts at the very top of the panel. A regression in
 *   `loadStorageHealthAlerts()` or in the supporting
 *   GET /api/ai-ops/storage-health-alerts endpoint would slip past CI.
 *
 * What this spec does:
 *   1. Authenticates as admin via the warmup helper (which also triggers
 *      the lazy CREATE TABLE IF NOT EXISTS for the AI Ops surface).
 *   2. Seeds one open `storage_health` alert through the same
 *      `createAIAlert` helper the daily prune cron uses, so the banner
 *      sees a real database row rather than a fixture.
 *   3. Loads /ai-ops, waits for /api/ai-ops/storage-health-alerts, then
 *      asserts:
 *        - the banner section is visible (no longer `hidden`)
 *        - the count badge reflects ≥ 1 (we don't pin to exactly 1
 *          because a real prune-cron alert may legitimately be open in
 *          the dev DB at the same time)
 *        - the seeded card renders with the title we wrote
 *        - the card exposes acknowledge / resolve / dismiss buttons —
 *          the three triage actions Task #578 wired up
 *   4. Cleans up by resolving the seeded alert on teardown.
 *
 * Requirements (mirrors tests/aiOpsTabs.spec.ts):
 *   - Dev server at BASE_URL (default <REDACTED_URL>
 *   - ADMIN_API_KEY / TEST_ADMIN_KEY set so admin auth works
 *   - DATABASE_URL pointing at the same Postgres the server uses
 *
 * Run:
 *   npx playwright test tests/storageHealthAlertsBanner.spec.ts --reporter=line
 */

import { test, expect } from '@playwright/test';
import { warmupAiOpsTables } from './helpers/warmupAiOpsTables';

const BASE_URL = process.env.BASE_URL || '<REDACTED_URL>';
const ADMIN_KEY = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ALERT_TITLE = `E2E storage-health banner seed ${RUN_ID}`;
const ALERT_DESCRIPTION = `Seeded by tests/storageHealthAlertsBanner.spec.ts at ${RUN_ID}`;

let seededAlertId: number | null = null;

test.describe('AI Ops — storage-health alerts banner', () => {
  test.beforeAll(async () => {
    if (!ADMIN_KEY || !DATABASE_URL) return;

    // Warm up the AI Ops tables (login + lazy CREATE TABLE IF NOT EXISTS)
    // before we INSERT directly. This keeps the spec compatible with a
    // cold dev DB the same way tests/aiOpsTabs.spec.ts does.
    await warmupAiOpsTables(ADMIN_KEY, BASE_URL);

    // Use the same helper the daily prune cron uses so we exercise the
    // production code path. Imported inline to keep the module-load cost
    // (sharedPool bootstrap) out of the test scaffolding when the env
    // gates above cause us to skip.
    const { createAIAlert, initAIAlertsTable } = await import(
      '../src/utils/aiAlertsDatabase'
    );
    const { STORAGE_HEALTH_DEDUPE_KEY } = await import(
      '../src/utils/storageHealthAlerts'
    );
    // ai_alerts is created lazily on first use; force the schema before
    // the INSERT so a cold DB doesn't blow up here.
    await initAIAlertsTable();
    const created = await createAIAlert({
      alert_type: 'storage_health',
      severity: 'high',
      title: ALERT_TITLE,
      description: ALERT_DESCRIPTION,
      suggestion: 'E2E test — safe to dismiss.',
      related_module: 'ai_ops',
      related_record_id: STORAGE_HEALTH_DEDUPE_KEY,
    });
    seededAlertId = created.id ?? null;
    if (seededAlertId == null) {
      throw new Error('Failed to seed storage_health alert for banner spec');
    }
  });

  test.afterAll(async () => {
    if (seededAlertId == null) return;
    try {
      const { resolveAlert } = await import('../src/utils/aiAlertsDatabase');
      // Use resolve so it's removed from the open-banner listing for
      // future suite runs. The status guard added in Task #578 makes
      // this safe even if the test itself already resolved/dismissed it.
      await resolveAlert(
        seededAlertId,
        'storage-health banner spec cleanup',
        'storage-health-banner-spec',
      );
    } catch {
      /* best-effort */
    }
  });

  test.use({
    extraHTTPHeaders: ADMIN_KEY ? { 'X-Admin-Key': ADMIN_KEY } : {},
  });

  test('banner renders the seeded open alert with acknowledge / resolve / dismiss buttons', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }
    if (!DATABASE_URL) {
      test.skip(true, 'DATABASE_URL not set in environment');
      return;
    }
    expect(seededAlertId, 'beforeAll should have seeded an alert id').not.toBeNull();

    // Capture the storage-health-alerts response BEFORE goto so the
    // initial DOMContentLoaded fetch doesn't race the wait setup.
    const storageResPromise = page.waitForResponse(
      (r) =>
        r.url().includes('/api/ai-ops/storage-health-alerts') &&
        !r.url().includes('/history') &&
        r.request().method() === 'GET',
      { timeout: 15000 },
    );

    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');

    const storageRes = await storageResPromise;
    expect(storageRes.status(), 'storage-health-alerts API should succeed').toBe(200);
    const payload = await storageRes.json();
    const rows: Array<{ id: number; title: string }> = payload?.data ?? [];
    const seededRow = rows.find((r) => r.id === seededAlertId);
    expect(seededRow, 'API payload should include the seeded alert').toBeTruthy();
    expect(seededRow!.title).toBe(ALERT_TITLE);

    // Banner section starts hidden when there are no open storage-health
    // alerts; once the seed renders it must drop the `hidden` class.
    const banner = page.locator('[data-testid="section-storage-health-alerts"]');
    await expect(banner, 'banner section should be visible').toBeVisible({ timeout: 10000 });

    // Count badge reflects the API row count. Use ≥ 1 because a real
    // prune-cron alert in the dev DB may push the count higher.
    const countBadge = page.locator('[data-testid="badge-storage-health-alerts-count"]');
    await expect(countBadge).toBeVisible();
    const countText = (await countBadge.textContent())?.trim() ?? '';
    const renderedCount = parseInt(countText, 10);
    expect(Number.isFinite(renderedCount), `count badge should be numeric — got "${countText}"`).toBe(true);
    expect(renderedCount).toBeGreaterThanOrEqual(rows.length);

    // The seeded card is keyed by alert id — assert it rendered with the
    // expected title and exposes all three triage buttons.
    const card = page.locator(`[data-testid="card-storage-health-alert-${seededAlertId}"]`);
    await expect(card, 'seeded alert card should render in the banner').toBeVisible();
    await expect(
      card.locator(`[data-testid="text-storage-alert-title-${seededAlertId}"]`),
    ).toHaveText(ALERT_TITLE);

    await expect(
      card.locator(`[data-testid="button-acknowledge-storage-alert-${seededAlertId}"]`),
      'card exposes Acknowledge button',
    ).toBeVisible();
    await expect(
      card.locator(`[data-testid="button-resolve-storage-alert-${seededAlertId}"]`),
      'card exposes Resolve button',
    ).toBeVisible();
    await expect(
      card.locator(`[data-testid="button-dismiss-storage-alert-${seededAlertId}"]`),
      'card exposes Dismiss button',
    ).toBeVisible();
  });
});
