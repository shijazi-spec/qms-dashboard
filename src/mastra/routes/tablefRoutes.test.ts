/**
 * CI gate — tablefDatabase (via tablefRoutes) write-path secret-leak test.
 *
 * This file is the companion secret-leak test for `src/utils/tablefDatabase.ts`
 * (mapped via COMPANION_TESTS in scripts/check-db-test-coverage.sh).  It
 * patches `pg.Pool.prototype.query` globally so INSERT/UPDATE calls issued by
 * tablefDatabase's pool are captured regardless of which file creates the pool.
 *
 * tablefDatabase writes KPI metadata, performance snapshots, user records, and
 * department seeds — all operational configuration, not user-entered credentials.
 * This test documents that invariant and verifies every write function reaches
 * pool.query without throwing.
 *
 * Run:  npx tsx src/mastra/routes/tablefRoutes.test.ts
 * Wired: auto-discovered by tests/runIntegrationTests.ts → scripts/post-merge.sh
 */

import { Pool, type QueryResult, type QueryResultRow } from "pg";

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}`); failed++; }
}

// ---------------------------------------------------------------------------
// Mock pg.Pool globally before importing the module under test.
// ---------------------------------------------------------------------------

interface CapturedQuery { sql: string; params: unknown[] }
const captured: CapturedQuery[] = [];

type QS = string | { text: string; values?: unknown[] };
const mockQuery = (sql: QS, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
  const sqlStr = typeof sql === "string" ? sql : sql.text;
  captured.push({ sql: sqlStr, params: Array.isArray(params) ? params : [] });
  return Promise.resolve({ rows: [{ kpi_id: "kpi-001", id: 1 }], rowCount: 1, command: "", oid: 0, fields: [] });
};
(Pool.prototype as unknown as { query: typeof mockQuery }).query = mockQuery;
(Pool.prototype as any).connect = () =>
  Promise.resolve({ query: mockQuery, release: () => {} });

const {
  seedTablefDepartment,
  updateTablefKpi,
  insertTablefKpi,
  archiveTablefKpi,
  updateTablefPerformance,
  insertTablefPerformance,
  upsertTablefSnapshot,
  updateTablefUser,
  insertTablefUser,
} = await import("../../utils/tablefDatabase");

const DENY_KEYS = ["password_hash", "mfa_secret", "access_token", "refresh_token", "api_key"];

function assertNoDenyKeys(params: unknown[], label: string): void {
  const joined = params.map(p =>
    typeof p === "object" && p !== null ? JSON.stringify(p) : String(p ?? ""),
  ).join("|");
  for (const dk of DENY_KEYS) {
    assert(!joined.includes(dk), `${label}: '${dk}' not present in params`);
  }
}

function lastWriteParams(verb: "INSERT" | "UPDATE"): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].sql.replace(/\s+/g, " ").toUpperCase().startsWith(verb)) return captured[i].params;
  }
  return null;
}

// ---------------------------------------------------------------------------
// seedTablefDepartment
// ---------------------------------------------------------------------------

console.log("\n=== seedTablefDepartment — write-path tests ===\n");
{
  captured.length = 0;
  await seedTablefDepartment("dept-ci", "CI Department", "Used for CI testing");
  const p = lastWriteParams("INSERT");
  assert(p !== null, "seedTablefDepartment: INSERT issued");
  if (p) assertNoDenyKeys(p, "seedTablefDepartment");
}

// ---------------------------------------------------------------------------
// insertTablefKpi / updateTablefKpi / archiveTablefKpi
// ---------------------------------------------------------------------------

console.log("\n=== tablefKpi write functions — write-path tests ===\n");

{
  captured.length = 0;
  await insertTablefKpi("kpi-ci-001", {
    department_id: "dept-ci", name: "CI KPI", description: "KPI for CI",
    category: "quality", unit: "%", target_annual: 90, target_monthly: 88,
    weight: 1, owner_email: "owner@example.com", data_source: "manual",
    calculation_definition: "count / total * 100",
  });
  const p = lastWriteParams("INSERT");
  assert(p !== null, "insertTablefKpi: INSERT issued");
  if (p) assertNoDenyKeys(p, "insertTablefKpi");
}

{
  captured.length = 0;
  await updateTablefKpi({
    kpi_id: "kpi-ci-001", name: "CI KPI Updated", department_id: "dept-ci",
    target_annual: 95,
  });
  const p = lastWriteParams("UPDATE");
  assert(p !== null, "updateTablefKpi: UPDATE issued");
  if (p) assertNoDenyKeys(p, "updateTablefKpi");
}

{
  captured.length = 0;
  await archiveTablefKpi("kpi-ci-001");
  const p = lastWriteParams("UPDATE");
  assert(p !== null, "archiveTablefKpi: UPDATE issued");
  if (p) assertNoDenyKeys(p, "archiveTablefKpi");
}

// ---------------------------------------------------------------------------
// insertTablefPerformance / updateTablefPerformance
// ---------------------------------------------------------------------------

console.log("\n=== tablefPerformance write functions — write-path tests ===\n");

{
  captured.length = 0;
  await insertTablefPerformance({
    kpi_id: "kpi-ci-001", period_month: 8, period_year: 2026, actual_value: 91.5,
    notes: "On track", submitted_by: "ci@example.com",
  });
  const p = lastWriteParams("INSERT");
  assert(p !== null, "insertTablefPerformance: INSERT issued");
  if (p) assertNoDenyKeys(p, "insertTablefPerformance");
}

{
  captured.length = 0;
  await updateTablefPerformance({
    id: 1, actual_value: 92, notes: "Revised", submitted_by: "ci@example.com",
  });
  const p = lastWriteParams("UPDATE");
  assert(p !== null, "updateTablefPerformance: UPDATE issued");
  if (p) assertNoDenyKeys(p, "updateTablefPerformance");
}

// ---------------------------------------------------------------------------
// upsertTablefSnapshot
// ---------------------------------------------------------------------------

console.log("\n=== upsertTablefSnapshot — write-path tests ===\n");

{
  captured.length = 0;
  await upsertTablefSnapshot({
    kpi_id: "kpi-ci-001", snapshot_date: "2026-08-01",
    actual_value: 91.5, target_value: 90,
  });
  const writes = captured.filter(c => {
    const u = c.sql.replace(/\s+/g, " ").toUpperCase();
    return u.includes("INSERT") || u.includes("UPDATE");
  });
  assert(writes.length > 0, "upsertTablefSnapshot: INSERT/UPDATE issued");
  for (const w of writes) assertNoDenyKeys(w.params, "upsertTablefSnapshot");
}

// ---------------------------------------------------------------------------
// insertTablefUser / updateTablefUser
// ---------------------------------------------------------------------------

console.log("\n=== tablefUser write functions — write-path tests ===\n");

{
  captured.length = 0;
  await insertTablefUser({
    user_id: "u-ci-001", name: "CI User", email: "ci@example.com",
    role: "viewer", departments: ["dept-ci"],
  });
  const p = lastWriteParams("INSERT");
  assert(p !== null, "insertTablefUser: INSERT issued");
  if (p) assertNoDenyKeys(p, "insertTablefUser");
}

{
  captured.length = 0;
  await updateTablefUser({
    user_id: "u-ci-001", name: "CI User Updated", email: "ci@example.com",
    role: "editor", departments: ["dept-ci"], active: true,
  });
  const p = lastWriteParams("UPDATE");
  assert(p !== null, "updateTablefUser: UPDATE issued");
  if (p) assertNoDenyKeys(p, "updateTablefUser");
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log();
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n❌ tablefRoutes (tablefDatabase) tests FAILED");
  process.exit(1);
}
console.log("\n✅ All tablefRoutes (tablefDatabase) tests passed");
process.exit(0);
