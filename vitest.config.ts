import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for tests that require module mocking (e.g. stubbing
 * dynamic ESM imports of database modules in route handlers).
 *
 * The legacy in-process test suites under `tests/*.test.ts` continue to run
 * via `tests/runIntegrationTests.ts` (npx tsx). Vitest is scoped strictly to
 * `tests/vitest/**` so the two runners do not collide.
 */
export default defineConfig({
  test: {
    include: ["tests/vitest/**/*.test.ts"],
    globals: false,
    pool: "forks",
    isolate: true,
    reporters: ["default"],
    // Several route-module suites (kpiRoutes, pmpRoutes, scorecardRoutes, ...)
    // import large route graphs and re-import them per test through the mock
    // layer. Each runs in ~1s alone but has been measured at ~4.5s inside the
    // full suite, where forks compete for CPU — close enough to vitest's 5s
    // default that whichever file lost the race failed with "Test timed out in
    // 5000ms", and a DIFFERENT file flaked on each run. The timeout also leaks
    // into the next test in the file, which surfaced once as a bogus 403 and
    // sent debugging down an auth rabbit hole.
    //
    // This only changes how long a hung test waits before being declared
    // failed — no assertion is weakened. A genuinely hung test still fails, it
    // just is not decided by how busy the machine is.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Auth shim for `X-Admin-Key` route tests — see file header for
    // the security-hardening regression it patches around. Per-file
    // `vi.mock("../../src/utils/rbacMiddleware", ...)` calls win over
    // the shim, so suites with their own bespoke rbac mock are unaffected.
    setupFiles: [
      // Must run BEFORE anything imports a route graph: src/mastra/storage
      // throws at module load when DATABASE_URL is unset, which took out any
      // suite that transitively reached qmsConsultantAgent (mobileRoutes).
      "./tests/vitest/_setup/testDatabaseUrl.ts",
      "./tests/vitest/_setup/rbacAuthShim.ts",
    ],
  },
});
