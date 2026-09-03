/**
 * Unit tests for the ai_pending_actions.payload_preview backfill logic
 * in redactHistoricalLogs.ts (Task #67).
 *
 * Verifies that redactAiPendingActions() reads existing TEXT rows, runs
 * them through redactSecretLikeStrings(), and UPDATEs only those rows
 * whose sanitised value differs from the stored value.
 *
 * Run: npx tsx tests/redactHistoricalPreview.test.ts
 */

import { redactAiPendingActions } from "../src/utils/redactHistoricalLogs";
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

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

function buildFakeClient(rows: Record<string, unknown>[]): {
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
  captured: CapturedQuery[];
} {
  const captured: CapturedQuery[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      captured.push({ sql, params });
      if (/SELECT\s+id/i.test(sql)) {
        return { rows };
      }
      return { rows: [] };
    },
  };
  return { client, captured };
}

// ---------------------------------------------------------------------------
// Test 1: row containing a ghp_ SourceControlProvider token in payload_preview is rewritten
// ---------------------------------------------------------------------------
console.log("\n=== redactAiPendingActions — payload_preview backfill ===\n");

{
  const GHP_TOKEN = "<REDACTED_SECRET>";
  const previewWithLeak = `Approve SourceControlProvider deploy for repo ExampleOrg/api — token=${GHP_TOKEN}`;

  const rows = [
    {
      id: 42,
      payload: null,
      payload_preview: previewWithLeak,
      execution_result: null,
    },
  ];

  const { client, captured } = buildFakeClient(rows);
  const result = await redactAiPendingActions(client);

  assert(result.scanned === 1, "scanned count = 1");
  assert(result.previewChanged === 1, "previewChanged count = 1");
  assert(result.rowsUpdated === 1, "rowsUpdated count = 1");
  assert(result.payloadChanged === 0, "payloadChanged count = 0 (no JSONB payload)");
  assert(result.executionResultChanged === 0, "executionResultChanged = 0 (no execution_result)");

  const updateCall = captured.find(c => /UPDATE ai_pending_actions/i.test(c.sql));
  assert(!!updateCall, "UPDATE ai_pending_actions was issued");

  if (updateCall) {
    const newPreview = updateCall.params[1] as string;
    assert(
      !newPreview.includes(GHP_TOKEN),
      "UPDATE param for payload_preview does not contain the ghp_… token",
    );
    assert(
      newPreview.includes(REDACTED_SENTINEL),
      "UPDATE param for payload_preview contains the REDACTED sentinel",
    );
    assert(
      newPreview.includes("Approve SourceControlProvider deploy for repo"),
      "UPDATE param preserves surrounding prose after redaction",
    );
    assert(updateCall.params[3] === 42, "UPDATE WHERE id matches the row id");
  }
}

// ---------------------------------------------------------------------------
// Test 2: row whose preview is already clean is NOT updated (idempotent)
// ---------------------------------------------------------------------------
{
  const safePreview = "Approve budget increase for department IT from $5000 to $7500";

  const rows = [
    {
      id: 99,
      payload: null,
      payload_preview: safePreview,
      execution_result: null,
    },
  ];

  const { client, captured } = buildFakeClient(rows);
  const result = await redactAiPendingActions(client);

  assert(result.scanned === 1, "idempotent: scanned count = 1");
  assert(result.previewChanged === 0, "idempotent: previewChanged = 0 for clean row");
  assert(result.rowsUpdated === 0, "idempotent: rowsUpdated = 0 for clean row");

  const updateCall = captured.find(c => /UPDATE ai_pending_actions/i.test(c.sql));
  assert(!updateCall, "idempotent: no UPDATE issued for clean row");
}

// ---------------------------------------------------------------------------
// Test 3: already-redacted preview (sentinel already present) is not re-updated
// ---------------------------------------------------------------------------
{
  const alreadyRedacted = `Approve key rotation — token=${REDACTED_SENTINEL}`;

  const rows = [
    {
      id: 7,
      payload: null,
      payload_preview: alreadyRedacted,
      execution_result: null,
    },
  ];

  const { client, captured } = buildFakeClient(rows);
  const result = await redactAiPendingActions(client);

  assert(result.scanned === 1, "idempotent: scanned count = 1");
  assert(result.rowsUpdated === 0, "idempotent: already-sentinel preview skipped");

  const updateCall = captured.find(c => /UPDATE ai_pending_actions/i.test(c.sql));
  assert(!updateCall, "idempotent: no UPDATE issued for already-redacted row");
}

// ---------------------------------------------------------------------------
// Test 4: multiple rows — only the dirty ones are updated
// ---------------------------------------------------------------------------
{
  const SK_KEY = "<REDACTED_TOKEN>";
  const GHP2 = "<REDACTED_TOKEN>";

  const rows = [
    {
      id: 10,
      payload: null,
      payload_preview: `Rotate PaymentProvider key: ${SK_KEY}`,
      execution_result: null,
    },
    {
      id: 11,
      payload: null,
      payload_preview: "Deploy app v2.3.1 to production",
      execution_result: null,
    },
    {
      id: 12,
      payload: null,
      payload_preview: `SourceControlProvider action triggered with token=${GHP2}`,
      execution_result: null,
    },
  ];

  const { client, captured } = buildFakeClient(rows);
  const result = await redactAiPendingActions(client);

  assert(result.scanned === 3, "multi: scanned count = 3");
  assert(result.previewChanged === 2, "multi: previewChanged = 2 (rows 10 and 12)");
  assert(result.rowsUpdated === 2, "multi: rowsUpdated = 2");

  const updateCalls = captured.filter(c => /UPDATE ai_pending_actions/i.test(c.sql));
  assert(updateCalls.length === 2, "multi: exactly 2 UPDATE statements issued");

  const updatedIds = updateCalls.map(c => c.params[3]);
  assert(updatedIds.includes(10), "multi: row id=10 (sk_live_ leak) was updated");
  assert(updatedIds.includes(12), "multi: row id=12 (ghp_ leak) was updated");
  assert(!updatedIds.includes(11), "multi: row id=11 (clean prose) was NOT updated");
}

// ---------------------------------------------------------------------------
// Test 5: null payload_preview is skipped gracefully
// ---------------------------------------------------------------------------
{
  const rows = [
    {
      id: 55,
      payload: null,
      payload_preview: null,
      execution_result: null,
    },
  ];

  const { client, captured } = buildFakeClient(rows);
  const result = await redactAiPendingActions(client);

  assert(result.scanned === 1, "null-preview: scanned count = 1");
  assert(result.previewChanged === 0, "null-preview: previewChanged = 0");
  assert(result.rowsUpdated === 0, "null-preview: no UPDATE for null preview");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error(
    "\n❌ redactHistoricalPreview tests FAILED — historical payload_preview backfill may be broken.",
  );
  process.exit(1);
}

console.log("\n✅ All redactHistoricalPreview tests passed");
process.exit(0);
