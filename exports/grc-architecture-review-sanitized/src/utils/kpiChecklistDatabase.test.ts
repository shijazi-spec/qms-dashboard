/**
 * CI gate: prevents kpiChecklistDatabase write paths from persisting unmasked
 * secrets into kpi_checklist_items.
 *
 * Run:    npx tsx src/utils/kpiChecklistDatabase.test.ts
 *
 * The caller-data writers are:
 *   - addChecklistItem(kpiId, itemText, updatedBy, section)  -> INSERT
 *   - updateChecklistItem(itemId, patch, updatedBy)          -> UPDATE
 * Both now wrap caller-supplied values with redactSensitiveDeep() before they
 * reach the parameterised query. This test mocks pool.query, drives the real
 * write functions with payloads containing the five required deny-list keys'
 * secret values (and credential-shaped strings), and asserts the raw secrets
 * never reach the INSERT/UPDATE params vector.
 *
 * (seedBuFrameworkChecklist / backfillInitialFrameworkProgress write only
 * hardcoded literal data and take no caller input, so there is nothing to
 * scrub there — they are exercised only via the public writers above.)
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
  captured.push({ sql: sqlStr, params: paramArr });
  // Return a plausible row so RETURNING * based writers resolve cleanly.
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
const { addChecklistItem, updateChecklistItem } = await import(
  "./kpiChecklistDatabase"
);

const REDACTED_SENTINEL = "***REDACTED***";

// kpi_checklist_items has only innocuously-named string columns (item_text,
// note, section, updated_by). The key-based deny list cannot fire on those
// column names, so a secret interpolated into one of those values is only
// scrubbed by the credential-shape regex/heuristic pass. We therefore use
// credential-SHAPED values (one realistic format per deny-list category) so
// the regex pass reliably catches them in prose. The key-based deny list is
// additionally exercised by the JSON-object test in Section 3.
const SECRETS = {
  password_hash: "$2b$12$abcdefghijklmnopqrstuOCm5RJ7p2sIcQqL7gKwSxmXJ9pYsZyHa",
  mfa_secret: "<REDACTED_TOKEN>",
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

function lastQueryParams(matcher: (sql: string) => boolean): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const c = captured[i];
    if (matcher(c.sql.replace(/\s+/g, " ").trim().toUpperCase())) {
      return c.params;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section 1 — addChecklistItem (INSERT) credential-shaped item_text
// ---------------------------------------------------------------------------

console.log("\n=== addChecklistItem — write-path secret-leak tests ===\n");

for (const key of REQUIRED_DENY_KEYS) {
  captured.length = 0;
  const rawSecret = SECRETS[key];

  await addChecklistItem(
    /* kpiId    */ 42,
    /* itemText */ `Rotate the ${key}: ${rawSecret}`,
    /* updatedBy */ `actor with token ${rawSecret}`,
    /* section  */ `BU ${rawSecret}`,
  );

  const params = lastQueryParams((s) => s.startsWith("INSERT INTO"));
  assert(params !== null, `add/${key}: pool.query was called with INSERT`);
  if (!params) continue;

  // params layout: [kpiId, section, item_text, updated_by]
  const combined = `${String(params[1] ?? "")}${String(params[2] ?? "")}${String(params[3] ?? "")}`;

  assert(
    !combined.includes(rawSecret),
    `add/${key}: raw secret is NOT present in INSERT params`,
  );
  assert(
    combined.includes(REDACTED_SENTINEL),
    `add/${key}: REDACTED sentinel IS present in INSERT params`,
  );
}

// Non-sensitive values pass through verbatim (anti-tautology).
{
  captured.length = 0;
  await addChecklistItem(7, "Process Drafting", "alice", "Sales");
  const params = lastQueryParams((s) => s.startsWith("INSERT INTO"));
  assert(params !== null, "add/non-sensitive: pool.query was called");
  if (params) {
    assert(
      params[1] === "Sales",
      "add/non-sensitive: section preserved verbatim (test isn't a tautology)",
    );
    assert(
      params[2] === "Process Drafting",
      "add/non-sensitive: item_text preserved verbatim",
    );
    assert(
      params[3] === "alice",
      "add/non-sensitive: updated_by preserved verbatim",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 2 — updateChecklistItem (UPDATE) credential-shaped patch fields
// ---------------------------------------------------------------------------

console.log("\n=== updateChecklistItem — write-path secret-leak tests ===\n");

for (const key of REQUIRED_DENY_KEYS) {
  captured.length = 0;
  const rawSecret = SECRETS[key];

  await updateChecklistItem(
    /* itemId */ 5,
    {
      item_text: `Done: rotated ${key} -> ${rawSecret}`,
      note: `Stored old ${key}: ${rawSecret}`,
    },
    /* updatedBy */ `bob using ${rawSecret}`,
  );

  const params = lastQueryParams((s) => s.startsWith("UPDATE"));
  assert(params !== null, `update/${key}: pool.query was called with UPDATE`);
  if (!params) continue;

  const combined = params.map((p) => String(p ?? "")).join("|");

  assert(
    !combined.includes(rawSecret),
    `update/${key}: raw secret is NOT present in UPDATE params`,
  );
  assert(
    combined.includes(REDACTED_SENTINEL),
    `update/${key}: REDACTED sentinel IS present in UPDATE params`,
  );
}

// Non-sensitive update passes through verbatim, and booleans are preserved.
{
  captured.length = 0;
  await updateChecklistItem(
    9,
    { item_text: "Trial Audit Report", is_done: true, note: "all good" },
    "carol",
  );
  const params = lastQueryParams((s) => s.startsWith("UPDATE"));
  assert(params !== null, "update/non-sensitive: pool.query was called");
  if (params) {
    // values layout: [item_text, is_done, note, updated_by, itemId]
    assert(
      params[0] === "Trial Audit Report",
      "update/non-sensitive: item_text preserved verbatim",
    );
    assert(
      params[1] === true,
      "update/non-sensitive: boolean is_done passes through unchanged",
    );
    assert(
      params[2] === "all good",
      "update/non-sensitive: note preserved verbatim",
    );
    assert(
      params[3] === "carol",
      "update/non-sensitive: updated_by preserved verbatim",
    );
    const combined = params.map((p) => String(p ?? "")).join("|");
    assert(
      !combined.includes(REDACTED_SENTINEL),
      "update/non-sensitive: REDACTED sentinel NOT present (redactor is targeted)",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 3 — credential-shaped strings under innocuous field names
// ---------------------------------------------------------------------------

console.log("\n=== credential-shaped values under innocuous fields ===\n");

{
  captured.length = 0;
  const jwt =
    "<REDACTED_TOKEN>";
  await addChecklistItem(1, `Found a token in notes: ${jwt}`, "alice", "GRC");
  const params = lastQueryParams((s) => s.startsWith("INSERT INTO"));
  assert(params !== null, "add/jwt-in-notes: pool.query was called");
  if (params) {
    const itemText = String(params[2] ?? "");
    assert(
      !itemText.includes(jwt),
      "add/jwt-in-notes: raw JWT is NOT present in item_text param",
    );
    assert(
      itemText.includes(REDACTED_SENTINEL),
      "add/jwt-in-notes: REDACTED sentinel IS present in item_text param",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 4 — key-based deny list via a JSON-serialised value.
//
// A caller may persist a JSON snapshot string into item_text/note. Even when
// the secret VALUE has no distinctive credential shape (a plain TOTP base32 or
// opaque refresh token), redactSensitiveDeep recurses into the parsed JSON and
// scrubs values whose KEY is on the deny list. This proves the non-shaped
// deny-list secrets (mfa_secret, refresh_token) are still caught.
// ---------------------------------------------------------------------------

console.log("\n=== key-based deny list via JSON-serialised value ===\n");

{
  captured.length = 0;
  const plainMfa = "JBSWY3DPEHPK3PXP";
  const plainRefresh = "1//0gREFRESHTOKENvalueXYZ";
  const snapshot = JSON.stringify({
    actor: "alice",
    mfa_secret: plainMfa,
    refresh_token: plainRefresh,
    note: "rotation complete",
  });
  await addChecklistItem(1, snapshot, "alice", "IT");
  const params = lastQueryParams((s) => s.startsWith("INSERT INTO"));
  assert(params !== null, "add/json-snapshot: pool.query was called");
  if (params) {
    const itemText = String(params[2] ?? "");
    assert(
      !itemText.includes(plainMfa) && !itemText.includes(plainRefresh),
      "add/json-snapshot: non-shaped deny-list secrets are NOT present in item_text param",
    );
    assert(
      itemText.includes(REDACTED_SENTINEL),
      "add/json-snapshot: REDACTED sentinel IS present in item_text param",
    );
    assert(
      itemText.includes("alice") && itemText.includes("rotation complete"),
      "add/json-snapshot: non-secret JSON fields are preserved",
    );
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n❌ kpiChecklistDatabase tests FAILED");
  process.exit(1);
}
console.log("\n✅ All kpiChecklistDatabase tests passed");
process.exit(0);
