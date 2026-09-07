#!/usr/bin/env node
/**
 * Delete messages THIS BOT posted to a Slack channel.
 *
 * Written because the platform posted duplicate reminders that could not be
 * removed from the Slack UI: messages posted by an app are not deletable by
 * ordinary workspace members, and some workspaces disable it entirely. Slack
 * does allow a bot to delete its OWN messages with the same token it posted
 * them with, which is what this uses.
 *
 * SAFETY, deliberately blunt:
 *   · DRY RUN by default. Nothing is deleted without --apply.
 *   · Only messages posted by this bot are ever touched. Human messages are
 *     skipped even when they match, and the script will not delete a message
 *     it cannot prove the bot authored.
 *   · --match is REQUIRED. There is no "delete everything" mode.
 *   · --channel is REQUIRED. It never guesses from env.
 *
 * Needs SLACK_BOT_TOKEN, plus the bot must be IN the channel and have history
 * scope for it: channels:history for public channels, groups:history for
 * private ones. chat:write it already has, since it posted.
 *
 * Usage (from the Replit shell, where SLACK_BOT_TOKEN is set):
 *
 *   # see what would go
 *   node scripts/slack-delete-bot-messages.mjs --channel C0123 --match "Country Risk Register"
 *
 *   # actually delete
 *   node scripts/slack-delete-bot-messages.mjs --channel C0123 --match "Country Risk Register" --apply
 *
 *   # narrow to today
 *   node scripts/slack-delete-bot-messages.mjs --channel C0123 --match "Platform Health" --hours 12
 */

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APPLY = process.argv.includes("--apply");
const CHANNEL = arg("channel");
const MATCH = arg("match");
const HOURS = Number(arg("hours", "48"));
const LIMIT = Number(arg("limit", "200"));

/**
 * --link mode: delete specific messages by their Slack permalink.
 *
 * This exists because searching for the bot's own messages needs
 * conversations.history, and granting groups:history would give the bot
 * permanent read access to every private channel it sits in — a large, lasting
 * permission for a one-off cleanup. Deleting needs only chat:write, which the
 * bot already has because it posted.
 *
 * A permalink carries BOTH the channel and the timestamp:
 *   https://walaplus.slack.com/archives/C0123ABCD/p1757251234567890
 *                                       ^channel   ^ts (dot removed)
 * so nothing else has to be looked up. Get one via "Copy link" on the message.
 */
const LINKS = process.argv
  .filter((a) => a.includes("/archives/"))
  .map((raw) => {
    const m = raw.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/i);
    if (!m) return null;
    return { channel: m[1], ts: `${m[2]}.${m[3]}`, raw };
  })
  .filter(Boolean);

if (LINKS.length === 0 && (!CHANNEL || !MATCH)) {
  console.error(
    "Give it EITHER message links, or a channel + match.\n\n" +
      "  By link (no extra Slack scope needed — use 'Copy link' on each message):\n" +
      "    node scripts/slack-delete-bot-messages.mjs <link> <link> --apply\n\n" +
      "  By search (needs channels:history / groups:history):\n" +
      '    node scripts/slack-delete-bot-messages.mjs --channel C0123 --match "Country Risk Register" [--hours 48] [--apply]',
  );
  process.exit(2);
}

const TOKEN = process.env.SLACK_BOT_TOKEN;
if (!TOKEN) {
  console.error("SLACK_BOT_TOKEN is not set — nothing to authenticate with.");
  process.exit(2);
}

const api = async (method, payload, httpMethod = "POST") => {
  const url = `https://slack.com/api/${method}`;
  const res =
    httpMethod === "GET"
      ? await fetch(`${url}?${new URLSearchParams(payload)}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      : await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(payload),
        });
  const body = await res.json();
  if (!body.ok) throw new Error(`${method}: ${body.error}`);
  return body;
};

const main = async () => {
  // Who am I? Used to prove authorship before deleting anything.
  const me = await api("auth.test", {}, "GET");
  const myBotId = me.bot_id;
  const myUserId = me.user_id;
  console.log(`Authenticated as ${me.user} (bot_id=${myBotId}) in ${me.team}`);

  // ---- link mode: delete exactly what was named, nothing else -------------
  if (LINKS.length > 0) {
    console.log(`\n${LINKS.length} message(s) named by link:\n`);
    for (const l of LINKS) {
      console.log(
        `  ${APPLY ? "DELETE" : "would delete"}  channel=${l.channel} ts=${l.ts}  (${new Date(Number(l.ts) * 1000).toISOString()})`,
      );
    }
    if (!APPLY) {
      console.log(`\nDRY RUN — nothing deleted. Add --apply to delete these.`);
      return;
    }
    let ok = 0;
    for (const l of LINKS) {
      try {
        await api("chat.delete", { channel: l.channel, ts: l.ts });
        ok++;
        await new Promise((r) => setTimeout(r, 1200));
      } catch (err) {
        // cant_delete_message means the bot did not author it — that is the
        // guard doing its job, not a bug to work around.
        console.error(`  failed ts=${l.ts}: ${err.message}`);
      }
    }
    console.log(`\nDeleted ${ok}/${LINKS.length}.`);
    return;
  }

  const oldest = ((Date.now() - HOURS * 3600 * 1000) / 1000).toFixed(6);
  const history = await api(
    "conversations.history",
    { channel: CHANNEL, oldest, limit: String(LIMIT) },
    "GET",
  );

  const candidates = (history.messages || []).filter((m) => {
    const mine = m.bot_id === myBotId || m.user === myUserId;
    if (!mine) return false;
    const haystack = [
      m.text || "",
      ...(m.blocks || []).map((b) => JSON.stringify(b)),
      ...(m.attachments || []).map((a) => JSON.stringify(a)),
    ].join(" ");
    return haystack.includes(MATCH);
  });

  const skippedHuman = (history.messages || []).filter(
    (m) => !(m.bot_id === myBotId || m.user === myUserId) && (m.text || "").includes(MATCH),
  ).length;

  console.log(
    `\nScanned ${history.messages?.length ?? 0} message(s) from the last ${HOURS}h in ${CHANNEL}.`,
  );
  console.log(`Matching THIS bot's messages: ${candidates.length}`);
  if (skippedHuman > 0) {
    console.log(`Skipped ${skippedHuman} matching message(s) posted by humans — never touched.`);
  }

  for (const m of candidates) {
    const when = new Date(Number(m.ts) * 1000).toISOString();
    const preview = (m.text || "(blocks only)").replace(/\s+/g, " ").slice(0, 90);
    console.log(`  ${APPLY ? "DELETE" : "would delete"}  ${when}  ${preview}`);
  }

  if (!APPLY) {
    console.log(
      `\nDRY RUN — nothing deleted. Re-run with --apply to delete these ${candidates.length} message(s).`,
    );
    return;
  }

  let deleted = 0;
  for (const m of candidates) {
    try {
      await api("chat.delete", { channel: CHANNEL, ts: m.ts });
      deleted++;
      // Slack rate-limits chat.delete; stay well under it.
      await new Promise((r) => setTimeout(r, 1200));
    } catch (err) {
      console.error(`  failed ts=${m.ts}: ${err.message}`);
    }
  }
  console.log(`\nDeleted ${deleted}/${candidates.length}.`);
};

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  if (/missing_scope|not_in_channel|channel_not_found/.test(err.message)) {
    console.error(
      "The bot needs to BE in the channel and hold history scope:\n" +
        "  private channel → groups:history   public channel → channels:history\n" +
        "Add the scope in the Slack app config, reinstall the app, then retry.",
    );
  }
  process.exit(1);
});
