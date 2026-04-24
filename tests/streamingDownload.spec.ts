/**
 * WalaPlus streaming-download — real-browser smoke test
 *
 * The Vitest suite for `dashboard/js/streaming-download.js` runs in jsdom
 * with hand-written fakes for the File System Access API, the service
 * worker, and transferable `ReadableStream`. That covers the JavaScript
 * control flow but cannot catch real-browser regressions — for example, if
 * Firefox or Safari ships a change that breaks transferable
 * `ReadableStream` over `postMessage`, or if the dashboard CSP starts
 * blocking the SW iframe trigger, the unit tests will still pass.
 *
 * This spec exports a small, byte-for-byte known CSV through the live
 * dashboard's `streamingDownload(url, …)` flow in each Playwright browser
 * engine (Chromium, Firefox, WebKit) and asserts:
 *
 *   1. The browser actually fired a `download` event.
 *   2. The downloaded file matches the expected bytes exactly.
 *   3. `result.streamedToDisk === true`, proving a true streaming path
 *      (service worker / FSA) was selected and we did not silently fall
 *      back to the in-memory Blob path.
 *
 * To force the SW path on every engine (including Chromium, which would
 * normally pick the File System Access API and prompt a save dialog that
 * Playwright cannot dismiss), the test deletes `window.showSaveFilePicker`
 * before invoking `streamingDownload` and passes `streamToDisk: 'always'`.
 *
 * Authentication: uses `/api/admin/auth` with `ADMIN_API_KEY` (or
 * `TEST_ADMIN_KEY`) to load the gated `/vendors` page, which already loads
 * `streaming-download.js` and the SW. The export URL itself is intercepted
 * via Playwright's `context.route` and replied with a fixed CSV — the test
 * exercises the *frontend* streaming path, not any specific export
 * endpoint, so it remains stable as backend exports evolve.
 */

import { test, expect, BrowserContext } from '@playwright/test';
import { promises as fs } from 'node:fs';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';

// Pick a URL pattern that is namespaced under /api/ so it sits behind the
// same security middleware as a real export, but isn't tied to any real
// backend route — Playwright's context.route() always wins.
const TEST_EXPORT_PATH = '/api/vendors/export?__streaming_smoke=1';

// Small but non-trivial CSV. Includes a UTF-8 multibyte character so we
// can also catch byte-vs-character regressions in the streaming pipeline.
const EXPECTED_CSV =
  'id,name,score,note\n' +
  '1,Vendor A,98,"all-good"\n' +
  '2,Vendor B,76,"needs-review"\n' +
  '3,Vendor C,55,"flagged — escalate"\n';

const EXPECTED_BYTES = Buffer.from(EXPECTED_CSV, 'utf-8');

async function authenticate(context: BrowserContext): Promise<boolean> {
  const adminKey = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY;
  if (!adminKey) return false;
  const res = await context.request.post(`${BASE_URL}/api/admin/auth`, {
    data: { key: adminKey },
    headers: { 'Content-Type': 'application/json' },
  });
  return res.status() === 200;
}

test.describe('streamingDownload — cross-browser smoke', () => {
  test('downloads a small CSV byte-for-byte via the streaming path', async ({
    page,
    context,
    browserName,
  }) => {
    test.setTimeout(60_000);

    // Surfaces in CI logs so triagers can confirm at a glance that all
    // three engines actually executed (vs. a project being silently filtered
    // out by a config typo).
    console.log(`[streaming-smoke] running on ${browserName}`);

    const ok = await authenticate(context);
    if (!ok) {
      // In CI a missing/invalid admin key is a configuration regression and
      // must hard-fail — silently skipping would let real engine breakage
      // sail through as a green build. Locally (no CI=true), skipping is
      // still convenient when the dev simply hasn't exported the key.
      if (process.env.CI === 'true') {
        throw new Error(
          'CI: ADMIN_API_KEY / TEST_ADMIN_KEY missing or not accepted by ' +
            `${BASE_URL}/api/admin/auth — refusing to skip the smoke test.`,
        );
      }
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not configured');
    }

    // Capture page console errors so a failed assertion has useful context.
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    // Intercept *only* the export URL with a known small CSV. We do NOT
    // intercept /_stream-download/* — that path is owned by the streaming
    // service worker and must reach it to exercise the SW response path.
    await context.route(TEST_EXPORT_PATH, async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="streaming-smoke.csv"',
          'content-length': String(EXPECTED_BYTES.byteLength),
          'cache-control': 'no-store',
        },
        body: EXPECTED_BYTES,
      });
    });

    // Load a real, same-origin dashboard page that already pulls in
    // streaming-download.js and the streaming SW. /vendors is one of the
    // six export-bearing dashboards listed in the task brief.
    await page.goto(`${BASE_URL}/vendors`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    // Wait for the global streamingDownload() helper to mount.
    await page.waitForFunction(
      () => typeof (window as any).streamingDownload === 'function',
      undefined,
      { timeout: 15_000 },
    );

    // Drive the download and capture the resulting browser download in
    // parallel. The download event fires either when the SW iframe
    // navigation is intercepted (streaming path) or when the in-memory
    // Blob anchor click fires (fallback path).
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });

    const result = await page.evaluate(async (url: string) => {
      // Force the service-worker streaming path on every engine:
      //   • Delete window.showSaveFilePicker so the FSA path is skipped on
      //     Chromium (otherwise it would prompt a save-as dialog Playwright
      //     cannot dismiss).
      //   • streamToDisk: 'always' makes shouldStreamToDisk() return true
      //     even for a tiny CSV that would normally use the Blob shortcut.
      //   • useServiceWorker is the default but pinned for clarity.
      try { delete (window as any).showSaveFilePicker; } catch (_) { /* ignore */ }
      const sd = (window as any).streamingDownload as (
        u: string,
        o?: any,
      ) => Promise<any>;
      return await sd(url, {
        streamToDisk: 'always',
        useServiceWorker: true,
        skipEstimate: true,
      });
    }, TEST_EXPORT_PATH);

    const download = await downloadPromise;
    const path = await download.path();
    expect(
      path,
      `download.path() returned no path on ${browserName}`,
    ).toBeTruthy();

    const bytes = await fs.readFile(path!);

    expect(
      bytes.byteLength,
      `Downloaded byte length mismatch on ${browserName} ` +
        `(expected ${EXPECTED_BYTES.byteLength}, got ${bytes.byteLength}; ` +
        `streamedToDisk=${result?.streamedToDisk}; bytes-reported=${result?.bytes}; ` +
        `console=${consoleErrors.join(' | ') || 'none'})`,
    ).toBe(EXPECTED_BYTES.byteLength);

    expect(
      bytes.equals(EXPECTED_BYTES),
      `Downloaded CSV content mismatch on ${browserName} ` +
        `(streamedToDisk=${result?.streamedToDisk}; ` +
        `console=${consoleErrors.join(' | ') || 'none'})\n` +
        `--- expected ---\n${EXPECTED_CSV}\n--- got ---\n${bytes.toString('utf-8')}`,
    ).toBe(true);

    expect(result?.bytes, `result.bytes mismatch on ${browserName}`).toBe(
      EXPECTED_BYTES.byteLength,
    );

    // The headline regression we want to catch: silent fallback to the
    // in-memory Blob path because transferable ReadableStream over
    // postMessage broke in this engine, the SW failed to register, or the
    // dashboard CSP now blocks the SW iframe trigger. Any of those would
    // flip `streamedToDisk` to `false`. Pre-existing CSP issues on the
    // dashboard page itself are covered by tests/csp.spec.ts and are
    // intentionally not re-asserted here.
    expect(
      result?.streamedToDisk,
      `Expected streaming path (SW or FSA) to be used on ${browserName}; ` +
        `fell back to in-memory Blob — transferable ReadableStream over ` +
        `postMessage may have regressed, the SW may have failed to register, ` +
        `or the dashboard CSP may now block the SW iframe trigger.\n` +
        `console=${consoleErrors.join(' | ') || 'none'}`,
    ).toBe(true);
  });
});
