/**
 * CI gate: prevents controlsCrosswalk write paths from persisting unmasked
 * secrets into the `controls` / `control_clause_mappings` tables.
 *
 * Run:    npx tsx src/utils/controlsCrosswalk.test.ts
 *
 * The two public writers — upsertControl() (controls) and mapControlToClause()
 * (control_clause_mappings) — take caller-supplied control_code / title /
 * description / domain / source. Each such value is now wrapped with
 * redactSensitiveDeep() before it reaches the INSERT params vector. This test
 * mocks pg.Pool.prototype.query, drives the real write functions with
 * credential-shaped values (bcrypt, JWT, sk-/ghp_ tokens) AND objects that
 * carry the deny-list keys, then asserts the raw secrets never reach the
 * INSERT params while the ***REDACTED*** sentinel does.
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
// that the shared pool inside controlsCrosswalk never touches a real DB.
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
    : typeof sql === "object" && Array.isArray(sql.values)
      ? sql.values
      : [];
  captured.push({ sql: sqlStr, params: paramArr });
  // upsertControl reads r.rows[0].id after INSERT — return a plausible row.
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
const { upsertControl, mapControlToClause } = await import("./controlsCrosswalk");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REDACTED_SENTINEL = "***REDACTED***";

/** Return the params from the most-recent INSERT captured for a given table. */
function lastInsertParams(table: string): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const norm = captured[i].sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (norm.startsWith(`INSERT INTO ${table.toUpperCase()}`)) {
      return captured[i].params;
    }
  }
  return null;
}

// Credential-shaped strings caught by the regex deny list regardless of the
// (non-sensitive) column name they are stored under.
const SECRET_STRINGS = {
  bcrypt: "<REDACTED_PASSWORD_HASH>",
  jwt: "<REDACTED_TOKEN>",
  skKey: "<REDACTED_SECRET>",
  ghp: "<REDACTED_TOKEN>",
} as const;

// ---------------------------------------------------------------------------
// Section 1 — upsertControl write-path tests
// ---------------------------------------------------------------------------

console.log("\n=== upsertControl — write-path secret-leak tests ===\n");

{
  captured.length = 0;
  await upsertControl({
    control_code: `CTRL-${SECRET_STRINGS.ghp}`,
    title: `Title with token ${SECRET_STRINGS.jwt}`,
    description: `Reset bcrypt hash ${SECRET_STRINGS.bcrypt} per playbook`,
    domain: "access-control",
    source: `import:${SECRET_STRINGS.skKey}`,
  });

  const params = lastInsertParams("controls");
  assert(params !== null, "controls: pool.query was called with INSERT");
  if (params) {
    // params layout: [control_code, title, description, domain, source]
    const combined = params.map((p) => String(p ?? "")).join("|");

    for (const [label, secret] of Object.entries(SECRET_STRINGS)) {
      assert(
        !combined.includes(secret),
        `controls/${label}: raw secret-shaped value is NOT present in INSERT params`,
      );
    }
    assert(
      combined.includes(REDACTED_SENTINEL),
      "controls: REDACTED sentinel IS present in INSERT params",
    );
    // Anti-tautology: a non-sensitive value passes through verbatim.
    assert(
      String(params[3] ?? "") === "access-control",
      "controls/non-sensitive: domain 'access-control' preserved verbatim",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 2 — mapControlToClause write-path tests
// ---------------------------------------------------------------------------

console.log("\n=== mapControlToClause — write-path secret-leak tests ===\n");

{
  captured.length = 0;
  await mapControlToClause(
    /* controlId    */ 1,
    /* obligationId */ 2,
    /* relationship */ "equal_to",
    /* strength     */ 7,
    /* source       */ `sync:${SECRET_STRINGS.skKey}`,
  );

  const params = lastInsertParams("control_clause_mappings");
  assert(params !== null, "mappings: pool.query was called with INSERT");
  if (params) {
    // params layout: [control_id, obligation_id, relationship_type, strength, source]
    const sourceParam = String(params[4] ?? "");
    assert(
      !sourceParam.includes(SECRET_STRINGS.skKey),
      "mappings/source: raw secret-shaped value is NOT present in source param",
    );
    assert(
      sourceParam.includes(REDACTED_SENTINEL),
      "mappings/source: REDACTED sentinel IS present in source param",
    );
    // Anti-tautology: numeric / enum params pass through unchanged.
    assert(
      params[0] === 1 && params[1] === 2,
      "mappings/non-sensitive: control_id & obligation_id preserved verbatim",
    );
    assert(
      params[2] === "equal_to" && params[3] === 7,
      "mappings/non-sensitive: relationship & strength preserved verbatim",
    );
  }
}

// Anti-tautology: an ordinary control with no secrets must pass through clean.
{
  captured.length = 0;
  await upsertControl({
    control_code: "AC-2",
    title: "Account Management",
    description: "Manage information system accounts.",
    domain: "access-control",
    source: "custom",
  });
  const params = lastInsertParams("controls");
  assert(params !== null, "controls/clean: pool.query was called");
  if (params) {
    const combined = params.map((p) => String(p ?? "")).join("|");
    assert(
      params[0] === "AC-2" && params[1] === "Account Management",
      "controls/clean: ordinary control_code & title preserved verbatim",
    );
    assert(
      !combined.includes(REDACTED_SENTINEL),
      "controls/clean: REDACTED sentinel NOT present (redactor is targeted)",
    );
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n❌ controlsCrosswalk tests FAILED");
  process.exit(1);
}
console.log("\n✅ All controlsCrosswalk tests passed");
process.exit(0);
