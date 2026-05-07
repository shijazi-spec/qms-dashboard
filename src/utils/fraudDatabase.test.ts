/**
 * CI gate: prevents fraudDatabase write paths from persisting
 * unmasked credential-shaped strings into the fraud_* tables.
 *
 * Run:   npx tsx src/utils/fraudDatabase.test.ts
 * Wired: auto-discovered by tests/runIntegrationTests.ts → npm test
 *
 * fraudDatabase.ts uses createRedactedPool (./redactedPool), which wraps
 * pg.Pool.prototype.query and runs redactSensitiveDeep() over every INSERT /
 * UPDATE param array before it reaches Postgres. Mocking Pool.prototype.query
 * BEFORE the module is imported lets us intercept the already-redacted params
 * and assert that no raw credential-shaped string survives to the wire.
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
// Capture harness — intercept Pool.prototype.query BEFORE module import so
// that the redactedPool wrapper (installed at module load) calls our mock as
// its underlying transport.
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

// Canned SELECT returns so functions that do a SELECT before writing still
// get a plausible result and proceed to the INSERT/UPDATE under test.
const CANNED_INCIDENT_ROW = {
  id: 42,
  public_id: "00000000-0000-0000-0000-000000000042",
  incident_code: "INC-042",
  date_detected: "2026-01-01",
  severity: "P3",
  incident_type: "card_testing",
  detection_source: "it_monitoring",
  affected_customers: 0,
  amount_sar: 0,
  actions_taken: null,
  account_frozen: false,
  resolution_date: null,
  root_cause: null,
  sama_reported: null,
  status: "open",
  contained_at: null,
  notes: null,
  linked_rule_id: null,
  linked_enterprise_risk_id: null,
  created_by: "test",
  updated_by: null,
  created_at: new Date(),
  updated_at: new Date(),
};

const CANNED_COUNTRY_ROW = {
  id: 1,
  public_id: "00000000-0000-0000-0000-000000000001",
  iso_code: "XX",
  country_name: "Testland",
  fatf_status: "no_action",
  risk_rating: "low",
  expat_population: null,
  bin_status: "approved",
  edd_required: false,
  special_conditions: null,
  approved_by: "test",
  date_assessed: "2026-01-01",
  created_at: new Date(),
  updated_at: new Date(),
};

const CANNED_ESC_ROW = {
  id: 1,
  public_id: "00000000-0000-0000-0000-000000000003",
  trigger_id: "ESC-P3",
  trigger_definition: "P3 test trigger",
  severity: "P3",
  notify_immediately: [],
  notify_within_4h: [],
  external_party: null,
  external_contact: null,
  response_sla: "72h",
  response_sla_hours: 72,
  is_active: true,
  updated_by: null,
  updated_at: new Date(),
};

const mockQuery: MockedPoolQuery = (sql, params = []) => {
  const sqlStr = typeof sql === "string" ? sql : sql.text;
  const paramArr = Array.isArray(params) ? params : [];
  captured.push({ sql: sqlStr, params: paramArr });

  // Return canned rows for SELECTs so callers that read-before-write succeed.
  const upper = sqlStr.replace(/\s+/g, " ").trim().toUpperCase();
  if (upper.startsWith("SELECT") || upper.startsWith("WITH")) {
    // generateNextIncidentCode returns max_n
    if (sqlStr.includes("max_n") || sqlStr.includes("MAX_N")) {
      return Promise.resolve({ rows: [{ max_n: 41 }], rowCount: 1, command: "SELECT", oid: 0, fields: [] });
    }
    // COUNT(*) queries (seed guards)
    if (sqlStr.includes("COUNT(*)")) {
      return Promise.resolve({ rows: [{ n: 0 }], rowCount: 1, command: "SELECT", oid: 0, fields: [] });
    }
    // getFraudIncidentById — needed by closeFraudIncident
    if (sqlStr.includes("fraud_incidents") && sqlStr.includes("id = $1")) {
      return Promise.resolve({ rows: [CANNED_INCIDENT_ROW], rowCount: 1, command: "SELECT", oid: 0, fields: [] });
    }
    // getCountryRiskByIso — needed by updateCountryRisk
    if (sqlStr.includes("fraud_country_risk") && sqlStr.includes("iso_code = $1")) {
      return Promise.resolve({ rows: [CANNED_COUNTRY_ROW], rowCount: 1, command: "SELECT", oid: 0, fields: [] });
    }
    // getEscalationByTriggerId — needed by updateEscalationRow + dispatchEscalationForIncident
    if (sqlStr.includes("fraud_escalation_matrix") && sqlStr.includes("trigger_id = $1")) {
      return Promise.resolve({ rows: [CANNED_ESC_ROW], rowCount: 1, command: "SELECT", oid: 0, fields: [] });
    }
    return Promise.resolve({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] });
  }

  // For INSERT RETURNING / UPDATE RETURNING, return a plausible row.
  return Promise.resolve({
    rows: [{ id: 1, incident_code: "INC-042", ...CANNED_INCIDENT_ROW }],
    rowCount: 1,
    command: upper.startsWith("INSERT") ? "INSERT" : "UPDATE",
    oid: 0,
    fields: [],
  });
};

(Pool.prototype as unknown as { query: MockedPoolQuery }).query = mockQuery;

// Import AFTER the mock is in place.
const {
  createFraudRule,
  updateFraudRule,
  createFraudIncident,
  updateFraudIncident,
  closeFraudIncident,
  upsertFraudKpi,
  createCountryRisk,
  updateCountryRisk,
  updateEscalationRow,
} = await import("./fraudDatabase");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REDACTED_SENTINEL = "***REDACTED***";

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
  {
    label: "Stripe live key",
    value: "sk_live_ABCdefGHIjklMNOpqrsTUVwx",
  },
];

/** Returns the params from the most-recent INSERT or UPDATE captured. */
function lastWriteParams(): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const c = captured[i];
    const upper = c.sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (upper.startsWith("INSERT INTO") || upper.startsWith("UPDATE ")) {
      return c.params;
    }
  }
  return null;
}

/** Returns true if any param in the array contains the given string. */
function anyParamContains(params: unknown[], needle: string): boolean {
  return params.some((p) => typeof p === "string" && p.includes(needle));
}

/** Returns true if any param in the array contains the REDACTED sentinel. */
function anyParamRedacted(params: unknown[]): boolean {
  return anyParamContains(params, REDACTED_SENTINEL);
}

// ---------------------------------------------------------------------------
// Section 1 — createFraudRule: secret-shaped strings in notes / rule_name
// ---------------------------------------------------------------------------

console.log("\n=== createFraudRule — write-path secret-leak tests ===\n");

for (const { label, value } of SECRET_LIKE_STRINGS) {
  captured.length = 0;
  await createFraudRule({
    rule_id: "FR-TEST",
    rule_name: `Rule with embedded token: ${value}`,
    transaction_type: "Wallet Top-Up",
    owner: "IT",
    test_status: "not_tested",
    next_review: "2026-07-01",
    notes: `Incident note referencing credential: ${value}`,
  });

  const params = lastWriteParams();
  assert(params !== null, `createFraudRule/${label}: pool.query was called with INSERT`);
  if (!params) continue;

  assert(
    !anyParamContains(params, value),
    `createFraudRule/${label}: raw secret-shaped value is NOT present in INSERT params`,
  );
  assert(
    anyParamRedacted(params),
    `createFraudRule/${label}: REDACTED sentinel IS present in INSERT params`,
  );
}

// Anti-tautology: ordinary notes must pass through verbatim.
{
  captured.length = 0;
  await createFraudRule({
    rule_id: "FR-SAFE",
    rule_name: "High Amount Payment Alert",
    transaction_type: "Wallet Top-Up",
    owner: "IT",
    test_status: "passed",
    next_review: "2026-07-01",
    notes: "Regular operational note — nothing sensitive here.",
  });
  const params = lastWriteParams();
  assert(params !== null, "createFraudRule/innocuous: pool.query was called");
  if (params) {
    assert(
      anyParamContains(params, "Regular operational note"),
      "createFraudRule/innocuous: ordinary notes value passes through verbatim",
    );
    assert(
      !anyParamRedacted(params),
      "createFraudRule/innocuous: REDACTED sentinel NOT present (regex is targeted)",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 2 — updateFraudRule: secret-shaped strings in notes
// ---------------------------------------------------------------------------

console.log("\n=== updateFraudRule — write-path secret-leak tests ===\n");

for (const { label, value } of SECRET_LIKE_STRINGS.slice(0, 2)) {
  captured.length = 0;
  await updateFraudRule(1, {
    notes: `Updated note with leaked token: ${value}`,
    updated_by: "test-runner",
  });

  const params = lastWriteParams();
  assert(params !== null, `updateFraudRule/${label}: pool.query was called with UPDATE`);
  if (!params) continue;

  assert(
    !anyParamContains(params, value),
    `updateFraudRule/${label}: raw secret-shaped value is NOT present in UPDATE params`,
  );
  assert(
    anyParamRedacted(params),
    `updateFraudRule/${label}: REDACTED sentinel IS present in UPDATE params`,
  );
}

// ---------------------------------------------------------------------------
// Section 3 — createFraudIncident: secret-shaped strings in free-text fields
// ---------------------------------------------------------------------------

console.log("\n=== createFraudIncident — write-path secret-leak tests ===\n");

for (const { label, value } of SECRET_LIKE_STRINGS) {
  captured.length = 0;
  try {
    await createFraudIncident({
      date_detected: "2026-05-01",
      severity: "P3",
      incident_type: "card_testing",
      detection_source: "it_monitoring",
      created_by: "test-runner",
      actions_taken: `Action details: token was ${value}`,
      root_cause: `Root cause references key: ${value}`,
      notes: `Investigation note: ${value}`,
    });
  } catch {
    // May throw if dispatchEscalationForIncident fails in the mock; that's OK
    // as long as the INSERT was already captured.
  }

  const params = lastWriteParams();
  assert(params !== null, `createFraudIncident/${label}: pool.query was called with INSERT`);
  if (!params) continue;

  assert(
    !anyParamContains(params, value),
    `createFraudIncident/${label}: raw secret-shaped value is NOT present in INSERT params`,
  );
  assert(
    anyParamRedacted(params),
    `createFraudIncident/${label}: REDACTED sentinel IS present in INSERT params`,
  );
}

// Anti-tautology
{
  captured.length = 0;
  try {
    await createFraudIncident({
      date_detected: "2026-05-01",
      severity: "P3",
      incident_type: "card_testing",
      detection_source: "it_monitoring",
      created_by: "test-runner",
      notes: "Customer notified; case ID ABC-123.",
    });
  } catch { /* ignore dispatch errors */ }

  const params = lastWriteParams();
  assert(params !== null, "createFraudIncident/innocuous: pool.query was called");
  if (params) {
    assert(
      anyParamContains(params, "Customer notified"),
      "createFraudIncident/innocuous: ordinary notes value passes through verbatim",
    );
    assert(
      !anyParamRedacted(params),
      "createFraudIncident/innocuous: REDACTED sentinel NOT present",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 4 — updateFraudIncident: secret-shaped strings in free-text fields
// ---------------------------------------------------------------------------

console.log("\n=== updateFraudIncident — write-path secret-leak tests ===\n");

for (const { label, value } of SECRET_LIKE_STRINGS.slice(0, 2)) {
  captured.length = 0;
  await updateFraudIncident(42, {
    root_cause: `Root cause with embedded credential: ${value}`,
    notes: `Follow-up note: ${value}`,
    updated_by: "test-runner",
  });

  const params = lastWriteParams();
  assert(params !== null, `updateFraudIncident/${label}: pool.query was called with UPDATE`);
  if (!params) continue;

  assert(
    !anyParamContains(params, value),
    `updateFraudIncident/${label}: raw secret-shaped value is NOT present in UPDATE params`,
  );
  assert(
    anyParamRedacted(params),
    `updateFraudIncident/${label}: REDACTED sentinel IS present in UPDATE params`,
  );
}

// ---------------------------------------------------------------------------
// Section 5 — closeFraudIncident: root_cause field
// ---------------------------------------------------------------------------

console.log("\n=== closeFraudIncident — write-path secret-leak tests ===\n");

{
  const { label, value } = SECRET_LIKE_STRINGS[2]; // OpenAI key
  captured.length = 0;
  await closeFraudIncident(42, "test-runner", {
    root_cause: `Closure root-cause references token: ${value}`,
    resolution_date: "2026-05-10",
  });

  const params = lastWriteParams();
  assert(params !== null, `closeFraudIncident/${label}: pool.query was called with UPDATE`);
  if (params) {
    assert(
      !anyParamContains(params, value),
      `closeFraudIncident/${label}: raw secret-shaped value is NOT present in UPDATE params`,
    );
    assert(
      anyParamRedacted(params),
      `closeFraudIncident/${label}: REDACTED sentinel IS present in UPDATE params`,
    );
  }
}

// ---------------------------------------------------------------------------
// Section 6 — upsertFraudKpi: notes field
// ---------------------------------------------------------------------------

console.log("\n=== upsertFraudKpi — write-path secret-leak tests ===\n");

for (const { label, value } of SECRET_LIKE_STRINGS.slice(0, 2)) {
  captured.length = 0;
  await upsertFraudKpi(
    "2026-05",
    {
      confirmed_incidents: 3,
      notes: `KPI notes with embedded token: ${value}`,
    },
    "test-runner",
  );

  const params = lastWriteParams();
  assert(params !== null, `upsertFraudKpi/${label}: pool.query was called with INSERT`);
  if (!params) continue;

  assert(
    !anyParamContains(params, value),
    `upsertFraudKpi/${label}: raw secret-shaped value is NOT present in INSERT params`,
  );
  assert(
    anyParamRedacted(params),
    `upsertFraudKpi/${label}: REDACTED sentinel IS present in INSERT params`,
  );
}

// ---------------------------------------------------------------------------
// Section 7 — createCountryRisk: special_conditions field
// ---------------------------------------------------------------------------

console.log("\n=== createCountryRisk — write-path secret-leak tests ===\n");

{
  const { label, value } = SECRET_LIKE_STRINGS[3]; // GitHub PAT
  captured.length = 0;
  await createCountryRisk({
    iso_code: "XX",
    country_name: "Testland",
    fatf_status: "no_action",
    risk_rating: "low",
    bin_status: "approved",
    edd_required: false,
    date_assessed: "2026-05-01",
    approved_by: "test-runner",
    special_conditions: `Conditions with embedded key: ${value}`,
  });

  const params = lastWriteParams();
  assert(params !== null, `createCountryRisk/${label}: pool.query was called with INSERT`);
  if (params) {
    assert(
      !anyParamContains(params, value),
      `createCountryRisk/${label}: raw secret-shaped value is NOT present in INSERT params`,
    );
    assert(
      anyParamRedacted(params),
      `createCountryRisk/${label}: REDACTED sentinel IS present in INSERT params`,
    );
  }
}

// ---------------------------------------------------------------------------
// Section 8 — updateCountryRisk: special_conditions field
// ---------------------------------------------------------------------------

console.log("\n=== updateCountryRisk — write-path secret-leak tests ===\n");

{
  const { label, value } = SECRET_LIKE_STRINGS[4]; // Stripe live key
  captured.length = 0;
  await updateCountryRisk(
    "XX",
    { special_conditions: `Updated conditions with token: ${value}` },
    "test-runner",
  );

  const params = lastWriteParams();
  assert(params !== null, `updateCountryRisk/${label}: pool.query was called with UPDATE`);
  if (params) {
    assert(
      !anyParamContains(params, value),
      `updateCountryRisk/${label}: raw secret-shaped value is NOT present in UPDATE params`,
    );
    assert(
      anyParamRedacted(params),
      `updateCountryRisk/${label}: REDACTED sentinel IS present in UPDATE params`,
    );
  }
}

// ---------------------------------------------------------------------------
// Section 9 — updateEscalationRow: trigger_definition / external_contact
// ---------------------------------------------------------------------------

console.log("\n=== updateEscalationRow — write-path secret-leak tests ===\n");

{
  const { label, value } = SECRET_LIKE_STRINGS[1]; // JWT
  captured.length = 0;
  await updateEscalationRow("ESC-P3", {
    trigger_definition: `Escalation trigger updated; token: ${value}`,
    external_contact: `Contact note references credential: ${value}`,
    updated_by: "test-runner",
  });

  const params = lastWriteParams();
  assert(params !== null, `updateEscalationRow/${label}: pool.query was called with UPDATE`);
  if (params) {
    assert(
      !anyParamContains(params, value),
      `updateEscalationRow/${label}: raw secret-shaped value is NOT present in UPDATE params`,
    );
    assert(
      anyParamRedacted(params),
      `updateEscalationRow/${label}: REDACTED sentinel IS present in UPDATE params`,
    );
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error(
    "\n❌ fraudDatabase secret-leak tests FAILED.\n" +
      "   The fraudDatabase write paths must route through createRedactedPool\n" +
      "   (./redactedPool) so every INSERT/UPDATE param vector is scrubbed\n" +
      "   for credential-shaped substrings before reaching Postgres.\n" +
      "   See src/utils/README.md for the required structure.",
  );
  process.exit(1);
} else {
  console.log("\n✅ fraudDatabase secret-leak tests passed.");
}
