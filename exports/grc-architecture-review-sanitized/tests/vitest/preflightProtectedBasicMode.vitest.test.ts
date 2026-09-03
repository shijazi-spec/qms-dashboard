/**
 * Regression test for the BASIC-mode protected-account guard.
 *
 * Production runs preflight in BASIC mode (PREFLIGHT_RULE_MODE defaults to
 * "basic"), which uses runPreflightBasic — a DIFFERENT code path from the
 * "full" classifyPreflightRows ladder. The protected / do-not-contact
 * blocklist (matchProtectedAccount) was originally only wired into the full
 * classifier, so in production it never fired. The pure-logic suite
 * (duplicateRadarPreflight.vitest.test.ts) only exercises classifyPreflightRows
 * directly, so it could not catch this path-selection bug.
 *
 * This test mocks the DB module so the DB-touching runPreflight wrapper can run
 * in BASIC mode without a live database, and asserts the protected verdict
 * fires there too.
 */
import { describe, it, expect, vi } from "vitest";

const makeClient = () => ({
  query: vi.fn(async () => ({ rows: [] })),
  release: vi.fn(),
});

vi.mock("../../src/utils/duplicateRadarDatabase", async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    pool: {
      connect: vi.fn(async () => makeClient()),
      query: vi.fn(async () => ({ rows: [] })),
    },
  };
});

import {
  runPreflight,
  PREFLIGHT_RULE_MODE,
} from "../../src/utils/duplicateRadarPreflight";

describe("runPreflight BASIC mode — protected-account guard", () => {
  it("runs in BASIC mode by default (the production path)", () => {
    expect(PREFLIGHT_RULE_MODE).toBe("basic");
  });

  it("blocks protected / do-not-contact accounts even with no CRM match", async () => {
    const res = await runPreflight({
      rows: [
        { company_name: "Example Organization", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>" },
        { company_name: "Example Organization", domain: "<REDACTED_HOST>", email: "<REDACTED_EMAIL>" },
        { company_name: "Example Organization", email: "<REDACTED_EMAIL>" },
        { company_name: "Example Organization", domain: "normalco.example", email: "<REDACTED_EMAIL>" },
      ],
    });

    const protectedRows = res.rows.filter((r) => r.reason === "protected_account");
    expect(protectedRows).toHaveLength(3);
    for (const r of protectedRows) {
      expect(r.verdict).toBe("block");
      expect(r.executive_severity).toBe("critical");
    }
    expect(res.summary.block).toBeGreaterThanOrEqual(3);

    const normal = res.rows.find((r) => r.input.company_name === "Totally Normal Co");
    expect(normal?.reason).not.toBe("protected_account");
  });

  it("blocks a protected account matched by NAME only (no email/phone/domain)", async () => {
    const res = await runPreflight({ rows: [{ company_name: "Example Organization" }] });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.reason).toBe("protected_account");
    expect(res.rows[0]!.verdict).toBe("block");
  });

  // Sample User 2026-07-06 — a phone is MANDATORY: a named contact with no valid phone
  // is rejected as invalid data (verdict no_contact / reason no_phone), even if
  // it carries an email. A contact WITH a phone is not rejected on this rule.
  it("rejects a named contact with NO phone even when it has an email", async () => {
    const res = await runPreflight({
      rows: [
        { company_name: "Example Organization", contact_name: "Sample User", email: "<REDACTED_EMAIL>" },
        { company_name: "Example Organization", contact_name: "Sample User", email: "<REDACTED_EMAIL>", phone: "555" },
        { company_name: "Example Organization", contact_name: "Sample User", email: "<REDACTED_EMAIL>", phone: "<REDACTED_PHONE>" },
      ],
    });
    const alice = res.rows.find((r) => r.input.company_name === "NoPhone Co");
    expect(alice?.verdict).toBe("no_contact");
    expect(alice?.reason).toBe("no_phone");
    // A phone under 7 digits normalises to null → still rejected as invalid.
    const carol = res.rows.find((r) => r.input.company_name === "ShortPhone Co");
    expect(carol?.verdict).toBe("no_contact");
    // A contact with a valid phone must NOT be rejected on this rule.
    const bob = res.rows.find((r) => r.input.company_name === "HasPhone Co");
    expect(bob?.verdict).not.toBe("no_contact");
    expect(res.summary.no_contact).toBeGreaterThanOrEqual(2);
  });
});
