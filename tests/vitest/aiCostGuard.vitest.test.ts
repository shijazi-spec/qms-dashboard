/**
 * Unit tests for the AI spend circuit-breaker. Pure in-memory logic —
 * no DB, no I/O. The feature flag is read from process.env so we
 * manipulate it directly.
 *
 * Run: npx vitest run tests/vitest/aiCostGuard.vitest.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  COST,
  _resetCostGuardForTests,
  getSpendSnapshot,
  isCostCapped,
  recordSpend,
} from "../../src/utils/aiCostGuard";

const FLAG_KEY = "COST_CIRCUIT_BREAKER";
const CAP_KEY = "OPENAI_DAILY_CAP_USD";

beforeEach(() => {
  _resetCostGuardForTests();
});

afterEach(() => {
  delete process.env[FLAG_KEY];
  delete process.env[CAP_KEY];
});

describe("recordSpend / getSpendSnapshot", () => {
  test("starts at zero with today's date", () => {
    const s = getSpendSnapshot();
    expect(s.total_usd).toBe(0);
    expect(s.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.ops).toEqual({});
  });

  test("accumulates spend per operation", () => {
    recordSpend(COST.WHISPER_TRANSCRIBE, "whisper_transcribe");
    recordSpend(COST.GPT4O_MINI_ANALYZE, "analyze");
    recordSpend(COST.GPT4O_MINI_ANALYZE, "analyze");
    const s = getSpendSnapshot();
    expect(s.total_usd).toBeCloseTo(
      COST.WHISPER_TRANSCRIBE + 2 * COST.GPT4O_MINI_ANALYZE,
      6,
    );
    expect(s.ops["whisper_transcribe"]).toEqual({
      count: 1,
      usd: COST.WHISPER_TRANSCRIBE,
    });
    expect(s.ops["analyze"]).toEqual({
      count: 2,
      usd: 2 * COST.GPT4O_MINI_ANALYZE,
    });
  });

  test("ignores zero, negative, NaN, Infinity", () => {
    recordSpend(0, "noop");
    recordSpend(-1, "noop");
    recordSpend(NaN, "noop");
    recordSpend(Infinity, "noop");
    const s = getSpendSnapshot();
    expect(s.total_usd).toBe(0);
    expect(s.ops).toEqual({});
  });

  test("accepts arbitrary operation names", () => {
    recordSpend(0.5, "custom_op");
    expect(getSpendSnapshot().ops["custom_op"]).toEqual({
      count: 1,
      usd: 0.5,
    });
  });
});

describe("isCostCapped — flag off (dry-run mode)", () => {
  test("never caps even with huge spend recorded", () => {
    recordSpend(9999, "runaway");
    expect(isCostCapped()).toBe(false);
  });

  test("snapshot reports cap_enforced=false", () => {
    expect(getSpendSnapshot().cap_enforced).toBe(false);
  });
});

describe("isCostCapped — flag on", () => {
  beforeEach(() => {
    process.env[FLAG_KEY] = "true";
  });

  test("does NOT cap below the cap", () => {
    process.env[CAP_KEY] = "10";
    recordSpend(5, "below");
    expect(isCostCapped()).toBe(false);
  });

  test("DOES cap at exactly the cap", () => {
    process.env[CAP_KEY] = "10";
    recordSpend(10, "at-cap");
    expect(isCostCapped()).toBe(true);
  });

  test("DOES cap above the cap", () => {
    process.env[CAP_KEY] = "10";
    recordSpend(11.5, "over-cap");
    expect(isCostCapped()).toBe(true);
  });

  test("falls back to default cap when env unset", () => {
    // Default is $50 per the source.
    recordSpend(49.99, "below-default");
    expect(isCostCapped()).toBe(false);
    recordSpend(0.02, "just-over-default");
    expect(isCostCapped()).toBe(true);
  });

  test("falls back to default when env is non-numeric or non-positive", () => {
    for (const bad of ["abc", "0", "-5", ""]) {
      _resetCostGuardForTests();
      process.env[CAP_KEY] = bad;
      recordSpend(49, "x");
      expect(isCostCapped()).toBe(false);
      recordSpend(2, "y"); // 51 > 50 default
      expect(isCostCapped()).toBe(true);
    }
  });

  test("snapshot reports cap_enforced=true and accurate pct_of_cap", () => {
    process.env[CAP_KEY] = "100";
    recordSpend(25, "x");
    const s = getSpendSnapshot();
    expect(s.cap_enforced).toBe(true);
    expect(s.cap_usd).toBe(100);
    expect(s.total_usd).toBe(25);
    expect(s.pct_of_cap).toBe(25);
  });
});

describe("daily roll", () => {
  test("rollIfNewDay logic via snapshot is internally consistent", () => {
    // We don't manipulate Date here (that requires fake timers); we
    // just confirm the structure is right. The actual roll is exercised
    // through getSpendSnapshot which calls rollIfNewDay.
    const s1 = getSpendSnapshot();
    recordSpend(1, "x");
    const s2 = getSpendSnapshot();
    expect(s2.day).toBe(s1.day);
    expect(s2.total_usd).toBe(1);
  });
});

describe("integration with featureFlags helper", () => {
  test("per-user flag enables caps for listed identity (still global toggle for the guard)", () => {
    // The guard itself doesn't take an identity — it just calls
    // isFlagEnabled('cost_circuit_breaker') with no identity. So
    // per-user override doesn't apply to the guard (intentional —
    // a cost cap should be global, not per-user). This test pins
    // that behavior so a future change can't silently break it.
    process.env.COST_CIRCUIT_BREAKER_USERS = "alice@walaplus.com";
    // Flag is off globally + only allowlisted for one user → guard
    // sees no identity → reports flag OFF → does not cap.
    recordSpend(9999, "x");
    expect(isCostCapped()).toBe(false);
    delete process.env.COST_CIRCUIT_BREAKER_USERS;
  });
});
