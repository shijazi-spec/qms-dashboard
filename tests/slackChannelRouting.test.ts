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
 * Nothing is muted unless PLATFORM_SLACK_MUTE is explicitly "true", so the
 * routing fixtures below need no mute flag at all — the empty default is the
 * working default. Kept as an empty object rather than deleted so the contrast
 * with MUTED_ENV stays visible at the bottom of the file.
 */
const UNMUTED = {};

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
  // Null here must mean "no channel configured", never "muted" — the mute has
  // its own assertions below, and one test proving two different things is how
  // a test stops testing either.
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

/* ── Platform-channel mute — OFF unless deliberately switched on ──────────── */

const MUTED_ENV = {
  PLATFORM_SLACK_MUTE: "true",
  SLACK_CHANNEL_PLATFORM: "C_PLATFORM",
  SLACK_CHANNEL_SDR_SALES: "C_SALES",
  SLACK_CHANNEL_CS: "C_CS",
  SLACK_CHANNEL_MARKETPLACE: "C_MARKET",
  SLACK_CHANNEL_ID: "C_LEGACY",
} as NodeJS.ProcessEnv;

await suite.test("NOTHING is muted by default", async () => {
  // The test that would have caught the 2026-09-07 mistake. This shipped once
  // with the opposite polarity — an opt-IN switch that silenced the entire
  // platform channel unless a secret was set — and it took months of working
  // reporting off Slack with it. A switch that turns things OFF must never be
  // what happens when nobody chooses.
  suite.expectEqual(platformAnnouncementsMuted({} as NodeJS.ProcessEnv), false, "unset");
  suite.expectEqual(
    platformAnnouncementsMuted({ PLATFORM_SLACK_MUTE: "" } as NodeJS.ProcessEnv),
    false,
    "empty",
  );
  suite.expectEqual(
    platformAnnouncementsMuted({ PLATFORM_SLACK_MUTE: "false" } as NodeJS.ProcessEnv),
    false,
    "explicitly false",
  );
  suite.expectEqual(
    platformAnnouncementsMuted({ PLATFORM_SLACK_MUTE: "1" } as NodeJS.ProcessEnv),
    false,
    "1 does not mute — only the literal word",
  );
  suite.expectEqual(
    platformAnnouncementsMuted({ PLATFORM_SLACK_MUTE: "TRUE" } as NodeJS.ProcessEnv),
    true,
    "case-insensitive true DOES mute",
  );
});

await suite.test("the platform channel posts normally with no mute set", async () => {
  // The regression that actually cost something: the digest, the merge-applied
  // ping, the weekly brief and the KPI results all route here.
  const r = resolveSlackChannel("platform", null, ENV);
  suite.expectEqual(r.channel, "C_PLATFORM", "platform still posts");
  suite.expectEqual(r.muted, false, "not muted");
  suite.expectEqual(resolveSlackChannel("duplicates", null, ENV).channel, "C_PLATFORM", "radar ops");
  suite.expectEqual(resolveSlackChannel("kpis", null, ENV).channel, "C_PLATFORM", "kpis");
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
