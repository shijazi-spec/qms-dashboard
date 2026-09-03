/**
 * Task #744 — historical sweep coverage for secrets buried inside
 * stringified-JSON column values, plus dry-run / preview support.
 *
 * Background
 * ----------
 * Task #684 added a JSON-of-JSON re-parse step to the live write path so
 * that when a caller stores a `JSON.stringify(payload)` blob inside an
 * audit column whose value is itself a string, any sensitive field name
 * (`mfa_secret`, `api_key`, …) inside the parsed object is sentinel'd
 * before the row reaches Postgres. The historical sweep
 * (`redactHistoricalLogs.ts`) only walked top-level string columns through
 * the regex pass and did NOT re-parse string values into JSON, so rows
 * written before Task #684 could still carry unredacted secrets in those
 * nested-JSON values.
 *
 * What this test exercises
 * ------------------------
 *   1. `redactEventLogs` rewrites an `event_logs.description` whose value
 *      is a stringified JSON blob containing a sensitive field
 *      (`mfa_secret` whose value is a shape-less UUID — uncatchable by
 *      the regex pass alone), and reports the change in the new
 *      per-column counter.
 *   2. The same sweep run with `{ dryRun: true }` produces identical
 *      counters but issues NO `UPDATE` statements (preview mode).
 *   3. `redactChangeHistoryTable` does the same for nested-JSON values
 *      stored under a non-sensitive `field_changed` (e.g. `payload`).
 *   4. `redactAiPendingActions` does the same for a `payload_preview`
 *      that is itself a JSON-stringified payload.
 *   5. `parseDryRunFromArgv` accepts both `--dry-run` and `--dryRun`.
 *
 * Run:  npx tsx tests/redactHistoricalNestedJson.test.ts
 */

import {
  redactEventLogs,
  redactChangeHistoryTable,
  redactAiPendingActions,
  parseDryRunFromArgv,
  DEFAULT_SWEEP_BATCH_SIZE,
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

interface Captured {
  sql: string;
  params: ReadonlyArray<unknown>;
}

function makeStub<TRow extends { id: number }>(
  rows: TRow[],
  selectMatcher: RegExp,
  applyUpdate: (row: TRow, params: ReadonlyArray<unknown>) => void,
): {
  client: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<any> };
  updates: Captured[];
  rows: TRow[];
} {
  const stored = rows.map((r) => ({ ...r }));
  stored.sort((a, b) => a.id - b.id);
  const updates: Captured[] = [];

  const query = async (
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<any> => {
    if (/^\s*SELECT/i.test(sql)) {
      if (!selectMatcher.test(sql)) {
        throw new Error(`unexpected SELECT:\n${sql}`);
      }
      const cursor = Number(params[0] ?? 0);
      const limit = Number(params[1] ?? stored.length);
      const page = stored.filter((r) => r.id > cursor).slice(0, limit);
      return { rows: page.map((r) => ({ ...r })), rowCount: page.length };
    }
    if (/^\s*UPDATE/i.test(sql)) {
      updates.push({ sql, params });
      const id = Number(params[params.length - 1]);
      const target = stored.find((r) => r.id === id);
      if (target) applyUpdate(target, params);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  return { client: { query }, updates, rows: stored };
}

const MFA_SECRET_UUID = "<REDACTED_SECRET>";

// =============================================================================
// 1. event_logs — description column carrying a stringified-JSON secret
// =============================================================================
{
  console.log(
    "\n[redactEventLogs] description with stringified-JSON secret (Task #744)\n",
  );

  interface ELRow {
    id: number;
    description: string | null;
    entity_name: string | null;
    old_value: any;
    new_value: any;
  }

  // The description is itself a stringified JSON object whose `mfa_secret`
  // key is sensitive. The regex pass alone cannot catch a shape-less UUID,
  // so the row would silently keep its secret without the JSON-of-JSON
  // re-parse step added in Task #744.
  const nestedDescription = JSON.stringify({
    user: "alice",
    mfa_secret: MFA_SECRET_UUID,
    note: "Enrolled on 2026-01-12",
  });

  const initial: ELRow[] = [
    {
      id: 1,
      description: nestedDescription,
      entity_name: "AuthService",
      old_value: null,
      new_value: null,
    },
    // A second row whose new_value JSONB contains a STRING leaf that is
    // itself stringified JSON with an api_key field — the JSON-of-JSON
    // case the live path fixed in Task #684.
    {
      id: 2,
      description: "Imported integration config",
      entity_name: "IntegrationSync",
      old_value: null,
      new_value: {
        provider: "PaymentProvider",
        // Note: this value is a STRING that happens to be JSON.
        raw_payload: JSON.stringify({ api_key: "<REDACTED_SECRET>" }),
      },
    },
  ];

  const stub = makeStub<ELRow>(
    initial,
    /SELECT\s+id,\s*description,\s*entity_name/i,
    (row, params) => {
      row.description = params[0] as string | null;
      row.entity_name = params[1] as string | null;
      row.old_value = params[2] != null ? JSON.parse(String(params[2])) : null;
      row.new_value = params[3] != null ? JSON.parse(String(params[3])) : null;
    },
  );

  const result = await redactEventLogs(stub.client);

  assert(result.scanned === 2, `scanned 2 rows (got ${result.scanned})`);
  assert(
    result.descriptionChanged === 1,
    `descriptionChanged === 1 (got ${result.descriptionChanged})`,
  );
  assert(
    result.newValueChanged === 1,
    `newValueChanged === 1 (got ${result.newValueChanged})`,
  );
  assert(
    result.rowsUpdated === 2,
    `rowsUpdated === 2 (got ${result.rowsUpdated})`,
  );
  assert(stub.updates.length === 2, `2 UPDATE statements issued`);

  const row1 = stub.rows.find((r) => r.id === 1)!;
  assert(
    !row1.description!.includes(MFA_SECRET_UUID),
    "row 1: mfa_secret UUID removed from description",
  );
  assert(
    row1.description!.includes(REDACTED_SENTINEL),
    "row 1: sentinel present in description",
  );
  // The re-stringified JSON should still be parseable and preserve the
  // non-sensitive sibling fields verbatim.
  const reparsed = JSON.parse(row1.description!);
  assert(
    reparsed.mfa_secret === REDACTED_SENTINEL,
    "row 1: parsed JSON has mfa_secret replaced by sentinel",
  );
  assert(
    reparsed.user === "alice" && reparsed.note === "Enrolled on 2026-01-12",
    "row 1: parsed JSON preserves non-sensitive sibling fields",
  );

  const row2 = stub.rows.find((r) => r.id === 2)!;
  assert(
    typeof row2.new_value.raw_payload === "string" &&
      !row2.new_value.raw_payload.includes("<REDACTED_TOKEN>"),
    "row 2: api_key inside stringified-JSON leaf was redacted",
  );
  assert(
    row2.new_value.raw_payload.includes(REDACTED_SENTINEL),
    "row 2: sentinel present in re-stringified raw_payload",
  );
  assert(
    row2.new_value.provider === "PaymentProvider",
    "row 2: non-secret sibling JSONB key preserved",
  );
}

// =============================================================================
// 2. event_logs dry-run mode: same counters, ZERO UPDATEs
// =============================================================================
{
  console.log(
    "\n[redactEventLogs] dry-run preview pass (Task #744)\n",
  );

  interface ELRow {
    id: number;
    description: string | null;
    entity_name: string | null;
    old_value: any;
    new_value: any;
  }

  const initial: ELRow[] = [
    {
      id: 10,
      description: JSON.stringify({ mfa_secret: MFA_SECRET_UUID }),
      entity_name: null,
      old_value: null,
      new_value: null,
    },
    {
      id: 11,
      description: "totally clean",
      entity_name: null,
      old_value: null,
      new_value: null,
    },
  ];

  const stub = makeStub<ELRow>(
    initial,
    /SELECT\s+id,\s*description,\s*entity_name/i,
    (row, params) => {
      row.description = params[0] as string | null;
    },
  );

  const result = await redactEventLogs(stub.client, DEFAULT_SWEEP_BATCH_SIZE, {
    dryRun: true,
  });

  assert(
    result.rowsUpdated === 1,
    `dry-run reports rowsUpdated=1 (got ${result.rowsUpdated})`,
  );
  assert(
    result.descriptionChanged === 1,
    "dry-run reports descriptionChanged=1",
  );
  assert(
    stub.updates.length === 0,
    `dry-run issues NO UPDATE statements (got ${stub.updates.length})`,
  );
  // The on-disk row is unchanged after a dry run.
  assert(
    stub.rows.find((r) => r.id === 10)!.description!.includes(MFA_SECRET_UUID),
    "dry-run: stored description still contains the secret (no commit)",
  );
}

// =============================================================================
// 3. *_change_history — non-sensitive field name carrying stringified JSON
// =============================================================================
{
  console.log(
    "\n[redactChangeHistoryTable] stringified-JSON new_value (Task #744)\n",
  );

  interface CHRow {
    id: number;
    field_changed: string;
    old_value: string | null;
    new_value: string | null;
    change_reason: string | null;
  }

  const initial: CHRow[] = [
    {
      id: 1,
      field_changed: "payload",
      old_value: null,
      new_value: JSON.stringify({
        action: "rotate",
        api_key: "<REDACTED_SECRET>",
      }),
      change_reason: "scheduled rotation",
    },
  ];

  const stub = makeStub<CHRow>(
    initial,
    /SELECT\s+id,\s*field_changed/i,
    (row, params) => {
      row.old_value = params[0] as string | null;
      row.new_value = params[1] as string | null;
      row.change_reason = params[2] as string | null;
    },
  );

  const result = await redactChangeHistoryTable(stub.client, "nc_change_history");

  assert(result.rowsUpdated === 1, `rowsUpdated === 1 (got ${result.rowsUpdated})`);
  assert(
    result.newValueChanged === 1,
    `newValueChanged === 1 (got ${result.newValueChanged})`,
  );
  assert(result.scanned === 1, "scanned counter populated");

  const r1 = stub.rows.find((r) => r.id === 1)!;
  assert(
    !r1.new_value!.includes("rotated-uuid-only"),
    "new_value: api_key UUID removed via JSON re-parse",
  );
  assert(
    r1.new_value!.includes(REDACTED_SENTINEL),
    "new_value: sentinel present in re-stringified payload",
  );

  // Dry-run mode on the same dataset: counters match, zero UPDATEs.
  const stub2 = makeStub<CHRow>(
    initial,
    /SELECT\s+id,\s*field_changed/i,
    () => {},
  );
  const result2 = await redactChangeHistoryTable(
    stub2.client,
    "nc_change_history",
    DEFAULT_SWEEP_BATCH_SIZE,
    { dryRun: true },
  );
  assert(
    result2.rowsUpdated === 1 && stub2.updates.length === 0,
    "change_history dry-run: counters non-zero, UPDATE count = 0",
  );
}

// =============================================================================
// 4. ai_pending_actions — preview that is a stringified payload
// =============================================================================
{
  console.log(
    "\n[redactAiPendingActions] payload_preview as stringified JSON (Task #744)\n",
  );

  interface AiRow {
    id: number;
    payload: any;
    payload_preview: string | null;
    execution_result: any;
  }

  const initial: AiRow[] = [
    {
      id: 1,
      payload: null,
      // Older buildPreview() callbacks sometimes serialised the whole
      // payload as JSON for the preview field. The api_key value is a
      // plain UUID that the regex pass cannot catch alone.
      payload_preview: JSON.stringify({
        op: "deploy",
        api_key: "<REDACTED_SECRET>",
      }),
      execution_result: null,
    },
  ];

  const stub = makeStub<AiRow>(
    initial,
    /SELECT\s+id,\s*payload,\s*payload_preview/i,
    (row, params) => {
      row.payload =
        params[0] != null ? JSON.parse(String(params[0])) : null;
      row.payload_preview = params[1] as string | null;
      row.execution_result =
        params[2] != null ? JSON.parse(String(params[2])) : null;
    },
  );

  const result = await redactAiPendingActions(stub.client);

  assert(result.rowsUpdated === 1, `rowsUpdated === 1 (got ${result.rowsUpdated})`);
  assert(
    result.previewChanged === 1,
    `previewChanged === 1 (got ${result.previewChanged})`,
  );

  const r1 = stub.rows.find((r) => r.id === 1)!;
  assert(
    !r1.payload_preview!.includes("uuid-shaped-key"),
    "payload_preview: api_key value redacted via JSON re-parse",
  );
  assert(
    r1.payload_preview!.includes(REDACTED_SENTINEL),
    "payload_preview: sentinel present after re-stringification",
  );
}

// =============================================================================
// 5. CLI argv parsing for --dry-run / --dryRun
// =============================================================================
{
  console.log("\n[parseDryRunFromArgv] CLI flag detection (Task #744)\n");

  assert(parseDryRunFromArgv([]) === false, "no flag → false");
  assert(parseDryRunFromArgv(["--dry-run"]) === true, "--dry-run → true");
  assert(parseDryRunFromArgv(["--dryRun"]) === true, "--dryRun → true");
  assert(
    parseDryRunFromArgv(["--other", "--dry-run", "extra"]) === true,
    "flag detected anywhere in argv",
  );
  assert(
    parseDryRunFromArgv(["--no-dry-run"]) === false,
    "unknown flag does NOT enable dry-run",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
