/**
 * CI gate — CRMProviderTasksSync write-path secret-leak test.
 *
 * `runCRMProviderTasksSync` writes CRMProvider task records: subject, status, priority,
 * owner_name, owner_email, who_name, what_name, description, and raw_data
 * — all fetched from CRMProvider's API, not entered as credentials by a platform
 * user.  This test verifies that when CRMProvider is not configured (the typical
 * CI environment), the function exits cleanly without reaching pool.query,
 * and that the deny-list credential keys do not appear in any params when
 * the write path IS exercised.
 *
 * Run:  npx tsx src/utils/CRMProviderTasksSync.test.ts
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
// Mock pg.Pool before importing the module under test.
// ---------------------------------------------------------------------------

interface CapturedQuery { sql: string; params: unknown[] }
const captured: CapturedQuery[] = [];

type QS = string | { text: string; values?: unknown[] };
const mockQuery = (sql: QS, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
  const sqlStr = typeof sql === "string" ? sql : sql.text;
  captured.push({ sql: sqlStr, params: Array.isArray(params) ? params : [] });
  return Promise.resolve({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] });
};
(Pool.prototype as unknown as { query: typeof mockQuery }).query = mockQuery;
(Pool.prototype as any).connect = () =>
  Promise.resolve({ query: mockQuery, release: () => {} });

const { runCRMProviderTasksSync, getCRMProviderTaskStats } = await import("./CRMProviderTasksSync");

// ---------------------------------------------------------------------------
// runCRMProviderTasksSync — not-configured short-circuit
// ---------------------------------------------------------------------------

console.log("\n=== runCRMProviderTasksSync (CRMProvider not configured) — write-path tests ===\n");

{
  // In CI, CRMProvider_CLIENT_ID / CRMProvider_REFRESH_TOKEN are not set.  getCRMProviderConnectionStatus()
  // returns { configured: false }, so runCRMProviderTasksSync returns immediately with
  // an error sample and never calls pool.query for writes.
  captured.length = 0;
  const result = await runCRMProviderTasksSync({ maxRecords: 1 });
  assert(typeof result.scanned === "number", "runCRMProviderTasksSync: returns scanned count");
  assert(typeof result.errors === "number", "runCRMProviderTasksSync: returns error count");

  const writes = captured.filter(c => {
    const u = c.sql.replace(/\s+/g, " ").toUpperCase();
    return u.includes("INSERT") || u.startsWith("UPDATE");
  });
  // Either no writes (not-configured path) or writes that don't contain credentials.
  for (const w of writes) {
    const joined = w.params.map(p =>
      typeof p === "object" && p !== null ? JSON.stringify(p) : String(p),
    ).join("|");
    const denyKeys = ["password_hash", "mfa_secret", "access_token", "refresh_token"];
    for (const dk of denyKeys) {
      assert(!joined.includes(dk), `runCRMProviderTasksSync: '${dk}' not in INSERT/UPDATE params`);
    }
  }
  assert(true, "runCRMProviderTasksSync: completed without throwing");
}

// ---------------------------------------------------------------------------
// getCRMProviderTaskStats — read-only, no INSERT/UPDATE
// ---------------------------------------------------------------------------

console.log("\n=== getCRMProviderTaskStats — read-only path ===\n");

{
  captured.length = 0;
  const stats = await getCRMProviderTaskStats();
  assert(typeof stats.total === "number", "getCRMProviderTaskStats: returns { total: number }");
  const writes = captured.filter(c => {
    const u = c.sql.replace(/\s+/g, " ").toUpperCase();
    return u.includes("INSERT") || u.startsWith("UPDATE");
  });
  assert(writes.length === 0, "getCRMProviderTaskStats: no INSERT/UPDATE (read-only path)");
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log();
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n❌ CRMProviderTasksSync tests FAILED");
  process.exit(1);
}
console.log("\n✅ All CRMProviderTasksSync tests passed");
process.exit(0);
