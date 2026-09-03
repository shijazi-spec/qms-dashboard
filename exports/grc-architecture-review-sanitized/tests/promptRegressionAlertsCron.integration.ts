/**
 * Task #365 — DB-backed integration test for the prompt-regression alert cron.
 *
 * Complements the dependency-injected unit test in
 * `tests/promptRegressionAlertsCron.test.ts` (which feeds synthetic
 * aggregate rows into `runPromptRegressionCheck`) by exercising the
 * production wiring against a real Postgres:
 *
 *   ai_call_metrics + ai_call_feedback rows
 *     → getFeedbackRateByPromptVersion()  (the dashboard's query)
 *     → runPromptRegressionCheck()         (default deps, real DB)
 *     → ai_alerts row with alert_type='prompt_regression'
 *
 * Catches drift in the SQL query, the (alert_type, related_record_id)
 * dedupe shape, and the JSONB metadata.prompt_version path that the
 * unit test cannot see because it stubs `fetchAggregates`.
 *
 * Opt-in via `RUN_PROMPT_REGRESSION_E2E=1`. Cleanup runs in `finally`;
 * orphan rows can be found via `agent_name LIKE 'prompt-regression-test-%'`
 * (and the matching `ai_alerts.related_record_id` prefix).
 *
 * Run locally:
 *   RUN_PROMPT_REGRESSION_E2E=1 DATABASE_URL=<REDACTED_DSN> \
 *     npx tsx tests/promptRegressionAlertsCron.integration.ts
 */

import pg from "pg";

import {
  ensureAiMetricsTable,
  insertAiCallMetric,
  insertCallFeedback,
  buildAiCallTelemetryMetadata,
} from "../src/utils/aiTelemetry";
import {
  initAIAlertsTable,
  getAIAlerts,
} from "../src/utils/aiAlertsDatabase";
import { runPromptRegressionCheck } from "../src/mastra/workflows/promptRegressionAlertsCron";

if (process.env.RUN_PROMPT_REGRESSION_E2E !== "1") {
  console.log(
    "[skip] promptRegressionAlertsCron.integration.ts — set " +
      "RUN_PROMPT_REGRESSION_E2E=1 (with DATABASE_URL pointed at a real " +
      "Postgres) to enable this suite.",
  );
  process.exit(0);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    "❌ DATABASE_URL env var is required for the prompt-regression cron " +
      "integration test.",
  );
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

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

// Unique per run so concurrent CI invocations on a shared DB do not
// collide on (agent, version) keys or `ai_alerts.related_record_id`.
const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const AGENT = `prompt-regression-test-${RUN_TAG}`;
const VERSION_CURRENT = "v-current";
const VERSION_ARCHIVED = "v-archived";

// Default cron config: minFeedback=10, dropPctPoints=10, windowDays=30.
// We seed enough feedback that BOTH versions clear the minFeedback floor
// (so the archived version is eligible to be flagged as regressed) and
// that the rate gap (100% vs 50%) is well above the dropPctPoints
// threshold — guaranteeing exactly one alert.
const FEEDBACK_PER_VERSION = 12;

async function cleanup(): Promise<void> {
  // ai_call_feedback rows cascade-delete with their parent metric.
  await pool
    .query("DELETE FROM ai_call_metrics WHERE agent_name = $1", [AGENT])
    .catch(() => undefined);
  await pool
    .query(
      "DELETE FROM ai_alerts WHERE alert_type = 'prompt_regression' AND related_record_id LIKE $1",
      [`${AGENT}:%`],
    )
    .catch(() => undefined);
}

async function seedVersion(
  promptVersion: string,
  thumbsUp: number,
  thumbsDown: number,
): Promise<void> {
  const total = thumbsUp + thumbsDown;
  for (let i = 0; i < total; i++) {
    const callId = await insertAiCallMetric({
      agent_name: AGENT,
      model: "gpt-4o-mini",
      latency_ms: 100,
      success: true,
      metadata: buildAiCallTelemetryMetadata({ promptVersion }),
    });
    if (callId == null) {
      throw new Error(
        `insertAiCallMetric returned null for ${promptVersion} #${i}`,
      );
    }
    const rating: "thumbs_up" | "thumbs_down" =
      i < thumbsUp ? "thumbs_up" : "thumbs_down";
    // Distinct user_hash per call avoids the (call_id, user_hash) unique
    // constraint upsert path so each rating becomes a fresh row.
    const ok = await insertCallFeedback(
      callId,
      rating,
      `${RUN_TAG}-user-${promptVersion}-${i}`,
    );
    if (!ok) {
      throw new Error(
        `insertCallFeedback returned false for ${promptVersion} #${i}`,
      );
    }
  }
}

async function main(): Promise<void> {
  console.log(
    "\n[prompt_regression] Verifying runPromptRegressionCheck() against real Postgres",
  );
  console.log(`  agent: ${AGENT}`);

  await cleanup();
  await ensureAiMetricsTable();
  await initAIAlertsTable();

  try {
    // "Current" version: everyone loves it (100% thumbs-up).
    await seedVersion(
      VERSION_CURRENT,
      FEEDBACK_PER_VERSION,
      0,
    );
    // "Archived" version: regressed (50% thumbs-up). The cron picks the
    // best-rated eligible version as baseline and flags every other
    // eligible version that has dropped by >= dropPctPoints — i.e. the
    // archived one here, with a 50pp gap.
    await seedVersion(
      VERSION_ARCHIVED,
      Math.floor(FEEDBACK_PER_VERSION / 2),
      Math.ceil(FEEDBACK_PER_VERSION / 2),
    );

    // Run the cron with default deps so the real SQL is exercised, but
    // stub out the side-effect deps so the test cannot:
    //   • page ChatProvider/email (notifyBreaches / notifyRecovery),
    //   • disturb pre-existing prompt_regression alerts owned by other
    //     suites/tenants on a shared DB (listOpenRegressionAlerts → []),
    //   • depend on the prompt_regression_config_overrides table being
    //     present and empty (loadOverrides → {}).
    const out = await runPromptRegressionCheck({
      listOpenRegressionAlerts: async () => [],
      notifyBreaches: async () => {},
      notifyRecovery: async () => {},
      loadOverrides: async () => ({}),
    });

    assert(
      out.alertsCreated >= 1,
      `at least one alert created (got ${out.alertsCreated})`,
    );
    const breach = out.breaches.find(
      (b) =>
        b.agent_name === AGENT &&
        b.regressed_version === VERSION_ARCHIVED,
    );
    assert(
      breach != null,
      `breach record points at ${AGENT}:${VERSION_ARCHIVED}`,
    );
    if (breach) {
      assert(
        breach.best_version === VERSION_CURRENT,
        `best version is ${VERSION_CURRENT} (got "${breach.best_version}")`,
      );
      assert(
        breach.drop_pp >= 10,
        `drop_pp clears the default threshold (got ${breach.drop_pp})`,
      );
    }

    // Round-trip through the real ai_alerts table: the alert the cron
    // wrote must be readable via the same getAIAlerts() query the AI Ops
    // dashboard's alerts feed uses, with the documented dedupe key shape.
    const expectedKey = `<REDACTED_SECRET>`;
    const { alerts } = await getAIAlerts({
      alert_type: "prompt_regression",
      status: "open",
      limit: 200,
    });
    const seeded = alerts.find((a) => a.related_record_id === expectedKey);
    assert(
      seeded != null,
      `getAIAlerts returns a prompt_regression alert with related_record_id="${expectedKey}"`,
    );
    if (seeded) {
      assert(
        seeded.alert_type === "prompt_regression",
        `alert_type is "prompt_regression" (got "${seeded.alert_type}")`,
      );
      assert(
        seeded.title.includes(AGENT) && seeded.title.includes(VERSION_ARCHIVED),
        "alert title names the agent and the regressed version",
      );
      assert(
        seeded.description.includes(VERSION_CURRENT) &&
          seeded.description.includes(VERSION_ARCHIVED),
        "alert description names both versions",
      );
    }
  } finally {
    await cleanup();
    await pool.end().catch(() => undefined);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error("Unexpected error:", err);
  await cleanup().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
