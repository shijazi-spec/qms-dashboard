/**
 * ExampleOrg Duplicate Radar — per-tab Advanced Filters wiring test
 *
 * The Advanced Filters panel (Module, Owner, Layout, Pipeline, Stage,
 * Confidence, Domain, Date Range) must filter the rows shown INSIDE each
 * per-module record tab (Leads/Deals/Contacts/Accounts), not just drive the
 * Domain Clusters view. This spec verifies the frontend wiring deterministically
 * by stubbing window.fetch and asserting that:
 *
 *   1. loadRecordTab folds the active filter selections into its request, and
 *   2. clicking Apply while a record tab is active re-queries THAT tab's
 *      endpoint (in-place) rather than jumping to /filtered-clusters.
 *
 * Auth mirrors the per-tab export spec: a valid X-Admin-Key header stands in
 * for an OIDC session on the gated /duplicates page.
 */
import { test, expect, type BrowserContext } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || '<REDACTED_URL>';

async function authenticate(context: BrowserContext): Promise<boolean> {
  const adminKey = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY;
  if (!adminKey) return false;
  await context.setExtraHTTPHeaders({ 'X-Admin-Key': adminKey });
  return true;
}

test.describe('Duplicate Radar — per-tab Advanced Filters', () => {
  test.beforeEach(async ({ context }) => {
    const ok = await authenticate(context);
    if (!ok) {
      if (process.env.CI === 'true') {
        throw new Error('CI: ADMIN_API_KEY / TEST_ADMIN_KEY missing or rejected');
      }
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not configured');
    }
  });

  test('Apply filters the active Deals tab in-place with the selected layout', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`${BASE_URL}/duplicates`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => typeof (window as any).loadRecordTab === 'function'
        && typeof (window as any).applyAdvancedFilters === 'function'
        && typeof (window as any).showTab === 'function',
    );

    // Capture every /api/duplicates/* request URL the page makes after we
    // start recording, so we can assert the filter params were forwarded.
    await page.evaluate(() => {
      (window as any).__capturedUrls = [];
      const origFetch = window.fetch.bind(window);
      window.fetch = ((input: any, init?: any) => {
        const u = typeof input === 'string' ? input : (input && input.url) || '';
        if (typeof u === 'string' && u.includes('/api/duplicates/')) {
          (window as any).__capturedUrls.push(u);
        }
        return origFetch(input, init);
      }) as any;
    });

    // Activate the Deals tab and seed a Layout filter selection.
    await page.evaluate(() => {
      (window as any).showTab('deals');
      const layout = document.getElementById('filterLayout') as HTMLSelectElement;
      // Inject a known option and select it (dev data may have no layouts).
      layout.innerHTML = '<option value="ExampleOrg">ExampleOrg</option>';
      layout.options[0].selected = true;
    });

    // Clear anything captured during showTab's lazy load, then Apply.
    await page.evaluate(() => { (window as any).__capturedUrls = []; });
    await page.evaluate(async () => { await (window as any).applyAdvancedFilters(); });

    const urls: string[] = await page.evaluate(() => (window as any).__capturedUrls);

    // Apply must hit the Deals endpoint with the layout filter, and must NOT
    // fall back to the cluster-wide filtered-clusters endpoint.
    const dealsReq = urls.find((u) => u.includes('/api/duplicates/deals'));
    expect(dealsReq, `expected a /api/duplicates/deals request, got: ${urls.join(' | ')}`).toBeTruthy();
    expect(dealsReq!).toContain('layouts=ExampleOrg');
    expect(urls.some((u) => u.includes('/filtered-clusters'))).toBeFalsy();
  });
});
