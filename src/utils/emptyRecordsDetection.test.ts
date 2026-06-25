import { describe, it, expect } from "vitest";
import {
  isTestOrPlaceholderName,
  classifyDeal,
  classifyAccount,
  classifyContact,
} from "./emptyRecordsDetection";

describe("isTestOrPlaceholderName", () => {
  it("flags exact placeholders", () => {
    expect(isTestOrPlaceholderName("test")).toBe(true);
    expect(isTestOrPlaceholderName("N/A")).toBe(true);
  });
  it("flags standalone test keywords (whole word, EN+AR)", () => {
    expect(isTestOrPlaceholderName("Test Account")).toBe(true);
    expect(isTestOrPlaceholderName("Ahmed Test")).toBe(true);
    expect(isTestOrPlaceholderName("demo deal")).toBe(true);
    expect(isTestOrPlaceholderName("شركة تجريبي")).toBe(true);
  });
  it("does NOT flag a keyword embedded in a real word", () => {
    expect(isTestOrPlaceholderName("Latest Holdings")).toBe(false);
    expect(isTestOrPlaceholderName("Testbed Robotics")).toBe(false);
  });
  it("does NOT flag a real company with no standalone keyword", () => {
    expect(isTestOrPlaceholderName("Saudi Aramco")).toBe(false);
  });
});

describe("classifyDeal", () => {
  it("empty when no account, no contact, no amount", () => {
    const r = classifyDeal({ hasAccount: false, hasContact: false, amount: 0, name: "X" });
    expect(r.reason).toBe("empty");
    expect(r.deleteEligible).toBe(true);
    expect(r.linkEligible).toBe(true);
  });
  it("orphaned (not empty) when no account but has a contact — link only", () => {
    const r = classifyDeal({ hasAccount: false, hasContact: true, amount: 0, name: "X" });
    expect(r.reason).toBe("orphaned");
    expect(r.deleteEligible).toBe(false);
    expect(r.linkEligible).toBe(true);
  });
  it("test name → delete-eligible even with an account and amount", () => {
    const r = classifyDeal({ hasAccount: true, hasContact: true, amount: 5000, name: "demo deal" });
    expect(r.reason).toBe("test");
    expect(r.deleteEligible).toBe(true);
  });
  it("a normal deal with an account is not flagged", () => {
    const r = classifyDeal({ hasAccount: true, hasContact: false, amount: 100, name: "Aramco Renewal" });
    expect(r.reason).toBe(null);
    expect(r.deleteEligible).toBe(false);
    expect(r.linkEligible).toBe(false);
  });
});

describe("classifyAccount", () => {
  it("structurally empty when no deals and no contacts", () => {
    const r = classifyAccount({ hasDeals: false, hasContacts: false, name: "X" });
    expect(r.reason).toBe("empty");
    expect(r.structurallyEmpty).toBe(true);
  });
  it("test name flagged regardless of links", () => {
    const r = classifyAccount({ hasDeals: true, hasContacts: true, name: "Test Co" });
    expect(r.reason).toBe("test");
  });
  it("normal account with links not flagged", () => {
    const r = classifyAccount({ hasDeals: true, hasContacts: false, name: "Riyad Bank" });
    expect(r.reason).toBe(null);
  });
});

describe("classifyContact", () => {
  it("name-only → delete eligible", () => {
    const r = classifyContact({ hasEmail: false, hasPhone: false, hasAccount: false, hasDeals: false, name: "John" });
    expect(r.reason).toBe("empty");
    expect(r.deleteEligible).toBe(true);
  });
  it("has an email → not empty", () => {
    const r = classifyContact({ hasEmail: true, hasPhone: false, hasAccount: false, hasDeals: false, name: "John" });
    expect(r.reason).toBe(null);
  });
  it("test name → flagged", () => {
    const r = classifyContact({ hasEmail: true, hasPhone: true, hasAccount: true, hasDeals: true, name: "test contact" });
    expect(r.reason).toBe("test");
    expect(r.deleteEligible).toBe(true);
  });
});
