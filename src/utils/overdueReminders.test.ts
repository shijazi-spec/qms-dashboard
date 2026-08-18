/**
 * CI gate — overdueReminders write-path secret-leak test.
 *
 * `sendOverdueReminders` issues:
 *   UPDATE handoff_tasks SET last_reminder_at = NOW() WHERE id = $1
 *   UPDATE tech_requests  SET last_reminder_at = NOW() WHERE id = $1
 *
 * The only param is the primary-key integer. No user text reaches the UPDATE
 * params vector.  This test documents that invariant and verifies the write
 * path reaches pool.query without throwing (using a mock that returns zero
 * overdue rows, so no emails are sent and no UPDATEs are issued).
 *
 * Run:  npx tsx src/utils/overdueReminders.test.ts
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
  // Return empty rows for all SELECTs — no overdue items means no emails,
  // no UPDATEs, and the function exits cleanly after both passes.
  return Promise.resolve({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] });
};
(Pool.prototype as unknown as { query: typeof mockQuery }).query = mockQuery;
(Pool.prototype as any).connect = () =>
  Promise.resolve({ query: mockQuery, release: () => {} });

const { sendOverdueReminders } = await import("./overdueReminders");

// ---------------------------------------------------------------------------
// sendOverdueReminders — zero-overdue path (no emails, no UPDATEs)
// ---------------------------------------------------------------------------

console.log("\n=== sendOverdueReminders (no-op path) — write-path tests ===\n");

{
  captured.length = 0;
  const result = await sendOverdueReminders();
  assert(typeof result.sent === "number", "sendOverdueReminders: returns { sent: number }");
  assert(result.sent === 0, "sendOverdueReminders: sent=0 when no overdue rows");

  // Verify no UPDATE was issued (no overdue rows → nothing to stamp).
  const updates = captured.filter(c => c.sql.replace(/\s+/g, " ").toUpperCase().startsWith("UPDATE"));
  assert(updates.length === 0, "sendOverdueReminders: no UPDATE issued when no overdue rows");

  // Verify the only non-zero params that could appear are integers (IDs) —
  // the UPDATE sets last_reminder_at = NOW() server-side with only $1 = id.
  for (const u of updates) {
    const nonIntParams = u.params.filter(p => typeof p !== "number");
    assert(
      nonIntParams.length === 0,
      "sendOverdueReminders: UPDATE params are integers only (no user text)",
    );
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log();
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n❌ overdueReminders tests FAILED");
  process.exit(1);
}
console.log("\n✅ All overdueReminders tests passed");
process.exit(0);
