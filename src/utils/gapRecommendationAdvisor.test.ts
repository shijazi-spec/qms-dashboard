/**
 * CI gate: prevents gapRecommendationAdvisor write paths from persisting
 * unmasked secrets into obligation_gap_recommendations.
 *
 * Run:    npx tsx src/utils/gapRecommendationAdvisor.test.ts
 * Wired:  scripts/post-merge.sh (auto-discovered by `npm test`)
 *
 * The two writers that accept caller / AI-supplied data are:
 *   - recommendForClause()    → INSERT ... obligation_gap_recommendations
 *                               (recommendation JSON + generated_by)
 *   - draftDocumentForClause()→ UPDATE obligation_gap_recommendations SET
 *                               recommendation = $2 (the recommendation JSON
 *                               with the AI-drafted document embedded)
 *
 * Both now wrap their caller/AI-supplied values with redactSensitiveDeep()
 * before they reach the params vector. This test mocks pool.query AND the
 * global fetch used by openaiChatHelper, drives the real write functions with
 * payloads containing credential-shaped strings, and asserts the raw secrets
 * never reach the captured INSERT / UPDATE params.
 *
 * NOTE on deny-list KEYS vs credential-shaped VALUES: the recommendation
 * object is normalised by parseRecommendation(), which keeps only a fixed set
 * of keys (what_required, recommended_action, …). Arbitrary deny-list KEYS
 * (password_hash, api_key, …) injected by the model are therefore dropped
 * before persistence, so the realistic leak vector for this module is a
 * credential-shaped STRING interpolated into one of those text fields (or the
 * caller-supplied generated_by / draft). redactSensitiveDeep()'s recursive
 * regex pass is what defends that path, which is what we exercise here.
 */

import { Pool, type QueryResult, type QueryResultRow } from "pg";

// openaiChatHelper.authHeader() throws if no key is configured; fetch is
// mocked below so the value is never sent anywhere.
process.env.OPENAI_API_KEY = "test-key-not-a-real-secret-000000000000000";
process.env.DOCUMENT_MAPPING_WEB_SEARCH = "false";

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

// Credential-shaped strings proven to be caught by the recursive regex pass
// (mirrors changeHistoryDatabase.test.ts Section 4b).
const GHP_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SK_KEY = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const JWT_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

// ---------------------------------------------------------------------------
// Mock pg.Pool.prototype.query before the module under test is imported.
// ---------------------------------------------------------------------------

interface CapturedQuery {
  sql: string;
  params: unknown[];
}
const captured: CapturedQuery[] = [];

// Controls whether the "is there a cached recommendation?" SELECTs return a
// row. null → empty (recommendForClause proceeds to generate + INSERT);
// an object → returned as the cached recommendation (recommendForClause
// short-circuits; draftDocumentForClause uses it as the row to UPDATE).
let cachedRec: Record<string, unknown> | null = null;

type QuerySource = string | { text: string; values?: unknown[] };
type MockedPoolQuery = (
  sql: QuerySource,
  params?: unknown[],
) => Promise<QueryResult<QueryResultRow>>;

const mockQuery: MockedPoolQuery = (sql, params = []) => {
  const sqlStr = typeof sql === "string" ? sql : sql.text;
  const paramArr = Array.isArray(params)
    ? params
    : ((sql as { values?: unknown[] })?.values ?? []);
  captured.push({ sql: sqlStr, params: paramArr });

  const s = sqlStr.replace(/\s+/g, " ").trim();
  let rows: QueryResultRow[] = [];

  if (/FROM obligations o\s+JOIN regulations/i.test(s) && /SELECT o\.id/i.test(s)) {
    // loadClause()
    rows = [
      {
        id: 1,
        obligation_code: "A.10.1",
        title: "Cryptographic controls",
        description: "Policy on the use of cryptographic controls.",
        regulation_id: 10,
        regulation_code: "ISO27001",
      },
    ];
  } else if (/SELECT recommendation, web_grounded FROM obligation_gap_recommendations/i.test(s)) {
    // recommendForClause cached check
    rows = cachedRec ? [{ recommendation: cachedRec, web_grounded: false }] : [];
  } else if (/SELECT recommendation FROM obligation_gap_recommendations/i.test(s)) {
    // draftDocumentForClause cached-draft check + cur fetch
    rows = cachedRec ? [{ recommendation: cachedRec }] : [{ recommendation: {} }];
  }

  return Promise.resolve({
    rows,
    rowCount: rows.length,
    command: "",
    oid: 0,
    fields: [],
  });
};

(Pool.prototype as unknown as { query: MockedPoolQuery }).query = mockQuery;

// ---------------------------------------------------------------------------
// Mock global fetch so openaiChatHelper.generateChatText() returns canned
// content without touching the network.
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  let body: { response_format?: { type?: string } } = {};
  try {
    body = JSON.parse(init?.body ?? "{}");
  } catch {
    /* ignore */
  }
  let content: string;
  if (body.response_format?.type === "json_object") {
    // structured recommendation; embed credential-shaped strings in text fields
    content = JSON.stringify({
      what_required: `The clause requires key management. Leaked key ${SK_KEY} found in legacy doc.`,
      recommended_action: `Create a policy; rotate the exposed token ${JWT_TOKEN}.`,
      suggested_document_title: "Cryptographic Key Management Policy",
      document_type: "Policy",
      key_criteria: ["Key generation", "Key rotation", "Secure storage"],
      priority: "high",
    });
  } else {
    // drafted document markdown; embed a credential-shaped string
    content = `# Cryptographic Key Management Policy\n\nThe old runbook leaked ${GHP_TOKEN} — rotate it.`;
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content, annotations: [] } }] }),
    text: async () => "",
  };
}) as unknown as typeof fetch;

// Import AFTER the mocks are in place.
const { recommendForClause, draftDocumentForClause } = await import(
  "./gapRecommendationAdvisor"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lastParamsMatching(re: RegExp): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (re.test(captured[i].sql.replace(/\s+/g, " ").trim())) {
      return captured[i].params;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section 1 — recommendForClause() INSERT write-path
// ---------------------------------------------------------------------------

console.log("\n=== recommendForClause — INSERT secret-leak tests ===\n");

{
  captured.length = 0;
  cachedRec = null; // force fresh generation → INSERT

  await recommendForClause(1, {
    web: false,
    generatedBy: GHP_TOKEN, // caller-supplied, credential-shaped
  });

  const params = lastParamsMatching(/^INSERT INTO obligation_gap_recommendations/i);
  assert(params !== null, "recommend: INSERT was captured");
  if (params) {
    // params: [obligationId, regulation_id, JSON(rec), web_grounded, generated_by]
    const recJsonParam = String(params[2] ?? "");
    const generatedByParam = String(params[4] ?? "");

    assert(
      !recJsonParam.includes(SK_KEY) && !recJsonParam.includes(JWT_TOKEN),
      "recommend: credential-shaped strings in recommendation JSON are NOT present in INSERT params",
    );
    assert(
      recJsonParam.includes(REDACTED_SENTINEL),
      "recommend: REDACTED sentinel IS present in recommendation JSON param",
    );
    assert(
      !generatedByParam.includes(GHP_TOKEN),
      "recommend: credential-shaped generated_by is NOT present in INSERT params",
    );
    assert(
      generatedByParam.includes(REDACTED_SENTINEL),
      "recommend: REDACTED sentinel IS present in generated_by param",
    );
    // Anti-tautology: non-sensitive content survives verbatim.
    assert(
      recJsonParam.includes("Cryptographic Key Management Policy"),
      "recommend: non-sensitive document title passes through verbatim (redactor is targeted)",
    );
  }
}

// Anti-tautology for generated_by: the default ("ai") must pass through.
{
  captured.length = 0;
  cachedRec = null;
  await recommendForClause(1, { web: false }); // no generatedBy → "ai"
  const params = lastParamsMatching(/^INSERT INTO obligation_gap_recommendations/i);
  assert(params !== null, "recommend/default: INSERT was captured");
  if (params) {
    assert(
      params[4] === "ai",
      "recommend/default: default generated_by 'ai' passes through verbatim",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 2 — draftDocumentForClause() UPDATE write-path
// ---------------------------------------------------------------------------

console.log("\n=== draftDocumentForClause — UPDATE secret-leak tests ===\n");

{
  captured.length = 0;
  // A cached recommendation (no draft yet) so recommendForClause short-circuits
  // and draftDocumentForClause proceeds to generate + UPDATE.
  cachedRec = {
    what_required: "Key management is required.",
    recommended_action: "Create a policy.",
    suggested_document_title: "Cryptographic Key Management Policy",
    document_type: "Policy",
    key_criteria: ["Rotation"],
    priority: "high",
    sources: [],
    web_grounded: false,
  };

  await draftDocumentForClause(1, { generatedBy: "consultant@example.com" });

  const params = lastParamsMatching(
    /^UPDATE obligation_gap_recommendations SET recommendation/i,
  );
  assert(params !== null, "draft: UPDATE was captured");
  if (params) {
    // params: [obligationId, JSON(recJson-with-draft)]
    const recJsonParam = String(params[1] ?? "");
    assert(
      !recJsonParam.includes(GHP_TOKEN),
      "draft: credential-shaped string inside drafted document is NOT present in UPDATE params",
    );
    assert(
      recJsonParam.includes(REDACTED_SENTINEL),
      "draft: REDACTED sentinel IS present in UPDATE recommendation param",
    );
    // Anti-tautology: ordinary draft prose / title survives.
    assert(
      recJsonParam.includes("Cryptographic Key Management Policy"),
      "draft: non-sensitive title/prose passes through verbatim",
    );
  }
}

// ---------------------------------------------------------------------------
// Restore + summary
// ---------------------------------------------------------------------------

globalThis.fetch = originalFetch;

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n❌ gapRecommendationAdvisor tests FAILED");
  process.exit(1);
}
console.log("\n✅ All gapRecommendationAdvisor tests passed");
process.exit(0);
