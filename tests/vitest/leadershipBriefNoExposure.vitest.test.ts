/**
 * The weekly leadership brief must not publish the SAR exposure figure.
 *
 * Standing rule (Sarah 2026-08-23): nothing goes to leadership except the
 * agreed KPIs — QM-KPI-002, QM-KPI-008, QM-KPI-015, GRC-KPI-008 — plus the
 * duplicate rate against its 2% target. Amount at risk is internal only.
 *
 * It is also unfit to publish: estimatedPipelineInflation read 172,480 then
 * 479,480 then 90,640 then 397,640 inside one day, because it is gated on
 * clusters holding more than one deal and currently rests on 1-2 deals.
 *
 * This reads the SOURCE rather than calling the builder, which needs a live
 * database (aggregate summary, KPI snapshot, module breakdown, grades and the
 * previous week's snapshot). The check is therefore structural: the brief
 * template must not interpolate the exposure value, and the dead helpers that
 * used to format it must stay gone so the line cannot be restored by reflex.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/utils/duplicateResolutionRunner.ts"),
  "utf8",
);

/** The brief template literal assigned to `const brief = ...`. */
function briefTemplate(): string {
  const start = SRC.indexOf("const brief =");
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf("return {", start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("the published brief carries no exposure figure", () => {
  it("never interpolates the exposure value", () => {
    expect(briefTemplate()).not.toContain("${exposure}");
  });

  it("has no SAR-formatted output at all", () => {
    // sar() was the only formatter; its removal is what makes this provable.
    const t = briefTemplate();
    expect(t).not.toContain("sar(");
    expect(t).not.toContain("SAR ");
  });

  it("does not mention financial exposure", () => {
    expect(briefTemplate().toLowerCase()).not.toContain("financial exposure");
  });

  it("keeps the sar() helper deleted", () => {
    // If someone reintroduces the helper, the line it formatted is one edit
    // away from returning.
    expect(SRC).not.toContain("const sar = (n: number)");
  });

  it("computes no week-over-week exposure delta", () => {
    // The delta was the worse half: it turned re-clustering noise into an
    // apparent trend.
    expect(SRC).not.toContain("dExposure");
  });
});

describe("what the brief must still report", () => {
  it("keeps the duplicate rate against its 2% target", () => {
    // An agreed KPI — removing exposure must not strip the legitimate content.
    expect(briefTemplate()).toContain("Duplicate rate");
  });

  it("keeps cluster counts and cleared progress", () => {
    const t = briefTemplate();
    expect(t).toContain("totalClusters");
    expect(t).toContain("clearedPct");
  });
});

describe("history is preserved", () => {
  it("still computes exposure for the snapshot table", () => {
    // Not publishing it is the rule; discarding it would break the
    // exec_brief_snapshots series and the week-over-week baseline.
    expect(SRC).toContain("estimatedPipelineInflation");
    expect(SRC).toMatch(/metrics:\s*\{[^}]*exposure/);
  });
});
