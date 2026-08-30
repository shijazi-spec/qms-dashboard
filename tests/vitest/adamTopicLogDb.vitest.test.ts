import { describe, it, expect, vi, beforeEach } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({ query: (...a: any[]) => query(...a), connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }) }),
}));
vi.mock("../../src/utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { rankSections, recordQuestionSection } from "../../src/utils/adamTopicLog";
beforeEach(() => query.mockReset());

describe("rankSections", () => {
  it("returns every section, most-asked first, zero-count ones included", () => {
    const out = rankSections({ kpis: 9, duplicates: 3 });
    expect(out[0].key).toBe("kpis");
    expect(out[1].key).toBe("duplicates");
    expect(out.length).toBeGreaterThan(2);
    expect(out.find((o) => o.key === "risks")?.asked).toBe(0);
    expect(out.every((o) => o.href.startsWith("/"))).toBe(true);
  });
});

describe("recordQuestionSection", () => {
  it("stores only the section key — never any question text", async () => {
    query.mockResolvedValue({ rows: [] });
    await recordQuestionSection("how many duplicates for Acme Trading Ltd?", { surface: "web", askedBy: "s@walaplus.com" });
    const call = query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO adam_topic_log"));
    expect(call).toBeTruthy();
    expect(JSON.stringify(call?.[1])).not.toContain("Acme");
    expect(JSON.stringify(call?.[1])).not.toContain("duplicates for");
  });
  it("swallows DB errors so a chat turn never breaks", async () => {
    query.mockRejectedValue(new Error("db down"));
    await expect(
      recordQuestionSection("any renewals due?", { surface: "slack", askedBy: null }),
    ).resolves.toBeUndefined();
  });
});
