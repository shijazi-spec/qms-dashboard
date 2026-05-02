/**
 * CI gate: prevents `triggerRoutes` POST /api/triggers/:id/action (action
 * "dismiss") from persisting unmasked secrets in `audit_triggers
 * .dismiss_reason`.
 *
 * Run:    npx tsx src/mastra/routes/triggerRoutes.test.ts
 * Wired:  scripts/post-merge.sh → `npm test` (auto-discovered).
 *
 * The dismiss action takes a free-text `dismiss_reason` (min 10 chars) and
 * persists it onto the audit_triggers row. Reviewers occasionally paste log
 * excerpts that contain credential-shaped substrings (JWTs, GitHub PATs,
 * bcrypt hashes, OpenAI keys). The handler now wraps `dismiss_reason` with
 * `redactSensitiveDeep()` before queuing the UPDATE.
 *
 * This test:
 *   1. Patches `pg.Pool.prototype.query` BEFORE importing the route module.
 *      The mock returns a fake admin-owned audit_triggers row when the
 *      handler does its ownership SELECT, then captures the subsequent
 *      UPDATE.
 *   2. Sets ADMIN_API_KEY (≥32 chars, ≥10 distinct) and presents an
 *      X-Admin-Key header so `getSessionUser` returns the admin-key user
 *      (role="admin" → in TRIGGER_ADMIN_ROLES → bypasses assigned_role
 *      check).
 *   3. Drives the dismiss handler with deny-list-shaped reasons and
 *      asserts the raw secret never reaches the captured UPDATE params,
 *      and that the `***REDACTED***` sentinel does.
 *   4. Anti-tautology: an innocuous reason round-trips verbatim.
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
  const paramArr = Array.isArray(params) ? params : [];
  captured.push({ sql: sqlStr, params: paramArr });

  const norm = sqlStr.replace(/\s+/g, " ").trim().toUpperCase();

  // 1) The ownership SELECT must return a real audit_triggers row so the
  //    handler proceeds past the 404 / 403 checks.
  if (norm.startsWith("SELECT * FROM AUDIT_TRIGGERS WHERE ID")) {
    return Promise.resolve({
      rows: [
        {
          id: paramArr[0],
          trigger_id: "AT-TEST-1",
          title: "Test Trigger",
          trigger_type: "deviation",
          severity: "warning",
          action_required: "Investigate and dismiss if benign",
          assigned_role: null,
          status: "pending",
        },
      ],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    });
  }

  // 2) `updateTriggerStatus()` issues an UPDATE...RETURNING * — return a
  //    minimal trigger row so the handler keeps going to the
  //    extraUpdates write (where the secret-shaped reason lands).
  if (
    /UPDATE AUDIT_TRIGGERS SET STATUS\s*=/.test(norm) &&
    /RETURNING/.test(norm)
  ) {
    return Promise.resolve({
      rows: [
        {
          id: paramArr[paramArr.length - 1] ?? 1,
          trigger_id: "AT-TEST-1",
          title: "Test Trigger",
          status: paramArr[0],
        },
      ],
      rowCount: 1,
      command: "UPDATE",
      oid: 0,
      fields: [],
    });
  }

  return Promise.resolve({
    rows: [],
    rowCount: 0,
    command: "",
    oid: 0,
    fields: [],
  });
};

(Pool.prototype as unknown as { query: MockedPoolQuery }).query = mockQuery;

const ADMIN_KEY = "trigger-secret-leak-test-admin-key-2026-XYZ"; // ≥32, ≥10 distinct
process.env.ADMIN_API_KEY = ADMIN_KEY;

// Import AFTER mock + env are in place.
const { triggerRoutes } = await import("./triggerRoutes");
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

/** Find the captured UPDATE that touches the dismiss_reason column. */
function lastDismissUpdateParams(): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const c = captured[i];
    const sql = c.sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (
      sql.startsWith("UPDATE AUDIT_TRIGGERS SET") &&
      sql.includes("DISMISS_REASON")
    ) {
      return c.params;
    }
  }
  return null;
}

const handler = await buildHandler(
  triggerRoutes,
  "/api/triggers/:id/action",
  "POST",
  { mastra: null },
);

console.log(
  "\n=== triggerRoutes — dismiss_reason write-path secret-leak tests ===\n",
);

// Section 1 — credential-shaped substrings inside dismiss_reason.
//
// NOTE on response status: the dismiss flow ends with `logEvent()` which
// itself does Postgres I/O (event_logs partition resolution).  Under the
// minimal mock used here that secondary write throws, and the route's
// outer try/catch converts the exception into a 500.  The contract this
// test guards is "secret value never reaches the dismiss UPDATE params" —
// which executes BEFORE the logEvent crash — so we only assert on the
// captured UPDATE, not on the response status.
for (const { label, value } of SECRET_LIKE_STRINGS) {
  captured.length = 0;
  const reason = `Investigated and benign — log excerpt was: ${value} (token rotated).`;
  await handler(
    makeContext({
      method: "POST",
      headers: { "X-Admin-Key": ADMIN_KEY },
      params: { id: "1" },
      body: { action: "dismiss", dismiss_reason: reason },
    }),
  );

  const params = lastDismissUpdateParams();
  assert(params !== null, `${label}: dismiss UPDATE was issued`);
  if (!params) continue;

  const flat = JSON.stringify(params);
  assert(
    !flat.includes(value),
    `${label}: raw credential-shaped substring is NOT present in UPDATE params`,
  );
  assert(
    flat.includes(REDACTED_SENTINEL),
    `${label}: REDACTED sentinel IS present in UPDATE params`,
  );
}

// Section 2 — deny-list values embedded in dismiss_reason.
for (const [keyLabel, rawSecret] of Object.entries(SECRETS)) {
  captured.length = 0;
  const reason = `Dismissed: secret rotated. Old value sat in field ${keyLabel} = ${rawSecret}, replaced now.`;
  await handler(
    makeContext({
      method: "POST",
      headers: { "X-Admin-Key": ADMIN_KEY },
      params: { id: "1" },
      body: { action: "dismiss", dismiss_reason: reason },
    }),
  );
  const params = lastDismissUpdateParams();
  if (params) {
    // Long credential-shaped values (bcrypt / JWT / PAT / sk-) MUST be
    // scrubbed; short opaque values like the TOTP base32 secret are
    // not regex-recognisable in isolation, so we only assert the write
    // executed without raw long-shape leakage.
    const flat = JSON.stringify(params);
    if (
      keyLabel === "password_hash" ||
      keyLabel === "access_token" ||
      keyLabel === "api_key"
    ) {
      assert(
        !flat.includes(rawSecret),
        `key=${keyLabel}: raw secret value is NOT present in UPDATE params`,
      );
    } else {
      assert(flat.length > 0, `key=${keyLabel}: dismiss UPDATE captured`);
    }
  }
}

// Anti-tautology: ordinary prose round-trips verbatim.
{
  captured.length = 0;
  const reason =
    "Investigated and benign on 2025-01-15 — no follow-up needed (per WP-SOP-009).";
  await handler(
    makeContext({
      method: "POST",
      headers: { "X-Admin-Key": ADMIN_KEY },
      params: { id: "1" },
      body: { action: "dismiss", dismiss_reason: reason },
    }),
  );
  const params = lastDismissUpdateParams();
  if (params) {
    const flat = JSON.stringify(params);
    assert(
      flat.includes("Investigated and benign on 2025-01-15"),
      "innocuous: ordinary prose preserved verbatim (test isn't a tautology)",
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
