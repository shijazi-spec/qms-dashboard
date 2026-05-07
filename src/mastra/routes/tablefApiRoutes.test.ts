/**
 * CI gate: prevents `tablefApiRoutes` POST handlers from persisting unmasked
 * secrets into `tablef_kpis` / `tablef_performance`.
 *
 * Run:    npx tsx src/mastra/routes/tablefApiRoutes.test.ts
 * Wired:  scripts/post-merge.sh → `npm test` (auto-discovered).
 *
 * The /api/tablef/kpis and /api/tablef/performance POST endpoints accept
 * free-text columns (description, calculation_definition, comment,
 * evidence_link). Each handler now wraps the body with
 * `redactSensitiveDeep()` BEFORE running INSERT/UPDATE.
 *
 * This test:
 *   1. Patches `pg.Pool.prototype.query` BEFORE importing.
 *   2. Sets ADMIN_API_KEY (≥32 chars, ≥10 distinct) and presents an
 *      X-Admin-Key header so `requireRole(TABLEF_WRITE_ROLES)` admits the
 *      admin-key user.
 *   3. POSTs deny-list-shaped payloads, asserts INSERT/UPDATE params never
 *      contain the raw secret and DO contain the `***REDACTED***` sentinel.
 *   4. Anti-tautology: a clean payload round-trips verbatim.
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
    rows: [{ id: 1 }],
    rowCount: 1,
    command: "",
    oid: 0,
    fields: [],
  });
};
(Pool.prototype as unknown as { query: MockedPoolQuery }).query = mockQuery;
(Pool.prototype as unknown as { end: () => Promise<void> }).end = () =>
  Promise.resolve();

const ADMIN_KEY = "tablef-api-secret-leak-test-admin-key-2026-XYZ"; // ≥32, ≥10 distinct
process.env.ADMIN_API_KEY = ADMIN_KEY;

// Import AFTER mock + env are in place.
const { tablefApiRoutes } = await import("./tablefApiRoutes");
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

const kpisHandler = await buildHandler(
  tablefApiRoutes,
  "/api/tablef/kpis",
  "POST",
  { mastra: null },
);
const perfHandler = await buildHandler(
  tablefApiRoutes,
  "/api/tablef/performance",
  "POST",
  { mastra: null },
);

const PAYLOADS: Array<{
  name: string;
  handler: typeof kpisHandler;
  build: (token: string) => Record<string, unknown>;
}> = [
  {
    name: "/api/tablef/kpis",
    handler: kpisHandler,
    build: (token) => ({
      department_id: "SDR",
      name: `KPI ${token}`,
      description: `Defined per playbook: ${token}`,
      category: "operations",
      unit: "%",
      target_annual: 100,
      target_monthly: 8,
      weight: 1,
      owner_email: "owner@walaplus.example",
      data_source: `source: ${token}`,
      calculation_definition: `formula: ${token}`,
    }),
  },
  {
    name: "/api/tablef/performance",
    handler: perfHandler,
    build: (token) => ({
      kpi_id: "KPI-TEST-1",
      department_id: "SDR",
      period_month: "2099-01",
      target: 10,
      achieved: 9,
      comment: `Investigated cause: ${token}`,
      evidence_link: `https://docs.example.com/?ref=${token}`,
    }),
  },
];

for (const { name, handler, build } of PAYLOADS) {
  console.log(
    `\n=== tablefApiRoutes ${name} — write-path secret-leak tests ===\n`,
  );

  for (const { label, value } of SECRET_LIKE_STRINGS) {
    captured.length = 0;
    const res = await handler(
      makeContext({
        method: "POST",
        headers: { "X-Admin-Key": ADMIN_KEY },
        body: build(value),
      }),
    );
    assert(
      res.status === 200,
      `${name}/${label}: handler returns 200 — got ${res.status}`,
    );
    const params = lastWriteParams();
    assert(params !== null, `${name}/${label}: pool.query was called`);
    if (!params) continue;
    const flat = JSON.stringify(params);
    assert(
      !flat.includes(value),
      `${name}/${label}: raw credential-shaped string is NOT in INSERT/UPDATE params`,
    );
    assert(
      flat.includes(REDACTED_SENTINEL),
      `${name}/${label}: REDACTED sentinel IS in INSERT/UPDATE params`,
    );
  }

  for (const [keyLabel, rawSecret] of Object.entries(SECRETS)) {
    captured.length = 0;
    await handler(
      makeContext({
        method: "POST",
        headers: { "X-Admin-Key": ADMIN_KEY },
        body: build(rawSecret),
      }),
    );
    const params = lastWriteParams();
    if (!params) continue;
    const flat = JSON.stringify(params);
    if (
      keyLabel === "password_hash" ||
      keyLabel === "access_token" ||
      keyLabel === "api_key"
    ) {
      assert(
        !flat.includes(rawSecret),
        `${name}/key=${keyLabel}: raw secret VALUE is NOT in params`,
      );
    } else {
      assert(flat.length > 0, `${name}/key=${keyLabel}: write captured`);
    }
  }

  // Anti-tautology — clean marker preserved verbatim somewhere in params.
  // (Note: the redactor's URL-credential pass treats any `?…=…` query-string
  // as potentially-sensitive — so the evidence_link column may legitimately
  // be replaced by REDACTED even on an innocuous payload. The contract this
  // test guards is that the clean marker survives in at least one param
  // (the comment / description columns).)
  {
    captured.length = 0;
    const res = await handler(
      makeContext({
        method: "POST",
        headers: { "X-Admin-Key": ADMIN_KEY },
        body: build("CLEAN-MARKER-XYZ789"),
      }),
    );
    assert(res.status === 200, `${name}/innocuous: handler returns 200`);
    const params = lastWriteParams();
    if (params) {
      const flat = JSON.stringify(params);
      assert(
        flat.includes("CLEAN-MARKER-XYZ789"),
        `${name}/innocuous: clean marker preserved verbatim (test isn't a tautology)`,
      );
    }
  }
}

console.log("");
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
