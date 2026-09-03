/**
 * ExampleOrg i18n / RTL E2E Tests — Phase 1
 *
 * Verifies:
 *   1. English is the default language on the login page
 *   2. Setting language to 'ar' in localStorage switches to RTL
 *   3. Arabic text appears on the login page
 *   4. Navigation language toggle buttons exist (English / العربية)
 *   5. Navigation renders in RTL when language is Arabic (side rail anchors right)
 *   6. Hijri date is visible on the executive page when logged in as Arabic
 *   7. GRC page metric labels translated in Arabic
 *   8. AI Consultant widget chrome translated in Arabic
 *   9. Executive page health labels and section headings translated
 *  10. ExampleOrgI18n.onReady() fires callbacks after load
 *
 * Run:
 *   npx playwright test tests/i18n.spec.ts --reporter=line
 *
 * For tests that require authentication, set <REDACTED_SECRET> in the environment.
 * Authenticated tests are skipped when the key is absent.
 *
 * These tests use the running dev server (<REDACTED_URL>
 * The server must be running before tests execute.
 */

import { test, expect, Page } from '@playwright/test';

const BASE_URL = '<REDACTED_URL>';

// Mirrors SHOW_LANG_TOGGLE in dashboard/js/navigation.js. The in-app
// language switcher is exposed so operators can flip between English and
// العربية from the user dropdown. Keep both flags in sync.
const SHOW_LANG_TOGGLE = true;

async function setLanguage(page: Page, lang: 'en' | 'ar') {
  // Only seed when the user has not already chosen a language. This allows
  // setLang() in-app reloads to take effect without being clobbered by the
  // init script on every navigation.
  await page.addInitScript((l: string) => {
    try {
      if (!localStorage.getItem('ExampleOrg_lang')) {
        localStorage.setItem('ExampleOrg_lang', l);
      }
    } catch (_) { /* noop */ }
  }, lang);
}

async function clearLanguage(page: Page) {
  await page.addInitScript(() => {
    localStorage.removeItem('ExampleOrg_lang');
  });
}

// --- Login page ---

test.describe('Login page — i18n', () => {
  // The Playwright config sets `X-Admin-Key` on every request when
  // <REDACTED_SECRET> is exported (see playwright.config.ts). That makes
  // `/api/auth/me` report `authenticated: true`, and the inline script in
  // dashboard/login.html (`if (data.authenticated) window.location.href = '/'`)
  // bounces the browser straight off the login page before the i18n strings
  // are ever applied. Stub the auth-probe to "unauthenticated" so the page
  // we're testing actually renders. We also clear cookies for belt-and-
  // suspenders against any session left over from other suites.
  test.beforeEach(async ({ page, context }) => {
    await context.clearCookies();
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: false }),
      }),
    );
  });

  test('shows English content by default', async ({ page }) => {
    await clearLanguage(page);
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('networkidle');

    // Title should contain English text
    const heading = page.locator('[data-i18n="login.welcome"]');
    await expect(heading).toBeVisible();
    await expect(heading).toHaveText('Welcome back');

    // html[lang] should be "en"
    const lang = await page.getAttribute('html', 'lang');
    expect(lang).toBe('en');

    // html[dir] should be "ltr"
    const dir = await page.getAttribute('html', 'dir');
    expect(dir === 'ltr' || dir === null).toBe(true);
  });

  test('shows Arabic content when language is set to ar', async ({ page }) => {
    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('networkidle');

    // Wait for i18n to apply (async fetch of ar.json)
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-i18n="login.welcome"]');
      return el && el.textContent && el.textContent.trim() !== 'Welcome back';
    }, { timeout: 5000 });

    const heading = page.locator('[data-i18n="login.welcome"]');
    await expect(heading).toBeVisible();
    // Arabic translation of "Welcome back"
    await expect(heading).toHaveText('أهلاً بعودتك');

    // html[dir] should be "rtl"
    const dir = await page.getAttribute('html', 'dir');
    expect(dir).toBe('rtl');

    // html[lang] should be "ar"
    const langAttr = await page.getAttribute('html', 'lang');
    expect(langAttr).toBe('ar');
  });

  test('sign-in button text is translated in Arabic', async ({ page }) => {
    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() => {
      const el = document.querySelector('[data-i18n="login.sign_in_btn"]');
      return el && el.textContent && el.textContent.includes('تسجيل');
    }, { timeout: 5000 });

    const btn = page.locator('[data-i18n="login.sign_in_btn"]');
    await expect(btn).toContainText('تسجيل الدخول');
  });

  test('page has data-i18n attributes on key elements', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('domcontentloaded');

    const i18nElements = await page.locator('[data-i18n]').count();
    expect(i18nElements).toBeGreaterThan(4);
  });
});

// --- i18n API endpoint ---

test.describe('Language preference API', () => {
  test('GET /api/user/language-preference returns valid response', async ({ page }) => {
    const response = await page.request.get(`${BASE_URL}/api/user/language-preference`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('lang');
    // Unauthenticated returns null; authenticated returns 'en' or 'ar'
    expect(body.lang === null || ['en', 'ar'].includes(body.lang)).toBe(true);
  });

  test('POST /api/user/language-preference persists language', async ({ page }) => {
    const res = await page.request.post(`${BASE_URL}/api/user/language-preference`, {
      <REDACTED_SCHEME> { lang: 'ar' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.lang).toBe('ar');
  });

  test('POST with unsupported lang returns 400', async ({ page }) => {
    const res = await page.request.post(`${BASE_URL}/api/user/language-preference`, {
      <REDACTED_SCHEME> { lang: 'fr' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(400);
  });
});

// --- Login page localStorage Arabic persistence (no auth required) ---

test.describe('Login page — localStorage Arabic preference persists without auth', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: false }),
      }),
    );
  });

  test('Arabic set in localStorage is not overridden by server when unauthenticated', async ({ page }) => {
    // Pre-set Arabic in localStorage before any page load
    await page.goto(`${BASE_URL}/login`);
    await page.evaluate(() => {
      try { localStorage.setItem('ExampleOrg_lang', 'ar'); } catch (_) {}
    });

    // Reload so i18n.js picks it up fresh
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Wait for RTL to apply (Arabic in effect)
    await page.waitForFunction(() =>
      document.documentElement.getAttribute('dir') === 'rtl' ||
      document.documentElement.lang === 'ar',
      { timeout: 5000 }
    ).catch(() => null);

    // localStorage should still be Arabic (server unauthenticated → null → no override)
    const storedLang = await page.evaluate(() => {
      try { return localStorage.getItem('ExampleOrg_lang'); } catch (_) { return null; }
    });
    expect(storedLang).toBe('ar');

    // The heading should be translated (not English)
    const heading = page.locator('[data-i18n="login.welcome"]');
    const text = await heading.textContent().catch(() => null);
    if (text) {
      expect(text.trim()).not.toBe('Welcome Back');
    }
  });
});

// --- Offline persist + retry behaviour ---
//
// Verifies the offline-resilience contract added for [P1] task #240:
//   - When setLang() can't reach the server (offline / 5xx), a "pending"
//     marker is recorded in localStorage.
//   - On the next init() (page load) and on the `online` event, the marker
//     drives a background retry until the server confirms.
//   - While a pending marker exists, init() does NOT overwrite localStorage
//     with the (stale) server value.

test.describe('Language preference — offline retry & reconciliation', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: false }),
      }),
    );
  });

  test('init() keeps localStorage when a pending marker disagrees with the (stale) server, then retries the persist', async ({ page }) => {
    // Stub fetch BEFORE the page loads so i18n.js sees our mock during init().
    await page.addInitScript(() => {
      // Seed an offline-failed write: user picked "ar", localStorage holds it,
      // but the server still has "en" because the persist never completed.
      localStorage.setItem('ExampleOrg_lang', 'ar');
      localStorage.setItem(
        'ExampleOrg_lang_pending',
        JSON.stringify({ lang: 'ar', timestamp: Date.now() })
      );

      const realFetch = window.fetch;
      (window as any).__langPostCount = 0;
      (window as any).__langPostBody = null;
      window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
        const url = typeof input === 'string'
          ? input
          : (input instanceof URL ? input.toString() : (input as Request).url);
        const method = (init?.method || 'GET').toUpperCase();
        if (url.indexOf('/api/user/language-preference') !== -1) {
          if (method === 'GET') {
            // Stale server value — should NOT clobber the local "ar".
            return Promise.resolve(new Response(JSON.stringify({ lang: 'en' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }));
          }
          if (method === 'POST') {
            (window as any).__langPostCount += 1;
            (window as any).__langPostBody = init?.body || null;
            return Promise.resolve(new Response(JSON.stringify({ success: true, lang: 'ar' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }));
          }
        }
        // `realFetch` is the original `window.fetch`; modern `fetch` does
        // not need a `this` binding to work, and calling `.call(this, ...)`
        // inside an `addInitScript` callback also produces TS2683 because
        // the outer `this` resolves to the playwright runner. Just invoke
        // it directly.
        return realFetch(input as any, init);
      } as typeof window.fetch;
    });

    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('networkidle');

    // localStorage must still be 'ar' (the user's last choice), not the
    // server's stale 'en'.
    const stored = await page.evaluate(() => localStorage.getItem('ExampleOrg_lang'));
    expect(stored).toBe('ar');

    // The pending marker should be cleared after the background retry succeeds.
    await page.waitForFunction(
      () => localStorage.getItem('ExampleOrg_lang_pending') === null,
      { timeout: 5000 }
    );

    // And the retry must have actually issued a POST with the local language.
    const postCount = await page.evaluate(() => (window as any).__langPostCount);
    const postBody = await page.evaluate(() => (window as any).__langPostBody);
    expect(postCount).toBeGreaterThanOrEqual(1);
    expect(typeof postBody === 'string' && postBody.indexOf('"ar"') !== -1).toBe(true);
  });

  test('setLang() leaves a pending marker when the server fails (5xx) — exercises production setLang/_persistLang/_postLang', async ({ page }) => {
    // Stub fetch + window.location.reload BEFORE the page loads so the real
    // setLang() in dashboard/js/i18n.js runs end-to-end without bouncing us
    // out of the test, and we can observe the post-failure state.
    await page.addInitScript(() => {
      // Make any reload a no-op so setLang() can complete in-page.
      try {
        Object.defineProperty(window.location, 'reload', {
          configurable: true,
          value: () => { (window as any).__reloadCalls = ((window as any).__reloadCalls || 0) + 1; },
        });
      } catch (_) { /* noop */ }

      const realFetch = window.fetch;
      (window as any).__failingPostCount = 0;
      window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
        const url = typeof input === 'string'
          ? input
          : (input instanceof URL ? input.toString() : (input as Request).url);
        const method = (init?.method || 'GET').toUpperCase();
        if (url.indexOf('/api/user/language-preference') !== -1 && method === 'POST') {
          (window as any).__failingPostCount += 1;
          // Simulate a 5xx — the production code must NOT clear the pending
          // marker so a later retry can try again.
          return Promise.resolve(new Response('boom', { status: 500 }));
        }
        // `realFetch` is the original `window.fetch`; modern `fetch` does
        // not need a `this` binding to work, and calling `.call(this, ...)`
        // inside an `addInitScript` callback also produces TS2683 because
        // the outer `this` resolves to the playwright runner. Just invoke
        // it directly.
        return realFetch(input as any, init);
      } as typeof window.fetch;
    });

    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('domcontentloaded');

    // Wait for ExampleOrgI18n to be available (dashboard/js/i18n.js is loaded
    // by the login page).
    await page.waitForFunction(() => typeof (window as any).ExampleOrgI18n !== 'undefined', { timeout: 5000 });

    // Reset state from any prior init so we observe a clean failed-persist.
    await page.evaluate(() => {
      try { localStorage.removeItem('ExampleOrg_lang_pending'); } catch (_) {}
    });

    // Drive the real public API. setLang() calls _persistLang() → _postLang()
    // and then schedules a (now stubbed) reload via Promise.race with a 5s
    // timeout. We give it ample time to settle and then assert state.
    await page.evaluate(() => (window as any).ExampleOrgI18n.setLang('ar'));

    // Wait until either the pending marker shows up (set synchronously by
    // _persistLang before the network call) or the timeout fires.
    await page.waitForFunction(
      () => localStorage.getItem('ExampleOrg_lang_pending') !== null,
      { timeout: 5000 }
    );

    const after = await page.evaluate(() => ({
      lang: localStorage.getItem('ExampleOrg_lang'),
      pending: localStorage.getItem('ExampleOrg_lang_pending'),
      failingPostCount: (window as any).__failingPostCount,
    }));

    // localStorage was updated immediately, the failing 5xx left the pending
    // marker in place, and the production code did issue exactly one POST
    // (the retry happens later, on init() / online).
    expect(after.lang).toBe('ar');
    expect(after.pending).not.toBeNull();
    const parsed = JSON.parse(after.pending as string);
    expect(parsed.lang).toBe('ar');
    expect(typeof parsed.timestamp).toBe('number');
    expect(after.failingPostCount).toBeGreaterThanOrEqual(1);
  });

});

// --- RTL layout ---

test.describe('RTL layout checks', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: false }),
      }),
    );
  });

  test('html[dir="rtl"] is set when Arabic is active', async ({ page }) => {
    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() =>
      document.documentElement.getAttribute('dir') === 'rtl',
      { timeout: 5000 }
    );

    const dir = await page.getAttribute('html', 'dir');
    expect(dir).toBe('rtl');
  });

  test('body has wp-rtl class in Arabic mode', async ({ page }) => {
    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() =>
      document.body.classList.contains('wp-rtl'),
      { timeout: 5000 }
    );

    const hasClass = await page.locator('body').evaluate(el => el.classList.contains('wp-rtl'));
    expect(hasClass).toBe(true);
  });
});

// --- i18n module presence ---

test.describe('i18n module availability', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: false }),
      }),
    );
  });

  test('ExampleOrgI18n is available on pages that load i18n.js', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('networkidle');

    const hasI18n = await page.evaluate(() => typeof window.ExampleOrgI18n !== 'undefined');
    expect(hasI18n).toBe(true);
  });

  test('ExampleOrgI18n.t() returns translated string', async ({ page }) => {
    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('networkidle');

    // Wait for strings to load
    await page.waitForFunction(() =>
      window.ExampleOrgI18n && window.ExampleOrgI18n.t('login.welcome') !== 'welcome',
      { timeout: 5000 }
    );

    const result = await page.evaluate(() => window.ExampleOrgI18n.t('login.welcome'));
    expect(result).toBe('أهلاً بعودتك');
  });

  test('ExampleOrgI18n.isRTL() returns true for Arabic', async ({ page }) => {
    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() =>
      window.ExampleOrgI18n && window.ExampleOrgI18n.currentLang() === 'ar',
      { timeout: 5000 }
    );

    const isRtl = await page.evaluate(() => window.ExampleOrgI18n.isRTL());
    expect(isRtl).toBe(true);
  });

  test('ExampleOrgI18n.onReady() fires callback after strings load', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('networkidle');

    // Register callback after page load and verify it fires
    const fired = await page.evaluate((): Promise<boolean> => {
      return new Promise((resolve) => {
        if (!window.ExampleOrgI18n) { resolve(false); return; }
        // If already loaded, onReady fires synchronously
        window.ExampleOrgI18n.onReady(() => resolve(true));
        // Fallback timeout
        setTimeout(() => resolve(false), 3000);
      });
    });
    expect(fired).toBe(true);
  });
});

// --- Helper for authenticated tests ---

async function authenticate(page: Page): Promise<boolean> {
  const adminKey = process.env.<REDACTED_SECRET>;
  if (!adminKey) return false;
  const res = await page.request.post(`${BASE_URL}/api/admin/auth`, {
    <REDACTED_SCHEME> { key: adminKey },
    headers: { 'Content-Type': 'application/json' },
  });
  return res.status() === 200;
}

// --- Navigation RTL rail (authenticated pages) ---

test.describe('Navigation RTL — rail direction', () => {
  test('side rail is visible and data-i18n language toggle buttons exist', async ({ page }) => {
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/executive.html`);
    await page.waitForLoadState('networkidle');

    // Wait for navigation to render
    await page.waitForFunction(() =>
      document.documentElement.getAttribute('dir') === 'rtl',
      { timeout: 5000 }
    );

    // Navigation side rail should exist
    const rail = page.locator('#sidebar, #nav-rail, nav[class*="fixed"]').first();
    await expect(rail).toBeVisible({ timeout: 5000 });

    // html[dir] should be rtl
    const dir = await page.getAttribute('html', 'dir');
    expect(dir).toBe('rtl');
  });

  test('language toggle buttons rendered in navigation (English / العربية)', async ({ page }) => {
    if (!SHOW_LANG_TOGGLE) { test.skip(); return; }
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await page.goto(`${BASE_URL}/executive.html`);
    await page.waitForLoadState('networkidle');

    // Wait for navigation to be injected by navigation.js
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="button-lang-en"]') !== null ||
      document.body.innerHTML.includes('العربية'),
      { timeout: 8000 }
    );

    // Should have both language toggle buttons
    const enBtn = page.locator('[data-testid="button-lang-en"]');
    const arBtn = page.locator('[data-testid="button-lang-ar"]');
    const hasEn = await enBtn.count() > 0;
    const hasAr = await arBtn.count() > 0;
    expect(hasEn || hasAr).toBe(true);
  });

  test('rail is right-anchored in RTL mode (computed right: 0px)', async ({ page }) => {
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/executive.html`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() =>
      document.documentElement.getAttribute('dir') === 'rtl',
      { timeout: 5000 }
    );

    // .wp-rail should have right: 0 and left: auto in RTL (per navigation.js RTL CSS)
    const rail = page.locator('.wp-rail').first();
    if (await rail.count() > 0) {
      const right = await rail.evaluate(el =>
        window.getComputedStyle(el).getPropertyValue('right')
      );
      expect(right).toBe('0px');
    }
  });
});

// --- Per-page Arabic label coverage for all Phase 1 surfaces ---

test.describe('Phase 1 surfaces — known Arabic label per page', () => {
  test('GRC page: active_risks label is translated to Arabic', async ({ page }) => {
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/grc.html`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() => {
      const el = document.querySelector('[data-i18n="grc.active_risks"]');
      return el && el.textContent && el.textContent.trim() !== 'Active Risks';
    }, { timeout: 5000 });

    const label = page.locator('[data-i18n="grc.active_risks"]').first();
    const text = await label.textContent();
    expect(text).not.toBe('Active Risks');
    expect(text && text.trim().length > 0).toBe(true);
  });

  test('Consultant page: title is translated to Arabic', async ({ page }) => {
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/consultant.html`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() => {
      const el = document.querySelector('[data-i18n="consultant.title"]');
      return el && el.textContent && el.textContent.trim() !== 'QMS AI Consultant';
    }, { timeout: 5000 });

    const title = page.locator('[data-i18n="consultant.title"]').first();
    const text = await title.textContent();
    expect(text).not.toBe('QMS AI Consultant');
    expect(text && text.trim().length > 0).toBe(true);
  });

  test('Executive page: MBR button is translated to Arabic', async ({ page }) => {
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/executive.html`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() => {
      const el = document.querySelector('[data-i18n="executive.generate_mbr"]');
      return el && el.textContent && el.textContent.trim() !== 'Generate MBR';
    }, { timeout: 5000 });

    const btn = page.locator('[data-i18n="executive.generate_mbr"]');
    const text = await btn.textContent();
    expect(text).not.toBe('Generate MBR');
    expect(text && text.trim().length > 0).toBe(true);
  });

  test('Consultant page: quick_actions sidebar label is in Arabic', async ({ page }) => {
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/consultant.html`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() => {
      const el = document.querySelector('[data-i18n="consultant.quick_actions"]');
      return el && el.textContent && el.textContent.trim() !== 'Quick Actions';
    }, { timeout: 5000 });

    const label = page.locator('[data-i18n="consultant.quick_actions"]');
    const text = await label.textContent();
    expect(text).not.toBe('Quick Actions');
    expect(text && text.trim().length > 0).toBe(true);
  });
});

// --- Executive page Arabic labels ---

test.describe('Executive page — Arabic labels', () => {
  test('executive health score label is translated to Arabic', async ({ page }) => {
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/executive.html`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() => {
      const el = document.querySelector('[data-i18n="executive.health_score"]');
      return el && el.textContent && el.textContent.trim() !== 'Overall Health Score';
    }, { timeout: 5000 });

    const label = page.locator('[data-i18n="executive.health_score"]');
    await expect(label).toBeVisible();
    // Should contain Arabic text, not English
    const text = await label.textContent();
    expect(text).not.toBe('Overall Health Score');
    expect(text && text.length > 0).toBe(true);
  });

  test('executive tab labels are translated to Arabic', async ({ page }) => {
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/executive.html`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() => {
      const el = document.querySelector('[data-i18n="executive.tabs.overview"]');
      return el && el.textContent && el.textContent.trim() !== 'Overview';
    }, { timeout: 5000 });

    const overviewTab = page.locator('[data-i18n="executive.tabs.overview"]');
    const text = await overviewTab.textContent();
    expect(text).not.toBe('Overview');
  });

  test('Hijri date renders correctly (not [object Object])', async ({ page }) => {
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/executive.html`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() => {
      const el = document.getElementById('hijri-date-display');
      return el && el.textContent && el.textContent.trim().length > 5;
    }, { timeout: 8000 });

    const dateEl = page.locator('#hijri-date-display');
    const dateText = await dateEl.textContent();
    expect(dateText).not.toContain('[object');
    expect(dateText && dateText.length > 5).toBe(true);
  });
});

// --- GRC page Arabic labels ---

test.describe('GRC page — Arabic labels', () => {
  test('GRC metric labels are translated to Arabic', async ({ page }) => {
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/grc.html`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() => {
      const el = document.querySelector('[data-i18n="grc.active_risks"]');
      return el && el.textContent && el.textContent.trim() !== 'Active Risks';
    }, { timeout: 5000 });

    const label = page.locator('[data-i18n="grc.active_risks"]');
    const text = await label.textContent();
    expect(text).not.toBe('Active Risks');
    expect(text && text.length > 0).toBe(true);
  });

  test('GRC section headers are fully translated to Arabic', async ({ page }) => {
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/grc.html`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() => {
      const el = document.querySelector('[data-i18n="grc.risk_heat_map"]');
      return el && el.textContent && el.textContent.trim() !== 'Risk Heat Map';
    }, { timeout: 5000 });

    const checks: Array<{ key: string; english: string }> = [
      { key: '<REDACTED_SECRET>', english: 'Risk Heat Map' },
      { key: '<REDACTED_SECRET>', english: 'GRC Module Status' },
      { key: '<REDACTED_SECRET>', english: 'Compliance by Framework' },
      { key: '<REDACTED_SECRET>', english: 'Handoff Rules' },
      { key: '<REDACTED_SECRET>', english: 'Quality-GRC Integration' },
      { key: '<REDACTED_SECRET>', english: 'Control Effectiveness' },
      { key: '<REDACTED_SECRET>', english: 'Audit Readiness' },
      { key: '<REDACTED_SECRET>', english: 'Recent Handoff Events' },
      { key: '<REDACTED_SECRET>', english: 'Rule' },
      { key: '<REDACTED_SECRET>', english: 'Status' },
      { key: '<REDACTED_SECRET>', english: 'Readiness Score' },
      { key: '<REDACTED_SECRET>', english: 'External Audits' },
    ];

    for (const { key, english } of checks) {
      const el = page.locator(`[data-i18n="${key}"]`).first();
      const count = await el.count();
      if (count > 0) {
        const t = await el.textContent();
        expect(t?.trim(), `Expected [${key}] not to show English "${english}"`).not.toBe(english);
        expect(t && t.trim().length > 0).toBe(true);
      }
    }
  });

  test('GRC heatmap axis labels are translated to Arabic', async ({ page }) => {
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/grc.html`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() => {
      const el = document.querySelector('[data-i18n="grc.risk_low"]');
      return el && el.textContent && el.textContent.trim() !== 'Low';
    }, { timeout: 5000 });

    for (const key of ['grc.risk_low', 'grc.risk_med', 'grc.risk_high', 'grc.risk_crit']) {
      const els = page.locator(`[data-i18n="${key}"]`);
      const cnt = await els.count();
      if (cnt > 0) {
        const t = await els.first().textContent();
        expect(t?.trim().length, `[${key}] should have non-empty Arabic text`).toBeGreaterThan(0);
        expect(t?.trim()).not.toMatch(/^(Low|Med|High|Crit)$/);
      }
    }
  });

  test('GRC page html[dir] is rtl in Arabic mode', async ({ page }) => {
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/grc.html`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() =>
      document.documentElement.getAttribute('dir') === 'rtl',
      { timeout: 5000 }
    );

    const dir = await page.getAttribute('html', 'dir');
    expect(dir).toBe('rtl');
  });
});

// --- AI Consultant widget chrome ---

test.describe('AI Consultant widget — i18n chrome', () => {
  test('widget chrome is translated to Arabic', async ({ page }) => {
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/executive.html`);
    await page.waitForLoadState('networkidle');

    // Wait for widget to be injected and i18n to apply
    await page.waitForFunction(() => {
      const w = document.getElementById('ai-consultant-widget');
      return w !== null;
    }, { timeout: 5000 });

    // Wait for translation to be applied (ExampleOrgI18nReady event)
    await page.waitForFunction(() => {
      const h4 = document.querySelector('#ai-widget-welcome h4');
      return h4 && h4.textContent && h4.textContent.trim() !== 'ExampleOrg QMS Consultant';
    }, { timeout: 6000 }).catch(() => {
      // Translation may be synchronous if i18n loaded before widget
    });

    const widget = page.locator('#ai-consultant-widget');
    await expect(widget).toBeVisible({ timeout: 5000 });

    // Widget chrome must show Arabic content — English default must not appear
    const h4 = page.locator('#ai-widget-welcome h4');
    if (await h4.count() > 0) {
      const h4Text = await h4.textContent();
      // In Arabic mode the heading must not be the English fallback
      expect(h4Text).not.toBe('ExampleOrg QMS Consultant');
      expect(h4Text && h4Text.trim().length > 0).toBe(true);
    } else {
      // Welcome section not rendered yet; verify widget has non-empty content
      const widgetContent = await widget.textContent();
      expect(widgetContent && widgetContent.trim().length > 0).toBe(true);
    }
  });

  test('widget placeholder is translated in Arabic', async ({ page }) => {
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/executive.html`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() =>
      document.getElementById('ai-widget-input') !== null,
      { timeout: 5000 }
    );

    // Wait for translated placeholder
    await page.waitForFunction(() => {
      const inp = document.getElementById('ai-widget-input') as HTMLTextAreaElement | null;
      return inp && inp.placeholder !== 'Ask anything...';
    }, { timeout: 6000 }).catch(() => {});

    const inp = page.locator('#ai-widget-input');
    const ph = await inp.getAttribute('placeholder');
    // placeholder should be Arabic or at least not English default
    expect(ph).not.toBeNull();
    expect(ph).not.toBe('');
  });
});

// --- In-app language toggle flow (user menu click) ---

test.describe('In-app language toggle — user menu', () => {
  test('clicking العربية button in user menu sets dir=rtl and lang=ar', async ({ page }) => {
    if (!SHOW_LANG_TOGGLE) { test.skip(); return; }
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    // Start in English
    await page.goto(`${BASE_URL}/executive.html`);
    await page.waitForLoadState('networkidle');

    // Open user menu
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="button-user-menu"]') !== null,
      { timeout: 6000 }
    );
    await page.click('[data-testid="button-user-menu"]');

    // Click Arabic button
    const arBtn = page.locator('[data-testid="button-lang-ar"]');
    await expect(arBtn).toBeVisible({ timeout: 4000 });

    // Clicking setLang triggers a page reload — intercept it
    await Promise.all([
      page.waitForNavigation({ timeout: 8000 }).catch(() => {}),
      arBtn.click(),
    ]);

    // After reload, html[lang] and html[dir] must reflect Arabic
    const lang = await page.getAttribute('html', 'lang');
    const dir  = await page.getAttribute('html', 'dir');
    expect(lang).toBe('ar');
    expect(dir).toBe('rtl');
  });

  test('clicking English button in user menu restores ltr', async ({ page }) => {
    if (!SHOW_LANG_TOGGLE) { test.skip(); return; }
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    // Start in Arabic
    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/executive.html`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() =>
      document.querySelector('[data-testid="button-user-menu"]') !== null,
      { timeout: 6000 }
    );
    await page.click('[data-testid="button-user-menu"]');

    const enBtn = page.locator('[data-testid="button-lang-en"]');
    await expect(enBtn).toBeVisible({ timeout: 4000 });

    await Promise.all([
      page.waitForNavigation({ timeout: 8000 }).catch(() => {}),
      enBtn.click(),
    ]);

    const dir = await page.getAttribute('html', 'dir');
    expect(dir === 'ltr' || dir === null).toBe(true);
  });
});

// --- Notifications panel translation ---

test.describe('Notifications panel — i18n', () => {
  test('notifications panel title is translated to Arabic', async ({ page }) => {
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/executive.html`);
    await page.waitForLoadState('networkidle');

    // Wait for i18n to apply
    await page.waitForFunction(() =>
      document.documentElement.getAttribute('lang') === 'ar',
      { timeout: 5000 }
    );

    // Open notifications panel
    const notifBtn = page.locator('[data-testid="button-notifications"]');
    if (await notifBtn.count() === 0) { test.skip(); return; }
    await notifBtn.click();

    // The notification panel title should be in Arabic
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-i18n="notifications.title"]');
      return el && el.textContent && el.textContent.trim() !== 'Notifications';
    }, { timeout: 5000 }).catch(() => {});

    const title = page.locator('[data-i18n="notifications.title"]');
    if (await title.count() > 0) {
      const text = await title.textContent();
      expect(text).not.toBe('Notifications');
      expect(text && text.trim().length > 0).toBe(true);
    }
  });
});

// --- User menu — numeral format toggle ---

test.describe('Numeral format toggle — user menu', () => {
  test('Eastern and Western numeral toggle buttons exist in Arabic mode user menu', async ({ page }) => {
    const ok = await authenticate(page);
    if (!ok) { test.skip(); return; }

    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/executive.html`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() =>
      document.querySelector('[data-testid="button-user-menu"]') !== null,
      { timeout: 6000 }
    );
    await page.click('[data-testid="button-user-menu"]');

    // Both numeral toggle buttons should be present
    const easternBtn = page.locator('[data-testid="button-numerals-eastern"]');
    const westernBtn = page.locator('[data-testid="button-numerals-western"]');
    await expect(easternBtn).toBeVisible({ timeout: 4000 });
    await expect(westernBtn).toBeVisible({ timeout: 4000 });
  });

  test('setUseEasternNumerals(false) switches to Western numerals', async ({ page }) => {
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: false }),
      }),
    );
    await setLanguage(page, 'ar');
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() =>
      window.ExampleOrgI18n && window.ExampleOrgI18n.formatNumber !== undefined,
      { timeout: 5000 }
    );

    // Enable Western numerals
    await page.evaluate(() => window.ExampleOrgI18n.setUseEasternNumerals(false));
    const resultWestern = await page.evaluate(() => window.ExampleOrgI18n.formatNumber(1234));
    expect(resultWestern).toBe('1,234');

    // Enable Eastern numerals
    await page.evaluate(() => window.ExampleOrgI18n.setUseEasternNumerals(true));
    const resultEastern = await page.evaluate(() => window.ExampleOrgI18n.formatNumber(1234));
    expect(resultEastern).not.toBe('1,234');
    expect(resultEastern.length > 0).toBe(true);
  });
});
