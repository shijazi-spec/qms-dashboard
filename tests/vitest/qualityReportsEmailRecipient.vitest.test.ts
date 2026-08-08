import { describe, it, expect } from "vitest";
import { resolveEmailRecipient } from "../../src/utils/qualityReportsEmail";

describe("resolveEmailRecipient", () => {
  it("self mode uses the session email (never a body-supplied address)", () => {
    expect(resolveEmailRecipient("self", "head@x.com", "me@walaplus.com")).toEqual({ to: "me@walaplus.com" });
  });
  it("self mode 400s when session email is missing", () => {
    expect(resolveEmailRecipient("self", "head@x.com", null)).toEqual({ error: "Could not resolve your email.", status: 400 });
  });
  it("head mode uses the BU head email", () => {
    expect(resolveEmailRecipient("head", "head@x.com", "me@walaplus.com")).toEqual({ to: "head@x.com" });
  });
  it("head mode 400s when no head email is mapped", () => {
    expect(resolveEmailRecipient("head", null, "me@walaplus.com")).toEqual({ error: "This BU has no head email mapped.", status: 400 });
  });
  it("rejects unknown modes", () => {
    expect(resolveEmailRecipient("x", "head@x.com", "me@walaplus.com")).toEqual({ error: "Invalid mode.", status: 400 });
  });
});
