/**
 * Tests for the DATABASE_URL SSL normalization side-effect module.
 * Run: npx tsx tests/normalizeDatabaseUrl.test.ts
 */
import assert from "node:assert";
import { normalizeSslMode } from "../src/utils/normalizeDatabaseUrl";

let passed = 0;
let failed = 0;

function pure(name: string, input: string | undefined, expected: string | undefined) {
  const actual = normalizeSslMode(input);
  try {
    assert.strictEqual(actual, expected);
    // Idempotency: applying the transform again must not change the result.
    assert.strictEqual(normalizeSslMode(actual), expected);
    console.log(`  ✓ [pure] ${name}`);
    passed++;
  } catch {
    console.log(`  ✗ [pure] ${name}\n      input:    ${input}\n      expected: ${expected}\n      actual:   ${actual}`);
    failed++;
  }
}

async function check(name: string, input: string, expected: string) {
  // Re-import the module fresh for each case by resetting the env and using a
  // cache-busting query on the module specifier.
  process.env.DATABASE_URL = input;
  const mod = `../src/utils/normalizeDatabaseUrl.ts?case=${encodeURIComponent(name)}`;
  await import(mod);
  const actual = process.env.DATABASE_URL;
  try {
    assert.strictEqual(actual, expected);
    console.log(`  ✓ ${name}`);
    passed++;
  } catch {
    console.log(`  ✗ ${name}\n      input:    ${input}\n      expected: ${expected}\n      actual:   ${actual}`);
    failed++;
  }
}

(async () => {
  console.log("=== normalizeDatabaseUrl — tests ===");

  console.log("-- pure normalizeSslMode --");
  pure("require -> no-verify", "<REDACTED_DSN>", "<REDACTED_DSN>");
  pure("prefer -> no-verify", "<REDACTED_DSN>", "<REDACTED_DSN>");
  pure("verify-ca -> no-verify", "<REDACTED_DSN>", "<REDACTED_DSN>");
  pure("verify-full untouched", "<REDACTED_DSN>", "<REDACTED_DSN>");
  pure("no-verify untouched (idempotent)", "<REDACTED_DSN>", "<REDACTED_DSN>");
  pure("no sslmode untouched", "<REDACTED_DSN>", "<REDACTED_DSN>");
  pure("DSN require -> no-verify", "host=h sslmode=require dbname=app", "host=h sslmode=no-verify dbname=app");
  pure("undefined -> undefined", undefined, undefined);
  pure("empty -> empty", "", "");


  await check(
    "sslmode=require -> no-verify",
    "<REDACTED_DSN>",
    "<REDACTED_DSN>",
  );
  await check(
    "sslmode=require preserves other params",
    "<REDACTED_DSN>",
    "<REDACTED_DSN>",
  );
  await check(
    "sslmode=prefer -> no-verify",
    "<REDACTED_DSN>",
    "<REDACTED_DSN>",
  );
  await check(
    "sslmode=verify-ca -> no-verify",
    "<REDACTED_DSN>",
    "<REDACTED_DSN>",
  );
  await check(
    "uppercase REQUIRE -> no-verify (case-insensitive)",
    "<REDACTED_DSN>",
    "<REDACTED_DSN>",
  );
  await check(
    "sslmode=verify-full left untouched",
    "<REDACTED_DSN>",
    "<REDACTED_DSN>",
  );
  await check(
    "sslmode=disable left untouched",
    "<REDACTED_DSN>",
    "<REDACTED_DSN>",
  );
  await check(
    "no sslmode (dev) left untouched",
    "<REDACTED_DSN>",
    "<REDACTED_DSN>",
  );

  // libpq key=value DSN form (not URL-parseable -> fallback branch)
  await check(
    "DSN sslmode=require -> no-verify (mid-string)",
    "host=<REDACTED_HOST> port=5432 sslmode=require dbname=app",
    "host=<REDACTED_HOST> port=5432 sslmode=no-verify dbname=app",
  );
  await check(
    "DSN sslmode=require -> no-verify (at start)",
    "sslmode=require host=<REDACTED_HOST> dbname=app",
    "sslmode=no-verify host=<REDACTED_HOST> dbname=app",
  );
  await check(
    "DSN sslmode=require -> no-verify (at end)",
    "host=<REDACTED_HOST> dbname=app sslmode=require",
    "host=<REDACTED_HOST> dbname=app sslmode=no-verify",
  );
  await check(
    "DSN uppercase VERIFY-CA -> no-verify (case-insensitive)",
    "host=<REDACTED_HOST> sslmode=VERIFY-CA dbname=app",
    "host=<REDACTED_HOST> sslmode=no-verify dbname=app",
  );
  await check(
    "DSN sslmode=verify-full left untouched",
    "host=<REDACTED_HOST> sslmode=verify-full dbname=app",
    "host=<REDACTED_HOST> sslmode=verify-full dbname=app",
  );
  await check(
    "DSN sslmode=disable left untouched",
    "host=<REDACTED_HOST> sslmode=disable dbname=app",
    "host=<REDACTED_HOST> sslmode=disable dbname=app",
  );
  await check(
    "DSN no sslmode left untouched",
    "host=<REDACTED_HOST> port=5432 dbname=app",
    "host=<REDACTED_HOST> port=5432 dbname=app",
  );

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
