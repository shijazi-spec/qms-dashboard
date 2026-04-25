/**
 * CI gate: prevents changeHistoryDatabase write paths from persisting
 * unmasked secrets into nc_change_history / capa_change_history.
 *
 * Run:    npx tsx src/utils/changeHistoryDatabase.test.ts
 * Wired:  scripts/post-merge.sh
 *
 * Both logNCChange() and logCAPAChange() call redactSensitiveFields() before
 * writing, but that guarantee has no integration-test coverage.  This test
 * mocks pool.query, drives the real write functions with payloads that contain
 * the required deny-list keys (password_hash, mfa_secret, access_token,
 * refresh_token, api_key), and asserts the raw secrets never reach the INSERT
 * params vector.
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
// that the local pool inside changeHistoryDatabase never touches a real DB.
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
  const paramArr = Array.isArray(params) ? params : [];
  captured.push({ sql: sqlStr, params: paramArr });
  return Promise.resolve({
    rows: [],
    rowCount: 0,
    command: "",
    oid: 0,
    fields: [],
  });
};

(Pool.prototype as unknown as { query: MockedPoolQuery }).query = mockQuery;

// Import AFTER the mock is in place.
const { logNCChange, logCAPAChange } = await import("./changeHistoryDatabase");

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

/** Return the params from the most-recent INSERT captured. */
function lastInsertParams(): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const c = captured[i];
    if (c.sql.replace(/\s+/g, " ").trim().toUpperCase().startsWith("INSERT INTO")) {
      return c.params;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section 1 — logNCChange write-path tests
// ---------------------------------------------------------------------------

console.log("\n=== logNCChange — write-path secret-leak tests ===\n");

for (const key of REQUIRED_DENY_KEYS) {
  captured.length = 0;
  const rawSecret = SECRETS[key];

  await logNCChange(
    /* recordId    */ 1,
    /* fieldChanged */ key,
    /* oldValue    */ rawSecret,
    /* newValue    */ `rotated-${rawSecret}`,
    /* changedBy   */ "test-runner",
    /* reason      */ `Testing redaction of ${key}`,
  );

  const params = lastInsertParams();
  assert(params !== null, `${key}: pool.query was called with INSERT`);
  if (!params) continue;

  // params layout: [recordId, fieldChanged, old_value, new_value, changedBy, reason]
  const oldParam = String(params[2] ?? "");
  const newParam = String(params[3] ?? "");
  const combined = `${oldParam}${newParam}`;

  assert(
    !combined.includes(rawSecret),
    `NC/${key}: raw secret is NOT present in INSERT params`,
  );
  assert(
    combined.includes(REDACTED_SENTINEL),
    `NC/${key}: REDACTED sentinel IS present in INSERT params`,
  );
}

// Non-sensitive field must pass through unchanged (anti-tautology check).
{
  captured.length = 0;
  await logNCChange(1, "status", "open", "closed", "test-runner");
  const params = lastInsertParams();
  assert(params !== null, "NC/non-sensitive: pool.query was called");
  if (params) {
    const oldParam = String(params[2] ?? "");
    const newParam = String(params[3] ?? "");
    assert(
      oldParam === "open",
      "NC/non-sensitive: old_value preserved verbatim (test isn't a tautology)",
    );
    assert(
      newParam === "closed",
      "NC/non-sensitive: new_value preserved verbatim",
    );
    assert(
      !oldParam.includes(REDACTED_SENTINEL) && !newParam.includes(REDACTED_SENTINEL),
      "NC/non-sensitive: REDACTED sentinel NOT present",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 2 — logCAPAChange write-path tests
// ---------------------------------------------------------------------------

console.log("\n=== logCAPAChange — write-path secret-leak tests ===\n");

for (const key of REQUIRED_DENY_KEYS) {
  captured.length = 0;
  const rawSecret = SECRETS[key];

  await logCAPAChange(
    /* recordId    */ 7,
    /* fieldChanged */ key,
    /* oldValue    */ rawSecret,
    /* newValue    */ `rotated-${rawSecret}`,
    /* changedBy   */ "test-runner",
    /* reason      */ `Testing redaction of ${key}`,
  );

  const params = lastInsertParams();
  assert(params !== null, `CAPA/${key}: pool.query was called with INSERT`);
  if (!params) continue;

  const oldParam = String(params[2] ?? "");
  const newParam = String(params[3] ?? "");
  const combined = `${oldParam}${newParam}`;

  assert(
    !combined.includes(rawSecret),
    `CAPA/${key}: raw secret is NOT present in INSERT params`,
  );
  assert(
    combined.includes(REDACTED_SENTINEL),
    `CAPA/${key}: REDACTED sentinel IS present in INSERT params`,
  );
}

// Non-sensitive field must pass through unchanged (anti-tautology check).
{
  captured.length = 0;
  await logCAPAChange(7, "priority", "medium", "high", "test-runner");
  const params = lastInsertParams();
  assert(params !== null, "CAPA/non-sensitive: pool.query was called");
  if (params) {
    const oldParam = String(params[2] ?? "");
    const newParam = String(params[3] ?? "");
    assert(
      oldParam === "medium",
      "CAPA/non-sensitive: old_value preserved verbatim (test isn't a tautology)",
    );
    assert(
      newParam === "high",
      "CAPA/non-sensitive: new_value preserved verbatim",
    );
    assert(
      !oldParam.includes(REDACTED_SENTINEL) && !newParam.includes(REDACTED_SENTINEL),
      "CAPA/non-sensitive: REDACTED sentinel NOT present",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 3 — object-valued payloads: secrets nested inside the value itself
//
// A caller may pass an object (e.g. a JSON snapshot) as oldValue/newValue.
// redactSensitiveFields() recurses into objects, so sensitive sub-keys inside
// the value should also be scrubbed before String() serialisation occurs.
// ---------------------------------------------------------------------------

console.log("\n=== object-valued payloads — nested secret scrubbing ===\n");

{
  captured.length = 0;
  await logNCChange(
    1,
    "profile_snapshot",
    { username: "alice", password_hash: SECRETS.password_hash, role: "admin" },
    { username: "alice", password_hash: SECRETS.password_hash, role: "viewer" },
    "test-runner",
  );
  const params = lastInsertParams();
  assert(params !== null, "NC/object: pool.query was called");
  if (params) {
    const combined = `${String(params[2] ?? "")}${String(params[3] ?? "")}`;
    assert(
      !combined.includes(SECRETS.password_hash),
      "NC/object: password_hash nested in object value is NOT present in INSERT params",
    );
  }
}

{
  captured.length = 0;
  await logCAPAChange(
    7,
    "integration_config",
    { provider: "zoho", api_key: SECRETS.api_key, account_id: "acct-public-123" },
    { provider: "zoho", api_key: SECRETS.api_key, account_id: "acct-public-456" },
    "test-runner",
  );
  const params = lastInsertParams();
  assert(params !== null, "CAPA/object: pool.query was called");
  if (params) {
    const combined = `${String(params[2] ?? "")}${String(params[3] ?? "")}`;
    assert(
      !combined.includes(SECRETS.api_key),
      "CAPA/object: api_key nested in object value is NOT present in INSERT params",
    );
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log();
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error(
    "\n❌ changeHistoryDatabase tests FAILED — secrets may leak into nc/capa_change_history.",
  );
  process.exit(1);
}

console.log("\n✅ All changeHistoryDatabase tests passed");
process.exit(0);
