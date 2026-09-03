/**
 * CI gate: prevents console.log / console.error regressions and verifies that
 * the logger wrapper redacts sensitive fields before forwarding to pino.
 *
 * Run:    npx tsx tests/safeLoggerRedaction.test.ts
 * Wired:  scripts/post-merge.sh
 *
 * Section 1 — _sanitiseForTest unit tests
 *   Verifies Layer 1 (redactSensitiveDeep): key-based + string-pattern
 *   redaction applied to every object payload before it reaches pino.
 *
 * Section 2 — _mergePayloadsForTest unit tests
 *   Verifies that multiple payload objects are merged and fully redacted.
 *
 * Section 3 — _scrubMessageForTest unit tests
 *   Verifies Layer 2: credential-shaped substrings interpolated directly into
 *   the log message string are caught by the regex scrubber even when there is
 *   no surrounding object key to inspect.
 *
 * Section 4 — grep-based console.* guardrail self-test
 *   Verifies that scripts/check-console-logs.sh catches a raw console.log in
 *   one of the migrated modules (simulated with a temp file) and passes when
 *   the module is clean.
 */

import { execSync } from 'child_process';

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

function assertDeepEqual<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(
      `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`,
    );
    failed++;
  }
}

const { _sanitiseForTest, _mergePayloadsForTest, _scrubMessageForTest } = await import('../src/utils/logger');
const { REDACTED_SENTINEL } = await import('../src/utils/eventLogsDatabase');

// ---------------------------------------------------------------------------
// Section 1 — _sanitiseForTest (Layer 1: redactSensitiveDeep on payloads)
// ---------------------------------------------------------------------------

console.log('\n=== _sanitiseForTest — Layer 1: key-based + regex payload redaction ===\n');

assert(_sanitiseForTest(null) === null, 'null passes through unchanged');
assert(_sanitiseForTest(undefined) === undefined, 'undefined passes through unchanged');
assert(_sanitiseForTest(42) === 42, 'number passes through unchanged');
assert(_sanitiseForTest('hello') === 'hello', 'plain string passes through unchanged');
assert(_sanitiseForTest(true) === true, 'boolean passes through unchanged');

{
  const result = _sanitiseForTest({ username: 'alice', email: '<REDACTED_EMAIL>' }) as any;
  assert(result.username === 'alice', 'non-sensitive key preserved by sanitise');
  assert(result.email === '<REDACTED_EMAIL>', 'email preserved by sanitise');
}

{
  const result = _sanitiseForTest({ username: 'bob', password_hash: '$2b$12$secret', api_key: '<REDACTED_SECRET>' }) as any;
  assert(result.password_hash === REDACTED_SENTINEL, 'password_hash redacted by key-based rule');
  assert(result.api_key === REDACTED_SENTINEL, 'api_key redacted by key-based rule');
  assert(result.username === 'bob', 'username preserved alongside redacted fields');
}

{
  const result = _sanitiseForTest({
    provider: 'CRMProvider',
    access_token: '<REDACTED_SECRET>',
    refresh_token: '<REDACTED_SECRET>',
    client_secret: '<REDACTED_SECRET>',
    account_id: 'acct-public-123',
  }) as any;
  assert(result.access_token === REDACTED_SENTINEL, 'access_token redacted');
  assert(result.refresh_token === REDACTED_SENTINEL, 'refresh_token redacted');
  assert(result.client_secret === REDACTED_SENTINEL, 'client_secret redacted');
  assert(result.account_id === 'acct-public-123', 'account_id preserved (non-sensitive)');
}

{
  const result = _sanitiseForTest({
    user: { email: '<REDACTED_EMAIL>', password_hash: '$2b$12$hash', mfa_secret: 'TOTP_SECRET' },
    meta: { module: 'auth' },
  }) as any;
  assert(result.user.password_hash === REDACTED_SENTINEL, 'nested password_hash redacted');
  assert(result.user.mfa_secret === REDACTED_SENTINEL, 'nested mfa_secret redacted');
  assert(result.user.email === '<REDACTED_EMAIL>', 'nested email preserved');
  assert(result.meta.module === 'auth', 'nested meta preserved');
}

// redactSensitiveDeep also scrubs credential-shaped substrings from string
// values even when the key is innocuous (e.g. `note`, `summary`, `errorText`).
{
  const sk = '<REDACTED_TOKEN>';
  const result = _sanitiseForTest({
    note: `previous key was ${sk}`,
    account_id: 'acct-public-123',
  }) as any;
  assert(
    !result.note.includes(sk),
    'sk_live_ credential inside non-sensitive string field is regex-scrubbed',
  );
  assert(
    result.note.includes(REDACTED_SENTINEL),
    'REDACTED sentinel present in scrubbed string field',
  );
  assert(result.account_id === 'acct-public-123', 'non-secret field preserved alongside scrubbed note');
}

{
  const jwt =
    '<REDACTED_TOKEN>';
  const result = _sanitiseForTest({
    errorText: `CRMProvider response: Bearer ${jwt}`,
    httpStatus: 401,
  }) as any;
  assert(
    !result.errorText.includes(jwt),
    'JWT (eyJ…) inside errorText field is regex-scrubbed by redactSensitiveDeep',
  );
  assert(result.httpStatus === 401, 'httpStatus number preserved');
}

{
  const err = new Error('connection failed');
  const result = _sanitiseForTest(err) as any;
  assert(result.message === 'connection failed', 'Error.message preserved in sanitised output');
  assert(result.name === 'Error', 'Error.name preserved');
}

// ---------------------------------------------------------------------------
// Section 2 — _mergePayloadsForTest
// ---------------------------------------------------------------------------

console.log('\n=== _mergePayloadsForTest — multi-payload merge and redaction ===\n');

{
  const result = _mergePayloadsForTest([
    { userId: 7, status: 'active' },
    { role: 'admin' },
  ]);
  assert(result.userId === 7, 'first object field present after merge');
  assert(result.role === 'admin', 'second object field present after merge');
  assert(result.status === 'active', 'first object non-secret field preserved');
}

{
  const result = _mergePayloadsForTest([
    { userId: 10, access_token: '<REDACTED_SECRET>' },
    { provider: 'IdentityProvider' },
  ]);
  assert(result.access_token === REDACTED_SENTINEL, 'access_token redacted in merged payload');
  assert(result.userId === 10, 'userId preserved in merged payload');
  assert(result.provider === 'IdentityProvider', 'provider preserved from second object');
}

{
  const result = _mergePayloadsForTest([
    { config: { api_key: '<REDACTED_SECRET>', timeout: 5000 } },
  ]);
  assert((result.config as any).api_key === REDACTED_SENTINEL, 'nested api_key redacted in merged payload');
  assert((result.config as any).timeout === 5000, 'nested non-secret preserved in merged payload');
}

{
  const sk = '<REDACTED_TOKEN>';
  const result = _mergePayloadsForTest([
    { summary: `rotated key was ${sk}`, provider: 'PaymentProvider' },
  ]);
  assert(
    !(result.summary as string).includes(sk),
    'sk_live_ inside non-sensitive field scrubbed by regex layer in merged payload',
  );
  assert(result.provider === 'PaymentProvider', 'provider preserved in merged payload');
}

// Primitive args (non-object) are attached to `extra` so they are not lost.
{
  const result = _mergePayloadsForTest([{ userId: 5 }, 'some-string' as any, 42 as any]);
  assert(result.userId === 5, 'object field preserved when mixed with primitive args');
  assert(Array.isArray(result.extra), 'primitive args collected in extra array');
}

// ---------------------------------------------------------------------------
// Section 3 — _scrubMessageForTest (Layer 2: regex scrub on message strings)
// ---------------------------------------------------------------------------

console.log('\n=== _scrubMessageForTest — Layer 2: regex redaction on message strings ===\n');

assert(
  _scrubMessageForTest('User profile updated') === 'User profile updated',
  'ordinary prose message is unchanged',
);

{
  const sk = '<REDACTED_TOKEN>';
  const msg = `Token refresh failed: response=${sk}`;
  const out = _scrubMessageForTest(msg);
  assert(!out.includes(sk), 'sk_live_ key interpolated into message string is scrubbed');
  assert(out.includes(REDACTED_SENTINEL), 'REDACTED sentinel present in scrubbed message');
  assert(out.includes('Token refresh failed:'), 'surrounding prose preserved in scrubbed message');
}

{
  const ghp = '<REDACTED_TOKEN>';
  const msg = `SourceControlProvider PAT leaked: ${ghp}`;
  const out = _scrubMessageForTest(msg);
  assert(!out.includes(ghp), 'ghp_ token interpolated into message string is scrubbed');
  assert(out.includes(REDACTED_SENTINEL), 'REDACTED sentinel present in message with ghp_ token');
}

{
  const jwt =
    '<REDACTED_TOKEN>';
  const msg = `Bearer token issued: ${jwt}`;
  const out = _scrubMessageForTest(msg);
  assert(!out.includes(jwt), 'JWT (eyJ…) interpolated into message string is scrubbed');
  assert(out.includes(REDACTED_SENTINEL), 'REDACTED sentinel present in message with JWT');
}

{
  const bcrypt = '$2b$12$abcdefghijABCDEFGHIJ12./uVwXyZaBcDeFgHiJkLmNoPqRsTuVwXy';
  const msg = `Bcrypt hash logged: ${bcrypt}`;
  const out = _scrubMessageForTest(msg);
  assert(!out.includes(bcrypt), 'bcrypt hash interpolated into message string is scrubbed');
  assert(out.includes(REDACTED_SENTINEL), 'REDACTED sentinel present in message with bcrypt hash');
}

// ---------------------------------------------------------------------------
// Section 4 — check-console-logs.sh self-test
// ---------------------------------------------------------------------------

console.log('\n=== check-console-logs.sh self-test ===\n');

function runCheckScript(extraArgs = ''): { exitCode: number; output: string } {
  try {
    const output = execSync(`bash scripts/check-console-logs.sh ${extraArgs} 2>&1`, {
      encoding: 'utf8',
    });
    return { exitCode: 0, output };
  } catch (err: any) {
    return { exitCode: err.status ?? 1, output: err.stdout ?? '' };
  }
}

{
  const { exitCode, output } = runCheckScript();
  assert(exitCode === 0, 'check-console-logs.sh exits 0 when all migrated modules are clean');
  assert(output.includes('✓'), 'check-console-logs.sh prints at least one pass mark');
}

{
  const GUARDED = 'src/utils/aiApprovalDatabase.ts';
  const originalContent = (await import('fs')).readFileSync(GUARDED, 'utf8');
  const injected = originalContent + "\n// TEST-ONLY: console.log('secret leak test');\n";
  (await import('fs')).writeFileSync(GUARDED, injected, 'utf8');

  let regression: ReturnType<typeof runCheckScript>;
  try {
    regression = runCheckScript();
  } finally {
    (await import('fs')).writeFileSync(GUARDED, originalContent, 'utf8');
  }

  assert(
    regression.exitCode !== 0,
    'check-console-logs.sh exits non-zero when migrated module has console.log',
  );
  assert(
    regression.output.includes('aiApprovalDatabase.ts'),
    'check-console-logs.sh names the offending migrated file in its output',
  );
}

{
  const tmpFile = 'src/utils/_test_new_module_console_leak.ts';
  (await import('fs')).writeFileSync(
    tmpFile,
    "export function doSomething() { console.log('leaking secret'); }\n",
    'utf8',
  );

  let regression: ReturnType<typeof runCheckScript>;
  try {
    regression = runCheckScript();
  } finally {
    (await import('fs')).unlinkSync(tmpFile);
  }

  assert(
    regression.exitCode !== 0,
    'check-console-logs.sh exits non-zero for new file with console.log outside allow-list',
  );
  assert(
    regression.output.includes('_test_new_module_console_leak.ts'),
    'check-console-logs.sh names the new file in its output',
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log();
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error(
    '\n❌ safeLogger redaction tests FAILED — secrets may leak via console.log.',
  );
  process.exit(1);
}

console.log('\n✅ All safeLogger redaction tests passed');
process.exit(0);
