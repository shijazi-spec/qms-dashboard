/**
 * E2E coverage for the ExampleOrg dashboard sidebar (Task #824).
 *
 * Background:
 *   Task #822 reworked dashboard/js/navigation.js with Pinned / Recent
 *   sections, search highlighting + an empty state, keyboard navigation
 *   (Arrow / Home / End / `/` / Escape), a mobile-drawer focus trap, and
 *   a polished active-row accent bar. None of those behaviours had any
 *   automated coverage, so silent regressions were possible. This spec
 *   exercises each contract the task description spells out, in both
 *   LTR (English) and RTL (Arabic) layouts.
 *
 * Auth strategy:
 *   The dashboard pages this spec hits (/onboarding, /feedback) are
 *   server-side auth-gated. We pin the X-Admin-Key header on every
 *   request via test.use({ extraHTTPHeaders }) — the same pattern as
 *   tests/aiOpsTabs.spec.ts and tests/promptVersionTab.spec.ts. With
 *   that header present, /api/auth/me resolves to the synthetic admin
 *   user (id: "admin"), so the per-user storage keys collapse to:
 *     ExampleOrg-nav-pinned:user:admin
 *     ExampleOrg-nav-recent:user:admin
 *
 *   When ADMIN_API_KEY / TEST_ADMIN_KEY is not in the environment, the
 *   suite is skipped (mirrors the other auth-gated dashboard specs).
 *
 * Run:
 *   npx playwright test tests/dashboardSidebar.spec.ts --reporter=line
 */

import { test, expect, Page } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || '<REDACTED_URL>';
const ADMIN_KEY = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY || '';

// User-scoped storage key suffix. /api/auth/me with X-Admin-Key returns
// `id: "admin"` (see server/routes/auth*.ts), so the per-user namespace
// is deterministic for this suite.
const PIN_KEY = 'ExampleOrg-nav-pinned:user:admin';
const RECENT_KEY = 'ExampleOrg-nav-recent:user:admin';

// Seed `ExampleOrg_lang` BEFORE any script runs so i18n.js picks it up
// during init and the rail renders in the requested direction. Also
// clears any leftover pin/recent state from previous runs so each spec
// starts from a clean rail.
async function bootstrap(page: Page, lang: 'en' | 'ar') {
  await page.addInitScript((l: string) => {
    try {
      localStorage.setItem('ExampleOrg_lang', l);
      localStorage.removeItem('ExampleOrg-nav-pinned');
      localStorage.removeItem('ExampleOrg-nav-recent');
      localStorage.removeItem('ExampleOrg-nav-pinned:user:admin');
      localStorage.removeItem('ExampleOrg-nav-recent:user:admin');
      localStorage.removeItem('ExampleOrg-nav-collapsed');
    } catch (_) { /* noop */ }
  }, lang);

  // Stub /api/auth/me at the browser layer. The real endpoint lives
  // behind a low per-IP AUTH_LIMIT (5/min — see src/utils/rateLimiter.ts
  // AUTH_PATHS), and this suite issues many page loads in quick
  // succession. Without the stub the limiter trips mid-suite, the
  // browser-side fetch returns 429 → loadUserInfo() falls back to the
  // anonymous user, the admin-gated nav groups disappear, and every
  // subsequent rail assertion fails for the wrong reason. The stub
  // returns the same payload the real handler returns when called with
  // a valid X-Admin-Key, so the user-scoped storage keys
  // (ExampleOrg-nav-{pinned,recent}:user:admin) stay correct.
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: {
          id: 'admin',
          email: 'user@example.invalid',
          name: 'Admin',
          picture: null,
          role: 'admin',
        },
      }),
    });
  });
}

// Wait until the rail finishes its role-aware re-render after
// /api/auth/me resolves. The first paint can render a smaller rail
// (gated groups hidden) before loadUserInfo() patches in the admin
// role; waiting for an admin-only group ensures every assertion below
// runs against the final DOM.
async function waitForRailReady(page: Page) {
  await page.waitForSelector('[data-testid="nav-rail"]', { timeout: 10000 });
  // The admin-only group only appears once /api/auth/me resolves and the
  // role-aware re-render runs. The link itself lives inside a collapsed
  // accordion (so attached, not visible), which is enough to confirm the
  // re-render has happened.
  await page.waitForSelector('[data-testid="link-nav-admin"]', { state: 'attached', timeout: 10000 });
}

test.describe('Dashboard sidebar — pin / recent / search / keyboard', () => {
  test.use({
    extraHTTPHeaders: ADMIN_KEY ? { 'X-Admin-Key': ADMIN_KEY } : {},
  });

  test.beforeEach(async () => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
    }
  });

  // ---------------------------------------------------------------------
  // Pin / Unpin
  // ---------------------------------------------------------------------
  test('pin / unpin updates the Pinned group and localStorage', async ({ page }) => {
    await bootstrap(page, 'en');
    await page.goto(`${BASE_URL}/feedback`);
    await waitForRailReady(page);

    // No Pinned group when the pinned list is empty.
    await expect(page.locator('[data-testid="button-group-pinned"]')).toHaveCount(0);

    // Pin "audits" via the public togglePin() API. The pin button is
    // gated by hover/focus CSS (`.wp-pin-btn { opacity: 0 }`) AND lives
    // inside whatever accordion the leaf belongs to (Quality, here),
    // which starts collapsed when the current page is in another
    // group (Support → /feedback). Rather than orchestrate hover +
    // accordion open just to click an attached-but-hidden button, we
    // call the same public method (`ExampleOrgNav.togglePin`) that the
    // button's `data-on-click` attribute invokes. This keeps the test
    // about the storage + render contract — which is exactly what
    // Task #822 is meant to guarantee — without coupling it to the
    // CSS hover affordance, which has its own visual story.
    await page.evaluate(() => (window as any).ExampleOrgNav.togglePin('audits'));

    // Pinned group now exists, contains the pinned item, and the
    // per-user localStorage key was written.
    await expect(page.locator('[data-testid="button-group-pinned"]')).toBeVisible();
    await expect(page.locator('[data-testid="link-nav-audits-pinned"]')).toBeVisible();

    const stored = await page.evaluate((k) => localStorage.getItem(k), PIN_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string)).toEqual(['audits']);

    // Unpin via the same public API (the in-group and Pinned-group
    // pin buttons both wire up to togglePin under the hood).
    await page.evaluate(() => (window as any).ExampleOrgNav.togglePin('audits'));

    await expect(page.locator('[data-testid="button-group-pinned"]')).toHaveCount(0);
    const after = await page.evaluate((k) => localStorage.getItem(k), PIN_KEY);
    expect(JSON.parse(after as string)).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Recent (capped at 5)
  // ---------------------------------------------------------------------
  test('visiting items records them under Recent (capped at 5, most-recent first)', async ({ page }) => {
    await bootstrap(page, 'en');

    // Pre-seed 5 visits via the public API so we can verify (a) the cap
    // and (b) the most-recent-first ordering without relying on real
    // page navigations (which would also trigger fresh visits and make
    // the assertion brittle). The recordVisit() implementation is the
    // same code path the click-handler in bindEvents() invokes.
    await page.goto(`${BASE_URL}/feedback`);
    await waitForRailReady(page);

    await page.evaluate(() => {
      const ids = ['kpis', 'team', 'projects', 'roi', 'reviews', 'vendors'];
      ids.forEach((id) => (window as any).ExampleOrgNav.recordVisit(id));
    });

    const recent = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]'), RECENT_KEY);
    // Cap at 5 (RECENT_MAX), most-recent first → 'vendors' was last.
    expect(recent).toHaveLength(5);
    expect(recent[0]).toBe('vendors');
    expect(recent).not.toContain('kpis'); // bumped out by the cap

    // Re-render so the Recent group materialises with the seeded ids.
    await page.evaluate(() => {
      const N = (window as any).ExampleOrgNav;
      N.render();
      N.bindEvents();
    });

    const recentGroup = page.locator('[data-testid="button-group-recent"]');
    await expect(recentGroup).toBeVisible();
    // Recent items are surfaced under the recent suffix and capped at 5.
    await expect(page.locator('[data-testid="link-nav-vendors-recent"]')).toBeVisible();
    await expect(page.locator('[data-testid="link-nav-roi-recent"]')).toBeVisible();
    await expect(page.locator('[data-testid="link-nav-kpis-recent"]')).toHaveCount(0);

    // Navigating to a leaf for real should also push a fresh entry —
    // loadUserInfo() invokes recordVisit(currentPage) on every page
    // load (see navigation.js). Visit /kpis so the assertion is about
    // an id that wasn't in the seeded list (the seed bumped it out via
    // the cap), proving the auto-record-on-navigation contract holds.
    await page.goto(`${BASE_URL}/kpis`);
    await waitForRailReady(page);
    await page.waitForFunction(
      (k) => {
        const raw = localStorage.getItem(k as string);
        if (!raw) return false;
        try { return (JSON.parse(raw)[0] === 'kpis'); } catch (_) { return false; }
      },
      RECENT_KEY,
      { timeout: 5000 },
    );
    const afterNav = await page.evaluate(
      (k) => JSON.parse(localStorage.getItem(k) || '[]'),
      RECENT_KEY,
    );
    expect(afterNav[0]).toBe('kpis');
    expect(afterNav.length).toBeLessThanOrEqual(5);
  });

  // ---------------------------------------------------------------------
  // Search: highlight matches + "No results" empty state
  // ---------------------------------------------------------------------
  test('search highlights matches with <mark class="wp-nav-mark"> and shows the empty state when nothing matches', async ({ page }) => {
    await bootstrap(page, 'en');
    await page.goto(`${BASE_URL}/feedback`);
    await waitForRailReady(page);

    const search = page.locator('[data-testid="input-nav-search"]');
    const empty = page.locator('#wp-nav-empty');
    await expect(empty).toBeHidden();

    // Type a substring that matches at least one leaf label.
    await search.fill('audit');
    // The matching label has a <mark class="wp-nav-mark"> wrapping the
    // hit substring. There's at least one such match in the rail.
    const marks = page.locator('mark.wp-nav-mark');
    await expect(marks.first()).toBeVisible();
    const markText = (await marks.first().textContent() || '').toLowerCase();
    expect(markText).toContain('audit');
    await expect(empty).toBeHidden();

    // Now type a query that nothing matches → the #wp-nav-empty state
    // becomes visible (its `.hidden` modifier is removed).
    await search.fill('zzznosuchlabelzzz');
    await expect(empty).toBeVisible();
    await expect(empty).not.toHaveClass(/hidden/);

    // Clearing the search restores the rail.
    await search.fill('');
    await expect(empty).toBeHidden();
    await expect(page.locator('mark.wp-nav-mark')).toHaveCount(0);
  });

  // ---------------------------------------------------------------------
  // Keyboard: `/` focuses search, Arrow/Home/End move within the rail
  // ---------------------------------------------------------------------
  test('"/" focuses the rail search input', async ({ page }) => {
    await bootstrap(page, 'en');
    await page.goto(`${BASE_URL}/feedback`);
    await waitForRailReady(page);

    // Defocus any existing element first by focusing the page body.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator('body').click({ position: { x: 1, y: 1 } });

    await page.keyboard.press('/');

    const focusedTestId = await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.getAttribute('data-testid'),
    );
    expect(focusedTestId).toBe('input-nav-search');
  });

  test('ArrowDown / ArrowUp / Home / End move focus across rail items', async ({ page }) => {
    await bootstrap(page, 'en');
    await page.goto(`${BASE_URL}/feedback`);
    await waitForRailReady(page);

    // Seed focus on the first focusable rail element (group toggle or
    // active leaf, depending on currentPage). Use page.evaluate so we
    // don't depend on tab-order from the URL bar.
    await page.evaluate(() => {
      const railNav = document.getElementById('wp-rail-nav');
      const first = railNav?.querySelector('.wp-group-toggle, .wp-rail-item') as HTMLElement | null;
      first?.focus();
    });
    const firstTag = await page.evaluate(() => document.activeElement?.tagName);
    expect(firstTag).toBeTruthy();

    // ArrowDown advances focus to the next focusable in the rail.
    await page.keyboard.press('ArrowDown');
    const afterDown = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    const startTestId = await page.evaluate(() => {
      const railNav = document.getElementById('wp-rail-nav');
      return railNav?.querySelector('.wp-group-toggle, .wp-rail-item')?.getAttribute('data-testid');
    });
    expect(afterDown).not.toBeNull();
    expect(afterDown).not.toBe(startTestId);

    // ArrowUp moves focus back.
    await page.keyboard.press('ArrowUp');
    const afterUp = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    expect(afterUp).toBe(startTestId);

    // End → focus the last focusable. Home → first.
    await page.keyboard.press('End');
    const afterEnd = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    const lastTestId = await page.evaluate(() => {
      const railNav = document.getElementById('wp-rail-nav');
      const list = Array.from(railNav?.querySelectorAll('.wp-group-toggle, .wp-rail-item') || [])
        .filter((el) => (el as HTMLElement).offsetParent !== null);
      return (list[list.length - 1] as HTMLElement | undefined)?.getAttribute('data-testid');
    });
    expect(afterEnd).toBe(lastTestId);

    await page.keyboard.press('Home');
    const afterHome = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    expect(afterHome).toBe(startTestId);
  });

  // ---------------------------------------------------------------------
  // Mobile drawer: Tab focus trap + Escape closes and returns focus
  // ---------------------------------------------------------------------
  test('mobile drawer traps Tab focus inside #nav-rail and Escape returns focus to the hamburger', async ({ page }) => {
    await bootstrap(page, 'en');
    await page.setViewportSize({ width: 600, height: 800 });
    await page.goto(`${BASE_URL}/feedback`);
    await waitForRailReady(page);

    const hamburger = page.locator('[data-testid="button-mobile-menu"]');
    await expect(hamburger).toBeVisible();
    await hamburger.focus();
    await hamburger.click();

    // Drawer is open; body picks up the open-modifier class.
    await expect(page.locator('body')).toHaveClass(/wp-mobile-open/);

    // Drive Tab/Shift+Tab and assert the active element stays inside
    // #nav-rail through a wrap-around. The handler in bindEvents()
    // intercepts Tab on the last focusable to send focus to the first
    // (and Shift+Tab on the first to send it to the last).
    const focusInsideRail = async () => {
      return await page.evaluate(() => {
        const rail = document.getElementById('nav-rail');
        return !!(rail && document.activeElement && rail.contains(document.activeElement));
      });
    };

    // Move focus to the last focusable in the rail, then Tab once → the
    // trap should bounce focus back to the first focusable.
    await page.evaluate(() => {
      const rail = document.getElementById('nav-rail');
      const list = rail?.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]',
      );
      const last = list?.[list.length - 1] as HTMLElement | undefined;
      last?.focus();
    });
    expect(await focusInsideRail()).toBe(true);
    await page.keyboard.press('Tab');
    // The focus trap must keep focus inside #nav-rail after Tab from
    // the last focusable. We assert containment rather than identity
    // with the "first" focusable: the rail has a roving tabindex
    // policy that re-tags items as users move around, so the
    // querySelectorAll-derived "first" can be ambiguous between the
    // search input and the active leaf depending on render order. The
    // contract Task #822 commits to is the trap, not which specific
    // element receives focus on wrap.
    expect(await focusInsideRail()).toBe(true);

    // Shift+Tab from a position inside the rail also stays inside.
    await page.keyboard.press('Shift+Tab');
    expect(await focusInsideRail()).toBe(true);

    // Escape closes the drawer and returns focus to the hamburger
    // (which is what owned focus before we opened the drawer).
    await page.keyboard.press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/wp-mobile-open/);
    const focusedAfterEscape = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid'),
    );
    expect(focusedAfterEscape).toBe('button-mobile-menu');
  });

  // ---------------------------------------------------------------------
  // RTL coverage — active accent bar mirrors and tooltips flip side
  // ---------------------------------------------------------------------
  test('LTR: active row accent bar sits on the inline-start (left) edge and tooltips open to the right', async ({ page }) => {
    await bootstrap(page, 'en');
    await page.goto(`${BASE_URL}/feedback`);
    await waitForRailReady(page);

    // The active row carries the polish class.
    const activeRow = page.locator('.wp-rail-row.wp-rail-row-active').first();
    await expect(activeRow).toBeVisible();

    // CSS uses `inset-inline-start: 0` on ::before — in LTR that resolves
    // to `left: 0`, in RTL to `right: 0`. Check the computed value.
    const insetStartLtr = await activeRow.evaluate((el) => {
      const cs = getComputedStyle(el, '::before');
      return { left: cs.left, right: cs.right };
    });
    expect(insetStartLtr.left).toBe('0px');

    // Tooltip mirroring (LTR): the tooltip box must sit to the RIGHT
    // of its anchor rail item. We can't assert against the computed
    // `left`/`right` strings — Chromium resolves both to numeric
    // offsets for absolutely-positioned elements, even when the
    // unused side is specified as `auto`. Compare bounding rects
    // instead, which captures the user-visible behaviour directly.
    const ltrSides = await page.evaluate(() => {
      const tip = document.querySelector('.wp-rail-item .wp-nav-tooltip') as HTMLElement | null;
      const item = tip?.closest('.wp-rail-item') as HTMLElement | null;
      if (!tip || !item) return null;
      const t = tip.getBoundingClientRect();
      const i = item.getBoundingClientRect();
      return { tipLeft: t.left, itemRight: i.right };
    });
    expect(ltrSides).not.toBeNull();
    // LTR: tooltip's left edge sits past the rail item's right edge.
    expect(ltrSides!.tipLeft).toBeGreaterThanOrEqual(ltrSides!.itemRight);
  });

  test('RTL: html[dir="rtl"] flips the active accent bar to the right edge and tooltips open to the left', async ({ page }) => {
    await bootstrap(page, 'ar');
    await page.goto(`${BASE_URL}/feedback`);
    await waitForRailReady(page);

    // Wait for the i18n bundle to apply RTL.
    await page.waitForFunction(
      () => document.documentElement.getAttribute('dir') === 'rtl',
      { timeout: 5000 },
    );

    const activeRow = page.locator('.wp-rail-row.wp-rail-row-active').first();
    await expect(activeRow).toBeVisible();

    // Under RTL, `inset-inline-start: 0` resolves to `right: 0`.
    const insetStartRtl = await activeRow.evaluate((el) => {
      const cs = getComputedStyle(el, '::before');
      return { left: cs.left, right: cs.right };
    });
    expect(insetStartRtl.right).toBe('0px');

    // Tooltip mirroring (RTL): the override in navigation.css under
    // `html[dir="rtl"] .wp-nav-tooltip` flips the tooltip to the
    // LEFT of its anchor. Compare bounding rects (same rationale as
    // the LTR case — computed `left`/`right` are always numeric for
    // absolutely-positioned elements).
    const rtlSides = await page.evaluate(() => {
      const tip = document.querySelector('.wp-rail-item .wp-nav-tooltip') as HTMLElement | null;
      const item = tip?.closest('.wp-rail-item') as HTMLElement | null;
      if (!tip || !item) return null;
      const t = tip.getBoundingClientRect();
      const i = item.getBoundingClientRect();
      return { tipRight: t.right, itemLeft: i.left };
    });
    expect(rtlSides).not.toBeNull();
    // RTL: tooltip's right edge sits before the rail item's left edge.
    expect(rtlSides!.tipRight).toBeLessThanOrEqual(rtlSides!.itemLeft);

    // Sanity: the rail stays anchored to the inline-start edge of the
    // viewport (which is the right side in RTL).
    const railRect = await page.locator('#nav-rail').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, vw: window.innerWidth };
    });
    expect(railRect.right).toBeCloseTo(railRect.vw, 0);
  });

  // ---------------------------------------------------------------------
  // RTL: search, pin, and the "No results" empty state still work end
  // to end. This is the smoke pass the task description calls out — the
  // detailed behaviours are already covered above under LTR; here we
  // just want to confirm none of them silently broke under dir="rtl".
  // ---------------------------------------------------------------------
  test('RTL: pin / search / empty state still wire up under dir="rtl"', async ({ page }) => {
    await bootstrap(page, 'ar');
    await page.goto(`${BASE_URL}/feedback`);
    await waitForRailReady(page);
    await page.waitForFunction(
      () => document.documentElement.getAttribute('dir') === 'rtl',
      { timeout: 5000 },
    );

    // Pin → Pinned group appears. Use the public togglePin() API for
    // the same reasoning as the LTR pin/unpin test (the in-row pin
    // button is gated by hover CSS + a collapsed accordion, neither
    // of which is what this assertion is about).
    await page.evaluate(() => (window as any).ExampleOrgNav.togglePin('audits'));
    await expect(page.locator('[data-testid="button-group-pinned"]')).toBeVisible();
    const stored = await page.evaluate((k) => localStorage.getItem(k), PIN_KEY);
    expect(JSON.parse(stored as string)).toEqual(['audits']);

    // Search highlight + empty state.
    const search = page.locator('[data-testid="input-nav-search"]');
    await search.fill('zzznosuchlabelzzz');
    await expect(page.locator('#wp-nav-empty')).toBeVisible();
    await search.fill('');
    await expect(page.locator('#wp-nav-empty')).toBeHidden();
  });
});
