/**
 * Regression coverage for `redactPgParam()` (`src/utils/redactedPool.ts`)
 * after Task #764 simplified the wrapper.
 *
 * Before the simplification, `redactPgParam` had its own hand-rolled
 * `JSON.parse` / re-walk / `JSON.stringify` branch that ran *only* against
 * top-level string params whose first non-space char was `{` or `[`. After
 * Task #741 moved that exact JSON-of-JSON detection into
 * `redactSensitiveDeep` itself, the wrapper now delegates straight through.
 *
 * This test pins the externally-observable behaviour so a future regression
 * in either layer can't silently drop the JSON-string handling that
 * production writers (changeHistory, eventLogs, ai_approvals, …) rely on.
 *
 * Run:  npx tsx tests/redactPgParamTopLevelJson.test.ts
 */

import {
  redactPgParam,
} from '../src/utils/redactedPool';
import { REDACTED_SENTINEL } from '../src/utils/sensitiveRedaction';

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

console.log('redactPgParam — top-level JSON-string param handling (Task #764)');

// ---------------------------------------------------------------------------
// (a) Top-level JSON-OBJECT string: the deny-list key inside is sentinel'd
//     and the value comes back out as a still-parseable JSON string so the
//     downstream JSONB column accepts it.
// ---------------------------------------------------------------------------
{
  const mfaSecret = '<REDACTED_PHONE>-4000-8000-<REDACTED_PHONE>';
  const param = JSON.stringify({ mfa_secret: mfaSecret, ok: true });

  const out = redactPgParam(param);

  assert(typeof out === 'string', 'JSON-object string param stays a string');
  assert(
    typeof out === 'string' && !out.includes(mfaSecret),
    'raw mfa_secret UUID is removed from the param',
  );
  assert(
    typeof out === 'string' && out.includes(REDACTED_SENTINEL),
    'redacted sentinel is present in the returned param',
  );

  const reparsed = JSON.parse(out as string) as Record<string, unknown>;
  assert(reparsed.ok === true, 'non-sensitive sibling survives the round trip');
  assert(
    reparsed.mfa_secret === REDACTED_SENTINEL,
    'mfa_secret is replaced by the sentinel inside the parsed result',
  );
}

// ---------------------------------------------------------------------------
// (b) Top-level JSON-ARRAY string is also walked, not treated as opaque.
// ---------------------------------------------------------------------------
{
  const token = '<REDACTED_SECRET>';
  const param = JSON.stringify([{ access_token: token }, { harmless: 1 }]);

  const out = redactPgParam(param);

  assert(typeof out === 'string', 'JSON-array string param stays a string');
  assert(
    typeof out === 'string' && !out.includes(token),
    'access_token value is scrubbed from the array',
  );

  const reparsed = JSON.parse(out as string) as Array<Record<string, unknown>>;
  assert(
    reparsed[0].access_token === REDACTED_SENTINEL,
    'access_token at index 0 is sentinel',
  );
  assert(reparsed[1].harmless === 1, 'unrelated sibling at index 1 survives');
}

// ---------------------------------------------------------------------------
// (c) Plain (non-JSON) string still gets the regex/heuristic scrub.
// ---------------------------------------------------------------------------
{
  const out = redactPgParam('error: token <REDACTED_TOKEN> leaked');
  assert(typeof out === 'string', 'plain string param stays a string');
  assert(
    typeof out === 'string' && !out.includes('<REDACTED_TOKEN>'),
    'vendor-prefixed token is scrubbed inside a plain string param',
  );
}

// ---------------------------------------------------------------------------
// (d) Malformed `{`-prefixed string is returned unchanged (no throw, no
//     stray sentinel).
// ---------------------------------------------------------------------------
{
  const malformed = '{this is not, in fact, JSON: missing quotes everywhere}';
  const out = redactPgParam(malformed);
  assert(out === malformed, 'malformed JSON-looking string passes through unchanged');
}

// ---------------------------------------------------------------------------
// (e) Non-string primitives and special object types pass through untouched
//     so pg's native serializer keeps working (Date / Buffer / typed array).
// ---------------------------------------------------------------------------
{
  const d = new Date('2026-05-02T00:00:00Z');
  assert(redactPgParam(d) === d, 'Date instance passes through by reference');

  const b = Buffer.from([1, 2, 3]);
  assert(redactPgParam(b) === b, 'Buffer passes through by reference');

  const u = new Uint8Array([4, 5, 6]);
  assert(redactPgParam(u) === u, 'typed array passes through by reference');

  assert(redactPgParam(null) === null, 'null passes through');
  assert(redactPgParam(undefined) === undefined, 'undefined passes through');
  assert(redactPgParam(42) === 42, 'number passes through');
  assert(redactPgParam(true) === true, 'boolean passes through');
}

// ---------------------------------------------------------------------------
// (f) Object param with a nested deny-listed key is walked.
// ---------------------------------------------------------------------------
{
  const out = redactPgParam({
    user_id: 7,
    password_hash: '$2b$10$abcdefghijabcdefghijabcdefghijabcdefghijabcdefghijab',
  }) as Record<string, unknown>;
  assert(out.user_id === 7, 'unrelated field preserved on object param');
  assert(out.password_hash === REDACTED_SENTINEL, 'password_hash sentinel on object param');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
