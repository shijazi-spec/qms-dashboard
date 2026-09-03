/**
 * CI gate: prevents kpiBuCoverageDatabase write paths from persisting unmasked
 * secrets into kpi_bu_coverage.
 *
 * Run:    npx tsx src/utils/kpiBuCoverageDatabase.test.ts
 *
 * The only writer that accepts CALLER-supplied data is updateBuCoverage()
 * (note / updated_by / status / due_date flow straight into the UPDATE params
 * vector). seedBuCoverage() and syncBuCoverageFromChecklist() write only
 * hardcoded / derived data (no caller input), so there is nothing to scrub
 * there. This test mocks pool.query, drives updateBuCoverage() with payloads
 * containing the five required deny-list keys (password_hash, mfa_secret,
 * access_token, refresh_token, api_key) embedded inside the caller-supplied
 * `note` and `updated_by` fields, and asserts the raw secrets never reach the
 * UPDATE params vector while non-sensitive prose passes through verbatim.
 */

import { Pool, type QueryResult, type QueryResultRow } from "pg";

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

// ---------------------------------------------------------------------------
// Patch pg.Pool.prototype.query before the module under test is imported so the
// shared pool inside kpiDatabase (re-used by kpiBuCoverageDatabase) never
// touches a real DB.
// ---------------------------------------------------------------------------

interface CapturedQuery {
  sql: string;
  params: unknown[];
}
const captured: CapturedQuery[] = [];

type QuerySource = string | { text: string; values?: unknown[] };
type MockedPoolQuery = (
  sql: QuerySource,
  params?: unknown[],
) => Promise<QueryResult<QueryResultRow>>;

const mockQuery: MockedPoolQuery = (sql, params = []) => {
  const sqlStr = typeof sql === "string" ? sql : sql.text;
  const paramArr = Array.isArray(params)
    ? params
    : (typeof sql === "object" && sql.values) || [];
  captured.push({ sql: sqlStr, params: paramArr as unknown[] });
  // Return a plausible row so updateBuCoverage()'s RETURNING * resolves.
  return Promise.resolve({
    rows: [{ id: 1 }],
    rowCount: 1,
    command: "",
    oid: 0,
    fields: [],
  });
};

(Pool.prototype as unknown as { query: MockedPoolQuery }).query = mockQuery;

// Import AFTER the mock is in place.
const { updateBuCoverage } = await import("./kpiBuCoverageDatabase");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REDACTED_SENTINEL = "***REDACTED***";

const SECRETS = {
  password_hash: "<REDACTED_PASSWORD_HASH>_IJ",
  mfa_secret: "<REDACTED_MFA_SECRET>",
  access_token: "<REDACTED_SECRET>",
  refresh_token: "<REDACTED_SECRET>",
  api_key: "<REDACTED_SECRET>",
} as const;

const REQUIRED_DENY_KEYS = [
  "password_hash",
  "mfa_secret",
  "access_token",
  "refresh_token",
  "api_key",
] as const;

/** Return the params from the most-recent UPDATE captured. */
function lastUpdateParams(): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const c = captured[i];
    if (
      c.sql.replace(/\s+/g, " ").trim().toUpperCase().startsWith("UPDATE KPI_BU_COVERAGE SET")
    ) {
      return c.params;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section 1 — deny-list keys embedded as JSON inside the caller `note` field
//
// A caller may serialise an object snapshot into the note. redactSensitiveDeep
// parses JSON-shaped strings and scrubs deny-list keys regardless of the
// destination column name.
// ---------------------------------------------------------------------------

console.log("\n=== updateBuCoverage — deny-list keys nested in note (JSON) ===\n");

for (const key of REQUIRED_DENY_KEYS) {
  captured.length = 0;
  const rawSecret = SECRETS[key];
  const note = JSON.stringify({ context: "audit", [key]: rawSecret });

  await updateBuCoverage(1, { note }, "test-runner");

  const params = lastUpdateParams();
  assert(params !== null, `${key}: pool.query was called with UPDATE`);
  if (!params) continue;

  const combined = params.map((p) => String(p ?? "")).join("|");
  assert(
    !combined.includes(rawSecret),
    `${key}: raw secret is NOT present in UPDATE params`,
  );
  assert(
    combined.includes(REDACTED_SENTINEL),
    `${key}: REDACTED sentinel IS present in UPDATE params`,
  );
}

// ---------------------------------------------------------------------------
// Section 2 — credential-shaped strings under the innocuous `note` / updated_by
// ---------------------------------------------------------------------------

console.log("\n=== updateBuCoverage — credential-shaped strings ===\n");

{
  captured.length = 0;
  const ghp = "<REDACTED_TOKEN>";
  await updateBuCoverage(
    1,
    { note: `Reset PAT to ${ghp} per playbook.` },
    `actor-${SECRETS.access_token}`,
  );
  const params = lastUpdateParams();
  assert(params !== null, "credential-string: pool.query was called");
  if (params) {
    const combined = params.map((p) => String(p ?? "")).join("|");
    assert(
      !combined.includes(ghp) && !combined.includes(SECRETS.access_token),
      "credential-string: raw token / access_token are NOT present in params",
    );
    assert(
      combined.includes(REDACTED_SENTINEL),
      "credential-string: REDACTED sentinel IS present in params",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 3 — anti-tautology: ordinary prose passes through verbatim
// ---------------------------------------------------------------------------

console.log("\n=== updateBuCoverage — non-sensitive passthrough ===\n");

{
  captured.length = 0;
  await updateBuCoverage(
    1,
    {
      completion_pct: 75,
      status: "in_progress",
      due_date: "2026-06-30",
      note: "Customer Success onboarding on track for Q2",
    },
    "Sample User",
  );
  const params = lastUpdateParams();
  assert(params !== null, "non-sensitive: pool.query was called");
  if (params) {
    const combined = params.map((p) => String(p ?? "")).join("|");
    assert(
      combined.includes("Customer Success onboarding on track for Q2"),
      "non-sensitive: note prose preserved verbatim (test isn't a tautology)",
    );
    assert(
      combined.includes("Sample User"),
      "non-sensitive: updated_by preserved verbatim",
    );
    assert(
      combined.includes("in_progress") && combined.includes("2026-06-30"),
      "non-sensitive: status + due_date preserved verbatim",
    );
    assert(
      !combined.includes(REDACTED_SENTINEL),
      "non-sensitive: REDACTED sentinel NOT present (redactor is targeted)",
    );
    assert(
      params.includes(75),
      "non-sensitive: numeric completion_pct preserved as a number",
    );
  }
}

// ---------------------------------------------------------------------------

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n❌ kpiBuCoverageDatabase tests FAILED");
  process.exit(1);
}
console.log("\n✅ All kpiBuCoverageDatabase tests passed");
process.exit(0);
