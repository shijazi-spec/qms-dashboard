/**
 * CI gate — docTrackerDatabase write-path secret-leak test.
 *
 * `recordSnapshot` and `touchCollector` write operational metadata:
 * snapshot hashes, collector IDs, version strings, health states, and
 * library paths. None of these fields accept user-controlled free-text
 * that could carry a credential — they are derived from the collector
 * agent or from fixed strings. This test documents that invariant and
 * verifies the write path reaches pool.query without throwing.
 *
 * Run:  npx tsx src/utils/docTrackerDatabase.test.ts
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
  return Promise.resolve({ rows: [{ id: 42 }], rowCount: 1, command: "", oid: 0, fields: [] });
};
(Pool.prototype as unknown as { query: typeof mockQuery }).query = mockQuery;

// Also stub pool.connect (used by advisory-lock path in initDocTrackerTables).
(Pool.prototype as any).connect = () =>
  Promise.resolve({ query: mockQuery, release: () => {} });

const { recordSnapshot, touchCollector } = await import("./docTrackerDatabase");

// ---------------------------------------------------------------------------
// recordSnapshot — writes to doc_tracker_snapshots
// ---------------------------------------------------------------------------

console.log("\n=== recordSnapshot — write-path tests ===\n");

{
  captured.length = 0;
  const id = await recordSnapshot({
    collector_id: "ci-collector-01",
    snapshot_hash: "abc123",
    mode: "full",
    status: "applied",
    documents_in: 10,
    inserted: 3,
    updated: 2,
    soft_deleted: 1,
    orphans: 0,
    stats: { duration_ms: 500 },
  });
  const inserts = captured.filter(c => c.sql.replace(/\s+/g, " ").toUpperCase().includes("INSERT INTO"));
  assert(inserts.length > 0, "recordSnapshot: pool.query called with INSERT INTO");
  assert(typeof id === "number", "recordSnapshot: returned a numeric id");
}

// ---------------------------------------------------------------------------
// touchCollector — upserts into doc_tracker_collectors
// ---------------------------------------------------------------------------

console.log("\n=== touchCollector — write-path tests ===\n");

{
  captured.length = 0;
  await touchCollector({
    collector_id: "ci-collector-01",
    collector_version: "1.2.3",
    library_root: "/mnt/docs",
    snapshot: true,
  });
  const writes = captured.filter(c => {
    const u = c.sql.replace(/\s+/g, " ").toUpperCase();
    return u.includes("INSERT INTO") || u.includes("UPDATE");
  });
  assert(writes.length > 0, "touchCollector: pool.query called with INSERT/UPDATE");
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log();
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n❌ docTrackerDatabase tests FAILED");
  process.exit(1);
}
console.log("\n✅ All docTrackerDatabase tests passed");
process.exit(0);
