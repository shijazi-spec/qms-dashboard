/**
 * E2E lock-down for the post-restore sweep alerts panel on /logs
 * (dashboard/logs.html). Companion to Task #657.
 *
 * Background:
 *   The post-restore sweep alerts card is the on-call investigation entry
 *   point fired after every boot redaction sweep. Until now it was only
 *   covered by the one-off Playwright run executed during the original
 *   implementation (Task #556). A regression in any of:
 *     * dashboard/logs.html (markup, badge wiring, deep-link handler,
 *       loadPostRestoreAlerts() / viewPostRestoreSweepEventLog()),
 *     * the safe-actions.js data-on-click delegation,
 *     * the module filter dropdown <option value="security/redaction-sweep">,
 *     * GET /api/admin/redaction-sweep/alerts in src/mastra/routes/adminApiRoutes.ts,
 *   could silently break the flow with no test failure. This spec locks
 *   down the contract end-to-end against the running dev server so a
 *   future PR that breaks any of those layers fails CI immediately.
 *
 * What this spec does:
 *   1. Authenticates as admin (POST /api/admin/auth) and pins X-Admin-Key
 *      on every browser request — same pattern as
 *      tests/aiMetricsRetentionDashboard.spec.ts and tests/aiOpsTabs.spec.ts.
 *   2. Seeds one notification fixture in the `notifications` table tagged
 *      with a per-run id so the assertions can locate it unambiguously
 *      even when ambient sweep alerts already exist; also seeds an
 *      event_logs row with module='security/redaction-sweep' /
 *      entity_id='boot_redaction_sweep' whose timestamp matches the
 *      notification's so the deep-link's "closest by timestamp" logic
 *      lands on our row deterministically.
 *   3. Asserts the panel:
 *      - renders with a badge whose count is ≥ 1 and label is "alerts" or
 *        "alert" (NOT the empty-state "No alerts"),
 *      - lists our seeded row with the seeded title,
 *      - "View event log" deep-links: filterModule becomes
 *        security/redaction-sweep AND the matching event_logs row is
 *        auto-expanded (`details-<id>` no longer has the `hidden` class).
 *   4. Asserts the empty / forbidden / error states render the right text
 *      by intercepting the alerts request with page.route() so the panel
 *      sees each shape without us having to flip the database state or
 *      drop the admin cookie mid-page.
 *   5. Cleans up: deletes both the seeded notification AND the seeded
 *      event_logs row by the per-run identifier so re-runs and ambient
 *      dev usage are unaffected.
 *
 * Requirements:
 *   - Dev server must be running at BASE_URL (default <REDACTED_URL>
 *     — same convention as the other Playwright specs in this repo.
 *   - ADMIN_API_KEY must be set on the server AND in the test process
 *     (via <REDACTED_SECRET> or ADMIN_API_KEY) so /api/admin/auth and
 *     X-Admin-Key requests succeed; otherwise the suite is skipped.
 *   - DATABASE_URL must be set so the test can seed and clean up its own
 *     fixtures. The same dev DB is used by the running server.
 *
 * Run:
 *   npx playwright test tests/postRestoreSweepPanel.spec.ts --reporter=line
 */

import { test, expect, request as pwRequest } from '@playwright/test';
import pg from 'pg';
import crypto from 'crypto';

const BASE_URL = process.env.BASE_URL || '<REDACTED_URL>';
const ADMIN_KEY = process.env.ADMIN_API_KEY || process.env.<REDACTED_SECRET> || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';

// Signed session cookie so the browser can authenticate against
// application-level routes (e.g. GET /api/logs) that now require a real OIDC
// session rather than an X-Admin-Key header.  X-Admin-Key is still used by
// apiCtx for /api/admin/* routes, which remain key-accessible.
const E2E_SESSION_EMAIL = '<REDACTED_EMAIL>';

function signE2ESession(): string {
  if (!SESSION_SECRET) return '';
  const payload = {
    userId: 0,
    email: E2E_SESSION_EMAIL,
    name: 'E2E Test Admin',
    role: 'admin',
    exp: Date.now() + 86_400_000,
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

const E2E_SESSION_TOKEN = signE2ESession();
const E2E_SESSION_COOKIE = E2E_SESSION_TOKEN
  ? `ExampleOrg_session=${encodeURIComponent(E2E_SESSION_TOKEN)}`
  : '';

const ALERTS_PATH = '/api/admin/redaction-sweep/alerts';
const SWEEP_MODULE = 'security/redaction-sweep';
const SWEEP_ENTITY_ID = 'boot_redaction_sweep';

// Per-run identifier so the seeded notification + event_log can be located
// (and cleaned up) unambiguously even when ambient sweep rows already exist
// in the dev DB. Mirrors the pattern in tests/aiMetricsRetentionDashboard.spec.ts.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SEEDED_TITLE = `Task #657 e2e — ${RUN_ID}`;
const SEEDED_MESSAGE = `Synthetic post-restore sweep alert seeded by tests/postRestoreSweepPanel.spec.ts run ${RUN_ID}`;
const SEEDED_EVENT_DESCRIPTION = `Task #657 e2e seeded sweep event_log — ${RUN_ID}`;

let apiCtx: Awaited<ReturnType<typeof pwRequest.newContext>>;
let pool: pg.Pool | null = null;
let seededNotificationId: number | null = null;
let seededEventLogId: number | null = null;

function shouldSkip(): boolean {
  return !ADMIN_KEY || !DATABASE_URL;
}

async function ensureNotificationsTableInitialized(): Promise<void> {
  // The GET /api/admin/redaction-sweep/alerts handler calls
  // initNotificationTables() lazily, so issuing one request guarantees
  // the table exists before our INSERT runs (avoids racing the
  // CREATE TABLE IF NOT EXISTS with our INSERT in a fresh DB).
  const res = await apiCtx.get(`${ALERTS_PATH}?limit=1`);
  expect(
    res.status(),
    `GET ${ALERTS_PATH} (table-init probe) should return 200 — got ${res.status()}`,
  ).toBe(200);
}

async function seedFixtures(): Promise<void> {
  if (!pool) throw new Error('pg pool not initialized');
  // Insert event_log first so the dashboard's deep-link finds a row whose
  // timestamp is within the ±1-day window the panel sets around the alert.
  // Both rows use NOW() so the per-row timestamp delta is < a few ms.
  const evRes = await pool.query(
    `INSERT INTO event_logs (
       action_type, entity_type, entity_id, entity_name,
       description, severity, module, ai_involved
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      'UPDATE',
      'SYSTEM',
      SWEEP_ENTITY_ID,
      'Boot-time secret-redaction sweep',
      SEEDED_EVENT_DESCRIPTION,
      'INFO',
      SWEEP_MODULE,
      false,
    ],
  );
  seededEventLogId = evRes.rows[0].id;

  const notifRes = await pool.query(
    `INSERT INTO notifications (
       title, message, module, priority, channel, status,
       related_entity_type, related_entity_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      SEEDED_TITLE,
      SEEDED_MESSAGE,
      SWEEP_MODULE,
      'critical',
      'in_app',
      'unread',
      'SYSTEM',
      SWEEP_ENTITY_ID,
    ],
  );
  seededNotificationId = notifRes.rows[0].id;
}

async function cleanupFixtures(): Promise<void> {
  if (!pool) return;
  try {
    if (seededNotificationId != null) {
      await pool.query(`DELETE FROM notifications WHERE id = $1`, [seededNotificationId]);
    } else {
      // Best-effort fallback: clean by tagged title in case the INSERT
      // succeeded but we lost the id (e.g. test crashed before assignment).
      await pool.query(`DELETE FROM notifications WHERE title = $1`, [SEEDED_TITLE]);
    }
    if (seededEventLogId != null) {
      await pool.query(`DELETE FROM event_logs WHERE id = $1`, [seededEventLogId]);
    } else {
      await pool.query(`DELETE FROM event_logs WHERE description = $1`, [SEEDED_EVENT_DESCRIPTION]);
    }
  } catch (err) {
    // Don't mask the test result with a teardown failure — log and move on.
    // The per-run RUN_ID makes leftover rows easy to identify if they ever
    // pile up.
    console.warn('[postRestoreSweepPanel] cleanup error:', err);
  }
}

test.describe('Post-restore sweep alerts panel — /logs (Task #657)', () => {
  test.beforeAll(async () => {
    if (shouldSkip()) return;
    apiCtx = await pwRequest.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { 'X-Admin-Key': ADMIN_KEY },
    });
    // Task #831 removed the browser admin_key cookie path. Authentication
    // is now header-only via X-Admin-Key, which apiCtx already carries on
    // every subsequent request, so calling POST /api/admin/auth here would
    // do nothing useful and only burn a quota slot in the
    // /api/admin/auth rate limiter (5 attempts / minute) — which causes
    // intermittent HTTP 429 failures when this workflow restarts back-to-back.

    pool = new pg.Pool({ connectionString: DATABASE_URL });
    // Seed a platform_users row for the E2E session email so requireRole()
    // and enforceRoutePermission() can verify the user on /api/logs calls.
    if (E2E_SESSION_COOKIE) {
      await pool.query(
        `INSERT INTO platform_users (email, full_name, role, status)
         VALUES ($1, 'E2E Test Admin', 'admin', 'active')
         ON CONFLICT (email) DO UPDATE SET role = 'admin', status = 'active'`,
        [E2E_SESSION_EMAIL],
      );
    }
    await ensureNotificationsTableInitialized();
    await seedFixtures();
  });

  test.afterAll(async () => {
    try {
      await cleanupFixtures();
      // Remove the E2E platform_users row seeded for session auth.
      if (pool && E2E_SESSION_COOKIE) {
        await pool.query(`DELETE FROM platform_users WHERE email = $1`, [E2E_SESSION_EMAIL]);
      }
    } finally {
      if (pool) await pool.end();
      pool = null;
      if (apiCtx) await apiCtx.dispose();
    }
  });

  // Pin auth on every browser request:
  //   - X-Admin-Key for /api/admin/* routes (redaction-sweep alerts panel)
  //   - ExampleOrg_session cookie for application routes like GET /api/logs
  //     which now require a real session rather than an admin key.
  test.use({
    extraHTTPHeaders: {
      ...(ADMIN_KEY ? { 'X-Admin-Key': ADMIN_KEY } : {}),
      ...(E2E_SESSION_COOKIE ? { Cookie: E2E_SESSION_COOKIE } : {}),
    },
  });

  test('Panel renders with the correct badge count and lists the seeded alert', async ({ page }) => {
    if (shouldSkip()) {
      test.skip(true, 'ADMIN_API_KEY / DATABASE_URL not set in environment');
      return;
    }

    // Capture the alerts response via a persistent listener (more
    // tolerant under load than a single waitForResponse race). The
    // listener is attached BEFORE goto so we never miss the request.
    let capturedAlertsBody: { total: number; notifications: unknown[] } | null = null;
    const captureAlerts = async (resp: import('@playwright/test').Response) => {
      try {
        if (resp.url().includes(ALERTS_PATH) && resp.request().method() === 'GET' && resp.status() === 200) {
          capturedAlertsBody = await resp.json();
        }
      } catch {
        // ignore: response may have been navigated away from
      }
    };
    page.on('response', captureAlerts);

    try {
      await page.goto(`${BASE_URL}/logs`);

      // Card itself is always present in the markup. The badge starts at
      // "Loading..." — wait for the renderer to flip it to a non-loading
      // state, then assert the alert-count branch (NOT the empty-state).
      await expect(page.locator('[data-testid="card-post-restore-alerts"]')).toBeVisible();
      const badge = page.locator('[data-testid="status-post-restore-alerts"]');
      await expect(badge).not.toHaveText('Loading...', { timeout: 30000 });
      await expect(badge).toHaveText(/^\d+ alerts?$/);

      // The badge text must agree with the API `total` the page received
      // (not just *some* number) — locks down off-by-one / wrong-key /
      // stale-cache regressions in the renderer.
      await expect
        .poll(() => capturedAlertsBody?.total, {
          message: 'GET /api/admin/redaction-sweep/alerts should be observed',
          timeout: 15000,
        })
        .toBeGreaterThanOrEqual(1);
      const alertsBody = capturedAlertsBody!;
      expect(Array.isArray(alertsBody.notifications), 'response.notifications should be an array').toBe(true);
      const expectedBadge = `${alertsBody.total} ${alertsBody.total === 1 ? 'alert' : 'alerts'}`;
      await expect(badge).toHaveText(expectedBadge);

      // The seeded row must be in the table — its row id is the
      // notification's serial id.
      expect(seededNotificationId, 'seeded notification id should be set').not.toBeNull();
      const seededRow = page.locator(`[data-testid="row-post-restore-alert-${seededNotificationId}"]`);
      await expect(seededRow, 'seeded notification row should render in the panel').toBeVisible();
      await expect(
        page.locator(`[data-testid="text-post-restore-alert-title-${seededNotificationId}"]`),
      ).toHaveText(SEEDED_TITLE);
      await expect(
        page.locator(`[data-testid="badge-post-restore-alert-priority-${seededNotificationId}"]`),
      ).toHaveText('CRITICAL');
      await expect(
        page.locator(`[data-testid="badge-post-restore-alert-status-${seededNotificationId}"]`),
      ).toHaveText('unread');

      // Hint paragraph should reference the contract documented in the panel:
      // module=security/redaction-sweep, entity_id=boot_redaction_sweep.
      const hint = page.locator('[data-testid="text-post-restore-alerts-hint"]');
      await expect(hint).toBeVisible();
      await expect(hint).toContainText('module=security/redaction-sweep');
      await expect(hint).toContainText('entity_id=boot_redaction_sweep');
    } finally {
      page.off('response', captureAlerts);
    }
  });

  test('"View event log" deep-link sets the module filter and auto-expands a matching event_logs row', async ({ page }) => {
    if (shouldSkip()) {
      test.skip(true, 'ADMIN_API_KEY / DATABASE_URL not set in environment');
      return;
    }

    await page.goto(`${BASE_URL}/logs`);
    // Wait for the seeded row's button to be wired up (safe-actions.js
    // attaches its delegated click listener after DOM ready).
    const viewBtn = page.locator(`[data-testid="button-view-event-log-${seededNotificationId}"]`);
    await expect(viewBtn).toBeVisible({ timeout: 10000 });

    // The deep-link triggers loadLogs() → GET /api/logs with
    // module=security/redaction-sweep. Capture the request to assert the
    // filter actually made it onto the wire — that's the regression
    // class this spec is here to catch.
    const logsGetPromise = page.waitForResponse(
      (r) => {
        if (r.request().method() !== 'GET') return false;
        const u = new URL(r.url());
        if (!u.pathname.endsWith('/api/logs')) return false;
        return u.searchParams.get('module') === SWEEP_MODULE;
      },
      { timeout: 15000 },
    );
    await viewBtn.click();
    const logsRes = await logsGetPromise;
    expect(logsRes.status(), 'deep-link logs fetch should succeed').toBe(200);

    // Module filter dropdown must reflect the selection — proves the
    // handler actually mutated the form, not just the URL.
    await expect(page.locator('#filterModule')).toHaveValue(SWEEP_MODULE);

    // The seeded event_log should be in the rendered table AND its
    // details row should be auto-expanded (`hidden` class removed) by
    // viewPostRestoreSweepEventLog()'s closest-timestamp matcher.
    expect(seededEventLogId, 'seeded event_log id should be set').not.toBeNull();
    const detailsRow = page.locator(`#details-${seededEventLogId}`);
    await expect(detailsRow, 'seeded event_logs row should be present in the table').toHaveCount(1);
    await expect(detailsRow, 'auto-expand should remove the `hidden` class on the details row').not.toHaveClass(/(?:^|\s)hidden(?:\s|$)/);
  });

  test('Empty state renders the documented copy when no alerts exist', async ({ page }) => {
    if (shouldSkip()) {
      test.skip(true, 'ADMIN_API_KEY / DATABASE_URL not set in environment');
      return;
    }

    // Mock the alerts response to an empty list rather than deleting the
    // seeded fixture mid-suite — keeps the other specs in the file
    // independent of test ordering.
    await page.route(`**${ALERTS_PATH}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          notifications: [],
          total: 0,
          module: SWEEP_MODULE,
          related_entity_id: SWEEP_ENTITY_ID,
        }),
      });
    });

    await page.goto(`${BASE_URL}/logs`);
    const empty = page.locator('[data-testid="text-post-restore-alerts-empty"]');
    await expect(empty, 'empty-state copy should be visible').toBeVisible({ timeout: 10000 });
    await expect(empty).toContainText('No post-restore sweep alerts have been recorded');
    const badge = page.locator('[data-testid="status-post-restore-alerts"]');
    await expect(badge).toHaveText('No alerts');
  });

  test('Forbidden state renders the admin-only copy when the alerts API returns 403', async ({ page }) => {
    if (shouldSkip()) {
      test.skip(true, 'ADMIN_API_KEY / DATABASE_URL not set in environment');
      return;
    }

    // Simulate the no-admin-key path WITHOUT actually unsetting the
    // page-level admin cookie (which would also lock us out of the /logs
    // page itself). The panel only looks at the alerts response status,
    // so a route-level mock of 403 is the authoritative way to exercise
    // the forbidden branch in isolation.
    await page.route(`**${ALERTS_PATH}**`, async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Insufficient permissions' }),
      });
    });

    await page.goto(`${BASE_URL}/logs`);
    const forbidden = page.locator('[data-testid="text-post-restore-alerts-forbidden"]');
    await expect(forbidden, 'forbidden-state copy should be visible').toBeVisible({ timeout: 10000 });
    await expect(forbidden).toContainText('Sign in as an administrator');
    const badge = page.locator('[data-testid="status-post-restore-alerts"]');
    await expect(badge).toHaveText('Admin only');
  });

  test('Error state renders the unavailable copy when the alerts API 500s', async ({ page }) => {
    if (shouldSkip()) {
      test.skip(true, 'ADMIN_API_KEY / DATABASE_URL not set in environment');
      return;
    }

    await page.route(`**${ALERTS_PATH}**`, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Failed to fetch post-restore sweep alerts' }),
      });
    });

    await page.goto(`${BASE_URL}/logs`);
    const errorMsg = page.locator('[data-testid="text-post-restore-alerts-error"]');
    await expect(errorMsg, 'error-state copy should be visible').toBeVisible({ timeout: 10000 });
    await expect(errorMsg).toContainText('Could not load post-restore sweep alerts');
    const badge = page.locator('[data-testid="status-post-restore-alerts"]');
    await expect(badge).toHaveText('Unavailable');
  });
});
