import { describe, it, expect } from "vitest";
import { renderBUReportEmailHtml } from "../../src/utils/qualityReportsEmail";

const baseReport = {
  bu: { bu_name: "Sales (B2B)", channel: "B2B", segment: "ExampleOrg", head_email: "user@example.invalid" },
  sections: {
    sops: { policies: [{}, {}], total: 2 },
    kpis: { done: 3, total: 5, pct: 60 },
    cleanup: { deals: { modules: { Deals: { verified_merges: 4 }, Accounts: { verified_merges: 1 } } } },
    compliance: { stageAging: { summary: { total_violations: 7 } }, dealCompliance: { checked: 0, compliant: 0, compliant_rate: null } },
    actions: { openCapas: 2 },
  },
  notConfigured: [],
};

describe("renderBUReportEmailHtml", () => {
  it("builds a dated subject with the BU name", () => {
    const out = renderBUReportEmailHtml(baseReport, "2026-08-06");
    expect(out.subject).toBe("Quality Report — Sales (B2B) — 2026-08-06");
    expect(out.html).toContain("Sales (B2B)");
    expect(out.html).toContain("60%");
  });
  it("shows 'no deals checked yet' when deal-docs checked=0, never 0%", () => {
    const out = renderBUReportEmailHtml(baseReport, "2026-08-06");
    expect(out.html).toContain("no deals checked yet");
  });
  it("renders 'Not configured yet' for sections in notConfigured", () => {
    const r = { ...baseReport, sections: { ...baseReport.sections, sops: null }, notConfigured: ["sops"] };
    const out = renderBUReportEmailHtml(r, "2026-08-06");
    expect(out.html).toContain("Not configured yet");
  });
  it("escapes dynamic text", () => {
    const r = { ...baseReport, bu: { ...baseReport.bu, bu_name: "A<b>&C" } };
    const out = renderBUReportEmailHtml(r, "2026-08-06");
    expect(out.html).toContain("A&lt;b&gt;&amp;C");
    expect(out.html).not.toContain("A<b>&C");
  });
});
