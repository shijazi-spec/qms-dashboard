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
  password_hash: "<REDACTED_SECRET>",
  mfa_secret: "<REDACTED_SECRET>",
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
// the value should also be scrubbed before serialisation occurs.
//
// Task #451: in addition to scrubbing, the stored value MUST be the JSON
// representation of the (redacted) object — i.e. parseable with JSON.parse —
// rather than the literal string `[object Object]` produced by `String({})`.
// The previous Section-3 assertions ("secret is gone") were also satisfied by
// `[object Object]`, hiding the audit-data-loss bug.
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
    const oldParam = String(params[2] ?? "");
    const newParam = String(params[3] ?? "");
    const combined = `${oldParam}${newParam}`;
    assert(
      !combined.includes(SECRETS.password_hash),
      "NC/object: password_hash nested in object value is NOT present in INSERT params",
    );

    // Task #451: stored value must NOT collapse to `[object Object]`.
    assert(
      oldParam !== "[object Object]" && newParam !== "[object Object]",
      "NC/object: stored value is NOT the literal string `[object Object]`",
    );

    // Task #451: stored value must round-trip as parseable JSON, and the
    // structure (non-secret keys) must survive the scrub.
    let oldParsed: unknown = null;
    let newParsed: unknown = null;
    let parseError: unknown = null;
    try {
      oldParsed = JSON.parse(oldParam);
      newParsed = JSON.parse(newParam);
    } catch (err) {
      parseError = err;
    }
    assert(
      parseError === null,
      "NC/object: old_value and new_value round-trip via JSON.parse without throwing",
    );
    assert(
      typeof oldParsed === "object" && oldParsed !== null &&
        (oldParsed as Record<string, unknown>).username === "alice" &&
        (oldParsed as Record<string, unknown>).role === "admin",
      "NC/object: parsed old_value preserves non-secret fields (username, role)",
    );
    assert(
      typeof newParsed === "object" && newParsed !== null &&
        (newParsed as Record<string, unknown>).role === "viewer",
      "NC/object: parsed new_value preserves the actual change (role: viewer)",
    );

    // Task #451 anti-tautology: secret key must still exist as a property,
    // but its value must be the redaction sentinel — not the raw secret.
    const oldObj = oldParsed as Record<string, unknown>;
    assert(
      "password_hash" in oldObj && oldObj.password_hash !== SECRETS.password_hash,
      "NC/object: parsed password_hash field is scrubbed (not raw secret)",
    );
  }
}

{
  captured.length = 0;
  await logCAPAChange(
    7,
    "integration_config",
    { provider: "CRMProvider", api_key: SECRETS.api_key, account_id: "acct-public-123" },
    { provider: "CRMProvider", api_key: SECRETS.api_key, account_id: "acct-public-456" },
    "test-runner",
  );
  const params = lastInsertParams();
  assert(params !== null, "CAPA/object: pool.query was called");
  if (params) {
    const oldParam = String(params[2] ?? "");
    const newParam = String(params[3] ?? "");
    const combined = `${oldParam}${newParam}`;
    assert(
      !combined.includes(SECRETS.api_key),
      "CAPA/object: api_key nested in object value is NOT present in INSERT params",
    );

    // Task #451: stored value must NOT collapse to `[object Object]`.
    assert(
      oldParam !== "[object Object]" && newParam !== "[object Object]",
      "CAPA/object: stored value is NOT the literal string `[object Object]`",
    );

    // Task #451: stored value must round-trip as parseable JSON, and the
    // distinguishing fields must survive the scrub so the audit row is useful.
    let oldParsed: unknown = null;
    let newParsed: unknown = null;
    let parseError: unknown = null;
    try {
      oldParsed = JSON.parse(oldParam);
      newParsed = JSON.parse(newParam);
    } catch (err) {
      parseError = err;
    }
    assert(
      parseError === null,
      "CAPA/object: old_value and new_value round-trip via JSON.parse without throwing",
    );
    assert(
      typeof oldParsed === "object" && oldParsed !== null &&
        (oldParsed as Record<string, unknown>).provider === "CRMProvider" &&
        (oldParsed as Record<string, unknown>).account_id === "acct-public-123",
      "CAPA/object: parsed old_value preserves non-secret fields (provider, account_id)",
    );
    assert(
      typeof newParsed === "object" && newParsed !== null &&
        (newParsed as Record<string, unknown>).account_id === "acct-public-456",
      "CAPA/object: parsed new_value preserves the actual change (account_id flip)",
    );

    const newObj = newParsed as Record<string, unknown>;
    assert(
      "api_key" in newObj && newObj.api_key !== SECRETS.api_key,
      "CAPA/object: parsed api_key field is scrubbed (not raw secret)",
    );
  }
}

// Task #451: array-valued payloads must also serialise to parseable JSON
// (not `[object Object]`-style coercion), since arrays are objects too and a
// caller may pass e.g. a list of attachments or affected records as the value.
{
  captured.length = 0;
  await logNCChange(
    1,
    "affected_records",
    [{ id: 1, name: "alpha" }, { id: 2, name: "beta" }],
    [{ id: 1, name: "alpha" }, { id: 2, name: "beta-renamed" }, { id: 3, name: "gamma" }],
    "test-runner",
  );
  const params = lastInsertParams();
  assert(params !== null, "NC/array: pool.query was called");
  if (params) {
    const oldParam = String(params[2] ?? "");
    const newParam = String(params[3] ?? "");
    assert(
      oldParam !== "[object Object]" && newParam !== "[object Object]",
      "NC/array: array value is NOT collapsed to `[object Object]`",
    );
    let oldParsed: unknown = null;
    let newParsed: unknown = null;
    let parseError: unknown = null;
    try {
      oldParsed = JSON.parse(oldParam);
      newParsed = JSON.parse(newParam);
    } catch (err) {
      parseError = err;
    }
    assert(
      parseError === null,
      "NC/array: old_value and new_value round-trip via JSON.parse without throwing",
    );
    assert(
      Array.isArray(oldParsed) && oldParsed.length === 2,
      "NC/array: parsed old_value is an Array of length 2",
    );
    assert(
      Array.isArray(newParsed) && newParsed.length === 3 &&
        (newParsed[1] as Record<string, unknown>).name === "beta-renamed",
      "NC/array: parsed new_value preserves the actual diff (length 3, beta-renamed)",
    );
  }
}

// Task #451 anti-regression: primitives (string, number, boolean) and
// null/undefined must continue to behave as today — strings pass through
// verbatim, numbers/booleans via String(), nullish → SQL NULL — i.e. the
// JSON-stringification path must be gated to `typeof value === 'object'`.
{
  captured.length = 0;
  await logNCChange(1, "count", 5, 7, "test-runner");
  const params = lastInsertParams();
  assert(params !== null, "NC/number: pool.query was called");
  if (params) {
    assert(
      String(params[2] ?? "") === "5" && String(params[3] ?? "") === "7",
      "NC/number: numeric values are stored as `5` / `7` (not JSON-quoted)",
    );
  }
}

{
  captured.length = 0;
  await logNCChange(1, "is_active", true, false, "test-runner");
  const params = lastInsertParams();
  assert(params !== null, "NC/boolean: pool.query was called");
  if (params) {
    assert(
      String(params[2] ?? "") === "true" && String(params[3] ?? "") === "false",
      "NC/boolean: boolean values are stored as `true` / `false`",
    );
  }
}

{
  captured.length = 0;
  await logNCChange(1, "assignee", null, "alice", "test-runner");
  const params = lastInsertParams();
  assert(params !== null, "NC/null: pool.query was called");
  if (params) {
    assert(
      params[2] === null,
      "NC/null: null oldValue is stored as SQL NULL (not the string `null`)",
    );
    assert(
      params[3] === "alice",
      "NC/null: string newValue still passes through verbatim",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 4a — credential-shaped strings under NON-sensitive field names
//
// A caller may pass a raw credential as the value of an innocuously-named
// field (e.g. `fieldChanged = "notes"`, value = a JWT or bcrypt hash).  The
// key-based deny list in redactSensitiveFields() cannot see these because it
// only inspects field names.  A second, regex-based pass over every string
// leaf (now consolidated into redactSensitiveDeep — Task #257) must scrub
// them before INSERT.
// ---------------------------------------------------------------------------

console.log("\n=== credential-shaped values under innocuous field names ===\n");

const SECRET_LIKE_STRINGS: Array<{ label: string; value: string }> = [
  {
    label: "bcrypt hash",
    value: "<REDACTED_PASSWORD_HASH>",
  },
  {
    label: "JWT",
    value:
      "<REDACTED_TOKEN>",
  },
  {
    label: "LLMProvider sk- key",
    value: "<REDACTED_TOKEN>",
  },
  {
    label: "SourceControlProvider PAT",
    value: "<REDACTED_TOKEN>",
  },
  {
    label: "PaymentProvider live key",
    value: "<REDACTED_TOKEN>",
  },
  {
    label: "IdentityProvider API key",
    value: "<REDACTED_TOKEN>",
  },
  {
    label: "Bearer <REDACTED_TOKEN>",
    value: "Bearer <REDACTED_TOKEN>",
  },
];

const INNOCUOUS_FIELDS = ["notes", "description", "comment", "title"] as const;

for (const { label, value } of SECRET_LIKE_STRINGS) {
  for (const field of INNOCUOUS_FIELDS.slice(0, 1)) {
    captured.length = 0;
    await logNCChange(
      42,
      field,
      `was: ${value}`,
      `now: rotated-${value}`,
      "test-runner",
      `Found a token in ${field}: ${value}`,
    );
    const params = lastInsertParams();
    assert(params !== null, `NC/${field}/${label}: pool.query was called`);
    if (params) {
      const oldParam = String(params[2] ?? "");
      const newParam = String(params[3] ?? "");
      const reasonParam = String(params[5] ?? "");
      const combined = `${oldParam}|${newParam}|${reasonParam}`;
      assert(
        !combined.includes(value),
        `NC/${field}/${label}: raw secret-shaped value is NOT present in INSERT params`,
      );
      assert(
        oldParam.includes(REDACTED_SENTINEL) && newParam.includes(REDACTED_SENTINEL),
        `NC/${field}/${label}: REDACTED sentinel IS present in old_value AND new_value`,
      );
    }
  }

  for (const field of INNOCUOUS_FIELDS.slice(1, 2)) {
    captured.length = 0;
    await logCAPAChange(
      99,
      field,
      `previous ${field}: ${value}`,
      `updated ${field}: rotated-${value}`,
      "test-runner",
    );
    const params = lastInsertParams();
    assert(params !== null, `CAPA/${field}/${label}: pool.query was called`);
    if (params) {
      const oldParam = String(params[2] ?? "");
      const newParam = String(params[3] ?? "");
      const combined = `${oldParam}|${newParam}`;
      assert(
        !combined.includes(value),
        `CAPA/${field}/${label}: raw secret-shaped value is NOT present in INSERT params`,
      );
      assert(
        oldParam.includes(REDACTED_SENTINEL) && newParam.includes(REDACTED_SENTINEL),
        `CAPA/${field}/${label}: REDACTED sentinel IS present in old_value AND new_value`,
      );
    }
  }
}

// Also: secret-shaped string nested deep inside an object value under a
// non-sensitive field name should be scrubbed by the regex pass.
{
  captured.length = 0;
  const jwt =
    "<REDACTED_TOKEN>";
  await logNCChange(
    1,
    "audit_metadata",
    { actor: "alice", trace: { upstream_header: `Authorization: ${jwt}` } },
    { actor: "alice", trace: { upstream_header: `Authorization: rotated-${jwt}` } },
    "test-runner",
  );
  const params = lastInsertParams();
  assert(params !== null, "NC/nested-object/jwt: pool.query was called");
  if (params) {
    const combined = `${String(params[2] ?? "")}${String(params[3] ?? "")}`;
    assert(
      !combined.includes(jwt),
      "NC/nested-object/jwt: JWT nested deep inside non-sensitive object IS scrubbed",
    );
  }
}

// Negative case: an innocuous string under a non-sensitive field must NOT be
// scrubbed (anti-tautology — proves the regex is targeted, not nuke-everything).
{
  captured.length = 0;
  await logNCChange(
    1,
    "notes",
    "Customer reported issue ABC-123 on 2025-01-15",
    "Customer reported issue ABC-456 on 2025-02-20",
    "test-runner",
  );
  const params = lastInsertParams();
  assert(params !== null, "NC/notes/innocuous: pool.query was called");
  if (params) {
    const oldParam = String(params[2] ?? "");
    const newParam = String(params[3] ?? "");
    assert(
      oldParam === "Customer reported issue ABC-123 on 2025-01-15",
      "NC/notes/innocuous: ordinary prose is preserved verbatim",
    );
    assert(
      !oldParam.includes(REDACTED_SENTINEL) && !newParam.includes(REDACTED_SENTINEL),
      "NC/notes/innocuous: REDACTED sentinel NOT present (regex is targeted)",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 4b — credential-shaped substrings inside INNOCUOUS nested fields
//
// Task #257: the previous redaction chain only ran the regex deny list at the
// top level, so a `ghp_…` / `sk-…` / JWT / bcrypt embedded inside a nested
// non-sensitive field (e.g. `notes`, `description`, `evidence`) slipped past
// `redactSensitiveFields()`. Switching to `redactSensitiveDeep()` walks every
// string leaf with the regex pass, so the sentinel must now appear in the
// stored INSERT params even when the surrounding key is innocuous.
// ---------------------------------------------------------------------------

console.log(
  "\n=== credential-shaped substrings inside non-sensitive nested fields ===\n",
);

const GHP_TOKEN = "<REDACTED_SECRET>";
const SK_KEY = "<REDACTED_TOKEN>";
const JWT_TOKEN =
  "<REDACTED_SECRET>";

{
  captured.length = 0;
  await logNCChange(
    1,
    "investigation_notes",
    "Previous run referenced SourceControlProvider token: <REDACTED_TOKEN>",
    {
      author: "alice",
      notes: `Reset the SourceControlProvider PAT to ${GHP_TOKEN} per playbook step 3.`,
      attachments: [
        { name: "post-mortem.md", contents: `Bearer ${JWT_TOKEN} was rotated.` },
      ],
    },
    "test-runner",
    `Reason of record: rotated key was ${SK_KEY}, see audit log.`,
  );
  const params = lastInsertParams();
  assert(params !== null, "NC/credential-substring: pool.query was called");
  if (params) {
    const oldParam = String(params[2] ?? "");
    const newParam = String(params[3] ?? "");
    const reasonParam = String(params[5] ?? "");
    const combined = `${oldParam}${newParam}${reasonParam}`;

    assert(
      !combined.includes(GHP_TOKEN),
      "NC/credential-substring: ghp_… token in nested `notes` is NOT present in INSERT params",
    );
    assert(
      !combined.includes(JWT_TOKEN),
      "NC/credential-substring: JWT in nested attachments[].contents is NOT present in INSERT params",
    );
    assert(
      !combined.includes(SK_KEY),
      "NC/credential-substring: sk-… key inside `change_reason` is NOT present in INSERT params",
    );
    assert(
      !oldParam.includes("<REDACTED_TOKEN>"),
      "NC/credential-substring: top-level string `oldValue` regex-scrubbed too",
    );
    assert(
      newParam.includes(REDACTED_SENTINEL),
      "NC/credential-substring: REDACTED sentinel IS present in serialised new_value JSON",
    );
    assert(
      reasonParam.includes(REDACTED_SENTINEL),
      "NC/credential-substring: REDACTED sentinel IS present in change_reason",
    );
  }
}

{
  captured.length = 0;
  await logCAPAChange(
    7,
    "evidence",
    null,
    {
      submitted_by: "bob",
      evidence: `Old AWS access key <REDACTED_TOKEN> rotated; new key issued via vault.`,
      ChatProvider_thread: {
        url: "<REDACTED_URL>",
        excerpt: `Bearer ${JWT_TOKEN} was used in the broken job.`,
      },
    },
    "test-runner",
  );
  const params = lastInsertParams();
  assert(params !== null, "CAPA/credential-substring: pool.query was called");
  if (params) {
    const newParam = String(params[3] ?? "");

    assert(
      !newParam.includes("<REDACTED_TOKEN>"),
      "CAPA/credential-substring: AWS access key inside nested `evidence` string is NOT present",
    );
    assert(
      !newParam.includes(JWT_TOKEN),
      "CAPA/credential-substring: JWT inside ChatProvider_thread.excerpt is NOT present",
    );
    assert(
      newParam.includes(REDACTED_SENTINEL),
      "CAPA/credential-substring: REDACTED sentinel IS present in serialised new_value JSON",
    );
    assert(
      newParam.includes("submitted_by") && newParam.includes("bob"),
      "CAPA/credential-substring: object is JSON-serialised (not collapsed to [object Object])",
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
