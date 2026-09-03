/**
 * E2E test for the manual "Prune now" flow on the AI metrics retention
 * card on /ai-ops (Task #558, validated by Task #646).
 *
 * Background:
 *   Task #558 added a "Prune now" button next to the Save / Clear
 *   controls on the metrics-retention card so an admin who has just
 *   tightened the window does not have to wait up to ~24h for the next
 *   `ai-cost-summary` cron pass to see the rows actually deleted.
 *
 *   The wiring spans three layers:
 *     - Route handler: POST /api/ai-ops/metrics-retention/prune-now
 *       (src/mastra/routes/aiOpsRoutes.ts) — admin-gated, lock-aware,
 *       returns previewed + deleted row counts plus the audit id.
 *     - Audit helper: `recordAiMetricsRetentionPruneAudit()`
 *       (src/utils/aiMetricsRetentionConfig.ts) — appends a row with a
 *       `[prune-now] previewed=N deleted=M retention=Xd[ — note]`
 *       structured note to the same `ai_metrics_retention_audit` table
 *       that config changes write to.
 *     - Dashboard UI: button → red `panel-metrics-retention-prune`
 *       confirm dialog → POST → result banner → audit row tagged with
 *       a "Manual prune" red badge (dashboard/ai-ops.html).
 *
 *   Existing coverage is solid on the inner two layers — the audit
 *   helper has 11 dedicated assertions in
 *   `tests/aiMetricsRetentionConfig.test.ts` and the route's
 *   admin-gating is covered by the 403-sweep in
 *   `tests/aiOpsRoutes.test.ts`. What was missing was a Playwright
 *   spec that exercised the full markup → data-on-click → fetch →
 *   banner → audit-renderer chain. Without it, a future refactor of
 *   `dashboard/js/safe-actions.js` (which delegates the
 *   `data-on-click` handlers under CSP) or the audit renderer block
 *   in `dashboard/ai-ops.html` could silently break the wiring without
 *   tripping any existing test.
 *
 * What this spec does:
 *   1. Authenticates as admin (POST /api/admin/auth) and pins
 *      X-Admin-Key on every browser request — same pattern as
 *      `tests/aiMetricsRetentionDashboard.spec.ts`.
 *   2. Snapshots the existing override before any test runs and
 *      restores it on teardown so this spec leaves no permanent
 *      retention state. (The audit row written by the prune itself is
 *      intentionally left in place — `ai_metrics_retention_audit` is
 *      append-only by design and a leftover prune-now row in dev is
 *      harmless and easy to find by its tagged note.)
 *   3. Happy path against the real backend: pre-sets the retention so
 *      the effective window is deterministic, navigates to /ai-ops,
 *      switches to the Alert Thresholds tab, clicks Prune now, asserts
 *      the red `panel-metrics-retention-prune` confirm panel appears,
 *      types a uniquely-tagged note, captures the POST request, clicks
 *      Confirm, asserts the POST fires against the right path with the
 *      operator note, asserts the result banner renders the previewed
 *      + deleted counts surfaced by the route, and asserts the new
 *      audit row appears in the timeline tagged with the "Manual prune"
 *      red badge and the previewed/deleted counts line.
 *   4. Lock-engaged path: uses page.route() to inject
 *      `env_locked: true` / `can_edit: false` into the GET response
 *      so the dashboard renders the lock banner and omits the Prune
 *      now button entirely (it lives inside the same `canEdit` block
 *      as the Save / Clear buttons in the renderer). Mirrors the
 *      lock-engaged sub-test in `tests/aiMetricsRetentionDashboard.spec.ts`.
 *
 * Requirements:
 *   - Dev server must be running at BASE_URL (default
 *     <REDACTED_URL> — same convention as
 *     tests/aiMetricsRetentionDashboard.spec.ts.
 *   - ADMIN_API_KEY must be set on the server AND TEST_ADMIN_KEY (or
 *     ADMIN_API_KEY) must be set in the test process so /api/admin/auth
 *     and X-Admin-Key requests succeed; otherwise the suite is skipped.
 *
 * Run:
 *   npx playwright test tests/aiMetricsRetentionPruneNow.spec.ts --reporter=line
 */

import { test, expect, request as pwRequest } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || '<REDACTED_URL>';
const ADMIN_KEY = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY || '';

const RETENTION_PATH = '/api/ai-ops/metrics-retention';
const PRUNE_NOW_PATH = '/api/ai-ops/metrics-retention/prune-now';

// Per-run identifier so the audit-note that this spec writes can be
// located unambiguously even when the audit table contains other
// entries from prior dev usage or sibling specs.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PRUNE_NOTE = `Task #646 e2e prune-now — ${RUN_ID}`;

// Pick a value that is (a) inside AI_METRICS_RETENTION_BOUNDS (1..3650),
// (b) different from the env baseline default (90) so the effective
// window seen by the route is unambiguous, and (c) wide enough that
// the prune is very unlikely to delete real telemetry on a fresh dev
// box (so the assertion "deleted_rows >= 0" is the right contract;
// the route returns the count regardless of whether anything was
// actually removed).
const PRESET_RETENTION_DAYS = 365;

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

test.describe('AI metrics retention — Prune now flow (Task #558 / #646)', () => {
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
    // Snapshot whatever override the dashboard / dev usage left behind
    // so teardown can restore it.
    const data = await getRetention();
    originalOverride = data.override_days ?? null;
  });

  test.afterAll(async () => {
    if (!apiCtx) return;
    try {
      // Restore the original override. The prune-now audit row this
      // spec writes is intentionally NOT cleaned up — the audit table
      // is append-only by design and the row is tagged with RUN_ID so
      // it is easy to grep for and ignore in dev.
      await putRetention(originalOverride, 'tests/aiMetricsRetentionPruneNow.spec.ts teardown');
    } finally {
      await apiCtx.dispose();
    }
  });

  // Pin admin auth on every browser request — the page load AND the
  // AJAX calls fired by ai-ops.html (GET /metrics-retention,
  // POST /metrics-retention/prune-now, GET /metrics-retention/preview)
  // all need to be admin-authorized.
  test.use({
    extraHTTPHeaders: ADMIN_KEY ? { 'X-Admin-Key': ADMIN_KEY } : {},
  });

  test('Admin can run "Prune now" via the UI; result banner shows previewed + deleted counts; audit row renders with Manual prune badge', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }

    // Pre-set the retention so the effective window the route resolves
    // is deterministic regardless of whatever the dev box was sitting
    // at. The PUT also seeds an `updated_by` so the GET payload reflects
    // a real admin.
    await putRetention(PRESET_RETENTION_DAYS, 'tests/aiMetricsRetentionPruneNow.spec.ts pre-test reset');

    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');

    // Switch to the Alert Thresholds tab — the retention card lives
    // there. The tab click is wired through `safe-actions.js` event
    // delegation (no inline onclick — CSP forbids it), so this also
    // smoke-tests that wiring by virtue of needing it to fire the GET.
    const retentionGetPromise = page.waitForResponse(
      r => r.url().includes(RETENTION_PATH) && r.request().method() === 'GET',
      { timeout: 15000 },
    );
    await page.locator('[data-testid="tab-thresholds"]').click();
    await retentionGetPromise;

    // The Prune now button is rendered inside the same `canEdit` block
    // as Save / Clear, so its presence proves the GET payload reported
    // can_edit=true (i.e. we are authenticated AND not env-locked).
    await expect(page.locator('[data-testid="section-metrics-retention"]')).toBeVisible();
    const pruneBtn = page.locator('[data-testid="button-metrics-retention-prune-now"]');
    await expect(pruneBtn, 'Prune now button should be visible for admins when not env-locked').toBeVisible();
    await expect(pruneBtn).toBeEnabled();

    // Click Prune now → the red confirm panel should appear. The body
    // initially says "Counting rows…" then updates after the preview
    // GET resolves — assert the panel itself is visible and assert the
    // body text eventually reflects either the count or the
    // unable-to-count fallback. Either is fine for this assertion;
    // the contract under test is "the panel appears and is populated".
    await pruneBtn.click();
    const prunePanel = page.locator('[data-testid="panel-metrics-retention-prune"]');
    await expect(prunePanel, 'red confirm panel should appear after clicking Prune now').toBeVisible();
    const prunePanelBody = page.locator('[data-testid="text-metrics-retention-prune-body"]');
    // The body text starts at "Counting rows…" and is replaced once
    // the preview resolves. Use a regex that matches all three
    // possible terminal states (some rows / no rows / preview failed)
    // so a slow preview endpoint doesn't make this assertion flaky.
    await expect(prunePanelBody).toHaveText(
      /(About to delete|No rows older than|Could not count how many rows would be deleted)/,
      { timeout: 15000 },
    );

    // Type a uniquely-tagged note so we can locate the resulting audit
    // row without ambiguity even if other prune-now rows exist in the
    // dev DB from prior runs.
    const noteInput = page.locator('[data-testid="input-metrics-retention-prune-note"]');
    await expect(noteInput).toBeVisible();
    await noteInput.fill(PRUNE_NOTE);

    // Capture the destructive POST and the post-prune reload GET that
    // the success handler fires via loadMetricsRetentionForm().
    const postPromise = page.waitForResponse(
      r => r.url().includes(PRUNE_NOW_PATH) && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    const reloadGetPromise = page.waitForResponse(
      // The reload GET hits /metrics-retention with the audit query
      // string (limit=…&offset=…) — the includes() check tolerates
      // both the bare path and any future query-string additions.
      r =>
        r.url().includes(RETENTION_PATH) &&
        !r.url().includes('/prune-now') &&
        !r.url().includes('/preview') &&
        r.request().method() === 'GET',
      { timeout: 30000 },
    );
    const confirmBtn = page.locator('[data-testid="button-metrics-retention-prune-confirm"]');
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();

    const postRes = await postPromise;
    expect(postRes.status(), 'POST /prune-now should succeed (admin auth, no lock)').toBe(200);
    // Verify the request body carried our note (proves the input is
    // wired through to the POST body, not silently dropped).
    const postReqBody = postRes.request().postDataJSON?.() || {};
    expect(postReqBody?.note, 'POST body should carry the operator note from the panel input').toBe(PRUNE_NOTE);
    const postBody = await postRes.json();
    expect(postBody.success, 'POST response should report success=true').toBe(true);
    expect(
      postBody.retention_days,
      'POST response should echo the effective retention window the prune ran against',
    ).toBe(PRESET_RETENTION_DAYS);
    expect(
      typeof postBody.deleted_rows === 'number' && postBody.deleted_rows >= 0,
      'POST response should report a non-negative deleted_rows count',
    ).toBe(true);
    // `previewed_rows` is `null` when the dry-run preview itself
    // throws (a documented non-fatal fallback in the route handler);
    // accept either a non-negative number or null so this spec doesn't
    // become flaky in environments where the preview SQL transiently
    // fails. The renderer already covers both cases.
    expect(
      postBody.previewed_rows === null ||
        (typeof postBody.previewed_rows === 'number' && postBody.previewed_rows >= 0),
      'previewed_rows should be a non-negative number or null',
    ).toBe(true);
    expect(
      postBody.audit_id,
      'POST response should expose the new audit_id so the dashboard can link to the row',
    ).not.toBeNull();

    // The result banner is the operator-facing surface that proves the
    // POST succeeded. It is re-applied after the reload via
    // `lastMetricsRetentionPruneResult` so it should remain visible
    // even after loadMetricsRetentionForm() rerenders the form.
    const banner = page.locator('[data-testid="banner-metrics-retention-prune-result"]');
    await expect(banner, 'result banner should be visible after the POST resolves').toBeVisible({ timeout: 15000 });
    await expect(banner).toContainText('Prune complete');
    await expect(
      banner,
      'banner should mention the actual deleted row count',
    ).toContainText(/actually deleted [\d,]+ rows?/);
    await expect(
      banner,
      'banner should mention the previewed row count (or that the preview was unavailable)',
    ).toContainText(/previewed (?:[\d,]+ rows?|unknown \(preview unavailable\))/);
    await expect(
      banner,
      'banner should reference the retention window the prune ran against',
    ).toContainText(`${PRESET_RETENTION_DAYS}-day window`);

    // Wait for the post-prune reload GET so the audit list is rendered
    // with the freshly-written row.
    await reloadGetPromise;

    // Find the audit row by its uniquely-tagged operator note. The
    // row is rendered with `data-audit-kind="prune-now"` and contains
    // a "Manual prune" red badge — both of those are the contract
    // under test.
    const auditList = page.locator('[data-testid="list-metrics-retention-audit"]');
    await expect(auditList).toBeVisible();
    const seededRow = auditList.locator('div[data-testid^="row-metrics-retention-audit-"]', {
      hasText: PRUNE_NOTE,
    });
    await expect(
      seededRow,
      'a prune-now audit row tagged with our seeded note should appear',
    ).toHaveCount(1);
    // The row must be tagged as prune-now (vs. a config-change row)
    // so the renderer's branch-detect on the `[prune-now]` note
    // prefix is exercised end-to-end.
    await expect(seededRow).toHaveAttribute('data-audit-kind', 'prune-now');
    // The Manual prune red badge is the marquee visual marker for an
    // operator scanning the audit timeline — assert it explicitly so a
    // refactor that swaps the badge for a different element fails the
    // spec rather than silently regressing the visual contract.
    const badge = seededRow.locator('[data-testid^="badge-metrics-retention-audit-prune-now-"]');
    await expect(badge, 'Manual prune red badge should render on the prune-now row').toHaveCount(1);
    await expect(badge).toContainText('Manual prune');
    // The structured "Previewed N rows, actually deleted M rows" line
    // is what proves the renderer is correctly parsing the
    // `[prune-now] previewed=… deleted=… retention=…d` note prefix.
    const counts = seededRow.locator('[data-testid^="text-metrics-retention-audit-counts-"]');
    await expect(counts, 'previewed / deleted counts line should render').toHaveCount(1);
    await expect(counts).toContainText('Previewed');
    await expect(counts).toContainText('actually deleted');
    // The retention window the prune used (which equals
    // PRESET_RETENTION_DAYS because we pre-set it above) is rendered
    // as a "Xd" mono span at the top of the row.
    await expect(seededRow).toContainText(`${PRESET_RETENTION_DAYS}d`);
    // Operator name is the admin-key user — at minimum a non-empty
    // "by …" string. Same shape as the config-change rows.
    await expect(seededRow).toContainText(/by\s+\S+/);
  });

  test('Lock-engaged path: Prune now button is absent when env_locked=true', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }

    // Mock the GET response so the dashboard sees `env_locked: true` /
    // `can_edit: false` without needing the server to actually have
    // AI_METRICS_RETENTION_DAYS_LOCK set in its env (which would
    // require a workflow restart mid-suite). This is a UI-only
    // simulation — the real 409 POST path is unit-tested in
    // tests/aiOpsRoutes.test.ts.
    //
    // Glob includes a trailing `**` so we also catch query-string
    // variants (`/metrics-retention?limit=25&offset=0`). Without it,
    // the mock would be bypassed on the GET and the real backend
    // would respond with `env_locked: false`, sinking the
    // button-absent assertion below.
    await page.route(`**${RETENTION_PATH}**`, async (route) => {
      const req = route.request();
      // Don't intercept the prune-now POST or the preview GET — those
      // should never fire in this sub-test (the button is absent), but
      // letting them fall through means a regression that DOES fire
      // them would surface as a real 409/200 in the network log
      // instead of being silently swallowed by the mock.
      if (req.url().includes('/prune-now') || req.url().includes('/preview')) {
        await route.continue();
        return;
      }
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
              audit_total: 0,
              audit_limit: 25,
              audit_offset: 0,
              can_edit: false,
            },
          }),
        });
        return;
      }
      // Any other method → fall through.
      await route.continue();
    });

    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');
    await page.locator('[data-testid="tab-thresholds"]').click();

    // Lock banner is the marquee assertion — its presence proves the
    // UI is reading `env_locked` from the GET payload and rendering
    // the operator-facing explanation.
    const banner = page.locator('[data-testid="text-metrics-retention-lock-banner"]');
    await expect(banner, 'lock banner should be visible').toBeVisible({ timeout: 15000 });

    // Prune now must be absent in the locked render — operators
    // should not be able to attempt a destructive prune that the
    // server would 409. The renderer only emits the button when
    // `data.can_edit === true`, which our mock sets to false.
    await expect(
      page.locator('[data-testid="button-metrics-retention-prune-now"]'),
      'Prune now button should NOT render when env-locked',
    ).toHaveCount(0);
    // Sibling buttons must also be absent — proves the entire
    // canEdit-gated button block is skipped, not just the Prune
    // now node.
    await expect(
      page.locator('[data-testid="button-metrics-retention-save"]'),
      'Save button should NOT render when env-locked (sanity check that the canEdit branch fired)',
    ).toHaveCount(0);
    // The destructive confirm panel must also be absent — it lives
    // inside the same canEdit block as the button itself, so a
    // regression that re-emits the panel without the trigger button
    // would still leak a destructive surface into the locked view.
    await expect(
      page.locator('[data-testid="panel-metrics-retention-prune"]'),
      'Prune confirm panel should NOT render when env-locked',
    ).toHaveCount(0);
  });
});
