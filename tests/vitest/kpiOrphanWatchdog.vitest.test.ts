/**
 * The watchdog has to look for orphan auto-values BEFORE it decides the KPIs
 * are healthy and returns.
 *
 * This is the whole trap in one line of control flow. An orphan only ever
 * appears while visibility is FINE — the KPI is present, active, and showing a
 * number. CS-KPI-21 passed every existing check for three weeks while
 * displaying a red 61% that nothing had maintained since the day a
 * since-deleted calculator wrote it. Put the orphan check after the
 * `if (!broken.length) return` and it runs only when something else is already
 * wrong, which is exactly when there is nothing to find.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(
  join(__dirname, "../../src/utils/scheduledJobs.ts"),
  "utf8",
);
const BODY = /export async function runKpiVisibilityWatchdog[\s\S]*?\n\}/.exec(
  SRC,
)![0];

describe("runKpiVisibilityWatchdog", () => {
  it("checks for orphan values", () => {
    expect(BODY).toContain("findOrphanAutoValues");
  });

  it("checks BEFORE the healthy early-return", () => {
    const orphanIdx = BODY.indexOf("findOrphanAutoValues");
    const earlyReturn = BODY.indexOf("if (!broken.length)");
    expect(orphanIdx).toBeGreaterThan(-1);
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(orphanIdx).toBeLessThan(earlyReturn);
  });

  it("reports the count on the healthy path too", () => {
    // Otherwise a tick that found orphans and nothing else looks identical to
    // a clean one.
    const healthy = BODY.slice(BODY.indexOf("if (!broken.length)"));
    expect(healthy.slice(0, 200)).toContain("orphanCount");
  });

  it("names the KPI and the figure in the log line", () => {
    // "3 orphans found" sends someone digging. "CS-KPI-21=61" is actionable.
    expect(BODY).toContain("o.kpi_code");
    expect(BODY).toContain("o.actual_value");
  });

  it("never lets the orphan check break the visibility repair", () => {
    // The repair is the more important of the two jobs, and it now runs
    // AFTER the orphan query. So the orphan query needs its own catch: an
    // unhandled failure there would take down the repair that exists because
    // 33 CS KPIs once vanished for days.
    const between = BODY.slice(
      BODY.indexOf("findOrphanAutoValues"),
      BODY.indexOf("verifySeededKpiVisibility()"),
    );
    expect(between).toContain("catch");
  });
});
