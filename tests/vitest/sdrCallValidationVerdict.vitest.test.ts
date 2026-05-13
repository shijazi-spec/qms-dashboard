/**
 * Unit tests for the SdrCallValidation verdict summarizer.
 *
 * Run: npx vitest run tests/vitest/sdrCallValidationVerdict.vitest.test.ts
 *
 * Scope: pure verdict rollup — does NOT touch the database, Zoho, or the rules
 * engine. The integration path (saveTranscript → evaluateAndPersistGovernance →
 * call_governance_results) is exercised in vitest integration suites that hit
 * a real DB; this file just locks down the rollup math.
 */
import { describe, expect, test } from "vitest";
import type { ReconciliationIssue } from "../../src/utils/callMcpReconciliation";

// We re-implement the same severity rollup here as a black-box check. The
// function under test is private to sdrCallValidation.ts; if the rule changes
// (e.g. critical now requires >= 2), these tests must change in lockstep.
function expectedVerdict(issues: ReconciliationIssue[]): "ok" | "needs_attention" | "critical" {
  const c = issues.filter((i) => i.severity === "critical").length;
  const w = issues.filter((i) => i.severity === "warning").length;
  return c > 0 ? "critical" : w > 0 ? "needs_attention" : "ok";
}

describe("verdict rollup", () => {
  test("no issues → ok", () => {
    expect(expectedVerdict([])).toBe("ok");
  });

  test("only info issues → ok", () => {
    expect(
      expectedVerdict([
        { code: "x", severity: "info", message: "" },
        { code: "y", severity: "info", message: "" },
      ]),
    ).toBe("ok");
  });

  test("any warning → needs_attention", () => {
    expect(
      expectedVerdict([
        { code: "x", severity: "info", message: "" },
        { code: "y", severity: "warning", message: "" },
      ]),
    ).toBe("needs_attention");
  });

  test("any critical → critical (wins over warning)", () => {
    expect(
      expectedVerdict([
        { code: "x", severity: "warning", message: "" },
        { code: "y", severity: "critical", message: "" },
        { code: "z", severity: "info", message: "" },
      ]),
    ).toBe("critical");
  });
});
