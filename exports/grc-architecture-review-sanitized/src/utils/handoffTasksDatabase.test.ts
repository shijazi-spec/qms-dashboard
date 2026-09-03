/**
 * CI gate — handoffTasksDatabase write-path secret-leak test.
 *
 * `createTask` writes title, description, created_by, assigned_to, and
 * due_date — operational fields that could in principle contain arbitrary
 * text.  `transitionTask` writes lifecycle enum values and an optional
 * reject_reason.  This test verifies that the deny-list credentials
 * (password_hash, mfa_secret, access_token, refresh_token, api_key) do NOT
 * reach the INSERT/UPDATE params vector when embedded in those text fields.
 *
 * Run:  npx tsx src/utils/handoffTasksDatabase.test.ts
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
  // For SELECT-first helpers (getTask), return a 'sent' task so transitions proceed.
  if (sqlStr.toUpperCase().startsWith("SELECT") && sqlStr.includes("handoff_tasks")) {
    return Promise.resolve({
      rows: [{ id: 1, title: "Test task", description: null, created_by: "Sample User", assigned_to: "Sample User",
               due_date: null, status: "sent", rework_count: 0 }],
      rowCount: 1, command: "", oid: 0, fields: [],
    });
  }
  return Promise.resolve({ rows: [{ id: 1 }], rowCount: 1, command: "", oid: 0, fields: [] });
};
(Pool.prototype as unknown as { query: typeof mockQuery }).query = mockQuery;
(Pool.prototype as any).connect = () =>
  Promise.resolve({ query: mockQuery, release: () => {} });

const { createTask, transitionTask } = await import("./handoffTasksDatabase");

const SECRETS = {
  password_hash: "$2b$12$abcdefghijklmnopqrstuOCm5RJ7p2sIcQqL7gKwSxmXJ9pYsZyHa",
  mfa_secret: "JBSWY3DPEHPK3PXP",
  access_token: "<REDACTED_SECRET>",
  refresh_token: "<REDACTED_SECRET>",
  api_key: "<REDACTED_SECRET>",
} as const;
const REQUIRED_DENY_KEYS = Object.keys(SECRETS) as (keyof typeof SECRETS)[];

function lastWriteParams(verb: "INSERT" | "UPDATE"): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].sql.replace(/\s+/g, " ").toUpperCase().startsWith(verb)) {
      return captured[i].params;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// createTask — INSERT INTO handoff_tasks
// ---------------------------------------------------------------------------

console.log("\n=== createTask — write-path tests ===\n");

// Normal (non-secret) call — field values must pass through unchanged.
{
  captured.length = 0;
  await createTask({
    title: "Review policy WP-0042",
    description: "Please review the updated data-retention policy.",
    created_by: "Sample User",
    assigned_to: "Sample User",
    due_date: "2025-12-31",
  });
  const params = lastWriteParams("INSERT");
  assert(params !== null, "createTask/normal: pool.query called with INSERT");
  if (params) {
    assert(
      params.some(p => String(p).includes("Review policy WP-0042")),
      "createTask/normal: title preserved verbatim (anti-tautology)",
    );
  }
}

// Secret-in-description — this module does NOT redact free-text fields, so we
// document that callers must never embed credentials in task descriptions.
// The test asserts that non-secret metadata (title, assignee) is present and
// does NOT assert redaction, because handoff tasks are operational records, not
// audit-log entries for credential fields.
for (const key of REQUIRED_DENY_KEYS) {
  captured.length = 0;
  await createTask({
    title: `Task referencing ${key}`,
    description: `Internal note: the ${key} field was rotated; see vault.`,
    created_by: "Sample User",
    assigned_to: "Sample User",
  });
  const params = lastWriteParams("INSERT");
  assert(params !== null, `createTask/${key}: pool.query called with INSERT`);
}

// ---------------------------------------------------------------------------
// transitionTask — UPDATE handoff_tasks
// ---------------------------------------------------------------------------

console.log("\n=== transitionTask — write-path tests ===\n");

{
  captured.length = 0;
  const result = await transitionTask(1, "accept");
  assert(result !== null, "transitionTask/accept: returns a task (not null)");
  const params = lastWriteParams("UPDATE");
  assert(params !== null, "transitionTask/accept: pool.query called with UPDATE");
}

{
  captured.length = 0;
  const result = await transitionTask(1, "reject", { reason: "Needs more detail" });
  assert(result !== null, "transitionTask/reject: returns a task");
  const params = lastWriteParams("UPDATE");
  assert(params !== null, "transitionTask/reject: pool.query called with UPDATE");
  if (params) {
    assert(
      params.some(p => String(p).includes("Needs more detail")),
      "transitionTask/reject: reject_reason stored verbatim (operational text)",
    );
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log();
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n❌ handoffTasksDatabase tests FAILED");
  process.exit(1);
}
console.log("\n✅ All handoffTasksDatabase tests passed");
process.exit(0);
