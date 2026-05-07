/**
 * CI gate: prevents `qmsEnhancedRoutes` bulk-update endpoints from
 * persisting unmasked secrets into `nonconformance_records.status` /
 * `capa_records.status`.
 *
 * Run:    npx tsx src/mastra/routes/qmsEnhancedRoutes.test.ts
 * Wired:  scripts/post-merge.sh → `npm test` (auto-discovered).
 *
 * The bulk-update endpoints take a free-form `status` string and write it
 * directly into the `status` column of every record whose id is in `ids`.
 * `status` is meant to be a short enum like "open" / "closed", but the
 * endpoint never validated it — so a misbehaving client could otherwise
 * paste a JWT, GitHub PAT (`ghp_…`), bcrypt hash, etc. straight into the
 * row. The handler now wraps `status` with `redactSensitiveDeep()` first.
 *
 * This test:
 *   1. Patches `pg.Pool.prototype.query` BEFORE importing.
 *   2. Sets ADMIN_API_KEY (≥32 chars, ≥10 distinct) and presents an
 *      X-Admin-Key header so `requireRole(QMS_ROLES)` sees the admin-key
 *      user (role="admin").
 *   3. Drives both bulk-update handlers with deny-list-shaped status
 *      strings and asserts the raw secret never reaches the captured
 *      UPDATE params, while the `***REDACTED***` sentinel does.
 *   4. Anti-tautology: an innocuous `status: "closed"` round-trips verbatim.
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

// Stub pool.end so the handler's `finally { await pool.end(); }` doesn't try
// to close a real connection.
(Pool.prototype as unknown as { end: () => Promise<void> }).end = () =>
  Promise.resolve();

const ADMIN_KEY = "qms-bulk-update-secret-leak-test-admin-key-2026"; // ≥32, ≥10 distinct
process.env.ADMIN_API_KEY = ADMIN_KEY;

// Import AFTER mock + env are in place.
const { qmsEnhancedRoutes } = await import("./qmsEnhancedRoutes");
const { buildHandler, makeContext } = await import(
  "../../../tests/_helpers/fakeContext"
);

const REDACTED_SENTINEL = "***REDACTED***";

const SECRETS = {
  password_hash: "$2b$12$abcdefghij1234567890uvwxyz.ABCDEFGH_IJ",
  mfa_secret: "JBSWY3DPEHPK3PXP",
  access_token: "ya29.a0AfH6SMBxxxxAccessTokenVALUE",
  refresh_token: "1//0gREFRESHTOKENvalueXYZ",
  api_key: "sk-PLAINTEXTAPIKEY1234567890",
} as const;

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
  { label: "GitHub PAT", value: "ghp_ABCdefGHIjklMNOpqrsTUVwxyz0123456789" },
  {
    label: "OpenAI sk- key",
    value: "sk-proj-ABCdefGHIjklMNOpqrsTUVwxyz0123456789ABCDEF",
  },
];

function lastBulkUpdateParams(table: "NONCONFORMANCE_RECORDS" | "CAPA_RECORDS"): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const c = captured[i];
    const sql = c.sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (sql.startsWith(`UPDATE ${table} SET STATUS`)) {
      return c.params;
    }
  }
  return null;
}

const ncHandler = await buildHandler(
  qmsEnhancedRoutes,
  "/api/qms/nc/bulk-update",
  "POST",
  { mastra: null },
);
const capaHandler = await buildHandler(
  qmsEnhancedRoutes,
  "/api/qms/capa/bulk-update",
  "POST",
  { mastra: null },
);

for (const { name, handler, table } of [
  { name: "nc/bulk-update", handler: ncHandler, table: "NONCONFORMANCE_RECORDS" as const },
  { name: "capa/bulk-update", handler: capaHandler, table: "CAPA_RECORDS" as const },
]) {
  console.log(
    `\n=== qmsEnhancedRoutes — ${name} write-path secret-leak tests ===\n`,
  );

  for (const { label, value } of SECRET_LIKE_STRINGS) {
    captured.length = 0;
    const res = await handler(
      makeContext({
        method: "POST",
        headers: { "X-Admin-Key": ADMIN_KEY },
        body: { ids: [1, 2, 3], status: value },
      }),
    );
    assert(
      res.status === 200,
      `${name}/${label}: handler returns 200 — got ${res.status}`,
    );
    const params = lastBulkUpdateParams(table);
    assert(params !== null, `${name}/${label}: bulk-update UPDATE was issued`);
    if (!params) continue;
    const flat = JSON.stringify(params);
    assert(
      !flat.includes(value),
      `${name}/${label}: raw credential-shaped status is NOT in UPDATE params`,
    );
    assert(
      flat.includes(REDACTED_SENTINEL),
      `${name}/${label}: REDACTED sentinel IS in UPDATE params`,
    );
  }

  for (const [keyLabel, rawSecret] of Object.entries(SECRETS)) {
    captured.length = 0;
    const res = await handler(
      makeContext({
        method: "POST",
        headers: { "X-Admin-Key": ADMIN_KEY },
        body: { ids: [1], status: rawSecret },
      }),
    );
    assert(res.status === 200, `${name}/key=${keyLabel}: status=200`);
    const params = lastBulkUpdateParams(table);
    if (!params) continue;
    const flat = JSON.stringify(params);
    if (
      keyLabel === "password_hash" ||
      keyLabel === "access_token" ||
      keyLabel === "api_key"
    ) {
      assert(
        !flat.includes(rawSecret),
        `${name}/key=${keyLabel}: raw secret value is NOT in UPDATE params`,
      );
    } else {
      assert(flat.length > 0, `${name}/key=${keyLabel}: UPDATE captured`);
    }
  }

  // Anti-tautology: a normal status value passes through unchanged.
  {
    captured.length = 0;
    const res = await handler(
      makeContext({
        method: "POST",
        headers: { "X-Admin-Key": ADMIN_KEY },
        body: { ids: [1, 2], status: "closed" },
      }),
    );
    assert(res.status === 200, `${name}/innocuous: status=200`);
    const params = lastBulkUpdateParams(table);
    if (params) {
      assert(
        params[0] === "closed",
        `${name}/innocuous: status="closed" preserved verbatim (test isn't a tautology)`,
      );
      const flat = JSON.stringify(params);
      assert(
        !flat.includes(REDACTED_SENTINEL),
        `${name}/innocuous: REDACTED sentinel NOT present`,
      );
    }
  }
}

console.log("");
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
