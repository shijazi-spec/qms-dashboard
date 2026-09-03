/**
 * E2E test for the inline save-confirmation panel on the AI metrics
 * retention form (Task #561, validated by Task #587).
 *
 * Background:
 *   Task #561 replaced the browser-native `confirm()` that previously
 *   gated tightening saves on /ai-ops with two new pieces of UX:
 *
 *     1. A debounced (~400ms) live preview of "next prune will delete
 *        ~N rows spanning ~D days of telemetry" that updates as the
 *        operator types — no need to click "Preview impact" first.
 *
 *     2. An inline `panel-metrics-retention-confirm` "are you sure?"
 *        panel that appears when "Save retention" is clicked AND the
 *        candidate is tighter than the current effective window AND the
 *        impact crosses the configurable confirm threshold. The Save
 *        button no longer fires the PUT directly — it only reveals the
 *        panel; the confirm/cancel buttons inside the panel decide what
 *        actually happens.
 *
 *   The backend logic for `getAiMetricsRetentionConfirmThreshold()` and
 *   `previewAiMetricsPruneImpact()` is unit-covered in
 *   `tests/aiMetricsRetentionConfig.test.ts` and the existing happy-path
 *   spec `tests/aiMetricsRetentionDashboard.spec.ts` covers the
 *   straight-through Save flow. Neither exercises the *new* in-browser
 *   gating: a regression that re-introduced the immediate-PUT path or
 *   silently broke the live-preview wiring would slip past CI today.
 *
 * What this spec does:
 *   1. Authenticates as admin (POST /api/admin/auth) and pins
 *      X-Admin-Key on every browser request — same pattern as
 *      tests/aiMetricsRetentionDashboard.spec.ts.
 *   2. Snapshots the existing override before any test runs and restores
 *      it on teardown so this spec leaves no permanent state.
 *   3. Stubs ONLY the preview endpoint via `page.route()` so the live
 *      preview deterministically reports a non-zero, multi-day impact
 *      (no dependency on the contents of `ai_call_metrics` in dev).
 *      The GET / PUT retention endpoints are NOT stubbed — those flow
 *      to the real server so we exercise the full save round-trip.
 *   4. Tightening case: types a value smaller than the current
 *      effective window, asserts the live preview text updates within
 *      ~1.5s and contains BOTH "rows" and "days of telemetry", clicks
 *      Save, asserts the confirm panel appears AND no PUT fires,
 *      clicks Cancel, asserts the panel hides AND no PUT fires, opens
 *      it again and clicks Confirm & save, asserts a single PUT and
 *      the success status text.
 *   5. Widening case: types a value >= the current effective window
 *      and asserts Save fires the PUT immediately with no confirm
 *      panel — the gating must NOT trigger when nothing extra would
 *      be deleted.
 */

import { test, expect, request as pwRequest } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || '<REDACTED_URL>';
const ADMIN_KEY = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY || '';

const RETENTION_PATH = '/api/ai-ops/metrics-retention';
const PREVIEW_PATH = '/api/ai-ops/metrics-retention/preview';

// Per-run identifier so any audit row this spec writes can be located
// unambiguously and is easy to grep for after the fact.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Pick a baseline window the test fully controls so both the tightening
// and widening cases have a known reference point regardless of whatever
// override the dev box was sitting at when the spec started. 60 is well
// inside AI_METRICS_RETENTION_BOUNDS (1..3650) and different enough from
// the compile-time default (90) that an accidental fallback would be
// obvious in failure output.
const BASELINE_RETENTION_DAYS = 60;
// Tighter than baseline → triggers the confirm panel (with the stubbed
// preview reporting 12,345 rows / 14 days, both arms of the default
// 1/1 threshold are tripped).
const TIGHTER_RETENTION_DAYS = 30;
// >= baseline → must NOT trigger the confirm panel.
const WIDER_RETENTION_DAYS = 75;

// Stubbed preview impact — large enough that BOTH the row arm AND the
// day arm of the default 1/1 confirm threshold trip, and the
// `formatMetricsRetentionImpactText` renderer emits the
// "spanning ~D days of telemetry" clause (only included when
// daysToDelete > 0).
const STUB_PREVIEW_ROWS = 12_345;
const STUB_PREVIEW_DAYS = 14;
const STUB_PREVIEW_OLDEST_AGE_DAYS = 73;

let apiCtx: Awaited<ReturnType<typeof pwRequest.newContext>>;
let originalOverride: number | null = null;

async function getRetention(): Promise<any> {
  const res = await apiCtx.get(RETENTION_PATH);
  expect(res.status(), `GET ${RETENTION_PATH} should succeed`).toBe(200);
  const body = await res.json();
  return body.data;
}

async function putRetention(retention_days: number | null, note?: string): Promise<void> {
  const res = await apiCtx.put(RETENTION_PATH, {
    <REDACTED_SCHEME> { retention_days, ...(note ? { note } : {}) },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(
    res.status(),
    `PUT ${RETENTION_PATH} (retention_days=${retention_days}) should succeed`,
  ).toBe(200);
}

test.describe('AI metrics retention — inline confirm panel (Task #561 / Task #587)', () => {
  test.beforeAll(async () => {
    if (!ADMIN_KEY) return;
    apiCtx = await pwRequest.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { 'X-Admin-Key': ADMIN_KEY },
    });
    // Single suite-level login; per-test logins would trip the
    // /api/admin/auth rate limiter (5 attempts / minute).
    const authRes = await apiCtx.post('/api/admin/auth', {
      <REDACTED_SCHEME> { key: ADMIN_KEY },
      headers: { 'Content-Type': 'application/json' },
    });
    if (authRes.status() !== 200) {
      throw new Error(`/api/admin/auth login returned HTTP ${authRes.status()}`);
    }
    const data = await getRetention();
    originalOverride = data.override_days ?? null;
  });

  test.afterAll(async () => {
    if (!apiCtx) return;
    try {
      // Restore whatever override existed before this spec ran so
      // subsequent runs / ambient dev usage are unaffected.
      await putRetention(
        originalOverride,
        'tests/aiMetricsRetentionConfirmPanel.spec.ts teardown',
      );
    } finally {
      await apiCtx.dispose();
    }
  });

  // Pin admin auth on every browser request so both the page load AND
  // the AJAX calls fired by ai-ops.html are authorized.
  test.use({
    extraHTTPHeaders: ADMIN_KEY ? { 'X-Admin-Key': ADMIN_KEY } : {},
  });

  test('Tightening save reveals the inline confirm panel; cancel withholds the PUT; confirm fires it', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }

    // Pin a known baseline so currentEffective is deterministic
    // regardless of what the dev box was sitting at.
    await putRetention(
      BASELINE_RETENTION_DAYS,
      `tests/aiMetricsRetentionConfirmPanel.spec.ts pre-test baseline — ${RUN_ID}`,
    );

    // Track every PUT to the retention endpoint so we can assert that
    // Save (and Cancel) genuinely DO NOT call it. Listening on the page
    // is the most regression-resistant way: a new code path that
    // accidentally fires a PUT will be visible no matter where it
    // originates from inside the dashboard JS.
    const putRequests: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes(RETENTION_PATH)) {
        putRequests.push(`${req.method()} ${req.url()}`);
      }
    });

    // Stub ONLY the preview endpoint so we can deterministically report
    // a non-zero, multi-day impact regardless of whether `ai_call_metrics`
    // contains rows older than TIGHTER_RETENTION_DAYS on the dev box.
    // GET / PUT to the retention endpoint flow through to the real
    // server — those round-trips are part of what this spec verifies.
    await page.route(`**${PREVIEW_PATH}**`, async (route) => {
      const url = new URL(route.request().url());
      const days = Number(url.searchParams.get('days'));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          <REDACTED_SCHEME> {
            candidate_days: days,
            rows_to_delete: STUB_PREVIEW_ROWS,
            oldest_row_age_days: STUB_PREVIEW_OLDEST_AGE_DAYS,
            days_to_delete: STUB_PREVIEW_DAYS,
          },
        }),
      });
    });

    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');

    // Switch to the Alert Thresholds tab — the retention card lives there.
    const retentionGetPromise = page.waitForResponse(
      (r) => r.url().includes(RETENTION_PATH)
        && !r.url().includes('/preview')
        && r.request().method() === 'GET',
      { timeout: 15000 },
    );
    await page.locator('[data-testid="tab-thresholds"]').click();
    await retentionGetPromise;

    // Sanity: the form rendered with the baseline we set, so we know
    // the live-preview / confirm-panel wiring is operating against a
    // known currentEffective.
    await expect(
      page.locator('[data-testid="text-metrics-retention-effective"]'),
    ).toHaveText(`${BASELINE_RETENTION_DAYS} days`);

    const input = page.locator('[data-testid="input-metrics-retention-days"]');
    const previewStatus = page.locator(
      '[data-testid="text-metrics-retention-preview"]',
    );
    const saveBtn = page.locator(
      '[data-testid="button-metrics-retention-save"]',
    );
    const confirmPanel = page.locator(
      '[data-testid="panel-metrics-retention-confirm"]',
    );
    const confirmSaveBtn = page.locator(
      '[data-testid="button-metrics-retention-confirm-save"]',
    );
    const cancelBtn = page.locator(
      '[data-testid="button-metrics-retention-confirm-cancel"]',
    );
    const statusEl = page.locator(
      '[data-testid="text-metrics-retention-save-status"]',
    );

    await expect(input).toBeVisible();
    await expect(saveBtn).toBeVisible();
    // Confirm panel exists in the DOM but is hidden until Save is clicked.
    await expect(confirmPanel).toBeHidden();

    // Type a tighter value — the input handler is debounced ~400ms and
    // fires the (stubbed) preview endpoint without needing a click on
    // "Preview impact". We assert the preview text is updated within
    // ~1.5s (debounce + network round-trip + render).
    await input.fill(String(TIGHTER_RETENTION_DAYS));

    // The renderer emits "Next prune will delete ~12,345 rows spanning
    // ~14 days of telemetry (older than 30 days)." for our stub. Assert
    // both required substrings appear — that proves the live-preview
    // path produced a row-count AND a day-span, not just one or the
    // other.
    await expect(previewStatus).toContainText('rows', { timeout: 1500 });
    await expect(previewStatus).toContainText('days of telemetry');

    // Click Save. The PUT must NOT fire — instead the confirm panel
    // must reveal itself.
    expect(putRequests, 'no PUTs should have happened yet').toHaveLength(0);
    await saveBtn.click();
    await expect(confirmPanel).toBeVisible();
    // Re-assert no PUT fired between the click and the panel appearing.
    // (`page.waitForTimeout` would be a flaky way to do this — instead
    // we wait for the panel to be visible, by which time the click
    // handler has fully run.)
    expect(
      putRequests,
      'Save click must NOT fire a PUT — it should only reveal the confirm panel',
    ).toHaveLength(0);

    // Cancel: panel hides, no PUT.
    await cancelBtn.click();
    await expect(confirmPanel).toBeHidden();
    await expect(statusEl).toContainText('cancelled');
    expect(
      putRequests,
      'Cancel must NOT fire a PUT',
    ).toHaveLength(0);

    // Re-open the panel and confirm. The PUT should fire exactly once.
    await saveBtn.click();
    await expect(confirmPanel).toBeVisible();

    const putResPromise = page.waitForResponse(
      (r) => r.url().includes(RETENTION_PATH)
        && !r.url().includes('/preview')
        && r.request().method() === 'PUT',
      { timeout: 15000 },
    );
    await confirmSaveBtn.click();
    const putRes = await putResPromise;

    expect(putRes.status(), 'Confirm & save should succeed').toBe(200);
    const putBody = await putRes.json();
    expect(putBody.success, 'PUT response should report success=true').toBe(true);
    expect(
      putBody.after,
      'PUT response should reflect the tighter override',
    ).toBe(TIGHTER_RETENTION_DAYS);
    expect(
      putBody.effective_days,
      'PUT response should expose the new effective window',
    ).toBe(TIGHTER_RETENTION_DAYS);

    // Exactly one PUT fired (the confirmed one) — Save and Cancel
    // earlier must not have leaked a request.
    expect(
      putRequests,
      'exactly one PUT should have fired (the confirmed save)',
    ).toHaveLength(1);

    // Confirm panel should hide after the confirmed save.
    await expect(confirmPanel).toBeHidden();

    // Post-save reload renders the form with the new effective value.
    // This is the user-visible "success" surface — the transient
    // `text-metrics-retention-save-status` toast is intentionally not
    // asserted because performMetricsRetentionPut() immediately calls
    // loadMetricsRetentionForm() which rerenders the whole form, so the
    // status span is empty by the time Playwright can inspect it (same
    // reasoning as tests/aiMetricsRetentionDashboard.spec.ts).
    await expect(
      page.locator('[data-testid="text-metrics-retention-effective"]'),
    ).toHaveText(`${TIGHTER_RETENTION_DAYS} days`);
  });

  test('Widening (>= current effective) saves immediately with no confirm panel', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }

    // Reset to a known baseline so the candidate WIDER_RETENTION_DAYS
    // is unambiguously >= currentEffective.
    await putRetention(
      BASELINE_RETENTION_DAYS,
      `tests/aiMetricsRetentionConfirmPanel.spec.ts widening pre-test — ${RUN_ID}`,
    );

    const putRequests: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes(RETENTION_PATH)) {
        putRequests.push(`${req.method()} ${req.url()}`);
      }
    });

    // Stub the preview endpoint same as before. Widening should NOT
    // trigger a confirm panel even if the preview endpoint returns
    // non-zero, because the gating logic is: tightening AND threshold
    // crossed. Stubbing it also lets us prove the preview wasn't even
    // consulted when widening (the saveMetricsRetention path skips the
    // pre-save fetch entirely when not tightening).
    await page.route(`**${PREVIEW_PATH}**`, async (route) => {
      const url = new URL(route.request().url());
      const days = Number(url.searchParams.get('days'));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          <REDACTED_SCHEME> {
            candidate_days: days,
            rows_to_delete: STUB_PREVIEW_ROWS,
            oldest_row_age_days: STUB_PREVIEW_OLDEST_AGE_DAYS,
            days_to_delete: STUB_PREVIEW_DAYS,
          },
        }),
      });
    });

    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');

    const retentionGetPromise = page.waitForResponse(
      (r) => r.url().includes(RETENTION_PATH)
        && !r.url().includes('/preview')
        && r.request().method() === 'GET',
      { timeout: 15000 },
    );
    await page.locator('[data-testid="tab-thresholds"]').click();
    await retentionGetPromise;

    await expect(
      page.locator('[data-testid="text-metrics-retention-effective"]'),
    ).toHaveText(`${BASELINE_RETENTION_DAYS} days`);

    const input = page.locator('[data-testid="input-metrics-retention-days"]');
    const saveBtn = page.locator(
      '[data-testid="button-metrics-retention-save"]',
    );
    const confirmPanel = page.locator(
      '[data-testid="panel-metrics-retention-confirm"]',
    );

    await input.fill(String(WIDER_RETENTION_DAYS));

    const putResPromise = page.waitForResponse(
      (r) => r.url().includes(RETENTION_PATH)
        && !r.url().includes('/preview')
        && r.request().method() === 'PUT',
      { timeout: 15000 },
    );
    await saveBtn.click();
    const putRes = await putResPromise;

    // Confirm panel must NEVER have shown — the gating is "tightening
    // AND threshold crossed", so widening goes straight through.
    await expect(confirmPanel).toBeHidden();

    expect(putRes.status(), 'Widening save should succeed immediately').toBe(200);
    const putBody = await putRes.json();
    expect(putBody.success).toBe(true);
    expect(putBody.after).toBe(WIDER_RETENTION_DAYS);
    expect(putBody.effective_days).toBe(WIDER_RETENTION_DAYS);

    expect(
      putRequests,
      'exactly one PUT (the immediate widening save) should have fired',
    ).toHaveLength(1);
  });
});
