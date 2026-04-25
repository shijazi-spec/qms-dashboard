/**
 * WalaPlus real-export-endpoint smoke test
 *
 * The existing cross-browser streaming-download test (tests/streamingDownload.spec.ts)
 * intercepts the export URL with Playwright's `context.route()` and serves a
 * fixed in-memory CSV. That isolates the frontend streaming pipeline from the
 * backend deliberately — but it means a regression in a real export endpoint
 * (wrong content-type, missing Content-Disposition, broken transfer-encoding,
 * bad SQL query) would pass as a green build.
 *
 * This test downloads from the live `/api/policies/export` route on Chromium
 * without any route interception and asserts:
 *
 *   1. The server returns HTTP 200.
 *   2. The Content-Type is `text/csv` (with optional charset suffix).
 *   3. A Content-Disposition header is present and marks the response as an
 *      attachment.
 *   4. The body is a well-formed CSV: at least one header row, followed by
 *      zero or more data rows (an empty table is fine — this is a dev/CI
 *      database).
 *
 * Authentication: mirrors the pattern from streamingDownload.spec.ts —
 * POST `/api/admin/auth` with `ADMIN_API_KEY` (or `TEST_ADMIN_KEY`) to
 * obtain the `admin_key` session cookie, then use that cookie for the
 * export request.
 *
 * Only Chromium is needed for a backend regression test; cross-engine
 * coverage of the *frontend* streaming pipeline is handled by the
 * complementary cross-browser smoke test.
 */

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';

/**
 * Parse a raw CSV string into rows.
 * Handles the simple case produced by the server (no embedded newlines inside
 * quoted fields needed for the header-validity assertion; we only need to
 * count rows, not reparse values).
 */
function parseCsvRows(csv: string): string[][] {
  return csv
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(','));
}

test.describe('Real export endpoint — backend smoke (Chromium)', () => {
  test('GET /api/policies/export returns a valid CSV', async ({ context }) => {
    test.setTimeout(60_000);

    // Authenticate with the admin key to receive the admin_key session cookie.
    const adminKey = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY;
    if (!adminKey) {
      if (process.env.CI === 'true') {
        throw new Error(
          'CI: ADMIN_API_KEY / TEST_ADMIN_KEY missing — cannot authenticate ' +
            'against the real export endpoint. Refusing to skip the test.',
        );
      }
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not configured — skipping locally');
    }

    const authRes = await context.request.post(`${BASE_URL}/api/admin/auth`, {
      data: { key: adminKey },
      headers: { 'Content-Type': 'application/json' },
    });

    expect(
      authRes.status(),
      `Admin auth failed with status ${authRes.status()} — check ADMIN_API_KEY`,
    ).toBe(200);

    // Hit the real export endpoint. Playwright's APIRequestContext automatically
    // forwards the admin_key cookie set by the auth response above.
    const exportRes = await context.request.get(
      `${BASE_URL}/api/policies/export`,
      { timeout: 45_000 },
    );

    // ── 1. HTTP status ────────────────────────────────────────────────────────
    expect(
      exportRes.status(),
      `Expected HTTP 200 from /api/policies/export, got ${exportRes.status()}`,
    ).toBe(200);

    // ── 2. Content-Type ───────────────────────────────────────────────────────
    const contentType = exportRes.headers()['content-type'] ?? '';
    expect(
      contentType.toLowerCase(),
      `Expected content-type to contain "text/csv", got "${contentType}"`,
    ).toContain('text/csv');

    // ── 3. Content-Disposition ────────────────────────────────────────────────
    const disposition = exportRes.headers()['content-disposition'] ?? '';
    expect(
      disposition.toLowerCase(),
      `Expected Content-Disposition to contain "attachment", got "${disposition}"`,
    ).toContain('attachment');

    // ── 4. CSV structure ──────────────────────────────────────────────────────
    const body = await exportRes.text();

    expect(
      body.length,
      'Export body must not be empty — expected at least a CSV header row',
    ).toBeGreaterThan(0);

    const rows = parseCsvRows(body);

    // At least the header row must be present.
    expect(
      rows.length,
      `Expected at least 1 row (the header) in the CSV; got ${rows.length}`,
    ).toBeGreaterThanOrEqual(1);

    // The known header columns exported by /api/policies/export.
    const EXPECTED_HEADERS = [
      'ID',
      'Doc Number',
      'Policy Number',
      'Title',
      'Type',
      'Category',
      'Status',
      'Confidentiality',
      'Owner',
      'Department',
      'Version',
      'Effective Date',
      'Review Date',
      'Tags',
      'Created',
    ];

    const headerRow = rows[0];
    // Strip BOM and whitespace that streaming might prepend.
    const normalizedHeader = headerRow.map((h) => h.replace(/^\uFEFF/, '').trim());

    expect(
      normalizedHeader,
      `CSV header row mismatch.\nExpected: ${JSON.stringify(EXPECTED_HEADERS)}\nGot:      ${JSON.stringify(normalizedHeader)}`,
    ).toEqual(EXPECTED_HEADERS);

    // Log the data-row count so CI triagers can see how many rows were exported.
    const dataRowCount = rows.length - 1;
    console.log(
      `[real-export-smoke] /api/policies/export returned ${dataRowCount} data row(s) plus the header.`,
    );
  });
});
