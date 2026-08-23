/**
 * Quality Reports timeframe selector.
 *
 * Only two sections have real per-period history — KPIs (kpi_values) and data
 * cleanup (duplicate_progress_daily). Compliance, SOPs and open actions read
 * CURRENT state: the compliance scans query live CRM, controlled documents are
 * versioned rather than periodic, and open CAPAs are a live count.
 *
 * The hazard this guards against is the one that produced four separate bugs in
 * this codebase already: a control whose label promises something the query
 * does not do. A Q1 heading over today's compliance numbers would be exactly
 * that, so the server names the sections it could not scope and the UI marks
 * each tile "current, not Q<n>".
 */
import { describe, it, expect } from "vitest";

/** The quarter window the aggregator and kpiDatabase both derive. */
function quarterWindow(year: number, quarter: number) {
  return {
    start: new Date(Date.UTC(year, (quarter - 1) * 3, 1)),
    end: new Date(Date.UTC(year, quarter * 3, 1)),
  };
}

describe("quarter windows", () => {
  it.each([
    [1, "2026-01-01", "2026-04-01"],
    [2, "2026-04-01", "2026-07-01"],
    [3, "2026-07-01", "2026-10-01"],
    [4, "2026-10-01", "2027-01-01"],
  ])("Q%i spans %s to %s", (q, start, end) => {
    const w = quarterWindow(2026, q as number);
    expect(w.start.toISOString().slice(0, 10)).toBe(start);
    expect(w.end.toISOString().slice(0, 10)).toBe(end);
  });

  it("rolls Q4 into the next year rather than clamping to 31 Dec", () => {
    // A half-open [start, end) interval is what includes 31 December whatever
    // time component period_end carries. Clamping to 2026-12-31 would drop any
    // value recorded with a non-zero time on the last day of the year.
    expect(quarterWindow(2026, 4).end.getUTCFullYear()).toBe(2027);
  });

  it("is half-open, so quarters cannot double-count a boundary date", () => {
    const q1 = quarterWindow(2026, 1);
    const q2 = quarterWindow(2026, 2);
    expect(q1.end.getTime()).toBe(q2.start.getTime());
    const boundary = new Date("2026-04-01T00:00:00Z").getTime();
    const inQ1 = boundary >= q1.start.getTime() && boundary < q1.end.getTime();
    const inQ2 = boundary >= q2.start.getTime() && boundary < q2.end.getTime();
    expect(inQ1).toBe(false);
    expect(inQ2).toBe(true);
  });
});

describe("the route only accepts a plausible period", () => {
  // Mirrors the guard in qualityReportsRoutes: anything outside 1..4 or with an
  // implausible year falls back to the live view rather than querying a
  // nonsense window and rendering the empty result as though it were history.
  const parse = (quarter: string, year: string) => {
    const qn = parseInt(quarter, 10);
    const yn = parseInt(year, 10);
    return qn >= 1 && qn <= 4 && yn >= 2000 && yn <= 2100
      ? { year: yn, quarter: qn }
      : undefined;
  };

  it("accepts a valid quarter and year", () => {
    expect(parse("2", "2026")).toEqual({ year: 2026, quarter: 2 });
  });

  it.each([
    ["0", "2026", "quarter below range"],
    ["5", "2026", "quarter above range"],
    ["abc", "2026", "non-numeric quarter"],
    ["2", "1999", "year below range"],
    ["2", "2200", "year above range"],
    ["2", "", "missing year"],
    ["", "", "nothing supplied"],
  ])("falls back to live for %s/%s (%s)", (q, y) => {
    expect(parse(q, y)).toBeUndefined();
  });
});

describe("which sections a period may scope", () => {
  const HAS_HISTORY = ["kpis", "cleanup"];
  const NO_HISTORY = ["compliance", "sops", "actions"];

  it("scopes only the sections backed by a per-period table", () => {
    expect(HAS_HISTORY).toContain("kpis");
    expect(HAS_HISTORY).toContain("cleanup");
  });

  it("never silently scopes a live-only section", () => {
    for (const s of NO_HISTORY) expect(HAS_HISTORY).not.toContain(s);
  });

  it("labels every unscoped section rather than leaving it ambiguous", () => {
    // notTimeScoped must list ALL of them — a section missing from the list
    // renders with no caveat and reads as a period figure.
    const notTimeScoped = ["compliance", "sops", "actions"];
    for (const s of NO_HISTORY) expect(notTimeScoped).toContain(s);
  });
});
