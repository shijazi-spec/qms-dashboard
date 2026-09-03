/**
 * HTTP integration test for the streaming-export latency budget.
 *
 * The Playwright smoke test (tests/streamingDownload.spec.ts) only checks
 * the latency of an intercepted ~80-byte CSV against the dashboard's
 * service-worker pipeline — it never hits a real backend export route.
 * A regression that buffers the full body in any single export endpoint
 * would not be caught by that test.
 *
 * This integration test plugs the gap: against a running dev server, it
 * issues a real HTTP GET to every streaming export endpoint and asserts
 *
 *   1. Status is 200.
 *   2. The response carries the `X-Stream-TTFB-Ms` header
 *      (proving the server-side latency wrapper is in the response path).
 *   3. The reported TTFB is within `EXPORT_TTFB_BUDGET_MS`.
 *   4. Total wall-clock transfer time is within `EXPORT_TOTAL_BUDGET_MS`.
 *   5. The body is non-empty (otherwise we are not actually streaming
 *      anything and the timing is meaningless).
 *
 * Auth: a temporary admin user is inserted into platform_users and a
 * signed session cookie is built locally (same pattern as
 * tests/rbacRouteLockdown.integration.ts). Cleaned up in `finally`.
 *
 * Run:  RUN_STREAMING_EXPORT_LATENCY_E2E=1 \
 *       DATABASE_URL=... SESSION_SECRET=... BASE_URL=<REDACTED_URL> \
 *       npx tsx tests/streamingExportLatency.integration.ts
 *
 * Wired into runIntegrationTests.ts behind the same env flag and into
 * the streaming-download-smoke CI workflow so a buffering regression in
 * any single export endpoint fails the build.
 */

import crypto from "crypto";
import pg from "pg";

import {
  EXPORT_TIMING_HEADERS,
  EXPORT_TTFB_BUDGET_MS,
  EXPORT_TOTAL_BUDGET_MS,
} from "../src/utils/excelExport.js";

const { Pool } = pg;

const BASE_URL = process.env.BASE_URL || "<REDACTED_URL>";
const SESSION_SECRET = process.env.SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SESSION_SECRET) {
  console.error("❌ SESSION_SECRET env var is required");
  process.exit(2);
}
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL env var is required");
  process.exit(2);
}

const pool = new Pool({ connectionString: DATABASE_URL });

const TEST_USER = {
  email: "user@example.invalid",
  role: "admin",
  name: "Stream Export Latency Admin",
};

// Stable, deterministic audit row used to exercise /api/audits/:id/export-xlsx.
// audits.id is VARCHAR (UUID-style) so any unique string works; this prefix
// makes orphaned rows easy to spot and clean up if a run dies between
// setup and finally.
const TEST_AUDIT_ID = "stream-export-latency-test-audit-001";

function signSession(payload: Record<string, any>): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", SESSION_SECRET!)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

function makeAdminCookie(): string {
  const token = signSession({
    userId: 999200,
    email: TEST_USER.email,
    name: TEST_USER.name,
    role: TEST_USER.role,
    exp: Date.now() + 3600_000,
  });
  return `ExampleOrg_session=${encodeURIComponent(token)}`;
}

async function setupAdminUser(): Promise<void> {
  await pool.query(
    `INSERT INTO platform_users (email, full_name, role, status, team)
     VALUES ($1, $2, 'admin', 'active', 'Other')
     ON CONFLICT (email) DO UPDATE SET role = 'admin', status = 'active'`,
    [TEST_USER.email, TEST_USER.name],
  );
}

async function cleanupAdminUser(): Promise<void> {
  await pool.query("DELETE FROM platform_users WHERE email = $1", [TEST_USER.email]);
}

/**
 * Seed an audit row so /api/audits/:id/export-xlsx returns 200 instead of
 * 404 in a fresh environment. The route's handler short-circuits on a
 * missing audit, which would skip stageStreamingExportFromHono entirely
 * and produce a meaningless TTFB measurement. We need a real 200 path.
 *
 * We hit the audits table directly (not the create route) so this test
 * has no dependency on any other API surface — the schema lives in
 * src/utils/auditDatabase.ts. `initAuditTables` runs lazily on first
 * audit-route hit, so by the time setup runs the table already exists if
 * the dev server has been touched at all; if not, CREATE TABLE IF NOT
 * EXISTS in the route handler will create it on first request and the
 * INSERT will succeed because we re-run setup defensively below.
 */
async function setupTestAudit(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS audits (
       id VARCHAR PRIMARY KEY,
       title TEXT NOT NULL,
       audit_number TEXT,
       type TEXT,
       status TEXT DEFAULT 'planned',
       created_at TIMESTAMP DEFAULT NOW()
     )`,
  );
  await pool.query(
    `INSERT INTO audits (id, title, status)
     VALUES ($1, $2, 'planned')
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title`,
    [TEST_AUDIT_ID, "Streaming export latency test audit"],
  );
}

async function cleanupTestAudit(): Promise<void> {
  // grc_audit_findings.audit_id has ON DELETE CASCADE so any seeded
  // findings (none here, but defensive) clean up automatically.
  await pool.query("DELETE FROM audits WHERE id = $1", [TEST_AUDIT_ID]);
}

/**
 * Every endpoint the central streaming wrapper instruments. The list is
 * derived by `rg "stageStreamingExportFromHono" src` and must include
 * EVERY caller — that is the entire point of this test. When a new
 * export route is added, add it here too. The CI check fails fast if a
 * route is missing the X-Stream-TTFB-Ms header, but only for the routes
 * we actually exercise; an unlisted route cannot be detected.
 *
 * Buffered (non-streaming) export routes such as
 *   /api/audits/:id/export-pdf  (pdfkit Buffer chunks)
 * are intentionally excluded — they go through `bufferResponseWithRange`,
 * not `stageStreamingExportFromHono`, and have a different latency
 * profile. Coverage for those is tracked as a follow-up.
 */
interface ExportRoute {
  label: string;
  path: string;
}

const EXPORT_ROUTES: ExportRoute[] = [
  // qmsEnhancedRoutes.ts
  { label: "vendors CSV",        path: "/api/vendors/export" },
  { label: "vendors XLSX",       path: "/api/vendors/export-xlsx" },
  { label: "QMS NC CSV",         path: "/api/qms/nc/export" },
  { label: "QMS NC XLSX",        path: "/api/qms/nc/export-xlsx" },
  { label: "QMS CAPA CSV",       path: "/api/qms/capa/export" },
  // The hyphenated path is intentional: the slash form
  // /api/qms/capa/export-xlsx is shadowed by GET /api/qms/capa/:id which
  // would parseInt('export-xlsx') and 500. See the route comment.
  { label: "QMS CAPA XLSX",      path: "/api/qms/capa-export-xlsx" },
  { label: "compliance CSV",     path: "/api/compliance/export" },
  { label: "PDPL CSV",           path: "/api/pdpl/export" },
  { label: "KPIs CSV",           path: "/api/kpis/export" },
  { label: "KPIs XLSX",          path: "/api/kpis/export-xlsx" },
  // riskRoutes.ts
  { label: "risks CSV",          path: "/api/risks/export" },
  { label: "risks XLSX",         path: "/api/risks/export-xlsx" },
  // duplicateRadarRoutes.ts
  { label: "duplicates CSV",     path: "/api/duplicates/export" },
  { label: "duplicates XLSX",    path: "/api/duplicates/export-xlsx" },
  // policyRoutes.ts
  { label: "policies CSV",       path: "/api/policies/export" },
  // eventLogsRoutes.ts
  { label: "event logs CSV",     path: "/api/logs/export" },
  // auditRoutes.ts — :id is a real seeded audit (see setupTestAudit).
  { label: "audit XLSX",         path: `/api/audits/${TEST_AUDIT_ID}/export-xlsx` },
];

interface ExportResult {
  label: string;
  path: string;
  status: number;
  ttfbMs: number | null;
  totalMs: number;
  bytes: number;
  budgetTtfbMs: number;
  budgetTotalMs: number;
  ok: boolean;
  reason?: string;
}

async function fetchExport(route: ExportRoute, cookie: string): Promise<ExportResult> {
  const url = `${BASE_URL}${route.path}`;
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Cookie: cookie },
      redirect: "manual",
    });
  } catch (err) {
    return {
      label: route.label,
      path: route.path,
      status: 0,
      ttfbMs: null,
      totalMs: Date.now() - t0,
      bytes: 0,
      budgetTtfbMs: EXPORT_TTFB_BUDGET_MS,
      budgetTotalMs: EXPORT_TOTAL_BUDGET_MS,
      ok: false,
      reason: `fetch threw: ${(err as Error).message}`,
    };
  }

  // Drain the entire body so total wall-clock includes last-byte time.
  let bytes = 0;
  try {
    if (res.body) {
      const reader = res.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) bytes += value.byteLength;
      }
    } else {
      const ab = await res.arrayBuffer();
      bytes = ab.byteLength;
    }
  } catch (err) {
    return {
      label: route.label,
      path: route.path,
      status: res.status,
      ttfbMs: Number(res.headers.get(EXPORT_TIMING_HEADERS.ttfb)) || null,
      totalMs: Date.now() - t0,
      bytes,
      budgetTtfbMs: EXPORT_TTFB_BUDGET_MS,
      budgetTotalMs: EXPORT_TOTAL_BUDGET_MS,
      ok: false,
      reason: `body read threw: ${(err as Error).message}`,
    };
  }
  const totalMs = Date.now() - t0;

  const ttfbHeader = res.headers.get(EXPORT_TIMING_HEADERS.ttfb);
  const ttfbMs = ttfbHeader === null ? null : Number(ttfbHeader);

  const result: ExportResult = {
    label: route.label,
    path: route.path,
    status: res.status,
    ttfbMs,
    totalMs,
    bytes,
    budgetTtfbMs: EXPORT_TTFB_BUDGET_MS,
    budgetTotalMs: EXPORT_TOTAL_BUDGET_MS,
    ok: true,
  };

  if (res.status !== 200) {
    result.ok = false;
    result.reason = `unexpected status ${res.status}`;
    return result;
  }

  if (ttfbMs === null || !Number.isFinite(ttfbMs)) {
    result.ok = false;
    result.reason =
      `missing ${EXPORT_TIMING_HEADERS.ttfb} header — the route is probably ` +
      `not going through stageStreamingExportFromHono. Check that the handler ` +
      `wraps its response with the streaming-export helper.`;
    return result;
  }

  // Budget-header parity: the route must advertise the same budget
  // constants the test is enforcing. If they drift (e.g. someone bumps
  // the constant in src/utils/excelExport.ts but forgets to update
  // tests, or vice versa), this catches it instead of silently passing.
  const advertisedTtfb = Number(res.headers.get(EXPORT_TIMING_HEADERS.ttfbBudget));
  const advertisedTotal = Number(res.headers.get(EXPORT_TIMING_HEADERS.totalBudget));
  if (advertisedTtfb !== EXPORT_TTFB_BUDGET_MS) {
    result.ok = false;
    result.reason =
      `${EXPORT_TIMING_HEADERS.ttfbBudget} header reports ${advertisedTtfb}ms ` +
      `but EXPORT_TTFB_BUDGET_MS is ${EXPORT_TTFB_BUDGET_MS}ms — config drift.`;
    return result;
  }
  if (advertisedTotal !== EXPORT_TOTAL_BUDGET_MS) {
    result.ok = false;
    result.reason =
      `${EXPORT_TIMING_HEADERS.totalBudget} header reports ${advertisedTotal}ms ` +
      `but EXPORT_TOTAL_BUDGET_MS is ${EXPORT_TOTAL_BUDGET_MS}ms — config drift.`;
    return result;
  }

  if (ttfbMs > EXPORT_TTFB_BUDGET_MS) {
    result.ok = false;
    result.reason =
      `TTFB ${ttfbMs}ms exceeds budget ${EXPORT_TTFB_BUDGET_MS}ms — likely ` +
      `accidental full-body buffering inside build() or a stalled promise chain.`;
    return result;
  }

  if (totalMs > EXPORT_TOTAL_BUDGET_MS) {
    result.ok = false;
    result.reason =
      `total transfer ${totalMs}ms exceeds budget ${EXPORT_TOTAL_BUDGET_MS}ms ` +
      `(${bytes} bytes) — backend streaming pipeline is broken.`;
    return result;
  }

  if (bytes === 0) {
    result.ok = false;
    result.reason = `body was empty — not even the CSV header row was emitted; the streaming pipeline is silently dropping output.`;
    return result;
  }

  return result;
}

async function main(): Promise<void> {
  console.log("\n=== Streaming-export latency — HTTP integration tests ===\n");
  console.log(`Target: ${BASE_URL}`);
  console.log(`TTFB budget: ${EXPORT_TTFB_BUDGET_MS}ms`);
  console.log(`Total budget: ${EXPORT_TOTAL_BUDGET_MS}ms\n`);

  await setupAdminUser();
  await setupTestAudit();
  const cookie = makeAdminCookie();

  let passed = 0;
  let failed = 0;
  const results: ExportResult[] = [];

  try {
    for (const route of EXPORT_ROUTES) {
      const r = await fetchExport(route, cookie);
      results.push(r);
      const tag = r.ok ? "✓" : "✗";
      const summary =
        `${tag} ${r.label.padEnd(20)} ${r.path.padEnd(38)} ` +
        `status=${r.status} ttfb=${r.ttfbMs ?? "—"}ms ` +
        `total=${r.totalMs}ms bytes=${r.bytes}`;
      if (r.ok) {
        console.log(summary + (r.reason ? `  (${r.reason})` : ""));
        passed++;
      } else {
        console.error(summary);
        console.error(`     reason: ${r.reason}`);
        failed++;
      }
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed (of ${results.length} export endpoints)`);
    console.log(
      `\nLatency summary (sorted by TTFB desc):`,
    );
    const sorted = [...results].sort(
      (a, b) => (b.ttfbMs ?? -1) - (a.ttfbMs ?? -1),
    );
    for (const r of sorted) {
      const ttfbStr = r.ttfbMs === null ? "—".padStart(6) : `${r.ttfbMs}`.padStart(6);
      const totalStr = `${r.totalMs}`.padStart(6);
      const bytesStr = `${r.bytes}`.padStart(8);
      console.log(`  ttfb=${ttfbStr}ms  total=${totalStr}ms  bytes=${bytesStr}  ${r.path}`);
    }

    if (failed > 0) {
      console.error(
        `\n❌ Streaming-export latency integration tests FAILED ` +
          `(${failed}/${results.length}). See per-route reasons above.`,
      );
      process.exit(1);
    }
    console.log("\n✅ All streaming-export latency integration tests passed");
  } finally {
    // Best-effort independent cleanups so a failure in one does not skip
    // the others (avoids leaking the seeded admin or audit row when the
    // first cleanup throws).
    try { await cleanupTestAudit(); } catch (e) {
      console.warn(`cleanupTestAudit failed: ${(e as Error).message}`);
    }
    try { await cleanupAdminUser(); } catch (e) {
      console.warn(`cleanupAdminUser failed: ${(e as Error).message}`);
    }
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Unexpected error:", err);
  process.exit(1);
});
