/**
 * CI gate (Task #459): prevents evidenceDatabase write paths from persisting
 * unmasked secrets into the evidence_records table.
 *
 * Run:    npx tsx src/utils/evidenceDatabase.test.ts
 * Wired:  scripts/post-merge.sh (auto-discovered by `npm test`)
 *
 * The writer is `addEvidence()`. Its only user-controlled free-form column
 * is `metadata` (JSONB) and `description` (TEXT). Both must reach the
 * INSERT params already scrubbed of the five required deny-list keys
 * (password_hash, mfa_secret, access_token, refresh_token, api_key) AND of
 * credential-shaped substrings interpolated into prose.
 */

import { Pool, type QueryResult, type QueryResultRow } from "pg";

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string): void {
  if (cond) {
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
  const paramArr = Array.isArray(params)
    ? params
    : typeof sql !== "string" && Array.isArray(sql.values)
      ? sql.values
      : [];
  captured.push({ sql: sqlStr, params: paramArr });
  return Promise.resolve({
    rows: [{ id: 1 }],
    rowCount: 1,
    command: "",
    oid: 0,
    fields: [],
  });
};

(Pool.prototype as unknown as { query: MockedPoolQuery }).query = mockQuery;

const { addEvidence } = await import("./evidenceDatabase");

const REDACTED_SENTINEL = "***REDACTED***";
const SECRETS = {
  password_hash: "$2b$12$abcdefghij1234567890uvwxyz.ABCDEFGH_IJ",
  mfa_secret: "JBSWY3DPEHPK3PXP",
  access_token: "ya29.a0AfH6SMBxxxxAccessTokenVALUE",
  refresh_token: "1//0gREFRESHTOKENvalueXYZ",
  api_key: "sk-PLAINTEXTAPIKEY1234567890",
} as const;
const REQUIRED_DENY_KEYS = [
  "password_hash",
  "mfa_secret",
  "access_token",
  "refresh_token",
  "api_key",
] as const;

function lastWriteParams(): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const head = captured[i].sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (
      head.startsWith("INSERT") ||
      head.startsWith("UPDATE") ||
      head.startsWith("UPSERT") ||
      head.startsWith("WITH ")
    ) {
      return captured[i].params;
    }
  }
  return null;
}

function paramsBlob(p: unknown[]): string {
  return p.map((x) => (x === null || x === undefined ? "" : typeof x === "string" ? x : JSON.stringify(x))).join("|");
}

console.log("\n=== addEvidence — write-path secret-leak tests ===\n");

for (const key of REQUIRED_DENY_KEYS) {
  captured.length = 0;
  await addEvidence({
    entity_type: "nc",
    entity_id: 7,
    filename: "report.pdf",
    original_filename: "report.pdf",
    file_type: "application/pdf",
    file_size: 1234,
    uploaded_by: "test-runner",
    description: `Filed by audit team — non-secret marker NSF-${key}`,
    metadata: { [key]: SECRETS[key], source: "non-secret marker" },
  });
  const params = lastWriteParams();
  assert(params !== null, `${key}: pool.query was called with INSERT`);
  if (!params) continue;
  const blob = paramsBlob(params);
  assert(!blob.includes(SECRETS[key]), `${key}: raw secret absent from INSERT params`);
  assert(blob.includes(REDACTED_SENTINEL), `${key}: REDACTED sentinel present in INSERT params`);
  assert(blob.includes("non-secret marker"), `${key}: non-sensitive metadata field passes through unchanged`);
}

console.log(
  `\n=== evidenceDatabase secret-leak tests: ${passed} passed, ${failed} failed ===\n`,
);
if (failed > 0) process.exit(1);
