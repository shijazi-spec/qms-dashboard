/**
 * Coverage for the JSON-of-JSON branch added to `redactSensitiveDeep()` in
 * `src/utils/sensitiveRedaction.ts` (Task #741).
 *
 * The redacted-pool wrapper (`src/utils/redactedPool.ts`) already attempts a
 * top-level `JSON.parse` on `{`/`[`-prefixed string params before walking
 * them. The gap this test guards against is the *inner* case:
 *
 *   { description: '{"mfa_secret":"<REDACTED_SECRET>"}' }
 *
 * The outer object is walked, but the `description` value used to be treated
 * as an opaque string leaf — only the regex/heuristic pass ran on it, which
 * is blind to a regex-undetectable secret like a raw `mfa_secret` UUID.
 *
 * After the fix, `redactSensitiveDeep()` itself detects when a string value
 * is valid JSON whose root is an object/array, recursively walks it, and
 * re-stringifies the result — so the deny-listed key inside the inner JSON
 * is sentinel'd just like a "real" nested object would be.
 *
 * Run:  npx tsx tests/redactSensitiveDeepNestedJson.test.ts
 */

import {
  REDACTED_SENTINEL,
  redactSensitiveDeep,
} from '../src/utils/sensitiveRedaction';

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

console.log(
  'redactSensitiveDeep — recursively walks JSON-string values (Task #741)',
);

// ---------------------------------------------------------------------------
// (a) Plain object with a single nested JSON-string value containing a secret
// ---------------------------------------------------------------------------
{
  const mfaSecret = '<REDACTED_SECRET>';
  const input = {
    description: JSON.stringify({ mfa_secret: mfaSecret, ok: true }),
    label: 'change-history-row-42',
  };

  const out = redactSensitiveDeep(input) as {
    description: string;
    label: string;
  };

  // The outer object survives; the description is still a string (so writers
  // that persist it into a TEXT column don't suddenly receive an object).
  assert(typeof out.description === 'string', 'description remains a string');
  assert(out.label === 'change-history-row-42', 'sibling label is untouched');

  // The nested mfa_secret has been sentinel'd by the key-name deny-list...
  assert(
    !out.description.includes(mfaSecret),
    'raw mfa_secret UUID is gone from the re-stringified description',
  );
  assert(
    out.description.includes(REDACTED_SENTINEL),
    'redacted sentinel is present in the re-stringified description',
  );

  // ...but the harmless sibling key inside the same nested JSON survives.
  const reparsed = JSON.parse(out.description) as Record<string, unknown>;
  assert(reparsed.ok === true, 'non-sensitive sibling inside nested JSON survives');
  assert(
    reparsed.mfa_secret === REDACTED_SENTINEL,
    'mfa_secret value is replaced by the sentinel inside parsed nested JSON',
  );
}

// ---------------------------------------------------------------------------
// (b) Triple-nested JSON-in-JSON-in-JSON (the recursive case)
// ---------------------------------------------------------------------------
{
  const innerSecret = '<REDACTED_SECRET>';
  // Three layers of escaping — each layer's value is itself a JSON-encoded
  // string of the next layer down. This is the shape we'd see if a tool
  // logged a tool-call payload that itself contained a logged tool-call
  // payload, etc.
  const layer3 = JSON.stringify({ access_token: innerSecret, depth: 3 });
  const layer2 = JSON.stringify({ inner: layer3, depth: 2 });
  const layer1 = JSON.stringify({ inner: layer2, depth: 1 });

  const input = { payload: layer1 };

  const out = redactSensitiveDeep(input) as { payload: string };

  assert(
    !out.payload.includes(innerSecret),
    'triple-nested access_token UUID is removed from the outer string',
  );

  // Walk back down through the layers and confirm structure is preserved
  // and the secret is sentinel'd at the deepest layer.
  const parsed1 = JSON.parse(out.payload) as { inner: string; depth: number };
  assert(parsed1.depth === 1, 'layer-1 depth marker preserved');
  const parsed2 = JSON.parse(parsed1.inner) as { inner: string; depth: number };
  assert(parsed2.depth === 2, 'layer-2 depth marker preserved');
  const parsed3 = JSON.parse(parsed2.inner) as Record<string, unknown>;
  assert(parsed3.depth === 3, 'layer-3 depth marker preserved');
  assert(
    parsed3.access_token === REDACTED_SENTINEL,
    'access_token at layer 3 is replaced with the sentinel',
  );
}

// ---------------------------------------------------------------------------
// (c) Malformed JSON-looking string passes through unchanged
// ---------------------------------------------------------------------------
{
  // Starts with `{` but is not valid JSON. Must not throw, must not mangle
  // the original string, and must NOT introduce the sentinel (there is no
  // secret-shaped substring inside).
  const malformed = '{this is not, in fact, JSON: missing quotes everywhere}';
  const out = redactSensitiveDeep({ note: malformed }) as { note: string };
  assert(out.note === malformed, 'malformed `{`-prefixed string is unchanged');
  assert(
    !out.note.includes(REDACTED_SENTINEL),
    'malformed string did not get a stray sentinel inserted',
  );

  // Same for a `[`-prefixed malformed string.
  const malformedArr = '[unterminated, , ,';
  const out2 = redactSensitiveDeep({ note: malformedArr }) as { note: string };
  assert(out2.note === malformedArr, 'malformed `[`-prefixed string is unchanged');

  // And a JSON literal whose root is a primitive (number / string / null) —
  // we don't recurse into these because there is no key/value graph to walk;
  // they go through the regex pass like any other string. The important
  // assertion is that the value is still returned (no throw) and not mangled.
  const primitiveJson = '"just a quoted string"';
  const out3 = redactSensitiveDeep({ note: primitiveJson }) as { note: string };
  assert(
    typeof out3.note === 'string' && out3.note.length > 0,
    'JSON primitive at root falls through without crashing',
  );
}

// ---------------------------------------------------------------------------
// Bonus: empty object / array JSON-strings round-trip safely
// ---------------------------------------------------------------------------
{
  const out = redactSensitiveDeep({ a: '{}', b: '[]' }) as { a: string; b: string };
  assert(out.a === '{}', 'empty-object JSON string round-trips');
  assert(out.b === '[]', 'empty-array JSON string round-trips');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
