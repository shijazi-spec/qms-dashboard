/**
 * Unit tests for src/utils/slackChannelRouting.ts
 *
 * Mis-routing is quiet and expensive: a SAMA deadline warning landing in a
 * sales channel is not obviously wrong to anyone reading either channel, and
 * an alert sent to a channel nobody owns is the same as no alert. These pin
 * the routing rules and, most importantly, the fallbacks.
 *
 * Run:  npx tsx tests/slackChannelRouting.test.ts
 */

import {
  resolveSlackAudience,
  resolveSlackChannel,
  AUDIENCE_ENV_VAR,
  platformAnnouncementsMuted,
  getSuppressedPlatformPosts,
  noteSuppressedPlatformPost,
  __resetSuppressedPlatformPosts,
} from "../src/utils/slackChannelRouting";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("slackChannelRouting");

console.log("\n=== Slack channel routing ===\n");

/**
 * The platform channel is muted unless PLATFORM_SLACK_ANNOUNCEMENTS is "true".
 * Every fixture that asserts platform ROUTING sets it, so those tests keep
 * checking which channel is chosen rather than accidentally re-testing the
 * mute. The mute has its own tests at the bottom.
 */
const UNMUTED = { PLATFORM_SLACK_ANNOUNCEMENTS: "true" };

const ENV = {
  ...UNMUTED,
  SLACK_CHANNEL_PLATFORM: "C_PLATFORM",
  SLACK_CHANNEL_SDR_SALES: "C_SALES",
  SLACK_CHANNEL_CS: "C_CS",
  SLACK_CHANNEL_MARKETPLACE: "C_MARKET",
  SLACK_CHANNEL_ID: "C_LEGACY",
} as NodeJS.ProcessEnv;

await suite.test("platform-owned modules route to the platform channel", async () => {
  for (const m of ["platform", "qms", "audits", "compliance", "pdpl", "kpis", "ai-governance"]) {
    suite.expectEqual(resolveSlackAudience(m), "platform", m);
  }
});

await suite.test("fraud goes to platform, NOT to a business unit", async () => {
  // Fraud is a SAMA/AML compliance function owned by GRQ. Routing it to a
  // sales channel would put incident detail in front of the wrong audience.
  suite.expectEqual(resolveSlackAudience("fraud"), "platform", "fraud");
});

await suite.test("SDR/Sales AUDIT FINDINGS route to the sales channel", async () => {
  // The weekly data-quality audit over the team's own records.
  for (const m of ["calls", "Leads", "Deals", "Accounts", "Contacts", "CRM"]) {
    suite.expectEqual(resolveSlackAudience(m), "sales_sdr", m);
  }
});

await suite.test("Duplicate Radar OPERATIONS route to platform, not sales", async () => {
  // The resolution digest and "merge applied" messages are the platform acting
  // on data, and the platform channel is where that behaviour gets reviewed and
  // tuned. Distinct from the audit findings above, which are the team's records.
  suite.expectEqual(resolveSlackAudience("duplicates"), "platform", "duplicates");
  suite.expectEqual(resolveSlackAudience("duplicate-radar"), "platform", "duplicate-radar");
});

await suite.test("CS modules route to the CS channel", async () => {
  for (const m of ["cs", "cs_lifecycle", "handoff"]) {
    suite.expectEqual(resolveSlackAudience(m), "cs", m);
  }
});

await suite.test("module matching is case-insensitive", async () => {
  // Callers use both "Leads" and "leads"; the map must not care.
  suite.expectEqual(resolveSlackAudience("LEADS"), "sales_sdr", "upper");
  suite.expectEqual(resolveSlackAudience("  Deals  "), "sales_sdr", "padded");
});

await suite.test("an unknown module lands on platform, not nowhere", async () => {
  // The important property: an unrouted alert must reach a staffed channel
  // rather than being silently dropped or sent somewhere unowned.
  suite.expectEqual(resolveSlackAudience("some_new_module"), "platform", "unknown");
  suite.expectEqual(resolveSlackAudience(undefined), "platform", "undefined");
  suite.expectEqual(resolveSlackAudience(null), "platform", "null");
  suite.expectEqual(resolveSlackAudience(""), "platform", "empty");
});

await suite.test("segment overrides module", async () => {
  // A marketplace duplicate cluster belongs to the marketplace channel even
  // though its module says "duplicates".
  suite.expectEqual(
    resolveSlackAudience("duplicates", "marketplace"),
    "marketplace",
    "marketplace segment wins",
  );
  suite.expectEqual(
    resolveSlackAudience("duplicates", "Partner Accounts"),
    "marketplace",
    "partner accounts is a marketplace layout",
  );
  suite.expectEqual(
    resolveSlackAudience("Leads", "walaplus"),
    "sales_sdr",
    "a corporate segment does not override the module",
  );
  suite.expectEqual(
    resolveSlackAudience("Leads", "marketplace"),
    "marketplace",
    "a marketplace Leads finding leaves the sales channel",
  );
});

await suite.test("resolves each audience to its own channel", async () => {
  suite.expectEqual(resolveSlackChannel("platform", null, ENV).channel, "C_PLATFORM", "platform");
  suite.expectEqual(resolveSlackChannel("calls", null, ENV).channel, "C_SALES", "sales");
  suite.expectEqual(resolveSlackChannel("cs", null, ENV).channel, "C_CS", "cs");
  suite.expectEqual(resolveSlackChannel("duplicates", "marketplace", ENV).channel, "C_MARKET", "marketplace");
});

await suite.test("falls back to SLACK_CHANNEL_ID when an audience is unconfigured", async () => {
  // Partial configuration must behave exactly like today rather than dropping
  // messages for the audiences that have no channel yet.
  const partial = { ...UNMUTED, SLACK_CHANNEL_ID: "C_LEGACY" } as NodeJS.ProcessEnv;
  suite.expectEqual(resolveSlackChannel("calls", null, partial).channel, "C_LEGACY", "sales falls back");
  suite.expectEqual(resolveSlackChannel("platform", null, partial).channel, "C_LEGACY", "platform falls back");
});

await suite.test("returns null when Slack is entirely unconfigured", async () => {
  // UNMUTED on purpose: without it this would pass because the channel is
  // muted, not because Slack is unconfigured — the same assertion for a
  // different reason, which is how a test stops testing anything.
  const none = { ...UNMUTED } as NodeJS.ProcessEnv;
  suite.expectEqual(resolveSlackChannel("platform", null, none).channel, null, "no channel");
});

await suite.test("SLACK_DEFAULT_CHANNEL is honoured as a last resort", async () => {
  const legacy = { ...UNMUTED, SLACK_DEFAULT_CHANNEL: "C_OLD" } as NodeJS.ProcessEnv;
  suite.expectEqual(resolveSlackChannel("qms", null, legacy).channel, "C_OLD", "default channel");
});

await suite.test("every audience has a distinct env var", async () => {
  const vars = Object.values(AUDIENCE_ENV_VAR);
  suite.expectEqual(new Set(vars).size, vars.length, "no duplicate env var names");
});

await suite.test("the env var names PRODUCTION actually has are the ones read", async () => {
  // Pinned deliberately. A transposed name (SDR_SALES vs SALES_SDR) does not
  // fail loudly — it falls through to SLACK_CHANNEL_ID and the messages quietly
  // keep going to the old shared channel. This caught exactly that on
  // 2026-09-07, after the secrets had already been created.
  const configured = {
    ...UNMUTED,
    SLACK_CHANNEL_PLATFORM: "C_P",
    SLACK_CHANNEL_SDR_SALES: "C_S",
    SLACK_CHANNEL_CS: "C_C",
    SLACK_CHANNEL_MARKETPLACE: "C_M",
    SLACK_CHANNEL_ID: "C_FALLBACK",
  } as NodeJS.ProcessEnv;
  suite.expectEqual(resolveSlackChannel("platform", null, configured).channel, "C_P", "platform");
  suite.expectEqual(resolveSlackChannel("calls", null, configured).channel, "C_S", "sdr/sales");
  suite.expectEqual(resolveSlackChannel("cs", null, configured).channel, "C_C", "cs");
  suite.expectEqual(resolveSlackChannel("marketplace", null, configured).channel, "C_M", "marketplace");
});

await suite.test("the legacy SALES_SDR spelling still resolves", async () => {
  // Kept working so a deployment configured against the original name does not
  // silently regress to the fallback channel.
  const legacy = {
    SLACK_CHANNEL_SALES_SDR: "C_OLDNAME",
    SLACK_CHANNEL_ID: "C_FALLBACK",
  } as NodeJS.ProcessEnv;
  suite.expectEqual(resolveSlackChannel("calls", null, legacy).channel, "C_OLDNAME", "alias honoured");
});

/* ── Platform-channel mute (Sarah 2026-09-07) ─────────────────────────────── */

const MUTED_ENV = {
  SLACK_CHANNEL_PLATFORM: "C_PLATFORM",
  SLACK_CHANNEL_SDR_SALES: "C_SALES",
  SLACK_CHANNEL_CS: "C_CS",
  SLACK_CHANNEL_MARKETPLACE: "C_MARKET",
  SLACK_CHANNEL_ID: "C_LEGACY",
} as NodeJS.ProcessEnv;

await suite.test("the mute is opt-IN — silence is the default", async () => {
  // Doing nothing gives silence; noise requires a deliberate act. Same shape as
  // HEALTH_PULSE_SLACK_ALERTS and FRAUD_REMINDERS_ENABLED.
  suite.expectEqual(platformAnnouncementsMuted({} as NodeJS.ProcessEnv), true, "unset");
  suite.expectEqual(
    platformAnnouncementsMuted({ PLATFORM_SLACK_ANNOUNCEMENTS: "" } as NodeJS.ProcessEnv),
    true,
    "empty",
  );
  suite.expectEqual(
    platformAnnouncementsMuted({ PLATFORM_SLACK_ANNOUNCEMENTS: "1" } as NodeJS.ProcessEnv),
    true,
    "1 is not true — only the literal word enables it",
  );
  suite.expectEqual(
    platformAnnouncementsMuted({ PLATFORM_SLACK_ANNOUNCEMENTS: "TRUE" } as NodeJS.ProcessEnv),
    false,
    "case-insensitive true",
  );
});

await suite.test("a muted platform channel resolves to null", async () => {
  // Null is what every existing sender already skips on, so the mute needed no
  // change at any call site.
  const r = resolveSlackChannel("platform", null, MUTED_ENV);
  suite.expectEqual(r.channel, null, "no channel");
  suite.expectEqual(r.muted, true, "reported as muted, not as unconfigured");
});

await suite.test("the mute NEVER touches the other three channels", async () => {
  // The regression that would matter most: silencing a team channel that has an
  // owner waiting on it. sales_sdr, cs and marketplace must be unaffected.
  suite.expectEqual(resolveSlackChannel("calls", null, MUTED_ENV).channel, "C_SALES", "sales");
  suite.expectEqual(resolveSlackChannel("cs", null, MUTED_ENV).channel, "C_CS", "cs");
  suite.expectEqual(
    resolveSlackChannel("duplicates", "marketplace", MUTED_ENV).channel,
    "C_MARKET",
    "marketplace",
  );
  for (const m of ["calls", "cs", "marketplace"]) {
    suite.expectEqual(resolveSlackChannel(m, null, MUTED_ENV).muted, false, `${m} not muted`);
  }
});

await suite.test("the mute also swallows UNROUTED alerts", async () => {
  // Stated as a test rather than left as a surprise: an unmapped module falls
  // through to platform, so while the mute is on it goes quiet too. That is the
  // cost of the mute, and it is why suppressions are counted.
  const r = resolveSlackChannel("some_new_module", null, MUTED_ENV);
  suite.expectEqual(r.audience, "platform", "unmapped still routes to platform");
  suite.expectEqual(r.muted, true, "and is muted with it");
});

await suite.test("ignoreMute reports the real wiring", async () => {
  // What GET /api/admin/slack-routing needs: a muted channel must still be
  // shown as configured, or "muted" reads as "broken".
  const r = resolveSlackChannel("platform", null, MUTED_ENV, { ignoreMute: true });
  suite.expectEqual(r.channel, "C_PLATFORM", "real channel");
  suite.expectEqual(r.muted, true, "still reported as muted");
});

await suite.test("suppressed posts are counted, not silently dropped", async () => {
  // The whole point of the counter: telling "the channel is quiet" apart from
  // "the sender is broken".
  __resetSuppressedPlatformPosts();
  suite.expectEqual(getSuppressedPlatformPosts().count, 0, "starts empty");
  noteSuppressedPlatformPost("Resolution digest — morning", "duplicates");
  noteSuppressedPlatformPost("Weekly Leadership Brief", "duplicates");
  const s = getSuppressedPlatformPosts();
  suite.expectEqual(s.count, 2, "counted");
  suite.expectEqual(s.recent[0].title, "Weekly Leadership Brief", "newest first");
  suite.expectEqual(s.recent[1].module, "duplicates", "module retained");
  __resetSuppressedPlatformPosts();
});

await suite.test("the suppression log is bounded", async () => {
  // It runs for the life of the process; an unbounded array would grow forever.
  __resetSuppressedPlatformPosts();
  for (let i = 0; i < 50; i++) noteSuppressedPlatformPost(`post ${i}`, "platform");
  const s = getSuppressedPlatformPosts();
  suite.expectEqual(s.count, 50, "count keeps rising");
  suite.expectEqual(s.recent.length, 20, "but only the last 20 are kept");
  suite.expectEqual(s.recent[0].title, "post 49", "newest retained");
  __resetSuppressedPlatformPosts();
});

suite.finishOrExit();
