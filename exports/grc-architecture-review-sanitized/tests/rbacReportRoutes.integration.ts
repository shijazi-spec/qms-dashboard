/**
 * Integration tests for RBAC on /api/reports/* endpoints.
 *
 * Spins up real HTTP requests against the running server using temporary
 * test users inserted into (and cleaned up from) the platform_users table.
 *
 * Assertions:
 *   - GET /api/reports/capa-effectiveness → 403 for department_viewer
 *   - GET /api/reports/capa-effectiveness → 200 for executive
 *   - GET /api/reports/compliance-posture → 403 for department_viewer
 *   - GET /api/reports/compliance-posture → 200 for executive
 *
 * Run:  npx tsx tests/rbacReportRoutes.integration.ts
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
    userId: 999000,
    email,
    name: `RBAC Test ${role}`,
    role,
    exp: Date.now() + 3600_000,
  });
  return `walaplus_session=${encodeURIComponent(token)}`;
}

const TEST_USERS = [
  {
    email: "user@example.invalid",
    role: "department_viewer",
    name: "RBAC Test Viewer",
  },
  {
    email: "user@example.invalid",
    role: "executive",
    name: "RBAC Test Executive",
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

async function get(path: string, cookie: string): Promise<{ status: number }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Cookie: cookie },
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

async function main(): Promise<void> {
  console.log("\n=== Report Route RBAC — HTTP integration tests ===\n");
  console.log(`Target: ${BASE_URL}\n`);

  await setupTestUsers();

  try {
    const viewerCookie = makeSessionCookie(
      "user@example.invalid",
      "department_viewer"
    );
    const executiveCookie = makeSessionCookie(
      "user@example.invalid",
      "executive"
    );

    const routes = [
      "/api/reports/capa-effectiveness",
      "/api/reports/compliance-posture",
    ];

    for (const route of routes) {
      console.log(`Route: GET ${route}`);

      const viewerRes = await get(route, viewerCookie);
      assert(
        viewerRes.status === 403,
        `department_viewer → 403 (got ${viewerRes.status})`
      );

      const execRes = await get(route, executiveCookie);
      assert(
        execRes.status === 200,
        `executive → 200 (got ${execRes.status})`
      );

      console.log();
    }

    console.log(`Results: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
      console.error("\n❌ Integration tests FAILED");
      process.exit(1);
    }

    console.log("\n✅ All RBAC report route integration tests passed");
  } finally {
    await cleanupTestUsers();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Unexpected error:", err);
  process.exit(1);
});
