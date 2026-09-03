/**
 * CI gate: prevents `exportDownloadRoutes` from persisting unmasked secrets
 * into `user_recent_downloads.entries` (JSONB).
 *
 * Run:    npx tsx src/mastra/routes/exportDownloadRoutes.test.ts
 * Wired:  scripts/post-merge.sh → `npm test` (auto-discovered).
 *
 * POST /api/exports/recent-downloads stores arbitrary client-side download
 * metadata (filename, URL, agent-supplied notes). The handler now wraps the
 * incoming `entries` array with `redactSensitiveDeep()` BEFORE the INSERT…
 * ON CONFLICT DO UPDATE. This test:
 *
 *   1. Patches `pg.Pool.prototype.query` BEFORE importing the route module.
 *   2. Sets `SESSION_SECRET` and forges a signed ExampleOrg_session cookie
 *      with a non-zero userId so the session branch (not the admin-key
 *      short-circuit, which returns success without writing) is exercised.
 *   3. Drives the POST handler with deny-list keys (password_hash,
 *      mfa_secret, access_token, refresh_token, api_key) AND credential-
 *      shaped strings (bcrypt, JWT, ghp_, sk-) embedded under nested
 *      innocuous keys (`notes`, `description`).
 *   4. Asserts the captured INSERT/UPDATE params never contain the raw
 *      secret and DO contain the `***REDACTED***` sentinel.
 *   5. Anti-tautology: a payload with no secrets round-trips verbatim.
 */

import crypto from "crypto";
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

const TEST_SESSION_SECRET = "test-session-secret-export-downloads-2026";
process.env.SESSION_SECRET = TEST_SESSION_SECRET;

// Import AFTER the mock + env are in place.
const { exportDownloadRoutes } = await import("./exportDownloadRoutes");
const { buildHandler, makeContext } = await import(
  "../../../tests/_helpers/fakeContext"
);

const SESSION_COOKIE_NAME = "ExampleOrg_session";
function signSession(payload: Record<string, unknown>): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", TEST_SESSION_SECRET)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}
const sessionCookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(
  signSession({
    userId: 99,
    email: "<REDACTED_EMAIL>",
    name: "Test User",
    role: "admin",
    exp: Date.now() + 3_600_000,
  }),
)}`;

const REDACTED_SENTINEL = "***REDACTED***";
const SECRETS = {
  password_hash: "<REDACTED_PASSWORD_HASH>_IJ",
  mfa_secret: "<REDACTED_MFA_SECRET>",
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

function lastInsertOrUpdateParams(): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const c = captured[i];
    const sql = c.sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (sql.startsWith("INSERT INTO") || /^UPDATE\s+\w+\s+SET/.test(sql)) {
      return c.params;
    }
  }
  return null;
}

const postHandler = await buildHandler(
  exportDownloadRoutes,
  "/api/exports/recent-downloads",
  "POST",
);

console.log(
  "\n=== exportDownloadRoutes — write-path secret-leak tests (deny-list keys) ===\n",
);

for (const key of REQUIRED_DENY_KEYS) {
  captured.length = 0;
  const rawSecret = SECRETS[key];
  const res = await postHandler(
    makeContext({
      method: "POST",
      headers: { Cookie: sessionCookie },
      body: {
        entries: [
          {
            id: `dl-${key}`,
            label: "Recent export",
            url: "/api/exports/foo.csv",
            // The deny-list key sits inside a nested entry so the handler's
            // redactSensitiveDeep() pass must walk the structure.
            metadata: { [key]: rawSecret, ts: Date.now() },
          },
        ],
      },
    }),
  );

  assert(
    res.status === 200,
    `${key}: handler returns 200 (write path executed) — got ${res.status}`,
  );

  const params = lastInsertOrUpdateParams();
  assert(params !== null, `${key}: pool.query was called with INSERT/UPDATE`);
  if (!params) continue;

  const flat = JSON.stringify(params);
  assert(
    !flat.includes(rawSecret),
    `${key}: raw secret is NOT present in INSERT params (entries JSONB scrubbed)`,
  );
  assert(
    flat.includes(REDACTED_SENTINEL),
    `${key}: REDACTED sentinel IS present in INSERT params`,
  );
}

console.log(
  "\n=== exportDownloadRoutes — credential-shaped strings under innocuous keys ===\n",
);

for (const { label, value } of SECRET_LIKE_STRINGS) {
  captured.length = 0;
  const res = await postHandler(
    makeContext({
      method: "POST",
      headers: { Cookie: sessionCookie },
      body: {
        entries: [
          {
            id: `dl-shape-${label}`,
            // innocuous key names — must still be regex-scrubbed.
            notes: `Shared with ${value}`,
            description: `evidence link contains ${value}`,
          },
        ],
      },
    }),
  );

  assert(
    res.status === 200,
    `${label}: handler returns 200 — got ${res.status}`,
  );
  const params = lastInsertOrUpdateParams();
  assert(params !== null, `${label}: pool.query was called`);
  if (!params) continue;

  const flat = JSON.stringify(params);
  assert(
    !flat.includes(value),
    `${label}: raw credential-shaped string is NOT present in INSERT params`,
  );
  assert(
    flat.includes(REDACTED_SENTINEL),
    `${label}: REDACTED sentinel IS present in INSERT params`,
  );
}

// Anti-tautology — innocuous prose is preserved verbatim.
{
  captured.length = 0;
  const res = await postHandler(
    makeContext({
      method: "POST",
      headers: { Cookie: sessionCookie },
      body: {
        entries: [
          {
            id: "dl-innocent",
            label: "Quarterly KPI export",
            notes: "Reviewed by alice on 2025-01-15",
          },
        ],
      },
    }),
  );
  assert(res.status === 200, "innocuous: handler returns 200");
  const params = lastInsertOrUpdateParams();
  if (params) {
    const flat = JSON.stringify(params);
    assert(
      flat.includes("Quarterly KPI export") &&
        flat.includes("Reviewed by alice"),
      "innocuous: ordinary prose preserved verbatim (test isn't a tautology)",
    );
    assert(
      !flat.includes(REDACTED_SENTINEL),
      "innocuous: REDACTED sentinel NOT present (regex is targeted, not nuke-everything)",
    );
  }
}

console.log("");
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
