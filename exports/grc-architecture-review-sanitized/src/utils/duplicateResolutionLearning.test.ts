/**
 * CI gate: prevents duplicateResolutionLearning write paths from persisting
 * unmasked secrets into duplicate_resolution_feedback.
 *
 * Run:    npx tsx src/utils/duplicateResolutionLearning.test.ts
 * Wired:  scripts/post-merge.sh (auto-discovered by tests/runIntegrationTests.ts)
 *
 * recordResolutionEvent() persists agent-supplied `plan` / `report` objects
 * (arbitrary `unknown`) into the plan_json / report_json columns. Those
 * snapshots can embed credential-shaped values (e.g. a CRMProvider field snapshot
 * carrying an api_key/access_token). The writer runs redactSensitiveDeep()
 * over every value before the INSERT. This test mocks pool.query, drives the
 * real write function with payloads containing the required deny-list keys
 * (password_hash, mfa_secret, access_token, refresh_token, api_key), and
 * asserts the raw secrets never reach the INSERT params vector.
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
// that the pool inside duplicateRadarDatabase (imported transitively) never
// touches a real DB.
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
const { recordResolutionEvent } = await import("./duplicateResolutionLearning");

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

// params layout (1-indexed in SQL -> 0-indexed here):
//   [0] cluster_id      [6] duplicates_tagged
//   [1] event_type      [7] reparented
//   [2] proposed_master [8] errors
//   [3] chosen_master   [9] plan_json (JSON string)
//   [4] master_overrid  [10] report_json (JSON string)
//   [5] fields_migrated [11] performed_by
const PLAN_IDX = 9;
const REPORT_IDX = 10;

// ---------------------------------------------------------------------------
// Section 1 — secret embedded in the plan / report object snapshots
// ---------------------------------------------------------------------------

console.log("\n=== recordResolutionEvent — plan/report secret scrubbing ===\n");

for (const key of REQUIRED_DENY_KEYS) {
  captured.length = 0;
  const rawSecret = SECRETS[key];

  await recordResolutionEvent({
    clusterId: 1,
    eventType: "applied",
    proposedMasterCRMProviderId: "CRMProvider-aaa",
    chosenMasterCRMProviderId: "CRMProvider-bbb",
    fieldsMigrated: 3,
    plan: {
      survivor: "CRMProvider-bbb",
      integration: { provider: "CRMProvider", [key]: rawSecret },
    },
    report: {
      summary: "merged 2 records",
      credentials_used: { [key]: rawSecret },
    },
    performedBy: "operator-1",
  });

  const params = lastInsertParams();
  assert(params !== null, `${key}: pool.query was called with INSERT`);
  if (!params) continue;

  const planParam = String(params[PLAN_IDX] ?? "");
  const reportParam = String(params[REPORT_IDX] ?? "");
  const combined = `${planParam}${reportParam}`;

  assert(
    !combined.includes(rawSecret),
    `${key}: raw secret is NOT present in plan_json/report_json INSERT params`,
  );
  assert(
    combined.includes(REDACTED_SENTINEL),
    `${key}: REDACTED sentinel IS present in plan_json/report_json INSERT params`,
  );

  // plan_json / report_json must remain valid JSON (the column is ::jsonb).
  let planParsed: unknown = null;
  let reportParsed: unknown = null;
  let parseError: unknown = null;
  try {
    planParsed = JSON.parse(planParam);
    reportParsed = JSON.parse(reportParam);
  } catch (err) {
    parseError = err;
  }
  assert(
    parseError === null,
    `${key}: plan_json and report_json round-trip via JSON.parse (still valid jsonb)`,
  );
  assert(
    typeof planParsed === "object" &&
      planParsed !== null &&
      (planParsed as Record<string, unknown>).survivor === "CRMProvider-bbb",
    `${key}: plan_json preserves non-secret fields (survivor)`,
  );
  void reportParsed;
}

// ---------------------------------------------------------------------------
// Section 2 — secret-shaped string routed through performed_by / CRMProvider ids
// ---------------------------------------------------------------------------

console.log("\n=== recordResolutionEvent — id/actor field scrubbing ===\n");

{
  captured.length = 0;
  const jwt =
    "<REDACTED_TOKEN>";
  await recordResolutionEvent({
    clusterId: 2,
    eventType: "dry_run",
    proposedMasterCRMProviderId: `Bearer ${jwt}`,
    chosenMasterCRMProviderId: "CRMProvider-clean",
    performedBy: `<REDACTED_TOKEN>`,
  });
  const params = lastInsertParams();
  assert(params !== null, "id/actor: pool.query was called with INSERT");
  if (params) {
    const combined = `${String(params[2] ?? "")}|${String(params[3] ?? "")}|${String(params[11] ?? "")}`;
    assert(
      !combined.includes(jwt) &&
        !combined.includes("<REDACTED_TOKEN>"),
      "id/actor: raw credential-shaped values are NOT present in INSERT params",
    );
    assert(
      combined.includes(REDACTED_SENTINEL),
      "id/actor: REDACTED sentinel IS present in INSERT params",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 3 — anti-tautology: ordinary, non-sensitive payloads pass through
// ---------------------------------------------------------------------------

console.log("\n=== recordResolutionEvent — non-sensitive passthrough ===\n");

{
  captured.length = 0;
  await recordResolutionEvent({
    clusterId: 42,
    eventType: "preview",
    proposedMasterCRMProviderId: "CRMProvider-12345",
    chosenMasterCRMProviderId: "CRMProvider-12345",
    fieldsMigrated: 7,
    plan: { survivor: "CRMProvider-12345", notes: "no overrides, clean merge" },
    report: { summary: "preview only", reparented: 0 },
    performedBy: "<REDACTED_EMAIL>",
  });
  const params = lastInsertParams();
  assert(params !== null, "non-sensitive: pool.query was called");
  if (params) {
    assert(
      params[0] === 42 && params[1] === "preview",
      "non-sensitive: cluster_id / event_type preserved verbatim",
    );
    assert(
      params[2] === "CRMProvider-12345" && params[3] === "CRMProvider-12345",
      "non-sensitive: CRMProvider ids preserved verbatim (not over-redacted)",
    );
    assert(
      params[11] === "<REDACTED_EMAIL>",
      "non-sensitive: performed_by preserved verbatim",
    );
    const planParam = String(params[PLAN_IDX] ?? "");
    assert(
      planParam.includes("no overrides, clean merge") &&
        !planParam.includes(REDACTED_SENTINEL),
      "non-sensitive: ordinary plan prose preserved (redaction is targeted, not nuke-everything)",
    );
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.error("❌ duplicateResolutionLearning secret-leak test FAILED");
  process.exit(1);
}
console.log("✅ duplicateResolutionLearning secret-leak test passed");
