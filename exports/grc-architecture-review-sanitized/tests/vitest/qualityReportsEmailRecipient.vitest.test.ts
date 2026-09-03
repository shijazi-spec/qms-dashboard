import { describe, it, expect } from "vitest";
import { resolveEmailRecipient } from "../../src/utils/qualityReportsEmail";

describe("resolveEmailRecipient", () => {
  it("self mode uses the session email (never a body-supplied address)", () => {
    expect(resolveEmailRecipient("self", "<REDACTED_EMAIL>", "<REDACTED_EMAIL>")).toEqual({ to: "<REDACTED_EMAIL>" });
  });
  it("self mode 400s when session email is missing", () => {
    expect(resolveEmailRecipient("self", "<REDACTED_EMAIL>", null)).toEqual({ error: "Could not resolve your email.", status: 400 });
  });
  it("head mode uses the BU head email", () => {
    expect(resolveEmailRecipient("head", "<REDACTED_EMAIL>", "<REDACTED_EMAIL>")).toEqual({ to: "<REDACTED_EMAIL>" });
  });
  it("head mode 400s when no head email is mapped", () => {
    expect(resolveEmailRecipient("head", null, "<REDACTED_EMAIL>")).toEqual({ error: "This BU has no head email mapped.", status: 400 });
  });
  it("rejects unknown modes", () => {
    expect(resolveEmailRecipient("x", "<REDACTED_EMAIL>", "<REDACTED_EMAIL>")).toEqual({ error: "Invalid mode.", status: 400 });
  });
});
