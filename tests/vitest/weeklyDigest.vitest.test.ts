/**
 * Unit tests for the weekly digest. Pure-function data + rendering
 * exercised against a mock pool. Send orchestration tested at the
 * flag-gate boundary; Slack/Resend integration is not invoked in
 * these tests (no real credentials).
 *
 * Run: npx vitest run tests/vitest/weeklyDigest.vitest.test.ts
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  buildLastWeekWindow,
  fetchWeeklyAgentRollup,
  renderDigestHtml,
  renderDigestSlackBlocks,
  renderDigestText,
  sendWeeklyDigest,
  type WeeklyDigest,
} from "../../src/utils/weeklyDigest";

const FLAG_KEY = "WEEKLY_DIGEST";

afterEach(() => {
  delete process.env[FLAG_KEY];
});

describe("buildLastWeekWindow", () => {
  test("produces a 7-day window ending 'today' (UTC)", () => {
    const w = buildLastWeekWindow(new Date("2026-05-25T12:00:00Z"));
    const dayMs = 24 * 60 * 60 * 1000;
    expect(w.end.getTime() - w.start.getTime()).toBe(7 * dayMs);
  });
  test("label is human-readable Month-Day range", () => {
    const w = buildLastWeekWindow(new Date("2026-05-25T12:00:00Z"));
    expect(w.label).toMatch(/[A-Z][a-z]{2} \d+ – [A-Z][a-z]{2} \d+/);
  });
});

describe("fetchWeeklyAgentRollup", () => {
  test("aggregates per-agent counts + avg/best/worst scores", async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            agent_email: "alice@x",
            agent_name: "Alice",
            call_count: 10,
            evaluated_count: 8,
            avg_overall_score: 82.5,
            best_score: 95,
            worst_score: 65,
          },
          {
            agent_email: "bob@x",
            agent_name: "Bob",
            call_count: 5,
            evaluated_count: 5,
            avg_overall_score: 70.0,
            best_score: 80,
            worst_score: 60,
          },
        ],
      }),
    };
    const r = await fetchWeeklyAgentRollup(pool, buildLastWeekWindow());
    expect(r.agents).toHaveLength(2);
    expect(r.total_calls).toBe(15);
    expect(r.total_evaluated).toBe(13);
    expect(r.agents_active).toBe(2);
    // weighted org avg = (82.5*8 + 70*5)/13 ≈ 77.69
    expect(r.org_avg_score).toBeCloseTo(77.69, 1);
  });

  test("rolls up to org_avg_score=null when no evaluations", async () => {
    const pool = {
      query: async () => ({
        rows: [
          { agent_email: "a@x", agent_name: null, call_count: 3,
            evaluated_count: 0, avg_overall_score: null, best_score: null, worst_score: null },
        ],
      }),
    };
    const r = await fetchWeeklyAgentRollup(pool, buildLastWeekWindow());
    expect(r.org_avg_score).toBeNull();
    expect(r.agents[0].avg_overall_score).toBeNull();
  });

  test("returns empty digest when query throws", async () => {
    const pool = {
      query: async () => {
        throw new Error("boom");
      },
    };
    const r = await fetchWeeklyAgentRollup(pool, buildLastWeekWindow());
    expect(r.agents).toEqual([]);
    expect(r.total_calls).toBe(0);
  });
});

const sampleDigest: WeeklyDigest = {
  window: { start: new Date("2026-05-18T00:00:00Z"), end: new Date("2026-05-25T00:00:00Z"), label: "May 18 – May 24" },
  total_calls: 15,
  total_evaluated: 13,
  agents_active: 2,
  org_avg_score: 77.69,
  agents: [
    { agent_email: "alice@x", agent_name: "Alice", call_count: 10, evaluated_count: 8,
      avg_overall_score: 82.5, best_score: 95, worst_score: 65 },
    { agent_email: "bob@x", agent_name: "Bob", call_count: 5, evaluated_count: 5,
      avg_overall_score: 70.0, best_score: 80, worst_score: 60 },
  ],
};

describe("renderDigestText", () => {
  test("includes window, snapshot, and one line per agent", () => {
    const t = renderDigestText(sampleDigest);
    expect(t).toContain("Weekly Call Evaluation Digest");
    expect(t).toContain("May 18 – May 24");
    expect(t).toContain("Alice: 10 calls");
    expect(t).toContain("Bob: 5 calls");
    expect(t).toContain("org avg 77.69");
  });
  test("handles empty agents gracefully", () => {
    const t = renderDigestText({ ...sampleDigest, agents: [], agents_active: 0 });
    expect(t).toContain("no calls in this window");
  });
});

describe("renderDigestSlackBlocks", () => {
  test("emits header + summary + divider + agent sections", () => {
    const blocks = renderDigestSlackBlocks(sampleDigest);
    expect(blocks[0].type).toBe("header");
    expect(blocks[1].type).toBe("section");
    expect(blocks[2].type).toBe("divider");
    expect(blocks.filter((b) => b.type === "section").length).toBeGreaterThanOrEqual(3);
  });
  test("caps at 10 agents and adds 'and N more' context", () => {
    const manyAgents = Array.from({ length: 15 }, (_, i) => ({
      agent_email: `a${i}@x`,
      agent_name: `Agent${i}`,
      call_count: 5,
      evaluated_count: 5,
      avg_overall_score: 75,
      best_score: 80,
      worst_score: 70,
    }));
    const blocks = renderDigestSlackBlocks({ ...sampleDigest, agents: manyAgents, agents_active: 15 });
    const contextBlocks = blocks.filter((b) => b.type === "context");
    expect(contextBlocks).toHaveLength(1);
    expect(JSON.stringify(contextBlocks[0])).toContain("5 more agents");
  });
});

describe("renderDigestHtml", () => {
  test("emits table with one row per agent", () => {
    const html = renderDigestHtml(sampleDigest);
    expect(html).toContain("<table");
    expect(html).toContain("Alice");
    expect(html).toContain("Bob");
    expect(html).toContain("May 18 – May 24");
  });
  test("escapes HTML in agent names", () => {
    const evil = {
      ...sampleDigest,
      agents: [
        { ...sampleDigest.agents[0], agent_name: "<script>alert(1)</script>" },
      ],
    };
    const html = renderDigestHtml(evil);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("sendWeeklyDigest — flag gating", () => {
  test("returns flag_disabled when flag off and forceSend=false", async () => {
    const pool = { query: async () => ({ rows: [] }) };
    const r = await sendWeeklyDigest(pool);
    expect(r.sent).toBe(false);
    expect(r.skipped_reason).toBe("flag_disabled");
    expect(r.slack.attempted).toBe(false);
    expect(r.email.attempted).toBe(false);
  });

  test("forceSend=true bypasses flag", async () => {
    const pool = { query: async () => ({ rows: [] }) };
    const r = await sendWeeklyDigest(pool, { forceSend: true });
    expect(r.skipped_reason).not.toBe("flag_disabled");
  });

  test("with flag on, no channels configured → skipped_reason=all_channels_failed_or_unconfigured", async () => {
    process.env[FLAG_KEY] = "true";
    // Clean env so neither channel has a destination
    delete process.env.SLACK_DIGEST_CHANNEL_ID;
    delete process.env.SLACK_CHANNEL_ID;
    delete process.env.WEEKLY_DIGEST_RECIPIENTS;
    const pool = { query: async () => ({ rows: [] }) };
    const r = await sendWeeklyDigest(pool);
    expect(r.sent).toBe(false);
    expect(r.skipped_reason).toBe("all_channels_failed_or_unconfigured");
    expect(r.slack.reason).toBe("no_channel_configured");
    expect(r.email.reason).toBe("no_recipients_configured");
  });

  test("digest_summary included regardless of dispatch outcome", async () => {
    const pool = { query: async () => ({ rows: [] }) };
    const r = await sendWeeklyDigest(pool, { forceSend: true });
    expect(r.digest_summary).toBeDefined();
    expect(r.digest_summary?.window_label).toBeTruthy();
  });
});
