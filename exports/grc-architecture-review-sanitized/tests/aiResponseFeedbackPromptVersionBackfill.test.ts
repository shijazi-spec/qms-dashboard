/**
 * Tests for the historical ai_response_feedback prompt-version backfill
 * sweep (Task #750).
 *
 * Verifies that `backfillFeedbackPromptVersion()` in
 * `src/scripts/backfillAiResponseFeedbackPromptVersion.ts`:
 *   (a) copies `prompt_version` from the linked `ai_call_metrics` row
 *       into `ai_response_feedback.metadata` when the feedback row is
 *       missing one and the metric row carries a value
 *   (b) preserves any sibling allow-list keys already in metadata
 *       (workflow / step / rating_source / etc.) — the merge uses
 *       `||` jsonb_build_object so non-target keys round-trip
 *   (c) leaves rows whose linked metric row also lacks a prompt_version
 *       untouched and counts them under `missing_source`
 *   (d) leaves rows with no resolvable `call_id` linkage untouched and
 *       counts them under `unlinked` — both the absent column and the
 *       absent metadata fallback paths
 *   (e) is idempotent — a second pass against the now-backfilled table
 *       reports 0 rows updated because the SELECT predicate filters
 *       them out
 *   (f) `--dry-run` mode (`{ dryRun: true }`) increments the same
 *       `rows_updated` counter but issues 0 UPDATE statements, so
 *       operators can preview the impact before committing
 *   (g) resolves the call_id from `metadata->>'call_id'` when the
 *       schema has no `call_id` column (legacy surfaces) AND from the
 *       real column when present (post-Task-#589 schema)
 *
 * Run:  npx tsx tests/aiResponseFeedbackPromptVersionBackfill.test.ts
 */

import {
  backfillFeedbackPromptVersion,
  resolveCallId,
  type FeedbackPromptVersionBackfillResult,
} from "../src/scripts/backfillAiResponseFeedbackPromptVersion";

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

interface FeedbackRow {
  id: number;
  call_id: number | null;
  metadata: Record<string, unknown> | null;
}

interface MetricRow {
  id: number;
  metadata: Record<string, unknown> | null;
}

interface CapturedUpdate {
  sql: string;
  params: ReadonlyArray<unknown>;
}

function makeStubClient(
  feedback: FeedbackRow[],
  metrics: MetricRow[],
  options: { hasCallIdColumn?: boolean } = {},
): {
  client: {
    query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<any>;
  };
  updates: CapturedUpdate[];
  rows: FeedbackRow[];
} {
  const hasCallIdColumn = options.hasCallIdColumn !== false;
  const rows = feedback.map((r) => ({
    ...r,
    metadata: r.metadata ? { ...r.metadata } : r.metadata,
  }));
  const updates: CapturedUpdate[] = [];

  const promptVersionMissing = (meta: Record<string, unknown> | null) => {
    const v = meta?.prompt_version;
    return typeof v !== "string" || v.trim() === "";
  };

  const query = async (sql: string, params: ReadonlyArray<unknown> = []) => {
    if (/information_schema\.columns/i.test(sql)) {
      return hasCallIdColumn
        ? { rows: [{ "?column?": 1 }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/FROM\s+ai_response_feedback/i.test(sql) && /^\s*SELECT/i.test(sql)) {
      const cursor = (params[0] as number) ?? 0;
      const limit = (params[1] as number) ?? rows.length;
      const slice = rows
        .filter((r) => r.id > cursor && promptVersionMissing(r.metadata))
        .sort((a, b) => a.id - b.id)
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          call_id: hasCallIdColumn ? r.call_id : null,
          metadata: r.metadata,
        }));
      return { rows: slice, rowCount: slice.length };
    }
    if (/FROM\s+ai_call_metrics/i.test(sql) && /^\s*SELECT/i.test(sql)) {
      const id = params[0] as number;
      const m = metrics.find((mr) => mr.id === id);
      const v = m?.metadata?.prompt_version;
      const prompt_version =
        typeof v === "string" && v.trim() !== "" ? v : null;
      return m
        ? { rows: [{ prompt_version }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/^\s*UPDATE\s+ai_response_feedback/i.test(sql)) {
      updates.push({ sql, params });
      const id = params[0] as number;
      const version = params[1] as string;
      const target = rows.find((r) => r.id === id);
      if (target && promptVersionMissing(target.metadata)) {
        target.metadata = {
          ...(target.metadata ?? {}),
          prompt_version: version,
        };
      }
      return { rows: [], rowCount: target ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  };

  return { client: { query }, updates, rows };
}

async function run(): Promise<void> {
  console.log(
    "\n[backfillFeedbackPromptVersion] resolveCallId() unit coverage",
  );
  {
    assert(
      resolveCallId({ call_id: 42 }) === 42,
      "(resolveCallId) numeric call_id column wins",
    );
    assert(
      resolveCallId({ call_id: "17" }) === 17,
      "(resolveCallId) numeric-string call_id column parses",
    );
    assert(
      resolveCallId({ call_id: null, metadata: { call_id: 99 } }) === 99,
      "(resolveCallId) falls back to metadata.call_id when column is null",
    );
    assert(
      resolveCallId({
        call_id: null,
        metadata: { call_id: "123", workflow: "x" },
      }) === 123,
      "(resolveCallId) parses metadata.call_id as string",
    );
    assert(
      resolveCallId({ call_id: null, metadata: null }) === null,
      "(resolveCallId) returns null when no source available",
    );
    assert(
      resolveCallId({ call_id: 0 }) === null,
      "(resolveCallId) rejects non-positive ids",
    );
    assert(
      resolveCallId({ call_id: null, metadata: { call_id: "abc" } }) === null,
      "(resolveCallId) rejects non-numeric metadata.call_id",
    );
    assert(
      resolveCallId({
        call_id: null,
        metadata: '{"call_id": 55}' as unknown as Record<string, unknown>,
      }) === 55,
      "(resolveCallId) parses stringified-JSON metadata defensively",
    );
  }

  console.log(
    "\n[backfillFeedbackPromptVersion] post-Task-#589 schema (call_id column present)",
  );

  const feedback: FeedbackRow[] = [
    {
      // (a) basic backfill — version copied from metric row.
      id: 1,
      call_id: 100,
      metadata: {},
    },
    {
      // (b) sibling allow-list keys preserved.
      id: 2,
      call_id: 101,
      metadata: { workflow: "qualityAuditWorkflow", rating_source: "inline_thumbs" },
    },
    {
      // (c) linked metric row also lacks prompt_version → missing_source.
      id: 3,
      call_id: 102,
      metadata: {},
    },
    {
      // (d) no call_id linkage at all → unlinked.
      id: 4,
      call_id: null,
      metadata: { workflow: "qualityAuditWorkflow" },
    },
    {
      // already-backfilled control: SELECT predicate filters this out.
      id: 5,
      call_id: 103,
      metadata: { prompt_version: "<REDACTED_EMAIL>" },
    },
    {
      // (g) legacy linkage in metadata — exercised in the second
      // fixture (no-call_id-column variant). Here it should also
      // resolve because resolveCallId() falls back when column is null.
      id: 6,
      call_id: null,
      metadata: { call_id: 104 },
    },
  ];

  const metrics: MetricRow[] = [
    { id: 100, metadata: { prompt_version: "<REDACTED_EMAIL>" } },
    { id: 101, metadata: { prompt_version: "<REDACTED_EMAIL>" } },
    { id: 102, metadata: {} },
    { id: 104, metadata: { prompt_version: "<REDACTED_EMAIL>" } },
  ];

  const stub1 = makeStubClient(feedback, metrics, { hasCallIdColumn: true });
  const result1: FeedbackPromptVersionBackfillResult =
    await backfillFeedbackPromptVersion(stub1.client);

  assert(
    result1.scanned === 5,
    `(scanned) the 5 rows missing prompt_version visited (got ${result1.scanned})`,
  );
  assert(
    result1.eligible === 4,
    `(eligible) the 4 rows with a resolvable call_id (got ${result1.eligible})`,
  );
  assert(
    result1.rows_updated === 3,
    `(rows_updated) the 3 rows whose linked metric carried a version (got ${result1.rows_updated})`,
  );
  assert(
    result1.missing_source === 1,
    `(missing_source) the 1 eligible row whose metric row had no version (got ${result1.missing_source})`,
  );
  assert(
    result1.unlinked === 1,
    `(unlinked) the 1 row with no call_id linkage at all (got ${result1.unlinked})`,
  );
  assert(
    stub1.updates.length === 3,
    `exactly 3 UPDATE statements issued (got ${stub1.updates.length})`,
  );

  const row1 = stub1.rows.find((r) => r.id === 1)!;
  assert(
    row1.metadata?.prompt_version === "<REDACTED_EMAIL>",
    "row 1 metadata.prompt_version stamped from metric 100",
  );

  const row2 = stub1.rows.find((r) => r.id === 2)!;
  assert(
    row2.metadata?.prompt_version === "<REDACTED_EMAIL>" &&
      row2.metadata?.workflow === "qualityAuditWorkflow" &&
      row2.metadata?.rating_source === "inline_thumbs",
    "row 2 sibling allow-list keys (workflow, rating_source) preserved alongside the new prompt_version",
  );

  const row3 = stub1.rows.find((r) => r.id === 3)!;
  assert(
    row3.metadata?.prompt_version === undefined,
    "row 3 untouched (linked metric had no prompt_version)",
  );

  const row4 = stub1.rows.find((r) => r.id === 4)!;
  assert(
    row4.metadata?.prompt_version === undefined &&
      row4.metadata?.workflow === "qualityAuditWorkflow",
    "row 4 untouched (no call_id linkage) — sibling key preserved",
  );

  const row5 = stub1.rows.find((r) => r.id === 5)!;
  assert(
    row5.metadata?.prompt_version === "<REDACTED_EMAIL>",
    "row 5 untouched — already had prompt_version (SELECT predicate excludes it)",
  );

  const row6 = stub1.rows.find((r) => r.id === 6)!;
  assert(
    row6.metadata?.prompt_version === "<REDACTED_EMAIL>",
    "row 6 backfilled via metadata.call_id fallback even when call_id column is null",
  );

  // (e) idempotency — a second pass reports 0 updates.
  const result2 = await backfillFeedbackPromptVersion(stub1.client);
  assert(
    result2.rows_updated === 0,
    `(idempotent) second pass updates 0 rows (got ${result2.rows_updated})`,
  );

  console.log(
    "\n[backfillFeedbackPromptVersion] legacy schema (no call_id column)",
  );

  const legacyFeedback: FeedbackRow[] = [
    { id: 10, call_id: null, metadata: { call_id: 200 } },
    { id: 11, call_id: null, metadata: {} },
  ];
  const legacyMetrics: MetricRow[] = [
    { id: 200, metadata: { prompt_version: "<REDACTED_EMAIL>" } },
  ];

  const stub2 = makeStubClient(legacyFeedback, legacyMetrics, {
    hasCallIdColumn: false,
  });
  const result3 = await backfillFeedbackPromptVersion(stub2.client);

  assert(
    result3.rows_updated === 1,
    `(legacy) 1 row backfilled via metadata->>'call_id' (got ${result3.rows_updated})`,
  );
  assert(
    result3.unlinked === 1,
    `(legacy) the metadata-less row counted under unlinked (got ${result3.unlinked})`,
  );
  const legacyRow10 = stub2.rows.find((r) => r.id === 10)!;
  assert(
    legacyRow10.metadata?.prompt_version === "<REDACTED_EMAIL>",
    "legacy row 10 backfilled via metadata.call_id linkage",
  );

  console.log(
    "\n[backfillFeedbackPromptVersion] dry-run mode increments counters but issues no UPDATE",
  );

  const dryFeedback: FeedbackRow[] = [
    { id: 20, call_id: 300, metadata: {} },
    { id: 21, call_id: 301, metadata: {} },
  ];
  const dryMetrics: MetricRow[] = [
    { id: 300, metadata: { prompt_version: "<REDACTED_EMAIL>" } },
    { id: 301, metadata: { prompt_version: "<REDACTED_EMAIL>" } },
  ];
  const stub3 = makeStubClient(dryFeedback, dryMetrics, {
    hasCallIdColumn: true,
  });
  const dryResult = await backfillFeedbackPromptVersion(stub3.client, {
    dryRun: true,
  });

  assert(
    dryResult.rows_updated === 2,
    `(dry-run) rows_updated still reflects what would change (got ${dryResult.rows_updated})`,
  );
  assert(
    dryResult.dry_run === true,
    "(dry-run) result echoes dry_run=true so the audit-log entry can record it",
  );
  assert(
    stub3.updates.length === 0,
    `(dry-run) ZERO UPDATE statements issued (got ${stub3.updates.length})`,
  );
  const dryRow20 = stub3.rows.find((r) => r.id === 20)!;
  assert(
    dryRow20.metadata?.prompt_version === undefined,
    "(dry-run) fixture row 20 metadata is unchanged on disk",
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
