/**
 * HTTP-level integration tests for RBAC on KPI, analytics, scorecard,
 * health-pulse, and infographic endpoints (task #35 lockdown routes).
 *
 * Spins up real HTTP requests against the running server using temporary
 * test users inserted into (and cleaned up from) the platform_users table.
 *
 * Assertions mirror the cases in tests/rbacRouteLockdown.test.ts but are
 * verified over real HTTP so that middleware regressions are caught.
 *
 * Roles tested:
 *   - department_viewer  (low-priv)          → 403 on all guarded routes
 *   - executive          (governance_read)    → allowed on read routes, 403 on write/admin
 *   - quality_manager    (governance_write)   → allowed on write routes, 403 on admin-only
 *   - admin              (all access)         → allowed on every route incl. admin-only
 *   - head_of_operations_quality             → allowed on digest/send, 403 on admin-only seeders
 *
 * Run:  npx tsx tests/rbacRouteLockdown.integration.ts
 * Env:  DATABASE_URL  — Postgres connection string (required)
 *       SESSION_SECRET — HMAC key used to sign session cookies (required)
 *       BASE_URL       — defaults to <REDACTED_URL>
 */

import crypto from "crypto";
import pg from "pg";

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

function signSession(payload: Record<string, any>): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", SESSION_SECRET!)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

function makeSessionCookie(email: string, role: string): string {
  const token = signSession({
    userId: 999100,
    email,
    name: `RBAC LockTest ${role}`,
    role,
    exp: Date.now() + 3600_000,
  });
  return `ExampleOrg_session=${encodeURIComponent(token)}`;
}

const TEST_USERS = [
  {
    email: "user@example.invalid",
    role: "department_viewer",
    name: "RBAC Lock Viewer",
  },
  {
    email: "user@example.invalid",
    role: "executive",
    name: "RBAC Lock Executive",
  },
  {
    email: "user@example.invalid",
    role: "quality_manager",
    name: "RBAC Lock QM",
  },
  {
    email: "user@example.invalid",
    role: "admin",
    name: "RBAC Lock Admin",
  },
  {
    email: "user@example.invalid",
    role: "head_of_operations_quality",
    name: "RBAC Lock HOQ",
  },
];

async function setupTestUsers(): Promise<void> {
  for (const u of TEST_USERS) {
    await pool.query(
      `INSERT INTO platform_users (email, full_name, role, status, team)
       VALUES ($1, $2, $3, 'active', 'Other')
       ON CONFLICT (email) DO UPDATE SET role = $3, status = 'active'`,
      [u.email, u.name, u.role]
    );
  }
}

async function cleanupTestUsers(): Promise<void> {
  for (const u of TEST_USERS) {
    await pool.query("DELETE FROM platform_users WHERE email = $1", [u.email]);
  }
}

/** Insert a minimal KPI definition so that POST /api/kpis/:id/values has a valid target. */
async function setupTestKPI(): Promise<number> {
  const code = `RBAC_INTTEST_${Date.now()}`;
  const res = await pool.query<{ id: number }>(
    `INSERT INTO kpi_definitions
       (kpi_name, kpi_code, description, owner_type, category, unit, frequency,
        threshold_green, threshold_amber, threshold_red, threshold_direction, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      "RBAC Integration Test KPI",
      code,
      "Inserted by rbacRouteLockdown.integration.ts — safe to delete",
      "quality_manager",
      "quality",
      "%",
      "monthly",
      90,
      75,
      60,
      "higher_is_better",
      true,
    ]
  );
  return res.rows[0].id;
}

async function cleanupTestKPI(id: number): Promise<void> {
  await pool.query("DELETE FROM kpi_values WHERE kpi_id = $1", [id]);
  await pool.query("DELETE FROM kpi_definitions WHERE id = $1", [id]);
}

async function req(
  method: string,
  path: string,
  cookie: string,
  body?: Record<string, any>
): Promise<{ status: number }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  return { status: res.status };
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

interface RouteCase {
  label: string;
  method: string;
  path: string;
  /**
   * Static body sent for every role in this case.
   * If the body must be unique per role (e.g. to avoid UNIQUE constraint clashes),
   * use `bodyFn` instead.
   */
  body?: Record<string, any>;
  /**
   * Body factory called once per role.  Takes precedence over `body` when present.
   * Useful for POST routes that require a unique identifier (kpi_code, etc.).
   */
  bodyFn?: (role: string) => Record<string, any>;
  /** Exact HTTP status codes accepted as success (auth passed) for allowed roles. */
  allowedStatuses: number[];
  expect200: string[];
  expect403: string[];
}

async function main(): Promise<void> {
  console.log(
    "\n=== Route Lockdown RBAC — HTTP integration tests (task #35) ===\n"
  );
  console.log(`Target: ${BASE_URL}\n`);

  await setupTestUsers();
  const testKpiId = await setupTestKPI();

  const cookies: Record<string, string> = {};
  for (const u of TEST_USERS) {
    cookies[u.role] = makeSessionCookie(u.email, u.role);
  }

  const viewer = "department_viewer";
  const exec = "executive";
  const qm = "quality_manager";
  const admin = "admin";
  const hoq = "head_of_operations_quality";

  const governanceRead = [admin, qm, hoq, exec];
  const governanceWrite = [admin, qm, hoq];
  const adminOnly = [admin];

  const kpiBodyFn = (role: string): Record<string, any> => ({
    kpi_name: `RBAC POST Test KPI (${role})`,
    kpi_code: `RBAC_POST_${role.replace(/_/g, "")}_${Date.now()}`,
    description: "Created by RBAC integration test",
    owner_type: "quality_manager",
    category: "quality",
    unit: "%",
    frequency: "monthly",
    threshold_green: 90,
    threshold_amber: 75,
    threshold_red: 60,
    threshold_direction: "higher_is_better",
    is_active: true,
  });

  const kpiValueBody = {
    period_start: "2026-01-01",
    period_end: "2026-01-31",
    actual_value: 85,
    status: "green",
    calculated_by: "manual",
  };

  const execReportBody = {
    report_type: "mbr",
    period_name: "RBAC Test Period",
    period_start: "2026-01-01",
    period_end: "2026-01-31",
    overall_health_score: 85,
    status: "draft",
  };

  const CASES: RouteCase[] = [
    // ─── KPI reads ───────────────────────────────────────────────────────────
    {
      label: "GET /api/kpis (list)",
      method: "GET",
      path: "/api/kpis",
      allowedStatuses: [200],
      expect200: governanceRead,
      expect403: [viewer],
    },
    {
      label: "GET /api/kpis/summary",
      method: "GET",
      path: "/api/kpis/summary",
      allowedStatuses: [200],
      expect200: governanceRead,
      expect403: [viewer],
    },
    {
      label: `GET /api/kpis/${testKpiId} (single)`,
      method: "GET",
      path: `/api/kpis/${testKpiId}`,
      allowedStatuses: [200],
      expect200: governanceRead,
      expect403: [viewer],
    },
    {
      label: `GET /api/kpis/${testKpiId}/history`,
      method: "GET",
      path: `/api/kpis/${testKpiId}/history`,
      allowedStatuses: [200],
      expect200: governanceRead,
      expect403: [viewer],
    },

    // ─── KPI writes ───────────────────────────────────────────────────────────
    {
      label: "POST /api/kpis (create) — executive blocked",
      method: "POST",
      path: "/api/kpis",
      bodyFn: kpiBodyFn,
      allowedStatuses: [200],
      expect200: governanceWrite,
      expect403: [viewer, exec],
    },
    {
      label: `PUT /api/kpis/${testKpiId}`,
      method: "PUT",
      path: `/api/kpis/${testKpiId}`,
      body: { kpi_name: "RBAC Updated KPI" },
      allowedStatuses: [200],
      expect200: governanceWrite,
      expect403: [viewer, exec],
    },
    {
      label: `POST /api/kpis/${testKpiId}/values`,
      method: "POST",
      path: `/api/kpis/${testKpiId}/values`,
      body: kpiValueBody,
      allowedStatuses: [200],
      expect200: governanceWrite,
      expect403: [viewer, exec],
    },

    // ─── KPI seeders (admin only) ─────────────────────────────────────────────
    {
      label: "POST /api/kpis/seed-Sample User (admin only)",
      method: "POST",
      path: "/api/kpis/seed-Sample User",
      allowedStatuses: [200],
      expect200: adminOnly,
      expect403: [viewer, exec, qm, hoq],
    },
    {
      label: "POST /api/kpis/seed-sdr (admin only)",
      method: "POST",
      path: "/api/kpis/seed-sdr",
      allowedStatuses: [200],
      expect200: adminOnly,
      expect403: [viewer, exec, qm, hoq],
    },

    // ─── Executive reports ────────────────────────────────────────────────────
    {
      label: "GET /api/executive/reports",
      method: "GET",
      path: "/api/executive/reports",
      allowedStatuses: [200],
      expect200: governanceRead,
      expect403: [viewer],
    },
    {
      label: "GET /api/executive/reports/7 (no such record → 404)",
      method: "GET",
      path: "/api/executive/reports/7",
      allowedStatuses: [404],
      expect200: governanceRead,
      expect403: [viewer],
    },
    {
      label: "POST /api/executive/reports — executive blocked",
      method: "POST",
      path: "/api/executive/reports",
      body: execReportBody,
      allowedStatuses: [200],
      expect200: governanceWrite,
      expect403: [viewer, exec],
    },
    {
      label: "PUT /api/executive/reports/7 (no such record → 404) — executive blocked",
      method: "PUT",
      path: "/api/executive/reports/7",
      body: { period_name: "RBAC Updated" },
      allowedStatuses: [404],
      expect200: governanceWrite,
      expect403: [viewer, exec],
    },
    {
      label: "GET /api/executive/mbr-data",
      method: "GET",
      path: "/api/executive/mbr-data",
      allowedStatuses: [200, 500],
      expect200: governanceRead,
      expect403: [viewer],
    },

    // ─── Analytics ────────────────────────────────────────────────────────────
    {
      label: "GET /api/analytics/cycle-times",
      method: "GET",
      path: "/api/analytics/cycle-times",
      allowedStatuses: [200],
      expect200: governanceRead,
      expect403: [viewer],
    },
    {
      label: "GET /api/analytics/agent-compliance",
      method: "GET",
      path: "/api/analytics/agent-compliance",
      allowedStatuses: [200],
      expect200: governanceRead,
      expect403: [viewer],
    },
    {
      label: "GET /api/analytics/capa-recurrence",
      method: "GET",
      path: "/api/analytics/capa-recurrence",
      allowedStatuses: [200],
      expect200: governanceRead,
      expect403: [viewer],
    },
    {
      label: "GET /api/analytics/trends",
      method: "GET",
      path: "/api/analytics/trends",
      allowedStatuses: [200],
      expect200: governanceRead,
      expect403: [viewer],
    },
    {
      label: "GET /api/analytics/executive-digest",
      method: "GET",
      path: "/api/analytics/executive-digest",
      allowedStatuses: [200],
      expect200: governanceRead,
      expect403: [viewer],
    },
    {
      label: "POST /api/analytics/executive-digest/send (admin + hoq only)",
      method: "POST",
      path: "/api/analytics/executive-digest/send",
      allowedStatuses: [200],
      expect200: [admin, hoq],
      expect403: [viewer, exec, qm],
    },

    // ─── Scorecard ────────────────────────────────────────────────────────────
    {
      label: "GET /api/scorecard/Sample User",
      method: "GET",
      path: "/api/scorecard/Sample User",
      allowedStatuses: [200],
      expect200: governanceRead,
      expect403: [viewer],
    },
    {
      label: "GET /api/scorecard/kpi/3",
      method: "GET",
      path: "/api/scorecard/kpi/3",
      allowedStatuses: [200],
      expect200: governanceRead,
      expect403: [viewer],
    },
    {
      label: "GET /api/scorecard/history",
      method: "GET",
      path: "/api/scorecard/history",
      allowedStatuses: [200],
      expect200: governanceRead,
      expect403: [viewer],
    },
    {
      label: "POST /api/scorecard/snapshot — executive blocked",
      method: "POST",
      path: "/api/scorecard/snapshot",
      allowedStatuses: [200],
      expect200: governanceWrite,
      expect403: [viewer, exec],
    },

    // ─── Health Pulse (admin only) ────────────────────────────────────────────
    {
      label: "GET /api/health/pulse (admin only)",
      method: "GET",
      path: "/api/health/pulse",
      allowedStatuses: [200],
      expect200: adminOnly,
      expect403: [viewer, exec, qm, hoq],
    },
    {
      label: "GET /api/health/pulse/latest (admin only)",
      method: "GET",
      path: "/api/health/pulse/latest",
      allowedStatuses: [200],
      expect200: adminOnly,
      expect403: [viewer, exec, qm, hoq],
    },
    {
      label: "POST /api/health/pulse/run (admin only)",
      method: "POST",
      path: "/api/health/pulse/run",
      allowedStatuses: [200],
      expect200: adminOnly,
      expect403: [viewer, exec, qm, hoq],
    },

    // ─── Infographics ─────────────────────────────────────────────────────────
    {
      label: "GET /api/infographic/sections",
      method: "GET",
      path: "/api/infographic/sections",
      allowedStatuses: [200],
      expect200: governanceRead,
      expect403: [viewer],
    },
    {
      label: "GET /api/infographic/quality-snapshot (no snapshot → 404)",
      method: "GET",
      path: "/api/infographic/quality-snapshot",
      allowedStatuses: [200, 404],
      expect200: governanceRead,
      expect403: [viewer],
    },
    {
      label: "GET /api/infographic/quality-snapshot.png (render — no snapshot → 404)",
      method: "GET",
      path: "/api/infographic/quality-snapshot.png",
      allowedStatuses: [200, 404],
      expect200: governanceRead,
      expect403: [viewer],
    },
    {
      label: "POST /api/infographic/quality-snapshot/share/ChatProvider — executive blocked",
      method: "POST",
      path: "/api/infographic/quality-snapshot/share/ChatProvider",
      allowedStatuses: [200, 404],
      expect200: governanceWrite,
      expect403: [viewer, exec],
    },
    {
      label: "POST /api/infographic/quality-snapshot/share/email — executive blocked",
      method: "POST",
      path: "/api/infographic/quality-snapshot/share/email",
      allowedStatuses: [200, 404],
      expect200: governanceWrite,
      expect403: [viewer, exec],
    },
  ];

  try {
    for (const c of CASES) {
      console.log(`Route: ${c.method} ${c.path}`);
      console.log(`  Case: ${c.label}`);

      for (const role of c.expect200) {
        const body = c.bodyFn ? c.bodyFn(role) : c.body;
        const { status } = await req(c.method, c.path, cookies[role], body);
        assert(
          c.allowedStatuses.includes(status),
          `role '${role}' → ${c.allowedStatuses.join("|")} (allowed, got ${status})`
        );
      }

      for (const role of c.expect403) {
        const body = c.bodyFn ? c.bodyFn(role) : c.body;
        const { status } = await req(c.method, c.path, cookies[role], body);
        assert(
          status === 403,
          `role '${role}' → 403 (blocked, got ${status})`
        );
      }

      console.log();
    }

    console.log(`Results: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
      console.error("\n❌ Route lockdown HTTP integration tests FAILED");
      process.exit(1);
    }

    console.log("\n✅ All route lockdown RBAC HTTP integration tests passed");
  } finally {
    await cleanupTestUsers();
    await cleanupTestKPI(testKpiId);
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Unexpected error:", err);
  process.exit(1);
});
