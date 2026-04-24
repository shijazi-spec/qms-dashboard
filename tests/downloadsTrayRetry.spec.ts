/**
 * E2E test for the floating "Recent downloads" tray.
 *
 * Background:
 *   The Vitest suite for `dashboard/js/streaming-download.js` already
 *   exercises the history/retry logic in JSDOM with hand-written fakes,
 *   but no end-to-end test confirms the tray is actually mounted on the
 *   real dashboard pages or that the Retry button ends up re-issuing the
 *   underlying export request through the live UI. If somebody moves the
 *   tray, restyles it, or accidentally drops the `data-testid` hooks the
 *   unit tests would still pass.
 *
 * What this test does:
 *   1. Authenticates as admin via /api/admin/auth (same pattern as the
 *      other dashboard specs in this directory).
 *   2. Opens /risks — one of the six export-bearing dashboards listed in
 *      the task brief — with the tray pre-opened in sessionStorage so its
 *      body renders the moment the first row is recorded.
 *   3. Intercepts /api/risks/export (and the sibling /estimate route) so
 *      the test stays hermetic and doesn't depend on the live exporter:
 *        - First export → 200 with a small known CSV.
 *        - Second export → 500 (forced failure).
 *        - Retry → 200 again.
 *      The handler counts hits on the export endpoint so the assertion
 *      that "Retry re-issues the same request" is concrete, not visual.
 *   4. Triggers the small CSV export via `window.streamDownload` (the
 *      same global the page's `data-on-click="streamDownload"` button
 *      ultimately resolves to) and waits for the tray to appear with a
 *      "Done" status row.
 *   5. Triggers the export again with the route flipped to 500 and waits
 *      for a Failed row with a Retry button to render.
 *   6. Clicks the actual Retry button rendered in the live tray and
 *      asserts the export endpoint was hit a third time with the same
 *      URL the original failed export used.
 *
 *   Driving the first two exports through `streamDownload` (rather than
 *   clicking the page's CSV button) is intentional: it pins the test to
 *   the streaming-download.js entry point that backs every real export
 *   button on every dashboard, while sidestepping a Playwright-specific
 *   race where the click that started the download also captures the
 *   freshly-attached cancel handler. The Retry button — which is what
 *   this task's "Done looks like" really cares about — is still clicked
 *   through the live tray UI, exercising the real DOM hookup.
 *
 * Requirements:
 *   - Dev server running at BASE_URL (default http://localhost:5000),
 *     same convention as tests/streamingDownload.spec.ts.
 *   - ADMIN_API_KEY (or TEST_ADMIN_KEY) must be set so the test can load
 *     the gated /risks page; otherwise the suite is skipped locally and
 *     hard-fails in CI (matching streamingDownload.spec.ts behaviour).
 *
 * Run:
 *   npx playwright test tests/downloadsTrayRetry.spec.ts --reporter=line
 */

import { test, expect, type BrowserContext } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';

// Small but non-trivial CSV — content doesn't matter, only that the
// response is a valid 200 with content-disposition so streaming-download
// records a successful history entry.
const SAMPLE_CSV =
  'id,title,severity\n' +
  '1,risk-one,low\n' +
  '2,risk-two,high\n';
const SAMPLE_BYTES = Buffer.from(SAMPLE_CSV, 'utf-8');

const RISKS_EXPORT_URL = '/api/risks/export';

// Matches /api/risks/export and /api/risks/export-xlsx, with or without
// a trailing /estimate, with or without a query string. The attachSize
// hints scan on /risks fires estimate requests for both export buttons
// at page-load time, so the regex needs to cover the xlsx variant too
// even though we only trigger the CSV export.
const RISKS_EXPORT_ROUTE = /\/api\/risks\/export(?:-xlsx)?(?:\/estimate)?(?:\?.*)?$/;

async function authenticateAsAdmin(context: BrowserContext): Promise<boolean> {
  const key = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY;
  if (!key) return false;
  const res = await context.request.post(`${BASE_URL}/api/admin/auth`, {
    data: { key },
    headers: { 'Content-Type': 'application/json' },
  });
  return res.status() === 200;
}

test.describe('Downloads tray — end-to-end', () => {
  test('renders a Done row on success and re-issues the request via Retry on failure', async ({
    page,
    context,
  }) => {
    test.setTimeout(60_000);

    const authed = await authenticateAsAdmin(context);
    if (!authed) {
      // CI must hard-fail on a missing/invalid admin key — silently
      // skipping would let real tray regressions sail through as a
      // green build. Locally, skipping is convenient when the dev
      // simply hasn't exported the key.
      if (process.env.CI === 'true') {
        throw new Error(
          'CI: ADMIN_API_KEY / TEST_ADMIN_KEY missing or not accepted by ' +
            `${BASE_URL}/api/admin/auth — refusing to skip the tray smoke test.`,
        );
      }
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not configured');
    }

    // Surface page-side errors in the assertion message so a failure has
    // useful context rather than an opaque "locator not visible" timeout.
    // We filter out unrelated console noise (CSP warnings, KPI 401s) at
    // the assertion-message level — they're real on this page but they
    // are not what this test guards against.
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    // Stub the export endpoint so the test stays hermetic and doesn't
    // depend on the live risks exporter. State machine:
    //   - exportCallCount counts only main-export hits (not /estimate).
    //   - exportRequestUrls captures the full URL of each main-export hit
    //     so we can assert the Retry click targeted the same URL.
    //   - nextExportShouldFail flips the next main-export response from
    //     200 + CSV to 500 + JSON error.
    let exportCallCount = 0;
    const exportRequestUrls: string[] = [];
    let nextExportShouldFail = false;

    await context.route(RISKS_EXPORT_ROUTE, async (route) => {
      const reqUrl = new URL(route.request().url());

      if (reqUrl.pathname.endsWith('/estimate')) {
        // streaming-download.js calls /estimate as a best-effort preflight.
        // We don't need to assert on it; just keep it from 404'ing so the
        // test doesn't accidentally exercise the "estimate failed" branch.
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            bytes: SAMPLE_BYTES.byteLength,
            rows: 2,
            format: 'csv',
          }),
        });
        return;
      }

      exportCallCount += 1;
      exportRequestUrls.push(reqUrl.pathname + reqUrl.search);

      if (nextExportShouldFail) {
        await route.fulfill({
          status: 500,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: 'forced-failure' }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="risks.csv"',
          'content-length': String(SAMPLE_BYTES.byteLength),
          'cache-control': 'no-store',
        },
        body: SAMPLE_BYTES,
      });
    });

    // Browsers that reach the in-memory Blob path open via a programmatic
    // anchor click, which Playwright surfaces as a `download` event. We
    // don't assert on the file contents here (streamingDownload.spec.ts
    // already does that); just drain them so they don't pile up.
    page.on('download', (d) => {
      d.cancel().catch(() => { /* ignore */ });
    });

    // Three init-script setups, all done before any page script runs:
    //   - Delete window.showSaveFilePicker so Chromium doesn't go down the
    //     File System Access path (which would prompt a native save dialog
    //     Playwright cannot dismiss).
    //   - Pre-open the tray so its row body is visible without an extra
    //     header click — keeps the assertions focused on the tray content,
    //     not on tray-toggle ergonomics (which are covered by unit tests).
    //   - Clear any leftover history from a previous run in the same
    //     browser context so the row counts in this test are deterministic.
    await context.addInitScript(() => {
      try { delete (window as any).showSaveFilePicker; } catch (_) { /* ignore */ }
      try {
        const ss = (window as any).sessionStorage;
        if (ss) {
          ss.setItem('walaplus.recentDownloads.trayOpen', '1');
          ss.removeItem('walaplus.recentDownloads.v1');
        }
      } catch (_) { /* ignore */ }
    });

    await page.goto(`${BASE_URL}/risks`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    // Wait for streamingDownload() and streamDownload() to mount —
    // they own the tray rendering and the Retry plumbing respectively.
    await page.waitForFunction(
      () =>
        typeof (window as any).streamingDownload === 'function' &&
        typeof (window as any).streamDownload === 'function',
      undefined,
      { timeout: 15_000 },
    );

    // Sanity: the page actually has the CSV export button the production
    // dashboard wires through `data-on-click="streamDownload"`. We don't
    // need to click it — see the file-header note about why we drive the
    // export through `streamDownload()` instead — but its presence is
    // what proves the tray ships next to a real export button on /risks.
    await expect(
      page.locator('[data-testid="button-export-csv"]'),
      'CSV export button is present on /risks',
    ).toBeVisible({ timeout: 10_000 });

    // ── First export → success ────────────────────────────────────────
    await page.evaluate(async (url) => {
      const sd = (window as any).streamDownload as (
        u: string,
        f: string,
        e: Event | null,
      ) => Promise<unknown>;
      try {
        await sd(url, 'risks.csv', null);
      } catch (_) {
        // streamingDownload may reject on cancel; the tray's history
        // entry is what matters here, not the promise outcome.
      }
    }, RISKS_EXPORT_URL);

    const tray = page.locator('[data-testid="tray-recent-downloads"]');
    await expect(
      tray,
      `Recent-downloads tray should mount after the first export ` +
        `(console=${consoleErrors.join(' | ') || 'none'})`,
    ).toBeVisible({ timeout: 15_000 });

    const doneStatusRows = tray.locator(
      '[data-testid^="text-recent-download-status-"]',
      { hasText: /Done/i },
    );
    await expect(
      doneStatusRows.first(),
      `A "Done" row should appear in the tray after a successful export ` +
        `(console=${consoleErrors.join(' | ') || 'none'})`,
    ).toBeVisible({ timeout: 15_000 });

    expect(
      exportCallCount,
      'first export should hit /api/risks/export exactly once',
    ).toBe(1);
    expect(
      exportRequestUrls[0],
      'first export should target /api/risks/export',
    ).toMatch(/^\/api\/risks\/export(\?|$)/);

    // ── Second export → failure ───────────────────────────────────────
    nextExportShouldFail = true;

    await page.evaluate(async (url) => {
      const sd = (window as any).streamDownload as (
        u: string,
        f: string,
        e: Event | null,
      ) => Promise<unknown>;
      try {
        await sd(url, 'risks.csv', null);
      } catch (_) {
        // Expected to reject — the route was flipped to 500 above.
      }
    }, RISKS_EXPORT_URL);

    const retryButton = tray.locator('[data-testid^="button-retry-download-"]').first();
    await expect(
      retryButton,
      `Retry button should appear for the failed download ` +
        `(console=${consoleErrors.join(' | ') || 'none'})`,
    ).toBeVisible({ timeout: 15_000 });

    expect(
      exportCallCount,
      'failed export should still hit /api/risks/export',
    ).toBe(2);

    // ── Retry → re-issues the same request ───────────────────────────
    nextExportShouldFail = false;

    // Capture the URL the failed entry will retry against. The retry
    // handler in streaming-download.js calls streamingDownload(match.url),
    // so the third hit should target the exact same path as the failed
    // request used.
    const expectedRetryPath = exportRequestUrls[1];

    await retryButton.click();

    await expect
      .poll(
        () => exportCallCount,
        {
          message:
            'Clicking Retry should re-issue the export request to the live API ' +
            `(console=${consoleErrors.join(' | ') || 'none'})`,
          timeout: 15_000,
        },
      )
      .toBe(3);

    expect(
      exportRequestUrls[2],
      'Retry should hit the same URL the original failed export used',
    ).toBe(expectedRetryPath);

    // After retry succeeds, the tray should grow another "Done" row on
    // top of the original one — proving the retry path also goes through
    // the same recordHistoryEntry plumbing as a fresh trigger.
    await expect
      .poll(
        () => doneStatusRows.count(),
        {
          message: 'Retry should append a fresh Done row to the tray',
          timeout: 15_000,
        },
      )
      .toBeGreaterThanOrEqual(2);
  });
});
