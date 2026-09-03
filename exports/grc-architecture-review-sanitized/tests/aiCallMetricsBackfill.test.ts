/**
 * Tests for the historical ai_call_metrics backfill sweep (Task #469 + #475).
 *
 * Verifies that `backfillAiCallMetricsRedaction()` in
 * `src/scripts/backfillAiCallMetricsRedaction.ts` rewrites pre-fix free-form
 * TEXT columns (`error_message`, `prompt_preview`, `tool_input_preview`,
 * `tool_output_preview`) AND walks the JSONB `metadata` column with
 * `deepRedactSecretLikeStrings()` so credential-shaped substrings (sk-…,
 * ghp_…, JWTs, bcrypt hashes, AWS keys) stuffed under innocuously-named
 * leaf keys (e.g. `metadata.note`) get sentinelised the same way. Also
 * leaves clean rows untouched, is idempotent on a second pass, and reports
 * the per-column scanned/changed counters the audit-log entry consumes —
 * including the new `metadata_changed` counter introduced by Task #475.
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
  // node-postgres parses JSONB columns into native JS values, so the
  // fixture stores the parsed shape (object | null), not a JSON string.
  metadata: Record<string, unknown> | null;
  // Task #557: the daily sweep stamps `previews_redacted_at = NOW()`
  // whenever it actually rewrites one of the three preview columns,
  // mirroring the breadcrumb the primary `redactAiCallMetrics()` sweep
  // (Task #467) already writes. Tracked here so assertions can verify
  // both the stamped path (preview-dirty rows) and the deliberately
  // unstamped path (rows where only `error_message` / `metadata` changed).
  previews_redacted_at: Date | null;
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
      const id = params[5] as number;
      const target = rows.find((r) => r.id === id);
      if (target) {
        target.error_message = params[0] as string | null;
        target.prompt_preview = params[1] as string | null;
        target.tool_input_preview = params[2] as string | null;
        target.tool_output_preview = params[3] as string | null;
        // The sweep serialises metadata to a JSON string before binding so
        // it can be cast to ::jsonb in the UPDATE. Mirror Postgres' jsonb
        // round-trip by parsing it back into the in-memory object.
        const rawMeta = params[4] as string | null;
        target.metadata =
          rawMeta === null || rawMeta === undefined
            ? null
            : (JSON.parse(rawMeta) as Record<string, unknown>);
        // Task #557: the real UPDATE adds `previews_redacted_at = NOW()`
        // to the SET clause server-side (no JS bind param) only when the
        // sweep actually rewrote one of the three preview columns. Mirror
        // that behaviour here by sniffing the SQL string so assertions
        // can confirm both the stamped path and the unstamped path.
        if (/previews_redacted_at\s*=\s*NOW\(\)/i.test(sql)) {
          target.previews_redacted_at = new Date();
        }
      }
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  return { client: { query }, updates, rows };
}

async function run(): Promise<void> {
  console.log("\n[backfillAiCallMetricsRedaction] ai_call_metrics historical sweep");

  const SK_KEY = "<REDACTED_TOKEN>";
  const GH_PAT = "<REDACTED_TOKEN>";
  const JWT =
    "<REDACTED_TOKEN>";
  const BCRYPT_HASH = "$2b$12$abcdefghijklmnopqrstuv1234567890ABCDEFGHIJKLMNOPQRSTU";
  const AWS_KEY = "<REDACTED_TOKEN>";
  const SAFE_PROSE = "Connection refused after 3 retries";

  // -----------------------------------------------------------------------
  // Fixture A: a row per leak vector + one fully-clean control row.
  // -----------------------------------------------------------------------
  const initial: RowState[] = [
    {
      id: 1,
      // Only `error_message` is dirty — the prompt_preview is clean
      // prose. Task #557 contract: this row gets an UPDATE but must NOT
      // acquire a `previews_redacted_at` breadcrumb because the AI Ops
      // call-detail badge specifically signals preview provenance.
      error_message: `Upstream API rejected key ${SK_KEY}`,
      prompt_preview: "Rotate API key for CRMProvider_books integration",
      tool_input_preview: null,
      tool_output_preview: null,
      // Clean metadata — must round-trip byte-identical.
      metadata: { prompt_version: "v3.2", tenant: "Example Organization" },
      previews_redacted_at: null,
    },
    {
      id: 2,
      // error_message + tool_input_preview both dirty → preview-dirty
      // path → breadcrumb stamped.
      error_message: `JWT verify failed for token=${JWT}`,
      prompt_preview: null,
      tool_input_preview: `{"authorization":"Bearer ${GH_PAT}","tenant":"Example Organization"}`,
      tool_output_preview: null,
      metadata: null,
      previews_redacted_at: null,
    },
    {
      id: 3,
      // prompt_preview + tool_output_preview both dirty → preview-dirty
      // path → breadcrumb stamped.
      error_message: null,
      prompt_preview: `User prompt: please rotate key. Old hash was ${BCRYPT_HASH}`,
      tool_input_preview: null,
      tool_output_preview: `{"status":"failed","echo":"key=${AWS_KEY}"}`,
      metadata: { prompt_version: "v4.0" },
      previews_redacted_at: null,
    },
    {
      id: 4,
      // Fully clean control — no credential-shaped content anywhere.
      error_message: SAFE_PROSE,
      prompt_preview: "Summarise audit findings for Q2",
      tool_input_preview: '{"vendor":"Example Organization-corp","status":"open"}',
      tool_output_preview: '{"count":17,"ok":true}',
      metadata: { prompt_version: "v2.1", source: "scheduler" },
      previews_redacted_at: null,
    },
    {
      id: 5,
      // Already-redacted row — sentinel must be preserved without rewrite.
      error_message: `Upstream rejected key ${REDACTED_SENTINEL}`,
      prompt_preview: null,
      tool_input_preview: null,
      tool_output_preview: null,
      metadata: { prompt_version: "v1.0" },
      previews_redacted_at: null,
    },
    {
      id: 6,
      // Task #475 fixture — TEXT columns clean, but a credential-shaped
      // substring is hiding under an innocuously-named JSONB leaf key
      // (`metadata.note`) that the per-key deny-list cannot catch. The
      // sweep must walk metadata recursively and sentinelise the leak
      // while preserving the surrounding non-secret structure. Task #557
      // contract: only `metadata` changed, so the breadcrumb must NOT
      // be stamped — the badge would misrepresent provenance.
      error_message: SAFE_PROSE,
      prompt_preview: null,
      tool_input_preview: null,
      tool_output_preview: null,
      metadata: {
        prompt_version: "v5.0",
        request_context: {
          // Even nested under a non-sensitive key, the leaf string must
          // be scrubbed. Mirrors the `deepRedactSecretLikeStrings` path
          // that already covers `ai_pending_actions.execution_result`.
          note: `Caller passed key ${SK_KEY} in error context`,
          tenant: "Example Organization",
        },
      },
      previews_redacted_at: null,
    },
  ];

  const stub1 = makeStubClient(initial);
  const result1: AiCallMetricsBackfillResult = await backfillAiCallMetricsRedaction(
    stub1.client,
  );

  assert(result1.scanned === 6, `scanned all 6 rows (got ${result1.scanned})`);
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
    result1.metadata_changed === 1,
    `metadata rewritten on the 1 leaky row — id=6, sk-… nested under metadata.request_context.note (got ${result1.metadata_changed})`,
  );
  assert(
    result1.rows_updated === 4,
    `total rows updated = 4 (rows 1, 2, 3, 6 — got ${result1.rows_updated})`,
  );
  assert(
    stub1.updates.length === 4,
    `exactly 4 UPDATE statements issued (got ${stub1.updates.length})`,
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
    row1.prompt_preview === "Rotate API key for CRMProvider_books integration",
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
      row4.tool_input_preview === '{"vendor":"Example Organization-corp","status":"open"}' &&
      row4.tool_output_preview === '{"count":17,"ok":true}',
    "row 4 (clean control) — every TEXT column byte-identical, no UPDATE issued",
  );
  assert(
    JSON.stringify(row4.metadata) ===
      JSON.stringify({ prompt_version: "v2.1", source: "scheduler" }),
    "row 4 (clean control) — metadata byte-identical",
  );

  const row5 = stub1.rows.find((r) => r.id === 5)!;
  assert(
    row5.error_message === `Upstream rejected key ${REDACTED_SENTINEL}`,
    "row 5 (already-redacted) error_message is byte-identical — no UPDATE issued",
  );

  // Task #475 — verify the JSONB sweep on the metadata leak fixture.
  const row6 = stub1.rows.find((r) => r.id === 6)!;
  const row6Meta = row6.metadata as {
    prompt_version: string;
    request_context: { note: string; tenant: string };
  };
  assert(
    !JSON.stringify(row6.metadata).includes(SK_KEY),
    "row 6 metadata no longer contains the sk-… credential anywhere in the JSONB tree",
  );
  assert(
    row6Meta.request_context.note.includes(REDACTED_SENTINEL),
    "row 6 metadata.request_context.note contains the redaction sentinel",
  );
  assert(
    row6Meta.request_context.note.includes("Caller passed key") &&
      row6Meta.request_context.note.includes("in error context"),
    "row 6 metadata.request_context.note preserves the surrounding non-secret prose",
  );
  assert(
    row6Meta.request_context.tenant === "Example Organization" &&
      row6Meta.prompt_version === "v5.0",
    "row 6 metadata: untouched leaves (tenant, prompt_version) round-trip byte-identical",
  );
  assert(
    row6.error_message === SAFE_PROSE,
    "row 6 error_message (clean) is byte-identical — TEXT columns untouched",
  );

  // -----------------------------------------------------------------------
  // Task #557 — `previews_redacted_at` breadcrumb is stamped if-and-only-if
  // the sweep actually rewrote one of the three preview columns. Without
  // this, the AI Operations call-detail panel ("Preview redacted by
  // historical sweep on YYYY-MM-DD") fires inconsistently depending on
  // which historical sweep happened to clean the row.
  // -----------------------------------------------------------------------
  assert(
    row1.previews_redacted_at === null,
    "row 1 (only error_message dirty) — previews_redacted_at NOT stamped, badge stays hidden",
  );
  assert(
    row2.previews_redacted_at instanceof Date,
    "row 2 (tool_input_preview dirty) — previews_redacted_at stamped",
  );
  assert(
    row3.previews_redacted_at instanceof Date,
    "row 3 (prompt_preview + tool_output_preview dirty) — previews_redacted_at stamped",
  );
  assert(
    row4.previews_redacted_at === null,
    "row 4 (clean control, no UPDATE) — previews_redacted_at stays NULL",
  );
  assert(
    row5.previews_redacted_at === null,
    "row 5 (already-redacted, no UPDATE) — previews_redacted_at stays NULL",
  );
  assert(
    row6.previews_redacted_at === null,
    "row 6 (only metadata dirty) — previews_redacted_at NOT stamped, badge stays hidden",
  );
  // Also assert the SQL shape directly: the breadcrumb assignment must
  // appear only on the UPDATE statements that rewrote a preview column.
  const previewDirtyIds = new Set([2, 3]);
  const errorOrMetadataOnlyIds = new Set([1, 6]);
  for (const u of stub1.updates) {
    const id = u.params[5] as number;
    const sqlHasBreadcrumb = /previews_redacted_at\s*=\s*NOW\(\)/i.test(u.sql);
    if (previewDirtyIds.has(id)) {
      assert(
        sqlHasBreadcrumb,
        `UPDATE for preview-dirty row id=${id} includes previews_redacted_at = NOW()`,
      );
    } else if (errorOrMetadataOnlyIds.has(id)) {
      assert(
        !sqlHasBreadcrumb,
        `UPDATE for non-preview-dirty row id=${id} omits previews_redacted_at = NOW()`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Idempotency: a second pass over the now-clean dataset must be a no-op.
  // -----------------------------------------------------------------------
  const stub2 = makeStubClient(stub1.rows);
  const result2 = await backfillAiCallMetricsRedaction(stub2.client);

  assert(result2.scanned === 6, "second pass still scans all 6 rows");
  assert(
    result2.rows_updated === 0,
    `second pass updates 0 rows (got ${result2.rows_updated}) — script is idempotent`,
  );
  assert(
    result2.error_message_changed === 0 &&
      result2.prompt_preview_changed === 0 &&
      result2.tool_input_preview_changed === 0 &&
      result2.tool_output_preview_changed === 0 &&
      result2.metadata_changed === 0,
    "second pass reports zero per-column changes (including metadata_changed)",
  );
  assert(
    stub2.updates.length === 0,
    "second pass issues no UPDATE statements",
  );

  // -----------------------------------------------------------------------
  // Combined column changes: every TEXT column dirty in the same row plus
  // a credential nested under metadata → counts as a single UPDATE but
  // increments all five per-column counters (Task #475 adds metadata).
  // -----------------------------------------------------------------------
  const combined: RowState[] = [
    {
      id: 10,
      error_message: `Tool failed: key=${SK_KEY}`,
      prompt_preview: `Help me rotate ${GH_PAT}`,
      tool_input_preview: `{"authorization":"Bearer ${JWT}"}`,
      tool_output_preview: `{"echo":"hash=${BCRYPT_HASH}"}`,
      metadata: {
        prompt_version: "v9.9",
        debug_context: { last_aws_key: AWS_KEY },
      },
      previews_redacted_at: null,
    },
  ];
  const stub3 = makeStubClient(combined);
  const result3 = await backfillAiCallMetricsRedaction(stub3.client);

  assert(
    result3.error_message_changed === 1 &&
      result3.prompt_preview_changed === 1 &&
      result3.tool_input_preview_changed === 1 &&
      result3.tool_output_preview_changed === 1 &&
      result3.metadata_changed === 1,
    "combined-fixture row reports change on all five per-column counters",
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
      !combinedRow.tool_output_preview!.includes("$2b$12$") &&
      !JSON.stringify(combinedRow.metadata).includes(AWS_KEY),
    "combined-fixture: every leaky column (including metadata) scrubbed in the single UPDATE",
  );
  const combinedMeta = combinedRow.metadata as {
    prompt_version: string;
    debug_context: { last_aws_key: string };
  };
  assert(
    combinedRow.error_message!.includes(REDACTED_SENTINEL) &&
      combinedRow.prompt_preview!.includes(REDACTED_SENTINEL) &&
      combinedRow.tool_input_preview!.includes(REDACTED_SENTINEL) &&
      combinedRow.tool_output_preview!.includes(REDACTED_SENTINEL) &&
      combinedMeta.debug_context.last_aws_key.includes(REDACTED_SENTINEL),
    "combined-fixture: sentinel present in every scrubbed column (including nested metadata leaf)",
  );
  assert(
    combinedMeta.prompt_version === "v9.9",
    "combined-fixture: untouched metadata leaves remain byte-identical",
  );
  // Task #557 — every preview column was rewritten, so the breadcrumb
  // must be stamped and the SQL must contain the server-side assignment.
  assert(
    combinedRow.previews_redacted_at instanceof Date,
    "combined-fixture: previews_redacted_at stamped (all preview columns rewritten)",
  );
  assert(
    /previews_redacted_at\s*=\s*NOW\(\)/i.test(stub3.updates[0].sql),
    "combined-fixture: UPDATE includes previews_redacted_at = NOW()",
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
      metadata: null,
      previews_redacted_at: null,
    },
    {
      id: 101,
      error_message: SAFE_PROSE,
      prompt_preview: null,
      tool_input_preview: null,
      tool_output_preview: null,
      metadata: { prompt_version: "v1.0" },
      previews_redacted_at: null,
    },
    {
      id: 102,
      error_message: `Leak B: ${GH_PAT}`,
      prompt_preview: null,
      tool_input_preview: null,
      tool_output_preview: null,
      metadata: null,
      previews_redacted_at: null,
    },
    {
      id: 103,
      error_message: SAFE_PROSE,
      prompt_preview: null,
      tool_input_preview: null,
      tool_output_preview: null,
      metadata: { prompt_version: "v1.1" },
      previews_redacted_at: null,
    },
    {
      id: 104,
      error_message: `Leak C: ${JWT}`,
      prompt_preview: null,
      tool_input_preview: null,
      tool_output_preview: null,
      metadata: null,
      previews_redacted_at: null,
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
  // Task #557 — every batched leak is error_message-only (no preview
  // column rewrites), so none of the rewritten rows should acquire a
  // previews_redacted_at breadcrumb and no UPDATE should contain the
  // server-side `NOW()` assignment.
  assert(
    stub4.rows.find((r) => r.id === 100)!.previews_redacted_at === null &&
      stub4.rows.find((r) => r.id === 102)!.previews_redacted_at === null &&
      stub4.rows.find((r) => r.id === 104)!.previews_redacted_at === null,
    "batched sweep: error_message-only rewrites leave previews_redacted_at NULL",
  );
  assert(
    stub4.updates.every(
      (u) => !/previews_redacted_at\s*=\s*NOW\(\)/i.test(u.sql),
    ),
    "batched sweep: no UPDATE includes previews_redacted_at = NOW() (no preview columns dirty)",
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
