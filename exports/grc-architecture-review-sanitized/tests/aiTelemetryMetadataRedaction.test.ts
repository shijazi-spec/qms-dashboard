/**
 * Tests for credential-leak protection on the `ai_call_metrics.metadata`
 * JSONB column.
 *
 * Task #475 closed the historical gap by adding the JSONB `metadata` column
 * to the daily `backfillAiCallMetricsRedaction()` sweep, but a row could
 * still land with a credential-shaped substring (sk-…, ghp_…, JWT, bcrypt
 * hash, AWS access key) under an innocuous metadata key like
 * `metadata.note` and remain in plaintext for up to ~24h until the next
 * sweep ran. Task #479 closes the WRITE path by routing every
 * caller-supplied `metadata` payload through `deepRedactSecretLikeStrings()`
 * (via `redactMetadataForStorage()`) before `JSON.stringify` at every write
 * site:
 *   • `insertAiCallMetric()`           — direct INSERT
 *   • `LLMProviderCallMetric()`             — INSERT issued by `startTelemetrySpan()`
 *
 * This test stubs `pg.Pool.prototype.query` so it captures the SQL parameters
 * that would be sent to Postgres without requiring a live DATABASE_URL,
 * mirroring the pattern in `tests/aiTelemetryErrorRedaction.test.ts`.
 *
 * Run:  npx tsx tests/aiTelemetryMetadataRedaction.test.ts
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
  redactMetadataForStorage,
  insertAiCallMetric,
  startTelemetrySpan,
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

const SK_KEY = '<REDACTED_TOKEN>';
const GH_PAT = '<REDACTED_TOKEN>';
const JWT =
  '<REDACTED_TOKEN>';
const BCRYPT_HASH = '<REDACTED_PASSWORD_HASH>';
const AWS_KEY = '<REDACTED_TOKEN>';

async function run(): Promise<void> {
  // ── 1. Pure helper: redactMetadataForStorage ───────────────────────────
  console.log('\nredactMetadataForStorage():');

  const emptyU = redactMetadataForStorage(undefined);
  assert(
    emptyU !== null && typeof emptyU === 'object' && Object.keys(emptyU).length === 0,
    'undefined input -> {}',
  );
  const emptyN = redactMetadataForStorage(null);
  assert(
    emptyN !== null && typeof emptyN === 'object' && Object.keys(emptyN).length === 0,
    'null input -> {}',
  );

  const passthrough = redactMetadataForStorage({
    prompt_version: 'v3.1.0',
    feature_flag: 'fast_path',
    nested: { count: 7, label: 'ok' },
    tags: ['a', 'b', 'c'],
  });
  assert(
    passthrough.prompt_version === 'v3.1.0' &&
      (passthrough.nested as { count: number }).count === 7 &&
      Array.isArray(passthrough.tags) &&
      (passthrough.tags as string[]).join(',') === 'a,b,c',
    'safe metadata passes through unchanged',
  );

  const skScrubbed = redactMetadataForStorage({ note: `Connection failed with key ${SK_KEY}` });
  const skJson = JSON.stringify(skScrubbed);
  assert(
    !skJson.includes(SK_KEY) && skJson.includes(REDACTED_SENTINEL),
    'sk-… credential under metadata.note is replaced with the sentinel',
  );

  const ghScrubbed = redactMetadataForStorage({
    diagnostics: { last_header: `Authorization: Bearer ${GH_PAT}` },
  });
  const ghJson = JSON.stringify(ghScrubbed);
  assert(
    !ghJson.includes(GH_PAT) && ghJson.includes(REDACTED_SENTINEL),
    'ghp_… credential nested under metadata.diagnostics.last_header is replaced',
  );

  const arrScrubbed = redactMetadataForStorage({ samples: [`token=${JWT}`, 'fine'] });
  const arrJson = JSON.stringify(arrScrubbed);
  assert(
    !arrJson.includes(JWT) && arrJson.includes(REDACTED_SENTINEL),
    'JWT inside an array element under metadata.samples is replaced',
  );

  const bcryptScrubbed = redactMetadataForStorage({ debug: { stored: BCRYPT_HASH } });
  const bcryptJson = JSON.stringify(bcryptScrubbed);
  assert(
    !bcryptJson.includes('$2b$12$') && bcryptJson.includes(REDACTED_SENTINEL),
    'bcrypt hash deep inside metadata is replaced with the sentinel',
  );

  const awsScrubbed = redactMetadataForStorage({ aws_actor: AWS_KEY });
  const awsJson = JSON.stringify(awsScrubbed);
  assert(
    !awsJson.includes(AWS_KEY) && awsJson.includes(REDACTED_SENTINEL),
    'AWS access key value under metadata.aws_actor is replaced',
  );

  // ── 2. insertAiCallMetric persists redacted metadata ───────────────────
  console.log('\ninsertAiCallMetric() scrubs row.metadata before INSERT:');

  captured.length = 0;
  await insertAiCallMetric({
    agent_name: 'test-agent',
    tool_name: 'rotate_api_key',
    model: 'tool',
    latency_ms: 42,
    success: true,
    // The metadata type only declares known scalar fields; we intentionally
    // smuggle extra unknown keys here to verify the persistence layer scrubs
    // them. Cast through `unknown` to allow the broader shape.
    metadata: {
      prompt_version: 'v1.2.3',
      note: `caller leaked credential ${SK_KEY} into metadata`,
      diag: { bearer: `Bearer ${GH_PAT}` },
      samples: [`jwt=${JWT}`, 'safe'],
    } as unknown as Parameters<typeof insertAiCallMetric>[0]['metadata'],
  });

  const insertCall = findLast(c =>
    /INSERT INTO ai_call_metrics/i.test(c.sql) && /RETURNING id/i.test(c.sql),
  );
  assert(!!insertCall, 'INSERT INTO ai_call_metrics issued by insertAiCallMetric()');
  // Column order: agent_name(1), tool_name(2), parent_call_id(3), model(4),
  //               prompt_tokens(5), completion_tokens(6), total_tokens(7),
  //               latency_ms(8), estimated_cost_usd(9), success(10),
  //               error_class(11), error_message(12), prompt_preview(13),
  //               tool_input_preview(14), tool_output_preview(15),
  //               user_hash(16), session_hash(17), metadata(18)  → params[17]
  const insertedMetadata = insertCall!.params[17] as string;
  assert(
    typeof insertedMetadata === 'string' && !insertedMetadata.includes(SK_KEY),
    'persisted metadata JSONB does NOT contain the sk-… key from metadata.note',
  );
  assert(
    typeof insertedMetadata === 'string' && !insertedMetadata.includes(GH_PAT),
    'persisted metadata JSONB does NOT contain the ghp_… token from metadata.diag.bearer',
  );
  assert(
    typeof insertedMetadata === 'string' && !insertedMetadata.includes(JWT),
    'persisted metadata JSONB does NOT contain the JWT from metadata.samples[0]',
  );
  assert(
    typeof insertedMetadata === 'string' && insertedMetadata.includes(REDACTED_SENTINEL),
    'persisted metadata JSONB contains the redaction sentinel',
  );
  // The non-secret prose / structure should survive — keys MUST NOT change,
  // and prompt_version (which is later read by the dashboard's per-version
  // aggregate) must pass through verbatim.
  const parsedMetadata = JSON.parse(insertedMetadata) as Record<string, unknown>;
  assert(
    parsedMetadata.prompt_version === 'v1.2.3',
    'prompt_version metadata key passes through unchanged (dashboard aggregate stays correct)',
  );
  assert(
    typeof parsedMetadata.note === 'string' &&
      (parsedMetadata.note as string).includes('caller leaked credential') &&
      (parsedMetadata.note as string).includes('into metadata'),
    'surrounding non-secret prose under metadata.note is preserved',
  );
  assert(
    Array.isArray(parsedMetadata.samples) &&
      (parsedMetadata.samples as unknown[]).length === 2 &&
      (parsedMetadata.samples as unknown[])[1] === 'safe',
    'array shape under metadata.samples is preserved',
  );

  // Empty / missing metadata still serialises to {} (preserves prior behaviour
  // so the JSONB column never receives NULL or invalid JSON).
  captured.length = 0;
  await insertAiCallMetric({
    agent_name: 'test-agent-2',
    model: 'gpt-4o-mini',
    latency_ms: 5,
    success: true,
  });
  const noMetaInsert = findLast(c =>
    /INSERT INTO ai_call_metrics/i.test(c.sql) && /RETURNING id/i.test(c.sql),
  );
  assert(
    !!noMetaInsert && (noMetaInsert.params[17] as string) === '{}',
    'missing metadata still serialises to {} (no NULL, no invalid JSON)',
  );

  // ── 3. LLMProviderCallMetric (via startTelemetrySpan) scrubs metadata ───────
  console.log('\nstartTelemetrySpan() / LLMProviderCallMetric() scrubs params.metadata:');

  captured.length = 0;
  // Intentionally bypass the BuiltAiCallTelemetryMetadata brand (Task #511)
  // to feed startTelemetrySpan() a hand-crafted dirty payload — that is the
  // exact pattern the brand prevents at compile time, but this test must
  // exercise the WRITE-path scrubber's defense-in-depth behaviour for the
  // `as any` bypass case. Production callers MUST go through
  // `buildAiCallTelemetryMetadata()`; this cast is the audit-trail marker
  // a code reviewer would catch if it ever appeared in non-test code.
  const dirtyMetadata = {
    prompt_version: 'v9.9.9',
    caller_note: `we accidentally serialised key ${SK_KEY} here`,
    stash: { aws: AWS_KEY, hash: BCRYPT_HASH },
  } as unknown as Parameters<typeof startTelemetrySpan>[0]['metadata'];
  const span = await startTelemetrySpan({
    agentName: 'span-agent',
    model: 'gpt-4o',
    promptText: 'hello world',
    metadata: dirtyMetadata,
  });

  const openInsert = findLast(c =>
    /INSERT INTO ai_call_metrics/i.test(c.sql) &&
    /RETURNING id/i.test(c.sql) &&
    // LLMProviderCallMetric uses the 6-column form (no tool_name, no error_*, etc.)
    /\(agent_name, model, success, prompt_preview, user_hash, session_hash, metadata\)/i.test(c.sql),
  );
  assert(!!openInsert, 'LLMProviderCallMetric INSERT was issued via startTelemetrySpan');
  // LLMProviderCallMetric param order: agent_name(1), model(2), prompt_preview(3),
  //                                user_hash(4), session_hash(5), metadata(6)
  // → params[5] is the JSON-stringified metadata.
  const openMetadata = openInsert!.params[5] as string;
  assert(
    typeof openMetadata === 'string' && !openMetadata.includes(SK_KEY),
    'LLMProviderCallMetric metadata does NOT contain the sk-… key',
  );
  assert(
    typeof openMetadata === 'string' && !openMetadata.includes(AWS_KEY),
    'LLMProviderCallMetric metadata does NOT contain the AWS access key',
  );
  assert(
    typeof openMetadata === 'string' && !openMetadata.includes('$2b$12$'),
    'LLMProviderCallMetric metadata does NOT contain the bcrypt hash prefix',
  );
  assert(
    typeof openMetadata === 'string' && openMetadata.includes(REDACTED_SENTINEL),
    'LLMProviderCallMetric metadata contains the redaction sentinel',
  );
  const parsedOpen = JSON.parse(openMetadata) as Record<string, unknown>;
  assert(
    parsedOpen.prompt_version === 'v9.9.9',
    'LLMProviderCallMetric preserves prompt_version (used by dashboard A/B aggregate)',
  );

  // Finalise the span to keep the state machine clean for subsequent tests
  // — the UPDATE doesn't touch metadata so it's not under test here.
  await span.finalize({ success: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run()
  .catch(err => {
    console.error('Unexpected test runner error:', err);
    process.exit(1);
  });
