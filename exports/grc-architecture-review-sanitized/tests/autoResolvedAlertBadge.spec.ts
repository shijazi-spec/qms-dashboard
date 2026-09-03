/**
 * E2E spec for the "Auto-resolved" vs "Manually resolved" alert badge
 * (Task #325).
 *
 * Background:
 *   The UI logic that distinguishes an auto-resolved alert from one closed
 *   by a human is a string-prefix check on `resolution_note`. Both the
 *   tool-health and prompt-regression auto-resolve sweeps stamp
 *   `resolution_note` with an "auto-resolved" prefix when they close an
 *   alert; if a human clicks Resolve there is no note (or the note doesn't
 *   start with that prefix). This is rendered as a distinct pill in two
 *   places:
 *
 *     • dashboard/ai-ops.html      → loadToolHealthAlertsHistory()
 *         - auto:   `<span data-testid="badge-history-auto-${id}">Auto-resolved</span>`
 *         - manual: `<span data-testid="badge-history-manual-${id}">Manual</span>`
 *     • dashboard/consultant.html  → loadAllAlerts()
 *         - auto:   `<span data-testid="badge-resolution-auto-${id}">Auto-resolved</span>`
 *         - manual: `<span data-testid="badge-resolution-manual-${id}">Manually resolved</span>`
 *
 *   There were no automated tests verifying this rendering, so a future
 *   refactor of either check (the prefix string, the badge templates, or
 *   the API plumbing of `resolution_note`) could silently mislabel
 *   resolved alerts without any test alarm. This spec closes that gap.
 *
 * What this spec does:
 *   1. Authenticates as admin via /api/admin/auth and pins X-Admin-Key on
 *      every browser request — same pattern as tests/aiOpsTabs.spec.ts and
 *      tests/promptVersionTab.spec.ts.
 *   2. Seeds two `ai_alerts` rows of type `tool_health`, both `resolved`
 *      with `resolved_at = NOW()` (so they fall inside both the AI Ops
 *      "last 7 days" history window and the consultant All Alerts modal):
 *        - AUTO row   → resolution_note starts with "auto-resolved:"
 *        - MANUAL row → resolution_note IS NULL (the consultant UI treats
 *                       a missing note as "manually resolved")
 *      Each row uses a unique title containing the per-run RUN_ID so the
 *      cleanup sweep can find them unambiguously.
 *   3. Loads /ai-ops, expands the "Recently triaged tool-health alerts"
 *      panel, and asserts both seeded rows render with the correct pill:
 *        - AUTO row carries `badge-history-auto-${id}` with text
 *          "Auto-resolved" and the purple-pill class.
 *        - MANUAL row carries `badge-history-manual-${id}` with text
 *          "Manual" and the emerald-pill class. It must NOT carry the
 *          auto pill testid.
 *   4. Loads /consultant.html, opens the "All Alerts" modal, filters to
 *      Resolved status, and asserts both seeded rows render with the
 *      correct pill:
 *        - AUTO row carries `badge-resolution-auto-${id}` with text
 *          "Auto-resolved".
 *        - MANUAL row carries `badge-resolution-manual-${id}` with text
 *          "Manually resolved". It must NOT carry the auto pill testid.
 *      We also exercise the resolution-source filter dropdown so the
 *      "Auto-resolved" filter only keeps the AUTO row and the "Manually
 *      closed" filter only keeps the MANUAL row — guarding the same
 *      isAutoResolved() prefix check from a second angle.
 *   5. Cleans up the two seeded rows on teardown via an explicit DELETE
 *      keyed on title (the unique RUN_ID makes that safe to run
 *      unconditionally as a belt-and-braces sweep).
 *
 * Requirements:
 *   - The dev server must be running at BASE_URL (default
 *     <REDACTED_URL> — same convention as tests/i18n.spec.ts.
 *   - ADMIN_API_KEY (or <REDACTED_SECRET>) must be set in the environment
 *     so the test can authenticate; otherwise the suite is skipped.
 *   - DATABASE_URL must point at the same Postgres the server uses so
 *     the seed/cleanup can write directly.
 *
 * Run:
 *   npx playwright test tests/autoResolvedAlertBadge.spec.ts --reporter=line
 */

import { test, expect, request as pwRequest, type Page } from '@playwright/test';
import * as pg from 'pg';

const BASE_URL = process.env.BASE_URL || '<REDACTED_URL>';
const ADMIN_KEY = process.env.<REDACTED_SECRET> || process.env.ADMIN_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

// Per-run suffix so parallel/repeated runs don't collide and the
// cleanup WHERE clause is unambiguous even after a mid-seed crash.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const AUTO_TITLE = `e2e_auto_resolved_alert_${RUN_ID}`;
const MANUAL_TITLE = `e2e_manual_resolved_alert_${RUN_ID}`;
// Resolution note exactly mirrors the prefix the tool-health auto-resolve
// sweep stamps in production (`auto-resolved: …`). The frontend's
// isAutoResolved() check lower-cases and trims the note before comparing,
// so a leading capital letter or trailing whitespace would still match —
// we keep the canonical lowercase shape here on purpose.
const AUTO_NOTE = `auto-resolved: error rate recovered (e2e ${RUN_ID})`;

let pool: pg.Pool | null = null;
let autoAlertId: number | null = null;
let manualAlertId: number | null = null;

async function seedAlerts(): Promise<void> {
  if (!pool) throw new Error('pool not initialized');

  // Both rows use 'critical' severity so they sort to the very top of
  // the consultant All Alerts modal, which orders by
  // `CASE severity WHEN 'critical' THEN 0 …` and clamps the page size to
  // 50. On a busy DB any lower severity could push the seeded rows off
  // the first page; 'critical' + the most-recent created_at puts them at
  // positions 0 and 1 of the resolved-status filter regardless of how
  // much production noise lives behind them.

  // AUTO row — `resolution_note` starts with the "auto-resolved" prefix.
  // acknowledged_by is left NULL because the cron closes alerts directly
  // without going through the human-acknowledge step. resolved_at = NOW()
  // ensures the row lands inside the default 7-day history window.
  const autoRes = await pool.query(
    `INSERT INTO ai_alerts
       (alert_type, severity, title, description, suggestion, related_module,
        related_record_id, status, acknowledged_by, resolved_at,
        resolution_note, created_at)
     VALUES
       ('tool_health', 'critical', $1,
        'E2E seed — auto-resolved tool-health alert', NULL, 'ai_ops',
        $2, 'resolved', NULL, NOW(), $3, NOW())
     RETURNING id`,
    [AUTO_TITLE, `e2e:${RUN_ID}:auto`, AUTO_NOTE],
  );
  autoAlertId = Number(autoRes.rows[0].id);

  // MANUAL row — no resolution_note (NULL). The consultant UI treats this
  // as "manually resolved" because isAutoResolved() returns false when
  // there's no note to inspect. acknowledged_by is set so the history
  // panel's "by …" cell renders an operator name (the badge logic itself
  // doesn't depend on it, but it keeps the row visually distinct from
  // the auto row in case a human inspects the screenshot).
  const manualRes = await pool.query(
    `INSERT INTO ai_alerts
       (alert_type, severity, title, description, suggestion, related_module,
        related_record_id, status, acknowledged_by, resolved_at,
        resolution_note, created_at)
     VALUES
       ('tool_health', 'critical', $1,
        'E2E seed — manually resolved tool-health alert', NULL, 'ai_ops',
        $2, 'resolved', $3, NOW(), NULL, NOW())
     RETURNING id`,
    [MANUAL_TITLE, `e2e:${RUN_ID}:manual`, `e2e-operator-${RUN_ID}`],
  );
  manualAlertId = Number(manualRes.rows[0].id);
}

async function cleanupAlerts(): Promise<void> {
  if (!pool) return;
  // Title-based delete is safe because each run uses a unique RUN_ID
  // suffix; the id-based delete is the primary path and the title sweep
  // is a belt-and-braces fallback in case the seed inserted but the id
  // capture failed.
  const ids: number[] = [];
  if (autoAlertId != null) ids.push(autoAlertId);
  if (manualAlertId != null) ids.push(manualAlertId);
  if (ids.length > 0) {
    await pool.query(`DELETE FROM ai_alerts WHERE id = ANY($1::bigint[])`, [ids]);
  }
  await pool.query(
    `DELETE FROM ai_alerts WHERE title = ANY($1::text[])`,
    [[AUTO_TITLE, MANUAL_TITLE]],
  );
  autoAlertId = null;
  manualAlertId = null;
}

async function authenticateAsAdmin(page: Page): Promise<void> {
  // Drops the admin_key cookie on the browser context as a courtesy so a
  // human watching headed mode is signed in too. The X-Admin-Key header
  // (set via context.extraHTTPHeaders below) is what actually authorizes
  // both the page request and the AJAX calls fired by the dashboards.
  const res = await page.request.post(`${BASE_URL}/api/admin/auth`, {
    <REDACTED_SCHEME> { key: ADMIN_KEY },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(res.status(), 'admin /api/admin/auth login should succeed').toBe(200);
}

test.describe('Auto-resolved vs manually-resolved alert badges (Task #325)', () => {
  test.beforeAll(async () => {
    if (!ADMIN_KEY || !DATABASE_URL) return;
    // Hit any admin-authenticated endpoint that touches ai_alerts so the
    // server runs initAIAlertsTable() (which creates the table and the
    // resolution_note / acknowledged_at columns) before we INSERT seed
    // rows directly. Without this warmup, a fresh dev DB throws
    // `relation "ai_alerts" does not exist` on the first INSERT.
    const apiCtx = await pwRequest.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { 'X-Admin-Key': ADMIN_KEY },
    });
    try {
      // Single suite-level login. /api/admin/auth is rate-limited
      // (5 attempts / minute), so a per-test login would turn this
      // suite flaky on repeated runs.
      const authRes = await apiCtx.post('/api/admin/auth', {
        <REDACTED_SCHEME> { key: ADMIN_KEY },
        headers: { 'Content-Type': 'application/json' },
      });
      if (authRes.status() !== 200) {
        throw new Error(`/api/admin/auth login returned HTTP ${authRes.status()}`);
      }
      // /api/ai-ops/tool-health-alerts/history calls
      // getToolHealthAlertHistory() which requires the ai_alerts table
      // (and the resolution_note + acknowledged_at idempotent ALTERs)
      // to exist. A 200 here proves the schema is ready for seeding.
      const warmup = await apiCtx.get('/api/ai-ops/tool-health-alerts/history?days=7&limit=1');
      if (warmup.status() !== 200) {
        throw new Error(`tool-health-alerts/history warmup returned HTTP ${warmup.status()}`);
      }
    } finally {
      await apiCtx.dispose();
    }
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await seedAlerts();
  });

  test.afterAll(async () => {
    try {
      await cleanupAlerts();
    } finally {
      await pool?.end().catch(() => {});
      pool = null;
    }
  });

  test.use({
    extraHTTPHeaders: ADMIN_KEY ? { 'X-Admin-Key': ADMIN_KEY } : {},
  });

  test('AI Ops history panel renders the Auto-resolved pill for auto-closed alerts and the Manual pill for human-closed alerts', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / <REDACTED_SECRET> not set in environment');
      return;
    }
    if (!DATABASE_URL) {
      test.skip(true, 'DATABASE_URL not set in environment');
      return;
    }

    expect(autoAlertId, 'auto-resolved seed row should have an id').toBeTruthy();
    expect(manualAlertId, 'manually-resolved seed row should have an id').toBeTruthy();

    await authenticateAsAdmin(page);

    // Set up the wait BEFORE goto — loadToolHealthAlertsHistory() fires
    // from the page's DOMContentLoaded handler, so the response can
    // race the page-load resolution.
    const historyResPromise = page.waitForResponse(
      r => r.url().includes('/api/ai-ops/tool-health-alerts/history')
        && r.request().method() === 'GET',
      { timeout: 15000 },
    );

    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');

    const historyRes = await historyResPromise;
    expect(historyRes.status(), 'tool-health-alerts/history should succeed').toBe(200);

    // Expand the panel so the rows are visible. The list is rendered into
    // the DOM regardless of the panel's collapsed state, so the
    // assertions below would also pass against the hidden body — but
    // expanding it makes the spec match what an operator actually sees.
    const toggle = page.locator('[data-testid="button-tool-health-history-toggle"]');
    await expect(toggle).toBeVisible({ timeout: 10000 });
    await toggle.click();

    const autoCard = page.locator(`[data-testid="card-tool-health-history-${autoAlertId}"]`);
    const manualCard = page.locator(`[data-testid="card-tool-health-history-${manualAlertId}"]`);
    await expect(autoCard, 'auto-resolved card should render in the history list').toBeVisible({ timeout: 15000 });
    await expect(manualCard, 'manually-resolved card should render in the history list').toBeVisible();

    // AUTO row — the seeded note "auto-resolved: error rate recovered …"
    // routes to the "recovered" category (Task #346), which renders a
    // green pill with the text "Recovered" plus a green inline
    // resolved-at line.
    const autoBadge = page.locator(`[data-testid="badge-history-recovered-${autoAlertId}"]`);
    await expect(autoBadge, 'AI Ops recovered badge should render for the auto-resolved row').toBeVisible();
    await expect(autoBadge).toHaveText(/Recovered/);
    await expect(autoBadge).toHaveClass(/bg-green-100/);
    await expect(autoBadge).toHaveClass(/text-green-800/);
    await expect(autoBadge).toHaveAttribute('title', AUTO_NOTE);
    await expect(autoBadge).toHaveAttribute('data-resolution-category', 'recovered');

    // The recovery row should also surface an inline green resolved-at
    // timestamp line so operators can spot self-healing events without
    // reading the right-aligned metadata column.
    await expect(
      page.locator(`[data-testid="text-history-resolved-at-${autoAlertId}"]`),
      'recovery row should surface the inline resolved-at timestamp',
    ).toBeVisible();

    // The auto card must NOT carry a *visible* manual pill. The
    // backwards-compatibility hidden <span class="sr-only"
    // data-testid="badge-history-manual-…"> still exists for legacy
    // selectors but its sr-only class clips it from the visual tree.
    await expect(
      page.locator(
        `[data-testid="badge-history-manual-${autoAlertId}"]:not(.sr-only)`,
      ),
      'auto-resolved row should not render a visible Manual pill',
    ).toHaveCount(0);

    // MANUAL row — uses the new "manual" category which renders a neutral
    // gray pill so it visually contrasts with the green recovery pills.
    const manualBadge = page.locator(`[data-testid="badge-history-manual-${manualAlertId}"]`);
    await expect(manualBadge.first(), 'AI Ops manual badge should render for the manually-resolved row').toBeVisible();
    const manualCategoryBadge = page.locator(`[data-testid="badge-history-manual-${manualAlertId}"]:not(.sr-only)`);
    await expect(manualCategoryBadge).toHaveText(/Manual/);
    await expect(manualCategoryBadge).toHaveClass(/bg-gray-100/);
    await expect(manualCategoryBadge).toHaveClass(/text-gray-700/);
    await expect(manualCategoryBadge).toHaveAttribute('title', 'Closed by an operator.');
    await expect(manualCategoryBadge).toHaveAttribute('data-resolution-category', 'manual');

    // Manual row must NOT carry any of the auto category badges.
    for (const slug of ['recovered', 'went-silent', 'prompt-regression']) {
      await expect(
        page.locator(`[data-testid="badge-history-${slug}-${manualAlertId}"]`),
        `manually-resolved row should not also render the ${slug} pill`,
      ).toHaveCount(0);
    }
  });

  test('Consultant All Alerts modal renders the Auto-resolved pill for auto-closed alerts and the Manually resolved pill for human-closed alerts (and the resolution-source filter agrees)', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / <REDACTED_SECRET> not set in environment');
      return;
    }
    if (!DATABASE_URL) {
      test.skip(true, 'DATABASE_URL not set in environment');
      return;
    }

    expect(autoAlertId, 'auto-resolved seed row should have an id').toBeTruthy();
    expect(manualAlertId, 'manually-resolved seed row should have an id').toBeTruthy();

    await authenticateAsAdmin(page);

    await page.goto(`${BASE_URL}/consultant.html`);
    await page.waitForLoadState('domcontentloaded');

    // Open the All Alerts modal — its open handler calls loadAllAlerts(),
    // which we then narrow to the Resolved status so the seeded rows
    // surface even on a busy DB. Using page.evaluate to call the
    // window-exposed handlers avoids fighting the modal's stacking layer.
    await page.waitForFunction(() => typeof (window as any).showAllAlerts === 'function', undefined, { timeout: 15000 });

    // Pre-narrow the status filter BEFORE the first load fires so we
    // don't waste a request on the "All Status" default.
    await page.evaluate(() => {
      const sel = document.getElementById('alertFilterStatus') as HTMLSelectElement | null;
      if (sel) sel.value = 'resolved';
    });

    const alertsResPromise = page.waitForResponse(
      r => r.url().includes('/api/consultant/alerts')
        && !r.url().includes('/count')
        && r.request().method() === 'GET',
      { timeout: 15000 },
    );
    await page.evaluate(() => (window as any).showAllAlerts());
    const alertsRes = await alertsResPromise;
    expect(alertsRes.status(), '/api/consultant/alerts should succeed').toBe(200);

    const autoCard = page.locator(`[data-testid="card-alert-${autoAlertId}"]`);
    const manualCard = page.locator(`[data-testid="card-alert-${manualAlertId}"]`);
    await expect(autoCard, 'auto-resolved card should render in the All Alerts modal').toBeVisible({ timeout: 15000 });
    await expect(manualCard, 'manually-resolved card should render in the All Alerts modal').toBeVisible();

    // AUTO row — the seeded note routes to the "recovered" category
    // (Task #346). Visible pill is green and uses the new category
    // testid; copy is still i18n-driven ("Auto-resolved") so the
    // consultant translation keeps working.
    const autoBadge = page.locator(`[data-testid="badge-resolution-recovered-${autoAlertId}"]`);
    await expect(autoBadge, 'consultant recovered badge should render for the auto-resolved row').toBeVisible();
    await expect(autoBadge).toHaveText(/Auto-resolved/);
    await expect(autoBadge).toHaveClass(/bg-green-100/);
    await expect(autoBadge).toHaveClass(/text-green-800/);
    await expect(autoBadge).toHaveAttribute('title', AUTO_NOTE);
    await expect(autoBadge).toHaveAttribute('data-resolution-category', 'recovered');
    await expect(
      page.locator(`[data-testid="text-resolution-note-${autoAlertId}"]`),
      'inline resolution-note line should echo the auto note',
    ).toContainText(AUTO_NOTE);
    // Inline green resolved-at timestamp for recovery events.
    await expect(
      page.locator(`[data-testid="text-resolution-resolved-at-${autoAlertId}"]`),
      'recovery row should surface inline resolved-at line',
    ).toBeVisible();

    // MANUAL row — neutral gray "manual" category pill.
    const manualBadge = page.locator(`[data-testid="badge-resolution-manual-${manualAlertId}"]:not(.sr-only)`);
    await expect(manualBadge, 'consultant manual badge should render for the manually-resolved row').toBeVisible();
    await expect(manualBadge).toHaveText(/Manually resolved/);
    await expect(manualBadge).toHaveClass(/bg-gray-100/);
    await expect(manualBadge).toHaveClass(/text-gray-700/);
    await expect(manualBadge).toHaveAttribute('title', 'Closed by an operator.');
    await expect(manualBadge).toHaveAttribute('data-resolution-category', 'manual');
    await expect(
      page.locator(`[data-testid="text-resolution-note-${manualAlertId}"]`),
      'manually-resolved row should not show an inline note (resolution_note is NULL)',
    ).toHaveCount(0);

    // Mutual-exclusivity guards — the recovered row must not also carry
    // the manual category pill (visible), and the manual row must not
    // carry any of the auto category pills.
    await expect(
      page.locator(`[data-testid="badge-resolution-manual-${autoAlertId}"]:not(.sr-only)`),
      'auto-resolved row should not render a visible manual pill',
    ).toHaveCount(0);
    for (const slug of ['recovered', 'went-silent', 'prompt-regression']) {
      await expect(
        page.locator(`[data-testid="badge-resolution-${slug}-${manualAlertId}"]`),
        `manually-resolved row should not render the ${slug} pill`,
      ).toHaveCount(0);
    }

    // ── Resolution-source filter dropdown ────────────────────────────
    // Same isAutoResolved() prefix check, exercised from the filter side.
    // Selecting "Auto-resolved" must keep the AUTO card and drop the
    // MANUAL one; selecting "Manually closed" must do the inverse.
    const resolutionFilter = page.locator('[data-testid="select-alert-resolution-filter"]');
    await expect(resolutionFilter).toBeVisible();

    await resolutionFilter.selectOption('auto');
    await expect(autoCard, 'AUTO filter should keep the auto-resolved row').toBeVisible({ timeout: 5000 });
    await expect(manualCard, 'AUTO filter should drop the manually-resolved row').toHaveCount(0);

    await resolutionFilter.selectOption('manual');
    await expect(manualCard, 'MANUAL filter should keep the manually-resolved row').toBeVisible({ timeout: 5000 });
    await expect(autoCard, 'MANUAL filter should drop the auto-resolved row').toHaveCount(0);

    // Restore the unfiltered view so a follow-up test (or a human
    // re-running headed mode) doesn't inherit a narrow filter.
    await resolutionFilter.selectOption('');
  });
});
