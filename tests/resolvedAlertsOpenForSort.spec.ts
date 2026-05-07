/**
 * E2E spec for the resolved-alerts feed's "Open for: …" line and the
 * "Open the longest" sort control on the AI Ops Recently-triaged
 * tool-health panel (Task #417).
 *
 * Background:
 *   The history panel has long surfaced an inline `Open for: …` line on
 *   each resolved row, computed client-side from `created_at →
 *   resolved_at`. Task #417 adds a sort selector that re-orders the
 *   already-fetched window by that same delta so on-call reviewers can
 *   find the alerts that stayed open the longest at a glance — those
 *   are the post-incident-review candidates.
 *
 *   There were no automated tests covering either the open-for line's
 *   render path or the new sort behavior, so a future refactor of
 *   `fmtAlertOpenDuration`, the testid, or the sort comparator could
 *   silently break the on-call workflow with no test alarm. This spec
 *   closes that gap.
 *
 * What this spec does:
 *   1. Authenticates as admin via /api/admin/auth and pins X-Admin-Key
 *      on every browser request — same pattern as
 *      tests/autoResolvedAlertBadge.spec.ts.
 *   2. Seeds three `ai_alerts` rows of type `tool_health`, all critical
 *      severity so they sort to the top of the 50-row history page even
 *      on a busy DB:
 *        - SHORT  → resolved, created 5 minutes ago, resolved_at = NOW()
 *        - LONG   → resolved, created 4 hours ago,  resolved_at = NOW()
 *        - ACK    → acknowledged-only, created 2 hours ago, resolved_at NULL
 *      Each row uses a unique title containing the per-run RUN_ID so the
 *      cleanup sweep can find them unambiguously.
 *   3. Loads /ai-ops, expands the panel, and asserts:
 *        - SHORT and LONG cards each carry `text-history-open-for-${id}`
 *          (so the line renders for resolved rows).
 *        - The ACK card does NOT carry that testid (acknowledged-only
 *          rows have no measurable open-for and the line must be
 *          omitted, not rendered as "Invalid Date" or empty).
 *   4. Selects the "Open the longest" option in the new sort control
 *      and asserts the LONG card's DOM position precedes the SHORT
 *      card's — the comparator must rank longer-open above shorter-open
 *      regardless of the backend's default most-recently-triaged order.
 *   5. Cleans up the seeded rows on teardown via an explicit DELETE
 *      keyed on title.
 *
 * Requirements:
 *   - The dev server must be running at BASE_URL (default
 *     http://localhost:5000).
 *   - ADMIN_API_KEY (or TEST_ADMIN_KEY) must be set in the environment;
 *     otherwise the suite is skipped.
 *   - DATABASE_URL must point at the same Postgres the server uses so
 *     the seed/cleanup can write directly.
 *
 * Run:
 *   npx playwright test tests/resolvedAlertsOpenForSort.spec.ts --reporter=line
 */

import { test, expect, request as pwRequest, type Page } from '@playwright/test';
import * as pg from 'pg';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const ADMIN_KEY = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SHORT_TITLE = `e2e_open_for_short_${RUN_ID}`;
const LONG_TITLE = `e2e_open_for_long_${RUN_ID}`;
const ACK_TITLE = `e2e_open_for_ack_${RUN_ID}`;

let pool: pg.Pool | null = null;
let shortId: number | null = null;
let longId: number | null = null;
let ackId: number | null = null;

async function seedAlerts(): Promise<void> {
  if (!pool) throw new Error('pool not initialized');

  // SHORT — open for ~5 minutes, resolved now. Lands inside the default
  // 7-day window via resolved_at = NOW().
  const shortRes = await pool.query(
    `INSERT INTO ai_alerts
       (alert_type, severity, title, description, suggestion, related_module,
        related_record_id, status, acknowledged_by, resolved_at,
        resolution_note, created_at)
     VALUES
       ('tool_health','critical',$1,
        'E2E seed — short open-for tool-health alert','n/a','ai_ops',
        $2,'resolved',NULL,NOW(),NULL, NOW() - INTERVAL '5 minutes')
     RETURNING id`,
    [SHORT_TITLE, `e2e:${RUN_ID}:short`],
  );
  shortId = Number(shortRes.rows[0].id);

  // LONG — open for ~4 hours, resolved now. Same window membership; the
  // longer delta is what the sort control should rank above SHORT.
  const longRes = await pool.query(
    `INSERT INTO ai_alerts
       (alert_type, severity, title, description, suggestion, related_module,
        related_record_id, status, acknowledged_by, resolved_at,
        resolution_note, created_at)
     VALUES
       ('tool_health','critical',$1,
        'E2E seed — long open-for tool-health alert','n/a','ai_ops',
        $2,'resolved',NULL,NOW(),NULL, NOW() - INTERVAL '4 hours')
     RETURNING id`,
    [LONG_TITLE, `e2e:${RUN_ID}:long`],
  );
  longId = Number(longRes.rows[0].id);

  // ACK — acknowledged-only, never resolved. Has no measurable
  // open-for; the dashboard must omit the line entirely (not render
  // "Invalid Date" / a stray testid). Lands in the window via
  // acknowledged_at = NOW().
  const ackRes = await pool.query(
    `INSERT INTO ai_alerts
       (alert_type, severity, title, description, suggestion, related_module,
        related_record_id, status, acknowledged_by, acknowledged_at,
        resolved_at, resolution_note, created_at)
     VALUES
       ('tool_health','critical',$1,
        'E2E seed — acknowledged-only tool-health alert','n/a','ai_ops',
        $2,'acknowledged',$3,NOW(),NULL,NULL, NOW() - INTERVAL '2 hours')
     RETURNING id`,
    [ACK_TITLE, `e2e:${RUN_ID}:ack`, `e2e-operator-${RUN_ID}`],
  );
  ackId = Number(ackRes.rows[0].id);
}

async function cleanupAlerts(): Promise<void> {
  if (!pool) return;
  const ids: number[] = [];
  if (shortId != null) ids.push(shortId);
  if (longId != null) ids.push(longId);
  if (ackId != null) ids.push(ackId);
  if (ids.length > 0) {
    await pool.query(`DELETE FROM ai_alerts WHERE id = ANY($1::bigint[])`, [ids]);
  }
  await pool.query(
    `DELETE FROM ai_alerts WHERE title = ANY($1::text[])`,
    [[SHORT_TITLE, LONG_TITLE, ACK_TITLE]],
  );
  shortId = null;
  longId = null;
  ackId = null;
}

async function authenticateAsAdmin(page: Page): Promise<void> {
  const res = await page.request.post(`${BASE_URL}/api/admin/auth`, {
    data: { key: ADMIN_KEY },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(res.status(), 'admin /api/admin/auth login should succeed').toBe(200);
}

test.describe('Resolved-alerts feed: open-for line and sort control (Task #417)', () => {
  test.beforeAll(async () => {
    if (!ADMIN_KEY || !DATABASE_URL) return;
    // Warm up the schema so the seed doesn't race the lazy table init —
    // same pattern as tests/autoResolvedAlertBadge.spec.ts.
    const apiCtx = await pwRequest.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { 'X-Admin-Key': ADMIN_KEY },
    });
    try {
      const authRes = await apiCtx.post('/api/admin/auth', {
        data: { key: ADMIN_KEY },
        headers: { 'Content-Type': 'application/json' },
      });
      if (authRes.status() !== 200) {
        throw new Error(`/api/admin/auth login returned HTTP ${authRes.status()}`);
      }
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

  test('Resolved rows render the "Open for: …" line; acknowledged-only rows omit it; the sort control re-orders by open-for descending', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }
    if (!DATABASE_URL) {
      test.skip(true, 'DATABASE_URL not set in environment');
      return;
    }

    expect(shortId, 'short open-for seed should have an id').toBeTruthy();
    expect(longId, 'long open-for seed should have an id').toBeTruthy();
    expect(ackId, 'acknowledged-only seed should have an id').toBeTruthy();

    await authenticateAsAdmin(page);

    const historyResPromise = page.waitForResponse(
      r => r.url().includes('/api/ai-ops/tool-health-alerts/history')
        && r.request().method() === 'GET',
      { timeout: 15000 },
    );

    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');

    const historyRes = await historyResPromise;
    expect(historyRes.status(), 'tool-health-alerts/history should succeed').toBe(200);

    const toggle = page.locator('[data-testid="button-tool-health-history-toggle"]');
    await expect(toggle).toBeVisible({ timeout: 10000 });
    await toggle.click();

    const shortCard = page.locator(`[data-testid="card-tool-health-history-${shortId}"]`);
    const longCard = page.locator(`[data-testid="card-tool-health-history-${longId}"]`);
    const ackCard = page.locator(`[data-testid="card-tool-health-history-${ackId}"]`);
    await expect(shortCard, 'short-open-for card should render').toBeVisible({ timeout: 15000 });
    await expect(longCard, 'long-open-for card should render').toBeVisible();
    await expect(ackCard, 'acknowledged-only card should render').toBeVisible();

    // Open-for line renders for both resolved rows. The seed uses
    // Postgres NOW() inside a single INSERT statement for both
    // created_at and resolved_at, and NOW() returns the transaction
    // start time — so the persisted gap is EXACTLY the seeded
    // INTERVAL (5 minutes / 4 hours) regardless of when the page later
    // renders. That lets us assert the exact compact duration string
    // produced by fmtAlertOpenDuration() rather than just its prefix,
    // locking in the format ("5m", "4h") so a future refactor of the
    // helper can't silently change "4h" to "240m" (or back to
    // "Invalid Date") without tripping this spec.
    const shortOpenFor = page.locator(`[data-testid="text-history-open-for-${shortId}"]`);
    const longOpenFor = page.locator(`[data-testid="text-history-open-for-${longId}"]`);
    await expect(shortOpenFor, 'short row should expose the open-for line').toBeVisible();
    await expect(shortOpenFor).toHaveText('Open for: 5m');
    await expect(longOpenFor, 'long row should expose the open-for line').toBeVisible();
    await expect(longOpenFor).toHaveText('Open for: 4h');

    // Acknowledged-only row has no measurable open-for and must omit
    // the line entirely (not render an empty pill or "Invalid Date").
    await expect(
      page.locator(`[data-testid="text-history-open-for-${ackId}"]`),
      'acknowledged-only row should NOT expose an open-for line',
    ).toHaveCount(0);

    // ── Sort control ────────────────────────────────────────────────
    // Default order is most-recently-triaged. Switching to "Open the
    // longest" must place LONG above SHORT in DOM order, regardless of
    // their resolved_at timestamps (both are NOW()).
    const sortSel = page.locator('[data-testid="select-tool-health-history-sort"]');
    await expect(sortSel).toBeVisible();
    await sortSel.selectOption('open-for-desc');

    // The loader re-runs synchronously off the existing in-memory window
    // (no second fetch is required), but await a short visible state to
    // let the DOM update before reading positions.
    await expect(longCard).toBeVisible();
    await expect(shortCard).toBeVisible();

    // Compare DOM positions via bounding boxes — top of LONG must be
    // above top of SHORT after sorting open-for-desc. Using boxes
    // (rather than evaluating sibling indexes) keeps the assertion
    // resilient to any wrapper elements the renderer may introduce.
    const longBox = await longCard.boundingBox();
    const shortBox = await shortCard.boundingBox();
    expect(longBox, 'long card should have a layout box').toBeTruthy();
    expect(shortBox, 'short card should have a layout box').toBeTruthy();
    expect(
      (longBox!.y),
      'after open-for-desc sort, the longer-open card should appear above the shorter-open card',
    ).toBeLessThan(shortBox!.y);
  });
});
