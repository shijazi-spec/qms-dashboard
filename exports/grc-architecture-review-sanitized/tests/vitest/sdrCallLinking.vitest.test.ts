/**
 * Regression test for the primary call→CRM auto-linker.
 *
 * GUARD (2026-05-29): phase-1 phone matching references the shared
 * MIN_PHONE_OVERLAP_DIGITS floor. A missing import once made that a runtime
 * ReferenceError that tsc did not surface (the project has unrelated
 * pre-existing type errors), silently breaking ALL phone auto-linking. This
 * test executes phase-1 with a valid phone candidate so any undefined
 * threshold / import regression fails loudly instead of shipping.
 *
 * Run: npx vitest run tests/vitest/sdrCallLinking.vitest.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { autoLinkCallToCrm } from "../../src/utils/sdrCallLinking";

describe("autoLinkCallToCrm phase-1", () => {
  const saved = {
    token: <REDACTED_SECRET>
    id: process.env.CRMProvider_CLIENT_ID,
    secret: <REDACTED_SECRET>
    refresh: process.env.CRMProvider_REFRESH_TOKEN,
  };
  beforeEach(() => {
    // Deterministic: force the "no CRMProvider" path so we exercise the threshold
    // branch without a live CRM, isolating the import/threshold regression.
    delete process.env.CRMProvider_ACCESS_TOKEN;
    delete process.env.CRMProvider_CLIENT_ID;
    delete process.env.CRMProvider_CLIENT_SECRET;
    delete process.env.CRMProvider_REFRESH_TOKEN;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries({
      CRMProvider_ACCESS_TOKEN: <REDACTED_SECRET>
      CRMProvider_CLIENT_ID: saved.id,
      CRMProvider_CLIENT_SECRET: <REDACTED_SECRET>
      CRMProvider_REFRESH_TOKEN: <REDACTED_SECRET>
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("a full 9-digit candidate runs phase-1 without throwing", async () => {
    const noop = async () => {};
    const res = await autoLinkCallToCrm(1, ["<REDACTED_PHONE>"], noop, noop, {});
    // Without CRMProvider creds the matcher bails gracefully; the point is that the
    // MIN_PHONE_OVERLAP_DIGITS reference resolved (no ReferenceError).
    expect(res).toBeTruthy();
    expect(typeof res.reason).toBe("string");
    expect(res.linked).toBe(false);
  });

  test("a sub-9-digit junk candidate is skipped, still no throw", async () => {
    const noop = async () => {};
    const res = await autoLinkCallToCrm(1, ["11"], noop, noop, {});
    expect(res).toBeTruthy();
    expect(res.linked).toBe(false);
  });
});
