/**
 * Unit tests for buildPerCheckHistory in src/utils/platformHealthPulse.ts
 *
 * Covers:
 *   - chronological ordering (oldest first → newest last)
 *   - per-check trimming to the requested limit
 *   - graceful handling of malformed / legacy run rows
 *   - status normalization (unknown values fall back to 'skipped')
 *
 * Run:  npx tsx tests/healthPulsePerCheckHistory.test.ts
 */

import { buildPerCheckHistory, type PulseRun } from "../src/utils/platformHealthPulse";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("buildPerCheckHistory");

console.log("\n=== buildPerCheckHistory unit tests ===\n");

function mkRun(at: string, checks: any): PulseRun {
  return {
    run_at: new Date(at),
    overall_status: "healthy",
    pass_count: 0,
    warn_count: 0,
    fail_count: 0,
    skipped_count: 0,
    duration_ms: 0,
    checks,
  };
}

await suite.test("returns empty object when no runs are provided", async () => {
  const out = buildPerCheckHistory([]);
  suite.expectEqual(Object.keys(out).length, 0, "no keys");
});

await suite.test("orders entries chronologically (oldest first)", async () => {
  // getRecentPulseRuns returns newest-first, so we feed in that order.
  const runs: PulseRun[] = [
    mkRun("2026-04-25T10:00:00Z", [{ id: "db_connectivity", status: "pass" }]),
    mkRun("2026-04-25T09:00:00Z", [{ id: "db_connectivity", status: "warn" }]),
    mkRun("2026-04-25T08:00:00Z", [{ id: "db_connectivity", status: "fail" }]),
  ];
  const out = buildPerCheckHistory(runs);
  const series = out["db_connectivity"] || [];
  suite.expectEqual(series.length, 3, "three entries");
  suite.expectEqual(series[0].status, "fail", "oldest first");
  suite.expectEqual(series[1].status, "warn", "middle");
  suite.expectEqual(series[2].status, "pass", "newest last");
});

await suite.test("trims to the requested per-check limit (newest kept)", async () => {
  // Mimic getRecentPulseRuns shape: newest run first. Index i == 0 is the
  // most recent run; i == 49 is the oldest. Mark only the very oldest runs
  // (i >= 45) as "fail" so we can verify trimming keeps the newest 30
  // entries (which should all be "pass").
  const runs: PulseRun[] = [];
  for (let i = 0; i < 50; i++) {
    runs.push(mkRun(
      new Date(2026, 0, 1, 49 - i).toISOString(),
      [{ id: "audit_recency", status: i >= 45 ? "fail" : "pass" }],
    ));
  }
  const out = buildPerCheckHistory(runs, 30);
  const series = out["audit_recency"] || [];
  suite.expectEqual(series.length, 30, "trimmed to 30");
  suite.expectEqual(series[series.length - 1].status, "pass", "newest preserved");
  suite.expectEqual(series[0].status, "pass", "oldest in trimmed window also a pass");
});

await suite.test("ignores runs whose checks payload is missing or malformed", async () => {
  const runs: PulseRun[] = [
    mkRun("2026-04-25T10:00:00Z", null as any),
    mkRun("2026-04-25T09:00:00Z", "not-an-array" as any),
    mkRun("2026-04-25T08:00:00Z", [{ /* no id */ status: "pass" }]),
    mkRun("2026-04-25T07:00:00Z", [{ id: "db_connectivity", status: "pass" }]),
  ];
  const out = buildPerCheckHistory(runs);
  suite.expectEqual(Object.keys(out).length, 1, "only one valid check id surfaces");
  suite.expectEqual((out["db_connectivity"] || []).length, 1, "one entry recorded");
});

await suite.test("normalizes unknown statuses to 'skipped'", async () => {
  const runs: PulseRun[] = [
    mkRun("2026-04-25T10:00:00Z", [{ id: "x", status: "bogus" as any }]),
    mkRun("2026-04-25T09:00:00Z", [{ id: "x", status: undefined as any }]),
    mkRun("2026-04-25T08:00:00Z", [{ id: "x", status: "pass" }]),
  ];
  const out = buildPerCheckHistory(runs);
  const series = out["x"] || [];
  suite.expectEqual(series[0].status, "pass", "valid pass preserved");
  suite.expectEqual(series[1].status, "skipped", "undefined → skipped");
  suite.expectEqual(series[2].status, "skipped", "bogus → skipped");
});

await suite.test("groups multiple checks per run into separate series", async () => {
  const runs: PulseRun[] = [
    mkRun("2026-04-25T10:00:00Z", [
      { id: "a", status: "pass" },
      { id: "b", status: "fail" },
    ]),
    mkRun("2026-04-25T09:00:00Z", [
      { id: "a", status: "warn" },
      { id: "b", status: "pass" },
    ]),
  ];
  const out = buildPerCheckHistory(runs);
  suite.expectEqual((out["a"] || []).length, 2, "a has two entries");
  suite.expectEqual((out["b"] || []).length, 2, "b has two entries");
  suite.expectEqual(out["a"][0].status, "warn", "a oldest");
  suite.expectEqual(out["a"][1].status, "pass", "a newest");
});

suite.finishOrExit();
