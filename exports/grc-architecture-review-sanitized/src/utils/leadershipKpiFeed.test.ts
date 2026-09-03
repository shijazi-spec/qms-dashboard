/**
 * CI gate: companion secret-leak test for src/utils/leadershipKpiFeed.ts.
 *
 * Run:    npx tsx src/utils/leadershipKpiFeed.test.ts
 * Wired:  auto-discovered by tests/runIntegrationTests.ts (npm test) and
 *         enforced by scripts/check-db-test-coverage.sh.
 *
 * SEED-ONLY ANALYSIS
 * ------------------
 * leadershipKpiFeed.ts is ~1373 lines and almost entirely SELECT reads that
 * compute KPI values. It contains exactly ONE write statement:
 *
 *     INSERT INTO business_units (bu_name, is_commercial)
 *     VALUES ($1, $2) ON CONFLICT (bu_name) DO NOTHING
 *
 * Its params are sourced from the module-level CANONICAL_BUSINESS_UNITS array
 * — a HARDCODED list of the 13 GRQ Quality-Plan business units. There is NO
 * caller-supplied data flowing into this INSERT: the only exported entry point
 * (`buildLeadershipKpiFeed()`) takes no arguments, and every value persisted is
 * a fixed literal. Per src/utils/README.md and the session contract's
 * seed-only note, there is therefore nothing to redact in the source file.
 *
 * This test still satisfies the gate by:
 *   1. Mocking pg.Pool.prototype.query before importing the module.
 *   2. Invoking the exported write path (buildLeadershipKpiFeed) so the
 *      INSERT INTO business_units actually executes.
 *   3. Asserting the known literal BU values reach the params VERBATIM and that
 *      no `***REDACTED***`-style corruption is introduced into seed data
 *      (anti-tautology: proves the writer doesn't mangle its own literals).
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

const REDACTED_SENTINEL = "***REDACTED***";

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
  // Return a plausible, harmless shape. The KPI calculators read named
  // aggregate columns (total/completed/etc.) which will be undefined here, so
  // each calc resolves to dataAvailable:false — that's fine; we only care that
  // the business_units seeding INSERT executes along the way.
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
const { buildLeadershipKpiFeed } = await import("./leadershipKpiFeed");

/** Collect every captured INSERT INTO business_units statement's params. */
function businessUnitInserts(): unknown[][] {
  return captured
    .filter((c) =>
      c.sql.replace(/\s+/g, " ").toUpperCase().includes("INSERT INTO BUSINESS_UNITS"),
    )
    .map((c) => c.params);
}

console.log("\n=== leadershipKpiFeed — seed-only write-path test ===\n");

captured.length = 0;

// Drive the only exported write path. It must not throw with a mocked pool.
let buildError: unknown = null;
try {
  await buildLeadershipKpiFeed();
} catch (err) {
  buildError = err;
}
assert(buildError === null, "buildLeadershipKpiFeed() runs without throwing under a mocked pool");

const inserts = businessUnitInserts();
assert(inserts.length > 0, "INSERT INTO business_units executed during the feed build");

if (inserts.length > 0) {
  const allParams = inserts.flat();
  const stringParams = allParams.map((p) => String(p ?? ""));
  const combined = stringParams.join("|");

  // Anti-corruption: hardcoded seed literals must pass through verbatim — the
  // writer must not inject the redaction sentinel into its own fixed data.
  assert(
    !combined.includes(REDACTED_SENTINEL),
    "business_units seed params contain NO ***REDACTED*** sentinel (literals untouched)",
  );

  // Anti-tautology: a known literal BU name reaches the params verbatim, and the
  // boolean is_commercial flag is preserved — proving the INSERT path is real.
  const sdrInsert = inserts.find((p) => p[0] === "SDR");
  assert(
    sdrInsert !== undefined,
    "business_units INSERT carries the literal bu_name 'SDR' verbatim",
  );
  if (sdrInsert) {
    assert(
      sdrInsert[1] === true,
      "business_units INSERT preserves is_commercial=true for 'SDR'",
    );
  }

  // Spot-check a non-commercial BU too, to prove multiple literals survive.
  const grcInsert = inserts.find((p) => p[0] === "GRC");
  assert(
    grcInsert !== undefined && grcInsert[1] === false,
    "business_units INSERT carries literal 'GRC' with is_commercial=false verbatim",
  );
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n❌ leadershipKpiFeed tests FAILED");
  process.exit(1);
}
console.log("\n✅ All leadershipKpiFeed tests passed");
process.exit(0);
