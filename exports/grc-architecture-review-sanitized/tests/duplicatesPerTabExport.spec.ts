/**
 * ExampleOrg Duplicate Radar — per-tab "Export CSV" smoke test
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

const BASE_URL = process.env.BASE_URL || '<REDACTED_URL>';

// The page gate (src/mastra/middleware) accepts a valid X-Admin-Key header in
// lieu of an OIDC session for non-public routes, so we set it on every request
// the browser makes (including the /duplicates navigation itself). We set the
// header directly rather than POSTing to /api/admin/auth — that endpoint only
// verifies the key (it sets no cookie) and is tightly rate-limited, which would
// flake the suite when several tests run back-to-back.
async function authenticate(context: BrowserContext): Promise<boolean> {
  const adminKey = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY;
  if (!adminKey) return false;
  await context.setExtraHTTPHeaders({ 'X-Admin-Key': adminKey });
  return true;
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
            record_id: 1, CRMProvider_record_id: 'z1', account_name: 'Example Organization', domain: '<REDACTED_HOST>',
            current_phase: 'renewal', days_since_modified: 10, cs_owner_name: 'Sara',
            customer_since: '2023-01-01', renewal_date: '2025-01-01', churn_date: '', health: 'green',
            violation: { code: 'renewal_overdue', severity: 'warning', message: 'Renewal overdue' },
          },
          {
            record_id: 2, CRMProvider_record_id: 'z2', account_name: 'Example Organization', domain: '<REDACTED_HOST>',
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
    expect(lines[1]).toContain('critical,Alpha Inc,<REDACTED_HOST>');
    expect(lines[1]).toContain('Omar');
    expect(lines[2]).toContain('warning,Beta Corp,<REDACTED_HOST>');
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
          { id: 1, cs_overlap_verdict: 'warn', domain: '<REDACTED_HOST>', company_name: 'Example Organization', client_sector: 'private', pipeline_lifecycle_state: 'adoption', arr_exposure: 10000, total_records: 2, updated_at: '2025-05-01T00:00:00Z' },
          { id: 2, cs_overlap_verdict: 'block', domain: '<REDACTED_HOST>', company_name: 'Example Organization', client_sector: 'government', pipeline_lifecycle_state: 'renewal', arr_exposure: 90000, total_records: 5, updated_at: '2025-05-02T00:00:00Z' },
        ],
        summary: {},
      };
    });

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.evaluate(() => (window as any).exportCsOverlap());
    const csv = await readDownload(downloadPromise);
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');

    expect(lines[0]).toBe('Verdict,Domain,Company,Sector,Phase,ARR Exposure,Records,Updated');
    expect(lines[1]).toContain('BLOCK,<REDACTED_HOST>,High ARR Co,Government');
    expect(lines[1]).toContain('90000');
    expect(lines[2]).toContain('WARN,<REDACTED_HOST>,Low ARR Co,Private');
  });

  test('Account Hints exports rows in displayed order with a CSV-injection guard', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`${BASE_URL}/duplicates`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as any).exportAccountHints === 'function');

    await page.evaluate(() => {
      (window as any)._accountHintsData = {
        hints: [
          { id: 1, deal_company_name: '=cmd|calc', deal_account_name: '', suggested_account_name: 'Example Organization', suggested_domain: '<REDACTED_HOST>', evidence_contact_email: 'user@example.invalid', confidence: 88, status: 'pending' },
          { id: 2, deal_company_name: 'Example Organization', deal_account_name: 'Example Organization LLC', suggested_account_name: 'Example Organization Corp', suggested_domain: '<REDACTED_HOST>', evidence_contact_email: 'user@example.invalid', confidence: 61, status: 'pending' },
        ],
        summary: { pending: 2, applied: 0, dismissed: 0 },
      };
    });

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.evaluate(() => (window as any).exportAccountHints());
    const csv = await readDownload(downloadPromise);
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');

    expect(lines[0]).toBe('Deal,Deal Account (current),Suggested Account,Suggested Domain,Evidence Contact,Confidence %,Status');
    // Formula-looking value is neutralized with a leading apostrophe (no comma
    // in the value, so it isn't additionally quoted).
    expect(lines[1].startsWith("'=cmd|calc,")).toBe(true);
    expect(lines[1]).toContain('Example Organization,<REDACTED_HOST>,user@example.invalid,88,pending');
    expect(lines[2]).toContain('Example Organization,Example Organization LLC,Example Organization Corp');
  });

  test('Cross-Module exports only the clusters matching the active pairing filter', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`${BASE_URL}/duplicates`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as any).exportCrossModule === 'function');

    // Seed two clusters of different pairings, then pin the filter to one
    // pairing so the export must drop the non-matching cluster — proving the
    // export reflects the tab's current view, not the full radar.
    // crossModuleClusters / crossModuleFilter are top-level `let` bindings
    // (the renderer's real data source), not window properties — assign them by
    // bare name so the exporter reads the same view the table renders.
    const clusters = [
      { id: 1, pairing: 'lead_contact', domain: '<REDACTED_HOST>', company_name: 'Example Organization', total_leads: 1, total_contacts: 2, total_accounts: 0, total_deals: 0, total_records: 3, confidence_score: 92, estimated_pipeline_value: 50000 },
      { id: 2, pairing: 'mixed', domain: '<REDACTED_HOST>', company_name: 'Example Organization', total_leads: 0, total_contacts: 1, total_accounts: 1, total_deals: 1, total_records: 3, confidence_score: 70, estimated_pipeline_value: 12000 },
    ];
    await page.evaluate((seed) => {
      // @ts-ignore - assign to the page's top-level lexical bindings
      crossModuleClusters = seed;
      // @ts-ignore
      crossModuleFilter = 'lead_contact';
    }, clusters);

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.evaluate(() => (window as any).exportCrossModule());
    const csv = await readDownload(downloadPromise);
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n').filter((l) => l.length > 0);

    expect(lines[0]).toBe('Pairing,Domain,Company,Modules,Records,Confidence %,Pipeline Value,Recommended Action');
    // Only the lead_contact cluster is exported; the mixed cluster is filtered out.
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('<REDACTED_HOST>,Alpha Inc');
    expect(lines[1]).toContain('Leads(1) · Contacts(2)');
    expect(csv).not.toContain('<REDACTED_HOST>');
  });
});
