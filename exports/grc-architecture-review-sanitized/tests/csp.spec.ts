/**
 * ExampleOrg CSP / Inline-Style E2E Tests
 *
 * Verifies:
 *   1. The top dashboard pages render with zero Content Security Policy
 *      violations reported in the browser console (`page.on('console')`)
 *      and zero uncaught page errors (`page.on('pageerror')`).
 *   2. The CSP header is present, includes a `style-src` nonce, and does
 *      NOT include `'unsafe-inline'` for `style-src` — guarding against
 *      regressions of the recent CSP tightening.
 *   3. The AI Consultant widget mounts on a page that loads it, the
 *      dynamic `<style>` block injected by `dashboard/js/ai-consultant-widget.js`
 *      carries the page nonce, opening the widget triggers no CSP
 *      violations, and the script-injected `<style>` actually applies
 *      (computed background-color is the gradient-styled launcher button).
 *
 * Authentication:
 *   These tests authenticate via `/api/admin/auth` using the `ADMIN_API_KEY`
 *   environment variable (or `TEST_ADMIN_KEY` if set). All authenticated
 *   tests are skipped when neither is available.
 *
 * Run:
 *   npx playwright test tests/csp.spec.ts --reporter=line
 *
 * The dev server (<REDACTED_URL> must be running before tests execute.
 */

import { test, expect, Page, BrowserContext, Request } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || '<REDACTED_URL>';

const DASHBOARD_PAGES: Array<{ path: string; label: string }> = [
  { path: '/dashboard', label: 'Dashboard (index alias)' },
  { path: '/index.html', label: 'Index HTML' },
  { path: '/sop', label: 'Standard Operating Procedure' },
  { path: '/risks', label: 'Risks' },
  { path: '/projects', label: 'Projects' },
  { path: '/grc', label: 'GRC Control Tower' },
  { path: '/consultant', label: 'AI Consultant' },
];

const CSP_PATTERNS: RegExp[] = [
  /Content Security Policy/i,
  /Refused to (apply|execute|load)/i,
  /violates the following Content Security Policy/i,
  /unsafe-inline/i,
];

function isCspMessage(text: string): boolean {
  if (!text) return false;
  return CSP_PATTERNS.some((p) => p.test(text));
}

interface CspCapture {
  consoleViolations: string[];
  pageErrors: string[];
  securityPolicyEvents: string[];
}

/**
 * Attach console / pageerror / securitypolicyviolation listeners BEFORE
 * navigation so we don't miss any CSP messages emitted during initial load.
 *
 * The page-level `securitypolicyviolation` DOM event is mirrored into the
 * console via an init script so we can assert against a single source.
 */
function captureCsp(page: Page): CspCapture {
  const capture: CspCapture = {
    consoleViolations: [],
    pageErrors: [],
    securityPolicyEvents: [],
  };

  page.on('console', (msg) => {
    const text = msg.text();
    if (isCspMessage(text)) {
      capture.consoleViolations.push(`[${msg.type()}] ${text}`);
    }
    // Also capture the bridged securitypolicyviolation events
    if (text.startsWith('__CSP_VIOLATION__')) {
      capture.securityPolicyEvents.push(text.replace('__CSP_VIOLATION__ ', ''));
    }
  });

  page.on('pageerror', (err) => {
    const message = err && err.message ? err.message : String(err);
    if (isCspMessage(message)) {
      capture.pageErrors.push(message);
    }
  });

  return capture;
}

async function installCspBridge(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e: Event) => {
      const ev = e as SecurityPolicyViolationEvent;
      try {
        const summary = JSON.stringify({
          directive: ev.violatedDirective,
          blockedURI: ev.blockedURI,
          source: ev.sourceFile,
          line: ev.lineNumber,
          sample: ev.sample,
        });
        console.error(`__CSP_VIOLATION__ ${summary}`);
      } catch (_) {
        // Best-effort bridge; ignore failures.
      }
    });
  });
}

async function authenticate(context: BrowserContext): Promise<boolean> {
  const adminKey = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY;
  if (!adminKey) return false;
  const res = await context.request.post(`${BASE_URL}/api/admin/auth`, {
    data: { key: adminKey },
    headers: { 'Content-Type': 'application/json' },
  });
  return res.status() === 200;
}

test.describe('CSP — dashboard pages have no inline-style violations', () => {
  for (const { path, label } of DASHBOARD_PAGES) {
    test(`${label} (${path}) loads with zero CSP violations`, async ({ page, context }) => {
      const ok = await authenticate(context);
      if (!ok) {
        test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not configured');
        return;
      }
      await installCspBridge(context);

      const capture = captureCsp(page);

      // Capture the response so we can also assert on the CSP header.
      const responsePromise = page.waitForResponse(
        (resp) => resp.url() === `${BASE_URL}${path}` || resp.url().endsWith(path),
        { timeout: 15000 },
      ).catch(() => null);

      await page.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle', timeout: 20000 });
      const response = await responsePromise;

      // Header sanity: style-src must be nonce-based, not unsafe-inline.
      if (response) {
        const csp = response.headers()['content-security-policy'] || '';
        expect(csp.length, `CSP header missing on ${path}`).toBeGreaterThan(0);
        // style-src directive should NOT contain 'unsafe-inline'
        const styleSrcMatch = csp.match(/style-src([^;]*)/i);
        expect(styleSrcMatch, `style-src directive missing on ${path}`).not.toBeNull();
        const styleSrc = (styleSrcMatch && styleSrcMatch[1]) || '';
        expect(
          styleSrc.includes("'unsafe-inline'"),
          `style-src on ${path} regressed to include 'unsafe-inline': ${styleSrc.trim()}`,
        ).toBe(false);
        expect(
          /'nonce-[^']+'/.test(styleSrc),
          `style-src on ${path} is missing a nonce: ${styleSrc.trim()}`,
        ).toBe(true);
      }

      // Give any deferred scripts (a11y.js, navigation.js, widget) a beat to settle.
      await page.waitForTimeout(750);

      const allViolations = [
        ...capture.consoleViolations,
        ...capture.pageErrors,
        ...capture.securityPolicyEvents,
      ];

      expect(
        allViolations,
        `Expected no CSP violations on ${path}, got:\n${allViolations.join('\n')}`,
      ).toEqual([]);
    });
  }
});

test.describe('CSP — AI Consultant widget honors the page nonce', () => {
  test('widget script-injected <style> block carries the nonce and opens cleanly', async ({
    page,
    context,
  }) => {
    const ok = await authenticate(context);
    if (!ok) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not configured');
      return;
    }
    await installCspBridge(context);

    const capture = captureCsp(page);

    // /sop is one of the lightweight pages that loads the AI consultant widget.
    await page.goto(`${BASE_URL}/sop`, { waitUntil: 'networkidle', timeout: 20000 });

    // Wait for the widget script to mount the launcher button.
    await page.waitForSelector('#ai-widget-btn', { timeout: 10000 });

    // The widget injects its CSS via document.head.appendChild(style). The
    // script reads `document.currentScript.nonce` and copies it onto the
    // <style> element. We verify the style tag exists in <head> AND that it
    // carries a non-empty nonce attribute.
    const widgetStyleInfo = await page.evaluate(() => {
      const styles = Array.from(document.head.querySelectorAll('style'));
      const widgetStyle = styles.find((s) => (s.textContent || '').includes('#ai-widget-btn'));
      if (!widgetStyle) return { found: false, nonce: null, length: 0 };
      return {
        found: true,
        nonce: widgetStyle.getAttribute('nonce'),
        length: (widgetStyle.textContent || '').length,
      };
    });

    expect(widgetStyleInfo.found, 'Widget injected <style> not found in <head>').toBe(true);
    expect(widgetStyleInfo.nonce && widgetStyleInfo.nonce.length > 0).toBe(true);
    expect(widgetStyleInfo.length).toBeGreaterThan(100);

    // If the CSP rejected the <style> block the gradient launcher button
    // would not have its background applied. Verify it actually rendered.
    const launcherBg = await page.locator('#ai-widget-btn').evaluate((el) => {
      return window.getComputedStyle(el).getPropertyValue('background-image');
    });
    expect(
      launcherBg.includes('linear-gradient'),
      `Widget <style> appears to have been blocked by CSP — computed background-image is "${launcherBg}"`,
    ).toBe(true);

    // Open the widget and verify no CSP violations are produced as a result
    // of the open interaction (e.g. dynamically inserted markup).
    await page.click('#ai-widget-btn');
    await page.waitForSelector('#ai-widget-panel.open', { timeout: 5000 });
    await page.waitForTimeout(500);

    const allViolations = [
      ...capture.consoleViolations,
      ...capture.pageErrors,
      ...capture.securityPolicyEvents,
    ];
    expect(
      allViolations,
      `AI Consultant widget produced CSP violations:\n${allViolations.join('\n')}`,
    ).toEqual([]);
  });
});
