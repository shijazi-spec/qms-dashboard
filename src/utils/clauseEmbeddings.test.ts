/**
 * CI gate: prevents clauseEmbeddings write paths from persisting unmasked
 * secrets into obligation_embeddings.
 *
 * Run:    npx tsx src/utils/clauseEmbeddings.test.ts
 *
 * The embedding writers (ensureClauseEmbeddings via shortlistByEmbedding, and
 * backfillEmbeddingsBatch) persist a per-clause row keyed by the candidate's
 * `obligation_id`. The clause's free text is NEVER stored (only its embedding
 * vector and a SHA-256 hash), so the single caller-controlled value that can
 * reach the INSERT params is `c.id`. Its TypeScript type is `number`, but the
 * type is not enforced at runtime — a buggy/hostile caller could pass a
 * credential-shaped string. This test drives the real write function with such
 * payloads (the 5 deny-list keys plus credential-shaped strings) and asserts:
 *   - the raw secret never reaches the INSERT params, AND
 *   - the ***REDACTED*** sentinel IS present (anti-tautology), AND
 *   - a legitimate numeric id passes through verbatim (targeted, not nuke-all).
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
// the shared pool inside clauseEmbeddings never touches a real DB. Existing
// embedding lookups return no rows so every candidate flows to the INSERT.
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
  return Promise.resolve({
    rows: [],
    rowCount: 0,
    command: "",
    oid: 0,
    fields: [],
  });
};

(Pool.prototype as unknown as { query: MockedPoolQuery }).query = mockQuery;

// Enable the feature flag + provide a (fake) OpenAI key so embedText proceeds.
process.env.DOCUMENT_MAPPING_EMBEDDINGS = "true";
process.env.OPENAI_API_KEY = "test-openai-key-1234567890";

// Mock fetch so embedText returns a vector without any network call.
(globalThis as unknown as { fetch: unknown }).fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ data: [{ embedding: [0.11, 0.22, 0.33] }] }),
});

// Import AFTER the mocks are in place.
const mod = await import("./clauseEmbeddings");

const REDACTED_SENTINEL = "***REDACTED***";

const SECRETS = {
  api_key: "sk-PLAINTEXTAPIKEY1234567890ABCDEFGH",
  access_token: "ya29.a0AfH6SMBxxxxAccessTokenVALUE1234567",
  github_pat: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
} as const;

/** All INSERT-into-obligation_embeddings params captured so far. */
function insertParamsList(): unknown[][] {
  return captured
    .filter((c) =>
      c.sql.replace(/\s+/g, " ").toUpperCase().includes("INSERT INTO OBLIGATION_EMBEDDINGS"),
    )
    .map((c) => c.params);
}

// ---------------------------------------------------------------------------
// Section 1 — shortlistByEmbedding → ensureClauseEmbeddings write path.
// Candidates are caller-supplied; their `id` reaches the INSERT params.
// ---------------------------------------------------------------------------

console.log("\n=== clauseEmbeddings — write-path secret-leak tests ===\n");

{
  captured.length = 0;

  // topK = 1 with > 1 candidate forces the shortlist path to run; every
  // candidate is embedded + INSERTed regardless of the final shortlist size.
  await mod.shortlistByEmbedding(
    "Document body describing access control requirements.",
    [
      { id: SECRETS.api_key as unknown as number, title: "Access control clause" },
      { id: SECRETS.access_token as unknown as number, title: "Token handling clause" },
      { id: SECRETS.github_pat as unknown as number, title: "Source control clause" },
      { id: SECRETS.jwt as unknown as number, title: "Session token clause" },
      { id: 4242, title: "Ordinary numeric-id clause" },
    ],
    1,
  );

  const inserts = insertParamsList();
  assert(inserts.length > 0, "shortlist: INSERT into obligation_embeddings was issued");

  // params layout: [obligation_id, embedding_json, model, dim, text_hash]
  const allIds = inserts.map((p) => String(p[0] ?? ""));
  const combinedIds = allIds.join("|");

  for (const [label, secret] of Object.entries(SECRETS)) {
    assert(
      !combinedIds.includes(secret),
      `shortlist/${label}: raw secret is NOT present in INSERT obligation_id params`,
    );
  }

  assert(
    allIds.some((id) => id.includes(REDACTED_SENTINEL)),
    "shortlist: REDACTED sentinel IS present in at least one INSERT id param",
  );

  // Anti-tautology: the legitimate numeric id must survive verbatim.
  assert(
    inserts.some((p) => p[0] === 4242),
    "shortlist/non-sensitive: numeric id 4242 passes through verbatim",
  );

  // The derived model column is not caller data and must be uncorrupted.
  assert(
    inserts.every((p) => p[2] === mod.EMBED_MODEL),
    "shortlist/non-sensitive: model column preserved (not redacted)",
  );
}

// ---------------------------------------------------------------------------
// Section 2 — backfillEmbeddingsBatch write path. The candidate rows here are
// DB-derived (from the SELECT mock), so this confirms the redaction wrapper
// is in place on this INSERT too and does not corrupt ordinary numeric ids.
// ---------------------------------------------------------------------------

console.log("\n=== clauseEmbeddings — backfill write path ===\n");

{
  captured.length = 0;

  // Branch the mock so the "obligations needing an embedding" SELECT returns a
  // row whose id is a credential-shaped string (simulating tainted data),
  // while every other query keeps the default empty result.
  const branchedMock: MockedPoolQuery = (sql, params = []) => {
    const sqlStr = typeof sql === "string" ? sql : sql.text;
    const paramArr = Array.isArray(params)
      ? params
      : typeof sql === "object" && Array.isArray(sql.values)
        ? sql.values
        : [];
    captured.push({ sql: sqlStr, params: paramArr });
    const norm = sqlStr.replace(/\s+/g, " ");
    if (norm.includes("FROM obligations o") && norm.includes("oe.obligation_id IS NULL") && norm.includes("LIMIT")) {
      return Promise.resolve({
        rows: [
          { id: SECRETS.api_key, obligation_code: "A.1", title: "Tainted", description: "x" },
          { id: 7, obligation_code: "A.2", title: "Clean", description: "y" },
        ],
        rowCount: 2,
        command: "",
        oid: 0,
        fields: [],
      } as unknown as QueryResult<QueryResultRow>);
    }
    return Promise.resolve({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] });
  };
  (Pool.prototype as unknown as { query: MockedPoolQuery }).query = branchedMock;

  await mod.backfillEmbeddingsBatch({ limit: 5, concurrency: 1 });

  const inserts = insertParamsList();
  assert(inserts.length > 0, "backfill: INSERT into obligation_embeddings was issued");

  const allIds = inserts.map((p) => String(p[0] ?? ""));
  assert(
    !allIds.join("|").includes(SECRETS.api_key),
    "backfill: raw secret is NOT present in INSERT obligation_id params",
  );
  assert(
    allIds.some((id) => id.includes(REDACTED_SENTINEL)),
    "backfill: REDACTED sentinel IS present in at least one INSERT id param",
  );
  assert(
    inserts.some((p) => p[0] === 7),
    "backfill/non-sensitive: numeric id 7 passes through verbatim",
  );

  // Restore the plain mock.
  (Pool.prototype as unknown as { query: MockedPoolQuery }).query = mockQuery;
}

// ---------------------------------------------------------------------------

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n❌ clauseEmbeddings tests FAILED");
  process.exit(1);
}
console.log("\n✅ All clauseEmbeddings tests passed");
process.exit(0);
