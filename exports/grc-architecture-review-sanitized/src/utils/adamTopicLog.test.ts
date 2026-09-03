/**
 * CI gate: proves AssistantPersona topic-log writes cannot persist unmasked credentials.
 *
 * Run: npx tsx src/utils/adamTopicLog.test.ts
 */

import { Pool, type QueryResult, type QueryResultRow } from "pg";

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

type QuerySource = string | { text: string; values?: unknown[] };
type MockedPoolQuery = (
  sql: QuerySource,
  params?: unknown[],
) => Promise<QueryResult<QueryResultRow>>;

const captured: CapturedQuery[] = [];
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

const mockQuery: MockedPoolQuery = (sql, params = []) => {
  const sqlText = typeof sql === "string" ? sql : sql.text;
  const values =
    typeof sql === "string" ? params : Array.isArray(sql.values) ? sql.values : [];
  captured.push({ sql: sqlText, params: values });
  return Promise.resolve({
    rows: [],
    rowCount: 1,
    command: "",
    oid: 0,
    fields: [],
  });
};

(Pool.prototype as unknown as { query: MockedPoolQuery }).query = mockQuery;

const { recordQuestionSection } = await import("./adamTopicLog");

const REDACTED = "***REDACTED***";
const SECRETS = {
  password_hash: "<REDACTED_PASSWORD_HASH>_IJ",
  mfa_secret: "<REDACTED_MFA_SECRET>",
  access_token: "<REDACTED_SECRET>",
  refresh_token: "<REDACTED_SECRET>",
  api_key: "<REDACTED_SECRET>",
} as const;

function lastInsertParams(): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (
      captured[i].sql
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase()
        .startsWith("INSERT INTO")
    ) {
      return captured[i].params;
    }
  }
  return null;
}

console.log("\n=== recordQuestionSection — secret-leak tests ===\n");

for (const [key, rawSecret] of Object.entries(SECRETS)) {
  captured.length = 0;
  await recordQuestionSection("Show duplicate records", {
    surface: "web",
    askedBy: JSON.stringify({
      display_name: "Sample User",
      [key]: rawSecret,
    }),
  });

  const params = lastInsertParams();
  assert(params !== null, `${key}: INSERT was issued`);
  if (!params) continue;

  const combined = params.map((value) => String(value ?? "")).join("|");
  assert(
    !combined.includes(rawSecret),
    `${key}: raw secret is absent from INSERT params`,
  );
  assert(
    combined.includes(REDACTED),
    `${key}: redaction sentinel is present in INSERT params`,
  );
}

captured.length = 0;
await recordQuestionSection("Show KPI scorecards", {
  surface: "ChatProvider",
  askedBy: "<REDACTED_EMAIL>",
});
const ordinaryParams = lastInsertParams();
assert(ordinaryParams !== null, "ordinary payload: INSERT was issued");
if (ordinaryParams) {
  assert(
    ordinaryParams[0] === "kpis" &&
      ordinaryParams[1] === "ChatProvider" &&
      ordinaryParams[2] === "<REDACTED_EMAIL>",
    "ordinary payload is preserved verbatim",
  );
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("\n✅ All adamTopicLog tests passed");
process.exit(0);