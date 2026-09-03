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
  pure("require -> no-verify", "postgres://u:p@h/db?sslmode=require", "postgres://u:p@h/db?sslmode=no-verify");
  pure("prefer -> no-verify", "postgres://u:p@h/db?sslmode=prefer", "postgres://u:p@h/db?sslmode=no-verify");
  pure("verify-ca -> no-verify", "postgres://u:p@h/db?sslmode=verify-ca", "postgres://u:p@h/db?sslmode=no-verify");
  pure("verify-full untouched", "postgres://u:p@h/db?sslmode=verify-full", "postgres://u:p@h/db?sslmode=verify-full");
  pure("no-verify untouched (idempotent)", "postgres://u:p@h/db?sslmode=no-verify", "postgres://u:p@h/db?sslmode=no-verify");
  pure("no sslmode untouched", "postgres://u:p@h/db", "postgres://u:p@h/db");
  pure("DSN require -> no-verify", "host=h sslmode=require dbname=app", "host=h sslmode=no-verify dbname=app");
  pure("undefined -> undefined", undefined, undefined);
  pure("empty -> empty", "", "");


  await check(
    "sslmode=require -> no-verify",
    "postgres://u:p@host:5432/db?sslmode=require",
    "postgres://u:p@host:5432/db?sslmode=no-verify",
  );
  await check(
    "sslmode=require preserves other params",
    "postgresql://u:p@host/db?sslmode=require&pool_timeout=0",
    "postgresql://u:p@host/db?sslmode=no-verify&pool_timeout=0",
  );
  await check(
    "sslmode=prefer -> no-verify",
    "postgres://u:p@host/db?sslmode=prefer",
    "postgres://u:p@host/db?sslmode=no-verify",
  );
  await check(
    "sslmode=verify-ca -> no-verify",
    "postgres://u:p@host/db?sslmode=verify-ca",
    "postgres://u:p@host/db?sslmode=no-verify",
  );
  await check(
    "uppercase REQUIRE -> no-verify (case-insensitive)",
    "postgres://u:p@host/db?sslmode=REQUIRE",
    "postgres://u:p@host/db?sslmode=no-verify",
  );
  await check(
    "sslmode=verify-full left untouched",
    "postgres://u:p@host/db?sslmode=verify-full",
    "postgres://u:p@host/db?sslmode=verify-full",
  );
  await check(
    "sslmode=disable left untouched",
    "postgres://u:p@host/db?sslmode=disable",
    "postgres://u:p@host/db?sslmode=disable",
  );
  await check(
    "no sslmode (dev) left untouched",
    "postgres://u:p@host/db",
    "postgres://u:p@host/db",
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
