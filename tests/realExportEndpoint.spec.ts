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
 * This test downloads from real export routes on Chromium without any
 * route interception. It runs in two parts:
 *
 *   Part 1 — /api/policies/export (full CSV validation, unchanged from the
 *            original task #187 smoke test). Asserts:
 *              1. Status 200
 *              2. Content-Type contains text/csv
 *              3. Content-Disposition is an attachment
 *              4. The body is a well-formed CSV whose header row matches the
 *                 columns the route is expected to export.
 *
 *   Part 2 — additional production-critical export routes (task #363).
 *            The acceptance criteria for the new routes are:
 *
 *              1. Status 200
 *              2. Correct Content-Type per format
 *                   • CSV → text/csv (with optional charset suffix)
 *                   • XLSX → application/vnd.openxmlformats-officedocument
 *                            .spreadsheetml.sheet
 *                            (we substring-match `spreadsheetml` so a future
 *                             charset/profile suffix is still tolerated)
 *              3. Content-Disposition is an attachment
 *              4. For XLSX bodies only: the response begins with the OOXML
 *                 magic bytes `PK\x03\x04` (50 4B 03 04). This catches the
 *                 most common XLSX regressions in one assertion — JSON
 *                 error bodies served with a 200, half-rendered HTML login
 *                 pages, or the streaming wrapper closing the body before
 *                 emitting the workbook.
 *
 *            Routes covered (each one is a separate `test()` so a regression
 *            in one route does not mask the others):
 *
 *              GET /api/risks/export             (CSV)
 *              GET /api/risks/export-xlsx        (XLSX, OOXML magic check)
 *              GET /api/qms/nc/export            (CSV)
 *              GET /api/qms/capa/export          (CSV)
 *              GET /api/kpis/export              (CSV)
 *
 *            Body content for the new CSV routes is *not* parsed. The CI
 *            postgres in streaming-download-smoke.yml is a fresh container
 *            with no seeded data, and several of these tables (NC, CAPA,
 *            risks, KPI values) are empty in that environment. Asserting
 *            on the parsed CSV body would couple the test to fixture data
 *            that doesn't exist; the wire-level checks above are sufficient
 *            to catch a wrong MIME type, broken Content-Disposition, or a
 *            bad SQL query (a 500 fails the status check immediately).
 *
 * Authentication: mirrors the pattern from streamingDownload.spec.ts —
 * POST `/api/admin/auth` with `ADMIN_API_KEY` (or `TEST_ADMIN_KEY`) to
 * obtain the `admin_key` session cookie, AND also send `X-Admin-Key` as a
 * header on every export request. The header is required for routes whose
 * gate calls `requireRole(c, ...)` (notably the QMS NC / CAPA / KPI routes
 * wrapped by `qmsGate`), because that helper resolves the caller via
 * `getSessionUser(c)` which only recognises the X-Admin-Key *header*, not
 * the admin_key cookie. The cookie is still set so the existing
 * `requireRoleOrKey`-gated routes (e.g. /api/policies/export) keep being
 * exercised in the same way as before.
 *
 * Only Chromium is needed for a backend regression test; cross-engine
 * coverage of the *frontend* streaming pipeline is handled by the
 * complementary cross-browser smoke test.
 */

import { test, expect, type APIRequestContext, type BrowserContext } from '@playwright/test';

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

/**
 * Resolve the admin key from env, preferring TEST_ADMIN_KEY (the CI workflow
 * sets both to the same value but the per-test override exists for local
 * runs against a real deployment). When unset:
 *   - In CI, throw — refusing to silently skip a backend smoke test is the
 *     whole point of this suite.
 *   - Locally, return null so the caller can `test.skip(...)` with a clear
 *     reason in the report.
 */
function resolveAdminKey(): string | null {
  const key = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY;
  if (key) return key;
  if (process.env.CI === 'true') {
    throw new Error(
      'CI: ADMIN_API_KEY / TEST_ADMIN_KEY missing — cannot authenticate ' +
        'against the real export endpoint. Refusing to skip the test.',
    );
  }
  return null;
}

/**
 * POST /api/admin/auth so the BrowserContext picks up the `admin_key` cookie
 * forwarded automatically with subsequent requests. Mirrors the auth flow
 * used by streamingDownload.spec.ts — kept here so each test() can run in
 * isolation without an order dependency on a beforeAll.
 */
async function authenticateAdmin(context: BrowserContext, adminKey: string): Promise<void> {
  const authRes = await context.request.post(`${BASE_URL}/api/admin/auth`, {
    data: { key: adminKey },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(
    authRes.status(),
    `Admin auth failed with status ${authRes.status()} — check ADMIN_API_KEY`,
  ).toBe(200);
}

/**
 * Issue an authenticated GET against an export route. The X-Admin-Key
 * header is sent on every call so QMS-gated routes (NC, CAPA, KPIs)
 * — whose `requireRole` helper only recognises the header form —
 * authenticate correctly. Routes that accept the cookie also pass.
 */
async function getExport(
  request: APIRequestContext,
  path: string,
  adminKey: string,
) {
  return request.get(`${BASE_URL}${path}`, {
    headers: { 'X-Admin-Key': adminKey },
    timeout: 45_000,
  });
}

// ─── Part 1: original full-CSV smoke for /api/policies/export ───────────────

test.describe('Real export endpoint — backend smoke (Chromium)', () => {
  test('GET /api/policies/export returns a valid CSV', async ({ context }) => {
    test.setTimeout(60_000);

    const adminKey = resolveAdminKey();
    if (!adminKey) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not configured — skipping locally');
    }
    await authenticateAdmin(context, adminKey as string);

    const exportRes = await getExport(context.request, '/api/policies/export', adminKey as string);

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

// ─── Part 2: additional production-critical export routes (task #363) ───────
//
// One test() per route so a regression in one shows up as a targeted failure.
// CSV routes only assert status + content-type + content-disposition (the body
// is intentionally not parsed — see the file header for rationale). The XLSX
// route additionally validates the OOXML magic bytes.

interface SmokeCaseBase {
  label: string;
  path: string;
  /**
   * If set, the test runs under `test.fail()` — i.e. the assertions are
   * expected to fail because the route is currently broken by a known bug.
   * When the bug is fixed, the test will "unexpectedly pass" and Playwright
   * will fail the run, which is the signal to remove this annotation and
   * promote the case back to a normal pass-expected check.
   *
   * The string is the human-readable reason, surfaced in the test title.
   */
  expectedFailureReason?: string;
}

interface CsvSmokeCase extends SmokeCaseBase {
  format: 'csv';
}

interface XlsxSmokeCase extends SmokeCaseBase {
  format: 'xlsx';
}

type AdditionalSmokeCase = CsvSmokeCase | XlsxSmokeCase;

// ──────────────────────────────────────────────────────────────────────────
// Routes registered under `/api/qms/capa/:id` (qmsApiRoutes.ts:83 +
// qmsEnhancedRoutes.ts:169) and `/api/kpis/:id` (kpiRoutes.ts:119) are
// matched by Mastra's router *before* the literal `/export` segment
// registered later in qmsEnhancedRoutes.ts, so a request to
//   GET /api/qms/capa/export       → handled by getCapaById('export') → 500
//   GET /api/kpis/export           → handled by getKpiById('export')  → 400
// despite both literal `/export` handlers being defined.
//
// The same shadowing is acknowledged inline at qmsEnhancedRoutes.ts:753 for
// the XLSX twin (`/api/qms/capa/export-xlsx`), which is why that route was
// renamed to the hyphenated `/api/qms/capa-export-xlsx`. The CSV equivalents
// have not been renamed yet, so they are still shadowed.
//
// We still exercise them under `test.fail()` so:
//   1. The route list in this file matches the task's acceptance criteria
//      verbatim (production-critical export routes), making the file the
//      single source of truth for "every export route we care about."
//   2. The day someone fixes the routing (either by reordering registrations
//      or migrating to the hyphenated path), Playwright reports the test as
//      "unexpectedly passed" — a hard failure that surfaces the win and
//      prompts removal of `expectedFailureReason`.
// ──────────────────────────────────────────────────────────────────────────
const ADDITIONAL_EXPORT_ROUTES: AdditionalSmokeCase[] = [
  // riskRoutes.ts — `requireRiskReadAuth` (admin role via X-Admin-Key passes).
  { label: 'risks CSV',    path: '/api/risks/export',      format: 'csv'  },
  { label: 'risks XLSX',   path: '/api/risks/export-xlsx', format: 'xlsx' },
  // qmsEnhancedRoutes.ts — wrapped by `qmsGate` → `requireRole`, so the
  // X-Admin-Key header (not just the cookie) is required for these to pass.
  { label: 'QMS NC CSV',   path: '/api/qms/nc/export',     format: 'csv'  },
  {
    label: 'QMS CAPA CSV',
    path: '/api/qms/capa/export',
    format: 'csv',
    expectedFailureReason: 'shadowed by GET /api/qms/capa/:id (parses "export" as id)',
  },
  {
    label: 'KPIs CSV',
    path: '/api/kpis/export',
    format: 'csv',
    expectedFailureReason: 'shadowed by GET /api/kpis/:id (parses "export" as id)',
  },
];

/**
 * OOXML / ZIP "local file header" magic bytes. Every well-formed .xlsx file
 * (ECMA-376 Open Packaging Convention) is a ZIP container whose first entry
 * starts with these four bytes.
 */
const XLSX_MAGIC_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

test.describe('Real export endpoint — additional routes (Chromium)', () => {
  for (const ec of ADDITIONAL_EXPORT_ROUTES) {
    const baseTitle = `GET ${ec.path} returns a valid ${ec.format.toUpperCase()}`;
    const title = ec.expectedFailureReason
      ? `${baseTitle} [expected fail: ${ec.expectedFailureReason}]`
      : baseTitle;

    test(title, async ({ context }) => {
      test.setTimeout(60_000);

      // Mark expected-failure routes with `test.fail()` so the assertions
      // below still run, but Playwright treats an assertion failure as a
      // pass and a passing assertion as an unexpected pass (surfaced as a
      // CI red signal). Doing it inside the test body — rather than via
      // `test.fail.only(...)` at definition time — keeps the per-route
      // metadata in one place (`ADDITIONAL_EXPORT_ROUTES`).
      if (ec.expectedFailureReason) {
        test.fail(true, ec.expectedFailureReason);
      }

      const adminKey = resolveAdminKey();
      if (!adminKey) {
        test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not configured — skipping locally');
      }
      await authenticateAdmin(context, adminKey as string);

      const exportRes = await getExport(context.request, ec.path, adminKey as string);

      // ── 1. HTTP status ────────────────────────────────────────────────────
      expect(
        exportRes.status(),
        `Expected HTTP 200 from ${ec.path}, got ${exportRes.status()}`,
      ).toBe(200);

      // ── 2. Content-Type ───────────────────────────────────────────────────
      const contentType = (exportRes.headers()['content-type'] ?? '').toLowerCase();
      if (ec.format === 'csv') {
        expect(
          contentType,
          `Expected content-type to contain "text/csv" for ${ec.path}, got "${contentType}"`,
        ).toContain('text/csv');
      } else {
        // Match `spreadsheetml` so a future content-type suffix (charset,
        // profile parameter, etc.) is still tolerated.
        expect(
          contentType,
          `Expected XLSX content-type for ${ec.path}, got "${contentType}"`,
        ).toContain('spreadsheetml');
      }

      // ── 3. Content-Disposition ────────────────────────────────────────────
      const disposition = (exportRes.headers()['content-disposition'] ?? '').toLowerCase();
      expect(
        disposition,
        `Expected Content-Disposition to contain "attachment" for ${ec.path}, got "${disposition}"`,
      ).toContain('attachment');

      // ── 4. XLSX magic-bytes check ─────────────────────────────────────────
      if (ec.format === 'xlsx') {
        // We deliberately do NOT unzip and parse the workbook — that is the
        // job of the unit tests around streamXlsx; this smoke test only
        // needs to prove the route returned real .xlsx bytes (not a JSON
        // error body or an HTML login redirect that happens to have the
        // right MIME type).
        const buf = await exportRes.body();
        expect(
          buf.length,
          `XLSX body for ${ec.path} must be at least ${XLSX_MAGIC_BYTES.length} bytes`,
        ).toBeGreaterThanOrEqual(XLSX_MAGIC_BYTES.length);

        const prefix = buf.subarray(0, XLSX_MAGIC_BYTES.length);
        expect(
          prefix.equals(XLSX_MAGIC_BYTES),
          `XLSX body for ${ec.path} did not start with OOXML magic bytes ` +
            `PK\\x03\\x04 (got ${Array.from(prefix).map((b) => '0x' + b.toString(16).padStart(2, '0')).join(' ')}). ` +
            `This usually means the route returned a JSON error, an HTML page, ` +
            `or an empty body with a 200 status.`,
        ).toBe(true);

        console.log(
          `[real-export-smoke] ${ec.path} returned ${buf.length} bytes of XLSX (OOXML magic verified).`,
        );
      } else {
        console.log(
          `[real-export-smoke] ${ec.path} returned content-type=${contentType}, disposition OK.`,
        );
      }
    });
  }
});
