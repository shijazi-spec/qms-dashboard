/**
 * The daily KPI job must sync Zoho Tasks BEFORE it runs the KPI engine.
 *
 * WHY THIS IS A TEST AND NOT JUST A COMMENT: SDR-KPI-11, SALES-KPI-07 and
 * SALES-KPI-08 read the local `zoho_tasks` mirror. If the engine runs first,
 * all three are scored against YESTERDAY's tasks and every value silently
 * trails the data by a day — nothing errors, nothing looks broken, the numbers
 * are just quietly wrong. Reordering these two blocks is an easy, innocent-
 * looking edit, so the order is pinned here.
 *
 * Also pins that a Zoho outage during the sync must NOT stop the engine: the
 * task KPIs degrade to "--" on an empty mirror, but everything that does not
 * depend on tasks must still record.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { calls, tasksSync, kpiAutoCalc, kpiQuery } = vi.hoisted(() => ({
  calls: [] as string[],
  tasksSync: vi.fn(),
  kpiAutoCalc: vi.fn(),
  kpiQuery: vi.fn(),
}));

vi.mock("../../src/utils/zohoTasksSync", () => ({
  runZohoTasksSync: (...a: any[]) => {
    calls.push("tasks-sync");
    return tasksSync(...a);
  },
}));
vi.mock("../../src/utils/kpiAutoCalc", () => ({
  runKPIAutoCalc: (...a: any[]) => {
    calls.push("kpi-engine");
    return kpiAutoCalc(...a);
  },
}));
vi.mock("../../src/utils/kpiDatabase", () => ({
  pool: { query: (...a: any[]) => kpiQuery(...a) },
  getAllKPIDefinitions: vi.fn(async () => []),
  recordKPIValue: vi.fn(async () => undefined),
}));
vi.mock("../../src/utils/sharedPool", () => ({
  sharedPool: { query: (...a: any[]) => kpiQuery(...a) },
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runKPIAutoCalc } from "../../src/utils/scheduledJobs";

const OK_SYNC = {
  scanned: 10, imported_new: 10, updated_existing: 0, skipped_no_linkage: 0,
  errors: 0, error_samples: [] as string[], duration_ms: 5, since: "x",
  linkage: { who: 4, what: 6, both: 0, none: 0 },
};

beforeEach(() => {
  calls.length = 0;
  kpiQuery.mockReset().mockResolvedValue({ rows: [] });
  tasksSync.mockReset().mockResolvedValue(OK_SYNC);
  kpiAutoCalc.mockReset().mockResolvedValue({ recorded: 0, skipped: 0, details: [] });
});

describe("daily KPI job — Zoho tasks sync ordering", () => {
  it("syncs tasks BEFORE running the KPI engine", async () => {
    await runKPIAutoCalc();
    expect(calls).toContain("tasks-sync");
    expect(calls).toContain("kpi-engine");
    // The whole point: sync first, or the task KPIs trail by a day.
    expect(calls.indexOf("tasks-sync")).toBeLessThan(calls.indexOf("kpi-engine"));
  });

  it("still runs the KPI engine when the tasks sync throws", async () => {
    tasksSync.mockRejectedValue(new Error("Zoho unreachable"));
    await runKPIAutoCalc();
    // A Zoho outage must not cost us every non-task KPI for the day.
    expect(calls).toContain("kpi-engine");
  });

  it("still runs the KPI engine when the sync reports errors", async () => {
    tasksSync.mockResolvedValue({ ...OK_SYNC, errors: 1, error_samples: ["boom"] });
    await runKPIAutoCalc();
    expect(calls).toContain("kpi-engine");
  });

  it("passes a bounded maxRecords so the daily job cannot run away", async () => {
    await runKPIAutoCalc();
    const arg = tasksSync.mock.calls[0]?.[0] ?? {};
    expect(typeof arg.maxRecords).toBe("number");
    expect(arg.maxRecords).toBeGreaterThan(0);
  });
});
