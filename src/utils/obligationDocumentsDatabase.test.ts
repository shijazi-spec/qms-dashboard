/**
 * CI gate: prevents obligationDocumentsDatabase write paths from persisting
 * unmasked secrets into obligation_documents.
 *
 * Run:    npx tsx src/utils/obligationDocumentsDatabase.test.ts
 * Wired:  scripts/post-merge.sh → tests/runIntegrationTests.ts (auto-discovered).
 *
 * The module owns its own pg.Pool via createRedactedPool(), which intercepts
 * INSERT/UPDATE params and applies redactSensitiveDeep() to every positional
 * value. This test patches Pool.prototype.query BEFORE importing the module,
 * drives linkDocumentToObligation() with payloads that contain:
 *   - the five required deny-list keys (password_hash, mfa_secret,
 *     access_token, refresh_token, api_key) embedded as substrings inside
 *     the free-text `linked_by` field,
 *   - credential-shaped strings (bcrypt hash, JWT, OpenAI sk-, GitHub PAT)
 *     embedded under the same innocuous string field,
 * and asserts those raw values never reach the captured INSERT params vector
 * while the ***REDACTED*** sentinel does.
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
  const paramArr =
    typeof sql !== "string" && Array.isArray(sql.values)
      ? sql.values
      : Array.isArray(params)
        ? params
        : [];
  captured.push({ sql: sqlStr, params: paramArr });
  return Promise.resolve({
    rows: [{ id: 1 }],
    rowCount: 1,
    command: "",
    oid: 0,
    fields: [],
  });
};

(Pool.prototype as unknown as { query: MockedPoolQuery }).query = mockQuery;

// Import AFTER the mock is in place so the wrapped pool's bound originalQuery
// resolves to the patched prototype method.
const { linkDocumentToObligation } = await import("./obligationDocumentsDatabase");

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
// Section 1 — deny-list-key secrets embedded in the linked_by free-text field
// ---------------------------------------------------------------------------

console.log("\n=== linkDocumentToObligation — deny-list secret values ===\n");

for (const key of REQUIRED_DENY_KEYS) {
  captured.length = 0;
  const rawSecret = SECRETS[key];

  await linkDocumentToObligation({
    obligation_id: 42,
    document_id: 7,
    linked_by: `agent ${key}=${rawSecret}`,
  });

  const params = lastInsertParams();
  assert(params !== null, `${key}: pool.query was called with INSERT`);
  if (!params) continue;

  // Param layout matches the linkDocumentToObligation INSERT:
  // [obligation_id, document_id, linked_by]
  const linkedByParam = String(params[2] ?? "");

  assert(
    !linkedByParam.includes(rawSecret),
    `${key}: raw secret is NOT present in linked_by INSERT param`,
  );
  assert(
    linkedByParam.includes(REDACTED_SENTINEL),
    `${key}: REDACTED sentinel IS present in linked_by INSERT param`,
  );
  // Anti-tautology: numeric ids must pass through unchanged.
  assert(
    params[0] === 42 && params[1] === 7,
    `${key}: numeric obligation_id / document_id pass through verbatim`,
  );
}

// ---------------------------------------------------------------------------
// Section 2 — credential-shaped strings under the innocuous linked_by field
// ---------------------------------------------------------------------------

console.log("\n=== linkDocumentToObligation — credential-shaped strings ===\n");

const SECRET_LIKE_STRINGS: Array<{ label: string; value: string }> = [
  {
    label: "bcrypt hash",
    value: "$2b$12$abcdefghijklmnopqrstuOCm5RJ7p2sIcQqL7gKwSxmXJ9pYsZyHa",
  },
  {
    label: "JWT",
    value:
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSIsIm5hbWUiOiJBbGljZSJ9.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  },
  {
    label: "OpenAI sk- key",
    value: "sk-proj-ABCdefGHIjklMNOpqrsTUVwxyz0123456789ABCDEF",
  },
  {
    label: "GitHub PAT",
    value: "ghp_ABCdefGHIjklMNOpqrsTUVwxyz0123456789",
  },
];

for (const { label, value } of SECRET_LIKE_STRINGS) {
  captured.length = 0;
  await linkDocumentToObligation({
    obligation_id: 1,
    document_id: 2,
    linked_by: `automation token ${label}: ${value}`,
  });

  const params = lastInsertParams();
  assert(params !== null, `${label}: pool.query was called with INSERT`);
  if (!params) continue;

  const linkedByParam = String(params[2] ?? "");
  assert(
    !linkedByParam.includes(value),
    `${label}: raw credential-shaped value is NOT present in linked_by INSERT param`,
  );
  assert(
    linkedByParam.includes(REDACTED_SENTINEL),
    `${label}: REDACTED sentinel IS present in linked_by INSERT param`,
  );
}

// ---------------------------------------------------------------------------
// Section 3 — anti-tautology: ordinary linked_by passes through verbatim
// ---------------------------------------------------------------------------

console.log("\n=== linkDocumentToObligation — innocuous payload passes through ===\n");

{
  captured.length = 0;
  await linkDocumentToObligation({
    obligation_id: 100,
    document_id: 200,
    linked_by: "alice@example.com",
  });

  const params = lastInsertParams();
  assert(params !== null, "innocuous: pool.query was called");
  if (params) {
    assert(
      params[0] === 100 && params[1] === 200,
      "innocuous: obligation_id / document_id preserved verbatim",
    );
    assert(
      String(params[2] ?? "") === "alice@example.com",
      "innocuous: linked_by preserved verbatim (test isn't a tautology)",
    );
    assert(
      !String(params[2] ?? "").includes(REDACTED_SENTINEL),
      "innocuous: REDACTED sentinel NOT present (regex is targeted)",
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
    "\n❌ obligationDocumentsDatabase tests FAILED — secrets may leak into obligation_documents.",
  );
  process.exit(1);
}

console.log("\n✅ All obligationDocumentsDatabase tests passed");
process.exit(0);
