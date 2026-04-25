/**
 * Tests for the historical ai_call_metrics preview-column backfill sweep.
 *
 * Covers Task #453 — verifies that `redactAiCallMetrics()` in
 * `src/utils/redactHistoricalLogs.ts` rewrites pre-fix `prompt_preview`,
 * `tool_input_preview`, and `tool_output_preview` rows that contain
 * credential-shaped substrings (sk-…, ghp_…, JWTs, bcrypt hashes,
 * AWS access key IDs), leaves clean rows untouched, is idempotent on a
 * second pass, and reports the per-column scanned/changed counters.
 *
 * Run:  npx tsx tests/aiCallMetricsSweepBackfill.test.ts
 */

import {
  redactAiCallMetrics,
  type AiCallMetricsSweepResult,
} from "../src/utils/redactHistoricalLogs";
import { REDACTED_SENTINEL } from "../src/utils/eventLogsDatabase";

// `redactPromptPreview` runs `redactSecretLikeStrings` (which substitutes
// REDACTED_SENTINEL = `***REDACTED***`) and THEN a PII pass whose
// `(?:password|secret|token|key|auth)\s*[:=]\s*\S+` rule rewrites e.g.
// `key=***REDACTED***` to the shorter `[REDACTED]`. Either marker is a valid
// "redacted" form — assertions accept both.
const PII_REDACTED = "[REDACTED]";
function isRedacted(s: string | null): boolean {
  return s != null && (s.includes(REDACTED_SENTINEL) || s.includes(PII_REDACTED));
}

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
  const rows = initialRows.map(r => ({ ...r }));
  const updates: CapturedUpdate[] = [];

  const query = async (sql: string, params: ReadonlyArray<unknown> = []) => {
    if (/^\s*SELECT/i.test(sql)) {
      return { rows: rows.map(r => ({ ...r })), rowCount: rows.length };
    }
    if (/^\s*UPDATE\s+ai_call_metrics/i.test(sql)) {
      updates.push({ sql, params });
      const id = params[3] as number;
      const target = rows.find(r => r.id === id);
      if (target) {
        target.prompt_preview = params[0] as string | null;
        target.tool_input_preview = params[1] as string | null;
        target.tool_output_preview = params[2] as string | null;
      }
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  return { client: { query }, updates, rows };
}

async function run(): Promise<void> {
  console.log("\n[redactHistoricalLogs] ai_call_metrics preview-column backfill sweep");

  const SECRET_KEY = "sk-live-LEAKED_METRICS_PROMPT_KEY_ABCDEFGHIJKLMNOP";
  const SECRET_GH = "ghp_leakedMetricsToolInput1234567890abcdef";
  const SECRET_BCRYPT = "$2b$12$abcdefghijklmnopqrstuv1234567890ABCDEFGHIJKLMNOPQRSTU";
  const SECRET_JWT =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI3Nzc3NzcifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const SECRET_AKIA = "AKIAIOSFODNN7EXAMPLE";
  const SAFE_PROMPT = "Summarise the latest non-conformance for tenant acme-corp";
  const SAFE_TOOL_INPUT = '{"action":"list","limit":10}';
  const SAFE_TOOL_OUTPUT = '{"status":"ok","count":3}';

  const initial: RowState[] = [
    {
      id: 1,
      prompt_preview: `${SAFE_PROMPT} (rotated key=${SECRET_KEY})`,
      tool_input_preview: null,
      tool_output_preview: null,
    },
    {
      id: 2,
      prompt_preview: SAFE_PROMPT,
      tool_input_preview: `${SAFE_TOOL_INPUT} gh=${SECRET_GH}`,
      tool_output_preview: `legacy_hash=${SECRET_BCRYPT}; aws=${SECRET_AKIA}`,
    },
    {
      id: 3,
      prompt_preview: `bearer ${SECRET_JWT}`,
      tool_input_preview: SAFE_TOOL_INPUT,
      tool_output_preview: SAFE_TOOL_OUTPUT,
    },
    {
      id: 4,
      // Already-clean control row — must NOT be touched.
      prompt_preview: SAFE_PROMPT,
      tool_input_preview: SAFE_TOOL_INPUT,
      tool_output_preview: SAFE_TOOL_OUTPUT,
    },
    {
      id: 5,
      // Already-redacted row — must be byte-identical and not re-updated.
      // Avoid `key=***REDACTED***` here: the PII regex would re-rewrite it
      // to `[REDACTED]`, which while still safe is not byte-identical and
      // would break this idempotency assertion.
      prompt_preview: `Rotate API token (was ${REDACTED_SENTINEL})`,
      tool_input_preview: `legacy hash ${REDACTED_SENTINEL}`,
      tool_output_preview: null,
    },
  ];

  const stub1 = makeStubClient(initial);
  const result1: AiCallMetricsSweepResult = await redactAiCallMetrics(stub1.client);

  assert(result1.scanned === 5, `scanned all 5 rows (got ${result1.scanned})`);
  assert(
    result1.promptPreviewChanged === 2,
    `prompt_preview rewritten on the 2 leaky rows (got ${result1.promptPreviewChanged})`,
  );
  assert(
    result1.toolInputPreviewChanged === 1,
    `tool_input_preview rewritten on the 1 leaky row (got ${result1.toolInputPreviewChanged})`,
  );
  assert(
    result1.toolOutputPreviewChanged === 1,
    `tool_output_preview rewritten on the 1 leaky row (got ${result1.toolOutputPreviewChanged})`,
  );
  assert(
    result1.rowsUpdated === 3,
    `total rows updated = 3 (got ${result1.rowsUpdated})`,
  );
  assert(stub1.updates.length === 3, "exactly 3 UPDATE statements issued");

  const row1 = stub1.rows.find(r => r.id === 1)!;
  assert(
    row1.prompt_preview != null && !row1.prompt_preview.includes(SECRET_KEY),
    "row 1 prompt_preview no longer contains the sk-… token",
  );
  assert(
    isRedacted(row1.prompt_preview),
    "row 1 prompt_preview contains a redaction marker",
  );
  assert(
    row1.prompt_preview != null && row1.prompt_preview.includes("Summarise the latest non-conformance"),
    "row 1 prompt_preview preserves the surrounding human-readable prose",
  );

  const row2 = stub1.rows.find(r => r.id === 2)!;
  assert(
    row2.tool_input_preview != null && !row2.tool_input_preview.includes(SECRET_GH),
    "row 2 tool_input_preview no longer contains the ghp_… token",
  );
  assert(
    row2.tool_output_preview != null &&
      !row2.tool_output_preview.includes(SECRET_BCRYPT) &&
      !row2.tool_output_preview.includes("$2b$12$") &&
      !row2.tool_output_preview.includes(SECRET_AKIA),
    "row 2 tool_output_preview no longer contains the bcrypt hash or AWS access key id",
  );
  assert(
    row2.tool_input_preview != null && row2.tool_input_preview.includes('"action":"list"'),
    "row 2 tool_input_preview preserves the surrounding non-secret JSON",
  );

  const row3 = stub1.rows.find(r => r.id === 3)!;
  assert(
    row3.prompt_preview != null && !row3.prompt_preview.includes(SECRET_JWT),
    "row 3 prompt_preview no longer contains the JWT",
  );
  assert(
    row3.tool_input_preview === SAFE_TOOL_INPUT &&
      row3.tool_output_preview === SAFE_TOOL_OUTPUT,
    "row 3 tool input/output (clean) are byte-identical — no UPDATE issued for them",
  );

  const row4 = stub1.rows.find(r => r.id === 4)!;
  assert(
    row4.prompt_preview === SAFE_PROMPT &&
      row4.tool_input_preview === SAFE_TOOL_INPUT &&
      row4.tool_output_preview === SAFE_TOOL_OUTPUT,
    "row 4 (clean control) is byte-identical — no UPDATE issued",
  );

  const row5 = stub1.rows.find(r => r.id === 5)!;
  assert(
    row5.prompt_preview === `Rotate API token (was ${REDACTED_SENTINEL})` &&
      row5.tool_input_preview === `legacy hash ${REDACTED_SENTINEL}` &&
      row5.tool_output_preview === null,
    "row 5 (already-redacted) is byte-identical — no UPDATE issued",
  );

  // ---- Idempotency: a second pass over the now-clean dataset must be a no-op
  const stub2 = makeStubClient(stub1.rows);
  const result2 = await redactAiCallMetrics(stub2.client);

  assert(result2.scanned === 5, "second pass still scans all 5 rows");
  assert(
    result2.rowsUpdated === 0,
    `second pass updates 0 rows (got ${result2.rowsUpdated}) — script is idempotent`,
  );
  assert(
    result2.promptPreviewChanged === 0 &&
      result2.toolInputPreviewChanged === 0 &&
      result2.toolOutputPreviewChanged === 0,
    "second pass reports zero per-column changes",
  );
  assert(stub2.updates.length === 0, "second pass issues no UPDATE statements");

  // ---- Combined column changes: all 3 preview columns dirty in same row
  const combined: RowState[] = [
    {
      id: 10,
      prompt_preview: `prompt with key=${SECRET_KEY}`,
      tool_input_preview: `input with gh=${SECRET_GH}`,
      tool_output_preview: `output with jwt=${SECRET_JWT}`,
    },
  ];
  const stub3 = makeStubClient(combined);
  const result3 = await redactAiCallMetrics(stub3.client);

  assert(
    result3.promptPreviewChanged === 1 &&
      result3.toolInputPreviewChanged === 1 &&
      result3.toolOutputPreviewChanged === 1,
    "combined-fixture row reports change on prompt_preview, tool_input_preview, AND tool_output_preview",
  );
  assert(
    result3.rowsUpdated === 1,
    "combined-fixture row counts as a single UPDATE",
  );
  const combinedRow = stub3.rows[0];
  assert(
    combinedRow.prompt_preview != null && !combinedRow.prompt_preview.includes(SECRET_KEY) &&
      isRedacted(combinedRow.prompt_preview),
    "combined row prompt_preview is scrubbed and contains a redaction marker",
  );
  assert(
    combinedRow.tool_input_preview != null && !combinedRow.tool_input_preview.includes(SECRET_GH) &&
      isRedacted(combinedRow.tool_input_preview),
    "combined row tool_input_preview is scrubbed and contains a redaction marker",
  );
  assert(
    combinedRow.tool_output_preview != null && !combinedRow.tool_output_preview.includes(SECRET_JWT) &&
      isRedacted(combinedRow.tool_output_preview),
    "combined row tool_output_preview is scrubbed and contains a redaction marker",
  );

  // ---- Empty / null preview columns must be tolerated and not counted as changes
  const empties: RowState[] = [
    { id: 20, prompt_preview: null, tool_input_preview: null, tool_output_preview: null },
    { id: 21, prompt_preview: "", tool_input_preview: "", tool_output_preview: "" },
  ];
  const stub4 = makeStubClient(empties);
  const result4 = await redactAiCallMetrics(stub4.client);
  assert(result4.scanned === 2, `empty-fixture: scanned 2 rows (got ${result4.scanned})`);
  assert(
    result4.rowsUpdated === 0,
    `empty-fixture: 0 rows updated (got ${result4.rowsUpdated}) — null/empty previews are skipped`,
  );

  // ---- Keyset pagination: with batchSize=1 the sweep must walk all rows
  const paginated: RowState[] = [
    { id: 100, prompt_preview: `key=${SECRET_KEY}`, tool_input_preview: null, tool_output_preview: null },
    { id: 101, prompt_preview: `gh=${SECRET_GH}`,  tool_input_preview: null, tool_output_preview: null },
    { id: 102, prompt_preview: SAFE_PROMPT,        tool_input_preview: null, tool_output_preview: null },
  ];
  const stub5 = makeStubClient(paginated);
  // Override the SELECT so it honours the cursor + LIMIT, mimicking real Postgres
  stub5.client.query = (async (sql: string, params: ReadonlyArray<unknown> = []) => {
    if (/^\s*SELECT/i.test(sql)) {
      const cursor = params[0] as number;
      const limit = params[1] as number;
      const slice = stub5.rows
        .filter(r => r.id > cursor)
        .sort((a, b) => a.id - b.id)
        .slice(0, limit)
        .map(r => ({ ...r }));
      return { rows: slice, rowCount: slice.length };
    }
    if (/^\s*UPDATE\s+ai_call_metrics/i.test(sql)) {
      stub5.updates.push({ sql, params });
      const id = params[3] as number;
      const target = stub5.rows.find(r => r.id === id);
      if (target) {
        target.prompt_preview = params[0] as string | null;
        target.tool_input_preview = params[1] as string | null;
        target.tool_output_preview = params[2] as string | null;
      }
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as any;

  const result5 = await redactAiCallMetrics(stub5.client, 1);
  assert(
    result5.scanned === 3,
    `pagination fixture: scanned 3 rows across batches of 1 (got ${result5.scanned})`,
  );
  assert(
    result5.rowsUpdated === 2,
    `pagination fixture: 2 leaky rows updated (got ${result5.rowsUpdated})`,
  );
  const pagedRow100 = stub5.rows.find(r => r.id === 100)!;
  const pagedRow101 = stub5.rows.find(r => r.id === 101)!;
  const pagedRow102 = stub5.rows.find(r => r.id === 102)!;
  assert(
    pagedRow100.prompt_preview != null && !pagedRow100.prompt_preview.includes(SECRET_KEY),
    "pagination fixture row 100: sk-… scrubbed across batch boundary",
  );
  assert(
    pagedRow101.prompt_preview != null && !pagedRow101.prompt_preview.includes(SECRET_GH),
    "pagination fixture row 101: ghp_… scrubbed across batch boundary",
  );
  assert(
    pagedRow102.prompt_preview === SAFE_PROMPT,
    "pagination fixture row 102 (clean) is byte-identical — no UPDATE issued",
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
