import { describe, it, expect } from "vitest";
import { classifyQuestionSection, PLATFORM_SECTIONS } from "../../src/utils/adamTopicLog";

describe("PLATFORM_SECTIONS", () => {
  it("has unique keys, a label and a platform href for each", () => {
    const keys = PLATFORM_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of PLATFORM_SECTIONS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.href.startsWith("/")).toBe(true);
      expect(s.keywords.length).toBeGreaterThan(0);
    }
  });
});

describe("classifyQuestionSection", () => {
  it("maps a question to a platform section", () => {
    expect(classifyQuestionSection("how many duplicates did we merge?")).toBe("duplicates");
    expect(classifyQuestionSection("any renewal coming up in CS?")).toBe("cs_lifecycle");
    expect(classifyQuestionSection("show me the KPI scorecard")).toBe("kpis");
    expect(classifyQuestionSection("what is open in the risk register?")).toBe("risks");
  });
  it("returns null when nothing matches — and NEVER any text", () => {
    expect(classifyQuestionSection("Acme Trading Ltd wants a partnership brochure")).toBeNull();
    expect(classifyQuestionSection("status?")).toBeNull();
  });
  it("respects canonical order when two sections could match", () => {
    // 'duplicate' (duplicates) precedes 'deal' (deal_compliance) in PLATFORM_SECTIONS
    expect(classifyQuestionSection("duplicate deal records")).toBe("duplicates");
  });
  it("ignores emails, phones and urls when matching", () => {
    expect(classifyQuestionSection("mail user@example.invalid about <REDACTED_PHONE>")).toBeNull();
  });
});
