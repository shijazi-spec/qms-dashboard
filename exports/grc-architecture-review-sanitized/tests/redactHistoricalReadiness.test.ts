/**
 * Boot-sweep readiness gate (Task #341).
 *
 * Verifies waitForTablesReady() in `src/utils/redactHistoricalLogs.ts`
 * polls `to_regclass()` for every required table, retries with the
 * configured interval until they all exist, and times out cleanly when
 * one or more never appear.
 *
 * Run:  npx tsx tests/redactHistoricalReadiness.test.ts
 */

import {
  REQUIRED_SWEEP_TABLES,
  waitForTablesReady,
} from "../src/utils/redactHistoricalLogs";

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

interface ProbeStub {
  query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<any>;
  probeCalls: number;
}

/**
 * Stub client whose `to_regclass()` view of the database evolves over
 * time. `presentByCall[n]` is the set of table names that exist on the
 * (1-indexed) n-th probe; later calls reuse the last entry. Lets a test
 * model "tables don't exist yet, then they do" without timing
 * assumptions.
 */
function buildProbeStub(
  presentByCall: ReadonlyArray<ReadonlySet<string>>,
): ProbeStub {
  const stub: ProbeStub = {
    probeCalls: 0,
    async query(sql: string, params: ReadonlyArray<unknown> = []) {
      if (!/to_regclass/i.test(sql)) {
        throw new Error(`Unexpected SQL on readiness stub:\n${sql}`);
      }
      stub.probeCalls++;
      const present =
        presentByCall[Math.min(stub.probeCalls - 1, presentByCall.length - 1)];
      const rows = (params as ReadonlyArray<string>).map((name) => ({
        name,
        present: present.has(name),
      }));
      return { rows, rowCount: rows.length };
    },
  };
  return stub;
}

async function run(): Promise<void> {
  console.log("\n[redactHistoricalLogs] table-readiness gate (Task #341)\n");

  // Test scaffolding: a deterministic clock + fake sleep so the wait loop
  // is fully synchronous and we can assert on `waitedMs` exactly.
  let nowMs = 0;
  const clock = () => nowMs;
  const sleep = async (ms: number) => {
    nowMs += ms;
  };

  // -------------------------------------------------------------------
  // 1. Steady-state: all tables already exist → ready on the first probe.
  // -------------------------------------------------------------------
  {
    nowMs = 0;
    const stub = buildProbeStub([new Set(REQUIRED_SWEEP_TABLES)]);
    const result = await waitForTablesReady(stub as any, {
      sleep,
      now: clock,
    });
    assert(result.ready === true, "steady-state: ready=true");
    assert(result.missing.length === 0, "steady-state: no missing tables");
    assert(result.attempts === 1, "steady-state: exactly 1 probe issued");
    assert(stub.probeCalls === 1, "steady-state: exactly 1 SQL probe");
    assert(result.waitedMs === 0, "steady-state: 0ms wait");
  }

  // -------------------------------------------------------------------
  // 2. Cold-start: tables appear gradually, sweep waits then proceeds.
  // -------------------------------------------------------------------
  {
    nowMs = 0;
    const stub = buildProbeStub([
      new Set(["event_logs"]), // probe 1: only event_logs exists
      new Set(["event_logs", "nc_change_history"]), // probe 2: two
      new Set(["event_logs", "nc_change_history", "capa_change_history"]), // probe 3: three
      new Set(REQUIRED_SWEEP_TABLES), // probe 4: all four
    ]);
    const result = await waitForTablesReady(stub as any, {
      intervalMs: 250,
      timeoutMs: 10_000,
      sleep,
      now: clock,
    });
    assert(result.ready === true, "cold-start: ready=true after waiting");
    assert(result.attempts === 4, "cold-start: required exactly 4 probes");
    // After 3 unsuccessful probes the loop slept 3 * 250 ms before the 4th.
    assert(
      result.waitedMs === 750,
      `cold-start: waited 750ms (got ${result.waitedMs})`,
    );
    assert(result.missing.length === 0, "cold-start: no missing on success");
  }

  // -------------------------------------------------------------------
  // 3. Timeout: at least one table never appears → ready=false, sweep
  //    must skip cleanly without writing a `table_missing` audit entry.
  // -------------------------------------------------------------------
  {
    nowMs = 0;
    // ai_pending_actions never shows up in this scenario.
    const persistent = new Set([
      "event_logs",
      "nc_change_history",
      "capa_change_history",
    ]);
    const stub = buildProbeStub([persistent]);
    const result = await waitForTablesReady(stub as any, {
      intervalMs: 100,
      timeoutMs: 500,
      sleep,
      now: clock,
    });
    assert(result.ready === false, "timeout: ready=false");
    assert(
      result.missing.length === 1 && result.missing[0] === "ai_pending_actions",
      `timeout: reports the missing table (got ${JSON.stringify(result.missing)})`,
    );
    assert(
      result.waitedMs >= 500,
      `timeout: waited at least the configured 500ms (got ${result.waitedMs})`,
    );
  }

  // -------------------------------------------------------------------
  // 4. Probe error treated as "not ready" — recovers on the next poll.
  //    A transient connection error during cold-start must not crash the
  //    boot path; the loop should keep trying until either success or
  //    the timeout elapses.
  // -------------------------------------------------------------------
  {
    nowMs = 0;
    let call = 0;
    const flakyStub = {
      probeCalls: 0,
      async query(_sql: string, params: ReadonlyArray<unknown> = []) {
        call++;
        flakyStub.probeCalls = call;
        if (call === 1) {
          throw new Error("connection reset by peer");
        }
        const rows = (params as ReadonlyArray<string>).map((name) => ({
          name,
          present: true,
        }));
        return { rows, rowCount: rows.length };
      },
    };
    const result = await waitForTablesReady(flakyStub as any, {
      intervalMs: 100,
      timeoutMs: 5_000,
      sleep,
      now: clock,
    });
    assert(result.ready === true, "probe-error: recovers on retry");
    assert(
      flakyStub.probeCalls === 2,
      `probe-error: required exactly 2 probes (got ${flakyStub.probeCalls})`,
    );
    assert(
      result.waitedMs === 100,
      `probe-error: waited one interval (got ${result.waitedMs})`,
    );
  }

  // -------------------------------------------------------------------
  // 5. The required-tables list matches what the sweep itself touches.
  //    Guards against drift between the readiness gate and the sweep.
  // -------------------------------------------------------------------
  {
    const expected = [
      "event_logs",
      "nc_change_history",
      "capa_change_history",
      "ai_pending_actions",
    ];
    assert(
      REQUIRED_SWEEP_TABLES.length === expected.length &&
        expected.every((name) =>
          (REQUIRED_SWEEP_TABLES as ReadonlyArray<string>).includes(name),
        ),
      "REQUIRED_SWEEP_TABLES covers the four sweep targets",
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(
      "\n❌ redactHistoricalReadiness tests FAILED — boot sweep may run before tables exist.",
    );
    process.exit(1);
  }
  console.log("\n✅ All redactHistoricalReadiness tests passed");
}

run().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
