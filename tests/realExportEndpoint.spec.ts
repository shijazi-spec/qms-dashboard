/**
 * WalaPlus export endpoint auth-enforcement smoke test
 *
 * Previous intent (pre-security-fix): download real CSV/XLSX from export
 * routes and validate content-type + Content-Disposition headers.  That test
 * strategy relied on the X-Admin-Key header being accepted as a bypass
 * credential on /api/* application routes — a vulnerability now fixed.
 *
 * Current intent (post-fix): verify that export routes correctly REJECT
 * admin-key-only callers with 401.  The X-Admin-Key is scoped exclusively to
 * /api/admin/* server-to-server paths.  A caller supplying only the
 * X-Admin-Key header (no OIDC-issued walaplus_session cookie) must receive
 * 401 from the global middleware before the handler executes.
 *
 * Full content-validation smoke tests (status 200, correct CSV headers, OOXML
 * magic bytes, etc.) require a real OIDC session.  Those are deferred to a
 * session-authenticated integration test suite once a CI test-user mechanism
 * is available.
 *
 * Routes covered (one test per route — a targeted failure per route is the
 * signal that a route unexpectedly started accepting admin keys again):
 *
 *   GET /api/policies/export
 *   GET /api/risks/export
 *   GET /api/risks/export-xlsx
 *   GET /api/qms/nc/export
 *   GET /api/qms/capa/export
 *   GET /api/kpis/export
 *
 * Authentication used: X-Admin-Key header ONLY (no session cookie).
 * Expected result for every route: HTTP 401.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';

/**
 * Resolve the admin key from env, preferring TEST_ADMIN_KEY.  When unset:
 *   - In CI, throw — refusing to silently skip a security smoke test.
 *   - Locally, return null so the caller can test.skip with a clear message.
 */
function resolveAdminKey(): string | null {
  const key = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY;
  if (key) return key;
  if (process.env.CI === 'true') {
    throw new Error(
      'CI: ADMIN_API_KEY / TEST_ADMIN_KEY missing — cannot run admin-key ' +
        'rejection smoke test. Refusing to skip.',
    );
  }
  return null;
}

/**
 * Issue a GET request with only the X-Admin-Key header (no session cookie).
 * This is the credential that must be rejected on non-admin routes.
 */
async function getWithKeyOnly(
  request: APIRequestContext,
  path: string,
  adminKey: string,
) {
  return request.get(`${BASE_URL}${path}`, {
    headers: { 'X-Admin-Key': adminKey },
    timeout: 15_000,
  });
}

// ─── Unauthenticated (sanity-check baseline) ─────────────────────────────────

test.describe('Export routes — unauthenticated baseline', () => {
  test('GET /api/policies/export without credentials → 401', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/policies/export`);
    expect(res.status()).toBe(401);
  });
});

// ─── Admin-key-only rejection ─────────────────────────────────────────────────
//
// Each test sends the X-Admin-Key header (matching the configured key) but NO
// session cookie.  Every export route is an application route and must return
// 401 — confirming the key is correctly scoped to /api/admin/* only.

const EXPORT_ROUTES: { label: string; path: string }[] = [
  { label: 'policies CSV',  path: '/api/policies/export'      },
  { label: 'risks CSV',     path: '/api/risks/export'         },
  { label: 'risks XLSX',    path: '/api/risks/export-xlsx'    },
  { label: 'QMS NC CSV',    path: '/api/qms/nc/export'        },
  { label: 'QMS CAPA CSV',  path: '/api/qms/capa/export'      },
  { label: 'KPIs CSV',      path: '/api/kpis/export'          },
];

test.describe('Export routes — X-Admin-Key rejected on application routes', () => {
  for (const ec of EXPORT_ROUTES) {
    test(`GET ${ec.path} (${ec.label}) with X-Admin-Key only → 401`, async ({ request }) => {
      const adminKey = resolveAdminKey();
      if (!adminKey) {
        test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not configured — skipping locally');
      }

      const res = await getWithKeyOnly(request, ec.path, adminKey as string);

      expect(
        res.status(),
        `Expected HTTP 401 from ${ec.path} for key-only caller (X-Admin-Key is scoped to ` +
          `/api/admin/* only), got ${res.status()}`,
      ).toBe(401);
    });
  }
});
