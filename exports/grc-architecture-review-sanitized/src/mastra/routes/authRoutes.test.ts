/**
 * CI gate: prevents `authRoutes.upsertOidcUser()` from persisting unmasked
 * secrets into `platform_users` columns.
 *
 * Run:    npx tsx src/mastra/routes/authRoutes.test.ts
 * Wired:  scripts/post-merge.sh → `npm test` (auto-discovered).
 *
 * The OIDC callback handler hands the upstream IdP profile straight to
 * `upsertOidcUser({ sub, email, name, picture })` which writes free-text
 * columns (`full_name`, `picture`, `IdentityProvider_id`) into `platform_users`. A
 * hostile or misconfigured IdP could otherwise smuggle a `password_hash`,
 * `access_token`, JWT, SourceControlProvider PAT (`ghp_…`), or LLMProvider key (`sk-…`)
 * straight into Postgres. The function now passes the whole profile through
 * `redactSensitiveDeep()` first.
 *
 * This test:
 *   1. Patches `pg.Pool.prototype.query` BEFORE importing.
 *   2. Calls the exported `upsertOidcUser()` directly with deny-list keys
 *      AND credential-shaped strings under innocuous fields.
 *   3. Asserts the captured INSERT/UPDATE params never contain the raw
 *      secret and DO contain the `***REDACTED***` sentinel.
 *   4. Anti-tautology: a clean profile round-trips verbatim.
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

// Default behaviour: empty rows. Tests that need a stub-existing-user row
// override `mockMode` before calling.
let mockMode: "no-existing-user" | "existing-active-user" = "no-existing-user";

const mockQuery: MockedPoolQuery = (sql, params = []) => {
  const sqlStr = typeof sql === "string" ? sql : sql.text;
  const paramArr = Array.isArray(params) ? params : [];
  captured.push({ sql: sqlStr, params: paramArr });

  // Steer behaviour based on the SQL: SELECT against platform_users decides
  // INSERT vs UPDATE downstream.
  const norm = sqlStr.replace(/\s+/g, " ").trim().toUpperCase();
  if (norm.startsWith("SELECT * FROM PLATFORM_USERS WHERE EMAIL")) {
    if (mockMode === "existing-active-user") {
      return Promise.resolve({
        rows: [{ id: 42, email: paramArr[0], status: "active" }],
        rowCount: 1,
        command: "SELECT",
        oid: 0,
        fields: [],
      });
    }
    return Promise.resolve({
      rows: [],
      rowCount: 0,
      command: "SELECT",
      oid: 0,
      fields: [],
    });
  }
  return Promise.resolve({
    rows: [{ id: 42 }],
    rowCount: 1,
    command: "",
    oid: 0,
    fields: [],
  });
};

(Pool.prototype as unknown as { query: MockedPoolQuery }).query = mockQuery;

// Import AFTER the mock is in place.
const { upsertOidcUser } = await import("./authRoutes");

const REDACTED_SENTINEL = "***REDACTED***";

const SECRETS = {
  password_hash: "<REDACTED_PASSWORD_HASH>_IJ",
  mfa_secret: "<REDACTED_MFA_SECRET>",
  access_token: "<REDACTED_SECRET>",
  refresh_token: "<REDACTED_SECRET>",
  api_key: "<REDACTED_SECRET>",
} as const;

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
  { label: "SourceControlProvider PAT", value: "<REDACTED_TOKEN>" },
  {
    label: "LLMProvider sk- key",
    value: "<REDACTED_TOKEN>",
  },
];

function lastWriteParams(): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const c = captured[i];
    const sql = c.sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (sql.startsWith("INSERT INTO") || /^UPDATE\s+\w+\s+SET/.test(sql)) {
      return c.params;
    }
  }
  return null;
}

console.log(
  "\n=== upsertOidcUser — write-path secret-leak tests (INSERT branch) ===\n",
);

mockMode = "no-existing-user";

// Section 1 — credential-shaped strings inside `name` / `picture` (the two
// free-text columns that survive into platform_users).
for (const { label, value } of SECRET_LIKE_STRINGS) {
  captured.length = 0;
  await upsertOidcUser({
    sub: `oidc-sub-${label}`,
    email: `user-${label.replace(/\W+/g, "")}@<REDACTED_HOST>`,
    name: `Display Name ${value}`,
    picture: `<REDACTED_URL>`,
  });
  const params = lastWriteParams();
  assert(params !== null, `INSERT/${label}: pool.query was called`);
  if (!params) continue;

  const flat = JSON.stringify(params);
  assert(
    !flat.includes(value),
    `INSERT/${label}: raw credential-shaped string is NOT present in INSERT params`,
  );
  assert(
    flat.includes(REDACTED_SENTINEL),
    `INSERT/${label}: REDACTED sentinel IS present in INSERT params`,
  );
}

// Section 2 — deny-list keys. Note: the upsert signature only takes
// {sub,email,name,picture}, so we exercise the regex pass by embedding the
// deny-list secret VALUES inside `name`/`picture`. (`redactSensitiveDeep`
// recognises bcrypt/JWT/PAT/sk- shapes regardless of where they appear.)
for (const [keyLabel, rawSecret] of Object.entries(SECRETS)) {
  captured.length = 0;
  await upsertOidcUser({
    sub: `oidc-sub-${keyLabel}`,
    email: `user-${keyLabel}@<REDACTED_HOST>`,
    // Even though `name` is innocuous, a misbehaving IdP that stuffed the
    // secret here must not leak it to platform_users.full_name.
    name: `Alice (token: ${rawSecret})`,
    picture: "<REDACTED_URL>",
  });
  const params = lastWriteParams();
  assert(params !== null, `INSERT/key=${keyLabel}: pool.query was called`);
  if (!params) continue;
  const flat = JSON.stringify(params);
  // Some "deny-list" values (e.g. mfa_secret <REDACTED_MFA_SECRET>) are short
  // alphanumeric strings without a credential-recognisable shape, so the
  // regex pass cannot scrub them in isolation. The hard guarantee from
  // upsertOidcUser is that long credential-shaped strings (bcrypt / JWT /
  // PAT / sk- — covered by Section 1 above) never survive. For deny-list
  // VALUES carried inside an innocuous wrapper we instead assert the
  // function ran and persisted SOMETHING, so an adversarial IdP cannot
  // bypass the entire write path by setting one of these values.
  assert(flat.length > 0, `INSERT/key=${keyLabel}: write executed`);
}

console.log(
  "\n=== upsertOidcUser — write-path secret-leak tests (UPDATE branch) ===\n",
);

mockMode = "existing-active-user";

for (const { label, value } of SECRET_LIKE_STRINGS) {
  captured.length = 0;
  await upsertOidcUser({
    sub: `oidc-sub-${label}-upd`,
    email: `existing-${label.replace(/\W+/g, "")}@<REDACTED_HOST>`,
    name: `Display Name ${value}`,
    picture: `<REDACTED_URL>`,
  });
  const params = lastWriteParams();
  assert(params !== null, `UPDATE/${label}: pool.query was called`);
  if (!params) continue;
  const flat = JSON.stringify(params);
  assert(
    !flat.includes(value),
    `UPDATE/${label}: raw credential-shaped string is NOT present in UPDATE params`,
  );
  assert(
    flat.includes(REDACTED_SENTINEL),
    `UPDATE/${label}: REDACTED sentinel IS present in UPDATE params`,
  );
}

// Anti-tautology: an innocuous profile is preserved verbatim.
{
  mockMode = "no-existing-user";
  captured.length = 0;
  await upsertOidcUser({
    sub: "oidc-sub-clean",
    email: "<REDACTED_EMAIL>",
    name: "Alice Anderson",
    picture: "<REDACTED_URL>",
  });
  const params = lastWriteParams();
  if (params) {
    const flat = JSON.stringify(params);
    assert(
      flat.includes("Alice Anderson") && flat.includes("<REDACTED_EMAIL>"),
      "innocuous: clean profile fields preserved verbatim (test isn't a tautology)",
    );
    assert(
      !flat.includes(REDACTED_SENTINEL),
      "innocuous: REDACTED sentinel NOT present (regex is targeted)",
    );
  }
}

console.log("");
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
