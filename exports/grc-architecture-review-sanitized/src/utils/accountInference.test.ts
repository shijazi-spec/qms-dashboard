/**
 * CI gate: prevents accountInference write paths from persisting unmasked
 * secrets into `account_inference_hints`.
 *
 * Run:    npx tsx src/utils/accountInference.test.ts
 * Wired:  scripts/post-merge.sh (auto-discovered by tests/runIntegrationTests.ts)
 *
 * accountInference has two public write functions:
 *
 *   • scanDealsForAccountHints() — walks duplicate_records and INSERTs into
 *     account_inference_hints (ON CONFLICT DO UPDATE). The INSERT writes only
 *     derived columns (deal_id, candidate account_id, suggested_account_name,
 *     suggested_domain, evidence_contact_id, evidence_contact_email,
 *     confidence). Critically, the deal's `raw_data` JSON blob — which can
 *     contain arbitrary CRMProvider payload fields — is NEVER part of the INSERT
 *     params vector.
 *   • setHintStatus(hintId, status) — UPDATE with [hintId, status] only.
 *
 * The tests below mock pg.Pool.prototype.query so the module never touches a
 * real DB, drive each write function with mocked SELECT rows that embed every
 * required deny-list key (password_hash, mfa_secret, access_token,
 * refresh_token, api_key) inside the deal `raw_data` payload AND inside the
 * candidate account's textual fields (account_name / email), and assert the
 * raw secret strings never reach the INSERT/UPDATE params vector.
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

// ---------------------------------------------------------------------------
// Patch pg.Pool.prototype.query BEFORE importing the module under test so the
// local pool inside duplicateRadarDatabase (which accountInference re-imports)
// never opens a real connection.
// ---------------------------------------------------------------------------

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

const REDACTED_SENTINEL = "***REDACTED***";

// Secret-shaped values chosen so each one is reliably caught by the
// `createRedactedPool` wrapper that `duplicateRadarDatabase` installs around
// every pool.query() call. Specifically:
//   • password_hash → 50-char mixed case+digit body, caught by the
//                     high-entropy heuristic (not the bcrypt regex, whose
//                     `[./A-Za-z0-9]{53}` body requirement is stricter than
//                     this fixture)
//   • mfa_secret    → 32-char mixed case+digit string, high Shannon entropy
//                     (caught by the high-entropy heuristic, not by key name)
//   • access_token  → `ya29.…` matches the IdentityProvider-oauth regex
//   • refresh_token → 40-char mixed case+digit, high Shannon entropy
//   • api_key       → `sk-…` matches the sk-key regex
const SECRETS = {
  password_hash: "$2b$12$abcdefghij1234567890uvwxyzABCDEFGHIJKLMNOPQRSTUVWXY",
  mfa_secret: "Jb7SwY3dPeHpK3pXqMnZv5RtUfCgWh2K",
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

// Programmable handler: each test installs a function that, given (sql, params),
// returns the mocked rows. The default returns empty.
let handler: (sql: string, params: unknown[]) => QueryResultRow[] = () => [];

const mockQuery: MockedPoolQuery = (sql, params = []) => {
  const sqlStr = typeof sql === "string" ? sql : sql.text;
  const paramArr = Array.isArray(params) ? params : [];
  captured.push({ sql: sqlStr, params: paramArr });
  const rows = handler(sqlStr, paramArr);
  return Promise.resolve({
    rows,
    rowCount: rows.length,
    command: "",
    oid: 0,
    fields: [],
  });
};

(Pool.prototype as unknown as { query: MockedPoolQuery }).query = mockQuery;

// Import AFTER the mock is in place.
const { scanDealsForAccountHints, setHintStatus } = await import(
  "./accountInference"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lastInsertParams(): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const c = captured[i];
    if (c.sql.replace(/\s+/g, " ").trim().toUpperCase().startsWith("INSERT INTO")) {
      return c.params;
    }
  }
  return null;
}

function lastUpdateParams(): unknown[] | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const c = captured[i];
    if (/^\s*UPDATE\s+/i.test(c.sql)) {
      return c.params;
    }
  }
  return null;
}

/** Flatten any value into a string so we can search for raw-secret leakage. */
function serializeParams(params: unknown[]): string {
  return params
    .map((p) => {
      if (p === null || p === undefined) return "";
      if (typeof p === "string") return p;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Section 1 — scanDealsForAccountHints: deny-list keys nested in raw_data
//
// Inject every required deny-list key into the deal's raw_data payload as
// both top-level keys AND nested string values. The INSERT into
// account_inference_hints writes only derived columns; raw_data must NOT
// reach the params vector.
// ---------------------------------------------------------------------------

console.log(
  "\n=== scanDealsForAccountHints — raw_data secret leakage to INSERT params ===\n",
);

{
  captured.length = 0;

  // Build a raw_data blob that contains every deny-list key plus a CRMProvider
  // Contact_Name reference so the inference path completes through to INSERT.
  const dirtyRawData: Record<string, unknown> = {
    Contact_Name: { id: "CRMProvider-contact-1", name: "Alice" },
  };
  for (const k of REQUIRED_DENY_KEYS) {
    dirtyRawData[k] = SECRETS[k];
  }
  dirtyRawData["nested"] = { ...SECRETS };

  handler = (sql, params) => {
    const s = sql.replace(/\s+/g, " ").trim();
    // 1. Deal scan
    if (s.startsWith("SELECT r.id, r.CRMProvider_record_id, r.account_name")) {
      return [
        {
          id: 101,
          CRMProvider_record_id: "deal-z-1",
          account_name: null,
          company_name: null,
          domain: null,
          raw_data: dirtyRawData,
          cluster_id: null,
          cluster_domain: null,
        },
      ];
    }
    // 2. Contact lookup by CRMProvider ids
    if (s.startsWith("SELECT id, CRMProvider_record_id, email, domain")) {
      return [
        {
          id: 202,
          CRMProvider_record_id: "CRMProvider-contact-1",
          email: "user@example.invalid",
          domain: "Example Organization.example",
        },
      ];
    }
    // 3. Candidate account lookup by domain
    if (s.startsWith("SELECT a.id,")) {
      return [
        {
          id: 303,
          CRMProvider_record_id: "acct-z-1",
          account_name: "Example Organization",
          company_name: "Example Organization",
          domain: "Example Organization.example",
          email: "user@example.invalid",
          has_explicit_domain: true,
          related_record_count: 5,
        },
      ];
    }
    // 4. The INSERT itself — return inserted=true
    if (s.startsWith("INSERT INTO account_inference_hints")) {
      return [{ inserted: true }];
    }
    return [];
  };

  await scanDealsForAccountHints();

  const params = lastInsertParams();
  assert(
    params !== null,
    "raw_data: INSERT INTO account_inference_hints was issued",
  );
  if (params) {
    const blob = serializeParams(params);
    for (const k of REQUIRED_DENY_KEYS) {
      assert(
        !blob.includes(SECRETS[k]),
        `raw_data/${k}: raw secret value is NOT present in INSERT params`,
      );
    }
    // Anti-tautology: the legitimate derived values DID make it in.
    assert(
      blob.includes("Example Organization") || blob.includes("Example Organization.example"),
      "raw_data/derived: legitimate suggested_account_name or domain IS present (test isn't a tautology)",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 2 — scanDealsForAccountHints: deny-list keys embedded in candidate
// account textual fields (account_name, email) that DO flow into INSERT.
//
// suggested_account_name = account.account_name || account.company_name and
// evidence_contact_email = primary contact email. If a deny-list-shaped
// substring is present in those fields, it WILL reach the INSERT params —
// the test asserts the redaction sentinel is applied before persistence.
// ---------------------------------------------------------------------------

console.log(
  "\n=== scanDealsForAccountHints — secret-shaped substrings in account/email fields ===\n",
);

for (const key of REQUIRED_DENY_KEYS) {
  captured.length = 0;
  const raw = SECRETS[key];

  // Place the raw secret inside the account_name and contact email so it
  // flows naturally into the INSERT.
  const pollutedAccountName = `Example Organization ${raw} Holdings`;
  const pollutedEmail = `ops+${raw}@Example Organization.example`;

  handler = (sql) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT r.id, r.CRMProvider_record_id, r.account_name")) {
      return [
        {
          id: 101,
          CRMProvider_record_id: "deal-z-1",
          account_name: null,
          company_name: null,
          domain: null,
          raw_data: { Contact_Name: { id: "CRMProvider-contact-1", name: "Alice" } },
          cluster_id: null,
          cluster_domain: null,
        },
      ];
    }
    if (s.startsWith("SELECT id, CRMProvider_record_id, email, domain")) {
      return [
        {
          id: 202,
          CRMProvider_record_id: "CRMProvider-contact-1",
          email: pollutedEmail,
          domain: "Example Organization.example",
        },
      ];
    }
    if (s.startsWith("SELECT a.id,")) {
      return [
        {
          id: 303,
          CRMProvider_record_id: "acct-z-1",
          account_name: pollutedAccountName,
          company_name: "Example Organization",
          domain: "Example Organization.example",
          email: "user@example.invalid",
          has_explicit_domain: true,
          related_record_count: 5,
        },
      ];
    }
    if (s.startsWith("INSERT INTO account_inference_hints")) {
      return [{ inserted: true }];
    }
    return [];
  };

  await scanDealsForAccountHints();

  const params = lastInsertParams();
  assert(
    params !== null,
    `inline/${key}: INSERT INTO account_inference_hints was issued`,
  );
  if (params) {
    const blob = serializeParams(params);
    assert(
      !blob.includes(raw),
      `inline/${key}: raw secret value is NOT present in INSERT params (suggested_account_name / evidence_contact_email)`,
    );
    assert(
      blob.includes(REDACTED_SENTINEL),
      `inline/${key}: REDACTED sentinel IS present in INSERT params`,
    );
  }
}

// ---------------------------------------------------------------------------
// Section 3 — setHintStatus: status enum is the only writable value; raw
// secret strings passed through the status arg (defensive) must never
// surface verbatim in UPDATE params.
// ---------------------------------------------------------------------------

console.log(
  "\n=== setHintStatus — UPDATE params secret-leak check ===\n",
);

for (const key of REQUIRED_DENY_KEYS) {
  captured.length = 0;
  const raw = SECRETS[key];

  handler = (sql) => {
    if (/^\s*UPDATE\s+/i.test(sql)) {
      return [{ id: 42 }];
    }
    return [];
  };

  // The signature restricts status to "dismissed" | "applied" at the type
  // layer. Runtime defense: pass a polluted value via `as any` to confirm
  // the UPDATE params vector never surfaces the raw secret verbatim.
  await setHintStatus(42, `dismissed-${raw}` as unknown as "dismissed");

  const params = lastUpdateParams();
  assert(params !== null, `setHintStatus/${key}: UPDATE was issued`);
  if (params) {
    const blob = serializeParams(params);
    assert(
      !blob.includes(raw),
      `setHintStatus/${key}: raw secret value is NOT present in UPDATE params`,
    );
  }
}

// ---------------------------------------------------------------------------
// Non-secret pass-through: ordinary status values must round-trip verbatim
// (anti-tautology — proves the assertions above aren't passing because every
// value gets stripped).
// ---------------------------------------------------------------------------

{
  captured.length = 0;
  handler = (sql) => {
    if (/^\s*UPDATE\s+/i.test(sql)) return [{ id: 7 }];
    return [];
  };
  await setHintStatus(7, "applied");
  const params = lastUpdateParams();
  assert(params !== null, "setHintStatus/non-sensitive: UPDATE was issued");
  if (params) {
    assert(
      params.includes(7) || params.includes("7"),
      "setHintStatus/non-sensitive: hintId is preserved verbatim",
    );
    assert(
      params.includes("applied"),
      "setHintStatus/non-sensitive: status 'applied' is preserved verbatim",
    );
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== accountInference secret-leak: ${passed} passed, ${failed} failed ===\n`);

if (failed > 0) {
  process.exit(1);
}
