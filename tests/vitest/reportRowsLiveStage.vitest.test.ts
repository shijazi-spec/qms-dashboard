/**
 * The report says what stage a deal is in NOW, not what it was in when we
 * last looked at it.
 *
 * Caught 2026-09-12, hours before this report was due in front of the Head of
 * Sales. The generated email said "Proposal: 453 deals". A direct re-check of
 * the same population said 301, and Zoho's own Kanban for WalaPlus + Standard
 * (Corporates) said 300. The row query preferred `deal_doc_compliance.stage` —
 * the snapshot written when a deal was last checked — over the live mirror, so
 * every deal checked at Proposal and since moved to Closed Lost, On Hold or
 * Agreement Signed was still being counted as Proposal. 152 deals reported to
 * a Head of Sales under a stage they had left.
 *
 * The distinction that matters: the compliance VERDICT is rightly the stored
 * one — it is a fact about the evidence we saw. The STAGE is a fact about the
 * deal today. Mixing the two puts a current-stage heading over a historical
 * population, which is the same failure as SPEC-KPI-02 and QM-KPI-008.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(
  join(__dirname, "../../src/utils/duplicateRadarDatabase.ts"),
  "utf8",
);

/** The stage expression inside getDealComplianceReportRows. */
function stageExpr(): string {
  const fn = /export async function getDealComplianceReportRows[\s\S]*?\n\}/.exec(SRC);
  expect(fn, "getDealComplianceReportRows not found — did it move?").toBeTruthy();
  const m = /COALESCE\([^)]*?AS stage/s.exec(fn![0]);
  expect(m, "no stage expression found in the row query").toBeTruthy();
  return m![0];
}

describe("getDealComplianceReportRows", () => {
  it("reads the stage from the live mirror, not the compliance snapshot", () => {
    const e = stageExpr();
    const live = e.indexOf("r.stage");
    const stored = e.indexOf("d.stage");
    expect(live).toBeGreaterThan(-1);
    expect(stored).toBeGreaterThan(-1);
    expect(live, "r.stage must be preferred over d.stage").toBeLessThan(stored);
  });

  it("falls back to raw_data before the snapshot", () => {
    // Same fallback chain the rest of the radar uses: column, then the synced
    // Zoho payload, and only then what we recorded at check time.
    const e = stageExpr();
    expect(e).toContain("r.raw_data->>'Stage'");
    expect(e.indexOf("raw_data->>'Stage'")).toBeLessThan(e.indexOf("d.stage"));
  });

  it("still keeps the stored verdict, which IS a fact about when we looked", () => {
    const fn = /export async function getDealComplianceReportRows[\s\S]*?\n\}/.exec(SRC)![0];
    expect(fn).toContain("d.compliant AS compliant");
    expect(fn).toContain("d.missing_docs AS missing_docs");
    expect(fn).toContain("d.checked_at AS checked_at");
  });
});
