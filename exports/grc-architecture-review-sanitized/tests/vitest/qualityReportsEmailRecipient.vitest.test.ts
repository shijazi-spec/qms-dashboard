import { describe, it, expect } from "vitest";
import { resolveEmailRecipient } from "../../src/utils/qualityReportsEmail";

describe("resolveEmailRecipient", () => {
  it("self mode uses the session email (never a body-supplied address)", () => {
    expect(resolveEmailRecipient("self", "user@example.invalid", "user@example.invalid")).toEqual({ to: "user@example.invalid" });
  });
  it("self mode 400s when session email is missing", () => {
    expect(resolveEmailRecipient("self", "user@example.invalid", null)).toEqual({ error: "Could not resolve your email.", status: 400 });
  });
  it("head mode uses the BU head email", () => {
    expect(resolveEmailRecipient("head", "user@example.invalid", "user@example.invalid")).toEqual({ to: "user@example.invalid" });
  });
  it("head mode 400s when no head email is mapped", () => {
    expect(resolveEmailRecipient("head", null, "user@example.invalid")).toEqual({ error: "This BU has no head email mapped.", status: 400 });
  });
  it("rejects unknown modes", () => {
    expect(resolveEmailRecipient("x", "user@example.invalid", "user@example.invalid")).toEqual({ error: "Invalid mode.", status: 400 });
  });
});
