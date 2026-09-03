/**
 * CI gate: prevents northStarSources write paths from persisting unmasked
 * secrets into the North Star capture tables (certification_milestones,
 * evidence_requests, tpra_requests, qms_adoption, value_realization,
 * okr_metric_entries).
 *
 * Run:    npx tsx src/utils/northStarSources.test.ts
 *
 * `insertSource(name, body)` builds a dynamic INSERT from caller-supplied
 * `body` values into a whitelisted table. This test mocks pool.query, drives
 * insertSource with payloads that carry the five required deny-list keys
 * (password_hash, mfa_secret, access_token, refresh_token, api_key) plus
 * credential-shaped strings under innocuous columns, and asserts the raw
 * secrets never reach the INSERT params vector.
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
const { insertSource } = await import("./northStarSources");

const REDACTED_SENTINEL = "***REDACTED***";

const SECRETS = {
  password_hash: <REDACTED_SECRET>
  mfa_secret: <REDACTED_SECRET>
  access_token: <REDACTED_SECRET>
  refresh_token: <REDACTED_SECRET>
  api_key: <REDACTED_SECRET>
} as const;

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
// Section 1 — deny-list keys carried inside an object column value.
// insertSource only persists whitelisted columns, none of which are named like
// the deny-list keys, so we nest each secret under its deny-list KEY inside an
// allowed TEXT column (e.g. `notes`) — redactSensitiveDeep recurses into the
// object and masks the value by key name before it reaches INSERT params.
// ---------------------------------------------------------------------------

console.log("\n=== insertSource — deny-list key values are scrubbed ===\n");

const SECRET_CASES: Array<{ label: keyof typeof SECRETS; value: string }> = [
  { label: "password_hash", value: SECRETS.password_hash },
  { label: "mfa_secret", value: SECRETS.mfa_secret },
  { label: "access_token", value: SECRETS.access_token },
  { label: "refresh_token", value: SECRETS.refresh_token },
  { label: "api_key", value: SECRETS.api_key },
];

for (const { label, value } of SECRET_CASES) {
  captured.length = 0;
  await insertSource("certification_milestones", {
    certification: "ISO 27001",
    milestone_name: "Stage 2 audit",
    status: "planned",
    owner: "alice",
    notes: { summary: "credential captured in audit trail", [label]: value },
  });
  const params = lastInsertParams();
  assert(params !== null, `${label}: pool.query was called with INSERT`);
  if (!params) continue;
  const combined = JSON.stringify(params);
  assert(
    !combined.includes(value),
    `${label}: raw secret value is NOT present in INSERT params`,
  );
  assert(
    combined.includes(REDACTED_SENTINEL),
    `${label}: REDACTED sentinel IS present in INSERT params`,
  );
}

// ---------------------------------------------------------------------------
// Section 2 — deny-list KEY redaction via nested object value.
// A caller may pass an object as a column value; redactSensitiveDeep recurses
// into objects, so a sensitive sub-key (api_key) inside the value should be
// scrubbed by name even when the surrounding column is innocuous.
// ---------------------------------------------------------------------------

console.log("\n=== insertSource — nested deny-list keys are scrubbed ===\n");

{
  captured.length = 0;
  await insertSource("value_realization", {
    initiative_name: "Automation rollout",
    category: "efficiency",
    status: "in_progress",
    notes: { provider: "CRMProvider", api_key: SECRETS.api_key, account_id: "acct-public-123" },
  });
  const params = lastInsertParams();
  assert(params !== null, "nested-object: pool.query was called with INSERT");
  if (params) {
    const combined = JSON.stringify(params);
    assert(
      !combined.includes(SECRETS.api_key),
      "nested-object: api_key nested in object value is NOT present in INSERT params",
    );
    assert(
      combined.includes(REDACTED_SENTINEL),
      "nested-object: REDACTED sentinel IS present in INSERT params",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 3 — anti-tautology: ordinary, non-sensitive values pass through
// verbatim so the redactor is proven targeted, not nuke-everything.
// ---------------------------------------------------------------------------

console.log("\n=== insertSource — non-sensitive values pass through verbatim ===\n");

{
  captured.length = 0;
  await insertSource("evidence_requests", {
    request_ref: "EVID-2025-001",
    business_unit: "Finance",
    status: "open",
    owner: "Bob Smith",
  });
  const params = lastInsertParams();
  assert(params !== null, "non-sensitive: pool.query was called with INSERT");
  if (params) {
    assert(
      params.includes("EVID-2025-001"),
      "non-sensitive: request_ref preserved verbatim (test isn't a tautology)",
    );
    assert(
      params.includes("Finance") && params.includes("Bob Smith"),
      "non-sensitive: business_unit and owner preserved verbatim",
    );
    const combined = JSON.stringify(params);
    assert(
      !combined.includes(REDACTED_SENTINEL),
      "non-sensitive: REDACTED sentinel NOT present (regex is targeted)",
    );
  }
}

// ---------------------------------------------------------------------------

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n❌ northStarSources tests FAILED");
  process.exit(1);
}
console.log("\n✅ All northStarSources tests passed");
process.exit(0);
