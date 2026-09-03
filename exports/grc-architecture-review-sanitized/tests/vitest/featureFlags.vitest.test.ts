/**
 * Unit tests for the feature-flag helper. Pure function — no DB, no I/O.
 *
 * Run: npx vitest run tests/vitest/featureFlags.vitest.test.ts
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  FLAGS,
  isFlagEnabled,
  listFlagStates,
  type FlagName,
} from "../../src/utils/featureFlags";

// Pick one real flag from the registry as the subject under test.
// Using a real one (not a fake) ensures we'd catch a registry typo.
const FLAG: FlagName = "five9_real_ingest";
const ENV_KEY = FLAGS[FLAG]; // "FIVE9_REAL_INGEST"
const USERS_KEY = `${ENV_KEY}_USERS`;

afterEach(() => {
  delete process.env[ENV_KEY];
  delete process.env[USERS_KEY];
});

describe("isFlagEnabled — global toggle", () => {
  test("unset env var → disabled", () => {
    expect(isFlagEnabled(FLAG)).toBe(false);
  });

  test('value "true" → enabled globally', () => {
    process.env[ENV_KEY] = "true";
    expect(isFlagEnabled(FLAG)).toBe(true);
  });

  test('value "1" → enabled globally', () => {
    process.env[ENV_KEY] = "1";
    expect(isFlagEnabled(FLAG)).toBe(true);
  });

  test('values "on", "yes", "enabled" → enabled globally', () => {
    for (const v of ["on", "yes", "enabled", "ON", "YES", "ENABLED"]) {
      process.env[ENV_KEY] = v;
      expect(isFlagEnabled(FLAG)).toBe(true);
    }
  });

  test('value "false" / "0" / "off" → disabled', () => {
    for (const v of ["false", "0", "off", "no", ""]) {
      process.env[ENV_KEY] = v;
      expect(isFlagEnabled(FLAG)).toBe(false);
    }
  });

  test("whitespace and casing are tolerated", () => {
    process.env[ENV_KEY] = "  True  ";
    expect(isFlagEnabled(FLAG)).toBe(true);
  });
});

describe("isFlagEnabled — per-user allowlist", () => {
  test("listed user is enabled even when global is off", () => {
    process.env[USERS_KEY] = "user@example.invalid,user@example.invalid";
    expect(isFlagEnabled(FLAG, "user@example.invalid")).toBe(true);
    expect(isFlagEnabled(FLAG, "user@example.invalid")).toBe(true);
  });

  test("unlisted user stays disabled when global is off", () => {
    process.env[USERS_KEY] = "user@example.invalid";
    expect(isFlagEnabled(FLAG, "user@example.invalid")).toBe(false);
  });

  test("user list is additive — global on still wins for unlisted users", () => {
    process.env[ENV_KEY] = "true";
    process.env[USERS_KEY] = "user@example.invalid";
    expect(isFlagEnabled(FLAG, "user@example.invalid")).toBe(true);
  });

  test("trims whitespace in user list and identity", () => {
    process.env[USERS_KEY] = " user@example.invalid , user@example.invalid ";
    expect(isFlagEnabled(FLAG, "user@example.invalid")).toBe(true);
    expect(isFlagEnabled(FLAG, "  user@example.invalid  ")).toBe(true);
  });

  test('empty identity ("") returns false even if listed', () => {
    process.env[USERS_KEY] = ",,,";
    expect(isFlagEnabled(FLAG, "")).toBe(false);
  });

  test("supports user:<id> identity format", () => {
    process.env[USERS_KEY] = "user:42";
    expect(isFlagEnabled(FLAG, "user:42")).toBe(true);
    expect(isFlagEnabled(FLAG, "user:7")).toBe(false);
  });

  test("null identity → only global is consulted", () => {
    process.env[USERS_KEY] = "user@example.invalid";
    expect(isFlagEnabled(FLAG, null)).toBe(false);
    process.env[ENV_KEY] = "true";
    expect(isFlagEnabled(FLAG, null)).toBe(true);
  });
});

describe("isFlagEnabled — defensive behavior", () => {
  test("unknown flag name returns false (never throws)", () => {
    // Force-cast to bypass the type checker — we want runtime behavior.
    expect(isFlagEnabled("not_a_flag" as FlagName)).toBe(false);
    expect(isFlagEnabled("" as FlagName, "user@example.invalid")).toBe(false);
  });
});

describe("listFlagStates", () => {
  test("returns every registered flag, even when unset", () => {
    const states = listFlagStates();
    const registered = Object.keys(FLAGS) as FlagName[];
    for (const f of registered) {
      expect(states[f]).toBeDefined();
      expect(states[f].envKey).toBe(FLAGS[f]);
    }
  });

  test("reflects global on/off correctly", () => {
    process.env[ENV_KEY] = "true";
    expect(listFlagStates()[FLAG].global).toBe(true);
    process.env[ENV_KEY] = "false";
    expect(listFlagStates()[FLAG].global).toBe(false);
  });

  test("reflects the user list", () => {
    process.env[USERS_KEY] = "user@example.invalid,user@example.invalid";
    expect(listFlagStates()[FLAG].users).toEqual([
      "user@example.invalid",
      "user@example.invalid",
    ]);
  });

  test("does NOT throw or leak when env is fully empty", () => {
    // Already cleaned by afterEach; nothing in env for this flag.
    const states = listFlagStates();
    expect(states[FLAG].global).toBe(false);
    expect(states[FLAG].users).toEqual([]);
  });
});
