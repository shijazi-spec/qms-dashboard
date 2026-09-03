/**
 * CI gate: secret-leak write-path coverage for okrDatabase.
 *
 * Run:    npx tsx src/utils/okrDatabase.test.ts
 *
 * SEED-ONLY MODULE
 * ----------------
 * `okrDatabase.ts` exposes two writers:
 *   - initOkrTables() — creates the okr_objectives / okr_key_results tables,
 *     INSERTs a HARDCODED `SEED` array of 8 objectives / 24 key results, then
 *     runs idempotent UPDATEs that set `kpi_code` from a HARDCODED map.
 *   - getOkrs() — read-only (SELECT).
 *
 * Neither writer accepts caller-supplied data: every value that reaches an
 * INSERT/UPDATE params vector is a literal from the in-module `SEED` constant
 * or the hardcoded `KR_KPI_MAP`. There is therefore nothing to redact at the
 * call site (per the Step-2 seed-only note in the session plan).
 *
 * This test still:
 *   1. Mocks pg.Pool.prototype.query so no real DB is touched.
 *   2. Drives initOkrTables() end-to-end so the seed INSERT/UPDATE paths run.
 *   3. Asserts the known literal seed values pass through VERBATIM and that the
 *      `***REDACTED***` sentinel is NEVER introduced into them (anti-corruption
 *      check — proves the redacted-pool wrapper doesn't mangle clean data).
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
// Patch pg.Pool.prototype.query before the module under test is imported so
// that the pool (a redacted-pool wrapper created in kpiDatabase) never touches
// a real DB. The wrapper binds the prototype's query at construction time, so
// the mock must be installed first.
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
    : (typeof sql === "object" && Array.isArray(sql.values) ? sql.values : []);
  captured.push({ sql: sqlStr, params: paramArr });

  // initOkrTables() reads `SELECT COUNT(*)::int AS n FROM okr_objectives` and
  // only seeds when n === 0. Returning a row WITHOUT an `n` field yields
  // `undefined ?? 0` === 0, so the seed INSERT path is exercised.
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
const { initOkrTables } = await import("./okrDatabase");

const REDACTED_SENTINEL = "***REDACTED***";

/** Return all captured INSERT statements' params. */
function insertParams(): unknown[][] {
  return captured
    .filter((c) =>
      c.sql.replace(/\s+/g, " ").trim().toUpperCase().startsWith("INSERT INTO"),
    )
    .map((c) => c.params);
}

// ---------------------------------------------------------------------------
// Section 1 — drive the seed writers
// ---------------------------------------------------------------------------

console.log("\n=== okrDatabase — seed-only write-path tests ===\n");

captured.length = 0;
await initOkrTables();

const inserts = insertParams();
assert(inserts.length > 0, "initOkrTables issued at least one INSERT");

// Objective INSERT params layout:
//   [objective_code, team, objective, owner, sort_order]
const objectiveInserts = inserts.filter(
  (p) => p.length === 5 && p[0] === "Q-O1",
);
assert(
  objectiveInserts.length === 1,
  "seed INSERT for objective Q-O1 was captured",
);
if (objectiveInserts.length === 1) {
  const p = objectiveInserts[0];
  assert(p[1] === "quality", "Q-O1: team literal preserved verbatim (`quality`)");
  assert(
    p[3] === "Sara (Quality)",
    "Q-O1: owner literal preserved verbatim (`Sara (Quality)`)",
  );
  assert(
    typeof p[2] === "string" && (p[2] as string).startsWith("Deploy Internal"),
    "Q-O1: objective text preserved verbatim",
  );
}

// ---------------------------------------------------------------------------
// Section 2 — anti-corruption: literal seed values must NOT be scrubbed
// ---------------------------------------------------------------------------

console.log("\n=== anti-corruption: clean seed data is never redacted ===\n");

const allParamsFlat = captured.flatMap((c) => c.params.map((v) => String(v ?? "")));
assert(
  !allParamsFlat.some((s) => s.includes(REDACTED_SENTINEL)),
  "no captured param contains the REDACTED sentinel (clean seed data untouched)",
);

// ---------------------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n❌ okrDatabase tests FAILED");
  process.exit(1);
}
console.log("\n✅ All okrDatabase tests passed");
process.exit(0);
