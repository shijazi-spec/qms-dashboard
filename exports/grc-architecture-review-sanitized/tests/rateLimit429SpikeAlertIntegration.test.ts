/**
 * Task #533 — DB-backed integration test for the 24h rate-limit 429 spike
 * alert cron.
 *
 * Complements the dependency-injected unit test
 * `tests/rateLimit429SpikeAlert.test.ts` (which feeds synthetic aggregates
 * into `runRateLimit429SpikeAlertCheck` via stubs) by exercising the
 * production wiring against a real Postgres:
 *
 *   system_events rows (event_type='rate_limit_429')
 *     → DEFAULT_FETCH_AGGREGATE        (the dashboard's query)
 *     → DEFAULT_COUNT_RECENT           (the dedupe window)
 *     → DEFAULT_EMIT_EVENT             (logSystemEvent → system_events)
 *
 * Catches drift in the SQL shape (column rename, schema drift), the
 * `rate_limit_429_spike_alert` event_type/severity enum, and the JSONB
 * `metadata->>'ip'` / `metadata->>'suppressed_in_previous_minute'` paths
 * the unit test cannot see because it stubs every dep.
 *
 * Skips on missing DATABASE_URL (matching the project convention used by
 * tests/aiTelemetryChildCallIndex.test.ts and tests/toolHealthConfigDatabase.test.ts).
 *
 * ChatProvider/email side-effect deps are stubbed so the test cannot page on-call
 * even if the runner happens to have a webhook configured.
 *
 * Run:   npx tsx tests/rateLimit429SpikeAlertIntegration.test.ts
 * Wired: discovered automatically by tests/runIntegrationTests.ts (npm test).
 */

import { sharedPool as pool } from "../src/utils/sharedPool";
import { runRateLimit429SpikeAlertCheck } from "../src/utils/rateLimit429SpikeAlert";

const HAS_DB = !!process.env.DATABASE_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string, extra?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`, extra ?? "");
    failed++;
  }
}

console.log("\n=== rateLimit429SpikeAlert DB integration test ===\n");

if (!HAS_DB) {
  console.log("[skip] DATABASE_URL not set — skipping DB-backed tests.\n");
  process.exit(0);
}

// Unique per run so concurrent CI invocations on a shared DB do not collide
// on seed/cleanup boundaries.
const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SEED_SOURCE = `rate_limit_429_spike_alert_test_${RUN_TAG}`;
const SEED_IP_PRIMARY = `10.0.${(Math.floor(Math.random() * 250) + 1)}.1`;
const SEED_IP_SECONDARY = `10.0.${(Math.floor(Math.random() * 250) + 1)}.2`;
const THRESHOLD = 25;
const SEED_COUNT = 30; // > THRESHOLD so the eval is "above_threshold"
const REPEAT_HOURS = 6;

async function ensureSystemEventsTable(): Promise<void> {
  // Mirrors src/utils/database.ts:ensureActivityTables() — that helper is
  // module-private and is only triggered indirectly via logAdminActivity().
  // A fresh CI Postgres won't have the table until something writes through
  // it, so we create it here defensively (IF NOT EXISTS — no-op on existing
  // schemas).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_events (
      id SERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      event_category TEXT,
      description TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      source TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function seed429Events(): Promise<void> {
  // Spread within the last 24h. `metadata.ip` and
  // `metadata.suppressed_in_previous_minute` are the JSONB paths the
  // production aggregate reads — seeding them lets us verify the top-IP
  // breakdown and totalSuppressed sums end-to-end.
  for (let i = 0; i < SEED_COUNT; i++) {
    const ip = i % 3 === 0 ? SEED_IP_SECONDARY : SEED_IP_PRIMARY;
    const suppressed = i % 5 === 0 ? 2 : 0;
    await pool.query(
      `INSERT INTO system_events
         (event_type, event_category, description, severity, source, metadata, created_at)
       VALUES ('rate_limit_429', 'security', $1, 'info', $2, $3::jsonb, NOW() - ($4::int * INTERVAL '1 minute'))`,
      [
        `synthetic 429 #${i} for spike alert integration test`,
        SEED_SOURCE,
        JSON.stringify({
          ip,
          suppressed_in_previous_minute: suppressed,
          test_run: RUN_TAG,
        }),
        i, // 0..SEED_COUNT-1 minutes ago
      ],
    );
  }
}

async function cleanup(): Promise<void> {
  // Both the seeded `rate_limit_429` rows and any spike alert rows the
  // cron wrote during the run carry our unique RUN_TAG so cleanup is
  // surgical and cannot delete unrelated rows on a shared DB.
  await pool
    .query(
      `DELETE FROM system_events
        WHERE event_type = 'rate_limit_429'
          AND source = $1`,
      [SEED_SOURCE],
    )
    .catch(() => undefined);
  await pool
    .query(
      `DELETE FROM system_events
        WHERE event_type = 'rate_limit_429_spike_alert'
          AND metadata->>'test_run_tag' = $1`,
      [RUN_TAG],
    )
    .catch(() => undefined);
}

async function countSpikeAlertsForRun(): Promise<number> {
  const r = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::bigint AS c
       FROM system_events
      WHERE event_type = 'rate_limit_429_spike_alert'
        AND metadata->>'test_run_tag' = $1`,
    [RUN_TAG],
  );
  return parseInt(r.rows[0]?.c ?? "0", 10);
}

async function main(): Promise<void> {
  await ensureSystemEventsTable();
  await cleanup();

  try {
    await seed429Events();

    // Tagging hook: wrap the default emit so every spike alert this test
    // writes carries the unique RUN_TAG, enabling the dedupe-by-tag count
    // and surgical cleanup. We delegate to the real `logSystemEvent` so
    // the production INSERT path (severity enum, source, JSONB encoding)
    // is still exercised.
    const { logSystemEvent } = await import("../src/utils/database");
    const taggedEmit = async ({
      description,
      metadata,
    }: {
      description: string;
      metadata: Record<string, unknown>;
    }) => {
      await logSystemEvent({
        event_type: "rate_limit_429_spike_alert",
        event_category: "security",
        description,
        severity: "warning",
        source: "rateLimit429SpikeAlert",
        metadata: { ...metadata, test_run_tag: RUN_TAG },
      });
    };

    // ── First call: should write exactly one spike alert. ───────────────
    const first = await runRateLimit429SpikeAlertCheck({
      threshold: THRESHOLD,
      repeatHours: REPEAT_HOURS,
      emitSystemEvent: taggedEmit,
      // Stub ChatProvider/email so the test cannot page even if the runner has
      // a webhook configured.
      postChatProvider: async () => false,
      sendEmail: async () => false,
    });

    assert(
      first.active === true && first.reason === "above_threshold",
      `first run: active=true, reason=above_threshold (got active=${first.active}, reason=${first.reason})`,
    );
    assert(
      first.total429 >= SEED_COUNT,
      `first run: total429 includes all ${SEED_COUNT} seeded rows (got ${first.total429})`,
    );
    assert(
      first.alertEmitted === true,
      `first run: alert was written (alertEmitted=true)`,
    );
    assert(
      first.alertSuppressedAsRepeat === false,
      `first run: not suppressed (alertSuppressedAsRepeat=false)`,
    );

    const writtenAfterFirst = await countSpikeAlertsForRun();
    assert(
      writtenAfterFirst === 1,
      `exactly one rate_limit_429_spike_alert row landed in system_events for this run (got ${writtenAfterFirst})`,
    );

    // ── Second call inside the repeat window: must be suppressed. ───────
    const second = await runRateLimit429SpikeAlertCheck({
      threshold: THRESHOLD,
      repeatHours: REPEAT_HOURS,
      emitSystemEvent: taggedEmit,
      postChatProvider: async () => false,
      sendEmail: async () => false,
    });

    assert(
      second.active === true && second.reason === "above_threshold",
      `second run: still active (above threshold)`,
    );
    assert(
      second.alertEmitted === false,
      `second run: NOT emitted (alertEmitted=false)`,
    );
    assert(
      second.alertSuppressedAsRepeat === true,
      `second run: suppressed as repeat (alertSuppressedAsRepeat=true)`,
    );

    const writtenAfterSecond = await countSpikeAlertsForRun();
    assert(
      writtenAfterSecond === 1,
      `still exactly one spike alert row after the second call (got ${writtenAfterSecond})`,
    );

    // ── Verify the row the cron wrote has the production shape. ─────────
    const persisted = await pool.query<{
      severity: string;
      event_category: string;
      source: string;
      description: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT severity, event_category, source, description, metadata
         FROM system_events
        WHERE event_type = 'rate_limit_429_spike_alert'
          AND metadata->>'test_run_tag' = $1`,
      [RUN_TAG],
    );
    assert(persisted.rows.length === 1, "persisted alert row count = 1");
    if (persisted.rows.length === 1) {
      const row = persisted.rows[0];
      assert(
        row.severity === "warning",
        `persisted row severity = "warning" (got "${row.severity}")`,
      );
      assert(
        row.event_category === "security",
        `persisted row event_category = "security" (got "${row.event_category}")`,
      );
      assert(
        row.source === "rateLimit429SpikeAlert",
        `persisted row source = "rateLimit429SpikeAlert" (got "${row.source}")`,
      );
      const md = row.metadata || {};
      assert(
        typeof md.total429 === "number" && (md.total429 as number) >= SEED_COUNT,
        `metadata.total429 reflects seeded count (got ${md.total429})`,
      );
      assert(
        md.threshold === THRESHOLD,
        `metadata.threshold = ${THRESHOLD} (got ${md.threshold})`,
      );
      assert(
        Array.isArray(md.topIps) && (md.topIps as unknown[]).length > 0,
        `metadata.topIps non-empty (got ${JSON.stringify(md.topIps)})`,
      );
      const ips = (md.topIps as Array<{ ip: string; events: number }>).map(
        (t) => t.ip,
      );
      assert(
        ips.includes(SEED_IP_PRIMARY),
        `topIps includes the seeded primary IP ${SEED_IP_PRIMARY} (got ${ips.join(", ")})`,
      );
      assert(
        row.description.includes(String(THRESHOLD)),
        `description references threshold (got "${row.description}")`,
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
