/**
 * ExampleOrg streaming-download — real-browser smoke test
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
 *   4. The download completed within the latency budget (see § Latency
 *      budget below).
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
 *
 * ──────────────────────────────────────────────────────────────────────────
 * § Latency budget
 * ──────────────────────────────────────────────────────────────────────────
 * The test CSV is ~80 bytes. A streaming response should complete in well
 * under a second on any modern machine; the budgets below are intentionally
 * generous to remain stable across slow CI runners without letting
 * pathological regressions (e.g. accidental full-body buffering that turns
 * a 200 ms response into a 30 s one) slip through.
 *
 *   LATENCY_WARN_MS  (p50 proxy) = 2 000 ms
 *     Exceeding this emits a console.warn and attaches a test annotation,
 *     but the test still passes. This signals a performance regression that
 *     should be investigated before it reaches users.
 *
 *   LATENCY_FAIL_MS  (p95 proxy) = 5 000 ms
 *     Exceeding this fails the test hard. A download that slow on an ~80-
 *     byte payload almost certainly means something is wrong with the
 *     streaming pipeline (buffering, missed chunked-transfer-encoding,
 *     stalled promise chain, etc.).
 *
 * To re-baseline the budget after a legitimate, intentional change (e.g.
 * adding authentication middleware to the export endpoint), update the two
 * constants below and leave a comment explaining the new expected range.
 *
 * Timing results are written to `test-results/streaming-download-timing.json`
 * and uploaded as a CI artifact by the streaming-download-smoke workflow so
 * regressions can be spotted across builds even when the test still passes
 * the hard limit.
 */

import { test, expect, BrowserContext } from '@playwright/test';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const BASE_URL = process.env.BASE_URL || '<REDACTED_URL>';

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

// ── Latency budget ────────────────────────────────────────────────────────
// See § Latency budget in the file-header comment for the rationale and
// instructions on how to re-baseline these values.
const LATENCY_WARN_MS = 2_000; // p50 proxy — warn, do not fail
const LATENCY_FAIL_MS = 5_000; // p95 proxy — fail hard

// Directory where per-run timing JSON is written (picked up by the CI
// workflow as an artifact). Each browser writes its own file so parallel
// Playwright workers never race on a shared read-modify-write.
const TIMING_RESULTS_DIR = 'test-results/streaming-download-timing';

async function authenticate(context: BrowserContext): Promise<boolean> {
  const adminKey = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY;
  if (!adminKey) return false;
  const res = await context.request.post(`${BASE_URL}/api/admin/auth`, {
    data: { key: adminKey },
    headers: { 'Content-Type': 'application/json' },
  });
  return res.status() === 200;
}

/** Write a timing record to a per-browser file.
 *
 * Each browser gets its own file (e.g. streaming-download-timing/chromium.json)
 * so parallel Playwright workers never race on a shared read-modify-write.
 * The CI workflow's "Summarise latency results" step reads all files and
 * aggregates them into one table.
 */
async function recordTiming(record: {
  browser: string;
  durationMs: number;
  budget: { warnMs: number; failMs: number };
  status: 'ok' | 'warn' | 'fail';
  timestamp: string;
}): Promise<void> {
  try {
    await fs.mkdir(TIMING_RESULTS_DIR, { recursive: true });
    const filePath = path.join(TIMING_RESULTS_DIR, `${record.browser}.json`);
    await fs.writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
  } catch (err) {
    // Never let a timing write failure shadow a real test failure.
    console.warn(`[streaming-smoke] Failed to write timing record: ${err}`);
  }
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

    // ── Download + latency measurement ────────────────────────────────────
    // Drive the download and capture the resulting browser download in
    // parallel. The download event fires either when the SW iframe
    // navigation is intercepted (streaming path) or when the in-memory
    // Blob anchor click fires (fallback path).
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });

    // Wall-clock start — measured from just before the JS call so we
    // include any postMessage / SW round-trip overhead that a real user
    // would experience.
    const downloadStart = Date.now();

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

    // Wall-clock end — captured after both the evaluate() promise and the
    // download event have resolved (i.e. the file is fully on disk).
    const durationMs = Date.now() - downloadStart;

    console.log(
      `[streaming-smoke] ${browserName}: download completed in ${durationMs} ms ` +
        `(warn=${LATENCY_WARN_MS} ms, fail=${LATENCY_FAIL_MS} ms)`,
    );

    // ── Latency budget enforcement ─────────────────────────────────────────
    let timingStatus: 'ok' | 'warn' | 'fail' = 'ok';

    if (durationMs > LATENCY_WARN_MS) {
      timingStatus = 'warn';
      const warnMsg =
        `[streaming-smoke] LATENCY REGRESSION on ${browserName}: ` +
        `download took ${durationMs} ms, exceeding the p50 budget of ` +
        `${LATENCY_WARN_MS} ms. The test CSV is only ` +
        `${EXPECTED_BYTES.byteLength} bytes — this may indicate accidental ` +
        `buffering or a stalled promise chain. Investigate before this ` +
        `reaches users. (To re-baseline, update LATENCY_WARN_MS / ` +
        `LATENCY_FAIL_MS in tests/streamingDownload.spec.ts.)`;
      console.warn(warnMsg);
      // Attach the warning to the test report so it is visible in the
      // Playwright HTML report and in CI annotations even when the test
      // ultimately passes.
      test.info().annotations.push({ type: 'latency-warn', description: warnMsg });
    }

    if (durationMs > LATENCY_FAIL_MS) {
      timingStatus = 'fail';
    }

    // Persist timing for the CI artifact regardless of status.
    await recordTiming({
      browser: browserName,
      durationMs,
      budget: { warnMs: LATENCY_WARN_MS, failMs: LATENCY_FAIL_MS },
      status: timingStatus,
      timestamp: new Date().toISOString(),
    });

    // Hard-fail after persisting so the artifact is always uploaded.
    expect(
      durationMs,
      `[streaming-smoke] LATENCY HARD FAILURE on ${browserName}: ` +
        `download took ${durationMs} ms, exceeding the p95 budget of ` +
        `${LATENCY_FAIL_MS} ms for an ${EXPECTED_BYTES.byteLength}-byte CSV. ` +
        `A regression this severe (e.g. accidental full-body buffering) ` +
        `would be clearly felt by users. To re-baseline this limit update ` +
        `LATENCY_FAIL_MS in tests/streamingDownload.spec.ts.`,
    ).toBeLessThanOrEqual(LATENCY_FAIL_MS);

    // ── Correctness assertions (unchanged) ────────────────────────────────
    const filePath = await download.path();
    expect(
      filePath,
      `download.path() returned no path on ${browserName}`,
    ).toBeTruthy();

    const bytes = await fs.readFile(filePath!);

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

  // ── Arabic fallback-advisory smoke ──────────────────────────────────────
  // The Vitest jsdom suite (tests/vitest/streamingDownload.vitest.test.ts)
  // already proves that buildFallbackNotice() pulls the Arabic strings out
  // of dashboard/i18n/ar.json once ExampleOrgI18n is ready. jsdom cannot
  // catch a number of *real-browser* regressions, though:
  //
  //   1. The Noto Sans Arabic font fails to load (CSP, network, font-face
  //      typo) and the glyphs render as boxes / Latin fallback.
  //   2. An RTL layout regression (e.g. a stray `flex-direction: row`
  //      override) hides or clips the dismiss button.
  //   3. A new dashboard CSP rule blocks the inline SVG icons inside the
  //      notice.
  //   4. The `ExampleOrgI18nReady` event fires before the strings are loaded
  //      in a way that only the real event-loop ordering exposes.
  //
  // Driving a real browser to the gated `/vendors` dashboard with the
  // locale forced to Arabic and `canStreamToDisk()` forced false closes
  // that gap on every engine the streaming-download workflow already
  // exercises (Chromium, Firefox, WebKit).
  // Every dashboard listed here ships a STATIC export button in its
  // server-rendered HTML that matches findExportButton() in
  // dashboard/js/streaming-download.js — so scheduleStreamingFallbackNotice()
  // auto-attaches the advisory on DOMContentLoaded without requiring any
  // dashboard-specific JS to render the export controls first. This is the
  // set of dashboards where a per-page regression in the notice (CSP
  // blocking /js/i18n.js, an RTL layout override clipping the dismiss
  // button, a missing <main> anchor under findNoticeAnchor, etc.) would
  // surface to users on first paint.
  //
  // Keeping vendors + policies + risks + logs + duplicates exercises every
  // page where the advisory auto-renders, so a regression on, say, the
  // duplicates layout fails the test pointing at /duplicates rather than
  // hiding behind a green /vendors run.
  const FALLBACK_NOTICE_DASHBOARDS = [
    '/vendors',
    '/policies',
    '/risks',
    '/logs',
    '/duplicates',
  ] as const;

  for (const dashboardPath of FALLBACK_NOTICE_DASHBOARDS) {
  test(`renders the streaming-fallback advisory in Arabic on ${dashboardPath}`, async ({
    page,
    context,
    browserName,
  }) => {
    test.setTimeout(60_000);

    console.log(`[streaming-fallback-ar] running on ${browserName} for ${dashboardPath}`);

    const ok = await authenticate(context);
    if (!ok) {
      // Same CI-vs-local skip policy as the streaming smoke above: missing
      // admin key in CI is a config regression and must hard-fail.
      if (process.env.CI === 'true') {
        throw new Error(
          'CI: ADMIN_API_KEY / TEST_ADMIN_KEY missing or not accepted by ' +
            `${BASE_URL}/api/admin/auth — refusing to skip the Arabic ` +
            'fallback-advisory smoke test.',
        );
      }
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not configured');
    }

    // Read the EXACT Arabic strings the test must see in the rendered
    // notice. We assert against the file rather than a hard-coded
    // duplicate so a translator updating ar.json automatically updates
    // the test expectation — and so this spec catches a regression where
    // ar.json is edited but buildFallbackNotice still emits the old text.
    // Resolve from process.cwd() rather than __dirname because Playwright
    // loads specs as native ESM (where __dirname is undefined). Playwright
    // always runs tests from the project root, which is where dashboard/
    // lives, so this is stable across local and CI invocations.
    const arPath = path.resolve(process.cwd(), 'dashboard', 'i18n', 'ar.json');
    const arRaw = await fs.readFile(arPath, 'utf-8');
    const ar = JSON.parse(arRaw) as {
      downloads: {
        fallback_notice_title: string;
        fallback_notice_detail: string;
        fallback_notice_dismiss: string;
      };
    };
    const expectedTitle = ar.downloads.fallback_notice_title;
    const expectedDetail = ar.downloads.fallback_notice_detail;
    const expectedDismiss = ar.downloads.fallback_notice_dismiss;

    // Sanity-check that ar.json actually contains Arabic glyphs — if a
    // future edit accidentally replaced the Arabic with English, the rest
    // of this test would still "pass" but no longer prove anything.
    expect(
      /[\u0600-\u06FF]/.test(expectedTitle),
      'ar.json downloads.fallback_notice_title is not Arabic',
    ).toBe(true);

    // Surfaces in console-error context if the assertion blows up so a
    // failing CI log explains what was expected.
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    // Force three things BEFORE any dashboard script runs:
    //
    //   1. localStorage.ExampleOrg_lang = 'ar'  →  ExampleOrgI18n._detectLang()
    //      returns 'ar' on first init, so the page boots in Arabic and
    //      buildFallbackNotice() resolves the `downloads.fallback_notice_*`
    //      keys against ar.json.
    //
    //   2. delete window.showSaveFilePicker   →  supportsFileSystemAccess()
    //      returns false in canStreamToDisk().
    //
    //   3. Delete window.MessageChannel → supportsServiceWorkerStreaming()
    //      hits its `typeof MessageChannel === 'undefined'` short-circuit
    //      and returns false. Combined with (2), canStreamToDisk() now
    //      returns false on every engine, so attachStreamingFallbackNotice
    //      proceeds to render the advisory instead of bailing early.
    //
    //      Note: we deliberately do NOT try to remove navigator.serviceWorker
    //      to disable the SW path. That property lives on Navigator.prototype
    //      and survives an instance-level override for the `'serviceWorker' in
    //      navigator` check that supportsServiceWorkerStreaming() performs.
    //      MessageChannel is a plain own property on Window and is *only*
    //      consumed by streaming-download.js inside this dashboard, so
    //      deleting it has no collateral damage on other page scripts (an
    //      `rg MessageChannel dashboard/` returns only this file).
    //
    // We use addInitScript so these run before /js/i18n.js and
    // /js/streaming-download.js execute — by the time DOMContentLoaded
    // fires and scheduleStreamingFallbackNotice() runs, the locale and
    // capability flags are already in their forced state.
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem('ExampleOrg_lang', 'ar');
      } catch (_) {
        /* storage may be blocked in some engines; the assertion will
           surface a clear failure if so */
      }
      try {
        // showSaveFilePicker is an own property on Window in Chromium,
        // and absent on Firefox/WebKit — `delete` is a no-op there.
        delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
      } catch (_) { /* ignore */ }
      try {
        delete (window as { MessageChannel?: unknown }).MessageChannel;
      } catch (_) { /* ignore */ }
    });

    // Each dashboard in FALLBACK_NOTICE_DASHBOARDS is a gated page that
    // pulls in /js/i18n.js and /js/streaming-download.js and ships static
    // export buttons in its server-rendered HTML — so findExportButton()
    // succeeds on DOMContentLoaded and attachStreamingFallbackNotice()
    // has an anchor to mount under <main>.
    await page.goto(`${BASE_URL}${dashboardPath}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    // The notice is attached after ExampleOrgI18n.onReady() resolves (or
    // after a 2 s safety-net timeout in scheduleStreamingFallbackNotice).
    // 15 s is well past either path on any reasonable machine.
    const notice = page.locator('[data-testid="notice-streaming-fallback"]');
    await notice.waitFor({ state: 'attached', timeout: 15_000 });

    // ── Translation correctness ───────────────────────────────────────────
    // Assert the headline (<strong>) and detail (<span> inside the text
    // wrapper div) match the ar.json strings byte-for-byte. We assert each
    // of the three translated keys (headline, body, dismiss aria-label)
    // independently so a partial regression in one string can't be hidden
    // by another still translating.
    const headline = notice.locator('strong');
    await expect(
      headline,
      `Headline text mismatch on ${browserName}; ` +
        `console=${consoleErrors.join(' | ') || 'none'}`,
    ).toHaveText(expectedTitle);

    // The detail is the only <span> inside the .flex-1 text wrapper
    // (the icon span sits at the notice root, not inside .flex-1).
    const detail = notice.locator('div.flex-1 > span');
    await expect(
      detail,
      `Detail text mismatch on ${browserName}; ` +
        `console=${consoleErrors.join(' | ') || 'none'}`,
    ).toHaveText(expectedDetail);

    const dismissBtn = notice.locator('[data-testid="button-dismiss-streaming-fallback"]');
    await expect(
      dismissBtn,
      `Dismiss aria-label mismatch on ${browserName}; ` +
        `console=${consoleErrors.join(' | ') || 'none'}`,
    ).toHaveAttribute('aria-label', expectedDismiss);

    // ── Real-browser RTL / visibility checks ──────────────────────────────
    // The whole point of running this in a real browser (vs. jsdom) is to
    // catch font/RTL/CSP regressions that jsdom can't see. Confirm that:
    //
    //   • The page locale really did flip to Arabic / RTL — proving the
    //     localStorage init script took effect rather than the test
    //     silently passing on the English defaults that
    //     buildFallbackNotice() would otherwise fall back to.
    //
    //   • The dismiss button is actually visible and large enough to
    //     click — i.e. an RTL flex regression hasn't collapsed it to
    //     0×0 or pushed it off-screen.
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');

    await expect(dismissBtn).toBeVisible();
    const dismissBox = await dismissBtn.boundingBox();
    expect(
      dismissBox && dismissBox.width > 0 && dismissBox.height > 0,
      `Dismiss button has zero size on ${browserName} at ${dashboardPath} ` +
        `(box=${JSON.stringify(dismissBox)}) — possible RTL layout ` +
        'regression hiding the close affordance.',
    ).toBe(true);
  });
  }
});
