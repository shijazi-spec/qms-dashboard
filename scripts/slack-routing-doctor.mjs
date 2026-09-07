#!/usr/bin/env node
/**
 * Show where each audience's Slack notifications will actually land.
 *
 * Written because a notification kept arriving in the wrong channel and the
 * cause was invisible from both ends: the code looked right, the secrets looked
 * set, and the only symptom was a message in the wrong place. A mis-typed or
 * empty audience variable does not error — it silently falls back to
 * SLACK_CHANNEL_ID, which is exactly what "wrong channel" looks like.
 *
 * This resolves each audience with the SAME precedence the app uses and, when
 * the token allows, resolves each id to its human channel NAME so you can see
 * at a glance whether platform alerts are pointed at the platform channel.
 *
 * Reads only. Sends nothing, changes nothing.
 *
 * Usage (Replit shell):
 *   node scripts/slack-routing-doctor.mjs
 */

// Mirrors AUDIENCE_ENV_VARS in src/utils/slackChannelRouting.ts.
const AUDIENCES = [
  { name: "platform", vars: ["SLACK_CHANNEL_PLATFORM"], gets: "health pulse, KPIs, radar ops, fraud, security, anything unmapped" },
  { name: "sales_sdr", vars: ["SLACK_CHANNEL_SDR_SALES", "SLACK_CHANNEL_SALES_SDR"], gets: "Leads/Deals/Accounts/Contacts findings, calls, CRM" },
  { name: "cs", vars: ["SLACK_CHANNEL_CS"], gets: "CS lifecycle, pipeline overlap" },
  { name: "marketplace", vars: ["SLACK_CHANNEL_MARKETPLACE"], gets: "marketplace-layout findings" },
];

// Feature-specific overrides that bypass the audience router entirely.
const DIRECT = [
  { varName: "DIRECT_AUDIT_SLACK_CHANNEL", what: "full audit report", fallsBackTo: "SLACK_CHANNEL_ID" },
  { varName: "AUTONOMOUS_RESOLUTION_SLACK_CHANNEL", what: "radar digest / merge-applied", fallsBackTo: "hardcoded default" },
  { varName: "DIGEST_SLACK_CHANNEL", what: "executive digests", fallsBackTo: "SLACK_CHANNEL_ID" },
  { varName: "SLACK_QMS_CHANNEL", what: "infographics", fallsBackTo: "SLACK_CHANNEL_ID" },
];

const TOKEN = process.env.SLACK_BOT_TOKEN;
const val = (n) => (process.env[n] || "").trim();

const nameCache = new Map();
async function channelName(id) {
  if (!id) return null;
  if (nameCache.has(id)) return nameCache.get(id);
  if (!TOKEN) return null;
  try {
    const res = await fetch(
      `https://slack.com/api/conversations.info?channel=${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    const body = await res.json();
    const name = body.ok ? `#${body.channel?.name}` : `(${body.error})`;
    nameCache.set(id, name);
    return name;
  } catch {
    return "(lookup failed)";
  }
}

const main = async () => {
  const fallback = val("SLACK_CHANNEL_ID") || val("SLACK_DEFAULT_CHANNEL");
  const fallbackName = await channelName(fallback);

  console.log("\n=== Slack routing ===\n");
  console.log(
    `Global fallback  SLACK_CHANNEL_ID = ${fallback || "(unset)"} ${fallbackName || ""}`,
  );
  console.log(
    "  Anything with no audience channel of its own lands here. If this is a\n" +
      "  business-unit channel, every unrouted alert lands in that team's feed.\n",
  );

  for (const a of AUDIENCES) {
    const hit = a.vars.find((v) => val(v));
    const id = hit ? val(hit) : fallback;
    const name = await channelName(id);
    const via = hit ? hit : `FALLBACK (${a.vars[0]} is unset)`;
    const flag = hit ? "" : "   <-- falls back";
    console.log(`${a.name.padEnd(12)} ${String(name || id || "(none)").padEnd(26)} via ${via}${flag}`);
    console.log(`             ${a.gets}`);
  }

  console.log("\n=== Feature overrides (these bypass the router) ===\n");
  for (const d of DIRECT) {
    const v = val(d.varName);
    const name = await channelName(v);
    console.log(
      `${d.varName.padEnd(38)} ${v ? `${v} ${name || ""}` : `(unset — uses ${d.fallsBackTo})`}`,
    );
    console.log(`  ${d.what}`);
  }

  console.log(
    "\nIf an audience shows 'falls back', its own variable is unset or empty —\n" +
      "that is the usual reason a message arrives in the wrong channel.\n",
  );
};

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});
