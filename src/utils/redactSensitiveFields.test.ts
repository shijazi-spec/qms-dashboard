/**
 * CI gate: prevents new logs from writing unmasked secrets.
 *
 * Run:    npx tsx src/utils/redactSensitiveFields.test.ts
 * Wired:  scripts/post-merge.sh
 *
 * The integration section calls the real logEvent() and asserts raw secrets
 * never appear in the captured INSERT params for the keys required by
 * Task #37: password_hash, mfa_secret, access_token, refresh_token, api_key.
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

function assertDeepEqual<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(
      `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`,
    );
    failed++;
  }
}

// Patch pg.Pool.prototype.query before importing the module under test, so
// the module's auto-initializeEventLogsTable() call never hits a real DB.

interface CapturedQuery {
  sql: string;
  params: unknown[];
}
const captured: CapturedQuery[] = [];

type QuerySource = string | { text: string; values?: unknown[] };
type MockedPoolQuery = (sql: QuerySource, params?: unknown[]) => Promise<QueryResult<QueryResultRow>>;

function fakeRow(params: unknown[]): QueryResultRow {
  return {
    id: captured.length,
    timestamp: new Date(),
    user_id: params[0] ?? null,
    action_type: params[4] ?? "UPDATE",
    entity_type: params[5] ?? "USER",
    entity_id: params[6] ?? null,
    entity_name: params[7] ?? null,
    description: params[8] ?? null,
    old_value: params[9] ?? null,
    new_value: params[10] ?? null,
    ai_involved: params[11] ?? false,
    severity: params[12] ?? "INFO",
    correlation_id: params[13] ?? null,
    ip_address: params[14] ?? null,
    user_agent: params[15] ?? null,
    module: params[16] ?? null,
    checksum: params[17] ?? null,
    created_at: new Date(),
    exists: false,
    is_partitioned: true,
    total: 0,
    count: 0,
  };
}

const mockQuery: MockedPoolQuery = (sql, params = []) => {
  const sqlStr = typeof sql === "string" ? sql : sql.text;
  const paramArr = Array.isArray(params) ? params : [];
  captured.push({ sql: sqlStr, params: paramArr });
  return Promise.resolve({
    rows: [fakeRow(paramArr)],
    rowCount: 1,
    command: "",
    oid: 0,
    fields: [],
  });
};

(Pool.prototype as unknown as { query: MockedPoolQuery }).query = mockQuery;

const {
  redactSensitiveFields,
  REDACTED_SENTINEL,
  isSensitiveField,
  pool,
  logEvent,
} = await import("./eventLogsDatabase");
type EventLogInput = Parameters<typeof logEvent>[0];

// Section 1 — redactSensitiveFields unit tests

console.log("\n=== redactSensitiveFields — unit tests ===\n");

assert(redactSensitiveFields(null) === null, "null returned unchanged");
assert(redactSensitiveFields(undefined) === undefined, "undefined returned unchanged");

{
  const input = { username: "alice", email: "alice@example.com", role: "admin" };
  assertDeepEqual(redactSensitiveFields(input), input, "non-sensitive flat object passes through");
}

{
  const r = redactSensitiveFields({ username: "bob", password: "s3cr3t!", role: "user" });
  assert(r.password === REDACTED_SENTINEL, "exact: password redacted");
  assert(r.username === "bob", "exact: non-sensitive sibling preserved");
}

{
  const r = redactSensitiveFields({ id: 1, password_hash: "$2b$12$hashedvalue", email: "x@y.com" });
  assert(r.password_hash === REDACTED_SENTINEL, "exact: password_hash redacted");
  assert(r.email === "x@y.com", "exact: email preserved");
}

{
  const r = redactSensitiveFields({ id: 7, mfa_secret: "TOTP_BASE32_SECRET" });
  assert(r.mfa_secret === REDACTED_SENTINEL, "exact: mfa_secret redacted");
  assert(r.id === 7, "exact: id preserved");
}

{
  const r = redactSensitiveFields({
    access_token: "eyJhbGciOiJIUzI1NiJ9",
    refresh_token: "rt_xyzabc",
    zoho_refresh_token: "zoho_rt_secret",
  });
  assert(r.access_token === REDACTED_SENTINEL, "suffix _token: access_token redacted");
  assert(r.refresh_token === REDACTED_SENTINEL, "suffix _token: refresh_token redacted");
  assert(r.zoho_refresh_token === REDACTED_SENTINEL, "suffix _token: zoho_refresh_token redacted");
}

{
  const r = redactSensitiveFields({ api_key: "sk-abc123", openai_api_key: "sk-openai" });
  assert(r.api_key === REDACTED_SENTINEL, "suffix _key: api_key redacted");
  assert(r.openai_api_key === REDACTED_SENTINEL, "suffix _key: openai_api_key redacted");
}

{
  const r = redactSensitiveFields({ client_secret: "cs_live_xyz", client_id: "cid_123" });
  assert(r.client_secret === REDACTED_SENTINEL, "suffix _secret: client_secret redacted");
  assert(r.client_id === "cid_123", "suffix _secret: client_id preserved");
}

{
  const r = redactSensitiveFields({ value: "abc", value_hash: "sha256hex" });
  assert(r.value_hash === REDACTED_SENTINEL, "suffix _hash: value_hash redacted");
  assert(r.value === "abc", "suffix _hash: value preserved");
}

// Prefix mfa_ is intentionally broad: any key starting with mfa_ is treated
// as sensitive (deny-by-default for the auth surface), including mfa_enabled.
{
  const r = redactSensitiveFields({
    mfa_code: "123456",
    mfa_token: "otptoken",
    mfa_enabled: true,
    role: "user",
  });
  assert(r.mfa_code === REDACTED_SENTINEL, "prefix mfa_: mfa_code redacted");
  assert(r.mfa_token === REDACTED_SENTINEL, "prefix mfa_: mfa_token redacted");
  assert(r.mfa_enabled === REDACTED_SENTINEL, "prefix mfa_: mfa_enabled also redacted");
  assert(r.role === "user", "prefix mfa_: non-mfa field preserved");
}

{
  const r = redactSensitiveFields({
    user: { email: "a@b.com", password_hash: "$2b$12$xyz", mfa_secret: "secret" },
    meta: { module: "auth" },
  });
  assert(r.user.password_hash === REDACTED_SENTINEL, "nested: password_hash redacted");
  assert(r.user.mfa_secret === REDACTED_SENTINEL, "nested: mfa_secret redacted");
  assert(r.user.email === "a@b.com", "nested: email preserved");
  assert(r.meta.module === "auth", "nested: meta.module preserved");
}

{
  const r = redactSensitiveFields([
    { id: 1, password: "plain" },
    { id: 2, name: "safe" },
  ]);
  assert(r[0].password === REDACTED_SENTINEL, "array element: password redacted");
  assert(r[1].name === "safe", "array element: non-sensitive preserved");
}

assert(
  redactSensitiveFields("$2b$12$hashedvalue", "password_hash") === REDACTED_SENTINEL,
  "fieldName: password_hash plain string redacted",
);
assert(
  redactSensitiveFields("TOTP_BASE32", "mfa_secret") === REDACTED_SENTINEL,
  "fieldName: mfa_secret plain string redacted",
);
assert(
  redactSensitiveFields("eyJhb", "access_token") === REDACTED_SENTINEL,
  "fieldName: access_token plain string redacted",
);
assert(
  redactSensitiveFields("alice", "full_name") === "alice",
  "fieldName: full_name preserved",
);
assert(
  redactSensitiveFields("active", "status") === "active",
  "fieldName: status preserved",
);

{
  const r = redactSensitiveFields({ PASSWORD: "secret", Password_Hash: "hash", API_KEY: "key" });
  assert(r.PASSWORD === REDACTED_SENTINEL, "case: UPPERCASE PASSWORD redacted");
  assert(r.Password_Hash === REDACTED_SENTINEL, "case: MixedCase Password_Hash redacted");
  assert(r.API_KEY === REDACTED_SENTINEL, "case: UPPERCASE API_KEY redacted");
}

const REQUIRED_DENY_KEYS = [
  "password_hash",
  "mfa_secret",
  "access_token",
  "refresh_token",
  "api_key",
];
for (const key of REQUIRED_DENY_KEYS) {
  assert(isSensitiveField(key), `isSensitiveField: '${key}' is on the deny list`);
}
assert(!isSensitiveField("email"), "isSensitiveField: 'email' is NOT sensitive");
assert(!isSensitiveField("full_name"), "isSensitiveField: 'full_name' is NOT sensitive");

// Section 2 — logEvent write-path integration test (the CI gate).

console.log("\n=== logEvent — write-path integration test ===\n");

const SECRETS = {
  password_hash: "$2b$12$abcdefghij1234567890uvwxyz.ABCDEFGH_IJ",
  plain_password: "MyS3cretP@ssword!",
  mfa_secret: "JBSWY3DPEHPK3PXP",
  access_token: "ya29.a0AfH6SMBxxxxAccessTokenVALUE",
  refresh_token: "1//0gREFRESHTOKENvalueXYZ",
  api_key: "sk-PLAINTEXTAPIKEY1234567890",
  bot_token: "xoxb-PLAINTEXTSLACKBOTTOKEN",
  client_secret: "cs_live_PLAINTEXTCLIENTSECRET",
} as const;

function findInsertCallParams(): unknown[] | null {
  const insertCall = captured.find((c) =>
    c.sql.replace(/\s+/g, " ").trim().toUpperCase().startsWith("INSERT INTO EVENT_LOGS"),
  );
  return insertCall ? insertCall.params : null;
}

async function runWritePathTest(
  name: string,
  input: EventLogInput,
  expectAbsent: string[],
): Promise<void> {
  captured.length = 0;
  await logEvent(input);

  const params = findInsertCallParams();
  assert(params !== null, `${name}: pool.query was called with INSERT INTO event_logs`);
  if (!params) return;

  const oldValueJson = params[9] as string | null;
  const newValueJson = params[10] as string | null;
  const combined = `${oldValueJson ?? ""}${newValueJson ?? ""}`;

  for (const secret of expectAbsent) {
    assert(
      !combined.includes(secret),
      `${name}: raw secret "${secret.substring(0, 18)}…" is NOT present in INSERT params`,
    );
  }

  if (input.oldValue || input.newValue) {
    assert(
      combined.includes(REDACTED_SENTINEL),
      `${name}: REDACTED sentinel IS present in INSERT params`,
    );
  }
}

await runWritePathTest(
  "password change",
  {
    actionType: "UPDATE",
    entityType: "USER",
    entityId: "42",
    entityName: "Alice Smith",
    description: "User password updated",
    severity: "WARNING",
    module: "auth",
    oldValue: {
      id: 42,
      email: "alice@example.com",
      full_name: "Alice Smith",
      password_hash: SECRETS.password_hash,
      mfa_secret: SECRETS.mfa_secret,
      role: "department_viewer",
    },
    newValue: {
      id: 42,
      email: "alice@example.com",
      full_name: "Alice Smith",
      password_hash: SECRETS.password_hash,
      mfa_secret: SECRETS.mfa_secret,
      role: "department_viewer",
      updated_at: "2026-04-24T00:00:00Z",
    },
  },
  [SECRETS.password_hash, "$2b$12$", SECRETS.plain_password, SECRETS.mfa_secret],
);

await runWritePathTest(
  "OAuth integration token rotation",
  {
    actionType: "UPDATE",
    entityType: "USER",
    entityId: "99",
    description: "OAuth tokens rotated",
    severity: "INFO",
    module: "integrations",
    newValue: {
      provider: "zoho",
      access_token: SECRETS.access_token,
      refresh_token: SECRETS.refresh_token,
      api_key: SECRETS.api_key,
      bot_token: SECRETS.bot_token,
      client_secret: SECRETS.client_secret,
      account_id: "acct-public-123",
    },
  },
  [
    SECRETS.access_token,
    SECRETS.refresh_token,
    SECRETS.api_key,
    SECRETS.bot_token,
    SECRETS.client_secret,
  ],
);

await runWritePathTest(
  "nested-secret payload",
  {
    actionType: "CREATE",
    entityType: "SYSTEM",
    description: "Nested OAuth credentials persisted",
    severity: "INFO",
    module: "integrations",
    newValue: {
      integration: "slack",
      config: {
        bot_token: SECRETS.bot_token,
        api_key: SECRETS.api_key,
        nested: {
          access_token: SECRETS.access_token,
          refresh_token: SECRETS.refresh_token,
        },
      },
      installed_at: "2026-04-24T00:00:00Z",
    },
  },
  [
    SECRETS.bot_token,
    SECRETS.api_key,
    SECRETS.access_token,
    SECRETS.refresh_token,
  ],
);

// Non-sensitive fields must survive verbatim, proving the test isn't a
// tautology that would also pass against a broken redactor.
{
  captured.length = 0;
  await logEvent({
    actionType: "UPDATE",
    entityType: "USER",
    entityId: "100",
    description: "Non-sensitive profile update",
    severity: "INFO",
    module: "users",
    newValue: { id: 100, email: "bob@example.com", account_id: "acct-public-XYZ" },
  });
  const params = findInsertCallParams();
  assert(params !== null, "non-sensitive: pool.query was called");
  if (params) {
    const json = String(params[10] ?? "");
    assert(
      json.includes("acct-public-XYZ"),
      "non-sensitive: account_id is preserved verbatim (test isn't a tautology)",
    );
    assert(
      json.includes("bob@example.com"),
      "non-sensitive: email is preserved verbatim",
    );
  }
}

console.log();
console.log(`Results: ${passed} passed, ${failed} failed`);

await pool.end();

if (failed > 0) {
  console.error(
    "\n❌ redactSensitiveFields tests FAILED — secrets may leak into event_logs.",
  );
  process.exit(1);
}

console.log("\n✅ All redactSensitiveFields tests passed");
process.exit(0);
