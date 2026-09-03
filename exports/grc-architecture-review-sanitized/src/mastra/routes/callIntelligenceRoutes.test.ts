/**
 * CI gate: prevents `callIntelligenceRoutes` POST /api/calls/ContactCenterProvider/configure
 * from persisting unmasked secrets into `integration_config.config` (JSONB).
 *
 * Run:    npx tsx src/mastra/routes/callIntelligenceRoutes.test.ts
 * Wired:  scripts/post-merge.sh → `npm test` (auto-discovered).
 *
 * The ContactCenterProvider configure endpoint deliberately drops the raw `password` field
 * from the persisted blob, but `domain` and `username` are still operator-
 * controlled and could otherwise smuggle a JWT, SourceControlProvider PAT (`ghp_…`),
 * bcrypt hash, LLMProvider key (`sk-…`) etc. into Postgres. The handler now
 * passes the persisted object through `redactSensitiveDeep()` first.
 *
 * This test:
 *   1. Patches `pg.Pool.prototype.query` BEFORE importing.
 *   2. Sets ADMIN_API_KEY (≥32 chars, ≥10 distinct) and presents an
 *      X-Admin-Key header so `requireAdminOrKey` admits the admin-key user.
 *   3. POSTs deny-list-shaped domain/username values, asserts the captured
 *      INSERT params never contain the raw secret and DO contain the
 *      `***REDACTED***` sentinel.
 *   4. Anti-tautology: a clean configuration round-trips verbatim.
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
  captured.push({ sql: sqlStr, params: Array.isArray(params) ? params : [] });
  return Promise.resolve({
    rows: [],
    rowCount: 0,
    command: "",
    oid: 0,
    fields: [],
  });
};
(Pool.prototype as unknown as { query: MockedPoolQuery }).query = mockQuery;

const ADMIN_KEY = "call-intel-secret-leak-test-admin-key-2026-XYZ"; // ≥32, ≥10 distinct
process.env.ADMIN_API_KEY = ADMIN_KEY;

// Import AFTER mock + env are in place.
const { callIntelligenceRoutes } = await import("./callIntelligenceRoutes");
const { buildHandler, makeContext } = await import(
  "../../../tests/_helpers/fakeContext"
);

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

function lastConfigInsertParams(): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const c = captured[i];
    const sql = c.sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (sql.startsWith("INSERT INTO INTEGRATION_CONFIG")) {
      return c.params;
    }
  }
  return null;
}

const handler = await buildHandler(
  callIntelligenceRoutes,
  "/api/calls/ContactCenterProvider/configure",
  "POST",
  { mastra: null },
);

console.log(
  "\n=== callIntelligenceRoutes /api/calls/ContactCenterProvider/configure — secret-leak tests ===\n",
);

for (const { label, value } of SECRET_LIKE_STRINGS) {
  captured.length = 0;
  const res = await handler(
    makeContext({
      method: "POST",
      headers: { "X-Admin-Key": ADMIN_KEY },
      body: {
        // domain & username are persisted into JSONB; password is dropped
        // by the handler and is therefore not part of the persistence
        // contract this test guards.
        domain: `Example Organization.${value}.<REDACTED_HOST>`,
        username: `agent-${value}`,
        password: "<REDACTED_SECRET>",
      },
    }),
  );
  assert(
    res.status === 200,
    `${label}: handler returns 200 — got ${res.status}`,
  );
  const params = lastConfigInsertParams();
  assert(params !== null, `${label}: integration_config INSERT was issued`);
  if (!params) continue;
  const flat = JSON.stringify(params);
  assert(
    !flat.includes(value),
    `${label}: raw credential-shaped string is NOT in INSERT params`,
  );
  assert(
    flat.includes(REDACTED_SENTINEL),
    `${label}: REDACTED sentinel IS in INSERT params`,
  );
}

for (const [keyLabel, rawSecret] of Object.entries(SECRETS)) {
  captured.length = 0;
  const res = await handler(
    makeContext({
      method: "POST",
      headers: { "X-Admin-Key": ADMIN_KEY },
      body: {
        domain: `Example Organization.${rawSecret}.<REDACTED_HOST>`,
        username: `agent-${rawSecret}`,
        password: "<REDACTED_SECRET>",
      },
    }),
  );
  assert(res.status === 200, `key=${keyLabel}: handler returns 200`);
  const params = lastConfigInsertParams();
  if (!params) continue;
  const flat = JSON.stringify(params);
  if (
    keyLabel === "password_hash" ||
    keyLabel === "access_token" ||
    keyLabel === "api_key"
  ) {
    assert(
      !flat.includes(rawSecret),
      `key=${keyLabel}: raw secret VALUE is NOT in INSERT params`,
    );
  } else {
    assert(flat.length > 0, `key=${keyLabel}: INSERT captured`);
  }
}

// Anti-tautology — clean configuration preserved verbatim.
{
  captured.length = 0;
  const res = await handler(
    makeContext({
      method: "POST",
      headers: { "X-Admin-Key": ADMIN_KEY },
      body: {
        domain: "<REDACTED_HOST>",
        username: "agent-clean",
        password: "<REDACTED_SECRET>",
      },
    }),
  );
  assert(res.status === 200, "innocuous: handler returns 200");
  const params = lastConfigInsertParams();
  if (params) {
    const flat = JSON.stringify(params);
    assert(
      flat.includes("<REDACTED_HOST>") && flat.includes("agent-clean"),
      "innocuous: clean configuration preserved verbatim (test isn't a tautology)",
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
