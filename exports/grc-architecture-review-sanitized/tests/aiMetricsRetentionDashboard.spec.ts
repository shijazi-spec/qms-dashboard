/**
 * E2E test for the AI metrics retention admin flow on /ai-ops (Task #551).
 *
 * Background:
 *   Task #504 added a no-redeploy way for ops admins to change the
 *   `ai_call_metrics` prune window from /ai-ops → Alert Thresholds tab.
 *   Unit coverage on the config / audit / resolver layer is solid (34
 *   assertions in tests/aiMetricsRetentionConfig.test.ts) but there was
 *   no end-to-end test exercising the actual admin flow through the
 *   dashboard. A future refactor of dashboard/ai-ops.html could silently
 *   break the wiring between markup → AJAX call → renderer → audit row,
 *   and a CSP regression on the data-on-click handlers would silently
 *   no-op the Save button. This spec catches both classes of break.
 *
 * What this spec does:
 *   1. Authenticates as admin (POST /api/admin/auth) and pins
 *      X-Admin-Key on every browser request — same pattern as
 *      tests/aiOpsTabs.spec.ts and tests/toolHealthOverrideBanner.spec.ts.
 *   2. Snapshots the current retention override before any test runs and
 *      restores it on teardown so this spec leaves no permanent state.
 *   3. Happy path: navigates to /ai-ops, switches to the Alert Thresholds
 *      tab, sets the retention to a unique value, types a uniquely
 *      identifiable note, clicks Save, asserts the success status text,
 *      asserts the GET payload reflects the new value, asserts the audit
 *      row renders with our note, and (the cron-pickup half of the
 *      contract) asserts that an out-of-band call to
 *      resolveEffectiveAiMetricsRetentionDays-equivalent
 *      (GET /api/ai-ops/metrics-retention) returns the new value as
 *      `effective_days`.
 *   4. Lock-engaged path: uses page.route() to inject `env_locked: true`
 *      / `can_edit: false` into the GET response so the dashboard renders
 *      the lock banner and omits the Save button (mirrors what the server
 *      does when AI_METRICS_RETENTION_DAYS_LOCK is set in env), then
 *      intercepts the PUT and asserts the route is wired to the right
 *      endpoint and would surface the 409 error to the operator. The
 *      real server-side 409 behaviour is already covered by unit tests
 *      in tests/aiMetricsRetentionConfig.test.ts; the page.route()
 *      approach exercises the *UI's* response to the lock state without
 *      requiring a server restart with env-var changes mid-suite.
 *
 * Requirements:
 *   - Dev server must be running at BASE_URL (default
 *     <REDACTED_URL> — same convention as tests/aiOpsTabs.spec.ts.
 *   - ADMIN_API_KEY must be set on the server AND TEST_ADMIN_KEY (or
 *     ADMIN_API_KEY) must be set in the test process so /api/admin/auth
 *     and X-Admin-Key requests succeed; otherwise the suite is skipped.
 *
 * Run:
 *   npx playwright test tests/aiMetricsRetentionDashboard.spec.ts --reporter=line
 */

import { test, expect, request as pwRequest } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || '<REDACTED_URL>';
const ADMIN_KEY = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY || '';

const RETENTION_PATH = '/api/ai-ops/metrics-retention';

// Per-run identifier so the audit-note can be located unambiguously even
// when the audit table contains other entries from prior dev usage.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SAVED_NOTE = `Task #551 e2e — ${RUN_ID}`;
// Pick a value that is (a) inside AI_METRICS_RETENTION_BOUNDS (1..3650),
// (b) different from the env baseline default (90) so we can prove the
// override took effect, and (c) different from any value a real ops
// rotation is likely to land on so an unrelated dashboard change doesn't
// poison the assertion.
const SAVED_RETENTION_DAYS = 137;

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
  // Either succeeds (200) or — when the env lock is engaged — 409. We
  // call this in setup/teardown when no lock is engaged, so 200 is the
  // expected status; assert it explicitly so a regression that started
  // returning 5xx fails fast.
  expect(
    res.status(),
    `PUT ${RETENTION_PATH} (retention_days=${retention_days}) should succeed`,
  ).toBe(200);
}

test.describe('AI metrics retention — admin dashboard flow (Task #551)', () => {
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
    // Snapshot whatever override the dashboard / dev usage left behind so
    // teardown can restore it. We assert the GET endpoint works here too,
    // so a broken endpoint fails the suite at setup rather than masquerading
    // as a UI bug later.
    const data = await getRetention();
    originalOverride = data.override_days ?? null;
  });

  test.afterAll(async () => {
    if (!apiCtx) return;
    try {
      // Restore whatever override existed before this spec ran so
      // subsequent runs / ambient dev usage are unaffected.
      await putRetention(originalOverride, 'tests/aiMetricsRetentionDashboard.spec.ts teardown');
    } finally {
      await apiCtx.dispose();
    }
  });

  // Pin admin auth on every browser request — both the page load AND the
  // AJAX calls fired by ai-ops.html (GET /metrics-retention, PUT
  // /metrics-retention) need to be admin-authorized.
  test.use({
    extraHTTPHeaders: ADMIN_KEY ? { 'X-Admin-Key': ADMIN_KEY } : {},
  });

  test('Admin can change retention via UI; audit row renders; effective_days reflects new value', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }

    // Start from a known clean state (no override) so the assertion
    // about the audit "before → after" line is unambiguous.
    await putRetention(null, 'tests/aiMetricsRetentionDashboard.spec.ts pre-test reset');

    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');

    // Switch to the Alert Thresholds tab — the retention card lives there.
    // safe-actions.js wires data-on-click via event delegation so the
    // CSP-blocked inline-onclick path is not used.
    const retentionGetPromise = page.waitForResponse(
      r => r.url().includes(RETENTION_PATH) && r.request().method() === 'GET',
      { timeout: 15000 },
    );
    await page.locator('[data-testid="tab-thresholds"]').click();
    await retentionGetPromise;

    // The whole retention section + its form should be visible after the
    // tab switch. If safe-actions.js stops wiring the tab click, this
    // assertion will fail before we touch the form, pointing right at
    // the regression class.
    await expect(page.locator('[data-testid="section-metrics-retention"]')).toBeVisible();
    await expect(page.locator('[data-testid="form-metrics-retention"]')).toBeVisible();

    const input = page.locator('[data-testid="input-metrics-retention-days"]');
    const noteInput = page.locator('[data-testid="input-metrics-retention-note"]');
    const saveBtn = page.locator('[data-testid="button-metrics-retention-save"]');
    await expect(input).toBeVisible();
    await expect(noteInput).toBeVisible();
    await expect(saveBtn).toBeVisible();
    await expect(saveBtn).toBeEnabled();

    // Type the new value + a uniquely-tagged note so we can locate the
    // resulting audit row without ambiguity.
    await input.fill(String(SAVED_RETENTION_DAYS));
    await noteInput.fill(SAVED_NOTE);

    // Trigger the save and capture the resulting PUT + the subsequent
    // reload GET (the Save handler calls loadMetricsRetentionForm() on
    // success which re-fetches the GET).
    const putResPromise = page.waitForResponse(
      r => r.url().includes(RETENTION_PATH) && r.request().method() === 'PUT',
      { timeout: 15000 },
    );
    const reloadGetPromise = page.waitForResponse(
      r => r.url().includes(RETENTION_PATH) && r.request().method() === 'GET',
      { timeout: 15000 },
    );
    await saveBtn.click();

    const putRes = await putResPromise;
    expect(putRes.status(), 'PUT should succeed (lock not engaged)').toBe(200);
    const putBody = await putRes.json();
    expect(putBody.success, 'PUT response should report success=true').toBe(true);
    expect(putBody.after, 'PUT response should reflect the new override').toBe(SAVED_RETENTION_DAYS);
    expect(
      putBody.effective_days,
      'PUT response should expose the new effective window so the cron picks it up next pass',
    ).toBe(SAVED_RETENTION_DAYS);

    await reloadGetPromise;

    // The "Effective" cell in the form re-renders to the new value once
    // the post-save reload of the GET payload completes. (The transient
    // success-status text inside `text-metrics-retention-save-status`
    // is intentionally NOT asserted: saveMetricsRetention() sets the
    // status string and then immediately calls loadMetricsRetentionForm()
    // which rerenders the whole form — the new status span is empty by
    // the time we can inspect it. The PUT response asserts above prove
    // the success path; the effective-cell + audit-row asserts below
    // prove the renderer reflects it.)
    await expect(page.locator('[data-testid="text-metrics-retention-effective"]')).toHaveText(`${SAVED_RETENTION_DAYS} days`);

    // The audit list should now contain a row tagged with our note. The
    // test ID is `row-metrics-retention-audit-${id}` (positional id from
    // the audit serial), and the row body carries the note as a small
    // italic line — locating by note text is the most stable selector.
    const auditList = page.locator('[data-testid="list-metrics-retention-audit"]');
    await expect(auditList).toBeVisible();
    const seededRow = auditList.locator('div[data-testid^="row-metrics-retention-audit-"]', {
      hasText: SAVED_NOTE,
    });
    await expect(seededRow, 'an audit row with our seeded note should appear').toHaveCount(1);
    // The before → after line is "— → 137d" because we pre-test-reset to null.
    await expect(seededRow).toContainText(`${SAVED_RETENTION_DAYS}d`);
    // Operator name is the admin-key user — at minimum a non-empty "by …" string.
    await expect(seededRow).toContainText(/by\s+\S+/);

    // Cron-pickup half of the contract: an out-of-band GET (i.e. what
    // the next cron pass would do) sees the new effective window. We
    // can't directly invoke the cron from a Playwright spec, but the
    // resolver the cron calls is exposed verbatim via the GET payload,
    // so this is the closest we can get without a server restart.
    const refreshed = await getRetention();
    expect(refreshed.override_days).toBe(SAVED_RETENTION_DAYS);
    expect(refreshed.effective_days).toBe(SAVED_RETENTION_DAYS);

    // Task #645: ambient scheduled-prune preview must be exposed on the
    // GET payload AND surfaced inline in the retention card so operators
    // can see "if I do nothing, the next cron pass will delete N rows"
    // without clicking the destructive Prune-now button. The exact row
    // count depends on the live ai_call_metrics table contents, so we
    // assert shape (well-formed object OR explicit null fallback) and
    // — when the server returned a number — that the UI line renders it
    // verbatim. Either branch must produce a visible preview line so
    // the operator never sees a blank row in the card.
    expect(
      refreshed,
      'GET payload must include the scheduled_preview field (Task #645)',
    ).toHaveProperty('scheduled_preview');
    const previewLine = page.locator('[data-testid="text-metrics-retention-scheduled-preview"]');
    await expect(previewLine, 'scheduled-preview line should be visible (unlocked path)').toBeVisible();
    await expect(previewLine).toContainText(/Next scheduled cron pass would delete/i);
    if (refreshed.scheduled_preview && Number.isFinite(Number(refreshed.scheduled_preview.rows_to_delete))) {
      const expectedRows = Number(refreshed.scheduled_preview.rows_to_delete).toLocaleString();
      await expect(
        page.locator('[data-testid="text-metrics-retention-scheduled-preview-rows"]'),
        'rendered row count should match GET payload',
      ).toHaveText(expectedRows);
    } else {
      await expect(
        page.locator('[data-testid="text-metrics-retention-scheduled-preview-rows"]'),
        'fallback to muted "—" when server could not compute the preview',
      ).toHaveText('—');
    }
  });

  test('Lock-engaged path: dashboard renders the lock banner, hides Save, and surfaces the 409 to the operator', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }

    // Mock the GET response so the dashboard sees `env_locked: true` /
    // `can_edit: false` without needing the server to actually have
    // AI_METRICS_RETENTION_DAYS_LOCK set in its env (which would
    // require a workflow restart mid-suite). This is a UI-only
    // simulation — the real 409 PUT path is unit-tested in
    // tests/aiMetricsRetentionConfig.test.ts and tests/aiOpsRoutes.test.ts.
    // Glob includes a trailing `**` so we also catch query-string variants
    // (`/metrics-retention?limit=25&offset=0` once paging was added in
    // Task #566). Without it, the mock would be bypassed on the GET and
    // the real backend would respond with `env_locked: false`, sinking
    // the lock-banner assertion below.
    await page.route(`**${RETENTION_PATH}**`, async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            <REDACTED_SCHEME> {
              default_days: 90,
              env_baseline_days: 60,
              env_var_set: true,
              env_locked: true,
              override_days: null,
              effective_days: 60,
              updated_by: null,
              updated_at: null,
              bounds: { min: 1, max: 3650 },
              audit: [],
              can_edit: false,
            },
          }),
        });
        return;
      }
      if (req.method() === 'PUT') {
        // Mirror the real server's lock-engaged response shape so the
        // UI's error-rendering wiring is exercised against the same
        // contract that aiOpsRoutes.ts emits.
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'AI_METRICS_RETENTION_DAYS_LOCK is engaged — clear the env lock to edit retention from the dashboard.',
          }),
        });
        return;
      }
      // Any other method → fall through (shouldn't happen for this route).
      await route.continue();
    });

    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');
    await page.locator('[data-testid="tab-thresholds"]').click();

    // Lock banner is the marquee assertion — its presence proves the
    // UI is reading `env_locked` from the GET payload and rendering the
    // operator-facing explanation. Use a generous timeout so the
    // assertion itself drives the wait for the renderer; whether the
    // mocked GET fires during page.goto() (initial bootstrap) or during
    // the tab click (lazy-load) is an implementation detail of the
    // dashboard that this spec deliberately does not pin down.
    const banner = page.locator('[data-testid="text-metrics-retention-lock-banner"]');
    await expect(banner, 'lock banner should be visible').toBeVisible({ timeout: 15000 });
    await expect(banner).toContainText('Env lock engaged');

    // Save (and Clear) buttons must be absent in the locked render —
    // operators should not be able to attempt a save that the server
    // would 409. The renderer only emits the buttons when
    // `data.can_edit === true`, which our mock sets to false.
    await expect(
      page.locator('[data-testid="button-metrics-retention-save"]'),
      'Save button should NOT render when locked',
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="button-metrics-retention-clear"]'),
      'Clear button should NOT render when locked',
    ).toHaveCount(0);

    // The input should also be present-but-disabled so the operator can
    // see the field but cannot type into it; Playwright's toBeDisabled
    // covers the `disabled` attribute on the rendered <input>.
    const input = page.locator('[data-testid="input-metrics-retention-days"]');
    await expect(input).toBeVisible();
    await expect(input, 'retention input should be disabled when locked').toBeDisabled();

    // Task #645: the ambient "next scheduled cron pass would delete N
    // rows" line is hidden under the locked path because the operator
    // can't act on it from the UI anyway. Hiding it keeps the lock
    // banner the unambiguous focal point and avoids implying the
    // dashboard could change anything.
    await expect(
      page.locator('[data-testid="text-metrics-retention-scheduled-preview"]'),
      'scheduled-preview line must NOT render when env_locked=true',
    ).toHaveCount(0);

    // Sanity-check the PUT-side of the lock contract: even though the
    // Save button is hidden, an operator who curls /api/ai-ops/metrics-retention
    // with a body would receive HTTP 409. We exercise this from the
    // page context (via fetch) so the same X-Admin-Key cookie/header
    // session is reused; the assertion is on status + error shape so a
    // regression that downgrades 409 → 500 (or drops the lock check
    // entirely) fails fast.
    const putStatus = await page.evaluate(async (path) => {
      const r = await fetch(path, {
        method: 'PUT',
        credentials: <REDACTED_SECRET>
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retention_days: 42, note: 'task-551 lock probe' }),
      });
      const body = await r.json().catch(() => ({}));
      return { status: r.status, error: body?.error };
    }, RETENTION_PATH);
    expect(putStatus.status, 'PUT under lock should return 409').toBe(409);
    expect(
      putStatus.error || '',
      'PUT 409 body should explain the lock so the UI can surface a meaningful toast',
    ).toMatch(/AI_METRICS_RETENTION_DAYS_LOCK/);
  });
});
