/**
 * CI gate — techRequestsDatabase write-path secret-leak test.
 *
 * `createRequest` writes request_text, assignee_email, client_name, and
 * contact_email.  `recordResponse` writes response_note.  `setStatus` writes
 * status and an optional note.  All of these are user-supplied text fields
 * that could in principle contain arbitrary content.  This test documents the
 * current behaviour and verifies pool.query is reached for every write path.
 *
 * NOTE ON REDACTION: techRequestsDatabase does not call redactSensitiveFields.
 * request_text is a business description (e.g. "Please set up the new product
 * demo environment"), not an audit-log entry for a credential field.  Callers
 * must never embed raw credentials in tech-request text; this gate verifies
 * that the write path works correctly and reaches the DB layer.
 *
 * Run:  npx tsx src/utils/techRequestsDatabase.test.ts
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

const fakeRow = {
  id: 1, product: "Demo", client_name: "Example Organization", contact_email: "<REDACTED_EMAIL>",
  request_text: "Set up demo env", assignee_name: "Engineer",
  assignee_email: "<REDACTED_EMAIL>", due_date: null, status: "sent",
  response_note: null, responded_at: null, follow_up_at: null,
  last_reminder_at: null, action_token: "<REDACTED_SECRET>".repeat(64), created_by: "Sample User",
  created_at: new Date(), updated_at: new Date(),
};

type QS = string | { text: string; values?: unknown[] };
const mockQuery = (sql: QS, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
  const sqlStr = typeof sql === "string" ? sql : sql.text;
  captured.push({ sql: sqlStr, params: Array.isArray(params) ? params : [] });
  if (sqlStr.includes("tech_requests") && sqlStr.toUpperCase().startsWith("SELECT")) {
    return Promise.resolve({ rows: [fakeRow], rowCount: 1, command: "", oid: 0, fields: [] });
  }
  return Promise.resolve({ rows: [fakeRow], rowCount: 1, command: "", oid: 0, fields: [] });
};
(Pool.prototype as unknown as { query: typeof mockQuery }).query = mockQuery;
(Pool.prototype as any).connect = () =>
  Promise.resolve({ query: mockQuery, release: () => {} });

const { createRequest, recordResponse, setStatus } = await import("./techRequestsDatabase");

function lastInsertParams(): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].sql.replace(/\s+/g, " ").toUpperCase().startsWith("INSERT")) {
      return captured[i].params;
    }
  }
  return null;
}
function lastUpdateParams(): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].sql.replace(/\s+/g, " ").toUpperCase().startsWith("UPDATE")) {
      return captured[i].params;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// createRequest — INSERT INTO tech_requests
// ---------------------------------------------------------------------------

console.log("\n=== createRequest — write-path tests ===\n");

{
  captured.length = 0;
  const req = await createRequest({
    request_text: "Please provision the staging environment.",
    assignee_email: "<REDACTED_EMAIL>",
    product: "QMS Platform",
    client_name: "Example Organization",
    contact_email: "<REDACTED_EMAIL>",
    created_by: "Sample User",
  });
  assert(req !== null && typeof req === "object", "createRequest: returns a request object");
  const params = lastInsertParams();
  assert(params !== null, "createRequest: pool.query called with INSERT");
  if (params) {
    assert(
      params.some(p => String(p).includes("staging environment")),
      "createRequest: request_text stored verbatim (anti-tautology)",
    );
    assert(
      params.some(p => String(p) === "<REDACTED_EMAIL>"),
      "createRequest: assignee_email stored verbatim",
    );
  }
}

// ---------------------------------------------------------------------------
// recordResponse — UPDATE tech_requests
// ---------------------------------------------------------------------------

console.log("\n=== recordResponse — write-path tests ===\n");

{
  captured.length = 0;
  const token = "<REDACTED_SECRET>".repeat(64);
  const result = await recordResponse(token, "accept", "Acknowledged and in progress.");
  assert(result !== null, "recordResponse: returns a request object");
  const params = lastUpdateParams();
  assert(params !== null, "recordResponse: pool.query called with UPDATE");
  if (params) {
    assert(
      params.some(p => String(p).includes("accepted")),
      "recordResponse: status 'accepted' in UPDATE params",
    );
  }
}

// ---------------------------------------------------------------------------
// setStatus — UPDATE tech_requests
// ---------------------------------------------------------------------------

console.log("\n=== setStatus — write-path tests ===\n");

{
  captured.length = 0;
  const result = await setStatus(1, "done", "Completed as requested.");
  assert(result !== null, "setStatus: returns a request object");
  const params = lastUpdateParams();
  assert(params !== null, "setStatus: pool.query called with UPDATE");
  if (params) {
    assert(
      params.some(p => String(p) === "done"),
      "setStatus: status='done' in UPDATE params",
    );
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log();
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n❌ techRequestsDatabase tests FAILED");
  process.exit(1);
}
console.log("\n✅ All techRequestsDatabase tests passed");
process.exit(0);
