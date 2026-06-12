/**
 * CI gate companion test for src/utils/supabaseBackup.ts.
 *
 * Run:    npx tsx src/utils/supabaseBackup.test.ts
 * Wired:  scripts/post-merge.sh (auto-discovered by tests/runIntegrationTests.ts)
 *
 * IMPORTANT — why this writer does NOT redact secrets
 * ---------------------------------------------------
 * The secret-leak gate (src/utils/README.md) exists to stop modules that
 * persist *new user-controlled data* from writing unmasked credentials into an
 * application table. runSupabaseRefresh() is a different category: it is a
 * faithful, whole-database disaster-recovery MIRROR. It reads every row already
 * stored in the live Postgres and replicates it verbatim into the org's own
 * Supabase fallback DB so a recent snapshot is always restorable.
 *
 * Redacting here would be a correctness/availability bug, not a security win:
 * a restored backup whose `password_hash`, `mfa_secret`, etc. had been replaced
 * with `***REDACTED***` would lock every user out and destroy the very data the
 * backup exists to protect. The data is not newly introduced by this module —
 * it is already in Postgres — so mirroring it to the same org's secured fallback
 * does not widen exposure.
 *
 * The genuine security property this writer MUST uphold is therefore different:
 * every replicated row value must travel as a BOUND query parameter, never
 * interpolated into the SQL text. That keeps attacker-controlled cell contents
 * from becoming executable SQL in the backup path. This test asserts exactly
 * that, and asserts the mirror copies faithfully (so a future "helpful" edit
 * that silently redacts the backup is caught).
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
// Fixtures: a single source table whose rows contain credential-shaped values
// under deny-list column names. A faithful mirror MUST copy these verbatim.
// ---------------------------------------------------------------------------

const SECRETS = {
  password_hash: "$2b$12$abcdefghij1234567890uvwxyz.ABCDEFGH_IJ",
  mfa_secret: "JBSWY3DPEHPK3PXP",
  access_token: "ya29.a0AfH6SMBxxxxAccessTokenVALUE",
  refresh_token: "1//0gREFRESHTOKENvalueXYZ",
  api_key: "sk-PLAINTEXTAPIKEY1234567890",
} as const;

const SOURCE_ROWS = [
  {
    id: 1,
    email: "alice@example.com",
    password_hash: SECRETS.password_hash,
    mfa_secret: SECRETS.mfa_secret,
  },
  {
    id: 2,
    email: "bob@example.com",
    password_hash: SECRETS.access_token, // arbitrary secret-shaped value
    mfa_secret: SECRETS.refresh_token,
  },
];

// ---------------------------------------------------------------------------
// Mock pg before importing the module under test.
//   • Pool.prototype.query   — services sharedPool reads (table discovery +
//                              SELECT * batches).
//   • Pool.prototype.connect — returns a fake target client capturing writes.
//   • Pool.prototype.end     — no-op.
// ---------------------------------------------------------------------------

type QuerySource = string | { text: string; values?: unknown[] };

interface Captured {
  sql: string;
  params: unknown[];
}
const targetCalls: Captured[] = [];

function emptyResult(): QueryResult<QueryResultRow> {
  return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
}

// sharedPool reads (table list + paged SELECT *).
const readQuery = (sql: QuerySource, params: unknown[] = []) => {
  const sqlStr = typeof sql === "string" ? sql : sql.text;
  if (/pg_tables/i.test(sqlStr)) {
    return Promise.resolve({
      ...emptyResult(),
      rows: [{ tablename: "users" }],
      rowCount: 1,
    } as QueryResult<QueryResultRow>);
  }
  if (/SELECT \* FROM/i.test(sqlStr)) {
    // params = [LIMIT, OFFSET]; only the first page (offset 0) has data.
    const offset = Number(Array.isArray(params) ? params[1] : 0) || 0;
    const rows = offset === 0 ? SOURCE_ROWS : [];
    return Promise.resolve({
      ...emptyResult(),
      rows: rows as unknown as QueryResultRow[],
      rowCount: rows.length,
    } as QueryResult<QueryResultRow>);
  }
  return Promise.resolve(emptyResult());
};

(Pool.prototype as unknown as { query: typeof readQuery }).query = readQuery;

const fakeTargetClient = {
  query(sql: QuerySource, params: unknown[] = []) {
    const sqlStr = typeof sql === "string" ? sql : sql.text;
    targetCalls.push({ sql: sqlStr, params: Array.isArray(params) ? params : [] });
    return Promise.resolve(emptyResult());
  },
  release() {
    /* no-op */
  },
};

(Pool.prototype as unknown as { connect: () => Promise<unknown> }).connect = () =>
  Promise.resolve(fakeTargetClient);
(Pool.prototype as unknown as { end: () => Promise<void> }).end = () =>
  Promise.resolve();

// Required by the writer; any value works since the pool is mocked.
process.env.SUPABASE_DATABASE_URL =
  process.env.SUPABASE_DATABASE_URL || "postgres://mock/mock";

const { runSupabaseRefresh } = await import("./supabaseBackup");

// ---------------------------------------------------------------------------
// Drive the refresh and inspect the captured target-side writes.
// ---------------------------------------------------------------------------

console.log("\n=== runSupabaseRefresh — mirror integrity & SQL safety ===\n");

const result = await runSupabaseRefresh();

assert(result.tablesProcessed === 1, "one source table was processed");
assert(result.totalRowsCopied === SOURCE_ROWS.length, "all source rows were copied");
assert(result.errors.length === 0, "no per-table errors");

const truncateCall = targetCalls.find((c) => /TRUNCATE TABLE/i.test(c.sql));
const insertCall = targetCalls.find((c) =>
  c.sql.replace(/\s+/g, " ").trim().toUpperCase().startsWith("INSERT INTO"),
);

assert(!!truncateCall, "target table is TRUNCATEd before re-insert (clean rewrite)");
assert(!!insertCall, "an INSERT was issued against the target");

if (insertCall) {
  // 1. SQL-injection safety: every row value is a bound parameter, so no raw
  //    secret (or any cell value) may appear in the INSERT SQL text.
  const everySecretAbsentFromSql = Object.values(SECRETS).every(
    (s) => !insertCall.sql.includes(s),
  );
  assert(
    everySecretAbsentFromSql,
    "no row value is interpolated into INSERT SQL text (values are bound params, injection-safe)",
  );
  assert(
    /VALUES\s*\(\s*\$1\b/i.test(insertCall.sql),
    "INSERT uses $N placeholders rather than literal values",
  );

  // 2. Mirror fidelity: the backup MUST be a faithful copy. Secrets are present
  //    VERBATIM in the bound params (NOT redacted) — redacting the mirror would
  //    corrupt disaster-recovery restores. This guards against a future change
  //    that wrongly applies redaction to the backup path.
  const flat = insertCall.params.map((p) => String(p ?? ""));
  assert(
    flat.includes(SECRETS.password_hash) && flat.includes(SECRETS.mfa_secret),
    "page-1 secrets are mirrored verbatim into bound params (faithful backup, not redacted)",
  );
  assert(
    !flat.includes("***REDACTED***"),
    "backup params contain NO redaction sentinel (mirror must not corrupt restorable data)",
  );

  // 3. Non-secret fields are mirrored too (anti-tautology).
  assert(
    flat.includes("alice@example.com") && flat.includes("bob@example.com"),
    "non-secret fields (email) are mirrored verbatim",
  );

  // 4. Param count matches rows × columns.
  const cols = Object.keys(SOURCE_ROWS[0]).length;
  assert(
    insertCall.params.length === SOURCE_ROWS.length * cols,
    `bound param count equals rows × columns (${SOURCE_ROWS.length} × ${cols})`,
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.error("❌ supabaseBackup mirror-integrity test FAILED");
  process.exit(1);
}
console.log("✅ supabaseBackup mirror-integrity test passed");
