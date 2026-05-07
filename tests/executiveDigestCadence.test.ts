import {
  buildDigestRunKey,
  buildDigestSlackBlocks,
  computeDigestWindow,
  isFirstThursdayInKsa,
  resolveDigestSectionRules,
  runDigestFanout,
  type DigestData,
} from "../src/utils/executiveDigest";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("executiveDigestCadence");

console.log("\n=== executiveDigestCadence tests ===\n");

await suite.test("weekly window resolves Fri->Thu in KSA", async () => {
  const ref = new Date("2026-05-07T14:00:00.000Z"); // Thursday 17:00 KSA
  const window = computeDigestWindow("weekly", ref);
  suite.expectEqual(window.cadence, "weekly", "cadence");
  suite.expectEqual(window.start.toISOString().slice(0, 10), "2026-05-01", "weekly start date");
  suite.expectEqual(window.end.toISOString().slice(0, 10), "2026-05-07", "weekly end date");
});

await suite.test("monthly and quarterly first-thursday guards are deterministic", async () => {
  const janFirstThu = new Date("2026-01-01T14:00:00.000Z");
  const janSecondThu = new Date("2026-01-08T14:00:00.000Z");
  suite.expectEqual(isFirstThursdayInKsa(janFirstThu, "monthly"), true, "monthly first Thursday true");
  suite.expectEqual(isFirstThursdayInKsa(janSecondThu, "monthly"), false, "monthly second Thursday false");
  suite.expectEqual(isFirstThursdayInKsa(janFirstThu, "quarterly"), true, "quarterly first Thursday true in Jan");
});

await suite.test("run key includes cadence, window and channel", async () => {
  const ref = new Date("2026-05-07T14:00:00.000Z");
  const window = computeDigestWindow("weekly", ref);
  const key = buildDigestRunKey("weekly", window, "slack");
  suite.expect(key.includes("weekly"), "contains cadence");
  suite.expect(key.endsWith(":slack"), "contains channel suffix");
});

await suite.test("section rules can be overridden from env JSON", async () => {
  const original = process.env.DIGEST_SECTION_RULES_JSON;
  process.env.DIGEST_SECTION_RULES_JSON = JSON.stringify([
    { id: "custom", title: "Custom Section", module: "Deals", includeKeywords: ["abc"] },
  ]);
  try {
    const rules = resolveDigestSectionRules();
    suite.expectEqual(rules.length, 1, "single custom rule loaded");
    suite.expectEqual(rules[0].id, "custom", "custom rule id");
    suite.expectEqual(rules[0].module, "Deals", "custom module");
  } finally {
    if (original === undefined) delete process.env.DIGEST_SECTION_RULES_JSON;
    else process.env.DIGEST_SECTION_RULES_JSON = original;
  }
});

await suite.test("slack block payload renders 4 digest sections", async () => {
  const mockData: DigestData = {
    generated_at: new Date().toISOString(),
    cadence: "weekly",
    period: "01/05/2026 — 07/05/2026",
    window_start: new Date("2026-05-01T00:00:00.000Z").toISOString(),
    window_end: new Date("2026-05-07T20:59:59.999Z").toISOString(),
    nc_summary: { open: 1, opened_this_week: 1, closed_this_week: 0, overdue: 0 },
    capa_summary: { open: 1, opened_this_week: 1, closed_this_week: 0, effectiveness_rate: 80 },
    risk_summary: { total_active: 2, critical_high: 1, new_this_week: 1, overdue_treatments: 0 },
    audit_summary: { last_score: 82, last_date: "2026-05-06", trend: "stable" },
    kpi_summary: { green: 1, amber: 1, red: 0, total: 2 },
    compliance_summary: { met: 1, partial: 1, not_met: 0, total: 2 },
    top_alerts: [],
    capa_recurrences: 0,
    duplicate_clusters: 0,
    business_sections: [
      { id: "sdr", title: "SDR (All leads)", total: 4, leads: 4, deals: 0, new_in_window: 4, progressed: 2, stalled: 1 },
      { id: "walaplus_deals", title: "WalaPlus Deals", total: 3, leads: 0, deals: 3, new_in_window: 3, progressed: 1, stalled: 1 },
      { id: "walaone_deals", title: "WalaOne Deals", total: 2, leads: 0, deals: 2, new_in_window: 2, progressed: 1, stalled: 0 },
      { id: "marketplace_all", title: "MarketPlace (All leads & deals)", total: 5, leads: 2, deals: 3, new_in_window: 5, progressed: 2, stalled: 1 },
    ],
  };

  const blocks = buildDigestSlackBlocks(mockData);
  const textBlob = JSON.stringify(blocks);
  suite.expect(textBlob.includes("SDR (All leads)"), "contains SDR section");
  suite.expect(textBlob.includes("WalaPlus Deals"), "contains WalaPlus section");
  suite.expect(textBlob.includes("WalaOne Deals"), "contains WalaOne section");
  suite.expect(textBlob.includes("MarketPlace (All leads & deals)"), "contains MarketPlace section");
});

await suite.test("fanout isolates channel failures (email fail, slack skipped)", async () => {
  const oldDigestEmail = process.env.QUALITY_DIGEST_EMAIL;
  const oldAdminEmail = process.env.ADMIN_EMAIL;
  const oldSlackToken = process.env.SLACK_BOT_TOKEN;
  const oldSlackApiToken = process.env.SLACK_API_TOKEN;
  const oldSlackNotify = process.env.DIGEST_SLACK_NOTIFY;

  delete process.env.QUALITY_DIGEST_EMAIL;
  delete process.env.ADMIN_EMAIL;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_API_TOKEN;
  process.env.DIGEST_SLACK_NOTIFY = "1";

  try {
    const result = await runDigestFanout("weekly", {
      now: new Date("2026-05-07T14:00:00.000Z"),
      enforceIdempotency: false,
    });
    suite.expectEqual(result.email.success, false, "email fails without recipient");
    suite.expectEqual(result.slack.success, true, "slack branch returns success when skipped");
    suite.expectEqual(result.slack.skipped, true, "slack skipped without creds");
  } finally {
    if (oldDigestEmail === undefined) delete process.env.QUALITY_DIGEST_EMAIL;
    else process.env.QUALITY_DIGEST_EMAIL = oldDigestEmail;
    if (oldAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = oldAdminEmail;
    if (oldSlackToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = oldSlackToken;
    if (oldSlackApiToken === undefined) delete process.env.SLACK_API_TOKEN;
    else process.env.SLACK_API_TOKEN = oldSlackApiToken;
    if (oldSlackNotify === undefined) delete process.env.DIGEST_SLACK_NOTIFY;
    else process.env.DIGEST_SLACK_NOTIFY = oldSlackNotify;
  }
});

suite.finishOrExit();

