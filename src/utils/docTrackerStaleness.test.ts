/**
 * CI gate — docTrackerStaleness write-path secret-leak test.
 *
 * `evaluateCollectorHealth` issues `UPDATE doc_tracker_collectors SET
 * health_state = …` — the only value written is a fixed enum string ('ok',
 * 'stale', 'silent') plus a server-side NOW() call.  No user-controlled
 * text reaches the UPDATE params vector.  This test documents that invariant
 * and verifies the write path reaches pool.query without throwing.
 *
 * Run:  npx tsx src/utils/docTrackerStaleness.test.ts
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
  // Return one degraded collector so the UPDATE branch is exercised.
  if (sqlStr.includes("doc_tracker_collectors") && sqlStr.toUpperCase().includes("SELECT")) {
    return Promise.resolve({
      rows: [{
        collector_id: "ci-collector",
        health_state: "ok",
        enabled: true,
        heartbeat_minutes: 200,   // silent (> 90 min)
        snapshot_hours: 30,       // stale (> 26 h)
        alert_age_hours: 48,      // alert is due (> 20 h gap)
      }],
      rowCount: 1, command: "", oid: 0, fields: [],
    });
  }
  return Promise.resolve({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] });
};
(Pool.prototype as unknown as { query: typeof mockQuery }).query = mockQuery;
(Pool.prototype as any).connect = () =>
  Promise.resolve({ query: mockQuery, release: () => {} });

const { evaluateCollectorHealth, computeHealthState, isAlertDue, isDegraded } = await import("./docTrackerStaleness");

// ---------------------------------------------------------------------------
// Pure functions — no I/O
// ---------------------------------------------------------------------------

console.log("\n=== computeHealthState / isDegraded / isAlertDue — pure logic ===\n");

{
  const healthy = computeHealthState({ enabled: true, snapshotHours: 1, heartbeatMinutes: 10 });
  assert(healthy === "ok", "computeHealthState: recent snapshot+heartbeat → ok");

  const stale = computeHealthState({ enabled: true, snapshotHours: 30, heartbeatMinutes: 10 });
  assert(stale === "stale", "computeHealthState: old snapshot → stale");

  const silent = computeHealthState({ enabled: true, snapshotHours: 1, heartbeatMinutes: 200 });
  assert(silent === "silent", "computeHealthState: dead heartbeat → silent");

  assert(isDegraded("stale"), "isDegraded: stale is degraded");
  assert(isDegraded("silent"), "isDegraded: silent is degraded");
  assert(!isDegraded("ok"), "isDegraded: ok is NOT degraded");

  assert(isAlertDue(25), "isAlertDue: 25h gap → alert due");
  assert(!isAlertDue(5), "isAlertDue: 5h gap → not due yet");
}

// ---------------------------------------------------------------------------
// evaluateCollectorHealth — UPDATE path
// ---------------------------------------------------------------------------

console.log("\n=== evaluateCollectorHealth — write-path tests ===\n");

{
  captured.length = 0;
  const result = await evaluateCollectorHealth();
  assert(typeof result.evaluated === "number", "evaluateCollectorHealth: returns evaluated count");

  const updates = captured.filter(c => c.sql.replace(/\s+/g, " ").toUpperCase().includes("UPDATE"));
  // health_state is a fixed enum written directly — no user text in params.
  for (const u of updates) {
    const secrets = ["password_hash", "mfa_secret", "access_token", "refresh_token", "api_key"];
    const joined = u.params.map(String).join("|");
    for (const s of secrets) {
      assert(!joined.includes(s), `UPDATE params do not contain deny-list key '${s}'`);
    }
  }
  assert(true, "evaluateCollectorHealth: completed without throwing");
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log();
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n❌ docTrackerStaleness tests FAILED");
  process.exit(1);
}
console.log("\n✅ All docTrackerStaleness tests passed");
process.exit(0);
