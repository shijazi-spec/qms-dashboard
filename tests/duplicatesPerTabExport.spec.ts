/**
 * WalaPlus Duplicate Radar — per-tab "Export CSV" smoke test
 *
 * The three browser-rendered tabs (CS Lifecycle, CS Pipeline Overlap,
 * Account Hints) build their CSV entirely client-side from the in-memory
 * data cache, so the download must reflect EXACTLY what's on screen: the
 * same rows, the same columns, the current applied sort order, and the
 * active status/verdict filter — not the server's generic full-radar dump.
 *
 * This spec loads the gated /duplicates page (admin auth), seeds each tab's
 * window data cache + sort state with a tiny known fixture, invokes the
 * page's real export function, captures the download, and asserts the CSV
 * bytes — header row, row order, and a CSV-injection guard.
 *
 * It deliberately seeds window state instead of running a live scan so the
 * assertion is deterministic and independent of whatever data happens to be
 * in the dev database.
 */
import { test, expect, type BrowserContext } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';

async function authenticate(context: BrowserContext): Promise<boolean> {
  const adminKey = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY;
  if (!adminKey) return false;
  const res = await context.request.post(`${BASE_URL}/api/admin/auth`, {
    data: { key: adminKey },
    headers: { 'Content-Type': 'application/json' },
  });
  return res.status() === 200;
}

async function readDownload(downloadPromise: Promise<import('@playwright/test').Download>): Promise<string> {
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf-8');
}

test.describe('Duplicate Radar — per-tab Export CSV', () => {
  test.beforeEach(async ({ context }) => {
    const ok = await authenticate(context);
    if (!ok) {
      if (process.env.CI === 'true') {
        throw new Error('CI: ADMIN_API_KEY / TEST_ADMIN_KEY missing or rejected by /api/admin/auth');
      }
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not configured');
    }
  });

  test('CS Lifecycle exports grouped violations in the applied sort order', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`${BASE_URL}/duplicates`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as any).exportCsLifecycle === 'function');

    // Two deals, each with a violation. Account "Beta" (warning) and "Alpha"
    // (critical). Default sort is severity desc, so Alpha (critical) must come
    // first even though Beta is earlier in the source array.
    await page.evaluate(() => {
      (window as any)._csLifecycleSort = { key: 'severity', dir: 'desc' };
      (window as any)._csLifecycleData = {
        violations: [
          {
            record_id: 1, zoho_record_id: 'z1', account_name: 'Beta Corp', domain: 'beta.com',
            current_phase: 'renewal', days_since_modified: 10, cs_owner_name: 'Sara',
            customer_since: '2023-01-01', renewal_date: '2025-01-01', churn_date: '', health: 'green',
            violation: { code: 'renewal_overdue', severity: 'warning', message: 'Renewal overdue' },
          },
          {
            record_id: 2, zoho_record_id: 'z2', account_name: 'Alpha Inc', domain: 'alpha.com',
            current_phase: 'onboarding', days_since_modified: 3, cs_owner_name: 'Omar',
            customer_since: '2024-06-01', renewal_date: '', churn_date: '', health: 'red',
            violation: { code: 'missing_owner', severity: 'critical', message: 'No CS owner' },
          },
        ],
        summary: { by_severity: { critical: 1, warning: 1, info: 0 }, total_cs_deals: 2, total_violations: 2 },
      };
    });

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.evaluate(() => (window as any).exportCsLifecycle());
    const csv = await readDownload(downloadPromise);
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');

    expect(lines[0]).toBe('Severity,Account,Domain,Phase,CS Owner,Customer Since,Renewal Date,Churn Date,Health,Days Since Modified,Violations,Messages');
    // critical (Alpha) sorts above warning (Beta)
    expect(lines[1]).toContain('critical,Alpha Inc,alpha.com');
    expect(lines[1]).toContain('Omar');
    expect(lines[2]).toContain('warning,Beta Corp,beta.com');
  });

  test('CS Overlap exports clusters in the applied sort order', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`${BASE_URL}/duplicates`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as any).exportCsOverlap === 'function');

    // Sort by ARR desc → the 90k cluster must precede the 10k cluster.
    await page.evaluate(() => {
      (window as any)._csOverlapSort = { key: 'arr', dir: 'desc' };
      (window as any)._csOverlapData = {
        clusters: [
          { id: 1, cs_overlap_verdict: 'warn', domain: 'low.com', company_name: 'Low ARR Co', client_sector: 'private', pipeline_lifecycle_state: 'adoption', arr_exposure: 10000, total_records: 2, updated_at: '2025-05-01T00:00:00Z' },
          { id: 2, cs_overlap_verdict: 'block', domain: 'high.com', company_name: 'High ARR Co', client_sector: 'government', pipeline_lifecycle_state: 'renewal', arr_exposure: 90000, total_records: 5, updated_at: '2025-05-02T00:00:00Z' },
        ],
        summary: {},
      };
    });

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.evaluate(() => (window as any).exportCsOverlap());
    const csv = await readDownload(downloadPromise);
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');

    expect(lines[0]).toBe('Verdict,Domain,Company,Sector,Phase,ARR Exposure,Records,Updated');
    expect(lines[1]).toContain('BLOCK,high.com,High ARR Co,Government');
    expect(lines[1]).toContain('90000');
    expect(lines[2]).toContain('WARN,low.com,Low ARR Co,Private');
  });

  test('Account Hints exports rows in displayed order with a CSV-injection guard', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`${BASE_URL}/duplicates`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as any).exportAccountHints === 'function');

    await page.evaluate(() => {
      (window as any)._accountHintsData = {
        hints: [
          { id: 1, deal_company_name: '=cmd|calc', deal_account_name: '', suggested_account_name: 'Acme', suggested_domain: 'acme.com', evidence_contact_email: 'a@acme.com', confidence: 88, status: 'pending' },
          { id: 2, deal_company_name: 'Globex', deal_account_name: 'Globex LLC', suggested_account_name: 'Globex Corp', suggested_domain: 'globex.com', evidence_contact_email: 'b@globex.com', confidence: 61, status: 'pending' },
        ],
        summary: { pending: 2, applied: 0, dismissed: 0 },
      };
    });

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.evaluate(() => (window as any).exportAccountHints());
    const csv = await readDownload(downloadPromise);
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');

    expect(lines[0]).toBe('Deal,Deal Account (current),Suggested Account,Suggested Domain,Evidence Contact,Confidence %,Status');
    // Formula-looking value is neutralized with a leading apostrophe then quoted.
    expect(lines[1]).toContain(`"'=cmd|calc"`);
    expect(lines[1]).toContain('Acme,acme.com,a@acme.com,88,pending');
    expect(lines[2]).toContain('Globex,Globex LLC,Globex Corp');
  });
});
