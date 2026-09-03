/**
 * Tests for credential-leak protection on the `ai_call_metrics.error_message`
 * TEXT column.
 *
 * Tool / LLM error strings frequently echo the input that triggered them
 * (e.g. "Connection failed with key sk-live-…"). Without redaction those
 * substrings would land in the metrics table verbatim — exactly the same
 * class of leak that Task #256 closed for `ai_pending_actions.execution_result.error`.
 *
 * Verifies that every write path that persists `error_message`
 * (`insertAiCallMetric`, `finalizeAiCallMetric` via `withAiTelemetry`,
 *  the fire-and-forget INSERT inside `wrapToolWithTelemetry`) routes the
 * string through `redactSecretLikeStrings()` before reaching the database.
 *
 * The test stubs `pg.Pool.prototype.query` so it captures the SQL parameters
 * that would be sent to Postgres without requiring a live DATABASE_URL.
 *
 * Run:  npx tsx tests/aiTelemetryErrorRedaction.test.ts
 */

import pg from 'pg';

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

const captured: CapturedQuery[] = [];

// ── Stub pool.query BEFORE importing aiTelemetry ────────────────────────────
// aiTelemetry constructs a `new Pool(...)` at module-load time, so we patch
// the prototype method to intercept every query made through it.
const originalQuery = pg.Pool.prototype.query;
let nextInsertId = 1;
(pg.Pool.prototype as unknown as { query: unknown }).query = async function stubQuery(
  this: pg.Pool,
  sql: unknown,
  params?: ReadonlyArray<unknown>,
): Promise<unknown> {
  if (typeof sql !== 'string') {
    return (originalQuery as unknown as (...args: unknown[]) => unknown).apply(this, [sql, params]);
  }
  captured.push({ sql, params: params ?? [] });
  const empty = { command: '', rowCount: 0, oid: 0, fields: [], rows: [] as unknown[] };
  if (/^\s*CREATE TABLE/i.test(sql) || /^\s*ALTER TABLE/i.test(sql) || /^\s*CREATE INDEX/i.test(sql)) {
    return empty;
  }
  if (/INSERT INTO ai_call_metrics/i.test(sql) && /RETURNING id/i.test(sql)) {
    return { ...empty, command: 'INSERT', rowCount: 1, rows: [{ id: nextInsertId++ }] };
  }
  if (/UPDATE ai_call_metrics/i.test(sql)) {
    return { ...empty, command: 'UPDATE', rowCount: 1 };
  }
  return empty;
} as typeof pg.Pool.prototype.query;

// Force-load aiTelemetry AFTER the stub is in place.
const {
  redactErrorMessageForStorage,
  insertAiCallMetric,
  withAiTelemetry,
  wrapToolWithTelemetry,
} = await import('../src/utils/aiTelemetry');
const { REDACTED_SENTINEL } = await import('../src/utils/eventLogsDatabase');

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

function findLast(predicate: (c: CapturedQuery) => boolean): CapturedQuery | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (predicate(captured[i])) return captured[i];
  }
  return undefined;
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1000,
  intervalMs = 10,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return predicate();
}

const SK_KEY = '<REDACTED_TOKEN>';
const GH_PAT = '<REDACTED_TOKEN>';
const JWT =
  '<REDACTED_TOKEN>';
const BCRYPT_HASH = '<REDACTED_PASSWORD_HASH>';
const AWS_KEY = '<REDACTED_TOKEN>';

async function run(): Promise<void> {
  // ── 1. Pure helper: redactErrorMessageForStorage ───────────────────────
  console.log('\nredactErrorMessageForStorage():');

  assert(redactErrorMessageForStorage(undefined) === null, 'undefined input -> null');
  assert(redactErrorMessageForStorage(null) === null, 'null input -> null');
  assert(redactErrorMessageForStorage('') === null, 'empty string -> null');

  const safe = redactErrorMessageForStorage('Connection refused after 3 retries');
  assert(safe === 'Connection refused after 3 retries', 'safe error string passes through unchanged');

  const skScrubbed = redactErrorMessageForStorage(`Connection failed with key ${SK_KEY}`);
  assert(
    !!skScrubbed && !skScrubbed.includes(SK_KEY) && skScrubbed.includes(REDACTED_SENTINEL),
    'sk-… credential in error string is replaced with the sentinel',
  );

  const ghScrubbed = redactErrorMessageForStorage(`401 Unauthorized — header: Authorization: Bearer ${GH_PAT}`);
  assert(
    !!ghScrubbed && !ghScrubbed.includes(GH_PAT) && ghScrubbed.includes(REDACTED_SENTINEL),
    'ghp_… credential in error string is replaced with the sentinel',
  );

  const jwtScrubbed = redactErrorMessageForStorage(`JWT verify failed for token=${JWT}`);
  assert(
    !!jwtScrubbed && !jwtScrubbed.includes(JWT) && jwtScrubbed.includes(REDACTED_SENTINEL),
    'JWT in error string is replaced with the sentinel',
  );

  const bcryptScrubbed = redactErrorMessageForStorage(`Hash mismatch: stored=${BCRYPT_HASH}`);
  assert(
    !!bcryptScrubbed && !bcryptScrubbed.includes('$2b$12$') && bcryptScrubbed.includes(REDACTED_SENTINEL),
    'bcrypt hash in error string is replaced with the sentinel',
  );

  const awsScrubbed = redactErrorMessageForStorage(`AWS API rejected request from ${AWS_KEY}`);
  assert(
    !!awsScrubbed && !awsScrubbed.includes(AWS_KEY) && awsScrubbed.includes(REDACTED_SENTINEL),
    'AWS access key in error string is replaced with the sentinel',
  );

  const longInput = 'X'.repeat(2000) + ` ${SK_KEY}`;
  const truncated = redactErrorMessageForStorage(longInput);
  assert(
    !!truncated && truncated.length === 500,
    'output is capped at 500 chars (column budget)',
  );

  // ── 2. insertAiCallMetric persists redacted error_message ──────────────
  console.log('\ninsertAiCallMetric() scrubs row.error_message before INSERT:');

  captured.length = 0;
  await insertAiCallMetric({
    agent_name: 'test-agent',
    tool_name: 'rotate_api_key',
    model: 'tool',
    latency_ms: 42,
    success: false,
    error_class: 'ToolReturnedFailure',
    error_message: `Upstream API rejected key ${SK_KEY}; bearer was ${GH_PAT}`,
  });

  const insertCall = findLast(c =>
    /INSERT INTO ai_call_metrics/i.test(c.sql) && /RETURNING id/i.test(c.sql),
  );
  assert(!!insertCall, 'INSERT INTO ai_call_metrics issued by insertAiCallMetric()');
  // Column order: agent_name(1), tool_name(2), parent_call_id(3), model(4),
  //               prompt_tokens(5), completion_tokens(6), total_tokens(7),
  //               latency_ms(8), estimated_cost_usd(9), success(10),
  //               error_class(11), error_message(12), ...
  const insertedErrorMessage = insertCall!.params[11] as string | null;
  assert(
    typeof insertedErrorMessage === 'string' && !insertedErrorMessage.includes(SK_KEY),
    'persisted error_message does NOT contain the sk-… key',
  );
  assert(
    typeof insertedErrorMessage === 'string' && !insertedErrorMessage.includes(GH_PAT),
    'persisted error_message does NOT contain the ghp_… token',
  );
  assert(
    typeof insertedErrorMessage === 'string' && insertedErrorMessage.includes(REDACTED_SENTINEL),
    'persisted error_message contains the redaction sentinel',
  );
  assert(
    typeof insertedErrorMessage === 'string' && insertedErrorMessage.includes('Upstream API rejected'),
    'persisted error_message preserves the surrounding non-secret prose',
  );

  // ── 3. wrapToolWithTelemetry failure path scrubs error_message ─────────
  console.log('\nwrapToolWithTelemetry() failure path scrubs the rethrown error message:');

  captured.length = 0;
  const sadTool = {
    id: 'sad-tool',
    execute: async (_args: Record<string, unknown>) => {
      throw new Error(`Backend rejected request: token=${SK_KEY}`);
    },
  };
  const wrappedSad = wrapToolWithTelemetry(sadTool, 'test-agent');
  let threw = false;
  try {
    await wrappedSad.execute!({ input: 'whatever' });
  } catch (err) {
    threw = err instanceof Error;
  }
  assert(threw, 'wrapper rethrew the original error');

  // The wrapper writes telemetry fire-and-forget from `finally`, so wait
  // briefly for the captured INSERT to land.
  const arrived = await waitForCondition(() =>
    !!findLast(c => /INSERT INTO ai_call_metrics/i.test(c.sql) && /RETURNING id/i.test(c.sql)),
  );
  assert(arrived, 'wrapToolWithTelemetry queued the failed-call INSERT');

  const wrappedInsert = findLast(c =>
    /INSERT INTO ai_call_metrics/i.test(c.sql) && /RETURNING id/i.test(c.sql),
  );
  const wrappedErrorMessage = wrappedInsert!.params[11] as string | null;
  assert(
    typeof wrappedErrorMessage === 'string' && !wrappedErrorMessage.includes(SK_KEY),
    'wrapped failure-path error_message does NOT contain the sk-… token',
  );
  assert(
    typeof wrappedErrorMessage === 'string' && wrappedErrorMessage.includes(REDACTED_SENTINEL),
    'wrapped failure-path error_message contains the redaction sentinel',
  );

  // ── 4. wrapToolWithTelemetry soft-fail (success:false, error:string) ────
  console.log('\nwrapToolWithTelemetry() soft-fail path scrubs result.error string:');

  captured.length = 0;
  const softFailTool = {
    id: 'softfail-tool',
    execute: async (_args: Record<string, unknown>) => ({
      success: false,
      error: `Connection failed with key ${SK_KEY} and bearer ${GH_PAT}`,
    }),
  };
  const wrappedSoft = wrapToolWithTelemetry(softFailTool, 'test-agent');
  await wrappedSoft.execute!({ ok: true });

  const softArrived = await waitForCondition(() =>
    !!findLast(c => /INSERT INTO ai_call_metrics/i.test(c.sql) && /RETURNING id/i.test(c.sql)),
  );
  assert(softArrived, 'wrapToolWithTelemetry queued the soft-fail INSERT');

  const softInsert = findLast(c =>
    /INSERT INTO ai_call_metrics/i.test(c.sql) && /RETURNING id/i.test(c.sql),
  );
  const softErrorMessage = softInsert!.params[11] as string | null;
  assert(
    typeof softErrorMessage === 'string' && !softErrorMessage.includes(SK_KEY),
    'soft-fail error_message does NOT contain the sk-… key from result.error',
  );
  assert(
    typeof softErrorMessage === 'string' && !softErrorMessage.includes(GH_PAT),
    'soft-fail error_message does NOT contain the ghp_… token from result.error',
  );
  assert(
    typeof softErrorMessage === 'string' && softErrorMessage.includes(REDACTED_SENTINEL),
    'soft-fail error_message contains the redaction sentinel',
  );

  // ── 5. finalizeAiCallMetric (via withAiTelemetry) scrubs UPDATE param ──
  console.log('\nwithAiTelemetry() finalize path scrubs error_message on UPDATE:');

  captured.length = 0;
  let caughtFromAgent: Error | null = null;
  try {
    await withAiTelemetry(
      { agentName: 'test-agent', model: 'gpt-4o-mini', promptText: 'hello' },
      async () => {
        throw new Error(`LLM call failed: api_key=${SK_KEY}`);
      },
    );
  } catch (err) {
    caughtFromAgent = err instanceof Error ? err : new Error(String(err));
  }
  assert(!!caughtFromAgent, 'withAiTelemetry rethrew the underlying error');

  const updateCall = findLast(c => /UPDATE ai_call_metrics/i.test(c.sql));
  assert(!!updateCall, 'withAiTelemetry issued an UPDATE on failure');
  // finalizeAiCallMetric column order: $1 id, $2 latency_ms, $3..$5 tokens,
  // $6 estimated_cost_usd, $7 success, $8 error_class, $9 error_message
  const finalizedErrorMessage = updateCall!.params[8] as string | null;
  assert(
    typeof finalizedErrorMessage === 'string' && !finalizedErrorMessage.includes(SK_KEY),
    'finalize UPDATE error_message does NOT contain the sk-… key',
  );
  assert(
    typeof finalizedErrorMessage === 'string' && finalizedErrorMessage.includes(REDACTED_SENTINEL),
    'finalize UPDATE error_message contains the redaction sentinel',
  );
  assert(
    typeof finalizedErrorMessage === 'string' && finalizedErrorMessage.includes('LLM call failed'),
    'finalize UPDATE error_message preserves the surrounding prose',
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run()
  .catch(err => {
    console.error('Unexpected test runner error:', err);
    process.exit(1);
  });
