/**
 * CI gate: prevents policyMappingBridge write paths from persisting unmasked
 * secrets into qms_uploaded_documents / document_clause_citations.
 *
 * Run:    npx tsx src/utils/policyMappingBridge.test.ts
 * Wired:  picked up automatically by `npm test` (recursive src/**\/*.test.ts
 *         discovery) which runs from scripts/post-merge.sh.
 *
 * `syncPolicyToMapping()` projects an Integrated QMS `policies` row into the
 * mapping source table (`qms_uploaded_documents`). The projected title, file
 * metadata, uploaded_by and extracted text are all operator-supplied content
 * and must be scrubbed of credential-shaped substrings (and deny-list keyed
 * values) before they reach the INSERT/UPDATE params. This test mocks
 * pool.query, drives the real write function with secret-laden policy data,
 * and asserts the raw secrets never reach the params vector while ordinary
 * prose passes through verbatim.
 *
 * NOTE: `runSemanticAutoMap()` also redacts its INSERT params
 * (raw_citation / source_excerpt), but its write path is gated behind a live
 * gpt-4o-mini call (generateChatText) that throws — and short-circuits before
 * the write — under the mocked pool, so it cannot be exercised here without a
 * network/LLM stub. The redaction wrapping there is identical in shape to the
 * verified syncPolicyToMapping path.
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

// Credential-shaped secrets (caught by the regex deny-list regardless of the
// destination column name).
const SK_KEY = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const GHP_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// ---------------------------------------------------------------------------
// Mock pg.Pool.prototype.query BEFORE importing the module under test so the
// local shared pool inside policyMappingBridge never touches a real DB.
// ---------------------------------------------------------------------------

interface CapturedQuery {
  sql: string;
  params: unknown[];
}
const captured: CapturedQuery[] = [];

// Drives which policy row the `FROM policies ... WHERE id = $1` SELECT returns.
let policyRow: Record<string, unknown> | null = null;

type QuerySource = string | { text: string; values?: unknown[] };
type MockedPoolQuery = (
  sql: QuerySource,
  params?: unknown[],
) => Promise<QueryResult<QueryResultRow>>;

const ok = (rows: QueryResultRow[]): QueryResult<QueryResultRow> => ({
  rows,
  rowCount: rows.length,
  command: "",
  oid: 0,
  fields: [],
});

const mockQuery: MockedPoolQuery = (sql, params = []) => {
  const sqlStr = typeof sql === "string" ? sql : sql.text;
  const paramArr = Array.isArray(params)
    ? params
    : (typeof sql === "object" && sql.values) || [];
  captured.push({ sql: sqlStr, params: paramArr });

  // The policy lookup that feeds the projection.
  if (
    sqlStr.includes("FROM policies") &&
    sqlStr.includes("WHERE id = $1") &&
    sqlStr.includes("policy_number")
  ) {
    return Promise.resolve(ok(policyRow ? [policyRow] : []));
  }

  // Force the INSERT path: no existing projection row for this policy.
  if (sqlStr.includes("extracted_hash") && sqlStr.includes("WHERE source_policy_id")) {
    return Promise.resolve(ok([]));
  }

  // The projection INSERT returns the new id.
  if (sqlStr.includes("INSERT INTO qms_uploaded_documents")) {
    return Promise.resolve(ok([{ id: 42 }]));
  }

  // Everything else (init DDL, etc.) — plausible default.
  return Promise.resolve(ok([{ id: 1 }]));
};

(Pool.prototype as unknown as { query: MockedPoolQuery }).query = mockQuery;

// Import AFTER the mock is in place.
const { syncPolicyToMapping } = await import("./policyMappingBridge");

/** Return the params from the most-recent qms_uploaded_documents INSERT. */
function lastProjectionInsertParams(): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].sql.includes("INSERT INTO qms_uploaded_documents")) {
      return captured[i].params;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section 1 — secret-laden policy must be scrubbed before the projection INSERT
// ---------------------------------------------------------------------------

console.log("\n=== syncPolicyToMapping — projection write secret-leak tests ===\n");

{
  captured.length = 0;
  policyRow = {
    id: 7,
    policy_number: "POL-PUBLIC-7",
    // Credential-shaped substring embedded in the title.
    title: `Quarterly Access Review ${SK_KEY} policy`,
    description: "",
    category: "policy",
    // Empty content + no file ⇒ status 'empty' ⇒ returns right after the
    // projection write (no LLM / citation extraction is reached).
    content_text: "",
    file_path: null,
    file_name: "access-review-public.pdf",
    file_size: 0,
    file_mime_type: null,
    // Credential-shaped substring embedded in uploaded_by.
    created_by: GHP_TOKEN,
    owner_name: null,
    linked_regulation_ids: null,
  };

  await syncPolicyToMapping(7, { semantic: false });

  const params = lastProjectionInsertParams();
  assert(params !== null, "secret-policy: projection INSERT was captured");
  if (params) {
    // INSERT params layout:
    // [title, file_path, file_name, file_size, mime, regCodes, uploaded_by,
    //  source_policy_id, extracted_text, status, fingerprint]
    const combined = params.map((p) => String(p ?? "")).join("|");

    assert(
      !combined.includes(SK_KEY),
      "secret-policy: raw sk- key is NOT present in INSERT params",
    );
    assert(
      !combined.includes(GHP_TOKEN),
      "secret-policy: raw ghp_ token is NOT present in INSERT params",
    );
    assert(
      combined.includes(REDACTED_SENTINEL),
      "secret-policy: REDACTED sentinel IS present in INSERT params",
    );

    // Anti-tautology: a non-sensitive value (file_name) passes through verbatim.
    assert(
      String(params[2] ?? "") === "access-review-public.pdf",
      "secret-policy: non-sensitive file_name preserved verbatim",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 2 — fully innocuous policy must NOT be altered (redactor is targeted)
// ---------------------------------------------------------------------------

console.log("\n=== syncPolicyToMapping — innocuous policy passes through ===\n");

{
  captured.length = 0;
  policyRow = {
    id: 8,
    policy_number: "POL-PUBLIC-8",
    title: "Information Security Policy",
    description: "",
    category: "policy",
    content_text: "",
    file_path: null,
    file_name: "infosec-policy.pdf",
    file_size: 0,
    file_mime_type: null,
    created_by: "alice@example.com",
    owner_name: null,
    linked_regulation_ids: null,
  };

  await syncPolicyToMapping(8, { semantic: false });

  const params = lastProjectionInsertParams();
  assert(params !== null, "innocuous-policy: projection INSERT was captured");
  if (params) {
    assert(
      String(params[0] ?? "") === "Information Security Policy",
      "innocuous-policy: ordinary title preserved verbatim",
    );
    assert(
      String(params[2] ?? "") === "infosec-policy.pdf",
      "innocuous-policy: ordinary file_name preserved verbatim",
    );
    assert(
      String(params[6] ?? "") === "alice@example.com",
      "innocuous-policy: ordinary uploaded_by (email) preserved verbatim",
    );
    const combined = params.map((p) => String(p ?? "")).join("|");
    assert(
      !combined.includes(REDACTED_SENTINEL),
      "innocuous-policy: REDACTED sentinel NOT present (redactor is targeted)",
    );
  }
}

// ---------------------------------------------------------------------------

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n❌ policyMappingBridge tests FAILED");
  process.exit(1);
}
console.log("\n✅ All policyMappingBridge tests passed");
process.exit(0);
