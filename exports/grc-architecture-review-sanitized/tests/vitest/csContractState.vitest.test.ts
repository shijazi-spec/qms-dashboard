/**
 * Unit tests for csContractState + the per-deal verdict matrix used by
 * csCommunicationCheck. Pure functions only — no DB.
 *
 * Run: npx vitest run tests/vitest/csContractState.vitest.test.ts
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  assessContractState,
  resetCsContractStateConfigCache,
} from "../../src/utils/csContractState";
import {
  perDealVerdict,
  normalizeQuery,
} from "../../src/utils/csCommunicationCheck";

afterEach(() => {
  resetCsContractStateConfigCache();
  delete process.env.CS_SIGNED_STAGES;
  delete process.env.CS_PAID_FIELDS;
});

describe("assessContractState — signed detection", () => {
  test("Stage = 'Agreement Signed' marks the deal as signed", () => {
    const r = assessContractState({ Stage: "Agreement Signed" });
    expect(r.is_signed).toBe(true);
    expect(r.ever_a_customer).toBe(true);
    expect(r.signed_signals[0]).toMatch(/stage:/i);
    expect(r.stage_value).toBe("Agreement Signed");
  });

  test("Stage = 'Closed Won' is also signed", () => {
    const r = assessContractState({ Stage: "Closed Won" });
    expect(r.is_signed).toBe(true);
  });

  test("Stage = 'Cold' is NOT signed", () => {
    const r = assessContractState({ Stage: "Cold" });
    expect(r.is_signed).toBe(false);
    expect(r.is_paid).toBe(false);
    expect(r.ever_a_customer).toBe(false);
  });

  test("env can extend the signed-stages list", () => {
    process.env.CS_SIGNED_STAGES = "Closed Won,Hot Win";
    resetCsContractStateConfigCache();
    const r = assessContractState({ Stage: "Hot Win" });
    expect(r.is_signed).toBe(true);
  });

  test("Custom Agreement_Signed field also marks as signed", () => {
    const r = assessContractState({
      Stage: "Cold",
      Agreement_Signed: "Yes",
    });
    expect(r.is_signed).toBe(true);
    expect(r.signed_signals.some((s) => s.startsWith("field:"))).toBe(true);
  });
});

describe("assessContractState — paid detection", () => {
  test("Invoiced = 'Yes' marks the deal as paid", () => {
    const r = assessContractState({ Invoiced: "Yes" });
    expect(r.is_paid).toBe(true);
    expect(r.ever_a_customer).toBe(true);
  });

  test("Invoiced = 'No' is not paid", () => {
    const r = assessContractState({ Invoiced: "No" });
    expect(r.is_paid).toBe(false);
  });

  test("Signed AND paid (full customer)", () => {
    const r = assessContractState({
      Stage: "Agreement Signed",
      Invoiced: "Yes",
    });
    expect(r.is_signed).toBe(true);
    expect(r.is_paid).toBe(true);
    expect(r.ever_a_customer).toBe(true);
  });
});

describe("assessContractState — defensive", () => {
  test("null raw_data returns no-customer", () => {
    expect(assessContractState(null).ever_a_customer).toBe(false);
  });
  test("string raw_data returns no-customer", () => {
    expect(assessContractState("not an object" as any).ever_a_customer).toBe(false);
  });
});

describe("perDealVerdict — full matrix", () => {
  const ACTIVE_PHASES = ["Onboarding", "Adoption", "Renewal"];
  const TERMINATION = "Termination";
  const fullCustomer = {
    is_signed: true,
    is_paid: true,
    ever_a_customer: true,
    signed_signals: ["stage:Agreement Signed"],
    paid_signals: ["field:Invoiced=Yes"],
    stage_value: "Agreement Signed",
  };
  const prospectOnly = {
    is_signed: false,
    is_paid: false,
    ever_a_customer: false,
    signed_signals: [],
    paid_signals: [],
    stage_value: "Cold",
  };

  test("signed + no churn → BLOCK", () => {
    const v = perDealVerdict({
      contract: fullCustomer,
      phase: "Adoption",
      churnDays: null,
      cooloffDays: 180,
      activePhases: ACTIVE_PHASES,
      terminationPhase: TERMINATION,
    });
    expect(v.verdict).toBe("block");
    expect(v.reason).toBe("active_signed_customer_no_churn");
  });

  test("signed + churn within cool-off → BLOCK", () => {
    const v = perDealVerdict({
      contract: fullCustomer,
      phase: "Termination",
      churnDays: 60,
      cooloffDays: 180,
      activePhases: ACTIVE_PHASES,
      terminationPhase: TERMINATION,
    });
    expect(v.verdict).toBe("block");
    expect(v.reason).toMatch(/within_cooloff/);
  });

  test("signed + churn past cool-off → ALLOW (the key new behavior)", () => {
    const v = perDealVerdict({
      contract: fullCustomer,
      phase: "Termination",
      churnDays: 220,
      cooloffDays: 180,
      activePhases: ACTIVE_PHASES,
      terminationPhase: TERMINATION,
    });
    expect(v.verdict).toBe("allow");
    expect(v.reason).toMatch(/past_cooloff/);
  });

  test("government sector — 365d cool-off", () => {
    // 200d ago for a gov sector → still inside 365d window → BLOCK
    const v = perDealVerdict({
      contract: fullCustomer,
      phase: "Termination",
      churnDays: 200,
      cooloffDays: 365,
      activePhases: ACTIVE_PHASES,
      terminationPhase: TERMINATION,
    });
    expect(v.verdict).toBe("block");
  });

  test("prospect (never signed) in active phase → REVIEW", () => {
    const v = perDealVerdict({
      contract: prospectOnly,
      phase: "Onboarding",
      churnDays: null,
      cooloffDays: 180,
      activePhases: ACTIVE_PHASES,
      terminationPhase: TERMINATION,
    });
    expect(v.verdict).toBe("review");
    expect(v.reason).toMatch(/prospect_in_active_phase/);
  });

  test("prospect that never signed + Termination phase → ALLOW (was never a customer)", () => {
    const v = perDealVerdict({
      contract: prospectOnly,
      phase: "Termination",
      churnDays: null,
      cooloffDays: 180,
      activePhases: ACTIVE_PHASES,
      terminationPhase: TERMINATION,
    });
    expect(v.verdict).toBe("allow");
    expect(v.reason).toMatch(/terminated/);
  });

  test("no phase + no contract → ALLOW", () => {
    const v = perDealVerdict({
      contract: prospectOnly,
      phase: null,
      churnDays: null,
      cooloffDays: 180,
      activePhases: ACTIVE_PHASES,
      terminationPhase: TERMINATION,
    });
    expect(v.verdict).toBe("allow");
  });
});

describe("normalizeQuery", () => {
  test("strips protocol, www, path; lowercases", () => {
    expect(normalizeQuery("<REDACTED_URL>")).toBe("<REDACTED_HOST>");
  });
  test("preserves Saudi multi-level TLD", () => {
    expect(normalizeQuery("<REDACTED_URL>")).toBe("<REDACTED_HOST>");
    expect(normalizeQuery("<REDACTED_HOST>")).toBe("<REDACTED_HOST>");
  });
  test("empty input → empty string (caller handles default)", () => {
    expect(normalizeQuery("")).toBe("");
  });
});
