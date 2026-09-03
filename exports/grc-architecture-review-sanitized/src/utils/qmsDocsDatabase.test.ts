/**
 * CI gate: prevents qmsDocsDatabase write paths from persisting unmasked
 * secrets into qms_uploaded_documents.
 *
 * Run:    npx tsx src/utils/qmsDocsDatabase.test.ts
 * Wired:  scripts/post-merge.sh → tests/runIntegrationTests.ts (auto-discovered).
 *
 * The module owns its own pg.Pool via createRedactedPool(), which intercepts
 * INSERT/UPDATE params and applies redactSensitiveDeep() to every positional
 * value. This test patches Pool.prototype.query BEFORE importing the module,
 * drives createDocument() with payloads that contain:
 *   - the five required deny-list keys (password_hash, mfa_secret,
 *     access_token, refresh_token, api_key) embedded as substrings inside the
 *     free-text `notes` field and the regulation_codes array,
 *   - credential-shaped strings (bcrypt hash, JWT, LLMProvider sk-, SourceControlProvider PAT)
 *     embedded under innocuous string fields (notes, title, file_name),
 * and asserts those raw values never reach the captured INSERT params vector
 * while the ***REDACTED*** sentinel does.
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
  const paramArr =
    typeof sql !== "string" && Array.isArray(sql.values)
      ? sql.values
      : Array.isArray(params)
        ? params
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

// Import AFTER the mock is in place so the wrapped pool's bound originalQuery
// resolves to the patched prototype method.
const { createDocument } = await import("./qmsDocsDatabase");

const REDACTED_SENTINEL = "***REDACTED***";

const SECRETS = {
  password_hash: "$2b$12$abcdefghij1234567890uvwxyz.ABCDEFGH_IJ",
  mfa_secret: "JBSWY3DPEHPK3PXP",
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

function lastInsertParams(): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const c = captured[i];
    if (c.sql.replace(/\s+/g, " ").trim().toUpperCase().startsWith("INSERT INTO")) {
      return c.params;
    }
  }
  return null;
}

const baseInput = {
  category: "documents" as const,
  title: "Quarterly Risk Review",
  file_path: "/uploads/qrr.pdf",
  file_name: "qrr.pdf",
  file_size: 1024,
  mime_type: "application/pdf",
  notes: null as string | null,
  regulation_codes: null as string[] | null,
  uploaded_by: "test-runner",
};

// ---------------------------------------------------------------------------
// Section 1 — deny-list-key secrets embedded in free-text fields
// ---------------------------------------------------------------------------

console.log("\n=== createDocument — deny-list secret values in free text ===\n");

for (const key of REQUIRED_DENY_KEYS) {
  captured.length = 0;
  const rawSecret = SECRETS[key];

  // Encode the deny-listed key/value as a JSON snapshot inside the `notes`
  // free-text field. createRedactedPool() walks JSON-shaped string params
  // recursively, so the deny-list-by-key scrubber must replace the value.
  const snapshot = JSON.stringify({
    operator: "alice",
    [key]: rawSecret,
    note: `pasted ${key} into upload metadata`,
  });
  await createDocument({
    ...baseInput,
    title: `Doc referencing ${key}`,
    notes: snapshot,
    regulation_codes: [`code-PDPL`],
  });

  const params = lastInsertParams();
  assert(params !== null, `${key}: pool.query was called with INSERT`);
  if (!params) continue;

  // Param layout matches the createDocument INSERT:
  // [category, title, file_path, file_name, file_size, mime_type,
  //  notes, regulation_codes, uploaded_by]
  const titleParam = String(params[1] ?? "");
  const notesParam = String(params[6] ?? "");
  const regCodesParam = Array.isArray(params[7])
    ? (params[7] as unknown[]).map((v) => String(v)).join("|")
    : String(params[7] ?? "");
  const combined = `${titleParam}|${notesParam}|${regCodesParam}`;

  assert(
    !combined.includes(rawSecret),
    `${key}: raw secret is NOT present in INSERT params (title/notes/regulation_codes)`,
  );
  assert(
    combined.includes(REDACTED_SENTINEL),
    `${key}: REDACTED sentinel IS present in INSERT params`,
  );
}

// ---------------------------------------------------------------------------
// Section 2 — credential-shaped strings under innocuous field names
// ---------------------------------------------------------------------------

console.log("\n=== createDocument — credential-shaped strings in innocuous fields ===\n");

const SECRET_LIKE_STRINGS: Array<{ label: string; value: string }> = [
  {
    label: "bcrypt hash",
    value: "$2b$12$abcdefghijklmnopqrstuOCm5RJ7p2sIcQqL7gKwSxmXJ9pYsZyHa",
  },
  {
    label: "JWT",
    value:
      "<REDACTED_TOKEN>",
  },
  {
    label: "LLMProvider sk- key",
    value: "<REDACTED_TOKEN>",
  },
  {
    label: "SourceControlProvider PAT",
    value: "<REDACTED_TOKEN>",
  },
];

for (const { label, value } of SECRET_LIKE_STRINGS) {
  captured.length = 0;
  await createDocument({
    ...baseInput,
    title: `Audit notes containing ${label}: ${value}`,
    file_name: `dump-${value}.txt`,
    notes: `Investigation log: ${label} found in upload — ${value}`,
  });

  const params = lastInsertParams();
  assert(params !== null, `${label}: pool.query was called with INSERT`);
  if (!params) continue;

  const titleParam = String(params[1] ?? "");
  const fileNameParam = String(params[3] ?? "");
  const notesParam = String(params[6] ?? "");
  const combined = `${titleParam}|${fileNameParam}|${notesParam}`;

  assert(
    !combined.includes(value),
    `${label}: raw credential-shaped value is NOT present in INSERT params`,
  );
  assert(
    notesParam.includes(REDACTED_SENTINEL),
    `${label}: REDACTED sentinel IS present in notes param`,
  );
}

// ---------------------------------------------------------------------------
// Section 3 — anti-tautology: ordinary prose passes through verbatim
// ---------------------------------------------------------------------------

console.log("\n=== createDocument — innocuous payload passes through ===\n");

{
  captured.length = 0;
  await createDocument({
    ...baseInput,
    title: "Q1 2026 Compliance Checklist",
    notes: "Reviewed by audit team on 2026-01-15. Ticket ABC-123.",
    regulation_codes: ["PDPL", "ISO-27001"],
  });

  const params = lastInsertParams();
  assert(params !== null, "innocuous: pool.query was called");
  if (params) {
    const titleParam = String(params[1] ?? "");
    const notesParam = String(params[6] ?? "");
    assert(
      titleParam === "Q1 2026 Compliance Checklist",
      "innocuous: title preserved verbatim (test isn't a tautology)",
    );
    assert(
      notesParam === "Reviewed by audit team on 2026-01-15. Ticket ABC-123.",
      "innocuous: notes preserved verbatim",
    );
    assert(
      !titleParam.includes(REDACTED_SENTINEL) &&
        !notesParam.includes(REDACTED_SENTINEL),
      "innocuous: REDACTED sentinel NOT present (regex is targeted)",
    );
    const regCodes = params[7] as unknown;
    assert(
      Array.isArray(regCodes) &&
        (regCodes as unknown[]).length === 2 &&
        (regCodes as unknown[])[0] === "PDPL" &&
        (regCodes as unknown[])[1] === "ISO-27001",
      "innocuous: regulation_codes array preserved verbatim",
    );
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log();
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error(
    "\n❌ qmsDocsDatabase tests FAILED — secrets may leak into qms_uploaded_documents.",
  );
  process.exit(1);
}

console.log("\n✅ All qmsDocsDatabase tests passed");
process.exit(0);
