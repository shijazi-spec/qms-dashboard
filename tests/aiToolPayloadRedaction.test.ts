/**
 * Tests for the sanitized tool input/output preview pipeline:
 *   • redactToolPayloadPreview() applies the same PII rules as
 *     redactPromptPreview() (emails, phones, cards, secrets) and caps
 *     output at 300 chars.
 *   • wrapToolWithTelemetry() preserves the original tool's behavior
 *     (return value on success, rethrow on failure) while still
 *     producing a wrapped clone (does not mutate the original).
 *
 * The redaction tests are the security-critical assertion — they prove
 * that the new tool_input_preview / tool_output_preview columns will
 * never receive raw secrets / PII.
 *
 * Run:  npx tsx tests/aiToolPayloadRedaction.test.ts
 */

import {
  redactToolPayloadPreview,
  wrapToolWithTelemetry,
} from '../src/utils/aiTelemetry';

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

async function main(): Promise<void> {
  console.log('\nredactToolPayloadPreview():');

  assert(
    redactToolPayloadPreview(undefined) === undefined,
    'undefined input -> undefined',
  );
  assert(
    redactToolPayloadPreview(null) === undefined,
    'null input -> undefined',
  );

  const emailRedacted = redactToolPayloadPreview({ to: 'alice@example.com' });
  assert(
    !!emailRedacted && emailRedacted.includes('[EMAIL]') && !emailRedacted.includes('alice@example.com'),
    'email is replaced with [EMAIL] sentinel',
  );

  const cardRedacted = redactToolPayloadPreview({ card: '4111 1111 1111 1111' });
  assert(
    !!cardRedacted && cardRedacted.includes('[CARD]'),
    'credit-card-shaped value is replaced with [CARD]',
  );

  const phoneRedacted = redactToolPayloadPreview('Call me at +1 555 123 4567');
  assert(
    !!phoneRedacted && phoneRedacted.includes('[PHONE]'),
    'phone number is replaced with [PHONE]',
  );

  const secretRedacted = redactToolPayloadPreview({ note: 'token=sk_live_abcdef123456' });
  assert(
    !!secretRedacted && secretRedacted.includes('[REDACTED]') && !secretRedacted.includes('sk_live_abcdef123456'),
    'token=... value is replaced with [REDACTED]',
  );

  const longInput = 'A'.repeat(1000);
  const truncated = redactToolPayloadPreview(longInput);
  assert(
    !!truncated && truncated.length === 300,
    'output is capped at 300 chars (default maxLen)',
  );

  const stringInput = redactToolPayloadPreview('plain text');
  assert(
    stringInput === 'plain text',
    'plain string passes through (no JSON quoting) when there is nothing to redact',
  );

  const customCap = redactToolPayloadPreview('A'.repeat(500), 50);
  assert(
    !!customCap && customCap.length === 50,
    'custom maxLen is honored',
  );

  // ─── Richer secret fixtures — same set used by aiApprovalRedaction.test.ts ──
  // These cover credential patterns that the basic PII_PATTERNS regex pass
  // does not catch on its own. They are caught by the redactSensitiveDeep /
  // redactSecretLikeStrings layer added to redactToolPayloadPreview().
  console.log('\nredactToolPayloadPreview() — richer secret fixtures:');

  const OPENAI_KEY = 'sk-live-NEVER_PERSIST_ME_1234567890abcdefghijklmnop';
  const GH_PAT = 'ghp_topsecretrefreshtokenabcdefghijklmnoXYZ';
  const BCRYPT_HASH = '$2b$12$abcdefghijklmnopqrstuv1234567890ABCDEFGHIJKLMNOPQRSTU';
  const JWT =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

  // OpenAI key as a plain string
  const openAiStr = redactToolPayloadPreview(OPENAI_KEY);
  assert(
    !!openAiStr && !openAiStr.includes(OPENAI_KEY),
    'OpenAI sk-… key in plain string is redacted',
  );

  // GitHub PAT as a plain string
  const ghPatStr = redactToolPayloadPreview(GH_PAT);
  assert(
    !!ghPatStr && !ghPatStr.includes(GH_PAT),
    'GitHub ghp_… PAT in plain string is redacted',
  );

  // bcrypt hash as a plain string
  const bcryptStr = redactToolPayloadPreview(BCRYPT_HASH);
  assert(
    !!bcryptStr && !bcryptStr.includes('$2b$12$'),
    'bcrypt hash in plain string is redacted',
  );

  // JWT as a plain string
  const jwtStr = redactToolPayloadPreview(JWT);
  assert(
    !!jwtStr && !jwtStr.includes('eyJhbGciOiJIUzI1NiJ9'),
    'JWT in plain string is redacted',
  );

  // AWS Access Key ID as a plain string
  const awsStr = redactToolPayloadPreview(AWS_KEY);
  assert(
    !!awsStr && !awsStr.includes(AWS_KEY),
    'AWS AKIA… access key in plain string is redacted',
  );

  // OpenAI key nested inside an object under a key-name-neutral field
  const nestedOpenAi = redactToolPayloadPreview({
    config: { api_key: OPENAI_KEY, region: 'us-east-1' },
  });
  assert(
    !!nestedOpenAi && !nestedOpenAi.includes(OPENAI_KEY),
    'OpenAI sk-… key nested under api_key object field is redacted',
  );

  // GitHub PAT nested inside Authorization header value
  const nestedBearer = redactToolPayloadPreview({
    headers: { Authorization: `Bearer ${GH_PAT}`, 'Content-Type': 'application/json' },
  });
  assert(
    !!nestedBearer && !nestedBearer.includes(GH_PAT),
    'GitHub ghp_… PAT nested under Authorization header field is redacted',
  );

  // bcrypt hash inside a nested field called password_hash
  const nestedBcrypt = redactToolPayloadPreview({
    user: { email: 'alice@example.com', password_hash: BCRYPT_HASH },
  });
  assert(
    !!nestedBcrypt && !nestedBcrypt.includes('$2b$12$'),
    'bcrypt hash nested under password_hash field is redacted',
  );

  // JWT inside a free-form string payload (error message style)
  const jwtInMsg = redactToolPayloadPreview(
    `Authentication failed — received token ${JWT} which is now expired`,
  );
  assert(
    !!jwtInMsg && !jwtInMsg.includes('eyJhbGciOiJIUzI1NiJ9'),
    'JWT embedded in free-form error string is redacted',
  );

  // AWS key in a value under an innocuous key name ("id")
  const awsInObject = redactToolPayloadPreview({ result: { id: AWS_KEY, region: 'us-east-1' } });
  assert(
    !!awsInObject && !awsInObject.includes(AWS_KEY),
    'AWS AKIA… key embedded in object value is redacted',
  );

  // Safe non-secret fields must survive
  const safeSurvives = redactToolPayloadPreview({
    action: 'rotate_key',
    target: 'zoho_books',
    reason: 'Scheduled quarterly rotation',
  });
  assert(
    !!safeSurvives &&
      safeSurvives.includes('zoho_books') &&
      safeSurvives.includes('Scheduled quarterly rotation'),
    'non-sensitive fields are preserved through deep redaction',
  );

  // ─── Structural sanity check on wrapToolWithTelemetry ─────────────────
  // We can't easily intercept the fire-and-forget insertAiCallMetric in
  // ESM, but we can verify the wrapper preserves the contract: returns
  // the clone-with-wrapped-execute, calls through on success, rethrows
  // on hard failure, and does NOT mutate the original tool's execute.
  console.log('\nwrapToolWithTelemetry() preserves tool contract:');

  const happyOriginalExecute = async (args: unknown) => ({ success: true, echo: args });
  const happyTool = { id: 'happyTool', execute: happyOriginalExecute };
  const wrappedHappy = wrapToolWithTelemetry(happyTool, 'TestAgent');

  assert(wrappedHappy !== happyTool, 'returns a new wrapped tool, not the original');
  assert(happyTool.execute === happyOriginalExecute, 'original tool.execute is not mutated');
  assert(wrappedHappy.execute !== happyOriginalExecute, 'wrapped tool.execute is replaced');
  assert(wrappedHappy.id === 'happyTool', 'wrapped tool keeps its id');

  const happyResult = await wrappedHappy.execute!({ user: 'bob' }) as { success: boolean; echo: { user: string } };
  assert(happyResult.success === true, 'wrapped success-path returns underlying result');
  assert(happyResult.echo.user === 'bob', 'wrapped success-path passes args through');

  const sadTool = {
    id: 'sadTool',
    execute: async () => { throw new Error('boom'); },
  };
  const wrappedSad = wrapToolWithTelemetry(sadTool, 'TestAgent');
  let threw = false;
  try {
    await wrappedSad.execute!({});
  } catch (err) {
    threw = err instanceof Error && err.message === 'boom';
  }
  assert(threw, 'wrapped failure-path rethrows the original error');

  // No-op when tool has no execute or no id
  const noExec = { id: 'x' } as { id: string; execute?: () => Promise<unknown> };
  assert(wrapToolWithTelemetry(noExec, 'A') === noExec, 'tool without execute is returned unchanged');

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
