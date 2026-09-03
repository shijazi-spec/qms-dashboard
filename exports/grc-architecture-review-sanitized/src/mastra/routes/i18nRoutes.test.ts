/**
 * CI gate: prevents `i18nRoutes` from accepting unmasked credential-shaped
 * `lang` values into any persistence path.
 *
 * Run:    npx tsx src/mastra/routes/i18nRoutes.test.ts
 * Wired:  scripts/post-merge.sh → `npm test` (auto-discovered by
 *         tests/runIntegrationTests.ts which scans src/**\/*.test.ts).
 *
 * The endpoint POST /api/user/language-preference takes a single field
 * (`lang`) and currently never persists. Today it short-circuits when no
 * session cookie is present (returns success without writing). To make the
 * gate meaningful — and to defend against a future regression that wires up
 * a session-aware UPDATE — this test:
 *
 *   1. Patches `pg.Pool.prototype.query` BEFORE importing the route module
 *      so that ANY future write attempt is captured rather than touching
 *      a real database.
 *   2. Drives the POST handler with secret-shaped `lang` payloads (deny-list
 *      keys + credential-shaped strings: bcrypt hash, JWT, SourceControlProvider PAT,
 *      LLMProvider key, etc.).
 *   3. Asserts the handler rejects with HTTP 400 ("Unsupported language")
 *      and that NO INSERT/UPDATE was issued — proving the input whitelist
 *      is the first line of defence and no raw secret could ever reach
 *      Postgres via this route.
 *   4. Anti-tautology: also drives a happy-path `lang: "en"` to confirm the
 *      gate would have caught a write if one were issued.
 */

import crypto from "crypto";
import { Pool, type QueryResult, type QueryResultRow } from "pg";

// Set SESSION_SECRET BEFORE importing the route so that
// authRoutes.getSessionFromCookie (which i18nRoutes calls) can verify
// the forged cookie below.
const TEST_SESSION_SECRET = "<REDACTED_SECRET>";
process.env.SESSION_SECRET = TEST_SESSION_SECRET;

const SESSION_COOKIE_NAME = "ExampleOrg_session";
function signSession(payload: Record<string, unknown>): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", TEST_SESSION_SECRET)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

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
const { i18nRoutes } = await import("./i18nRoutes");
const { buildHandler, makeContext } = await import(
  "../../../tests/_helpers/fakeContext"
);

const SECRETS = {
  password_hash: "<REDACTED_SECRET>",
  mfa_secret: "<REDACTED_SECRET>",
  access_token: "<REDACTED_SECRET>",
  refresh_token: "<REDACTED_SECRET>",
  api_key: "<REDACTED_SECRET>",
} as const;

const SECRET_LIKE_LANG_VALUES: Array<{ label: string; value: string }> = [
  ...Object.entries(SECRETS).map(([k, v]) => ({ label: k, value: v })),
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

console.log("\n=== i18nRoutes — write-path secret-leak tests ===\n");

const handler = await buildHandler(
  i18nRoutes,
  "/api/user/language-preference",
  "POST",
);

for (const { label, value } of SECRET_LIKE_LANG_VALUES) {
  captured.length = 0;
  const res = await handler(
    makeContext({ method: "POST", body: { lang: value } }),
  );

  assert(
    res.status === 400,
    `lang=${label}: handler returns 400 (whitelist rejects unknown lang) — got ${res.status}`,
  );

  // Anti-leak: confirm no INSERT/UPDATE was attempted with the raw secret.
  for (const c of captured) {
    const sqlNorm = c.sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (sqlNorm.startsWith("INSERT INTO") || /^UPDATE\s+\w+\s+SET/.test(sqlNorm)) {
      const flat = JSON.stringify(c.params);
      assert(
        !flat.includes(value),
        `lang=${label}: raw secret-shaped lang must NOT appear in any INSERT/UPDATE params`,
      );
    }
  }
  // The write-rejection contract: no INSERT/UPDATE at all on a 400.
  const wroteAnything = captured.some((c) => {
    const sqlNorm = c.sql.replace(/\s+/g, " ").trim().toUpperCase();
    return sqlNorm.startsWith("INSERT INTO") || /^UPDATE\s+\w+\s+SET/.test(sqlNorm);
  });
  assert(
    !wroteAnything,
    `lang=${label}: NO INSERT/UPDATE was issued for the rejected payload`,
  );
}

// Anti-tautology: a valid lang is accepted (200) and still issues no
// INSERT/UPDATE in the no-session branch — proving the preceding "no write"
// assertion is not vacuous (the route really does have write surfaces gated
// by session presence; if a regression added an unconditional write, this
// negative-control would surface it via the rest of the suite).
{
  captured.length = 0;
  const res = await handler(makeContext({ method: "POST", body: { lang: "en" } }));
  assert(res.status === 200, `lang=en: handler returns 200 — got ${res.status}`);
  assert(
    res.body?.success === true,
    "lang=en: response body.success === true",
  );
}

// === Section 2: session-authenticated WRITE-PATH coverage =================
//
// The previous section drove the no-session branch (which short-circuits
// before any DB write) to prove the input whitelist rejects secret-shaped
// `lang` values. This section forges a signed session cookie so the
// handler enters the actual UPDATE platform_users SET ui_language = $1
// WHERE id = $2 branch, and verifies:
//
//   (a) Whitelisted "en" / "ar" values DO produce an UPDATE, and the
//       captured params contain ONLY the whitelist value + numeric
//       userId — i.e. there is no free-text column on this route that a
//       caller could use to smuggle a secret into Postgres.
//   (b) Even WITH a valid session, a secret-shaped `lang` is still
//       rejected with 400 BEFORE the UPDATE fires. This proves the
//       whitelist (not the session check) is what blocks secret
//       persistence on this endpoint.
//
console.log("\n--- Section 2: session-authenticated UPDATE path ---\n");

const SESSION_USER_ID = 4242;
const sessionCookieValue = signSession({
  userId: SESSION_USER_ID,
  email: "<REDACTED_EMAIL>",
  exp: Date.now() + 60_000,
});
const sessionCookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionCookieValue)}`;

function findUpdateOnPlatformUsers(): CapturedQuery | null {
  for (const c of captured) {
    const sqlNorm = c.sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (/^UPDATE\s+PLATFORM_USERS\s+SET/.test(sqlNorm)) return c;
  }
  return null;
}

// (a) Happy-path: each whitelisted lang fires the UPDATE and its params
//     contain no surprises.
for (const validLang of ["en", "ar"]) {
  captured.length = 0;
  const res = await handler(
    makeContext({
      method: "POST",
      headers: { Cookie: sessionCookieHeader },
      body: { lang: validLang },
    }),
  );
  assert(
    res.status === 200,
    `session+lang=${validLang}: handler returns 200 — got ${res.status} (body: ${JSON.stringify(res.body)})`,
  );

  const update = findUpdateOnPlatformUsers();
  assert(
    update !== null,
    `session+lang=${validLang}: UPDATE platform_users was issued`,
  );
  if (!update) continue;

  assert(
    update.params.length === 2,
    `session+lang=${validLang}: UPDATE has exactly 2 bound params (lang, userId)`,
  );
  assert(
    update.params[0] === validLang,
    `session+lang=${validLang}: $1 is the whitelisted lang value`,
  );
  assert(
    update.params[1] === SESSION_USER_ID,
    `session+lang=${validLang}: $2 is the session userId (no caller-controlled string)`,
  );

  // Defensive: confirm none of our deny-list values or credential-shaped
  // strings could have ended up in the params.
  const flat = JSON.stringify(update.params);
  for (const [keyLabel, rawSecret] of Object.entries(SECRETS)) {
    assert(
      !flat.includes(rawSecret),
      `session+lang=${validLang}: ${keyLabel} secret never appears in UPDATE params`,
    );
  }
}

// (b) Secret-shaped `lang` values are still rejected even when a valid
//     session is presented — the whitelist is the gate, not the cookie.
for (const { label, value } of SECRET_LIKE_LANG_VALUES) {
  captured.length = 0;
  const res = await handler(
    makeContext({
      method: "POST",
      headers: { Cookie: sessionCookieHeader },
      body: { lang: value },
    }),
  );
  assert(
    res.status === 400,
    `session+lang=${label}: whitelist rejects secret-shaped lang with 400 — got ${res.status}`,
  );
  assert(
    findUpdateOnPlatformUsers() === null,
    `session+lang=${label}: NO UPDATE platform_users was issued for the rejected payload`,
  );
}

console.log("");
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
