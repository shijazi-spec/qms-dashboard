/**
 * The BU Coverage tracker must stay reachable while it holds data.
 *
 * kpis.html rendered "🏢 Manage BU Coverage" only when
 * calc_mode === 'bu_coverage'. On 2026-09-11 QM-KPI-008 went back to being a
 * checklist KPI, which left NO KPI carrying that mode — so the button vanished
 * from every card while the kpi_bu_coverage rows stayed in the database. A
 * tracker with data and no way in, and nothing failed to say so.
 *
 * calc_mode describes how a KPI is CALCULATED. It must never be the thing that
 * decides whether existing data can be opened.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Comments below quote the old condition on purpose; scan code only. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const PAGE = read("dashboard/kpis.html");
const ROUTES = strip(read("src/mastra/routes/kpiRoutes.ts"));
const DB = strip(read("src/utils/kpiBuCoverageDatabase.ts"));

describe("the Manage BU Coverage button is data-driven", () => {
  it("renders when the KPI has tracker rows, not only on calc_mode", () => {
    const line = PAGE.split("\n").find((l) =>
      l.includes('data-on-click="openBuCoverageModal"'),
    );
    expect(line, "the BU Coverage button is gone entirely").toBeTruthy();
    expect(line!).toContain("bu_coverage_rows");
  });

  it("still renders for a genuine bu_coverage KPI", () => {
    // Both halves matter: a KPI configured for the tracker should offer it even
    // before anyone has entered a single row.
    const line = PAGE.split("\n").find((l) =>
      l.includes('data-on-click="openBuCoverageModal"'),
    )!;
    expect(line).toContain("calc_mode === 'bu_coverage'");
  });
});

describe("the count reaches the page", () => {
  it("/api/kpis attaches bu_coverage_rows to every KPI", () => {
    expect(ROUTES).toContain("bu_coverage_rows:");
    expect(ROUTES).toContain("buCoverageRowCounts");
  });

  it("counts in ONE grouped query, not one per KPI", () => {
    // /api/kpis already runs a per-KPI Promise.all; a lookup inside it would
    // add a second N+1 to a list that is slow enough to have needed fixing
    // before. The GROUP BY is the point.
    expect(DB).toMatch(/SELECT kpi_id, COUNT\(\*\)[\s\S]*?GROUP BY kpi_id/);
    const i = ROUTES.indexOf("buCoverageRowCounts");
    const j = ROUTES.indexOf("kpis = await Promise.all");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(-1);
    expect(i, "the count query must run BEFORE the per-KPI map").toBeLessThan(j);
  });

  it("degrades to an empty map rather than failing the KPI list", () => {
    // A missing table must hide the button, never break /api/kpis.
    const fn = DB.slice(
      DB.indexOf("export async function buCoverageRowCounts"),
      DB.indexOf("export async function getBuCoverage"),
    );
    expect(fn).toContain("catch");
    expect(fn).toContain("return out");
  });
});
