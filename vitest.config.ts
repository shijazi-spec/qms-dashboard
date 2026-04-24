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
  },
});
