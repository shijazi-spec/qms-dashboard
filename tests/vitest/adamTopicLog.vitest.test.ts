import { describe, it, expect } from "vitest";
import { classifyQuestionTopic, CANONICAL_TOPICS } from "../../src/utils/adamTopicLog";

describe("CANONICAL_TOPICS", () => {
  it("has unique keys and a label for each", () => {
    const keys = CANONICAL_TOPICS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of CANONICAL_TOPICS) expect(t.label.length).toBeGreaterThan(0);
  });
});

describe("classifyQuestionTopic", () => {
  it("matches a known topic by keyword", () => {
    expect(classifyQuestionTopic("how many duplicates did we merge?").topic).toBe("data_cleanup");
    expect(classifyQuestionTopic("any renewal coming up in CS?").topic).toBe("cs_lifecycle");
    expect(classifyQuestionTopic("show me the KPI scorecard").topic).toBe("kpis");
  });
  it("returns null plus keywords when nothing matches", () => {
    const out = classifyQuestionTopic("what about the marketing budget approval workflow");
    expect(out.topic).toBeNull();
    expect(out.keywords.length).toBeGreaterThan(0);
    expect(out.keywords).toContain("marketing");
  });
  it("never keeps emails, urls, or phone numbers in keywords", () => {
    const out = classifyQuestionTopic("ping ahmad@walaplus.com on +966558733973 see https://x.com/abc regarding onboarding paperwork");
    const joined = out.keywords.join(" ");
    expect(joined).not.toContain("walaplus.com");
    expect(joined).not.toContain("966558733973");
    expect(joined).not.toContain("https");
    for (const k of out.keywords) expect(/\d/.test(k)).toBe(false);
  });
  it("treats a too-short question as unlearnable", () => {
    const out = classifyQuestionTopic("status?");
    expect(out.topic).toBeNull();
    expect(out.keywords).toEqual([]);
  });
  it("respects canonical order when two topics could match", () => {
    // 'duplicate' (data_cleanup) precedes 'deal' (deals) in CANONICAL_TOPICS
    expect(classifyQuestionTopic("duplicate deal records").topic).toBe("data_cleanup");
  });
});
