/**
 * CI gate: proves uploaded-file metadata writes cannot persist unmasked
 * credentials.
 *
 * Run: npx tsx src/utils/fileUpload.test.ts
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

const { saveUploadedFile } = await import("./fileUpload");

const REDACTED = "***REDACTED***";
const PDF_BUFFER = Buffer.from("%PDF-1.7\nredaction-test\n");
const SECRETS = {
  password_hash: <REDACTED_SECRET>
  mfa_secret: <REDACTED_SECRET>
  access_token: <REDACTED_SECRET>
  refresh_token: <REDACTED_SECRET>
  api_key: <REDACTED_SECRET>
} as const;

function lastUploadedFileInsertParams(): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const normalized = captured[i].sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (normalized.startsWith("INSERT INTO UPLOADED_FILES")) {
      return captured[i].params;
    }
  }
  return null;
}

console.log("\n=== saveUploadedFile — secret-leak tests ===\n");

for (const [key, rawSecret] of Object.entries(SECRETS)) {
  captured.length = 0;
  await saveUploadedFile(
    PDF_BUFFER,
    "evidence.pdf",
    JSON.stringify({
      content_type: "application/pdf",
      [key]: rawSecret,
    }),
    "audits",
  );

  const params = lastUploadedFileInsertParams();
  assert(params !== null, `${key}: uploaded_files INSERT was issued`);
  if (!params) continue;

  const combined = params
    .filter((value) => !Buffer.isBuffer(value))
    .map((value) => String(value ?? ""))
    .join("|");
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
await saveUploadedFile(
  PDF_BUFFER,
  "ordinary-evidence.pdf",
  "application/pdf",
  "audits",
);
const ordinaryParams = lastUploadedFileInsertParams();
assert(ordinaryParams !== null, "ordinary payload: uploaded_files INSERT was issued");
if (ordinaryParams) {
  assert(
    ordinaryParams[1] === "audits" &&
      ordinaryParams[2] === "ordinary-evidence.pdf" &&
      ordinaryParams[4] === "application/pdf",
    "ordinary upload metadata is preserved verbatim",
  );
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("\n✅ All fileUpload tests passed");
process.exit(0);