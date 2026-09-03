/**
 * Give vitest workers a DATABASE_URL so route graphs can be imported.
 *
 * `src/mastra/storage/index.ts` throws AT MODULE LOAD when DATABASE_URL is
 * unset — a deliberate production guard, so that a deploy cannot silently come
 * up pointed at no database. But any suite whose import chain reaches it dies
 * before a single test runs, which is what `mobileRoutes.vitest.test.ts` has
 * been doing (it imports the route graph, which reaches qmsConsultantAgent,
 * which reaches storage).
 *
 * This does NOT connect to anything. Every vitest suite stubs `pg` or
 * `redactedPool`, so the value only has to satisfy the guard and parse as a
 * connection string. Pointing it at a real database would be the dangerous
 * option — a test that forgot its stub would then quietly read and write live
 * data instead of failing loudly on connect.
 *
 * Only set when absent, so a developer who deliberately exports DATABASE_URL
 * to run something against a scratch database keeps their value.
 */
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    "postgresql://vitest:vitest@<REDACTED_IP>:1/vitest_no_such_database";
}
