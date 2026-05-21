/**
 * MCP Call Evaluation — backend smoke test
 *
 * Exercises routes added to src/mastra/routes/callIntelligenceRoutes.ts:
 *
 *   GET  /api/calls/mcp/import-sources
 *   POST /api/calls/mcp/leads/match-phone
 *   GET  /api/calls/mcp/reconciliation/:id
 *   GET  /api/calls/mcp/scorecard/:id
 *   POST /api/calls/:id/auto-link-lead
 *
 * Security model (post-fix):
 *   X-Admin-Key is scoped to /api/admin/* routes ONLY.  All /api/calls/mcp/*
 *   routes are authenticated-user routes that require a real OIDC session.
 *   An X-Admin-Key header on these routes is rejected with 401 by the global
 *   middleware before the handler runs.
 *
 * This file therefore tests two things:
 *   1. Unauthenticated requests (no auth at all) → 401.
 *   2. Admin-key-only requests (X-Admin-Key header, no session) → 401,
 *      confirming the key is NOT treated as a bypass for application routes.
 *
 * Full route-behavior smoke tests (400 input validation, 404 not-found, 200
 * happy-path) require a real OIDC-issued session and are deferred to the
 * session-authenticated integration test suite.
 */

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';

function resolveAdminKey(): string | null {
  const key = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY;
  return key || null;
}

test.describe('MCP Call Evaluation routes — auth enforcement', () => {
  test.describe.configure({ mode: 'serial' });

  // ── Unauthenticated (no credentials at all) ─────────────────────────────

  test('unauthenticated GET /import-sources returns 401', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/calls/mcp/import-sources`);
    expect(res.status()).toBe(401);
  });

  test('POST /leads/match-phone unauthenticated returns 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/calls/mcp/leads/match-phone`, {
      headers: { 'Content-Type': 'application/json' },
      data: { phone: '+966500000000' },
    });
    // 429 acceptable when the global rate limiter fires before auth check.
    expect([401, 429]).toContain(res.status());
  });

  test('GET /mcp/scorecard/:id unauthenticated returns 401', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/calls/mcp/scorecard/1`);
    expect(res.status()).toBe(401);
  });

  test('POST /:id/auto-link-lead unauthenticated returns 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/calls/1/auto-link-lead`, {
      headers: { 'Content-Type': 'application/json' },
      data: {},
    });
    // 401 is the happy path. 429 is acceptable when this test runs after a
    // burst of unauth POSTs in the same suite — the global rate limiter fires
    // before verifyCallAccess runs. Either way the route is not open.
    expect([401, 429]).toContain(res.status());
  });

  // ── Admin-key-only (key present but no session) ─────────────────────────
  // These tests verify that the X-Admin-Key header alone is NOT treated as a
  // valid credential for application routes (/api/calls/*).  The key is scoped
  // exclusively to /api/admin/* server-to-server paths.

  test('GET /import-sources with X-Admin-Key only → 401 (key not a session)', async ({ request }) => {
    const key = resolveAdminKey();
    test.skip(!key, 'ADMIN_API_KEY/TEST_ADMIN_KEY not set');

    const res = await request.get(`${BASE_URL}/api/calls/mcp/import-sources`, {
      headers: { 'X-Admin-Key': key! },
    });
    expect(res.status(), `expected 401 (key scoped to /api/admin/* only), got ${res.status()}`).toBe(401);
  });

  test('GET /reconciliation/:id with X-Admin-Key only → 401', async ({ request }) => {
    const key = resolveAdminKey();
    test.skip(!key, 'ADMIN_API_KEY/TEST_ADMIN_KEY not set');

    const res = await request.get(`${BASE_URL}/api/calls/mcp/reconciliation/99999999`, {
      headers: { 'X-Admin-Key': key! },
    });
    expect(res.status(), `expected 401, got ${res.status()}`).toBe(401);
  });

  test('POST /leads/match-phone with X-Admin-Key only → 401', async ({ request }) => {
    const key = resolveAdminKey();
    test.skip(!key, 'ADMIN_API_KEY/TEST_ADMIN_KEY not set');

    const res = await request.post(`${BASE_URL}/api/calls/mcp/leads/match-phone`, {
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key! },
      data: { phone: '+966500000000', max_records: 10 },
    });
    expect(res.status(), `expected 401, got ${res.status()}`).toBe(401);
  });

  test('GET /mcp/scorecard/:id with X-Admin-Key only → 401', async ({ request }) => {
    const key = resolveAdminKey();
    test.skip(!key, 'ADMIN_API_KEY/TEST_ADMIN_KEY not set');

    const res = await request.get(`${BASE_URL}/api/calls/mcp/scorecard/abc`, {
      headers: { 'X-Admin-Key': key! },
    });
    expect(res.status(), `expected 401, got ${res.status()}`).toBe(401);
  });

  test('POST /:id/auto-link-lead with X-Admin-Key only → 401', async ({ request }) => {
    const key = resolveAdminKey();
    test.skip(!key, 'ADMIN_API_KEY/TEST_ADMIN_KEY not set');

    const res = await request.post(`${BASE_URL}/api/calls/99999999/auto-link-lead`, {
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key! },
      data: {},
    });
    expect(res.status(), `expected 401, got ${res.status()}`).toBe(401);
  });
});
