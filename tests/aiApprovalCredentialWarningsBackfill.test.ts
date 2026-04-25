/**
 * Tests for the historical ai_pending_actions credential-warnings backfill
 * (Task #480 — `backfillAiPendingActionsCredentialWarnings`).
 *
 * Verifies that the sweep:
 *
 *   1. Selects only rows whose `credential_warnings` column is empty
 *      (`'[]'::jsonb`) — pre-Task-#477 legacy rows.
 *   2. Runs `detectCredentialLikeFields()` over the persisted (redacted)
 *      payload + payload_preview and writes the resulting warnings back.
 *   3. Reports per-pass counters: scanned rows, rows updated, total
 *      warnings added — these populate the boot-sweep audit-log entry.
 *   4. Is idempotent — a second pass over the now-flagged dataset
 *      issues 0 UPDATEs because the WHERE filter excludes already-
 *      backfilled rows.
 *   5. Leaves rows with no credential-shaped values at the column
 *      default (no UPDATE issued).
 *   6. Re-asserts the empty-array predicate in the UPDATE so a
 *      concurrent live INSERT cannot have its newer warnings clobbered.
 *
 * Run:  npx tsx tests/aiApprovalCredentialWarningsBackfill.test.ts
 */

import {
  backfillAiPendingActionsCredentialWarnings,
  type AiPendingActionsCredentialWarningsBackfillResult,
} from "../src/utils/redactHistoricalLogs";

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

interface RowState {
  id: number;
  payload: any;
  payload_preview: string;
  /** Stored as the parsed JS array, mirroring how `pg` hydrates JSONB. */
  credential_warnings: any[];
}

interface CapturedUpdate {
  sql: string;
  params: ReadonlyArray<unknown>;
}

function makeStubClient(initialRows: RowState[]): {
  client: {
    query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<any>;
  };
  updates: CapturedUpdate[];
  rows: RowState[];
} {
  const rows = initialRows.map((r) => ({
    ...r,
    payload: structuredClone(r.payload),
    credential_warnings: structuredClone(r.credential_warnings),
  }));
  const updates: CapturedUpdate[] = [];

  const query = async (sql: string, params: ReadonlyArray<unknown> = []) => {
    if (/^\s*SELECT/i.test(sql)) {
      // Honour the `WHERE id > $1 AND credential_warnings = '[]'::jsonb`
      // contract so the test exercises the same row-set the production
      // SELECT would.
      const cursor = params[0] as number;
      const limit = params[1] as number;
      const filtered = rows
        .filter(
          (r) =>
            r.id > cursor &&
            Array.isArray(r.credential_warnings) &&
            r.credential_warnings.length === 0,
        )
        .sort((a, b) => a.id - b.id)
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          payload: r.payload,
          payload_preview: r.payload_preview,
        }));
      return { rows: filtered, rowCount: filtered.length };
    }
    if (/^\s*UPDATE\s+ai_pending_actions/i.test(sql)) {
      updates.push({ sql, params });
      const id = params[1] as number;
      const target = rows.find((r) => r.id === id);
      // Honour the `AND credential_warnings = '[]'::jsonb` predicate so
      // the test reflects the live optimistic-concurrency guard.
      if (
        target &&
        Array.isArray(target.credential_warnings) &&
        target.credential_warnings.length === 0
      ) {
        target.credential_warnings = JSON.parse(String(params[0]));
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };

  return { client: { query }, updates, rows };
}

async function run(): Promise<void> {
  console.log(
    "\n[redactHistoricalLogs] ai_pending_actions credential-warnings backfill",
  );

  // Token-prefix shapes the redactor would normally catch — used here as
  // *post-redaction residue* the detector should still flag (the sweep
  // exists to surface tell-tale shapes the redactor missed).
  const SECRET_KEY = "sk-live-LEAKED_LEGACY_KEY_ABCDEFGHIJKLMNOP";
  const SECRET_GH = "ghp_legacyTokenInPayload1234567890abcdef";
  const SECRET_JWT =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI5OTk5OTkifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const SAFE_PROSE = "Rotate API key for zoho_books integration";

  const initial: RowState[] = [
    {
      // Legacy row: leaked sk-… in payload.note + ghp_… in preview.
      id: 1,
      payload: {
        target_integration: "zoho_books",
        note: `previous=${SECRET_KEY}`,
      },
      payload_preview: `${SAFE_PROSE} (gh=${SECRET_GH})`,
      credential_warnings: [],
    },
    {
      // Legacy row: clean payload, only a JWT in the preview.
      id: 2,
      payload: { target: "auth_session" },
      payload_preview: `Replay session token=${SECRET_JWT}`,
      credential_warnings: [],
    },
    {
      // Legacy row: clean — nothing for the detector to flag.
      id: 3,
      payload: { target_integration: "stripe", note: "no secret here" },
      payload_preview: "Rotate Stripe webhook signing key (id=we_abc123)",
      credential_warnings: [],
    },
    {
      // Post-Task-#477 row that already has a non-empty warning array —
      // the backfill must NOT touch it (would double-warn or clobber).
      id: 4,
      payload: { target: "zoho_books", note: SAFE_PROSE },
      payload_preview: SAFE_PROSE,
      credential_warnings: [{ path: "payload.api_key", kind: "sensitive-key" }],
    },
  ];

  const stub1 = makeStubClient(initial);
  const result1: AiPendingActionsCredentialWarningsBackfillResult =
    await backfillAiPendingActionsCredentialWarnings(stub1.client);

  assert(
    result1.scanned === 3,
    `scanned only the 3 rows with empty credential_warnings (got ${result1.scanned})`,
  );
  assert(
    result1.rowsUpdated === 2,
    `rowsUpdated counts the 2 legacy rows that produced warnings (got ${result1.rowsUpdated})`,
  );
  assert(
    result1.warningsAdded >= 2,
    `warningsAdded sums per-row warning counts (got ${result1.warningsAdded})`,
  );
  assert(stub1.updates.length === 2, "exactly 2 UPDATE statements issued");

  const row1 = stub1.rows.find((r) => r.id === 1)!;
  assert(
    Array.isArray(row1.credential_warnings) &&
      row1.credential_warnings.length > 0,
    "row 1 (legacy with sk-/ghp- residue) gains a non-empty credential_warnings array",
  );
  assert(
    row1.credential_warnings.some(
      (w: any) =>
        typeof w.path === "string" &&
        w.path.startsWith("payload.") &&
        typeof w.kind === "string",
    ),
    "row 1 warnings include a payload-rooted entry with the expected shape",
  );
  assert(
    row1.credential_warnings.some(
      (w: any) =>
        w.path === "payload_preview" || w.path?.startsWith("payload_preview"),
    ),
    "row 1 warnings include a payload_preview-rooted entry",
  );

  const row2 = stub1.rows.find((r) => r.id === 2)!;
  assert(
    row2.credential_warnings.length > 0 &&
      row2.credential_warnings.every(
        (w: any) => typeof w.path === "string" && typeof w.kind === "string",
      ),
    "row 2 (preview-only JWT) gains a well-formed warning entry",
  );

  const row3 = stub1.rows.find((r) => r.id === 3)!;
  assert(
    Array.isArray(row3.credential_warnings) &&
      row3.credential_warnings.length === 0,
    "row 3 (clean control) is left at the default empty array — no UPDATE issued",
  );

  const row4 = stub1.rows.find((r) => r.id === 4)!;
  assert(
    row4.credential_warnings.length === 1 &&
      row4.credential_warnings[0].path === "payload.api_key",
    "row 4 (already-flagged) is excluded by the WHERE filter — unchanged",
  );

  // ---- Idempotency: a second pass over the now-backfilled dataset is a no-op
  const stub2 = makeStubClient(stub1.rows);
  const result2 = await backfillAiPendingActionsCredentialWarnings(
    stub2.client,
  );

  assert(
    result2.scanned === 1,
    `second pass only scans the still-empty row 3 (got ${result2.scanned})`,
  );
  assert(
    result2.rowsUpdated === 0,
    `second pass updates 0 rows (got ${result2.rowsUpdated}) — sweep is idempotent`,
  );
  assert(stub2.updates.length === 0, "second pass issues no UPDATE statements");

  // ---- Concurrent-write guard: simulate a live INSERT racing the sweep.
  // The SELECT returns the row as empty, but between SELECT and UPDATE
  // the live path populates credential_warnings. The UPDATE must see
  // `rowCount = 0` (predicate fails) and NOT count the row as updated.
  const racy: RowState[] = [
    {
      id: 50,
      payload: { note: `previous=${SECRET_KEY}` },
      payload_preview: SAFE_PROSE,
      credential_warnings: [],
    },
  ];
  const racyStub = makeStubClient(racy);
  // Wrap query so that immediately AFTER the SELECT returns, we mutate
  // the row to simulate the racing live-path INSERT/UPDATE.
  const originalQuery = racyStub.client.query;
  racyStub.client.query = async (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => {
    const result = await originalQuery(sql, params);
    if (/^\s*SELECT/i.test(sql) && result.rows.length > 0) {
      // Live-path race: someone wrote a non-empty warning array.
      const target = racyStub.rows.find((r) => r.id === 50);
      if (target) {
        target.credential_warnings = [
          { path: "payload.api_key", kind: "sensitive-key" },
        ];
      }
    }
    return result;
  };

  const racyResult = await backfillAiPendingActionsCredentialWarnings(
    racyStub.client,
  );

  assert(
    racyResult.scanned === 1,
    `racy fixture: row was selected before the race (got scanned=${racyResult.scanned})`,
  );
  assert(
    racyResult.rowsUpdated === 0,
    `racy fixture: UPDATE predicate prevents clobbering live warnings (got rowsUpdated=${racyResult.rowsUpdated})`,
  );
  assert(
    racyStub.rows[0].credential_warnings.length === 1 &&
      racyStub.rows[0].credential_warnings[0].path === "payload.api_key",
    "racy fixture: live-path warnings preserved verbatim — not overwritten by the sweep",
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
