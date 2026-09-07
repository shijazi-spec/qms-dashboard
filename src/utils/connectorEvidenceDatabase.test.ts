/**
 * CI gate: prevents connectorEvidenceDatabase write paths from persisting
 * unmasked secrets into connector_evidence.
 *
 * Run:    npx tsx src/utils/connectorEvidenceDatabase.test.ts
 * Wired:  auto-discovered by `npm test` (tests/runIntegrationTests.ts)
 *
 * Why this module needs it more than most: `observed` is a free-form
 * `Record<string, any>` written straight to JSONB. The GitHub checks that exist
 * today are careful to store counts rather than secrets — the secret-scanning
 * check deliberately records alert TYPES and never alert bodies — but this is
 * the generic write path every future connector will use, and "the caller
 * promised not to" is not a control. A connector that pastes an API response
 * containing a token into `observed` must not put that token in the database.
 *
 * recordObservations() runs inside a transaction on a pooled client, so this
 * mocks Pool.prototype.connect (not just .query) — patching only .query would
 * capture the CREATE TABLE from init and silently miss every INSERT, and the
 * test would pass while asserting nothing.
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
// Mock the pool before the module under test is imported.
// ---------------------------------------------------------------------------

interface CapturedQuery {
  sql: string;
  params: unknown[];
}
const captured: CapturedQuery[] = [];

const emptyResult = (): Promise<QueryResult<QueryResultRow>> =>
  Promise.resolve({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] });

type QuerySource = string | { text: string; values?: unknown[] };

function record(sql: QuerySource, params?: unknown[]) {
  captured.push({
    sql: typeof sql === "string" ? sql : sql.text,
    params: Array.isArray(params) ? params : [],
  });
  return emptyResult();
}

(Pool.prototype as any).query = (sql: QuerySource, params?: unknown[]) =>
  record(sql, params);

// The transactional write path takes a client out of the pool.
(Pool.prototype as any).connect = () =>
  Promise.resolve({
    query: (sql: QuerySource, params?: unknown[]) => record(sql, params),
    release: () => {},
  });

const { recordObservations } = await import("./connectorEvidenceDatabase");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REDACTED_SENTINEL = "***REDACTED***";

const SECRETS = {
  password_hash: "$2b$12$abcdefghij1234567890uvwxyz.ABCDEFGH_IJ",
  mfa_secret: "JBSWY3DPEHPK3PXP",
  access_token: "ya29.a0AfH6SMBxxxxAccessTokenVALUE",
  refresh_token: "1//0gREFRESHTOKENvalueXYZ",
  api_key: "sk-PLAINTEXTAPIKEY1234567890",
} as const;

const REQUIRED_DENY_KEYS = [
  "password_hash",
  "mfa_secret",
  "access_token",
  "refresh_token",
  "api_key",
] as const;

/** Params of the most recent INSERT captured. */
function lastInsertParams(): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const sql = captured[i].sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (sql.startsWith("INSERT INTO")) return captured[i].params;
  }
  return null;
}

/** Every INSERT captured since the last reset. */
function allInsertParams(): unknown[][] {
  return captured
    .filter((c) => c.sql.replace(/\s+/g, " ").trim().toUpperCase().startsWith("INSERT INTO"))
    .map((c) => c.params);
}

const obs = (observed: Record<string, any>, summary = "a check ran") => ({
  source: "github",
  check_key: "branch_protection",
  subject: "owner/repo:main",
  status: "pass" as const,
  summary,
  observed,
});

// ---------------------------------------------------------------------------
// Section 1 — deny-list keys inside `observed`
// ---------------------------------------------------------------------------

console.log("\n=== recordObservations — observed payload secret-leak tests ===\n");

for (const key of REQUIRED_DENY_KEYS) {
  captured.length = 0;
  const rawSecret = SECRETS[key];

  await recordObservations([obs({ repo: "owner/repo", [key]: rawSecret })]);

  const params = lastInsertParams();
  assert(params !== null, `${key}: an INSERT was issued`);
  if (!params) continue;

  // params layout: [source, check_key, subject, status, summary, observed]
  const observedParam = String(params[5] ?? "");
  assert(
    !observedParam.includes(rawSecret),
    `${key}: raw secret is NOT present in INSERT params`,
  );
  assert(
    observedParam.includes(REDACTED_SENTINEL),
    `${key}: REDACTED sentinel IS present in INSERT params`,
  );
}

// ---------------------------------------------------------------------------
// Section 2 — credential-shaped strings under innocuous keys
//
// The key-based deny list cannot see these: the field is called `note`, and
// only the regex/entropy pass over string leaves catches them. This is the
// realistic shape of the leak for this module — a connector interpolating an
// API response into a human-readable field.
// ---------------------------------------------------------------------------

console.log("\n=== credential-shaped values under innocuous keys ===\n");

const SECRET_LIKE: Array<{ label: string; value: string }> = [
  { label: "GitHub PAT", value: "ghp_ABCdefGHIjklMNOpqrsTUVwxyz0123456789" },
  { label: "OpenAI sk- key", value: "sk-proj-ABCdefGHIjklMNOpqrsTUVwxyz0123456789ABCDEF" },
  {
    label: "JWT",
    value:
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSIsIm5hbWUiOiJBbGljZSJ9.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  },
];

for (const { label, value } of SECRET_LIKE) {
  captured.length = 0;
  await recordObservations([
    obs(
      { note: `token was ${value}`, nested: { deeper: [`also ${value}`] } },
      `Summary mentioning ${value}`,
    ),
  ]);

  const params = lastInsertParams();
  assert(params !== null, `${label}: an INSERT was issued`);
  if (!params) continue;

  const summaryParam = String(params[4] ?? "");
  const observedParam = String(params[5] ?? "");
  assert(
    !observedParam.includes(value),
    `${label}: value under an innocuous key is NOT present in observed`,
  );
  assert(
    !observedParam.includes(value) && !summaryParam.includes(value),
    `${label}: value is NOT present in the summary either`,
  );
  assert(
    observedParam.includes(REDACTED_SENTINEL),
    `${label}: REDACTED sentinel IS present in observed`,
  );
}

// ---------------------------------------------------------------------------
// Section 3 — anti-tautology: ordinary evidence must survive intact
//
// A redactor that blanked everything would pass every assertion above while
// destroying the evidence this table exists to hold.
// ---------------------------------------------------------------------------

console.log("\n=== ordinary evidence is preserved verbatim ===\n");

{
  captured.length = 0;
  await recordObservations([
    obs(
      {
        default_branch: "main",
        protected: true,
        required_approving_review_count: 2,
        open_total: 0,
        truncated: false,
      },
      "main is protected: no force pushes, no deletions.",
    ),
  ]);

  const params = lastInsertParams();
  assert(params !== null, "ordinary: an INSERT was issued");
  if (params) {
    const summaryParam = String(params[4] ?? "");
    const observedParam = String(params[5] ?? "");

    assert(
      summaryParam === "main is protected: no force pushes, no deletions.",
      "ordinary: summary preserved verbatim (test isn't a tautology)",
    );
    assert(
      !observedParam.includes(REDACTED_SENTINEL),
      "ordinary: no REDACTED sentinel in clean evidence (redaction is targeted)",
    );

    let parsed: any = null;
    let parseError: unknown = null;
    try {
      parsed = JSON.parse(observedParam);
    } catch (err) {
      parseError = err;
    }
    assert(parseError === null, "ordinary: observed round-trips via JSON.parse");
    assert(
      parsed?.default_branch === "main" &&
        parsed?.protected === true &&
        parsed?.required_approving_review_count === 2,
      "ordinary: observed fields survive with their types intact",
    );
    assert(
      parsed?.truncated === false,
      "ordinary: `truncated: false` survives (it is load-bearing for honest counts)",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 4 — the run is one transaction
//
// Storage-level partial writes are the failure this guards: a run that wrote
// some rows and then threw leaves a timeline that looks complete and is not.
// ---------------------------------------------------------------------------

console.log("\n=== one run is one transaction ===\n");

{
  captured.length = 0;
  await recordObservations([
    obs({ a: 1 }, "first"),
    obs({ b: 2 }, "second"),
    obs({ c: 3 }, "third"),
  ]);

  const sqls = captured.map((c) => c.sql.replace(/\s+/g, " ").trim().toUpperCase());
  assert(sqls.includes("BEGIN"), "transaction: BEGIN was issued");
  assert(sqls.includes("COMMIT"), "transaction: COMMIT was issued");
  assert(allInsertParams().length === 3, "transaction: all three rows INSERTed");
  assert(
    sqls.indexOf("BEGIN") < sqls.findIndex((s) => s.startsWith("INSERT INTO")),
    "transaction: BEGIN precedes the first INSERT",
  );
  assert(
    sqls.lastIndexOf("COMMIT") >
      sqls.reduce((last, s, i) => (s.startsWith("INSERT INTO") ? i : last), -1),
    "transaction: COMMIT follows the last INSERT",
  );
}

// An empty run must not open a transaction at all.
{
  captured.length = 0;
  const written = await recordObservations([]);
  assert(written === 0, "empty run: returns 0");
  assert(captured.length === 0, "empty run: issues no queries at all");
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log();
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error(
    "\n❌ connectorEvidenceDatabase tests FAILED — secrets may leak into connector_evidence.",
  );
  process.exit(1);
}

console.log("\n✅ All connectorEvidenceDatabase tests passed");
process.exit(0);
