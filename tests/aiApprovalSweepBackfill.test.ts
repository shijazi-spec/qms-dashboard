/**
 * Tests for the historical ai_pending_actions backfill sweep.
 *
 * Covers Task #85 — verifies that `redactAiPendingActions()` in
 * `src/utils/redactHistoricalLogs.ts` rewrites pre-fix `payload_preview`
 * rows that contain credential-shaped substrings, leaves clean rows
 * untouched, is idempotent on a second pass, and reports the per-column
 * scanned/changed counters the audit-log entry consumes.
 *
 * Run:  npx tsx tests/aiApprovalSweepBackfill.test.ts
 */

import {
  redactAiPendingActions,
  type AiPendingActionsSweepResult,
} from "../src/utils/redactHistoricalLogs";
import { REDACTED_SENTINEL } from "../src/utils/eventLogsDatabase";

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
  execution_result: any | null;
}

interface CapturedUpdate {
  sql: string;
  params: ReadonlyArray<unknown>;
}

function makeStubClient(initialRows: RowState[]): {
  client: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<any> };
  updates: CapturedUpdate[];
  rows: RowState[];
} {
  const rows = initialRows.map(r => ({ ...r, payload: structuredClone(r.payload), execution_result: r.execution_result === null ? null : structuredClone(r.execution_result) }));
  const updates: CapturedUpdate[] = [];

  const query = async (sql: string, params: ReadonlyArray<unknown> = []) => {
    if (/^\s*SELECT/i.test(sql)) {
      return { rows: rows.map(r => ({ ...r })), rowCount: rows.length };
    }
    if (/^\s*UPDATE\s+ai_pending_actions/i.test(sql)) {
      updates.push({ sql, params });
      const id = params[3] as number;
      const target = rows.find(r => r.id === id);
      if (target) {
        target.payload = params[0] != null ? JSON.parse(String(params[0])) : null;
        target.payload_preview = params[1] as string;
        target.execution_result = params[2] != null ? JSON.parse(String(params[2])) : null;
      }
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  return { client: { query }, updates, rows };
}

async function run(): Promise<void> {
  console.log("\n[redactHistoricalLogs] ai_pending_actions backfill sweep");

  const SECRET_KEY = "sk-live-LEAKED_PREVIEW_KEY_ABCDEFGHIJKLMNOP";
  const SECRET_GH = "ghp_leakedTokenInPreview1234567890abcdef";
  const SECRET_BCRYPT = "$2b$12$abcdefghijklmnopqrstuv1234567890ABCDEFGHIJKLMNOPQRSTU";
  const SECRET_JWT =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI5OTk5OTkifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const SAFE_PROSE = "Rotate API key for zoho_books integration";

  const initial: RowState[] = [
    {
      id: 1,
      payload: { target_integration: "zoho_books", note: SAFE_PROSE },
      payload_preview: `${SAFE_PROSE} — new key=${SECRET_KEY}, gh=${SECRET_GH}`,
      execution_result: null,
    },
    {
      id: 2,
      payload: { target: "auth_session" },
      payload_preview: `Replay session token=${SECRET_JWT}; legacy_hash=${SECRET_BCRYPT}`,
      execution_result: null,
    },
    {
      id: 3,
      payload: { target_integration: "stripe", note: "no secret here" },
      payload_preview: "Rotate Stripe webhook signing key (id=we_abc123)",
      execution_result: null,
    },
    {
      id: 4,
      payload: { target_integration: "zoho_books" },
      payload_preview: `Already redacted preview — key=${REDACTED_SENTINEL}`,
      execution_result: null,
    },
  ];

  const stub1 = makeStubClient(initial);
  const result1: AiPendingActionsSweepResult = await redactAiPendingActions(stub1.client);

  assert(result1.scanned === 4, `scanned all 4 rows (got ${result1.scanned})`);
  assert(
    result1.previewChanged === 2,
    `payload_preview rewritten on the 2 leaky rows (got ${result1.previewChanged})`,
  );
  assert(
    result1.rowsUpdated === 2,
    `total rows updated = 2 (got ${result1.rowsUpdated})`,
  );
  assert(
    result1.payloadChanged === 0 && result1.executionResultChanged === 0,
    "JSONB columns untouched in this fixture (no key-deny-list matches)",
  );
  assert(stub1.updates.length === 2, "exactly 2 UPDATE statements issued");

  const row1 = stub1.rows.find(r => r.id === 1)!;
  assert(
    !row1.payload_preview.includes(SECRET_KEY) &&
      !row1.payload_preview.includes(SECRET_GH),
    "row 1 preview no longer contains sk-… or ghp_… tokens",
  );
  assert(
    row1.payload_preview.includes(REDACTED_SENTINEL),
    "row 1 preview contains the redaction sentinel",
  );
  assert(
    row1.payload_preview.includes("Rotate API key") &&
      row1.payload_preview.includes("zoho_books"),
    "row 1 preview preserves the surrounding human-readable prose",
  );

  const row2 = stub1.rows.find(r => r.id === 2)!;
  assert(
    !row2.payload_preview.includes(SECRET_JWT) &&
      !row2.payload_preview.includes(SECRET_BCRYPT) &&
      !row2.payload_preview.includes("$2b$12$"),
    "row 2 preview no longer contains the JWT or bcrypt hash",
  );

  const row3 = stub1.rows.find(r => r.id === 3)!;
  assert(
    row3.payload_preview === "Rotate Stripe webhook signing key (id=we_abc123)",
    "row 3 (clean control) preview is byte-identical — no UPDATE issued",
  );

  const row4 = stub1.rows.find(r => r.id === 4)!;
  assert(
    row4.payload_preview === `Already redacted preview — key=${REDACTED_SENTINEL}`,
    "row 4 (already-redacted) preview is byte-identical — no UPDATE issued",
  );

  // ---- Idempotency: a second pass over the now-clean dataset must be a no-op
  const stub2 = makeStubClient(stub1.rows);
  const result2 = await redactAiPendingActions(stub2.client);

  assert(result2.scanned === 4, "second pass still scans all 4 rows");
  assert(
    result2.rowsUpdated === 0,
    `second pass updates 0 rows (got ${result2.rowsUpdated}) — script is idempotent`,
  );
  assert(
    result2.previewChanged === 0 &&
      result2.payloadChanged === 0 &&
      result2.executionResultChanged === 0,
    "second pass reports zero per-column changes",
  );
  assert(stub2.updates.length === 0, "second pass issues no UPDATE statements");

  // ---- Combined column changes: payload + preview both dirty in same row
  const combined: RowState[] = [
    {
      id: 10,
      payload: { api_key: SECRET_KEY, note: SAFE_PROSE },
      payload_preview: `Issued key ${SECRET_GH}`,
      execution_result: { data: { access_token: "eyJhbGci_freshtoken" } },
    },
  ];
  const stub3 = makeStubClient(combined);
  const result3 = await redactAiPendingActions(stub3.client);

  assert(
    result3.payloadChanged === 1 &&
      result3.previewChanged === 1 &&
      result3.executionResultChanged === 1,
    "combined-fixture row reports change on payload, preview, AND execution_result",
  );
  assert(
    result3.rowsUpdated === 1,
    "combined-fixture row counts as a single UPDATE",
  );
  const combinedRow = stub3.rows[0];
  assert(
    combinedRow.payload.api_key === REDACTED_SENTINEL &&
      combinedRow.payload.note === SAFE_PROSE,
    "key-based deny-list still scrubs JSONB payload sensitive keys",
  );
  assert(
    !combinedRow.payload_preview.includes(SECRET_GH) &&
      combinedRow.payload_preview.includes(REDACTED_SENTINEL),
    "preview regex deny-list scrubs ghp_… tokens",
  );
  assert(
    combinedRow.execution_result?.data?.access_token === REDACTED_SENTINEL,
    "execution_result.data.access_token redacted by key-based deny-list",
  );

  // ---- Deep regex scrubbing of JSONB string leaves under non-sensitive keys
  // Task #100/#102: redactAiPendingActions must apply the deep-string redaction
  // AFTER redactSensitiveFields so that credential-shaped substrings embedded
  // in innocuously-named keys (note, summary, message) are also swept.
  const deepLeafRows: RowState[] = [
    {
      id: 20,
      payload: {
        target: "zoho_books",
        note: `Previous key was ${SECRET_KEY}`,
        meta: { summary: `issued to ${SECRET_GH}`, count: 5 },
      },
      payload_preview: "no secret here",
      execution_result: {
        result: "ok",
        message: `Session token: ${SECRET_JWT}; hash: ${SECRET_BCRYPT}`,
      },
    },
    {
      id: 21,
      payload: { target: "stripe", note: "no credential here" },
      payload_preview: "clean preview",
      execution_result: null,
    },
  ];
  const stub4 = makeStubClient(deepLeafRows);
  const result4 = await redactAiPendingActions(stub4.client);

  assert(
    result4.scanned === 2,
    `deep-leaf fixture: scanned 2 rows (got ${result4.scanned})`,
  );
  assert(
    result4.payloadChanged === 1,
    `deep-leaf fixture: payload changed on 1 row (got ${result4.payloadChanged})`,
  );
  assert(
    result4.executionResultChanged === 1,
    `deep-leaf fixture: execution_result changed on 1 row (got ${result4.executionResultChanged})`,
  );
  assert(
    result4.rowsUpdated === 1,
    `deep-leaf fixture: 1 row updated total (got ${result4.rowsUpdated})`,
  );

  const deepRow20 = stub4.rows.find(r => r.id === 20)!;
  assert(
    !JSON.stringify(deepRow20.payload).includes(SECRET_KEY),
    "deep-leaf: sk_ key under innocuous 'note' key removed from payload",
  );
  assert(
    !JSON.stringify(deepRow20.payload).includes(SECRET_GH),
    "deep-leaf: ghp_ token under 'meta.summary' removed from payload",
  );
  assert(
    deepRow20.payload.meta.count === 5,
    "deep-leaf: numeric leaf under 'meta.count' preserved in payload",
  );
  assert(
    !JSON.stringify(deepRow20.execution_result).includes(SECRET_JWT) &&
      !JSON.stringify(deepRow20.execution_result).includes(SECRET_BCRYPT),
    "deep-leaf: JWT and bcrypt under 'message' removed from execution_result",
  );
  assert(
    deepRow20.execution_result?.result === "ok",
    "deep-leaf: non-secret 'result' string preserved in execution_result",
  );

  const deepRow21 = stub4.rows.find(r => r.id === 21)!;
  assert(
    deepRow21.payload.note === "no credential here",
    "deep-leaf: clean row 21 payload is untouched",
  );

  // ---- Idempotency of the deep-leaf fixture
  const stub5 = makeStubClient(stub4.rows);
  const result5 = await redactAiPendingActions(stub5.client);
  assert(
    result5.rowsUpdated === 0,
    `deep-leaf second pass updates 0 rows (got ${result5.rowsUpdated}) — idempotent`,
  );

  // -----------------------------------------------------------------------
  // Value-level (substring) redaction in innocuously-named JSONB fields.
  //
  // Task #102: the key-based deny-list is blind to credentials stored under
  // field names that don't match the deny-list patterns (e.g. `note`,
  // `message`, `config_diff`, `curl_example`).  This fixture covers the
  // additional secret formats Task #102 cared about (ids 40-42 to avoid
  // colliding with the deep-leaf fixture above).
  // -----------------------------------------------------------------------
  const innocuousSecret = "sk-live-INNOCUOUS_FIELD_LEAKING_VALUE_ABCDEFGH";
  const innocuousGh = "ghp_innocuousFieldGhTokenValue1234567890abc";
  const innocuousJwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI4ODg4ODgifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const innocuousSafe = "operation completed for tenant acme-corp";

  const innocuousRows: RowState[] = [
    {
      id: 40,
      // `note` and `message` are NOT in the key deny-list — only value-level
      // regex redaction can remove the credentials they contain.
      payload: {
        target: "zoho_books",
        note: `key=sk-live-${innocuousSecret.slice(3)}`,
        message: `rotated to ${innocuousSecret}`,
      },
      payload_preview: innocuousSafe,
      execution_result: null,
    },
    {
      id: 41,
      payload: { action: "rotate", description: innocuousSafe },
      payload_preview: innocuousSafe,
      // `curl_example` and `error_detail` are NOT in the key deny-list.
      execution_result: {
        data: {
          curl_example: `curl -H 'Authorization: Bearer ${innocuousGh}' https://api.example.com`,
          error_detail: `JWT was ${innocuousJwt}`,
          audit_note: innocuousSafe,
        },
      },
    },
    {
      id: 42,
      // Clean row — no credentials anywhere; must not be touched.
      payload: { target: "stripe", description: "webhook re-registration" },
      payload_preview: "Register Stripe webhook (id=we_def456)",
      execution_result: { data: { status: "ok", hook_id: "we_def456" } },
    },
  ];

  const stub8 = makeStubClient(innocuousRows);
  const result8 = await redactAiPendingActions(stub8.client);

  assert(result8.scanned === 3, `value-level fixture: scanned 3 rows (got ${result8.scanned})`);
  assert(
    result8.payloadChanged === 1,
    `value-level fixture: payload changed on 1 row (got ${result8.payloadChanged})`,
  );
  assert(
    result8.executionResultChanged === 1,
    `value-level fixture: execution_result changed on 1 row (got ${result8.executionResultChanged})`,
  );
  assert(
    result8.rowsUpdated === 2,
    `value-level fixture: 2 rows updated (got ${result8.rowsUpdated})`,
  );
  assert(stub8.updates.length === 2, "value-level fixture: exactly 2 UPDATE statements issued");

  const innocuousRow40 = stub8.rows.find(r => r.id === 40)!;
  assert(
    !JSON.stringify(innocuousRow40.payload).includes(innocuousSecret),
    "row 40 payload.note/message no longer contain the sk-… credential (value-level redaction)",
  );
  assert(
    JSON.stringify(innocuousRow40.payload).includes(REDACTED_SENTINEL),
    "row 40 payload contains the redaction sentinel after value-level sweep",
  );
  assert(
    innocuousRow40.payload.target === "zoho_books",
    "row 40 payload.target (non-secret) is preserved",
  );

  const innocuousRow41 = stub8.rows.find(r => r.id === 41)!;
  const execJson41 = JSON.stringify(innocuousRow41.execution_result);
  assert(
    !execJson41.includes(innocuousGh),
    "row 41 execution_result.data.curl_example no longer contains the ghp_… token (value-level redaction)",
  );
  assert(
    !execJson41.includes(innocuousJwt),
    "row 41 execution_result.data.error_detail no longer contains the JWT (value-level redaction)",
  );
  assert(
    execJson41.includes(REDACTED_SENTINEL),
    "row 41 execution_result contains the redaction sentinel after value-level sweep",
  );
  assert(
    innocuousRow41.execution_result?.data?.audit_note === innocuousSafe,
    "row 41 execution_result.data.audit_note (non-secret) is preserved",
  );

  const innocuousRow42 = stub8.rows.find(r => r.id === 42)!;
  assert(
    innocuousRow42.payload.target === "stripe" &&
      innocuousRow42.execution_result?.data?.status === "ok",
    "row 42 (clean control) is byte-identical — no UPDATE issued",
  );

  // Idempotency on value-level-cleaned rows
  const stub9 = makeStubClient(stub8.rows);
  const result9 = await redactAiPendingActions(stub9.client);
  assert(
    result9.rowsUpdated === 0,
    `value-level fixture second pass updates 0 rows (got ${result9.rowsUpdated}) — idempotent`,
  );

  // -----------------------------------------------------------------------
  // execution_result.error string redaction — consistency with write path.
  //
  // A failed tool execution may write an upstream error message that echoes
  // the rejected credential.  The sweep must scrub the `error` string leaf
  // inside the JSONB column exactly as recordExecutionResult() now does.
  // -----------------------------------------------------------------------
  const errorSecret = "sk-live-HISTORICAL_ERROR_LEAKED_VALUE_ABCDE";
  const errorJwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI3Nzc3NzcifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

  const errorRows: RowState[] = [
    {
      id: 30,
      payload: { action: "rotate", description: "noop" },
      payload_preview: "Rotate key (failed)",
      execution_result: {
        data: null,
        error: `Upstream rejected: Bearer token ${errorJwt} for key ${errorSecret}`,
      },
    },
    {
      id: 31,
      // Clean error — no credential-shaped content.
      payload: { action: "rotate", description: "noop" },
      payload_preview: "Rotate key (failed)",
      execution_result: { data: null, error: "Network timeout after 30s" },
    },
  ];

  const stub6 = makeStubClient(errorRows);
  const result6 = await redactAiPendingActions(stub6.client);

  assert(
    result6.scanned === 2,
    `error-string fixture: scanned 2 rows (got ${result6.scanned})`,
  );
  assert(
    result6.executionResultChanged === 1,
    `error-string fixture: execution_result changed on 1 row (got ${result6.executionResultChanged})`,
  );
  assert(
    result6.rowsUpdated === 1,
    `error-string fixture: 1 row updated (got ${result6.rowsUpdated})`,
  );

  const errorRow30 = stub6.rows.find(r => r.id === 30)!;
  const errorJson30 = JSON.stringify(errorRow30.execution_result);
  assert(
    !errorJson30.includes(errorSecret),
    "row 30 execution_result.error no longer contains the sk-… credential (sweep error-string redaction)",
  );
  assert(
    !errorJson30.includes(errorJwt),
    "row 30 execution_result.error no longer contains the JWT (sweep error-string redaction)",
  );
  assert(
    errorJson30.includes(REDACTED_SENTINEL),
    "row 30 execution_result.error contains the redaction sentinel",
  );

  const errorRow31 = stub6.rows.find(r => r.id === 31)!;
  assert(
    errorRow31.execution_result?.error === "Network timeout after 30s",
    "row 31 (clean error) is byte-identical — no UPDATE issued",
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
