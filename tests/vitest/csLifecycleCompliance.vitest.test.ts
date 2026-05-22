/**
 * Unit tests for the CS Lifecycle Compliance detector.
 *
 * Run: npx vitest run tests/vitest/csLifecycleCompliance.vitest.test.ts
 *
 * Pure logic only — does not touch the database. The detection rules
 * mirror the CS team SLAs:
 *
 *   - Onboarding phase ≤ 30 calendar days
 *   - Phase auto-moves to Termination when Churn Date is set
 *   - Termination phase requires Churn Date
 *   - One working day per phase-to-phase transition (steady-state phases
 *     Adoption / Renewal are exempt)
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  evaluateCsLifecycle,
  resetCsLifecycleConfigCache,
  summarizeViolations,
} from "../../src/utils/csLifecycleCompliance";

afterEach(() => {
  resetCsLifecycleConfigCache();
  delete process.env.CS_LIFECYCLE_ONBOARDING_MAX_DAYS;
  delete process.env.CS_LIFECYCLE_STALLED_TRANSITION_DAYS;
  delete process.env.CS_LIFECYCLE_ADOPTION_MIN_CUSTOMER_AGE_DAYS;
});

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

describe("evaluateCsLifecycle — non-CS deals are skipped", () => {
  test("record without Phase field returns is_cs_deal=false", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Stage: "Closed Won" },
      modified_date: new Date(),
    });
    expect(result.is_cs_deal).toBe(false);
    expect(result.violations).toEqual([]);
  });

  test("null raw_data returns is_cs_deal=false", () => {
    const result = evaluateCsLifecycle({
      raw_data: null,
      modified_date: new Date(),
    });
    expect(result.is_cs_deal).toBe(false);
  });
});

describe("onboarding_overdue", () => {
  test("fires when Onboarding > 30 days", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Phase: "Onboarding" },
      modified_date: daysAgo(45),
    });
    expect(result.violations.map((v) => v.code)).toContain(
      "onboarding_overdue",
    );
    const v = result.violations.find((x) => x.code === "onboarding_overdue")!;
    expect(v.severity).toBe("warning");
    expect(v.days_in_phase).toBe(45);
  });

  test("does NOT fire when Onboarding ≤ 30 days", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Phase: "Onboarding" },
      modified_date: daysAgo(15),
    });
    expect(result.violations.map((v) => v.code)).not.toContain(
      "onboarding_overdue",
    );
  });

  test("threshold configurable via env", () => {
    process.env.CS_LIFECYCLE_ONBOARDING_MAX_DAYS = "10";
    resetCsLifecycleConfigCache();
    const result = evaluateCsLifecycle({
      raw_data: { Phase: "Onboarding" },
      modified_date: daysAgo(15),
    });
    expect(result.violations.map((v) => v.code)).toContain(
      "onboarding_overdue",
    );
  });
});

describe("phase_churn_desync (critical)", () => {
  test("fires when Churn Date set but Phase is Adoption", () => {
    const result = evaluateCsLifecycle({
      raw_data: {
        Phase: "Adoption",
        Churn_Date: "2026-04-01",
      },
      modified_date: daysAgo(2),
    });
    expect(result.violations.map((v) => v.code)).toContain(
      "phase_churn_desync",
    );
    const v = result.violations.find((x) => x.code === "phase_churn_desync")!;
    expect(v.severity).toBe("critical");
  });

  test("does NOT fire when Churn Date set AND Phase is Termination", () => {
    const result = evaluateCsLifecycle({
      raw_data: {
        Phase: "Termination",
        Churn_Date: "2026-04-01",
      },
      modified_date: daysAgo(2),
    });
    expect(result.violations.map((v) => v.code)).not.toContain(
      "phase_churn_desync",
    );
  });

  test("does NOT fire when Phase is Onboarding and Churn Date null", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Phase: "Onboarding" },
      modified_date: daysAgo(5),
    });
    expect(result.violations.map((v) => v.code)).not.toContain(
      "phase_churn_desync",
    );
  });

  test("does NOT fire when Renewal Date is AFTER Churn Date (re-engaged)", () => {
    // Customer churned but came back — Renewal Date set after Churn Date.
    // Phase legitimately moved back to Adoption; the stale Churn Date is
    // historical, not a desync.
    const result = evaluateCsLifecycle({
      raw_data: {
        Phase: "Adoption",
        Churn_Date: "2026-03-15",
        Renewal_Date: "2026-03-16",
      },
      modified_date: daysAgo(2),
    });
    expect(result.violations.map((v) => v.code)).not.toContain(
      "phase_churn_desync",
    );
  });

  test("STILL fires when Renewal Date is BEFORE Churn Date", () => {
    // Renewal is historical, Churn is the more-recent event — genuine desync.
    const result = evaluateCsLifecycle({
      raw_data: {
        Phase: "Adoption",
        Churn_Date: "2026-04-01",
        Renewal_Date: "2026-03-01",
      },
      modified_date: daysAgo(2),
    });
    expect(result.violations.map((v) => v.code)).toContain(
      "phase_churn_desync",
    );
  });
});

describe("termination_missing_churn_date", () => {
  test("fires when Phase is Termination but no Churn Date", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Phase: "Termination" },
      modified_date: daysAgo(10),
    });
    expect(result.violations.map((v) => v.code)).toContain(
      "termination_missing_churn_date",
    );
  });

  test("does NOT fire when Churn Date present", () => {
    const result = evaluateCsLifecycle({
      raw_data: {
        Phase: "Termination",
        Churn_Date: "2026-05-01",
      },
      modified_date: daysAgo(10),
    });
    expect(result.violations.map((v) => v.code)).not.toContain(
      "termination_missing_churn_date",
    );
  });
});

describe("phase_transition_stalled (info)", () => {
  test("Adoption is steady-state — does not fire even at 60 days", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Phase: "Adoption" },
      modified_date: daysAgo(60),
    });
    expect(result.violations.map((v) => v.code)).not.toContain(
      "phase_transition_stalled",
    );
  });

  test("Renewal is steady-state — does not fire", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Phase: "Renewal" },
      modified_date: daysAgo(30),
    });
    expect(result.violations.map((v) => v.code)).not.toContain(
      "phase_transition_stalled",
    );
  });

  test("Onboarding is bounded by onboarding_overdue, not stalled", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Phase: "Onboarding" },
      modified_date: daysAgo(15),
    });
    expect(result.violations.map((v) => v.code)).not.toContain(
      "phase_transition_stalled",
    );
  });

  test("Termination is terminal — does not fire", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Phase: "Termination", Churn_Date: "2025-12-01" },
      modified_date: daysAgo(120),
    });
    expect(result.violations.map((v) => v.code)).not.toContain(
      "phase_transition_stalled",
    );
  });
});

describe("adoption_premature", () => {
  test("fires when Customer_Since is recent (< 30 days)", () => {
    const result = evaluateCsLifecycle({
      raw_data: {
        Phase: "Adoption",
        Customer_Since: daysAgo(5).toISOString().slice(0, 10),
      },
      modified_date: daysAgo(2),
    });
    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain("adoption_premature");
    const v = result.violations.find((x) => x.code === "adoption_premature")!;
    expect(v.severity).toBe("warning");
  });

  test("fires when Trial_End_Date is in the future", () => {
    const tomorrow = new Date(Date.now() + 5 * 86400 * 1000);
    const result = evaluateCsLifecycle({
      raw_data: {
        Phase: "Adoption",
        Customer_Since: daysAgo(180).toISOString().slice(0, 10),
        Trial_End_Date: tomorrow.toISOString().slice(0, 10),
      },
      modified_date: daysAgo(1),
    });
    expect(result.violations.map((v) => v.code)).toContain(
      "adoption_premature",
    );
  });

  test("does NOT fire when Customer_Since is old AND no future trial", () => {
    const result = evaluateCsLifecycle({
      raw_data: {
        Phase: "Adoption",
        Customer_Since: daysAgo(180).toISOString().slice(0, 10),
      },
      modified_date: daysAgo(1),
    });
    expect(result.violations.map((v) => v.code)).not.toContain(
      "adoption_premature",
    );
  });

  test("does NOT fire when no Customer_Since AND no Trial_End present", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Phase: "Adoption" },
      modified_date: daysAgo(1),
    });
    expect(result.violations.map((v) => v.code)).not.toContain(
      "adoption_premature",
    );
  });

  test("does NOT fire for non-Adoption phases", () => {
    const result = evaluateCsLifecycle({
      raw_data: {
        Phase: "Onboarding",
        Customer_Since: daysAgo(5).toISOString().slice(0, 10),
      },
      modified_date: daysAgo(1),
    });
    expect(result.violations.map((v) => v.code)).not.toContain(
      "adoption_premature",
    );
  });

  test("threshold configurable via env", () => {
    process.env.CS_LIFECYCLE_ADOPTION_MIN_CUSTOMER_AGE_DAYS = "90";
    resetCsLifecycleConfigCache();
    const result = evaluateCsLifecycle({
      raw_data: {
        Phase: "Adoption",
        Customer_Since: daysAgo(60).toISOString().slice(0, 10),
      },
      modified_date: daysAgo(1),
    });
    expect(result.violations.map((v) => v.code)).toContain(
      "adoption_premature",
    );
  });
});

describe("missing_company_domain", () => {
  test("fires for Onboarding when Company_Domain is empty", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Phase: "Onboarding" },
      modified_date: daysAgo(5),
    });
    expect(result.violations.map((v) => v.code)).toContain(
      "missing_company_domain",
    );
    const v = result.violations.find((x) => x.code === "missing_company_domain")!;
    expect(v.severity).toBe("warning");
  });

  test("fires for Adoption when Company_Domain is empty", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Phase: "Adoption" },
      modified_date: daysAgo(60),
    });
    expect(result.violations.map((v) => v.code)).toContain(
      "missing_company_domain",
    );
  });

  test("fires for Renewal when Company_Domain is empty", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Phase: "Renewal" },
      modified_date: daysAgo(10),
    });
    expect(result.violations.map((v) => v.code)).toContain(
      "missing_company_domain",
    );
  });

  test("does NOT fire when Company_Domain is populated", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Phase: "Onboarding", Company_Domain: "alsahab.sa" },
      modified_date: daysAgo(5),
    });
    expect(result.violations.map((v) => v.code)).not.toContain(
      "missing_company_domain",
    );
  });

  test("does NOT fire for Termination phase (out of scope per ops decision)", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Phase: "Termination" },
      modified_date: daysAgo(5),
    });
    expect(result.violations.map((v) => v.code)).not.toContain(
      "missing_company_domain",
    );
  });

  test("does NOT fire for non-CS deals (no Phase field)", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Stage: "Closed Won" },
      modified_date: daysAgo(5),
    });
    expect(result.violations.map((v) => v.code)).not.toContain(
      "missing_company_domain",
    );
  });

  test("tolerates camelCase field variation 'CompanyDomain'", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Phase: "Adoption", CompanyDomain: "example.com" },
      modified_date: daysAgo(2),
    });
    expect(result.violations.map((v) => v.code)).not.toContain(
      "missing_company_domain",
    );
  });

  test("whitespace-only Company_Domain still triggers the rule", () => {
    const result = evaluateCsLifecycle({
      raw_data: { Phase: "Onboarding", Company_Domain: "   " },
      modified_date: daysAgo(3),
    });
    expect(result.violations.map((v) => v.code)).toContain(
      "missing_company_domain",
    );
  });
});

describe("summarizeViolations", () => {
  test("rolls up severity + code counts correctly", () => {
    const evals = [
      evaluateCsLifecycle({
        raw_data: { Phase: "Onboarding" },
        modified_date: daysAgo(45),
      }),
      evaluateCsLifecycle({
        raw_data: { Phase: "Adoption", Churn_Date: "2026-04-01" },
        modified_date: daysAgo(2),
      }),
      evaluateCsLifecycle({
        raw_data: { Phase: "Termination" },
        modified_date: daysAgo(10),
      }),
      evaluateCsLifecycle({
        raw_data: { Phase: "Adoption" },
        modified_date: daysAgo(2),
      }), // no violations
      evaluateCsLifecycle({
        raw_data: { Stage: "Closed Won" }, // not a CS deal
        modified_date: daysAgo(1),
      }),
    ];
    const s = summarizeViolations(evals);
    expect(s.total_evaluated).toBe(5);
    expect(s.total_cs_deals).toBe(4); // last one isn't a CS deal
    expect(s.by_severity.critical).toBe(1); // phase_churn_desync
    expect(s.by_severity.warning).toBeGreaterThanOrEqual(2); // onboarding_overdue + termination_missing_churn_date
    expect(s.by_code.phase_churn_desync).toBe(1);
    expect(s.by_code.onboarding_overdue).toBe(1);
    expect(s.by_code.termination_missing_churn_date).toBe(1);
  });
});
