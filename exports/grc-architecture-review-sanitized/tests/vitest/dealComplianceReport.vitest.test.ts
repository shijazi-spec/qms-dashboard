import { describe, it, expect } from "vitest";
import { shapeDealCompliance } from "../../src/utils/dealComplianceReport";

const rows = [
  { stage: "Agreement Signed", compliant: false, amount: 100, owner: "Sample User", missing_docs: [{ key: "vat", label: "VAT Certificate" }, { key: "cr", label: "Commercial Registration (CR)" }] },
  { stage: "Agreement Signed", compliant: true, amount: 50, owner: "Sample User", missing_docs: [] },
  { stage: "Proposal", compliant: false, amount: 200, owner: "", missing_docs: [{ key: "financial_offer", label: "Financial offer / proposal" }] },
  { stage: "Agreement Signed", compliant: false, amount: 300, owner: "Sample User", missing_docs: [{ key: "vat", label: "VAT Certificate" }] },
];

describe("shapeDealCompliance", () => {
  it("aggregates totals, at-risk, stage/owner, and top missing docs", () => {
    const out = shapeDealCompliance("ExampleOrg", rows);
    expect(out.checked).toBe(4);
    expect(out.compliant).toBe(1);
    expect(out.compliant_rate).toBe(25);
    expect(out.at_risk_sar).toBe(600); // 100 + 200 + 300 (non-compliant only)
    // by_stage sorted by missing desc: Agreement Signed (2 missing) before Proposal (1)
    expect(out.by_stage[0].stage).toBe("Agreement Signed");
    expect(out.by_stage[0].missing).toBe(2);
    // owner "" falls back to Unassigned
    expect(out.by_owner.some((o) => o.owner === "Unassigned")).toBe(true);
    // top missing: VAT appears twice → first
    expect(out.top_missing_docs[0]).toEqual({ label: "VAT Certificate", count: 2 });
  });
  it("compliant_rate is null when nothing checked", () => {
    const out = shapeDealCompliance("Example Organization", []);
    expect(out.checked).toBe(0);
    expect(out.compliant_rate).toBeNull();
    expect(out.at_risk_sar).toBe(0);
  });
  it("caps by_owner at 10 and reports overflow", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ stage: "Agreement Signed", compliant: false, amount: 10, owner: "owner" + i, missing_docs: [{ key: "vat", label: "VAT Certificate" }] }));
    const out = shapeDealCompliance("ExampleOrg", many);
    expect(out.by_owner.length).toBe(10);
    expect(out.owner_overflow).toBe(3);
  });
  it("aggregates missing_docs stored as plain label strings (real DB format)", () => {
    const stringRows = [
      { stage: "Agreement Signed", compliant: false, amount: 10, owner: "Sample User", missing_docs: ["VAT Certificate", "VAT Certificate"] },
    ];
    const out = shapeDealCompliance("ExampleOrg", stringRows);
    expect(out.top_missing_docs[0]).toEqual({ label: "VAT Certificate", count: 2 });
  });
});
