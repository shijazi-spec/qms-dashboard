/**
 * Tests for the DATABASE_URL SSL normalization side-effect module.
 * Run: npx tsx tests/normalizeDatabaseUrl.test.ts
 */
import assert from "node:assert";

let passed = 0;
let failed = 0;

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
    "host=db.example.com port=5432 sslmode=require dbname=app",
    "host=db.example.com port=5432 sslmode=no-verify dbname=app",
  );
  await check(
    "DSN sslmode=require -> no-verify (at start)",
    "sslmode=require host=db.example.com dbname=app",
    "sslmode=no-verify host=db.example.com dbname=app",
  );
  await check(
    "DSN sslmode=require -> no-verify (at end)",
    "host=db.example.com dbname=app sslmode=require",
    "host=db.example.com dbname=app sslmode=no-verify",
  );
  await check(
    "DSN uppercase VERIFY-CA -> no-verify (case-insensitive)",
    "host=db.example.com sslmode=VERIFY-CA dbname=app",
    "host=db.example.com sslmode=no-verify dbname=app",
  );
  await check(
    "DSN sslmode=verify-full left untouched",
    "host=db.example.com sslmode=verify-full dbname=app",
    "host=db.example.com sslmode=verify-full dbname=app",
  );
  await check(
    "DSN sslmode=disable left untouched",
    "host=db.example.com sslmode=disable dbname=app",
    "host=db.example.com sslmode=disable dbname=app",
  );
  await check(
    "DSN no sslmode left untouched",
    "host=db.example.com port=5432 dbname=app",
    "host=db.example.com port=5432 dbname=app",
  );

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
