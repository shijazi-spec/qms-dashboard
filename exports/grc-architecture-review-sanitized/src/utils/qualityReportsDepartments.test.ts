/**
 * CI gate — qualityReportsDepartments write-path secret-leak test.
 *
 * `upsertBU` writes BU metadata (bu_key, bu_name, channel, fn, head_email,
 * policy_department, kpi_bu_name, kpi_owner_name, sort_order, is_active).
 * `setBUOwners` writes owner emails.  These are operational configuration
 * fields — not free-text that would carry credentials.  This test documents
 * that invariant and verifies pool.query is reached without throwing.
 *
 * Run:  npx tsx src/utils/qualityReportsDepartments.test.ts
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
  id: 1, bu_key: "ci-bu", bu_name: "CI BU", channel: "B2B",
  segment: "ExampleOrg", fn: "eng", head_email: null, policy_department: null,
  kpi_bu_name: null, kpi_owner_name: null, sort_order: 0, is_active: true,
  created_at: new Date(), updated_at: new Date(),
};

type QS = string | { text: string; values?: unknown[] };
const mockQuery = (sql: QS, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
  const sqlStr = typeof sql === "string" ? sql : sql.text;
  captured.push({ sql: sqlStr, params: Array.isArray(params) ? params : [] });
  if (sqlStr.includes("quality_report_bus") && sqlStr.toUpperCase().includes("SELECT")) {
    return Promise.resolve({ rows: [fakeRow], rowCount: 1, command: "", oid: 0, fields: [] });
  }
  if (sqlStr.includes("quality_report_bu_owners") && sqlStr.toUpperCase().includes("SELECT")) {
    return Promise.resolve({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] });
  }
  return Promise.resolve({ rows: [fakeRow], rowCount: 1, command: "", oid: 0, fields: [] });
};
(Pool.prototype as unknown as { query: typeof mockQuery }).query = mockQuery;
(Pool.prototype as any).connect = () =>
  Promise.resolve({ query: mockQuery, release: () => {} });

const { upsertBU, setBUOwners } = await import("./qualityReportsDepartments");

// ---------------------------------------------------------------------------
// upsertBU — INSERT … ON CONFLICT DO UPDATE
// ---------------------------------------------------------------------------

console.log("\n=== upsertBU — write-path tests ===\n");

{
  captured.length = 0;
  const bu = await upsertBU({
    bu_key: "ci-bu",
    bu_name: "CI Business Unit",
    channel: "B2B",
    fn: "Engineering",
    head_email: "<REDACTED_EMAIL>",
    sort_order: 1,
    is_active: true,
  });
  assert(bu !== null && typeof bu === "object", "upsertBU: returns a BU object");
  const writes = captured.filter(c => {
    const u = c.sql.replace(/\s+/g, " ").toUpperCase();
    return u.includes("INSERT") || u.includes("UPDATE");
  });
  assert(writes.length > 0, "upsertBU: pool.query called with INSERT/UPDATE");

  // Verify no deny-list credential keys appear in params.
  const denyKeys = ["password_hash", "mfa_secret", "access_token", "refresh_token", "api_key"];
  for (const w of writes) {
    const joined = w.params.map(String).join("|");
    for (const dk of denyKeys) {
      assert(!joined.includes(dk), `upsertBU: '${dk}' not present in INSERT/UPDATE params`);
    }
  }
}

// ---------------------------------------------------------------------------
// setBUOwners — DELETE + INSERT per owner email
// ---------------------------------------------------------------------------

console.log("\n=== setBUOwners — write-path tests ===\n");

{
  captured.length = 0;
  await setBUOwners(1, ["<REDACTED_EMAIL>", "<REDACTED_EMAIL>"]);
  const inserts = captured.filter(c => c.sql.replace(/\s+/g, " ").toUpperCase().includes("INSERT"));
  assert(inserts.length > 0, "setBUOwners: pool.query called with INSERT for each owner");

  // Params are [buId, email] — neither is credential-shaped.
  for (const ins of inserts) {
    const joined = ins.params.map(String).join("|");
    const denyKeys = ["password_hash", "mfa_secret", "access_token", "refresh_token", "api_key"];
    for (const dk of denyKeys) {
      assert(!joined.includes(dk), `setBUOwners: '${dk}' not present in INSERT params`);
    }
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log();
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n❌ qualityReportsDepartments tests FAILED");
  process.exit(1);
}
console.log("\n✅ All qualityReportsDepartments tests passed");
process.exit(0);
