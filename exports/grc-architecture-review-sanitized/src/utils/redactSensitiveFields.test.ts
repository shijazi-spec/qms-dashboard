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
  redactSecretLikeStrings,
  deepRedactSecretLikeStrings,
  REDACTED_SENTINEL,
  isSensitiveField,
  pool,
  logEvent,
} = await import("./eventLogsDatabase");
type EventLogInput = Parameters<typeof logEvent>[0];

const { logNCChange, logCAPAChange } = await import("./changeHistoryDatabase");

// Section 1 — redactSensitiveFields unit tests

console.log("\n=== redactSensitiveFields — unit tests ===\n");

assert(redactSensitiveFields(null) === null, "null returned unchanged");
assert(redactSensitiveFields(undefined) === undefined, "undefined returned unchanged");

{
  const input = { username: "alice", email: "<REDACTED_EMAIL>", role: "admin" };
  assertDeepEqual(redactSensitiveFields(input), input, "non-sensitive flat object passes through");
}

{
  const r = redactSensitiveFields({ username: "bob", password: "<REDACTED_SECRET>", role: "user" });
  assert(r.password === REDACTED_SENTINEL, "exact: password redacted");
  assert(r.username === "bob", "exact: non-sensitive sibling preserved");
}

{
  const r = redactSensitiveFields({ id: 1, password_hash: "$2b$12$hashedvalue", email: "<REDACTED_EMAIL>" });
  assert(r.password_hash === REDACTED_SENTINEL, "exact: password_hash redacted");
  assert(r.email === "<REDACTED_EMAIL>", "exact: email preserved");
}

{
  const r = redactSensitiveFields({ id: 7, mfa_secret: "TOTP_BASE32_SECRET" });
  assert(r.mfa_secret === REDACTED_SENTINEL, "exact: mfa_secret redacted");
  assert(r.id === 7, "exact: id preserved");
}

{
  const r = redactSensitiveFields({
    access_token: "<REDACTED_SECRET>",
    refresh_token: "<REDACTED_SECRET>",
    CRMProvider_refresh_token: "CRMProvider_rt_secret",
  });
  assert(r.access_token === REDACTED_SENTINEL, "suffix _token: access_token redacted");
  assert(r.refresh_token === REDACTED_SENTINEL, "suffix _token: refresh_token redacted");
  assert(r.CRMProvider_refresh_token === REDACTED_SENTINEL, "suffix _token: CRMProvider_refresh_token redacted");
}

{
  const r = redactSensitiveFields({ api_key: "<REDACTED_SECRET>", LLMProvider_api_key: "<REDACTED_TOKEN>" });
  assert(r.api_key === REDACTED_SENTINEL, "suffix _key: api_key redacted");
  assert(r.LLMProvider_api_key === REDACTED_SENTINEL, "suffix _key: LLMProvider_api_key redacted");
}

{
  const r = redactSensitiveFields({ client_secret: "<REDACTED_SECRET>", client_id: "cid_123" });
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
    user: { email: "<REDACTED_EMAIL>", password_hash: "$2b$12$xyz", mfa_secret: "secret" },
    meta: { module: "auth" },
  });
  assert(r.user.password_hash === REDACTED_SENTINEL, "nested: password_hash redacted");
  assert(r.user.mfa_secret === REDACTED_SENTINEL, "nested: mfa_secret redacted");
  assert(r.user.email === "<REDACTED_EMAIL>", "nested: email preserved");
  assert(r.meta.module === "auth", "nested: meta.module preserved");
}

{
  const r = redactSensitiveFields([
    { id: 1, password: "<REDACTED_SECRET>" },
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
  const r = redactSensitiveFields({ PASSWORD: "<REDACTED_SECRET>", Password_Hash: "hash", API_KEY: "<REDACTED_SECRET>" });
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

// Section 1b — redactSecretLikeStrings / deepRedactSecretLikeStrings unit tests
//
// Task #84: ensure regex scrubber catches sk_, ghp_, eyJ, bcrypt patterns and
// is applied recursively to string leaves so audit-log free-text never leaks
// freshly-rotated credentials.

console.log("\n=== redactSecretLikeStrings — unit tests ===\n");

assert(redactSecretLikeStrings(null) === null, "regex: null returned unchanged");
assert(redactSecretLikeStrings(undefined) === undefined, "regex: undefined returned unchanged");
assert(redactSecretLikeStrings(42) === 42, "regex: non-string primitive returned unchanged");
assert(redactSecretLikeStrings("") === "", "regex: empty string returned unchanged");

{
  const out = redactSecretLikeStrings(
    "PaymentProvider key <REDACTED_TOKEN> rotated",
  ) as string;
  assert(!out.includes("<REDACTED_TOKEN>"), "regex: sk_live_ key scrubbed");
  assert(out.includes(REDACTED_SENTINEL), "regex: sentinel inserted in place of sk_ key");
}

{
  const out = redactSecretLikeStrings(
    "SourceControlProvider PAT <REDACTED_TOKEN> leaked",
  ) as string;
  assert(
    !out.includes("<REDACTED_TOKEN>"),
    "regex: ghp_ token scrubbed",
  );
  assert(out.includes(REDACTED_SENTINEL), "regex: sentinel inserted in place of ghp_ token");
}

{
  const jwt =
    "<REDACTED_TOKEN>";
  const out = redactSecretLikeStrings(`Bearer issued: ${jwt}`) as string;
  assert(!out.includes(jwt), "regex: JWT scrubbed (eyJ pattern)");
  assert(out.includes(REDACTED_SENTINEL), "regex: sentinel inserted in place of JWT");
}

{
  const bcrypt = "$2b$12$abcdefghijABCDEFGHIJ12./uVwXyZaBcDeFgHiJkLmNoPqRsTuVwXy";
  const out = redactSecretLikeStrings(`hash=${bcrypt}`) as string;
  assert(!out.includes(bcrypt), "regex: bcrypt hash scrubbed");
  assert(out.includes(REDACTED_SENTINEL), "regex: sentinel inserted in place of bcrypt");
}

{
  // Boring prose with no credentials must pass through unchanged so the
  // scrubber doesn't false-positive on ordinary audit descriptions.
  const safe = "User Alice updated project ID 42 (status=active)";
  assert(redactSecretLikeStrings(safe) === safe, "regex: ordinary prose untouched");
}

console.log("\n=== deepRedactSecretLikeStrings — unit tests ===\n");

{
  const out = deepRedactSecretLikeStrings({
    note: "rotated key <REDACTED_TOKEN> today",
    nested: {
      summary: "Bearer <REDACTED_TOKEN>",
      list: ["safe value", "<REDACTED_TOKEN>"],
    },
    count: 7,
    enabled: true,
  });
  assert(
    !JSON.stringify(out).includes("<REDACTED_TOKEN>"),
    "deep: top-level string leaf scrubbed",
  );
  assert(
    !JSON.stringify(out).includes("<REDACTED_TOKEN>"),
    "deep: nested object string leaf scrubbed",
  );
  assert(
    !JSON.stringify(out).includes("<REDACTED_TOKEN>"),
    "deep: array string element scrubbed",
  );
  assert(out.count === 7, "deep: numeric leaf preserved");
  assert(out.enabled === true, "deep: boolean leaf preserved");
  assert(out.nested.list[0] === "safe value", "deep: non-secret string preserved");
}

// Section 2 — logEvent write-path integration test (the CI gate).

console.log("\n=== logEvent — write-path integration test ===\n");

const SECRETS = {
  password_hash: "$2b$12$abcdefghij1234567890uvwxyz.ABCDEFGH_IJ",
  plain_password: "MyS3cretP@ssword!",
  mfa_secret: "JBSWY3DPEHPK3PXP",
  access_token: "<REDACTED_SECRET>",
  refresh_token: "<REDACTED_SECRET>",
  api_key: "<REDACTED_SECRET>",
  bot_token: "<REDACTED_TOKEN>",
  client_secret: "<REDACTED_SECRET>",
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
      email: "<REDACTED_EMAIL>",
      full_name: "Sample User",
      password_hash: SECRETS.password_hash,
      mfa_secret: SECRETS.mfa_secret,
      role: "department_viewer",
    },
    newValue: {
      id: 42,
      email: "<REDACTED_EMAIL>",
      full_name: "Sample User",
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
      provider: "CRMProvider",
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
      integration: "ChatProvider",
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
    newValue: { id: 100, email: "<REDACTED_EMAIL>", account_id: "acct-public-XYZ" },
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
      json.includes("<REDACTED_EMAIL>"),
      "non-sensitive: email is preserved verbatim",
    );
  }
}

// Section 3 — Task #84: free-text TEXT columns must be regex-scrubbed.
//
// description and entity_name are populated by callers that interpolate
// runtime data into a human-readable summary.  redactSensitiveFields() is
// key-based and cannot see inside a string, so a freshly-rotated key
// embedded in a description would otherwise leak through the events viewer
// and any audit export.

console.log("\n=== Task #84 — TEXT column + JSON-leaf scrubbing ===\n");

const TEXT_LEAK_SECRETS = {
  sk: "<REDACTED_TOKEN>",
  ghp: "<REDACTED_TOKEN>",
  jwt:
    "<REDACTED_TOKEN>",
  bcrypt: "$2b$12$abcdefghijABCDEFGHIJ12./uVwXyZaBcDeFgHiJkLmNoPqRsTuVwXy",
} as const;

{
  captured.length = 0;
  await logEvent({
    actionType: "UPDATE",
    entityType: "SYSTEM",
    entityId: "PaymentProvider-config",
    entityName: `PaymentProvider key ${TEXT_LEAK_SECRETS.sk}`,
    description: `Rotated PaymentProvider live key to ${TEXT_LEAK_SECRETS.sk} for finance team`,
    severity: "WARNING",
    module: "integrations",
  });
  const params = findInsertCallParams();
  assert(params !== null, "task-84 description: pool.query was called");
  if (params) {
    const entityName = String(params[7] ?? "");
    const description = String(params[8] ?? "");
    assert(
      !entityName.includes(TEXT_LEAK_SECRETS.sk),
      "task-84: sk_live_ in entity_name is scrubbed before INSERT",
    );
    assert(
      !description.includes(TEXT_LEAK_SECRETS.sk),
      "task-84: sk_live_ in description is scrubbed before INSERT",
    );
    assert(
      description.includes(REDACTED_SENTINEL),
      "task-84: REDACTED sentinel present in description",
    );
    assert(
      entityName.includes(REDACTED_SENTINEL),
      "task-84: REDACTED sentinel present in entity_name",
    );
    assert(
      description.includes("Rotated PaymentProvider live key"),
      "task-84: surrounding prose preserved in description",
    );
  }
}

{
  captured.length = 0;
  await logEvent({
    actionType: "CREATE",
    entityType: "SYSTEM",
    entityName: `SourceControlProvider PAT issued: ${TEXT_LEAK_SECRETS.ghp}`,
    description: `JWT minted: ${TEXT_LEAK_SECRETS.jwt}`,
    severity: "INFO",
    module: "auth",
  });
  const params = findInsertCallParams();
  assert(params !== null, "task-84 ghp+jwt: pool.query was called");
  if (params) {
    const entityName = String(params[7] ?? "");
    const description = String(params[8] ?? "");
    assert(
      !entityName.includes(TEXT_LEAK_SECRETS.ghp),
      "task-84: ghp_ token in entity_name is scrubbed",
    );
    assert(
      !description.includes(TEXT_LEAK_SECRETS.jwt),
      "task-84: JWT (eyJ pattern) in description is scrubbed",
    );
  }
}

{
  // The KEY-based redactor would NOT mask `summary` / `note` because they
  // aren't on the deny list.  This case proves that the deep regex scrubber
  // catches secrets that callers stuff into innocuously-named JSON fields.
  captured.length = 0;
  await logEvent({
    actionType: "UPDATE",
    entityType: "SYSTEM",
    description: "Integration sync run",
    severity: "INFO",
    module: "integrations",
    oldValue: {
      summary: `previous key was ${TEXT_LEAK_SECRETS.sk}`,
      note: `bcrypt of legacy admin: ${TEXT_LEAK_SECRETS.bcrypt}`,
    },
    newValue: {
      provider: "SourceControlProvider",
      headers: {
        authorization: `Bearer ${TEXT_LEAK_SECRETS.jwt}`,
      },
      audit_trail: [
        `issued ghp_${TEXT_LEAK_SECRETS.ghp.slice(4)} for octocat`,
        "no further changes",
      ],
      account_id: "acct-public-ZZZ",
    },
  });
  const params = findInsertCallParams();
  assert(params !== null, "task-84 deep JSON: pool.query was called");
  if (params) {
    const oldJson = String(params[9] ?? "");
    const newJson = String(params[10] ?? "");
    const combined = `${oldJson}${newJson}`;
    assert(
      !combined.includes(TEXT_LEAK_SECRETS.sk),
      "task-84 deep: sk_live_ buried in `summary` JSON leaf is scrubbed",
    );
    assert(
      !combined.includes(TEXT_LEAK_SECRETS.bcrypt),
      "task-84 deep: bcrypt buried in `note` JSON leaf is scrubbed",
    );
    assert(
      !combined.includes(TEXT_LEAK_SECRETS.jwt),
      "task-84 deep: JWT buried in nested headers.authorization JSON leaf is scrubbed",
    );
    assert(
      !combined.includes(TEXT_LEAK_SECRETS.ghp),
      "task-84 deep: ghp_ buried in audit_trail array element is scrubbed",
    );
    assert(
      newJson.includes("acct-public-ZZZ"),
      "task-84 deep: non-secret JSON leaf preserved (not a tautology)",
    );
    assert(
      combined.includes(REDACTED_SENTINEL),
      "task-84 deep: REDACTED sentinel present in JSON column",
    );
  }
}

// Task #302 — make the regex pass on event_logs JSONB explicit for the exact
// payload shapes called out in the task description: a caller that puts a
// credential into `newValue.note` or `newValue.curl_example` (innocuous
// field names that the key-based deny-list cannot see through) must still
// have the secret scrubbed by `deepRedactSecretLikeStrings`.

{
  captured.length = 0;
  await logEvent({
    actionType: "UPDATE",
    entityType: "SYSTEM",
    entityId: "PaymentProvider-webhook",
    description: "webhook reconfigured",
    severity: "INFO",
    module: "integrations",
    newValue: {
      note: `key=${TEXT_LEAK_SECRETS.sk}`,
      curl_example:
        `curl -H 'Authorization: Bearer ${TEXT_LEAK_SECRETS.sk}' <REDACTED_URL>`,
      provider: "PaymentProvider",
    },
  });
  const params = findInsertCallParams();
  assert(params !== null, "task-302: pool.query was called");
  if (params) {
    const newJson = String(params[10] ?? "");
    assert(
      !newJson.includes(TEXT_LEAK_SECRETS.sk),
      "task-302: sk_ key in newValue.note is scrubbed by deepRedactSecretLikeStrings",
    );
    assert(
      newJson.includes(REDACTED_SENTINEL),
      "task-302: REDACTED sentinel present in newValue JSONB column",
    );
    assert(
      newJson.includes("PaymentProvider"),
      "task-302: non-secret sibling field 'provider' preserved verbatim",
    );
    assert(
      newJson.includes("curl -H"),
      "task-302: surrounding curl_example prose preserved",
    );
  }
}

{
  // Same shape but on the oldValue side, since both safeOldValue and
  // safeNewValue must be scrubbed identically per the task's done-criteria.
  captured.length = 0;
  await logEvent({
    actionType: "UPDATE",
    entityType: "SYSTEM",
    entityId: "PaymentProvider-webhook",
    description: "webhook reconfigured",
    severity: "INFO",
    module: "integrations",
    oldValue: {
      note: `key=${TEXT_LEAK_SECRETS.sk}`,
      curl_example:
        `curl -H 'Authorization: Bearer ${TEXT_LEAK_SECRETS.sk}' <REDACTED_URL>`,
      provider: "PaymentProvider",
    },
  });
  const params = findInsertCallParams();
  assert(params !== null, "task-302 oldValue: pool.query was called");
  if (params) {
    const oldJson = String(params[9] ?? "");
    assert(
      !oldJson.includes(TEXT_LEAK_SECRETS.sk),
      "task-302: sk_ key in oldValue.note is scrubbed by deepRedactSecretLikeStrings",
    );
    assert(
      oldJson.includes(REDACTED_SENTINEL),
      "task-302: REDACTED sentinel present in oldValue JSONB column",
    );
  }
}

// Section 4 — Task #99: NC and CAPA change history write-path tests.
//
// logNCChange / logCAPAChange must apply redactSecretLikeStrings to
// old_value, new_value, and change_reason before INSERT so that a caller
// who interpolates a freshly-rotated credential into any of those columns
// never leaks the raw secret into the change-history viewer or exports.

console.log("\n=== Task #99 — NC / CAPA change history write-path tests ===\n");

const CH_SECRETS = {
  sk: "<REDACTED_TOKEN>",
  ghp: "<REDACTED_TOKEN>",
  jwt:
    "<REDACTED_TOKEN>",
  bcrypt: "$2b$12$abcdefghijABCDEFGHIJ12./uVwXyZaBcDeFgHiJkLmNoPqRsTuVwXy",
} as const;

function findInsertForTable(table: string): unknown[] | null {
  const insertCall = captured.find((c) =>
    c.sql.replace(/\s+/g, " ").trim().toUpperCase().startsWith(`INSERT INTO ${table.toUpperCase()}`),
  );
  return insertCall ? insertCall.params : null;
}

// NC — sk_ in old_value, ghp_ in new_value, bcrypt in change_reason

{
  captured.length = 0;
  await logNCChange(
    1,
    "api_integration_key",
    `previously sk_live_ was ${CH_SECRETS.sk}`,
    `rotated to ghp_${CH_SECRETS.ghp.slice(4)}`,
    "admin",
    `bcrypt of old key: ${CH_SECRETS.bcrypt}`,
  );
  const params = findInsertForTable("nc_change_history");
  assert(params !== null, "NC sk+ghp+bcrypt: pool.query called for nc_change_history INSERT");
  if (params) {
    const oldVal = String(params[2] ?? "");
    const newVal = String(params[3] ?? "");
    const reason = String(params[5] ?? "");
    assert(!oldVal.includes(CH_SECRETS.sk), "NC: sk_live_ in old_value is scrubbed");
    assert(!newVal.includes(CH_SECRETS.ghp), "NC: ghp_ in new_value is scrubbed");
    assert(!reason.includes(CH_SECRETS.bcrypt), "NC: bcrypt in change_reason is scrubbed");
    assert(
      oldVal.includes(REDACTED_SENTINEL) || newVal.includes(REDACTED_SENTINEL) || reason.includes(REDACTED_SENTINEL),
      "NC: REDACTED sentinel is present in at least one column",
    );
  }
}

// NC — JWT in change_reason
{
  captured.length = 0;
  await logNCChange(
    2,
    "session_token",
    "old-session",
    "new-session",
    "admin",
    `minted JWT: ${CH_SECRETS.jwt}`,
  );
  const params = findInsertForTable("nc_change_history");
  assert(params !== null, "NC JWT reason: pool.query called");
  if (params) {
    const reason = String(params[5] ?? "");
    assert(!reason.includes(CH_SECRETS.jwt), "NC: JWT in change_reason is scrubbed");
    assert(reason.includes(REDACTED_SENTINEL), "NC: REDACTED sentinel present in change_reason");
  }
}

// NC — non-sensitive values must pass through unchanged
{
  captured.length = 0;
  await logNCChange(7, "status", "open", "closed", "alice", "status updated by QA");
  const params = findInsertForTable("nc_change_history");
  assert(params !== null, "NC non-sensitive: pool.query called");
  if (params) {
    const oldVal = String(params[2] ?? "");
    const newVal = String(params[3] ?? "");
    const reason = String(params[5] ?? "");
    assert(oldVal === "open", "NC non-sensitive: old_value preserved verbatim");
    assert(newVal === "closed", "NC non-sensitive: new_value preserved verbatim");
    assert(reason === "status updated by QA", "NC non-sensitive: change_reason preserved verbatim");
  }
}

// CAPA — sk_ in old_value, ghp_ in new_value, bcrypt in change_reason
{
  captured.length = 0;
  await logCAPAChange(
    10,
    "webhook_secret",
    `old secret was ${CH_SECRETS.sk}`,
    `new token is ${CH_SECRETS.ghp}`,
    "sysadmin",
    `bcrypt verification: ${CH_SECRETS.bcrypt}`,
  );
  const params = findInsertForTable("capa_change_history");
  assert(params !== null, "CAPA sk+ghp+bcrypt: pool.query called for capa_change_history INSERT");
  if (params) {
    const oldVal = String(params[2] ?? "");
    const newVal = String(params[3] ?? "");
    const reason = String(params[5] ?? "");
    assert(!oldVal.includes(CH_SECRETS.sk), "CAPA: sk_live_ in old_value is scrubbed");
    assert(!newVal.includes(CH_SECRETS.ghp), "CAPA: ghp_ in new_value is scrubbed");
    assert(!reason.includes(CH_SECRETS.bcrypt), "CAPA: bcrypt in change_reason is scrubbed");
    assert(
      oldVal.includes(REDACTED_SENTINEL) || newVal.includes(REDACTED_SENTINEL) || reason.includes(REDACTED_SENTINEL),
      "CAPA: REDACTED sentinel is present in at least one column",
    );
  }
}

// CAPA — JWT in change_reason
{
  captured.length = 0;
  await logCAPAChange(
    11,
    "auth_token",
    "expired",
    "refreshed",
    "sysadmin",
    `issued JWT: ${CH_SECRETS.jwt}`,
  );
  const params = findInsertForTable("capa_change_history");
  assert(params !== null, "CAPA JWT reason: pool.query called");
  if (params) {
    const reason = String(params[5] ?? "");
    assert(!reason.includes(CH_SECRETS.jwt), "CAPA: JWT in change_reason is scrubbed");
    assert(reason.includes(REDACTED_SENTINEL), "CAPA: REDACTED sentinel present in change_reason");
  }
}

// CAPA — non-sensitive values must pass through unchanged
{
  captured.length = 0;
  await logCAPAChange(20, "priority", "low", "high", "bob", "escalated by manager");
  const params = findInsertForTable("capa_change_history");
  assert(params !== null, "CAPA non-sensitive: pool.query called");
  if (params) {
    const oldVal = String(params[2] ?? "");
    const newVal = String(params[3] ?? "");
    const reason = String(params[5] ?? "");
    assert(oldVal === "low", "CAPA non-sensitive: old_value preserved verbatim");
    assert(newVal === "high", "CAPA non-sensitive: new_value preserved verbatim");
    assert(reason === "escalated by manager", "CAPA non-sensitive: change_reason preserved verbatim");
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
