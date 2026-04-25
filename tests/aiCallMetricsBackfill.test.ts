/**
 * Tests for the historical ai_call_metrics backfill sweep (Task #469).
 *
 * Verifies that `backfillAiCallMetricsRedaction()` in
 * `src/scripts/backfillAiCallMetricsRedaction.ts` rewrites pre-fix free-form
 * TEXT columns (`error_message`, `prompt_preview`, `tool_input_preview`,
 * `tool_output_preview`) that contain credential-shaped substrings (sk-…,
 * ghp_…, JWTs, bcrypt hashes, AWS keys), leaves clean rows untouched, is
 * idempotent on a second pass, and reports the per-column scanned/changed
 * counters the audit-log entry consumes.
 *
 * Mirrors the fixture / assertion pattern of `tests/aiApprovalSweepBackfill.test.ts`
 * and reuses the same credential fixtures as `tests/aiTelemetryErrorRedaction.test.ts`
 * so the leak coverage stays consistent across the write path (Task #452)
 * and the historical sweep (this task).
 *
 * Run:  npx tsx tests/aiCallMetricsBackfill.test.ts
 */

import {
  backfillAiCallMetricsRedaction,
  type AiCallMetricsBackfillResult,
} from "../src/scripts/backfillAiCallMetricsRedaction";
import { REDACTED_SENTINEL } from "../src/utils/eventLogsDatabase";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  \u2713 ${label}`);
    passed++;
  } else {
    console.error(`  \u2717 ${label}`);
    failed++;
  }
}

interface RowState {
  id: number;
  error_message: string | null;
  prompt_preview: string | null;
  tool_input_preview: string | null;
  tool_output_preview: string | null;
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
  const rows = initialRows.map((r) => ({ ...r }));
  const updates: CapturedUpdate[] = [];

  const query = async (sql: string, params: ReadonlyArray<unknown> = []) => {
    if (/^\s*SELECT/i.test(sql)) {
      // Honor the keyset cursor so the sweep terminates correctly when
      // exercised with batch sizes smaller than the fixture row count.
      const cursor = (params[0] as number) ?? 0;
      const limit = (params[1] as number) ?? rows.length;
      const slice = rows
        .filter((r) => r.id > cursor)
        .sort((a, b) => a.id - b.id)
        .slice(0, limit)
        .map((r) => ({ ...r }));
      return { rows: slice, rowCount: slice.length };
    }
    if (/^\s*UPDATE\s+ai_call_metrics/i.test(sql)) {
      updates.push({ sql, params });
      const id = params[4] as number;
      const target = rows.find((r) => r.id === id);
      if (target) {
        target.error_message = params[0] as string | null;
        target.prompt_preview = params[1] as string | null;
        target.tool_input_preview = params[2] as string | null;
        target.tool_output_preview = params[3] as string | null;
      }
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  return { client: { query }, updates, rows };
}

async function run(): Promise<void> {
  console.log("\n[backfillAiCallMetricsRedaction] ai_call_metrics historical sweep");

  const SK_KEY = "sk-live-LEAKED_AI_METRICS_HISTORICAL_ABCDEFGHI";
  const GH_PAT = "ghp_leakedHistoricalMetricsToken1234567890XYZ";
  const JWT =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI1NTU1NTUifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const BCRYPT_HASH = "$2b$12$abcdefghijklmnopqrstuv1234567890ABCDEFGHIJKLMNOPQRSTU";
  const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
  const SAFE_PROSE = "Connection refused after 3 retries";

  // -----------------------------------------------------------------------
  // Fixture A: a row per leak vector + one fully-clean control row.
  // -----------------------------------------------------------------------
  const initial: RowState[] = [
    {
      id: 1,
      error_message: `Upstream API rejected key ${SK_KEY}`,
      prompt_preview: "Rotate API key for zoho_books integration",
      tool_input_preview: null,
      tool_output_preview: null,
    },
    {
      id: 2,
      error_message: `JWT verify failed for token=${JWT}`,
      prompt_preview: null,
      tool_input_preview: `{"authorization":"Bearer ${GH_PAT}","tenant":"acme"}`,
      tool_output_preview: null,
    },
    {
      id: 3,
      error_message: null,
      prompt_preview: `User prompt: please rotate key. Old hash was ${BCRYPT_HASH}`,
      tool_input_preview: null,
      tool_output_preview: `{"status":"failed","echo":"key=${AWS_KEY}"}`,
    },
    {
      id: 4,
      // Fully clean control — no credential-shaped content anywhere.
      error_message: SAFE_PROSE,
      prompt_preview: "Summarise audit findings for Q2",
      tool_input_preview: '{"vendor":"acme-corp","status":"open"}',
      tool_output_preview: '{"count":17,"ok":true}',
    },
    {
      id: 5,
      // Already-redacted row — sentinel must be preserved without rewrite.
      error_message: `Upstream rejected key ${REDACTED_SENTINEL}`,
      prompt_preview: null,
      tool_input_preview: null,
      tool_output_preview: null,
    },
  ];

  const stub1 = makeStubClient(initial);
  const result1: AiCallMetricsBackfillResult = await backfillAiCallMetricsRedaction(
    stub1.client,
  );

  assert(result1.scanned === 5, `scanned all 5 rows (got ${result1.scanned})`);
  assert(
    result1.error_message_changed === 2,
    `error_message rewritten on the 2 leaky rows (got ${result1.error_message_changed})`,
  );
  assert(
    result1.prompt_preview_changed === 1,
    `prompt_preview rewritten on the 1 leaky row (got ${result1.prompt_preview_changed})`,
  );
  assert(
    result1.tool_input_preview_changed === 1,
    `tool_input_preview rewritten on the 1 leaky row (got ${result1.tool_input_preview_changed})`,
  );
  assert(
    result1.tool_output_preview_changed === 1,
    `tool_output_preview rewritten on the 1 leaky row (got ${result1.tool_output_preview_changed})`,
  );
  assert(
    result1.rows_updated === 3,
    `total rows updated = 3 (rows 1, 2, 3 — got ${result1.rows_updated})`,
  );
  assert(
    stub1.updates.length === 3,
    `exactly 3 UPDATE statements issued (got ${stub1.updates.length})`,
  );

  const row1 = stub1.rows.find((r) => r.id === 1)!;
  assert(
    !row1.error_message!.includes(SK_KEY),
    "row 1 error_message no longer contains the sk-… credential",
  );
  assert(
    row1.error_message!.includes(REDACTED_SENTINEL),
    "row 1 error_message contains the redaction sentinel",
  );
  assert(
    row1.error_message!.includes("Upstream API rejected key"),
    "row 1 error_message preserves the surrounding non-secret prose",
  );
  assert(
    row1.prompt_preview === "Rotate API key for zoho_books integration",
    "row 1 prompt_preview (clean) is byte-identical",
  );

  const row2 = stub1.rows.find((r) => r.id === 2)!;
  assert(
    !row2.error_message!.includes(JWT),
    "row 2 error_message no longer contains the JWT",
  );
  assert(
    !row2.tool_input_preview!.includes(GH_PAT),
    "row 2 tool_input_preview no longer contains the ghp_… token",
  );
  assert(
    row2.tool_input_preview!.includes(REDACTED_SENTINEL),
    "row 2 tool_input_preview contains the redaction sentinel",
  );

  const row3 = stub1.rows.find((r) => r.id === 3)!;
  assert(
    !row3.prompt_preview!.includes("$2b$12$"),
    "row 3 prompt_preview no longer contains the bcrypt hash prefix",
  );
  assert(
    !row3.tool_output_preview!.includes(AWS_KEY),
    "row 3 tool_output_preview no longer contains the AWS access key",
  );
  assert(
    row3.tool_output_preview!.includes(REDACTED_SENTINEL),
    "row 3 tool_output_preview contains the redaction sentinel",
  );

  const row4 = stub1.rows.find((r) => r.id === 4)!;
  assert(
    row4.error_message === SAFE_PROSE &&
      row4.prompt_preview === "Summarise audit findings for Q2" &&
      row4.tool_input_preview === '{"vendor":"acme-corp","status":"open"}' &&
      row4.tool_output_preview === '{"count":17,"ok":true}',
    "row 4 (clean control) — every column byte-identical, no UPDATE issued",
  );

  const row5 = stub1.rows.find((r) => r.id === 5)!;
  assert(
    row5.error_message === `Upstream rejected key ${REDACTED_SENTINEL}`,
    "row 5 (already-redacted) error_message is byte-identical — no UPDATE issued",
  );

  // -----------------------------------------------------------------------
  // Idempotency: a second pass over the now-clean dataset must be a no-op.
  // -----------------------------------------------------------------------
  const stub2 = makeStubClient(stub1.rows);
  const result2 = await backfillAiCallMetricsRedaction(stub2.client);

  assert(result2.scanned === 5, "second pass still scans all 5 rows");
  assert(
    result2.rows_updated === 0,
    `second pass updates 0 rows (got ${result2.rows_updated}) — script is idempotent`,
  );
  assert(
    result2.error_message_changed === 0 &&
      result2.prompt_preview_changed === 0 &&
      result2.tool_input_preview_changed === 0 &&
      result2.tool_output_preview_changed === 0,
    "second pass reports zero per-column changes",
  );
  assert(
    stub2.updates.length === 0,
    "second pass issues no UPDATE statements",
  );

  // -----------------------------------------------------------------------
  // Combined column changes: every TEXT column dirty in the same row →
  // counts as a single UPDATE but increments all four per-column counters.
  // -----------------------------------------------------------------------
  const combined: RowState[] = [
    {
      id: 10,
      error_message: `Tool failed: key=${SK_KEY}`,
      prompt_preview: `Help me rotate ${GH_PAT}`,
      tool_input_preview: `{"authorization":"Bearer ${JWT}"}`,
      tool_output_preview: `{"echo":"hash=${BCRYPT_HASH}"}`,
    },
  ];
  const stub3 = makeStubClient(combined);
  const result3 = await backfillAiCallMetricsRedaction(stub3.client);

  assert(
    result3.error_message_changed === 1 &&
      result3.prompt_preview_changed === 1 &&
      result3.tool_input_preview_changed === 1 &&
      result3.tool_output_preview_changed === 1,
    "combined-fixture row reports change on all four per-column counters",
  );
  assert(
    result3.rows_updated === 1,
    "combined-fixture row counts as a single UPDATE",
  );
  assert(
    stub3.updates.length === 1,
    "combined-fixture issues exactly one UPDATE statement",
  );
  const combinedRow = stub3.rows[0];
  assert(
    !combinedRow.error_message!.includes(SK_KEY) &&
      !combinedRow.prompt_preview!.includes(GH_PAT) &&
      !combinedRow.tool_input_preview!.includes(JWT) &&
      !combinedRow.tool_output_preview!.includes("$2b$12$"),
    "combined-fixture: every leaky column scrubbed in the single UPDATE",
  );
  assert(
    combinedRow.error_message!.includes(REDACTED_SENTINEL) &&
      combinedRow.prompt_preview!.includes(REDACTED_SENTINEL) &&
      combinedRow.tool_input_preview!.includes(REDACTED_SENTINEL) &&
      combinedRow.tool_output_preview!.includes(REDACTED_SENTINEL),
    "combined-fixture: sentinel present in every scrubbed column",
  );

  // -----------------------------------------------------------------------
  // Batched keyset pagination: with batch=2 over 5 rows, the cursor must
  // advance correctly across multiple pages and still produce the same
  // row-update result as the single-batch path. Mirrors the keyset-batch
  // safety check Task #289 added to the ai_pending_actions sweep.
  // -----------------------------------------------------------------------
  const batched: RowState[] = [
    {
      id: 100,
      error_message: `Leak A: ${SK_KEY}`,
      prompt_preview: null,
      tool_input_preview: null,
      tool_output_preview: null,
    },
    {
      id: 101,
      error_message: SAFE_PROSE,
      prompt_preview: null,
      tool_input_preview: null,
      tool_output_preview: null,
    },
    {
      id: 102,
      error_message: `Leak B: ${GH_PAT}`,
      prompt_preview: null,
      tool_input_preview: null,
      tool_output_preview: null,
    },
    {
      id: 103,
      error_message: SAFE_PROSE,
      prompt_preview: null,
      tool_input_preview: null,
      tool_output_preview: null,
    },
    {
      id: 104,
      error_message: `Leak C: ${JWT}`,
      prompt_preview: null,
      tool_input_preview: null,
      tool_output_preview: null,
    },
  ];
  const stub4 = makeStubClient(batched);
  const result4 = await backfillAiCallMetricsRedaction(stub4.client, 2);

  assert(
    result4.scanned === 5,
    `batched (size=2) sweep scans all 5 rows across pages (got ${result4.scanned})`,
  );
  assert(
    result4.rows_updated === 3,
    `batched sweep updates 3 leaky rows (got ${result4.rows_updated})`,
  );
  assert(
    stub4.rows.find((r) => r.id === 100)!.error_message!.includes(REDACTED_SENTINEL) &&
      stub4.rows.find((r) => r.id === 102)!.error_message!.includes(REDACTED_SENTINEL) &&
      stub4.rows.find((r) => r.id === 104)!.error_message!.includes(REDACTED_SENTINEL),
    "batched sweep: every leaky row across page boundaries is scrubbed",
  );
  assert(
    stub4.rows.find((r) => r.id === 101)!.error_message === SAFE_PROSE &&
      stub4.rows.find((r) => r.id === 103)!.error_message === SAFE_PROSE,
    "batched sweep: clean rows between leaky ones remain byte-identical",
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
