/**
 * Fast unit coverage for every richer credential shape that the
 * SECRET_LIKE_PATTERNS deny-list inside `src/utils/eventLogsDatabase.ts`
 * is supposed to scrub before a tool's input/output payload is persisted
 * to `ai_call_metrics.tool_input_preview` / `tool_output_preview`
 * (Task #600 — gap left by `aiToolPreviewRoundTrip.test.ts`, which only
 * exercises two of the eleven shapes end-to-end).
 *
 * Each fixture embeds a representative sample value under an
 * INNOCUOUSLY-NAMED field (e.g. `note`, `commitMessage`, `description`)
 * so the key-based deny-list (`isSensitiveField`) cannot match — the
 * only thing that can save us is the regex deny-list inside
 * `redactSecretLikeStrings()` / `redactSensitiveDeep()` that
 * `redactToolPayloadPreview()` runs first.
 *
 * No DB, no network: this calls `redactToolPayloadPreview()` directly
 * so it runs in milliseconds in every environment, including ones
 * without `DATABASE_URL`.
 *
 * Run:  npx tsx tests/redactToolPayloadPreview.test.ts
 */

import { redactToolPayloadPreview } from '../src/utils/aiTelemetry';

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

/**
 * One fixture per `SECRET_LIKE_PATTERNS` entry in
 * `src/utils/eventLogsDatabase.ts` (kept in the same order for easy
 * cross-referencing). The `marker` is a stable substring of the secret
 * we use for the negative-presence assertion: it must be long enough
 * that an accidental partial match in the redacted output would still
 * indicate a leak (i.e. >= 12 chars and unique to the secret).
 *
 * `field` is the innocuously-named key the secret lives under so that
 * key-based redaction cannot fire — only the regex deny-list can.
 */
interface SecretFixture {
  patternName: string;
  description: string;
  secret: string;
  marker: string;
  field: string;
}

const FIXTURES: SecretFixture[] = [
  {
    patternName: 'bcrypt',
    description: 'bcrypt $2b$ hash embedded in a free-form note',
    secret: '<REDACTED_SECRET>',
    marker: 'abcdefghijklmnopqrstuv',
    field: 'note',
  },
  {
    patternName: 'jwt',
    description: 'JWT (eyJ…) embedded in a free-form note',
    secret:
      '<REDACTED_SECRET>',
    marker: 'eyJhbGciOiJIUzI1NiJ9',
    field: 'note',
  },
  {
    patternName: 'sk-key',
    description: 'OpenAI sk-… key embedded in a commit message',
    secret: '<REDACTED_SECRET>',
    marker: 'NEVER_PERSIST_ME_1234567890',
    field: 'commitMessage',
  },
  {
    patternName: 'stripe-pk',
    description: 'Stripe pk_live_… publishable key embedded in a description',
    secret: '<REDACTED_SECRET>',
    marker: '<REDACTED_TOKEN>',
    field: 'description',
  },
  {
    patternName: 'github',
    description: 'GitHub ghp_… personal access token embedded in a note',
    secret: '<REDACTED_SECRET>',
    marker: '<REDACTED_TOKEN>',
    field: 'note',
  },
  {
    patternName: 'gitlab',
    description: 'GitLab glpat-… token embedded in a note',
    secret: '<REDACTED_SECRET>',
    marker: 'glpat-abcdefghijklmno',
    field: 'note',
  },
  {
    patternName: 'slack',
    description: 'Slack xoxb-… bot token embedded in a description',
    secret: '<REDACTED_SECRET>',
    marker: '<REDACTED_TOKEN>',
    field: 'description',
  },
  {
    patternName: 'google-api',
    description: 'Google API key (AIza…) embedded in a commit message',
    secret: '<REDACTED_SECRET>',
    marker: 'AIzaSyA1234567890abc',
    field: 'commitMessage',
  },
  {
    patternName: 'google-oauth',
    description: 'Google OAuth token (ya29.…) embedded in a note',
    secret: '<REDACTED_SECRET>',
    marker: 'ya29.A0AfH6SMBabcde',
    field: 'note',
  },
  {
    patternName: 'aws-akid',
    description: 'AWS Access Key ID (AKIA…) embedded in a description',
    secret: '<REDACTED_SECRET>',
    marker: '<REDACTED_TOKEN>',
    field: 'description',
  },
  {
    patternName: 'bearer',
    description: 'HTTP "Authorization: Bearer …" header value in a note',
    secret: '<REDACTED_SECRET>',
    marker: 'abcdefghij1234567890ABCDEFGHIJ',
    field: 'note',
  },
];

async function main(): Promise<void> {
  console.log('\nredactToolPayloadPreview() — every SECRET_LIKE_PATTERNS shape:');

  for (const fx of FIXTURES) {
    // The secret lives inside a free-form sentence so that the regex
    // deny-list — not the key-name deny-list and not the heuristic
    // password / entropy scanner alone — is the layer being exercised.
    // We embed the value rather than passing it as a bare string so we
    // also prove the regex survives the JSON.stringify() pass that
    // `redactToolPayloadPreview` runs for non-string payloads.
    const payload: Record<string, unknown> = {};
    payload[fx.field] = `Operator pasted credential into chat: ${fx.secret} — please rotate.`;

    const out = redactToolPayloadPreview(payload);

    assert(typeof out === 'string', `[${fx.patternName}] returns a string preview`);
    if (typeof out !== 'string') continue;

    assert(
      !out.includes(fx.secret),
      `[${fx.patternName}] full secret string is absent from preview (${fx.description})`,
    );
    assert(
      !out.includes(fx.marker),
      `[${fx.patternName}] distinctive secret marker "${fx.marker}" is absent from preview`,
    );
    // The marker assertion alone is necessary but not sufficient: we
    // also want to see a redaction sentinel so a future regression that
    // simply truncated the preview (instead of redacting it) would not
    // pass quietly. Either marker is acceptable evidence:
    //   • `***REDACTED***` — emitted by `redactSecretLikeStrings()` /
    //     `redactSensitiveDeep()` (the regex / key-based pass).
    //   • `[REDACTED]`     — emitted by `redactPromptPreview()`'s
    //     PII_PATTERNS pass for generic `token=…` style hits.
    assert(
      out.includes('***REDACTED***') || out.includes('[REDACTED]'),
      `[${fx.patternName}] preview contains a redaction sentinel`,
    );
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
