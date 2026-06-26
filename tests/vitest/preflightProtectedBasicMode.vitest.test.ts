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
        { company_name: "Saudi Aramco", domain: "aramco.com", email: "buyer@aramco.com" },
        { company_name: "Syarah", domain: "syarah.com", email: "x@syarah.com" },
        { company_name: "Tree", email: "leaf@example.com" },
        { company_name: "Totally Normal Co", domain: "normalco.example", email: "a@normalco.example" },
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
    const res = await runPreflight({ rows: [{ company_name: "Syarah" }] });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.reason).toBe("protected_account");
    expect(res.rows[0]!.verdict).toBe("block");
  });
});
