/**
 * Schema bootstrap for the CI integration suite.
 *
 * WHY THIS EXISTS
 * ---------------
 * `.github/workflows/tests.yml` starts a bare `postgres:16-alpine` service and
 * runs `npm test` straight against it. Nothing in between creates a table.
 *
 * That is survivable for most of the suite, because this app owns its schema at
 * runtime: every table is a `CREATE TABLE IF NOT EXISTS` inside an init that
 * runs lazily, on the first read or write of the feature that owns it (see
 * scripts/check-lazy-tables.mjs). A test that exercises such a path creates
 * what it needs on the way through.
 *
 * It is NOT survivable for a test that seeds straight through a data helper.
 * `aiOpsRoutes.test.ts` calls `createAIAlert()` without anything having called
 * `initAIAlertsTable()` first, so CI reported `relation "ai_alerts" does not
 * exist` 24 times in one run while the same test passed on every developer
 * machine — where that feature had been exercised once, months ago.
 *
 * So this front-runs the inits the suite cannot trigger for itself. It is not a
 * migration system and does not aspire to be one: the lazy inits stay the
 * source of truth, and this only calls them earlier.
 *
 * WHY THE GUARD
 * -------------
 * `initKPITables()` is NOT pure DDL. It also runs seedDefaultKPIs,
 * seedFinalGrqKpis, reassignMohammedKPIs and deactivateStaleLegacyKPIs — the
 * GRQ sweep that has previously deactivated live rows and produced "No active
 * KPIs found for <Team>" on the dashboard. Pointed at a real database, this
 * script would rewrite the KPI catalog.
 *
 * It therefore refuses to run unless BOTH hold:
 *   1. ALLOW_TEST_SCHEMA_BOOTSTRAP=1 is set explicitly, and
 *   2. DATABASE_URL points at a local host, or names a database containing
 *      "test".
 *
 * Fail closed: a missing or unparseable DATABASE_URL is a refusal, never a
 * pass.
 *
 * Usage:
 *   ALLOW_TEST_SCHEMA_BOOTSTRAP=1 npx tsx scripts/bootstrap-test-schema.ts
 */

interface BootstrapStep {
  label: string;
  run: () => Promise<unknown>;
}

type Target = { host: string; database: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function describeTarget(raw: string): Target | null {
  try {
    const parsed = new URL(raw);
    return {
      host: parsed.hostname,
      database: parsed.pathname.replace(/^\//, ""),
    };
  } catch {
    return null;
  }
}

function isDisposableTarget(target: Target): boolean {
  return LOCAL_HOSTS.has(target.host) || /test/i.test(target.database);
}

/**
 * The inits the suite cannot trigger for itself.
 *
 * Deliberately short. Every entry here is a table some test writes to through a
 * helper that does not init it — not "every table the app has". Adding one
 * because a test failed once is how this turns into a second, worse migration
 * system.
 */
const STEPS: BootstrapStep[] = [
  {
    // Pure DDL. Needed by aiOpsRoutes, consultantRoutes and
    // rateLimit429SpikeAlertIntegration, all of which seed via createAIAlert().
    label: "ai_alerts",
    run: () =>
      import("../src/utils/aiAlertsDatabase").then((m) =>
        m.initAIAlertsTable(),
      ),
  },
  {
    // Pure DDL. Needed by dashboardApiRoutes.
    label: "notifications",
    run: () =>
      import("../src/utils/notificationHub").then((m) =>
        m.initNotificationTables(),
      ),
  },
  {
    // NOT pure DDL — see WHY THE GUARD above. kpi_definitions is needed by
    // estimateEndpoints (the KPI CSV and XLSX estimate routes).
    label: "kpi_definitions (+ GRQ seed)",
    run: () =>
      import("../src/utils/kpiDatabase").then((m) => m.initKPITables()),
  },
];

async function main(): Promise<void> {
  if (process.env.ALLOW_TEST_SCHEMA_BOOTSTRAP !== "1") {
    console.error(
      "✗ Refusing to run: set ALLOW_TEST_SCHEMA_BOOTSTRAP=1 to confirm this " +
        "database is disposable. See the header of this file for why.",
    );
    process.exit(2);
  }

  const target = describeTarget(process.env.DATABASE_URL ?? "");
  if (!target) {
    console.error("✗ Refusing to run: DATABASE_URL is missing or unparseable.");
    process.exit(2);
  }

  if (!isDisposableTarget(target)) {
    console.error(
      `✗ Refusing to run against ${target.host}/${target.database}: not a ` +
        'local host, and the database name does not contain "test".',
    );
    process.exit(2);
  }

  console.log(
    `\n▶ Bootstrapping test schema on ${target.host}/${target.database}\n`,
  );

  // Each step runs even after an earlier one fails, so a single broken init
  // does not hide the state of the others. One CI run should report the whole
  // picture, not the first problem in the list.
  let failed = 0;
  for (const step of STEPS) {
    const startedAt = Date.now();
    try {
      await step.run();
      console.log(`  ✓ ${step.label} (${Date.now() - startedAt}ms)`);
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ ${step.label} — ${message}`);
    }
  }

  console.log(
    `\n  Result: ${STEPS.length - failed}/${STEPS.length} bootstrapped.\n`,
  );

  // Explicit exit: each imported module owns a pg Pool that would otherwise
  // hold the event loop open long past the last statement.
  process.exit(failed === 0 ? 0 : 1);
}

await main();
