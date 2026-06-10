/**
 * GRQ Assistant — two-way Slack chat.
 *
 * Lets anyone in the resolution channel (Sarah, her manager) talk to the agent
 * in Slack: @mention the bot, address it by name ("GRQ" / "hey GRQ"), or DM it,
 * and it replies in-thread using the same GRQ Assistant brain (qmsConsultantAgent
 * — full QMS/compliance/CRM tools). Conversation memory is per Slack channel/
 * thread so it's an actual back-and-forth.
 *
 * Built on the existing registerSlackTrigger framework (handles Slack's URL
 * verification, dedup, and bot-loop guard). Registered at /webhooks/slack/action
 * — set that as the Event Subscriptions Request URL in the Slack app.
 *
 * Slack app setup (one-time): Event Subscriptions → Request URL
 * https://<host>/webhooks/slack/action → subscribe to bot events `app_mention`
 * (and `message.channels` for the name trigger, `message.im` for DMs) → reinstall.
 * Scopes: chat:write, app_mentions:read, channels:history, im:history.
 */

import type { ApiRoute } from "@mastra/core/server";
import { registerSlackTrigger, getClient } from "./slackTriggers";

// Address-by-name trigger: "Adam" (the agent's name) or "GRQ", optionally greeted.
const NAME_TRIGGER = /(^|\s)(hey\s+|hi\s+|hello\s+)?@?(adam|grq)(\s+assistant)?\b/i;

/** Best-effort text extraction across Mastra's several result shapes. */
async function extractAgentText(res: any): Promise<string> {
  if (!res) return "";
  if (typeof res === "string") return res;
  if (typeof res.text === "string") return res.text;
  if (res.text && typeof res.text.then === "function") {
    try { return String((await res.text) ?? ""); } catch { /* fall through */ }
  }
  if (typeof res.content === "string") return res.content;
  if (Array.isArray(res.content)) {
    return res.content.map((p: any) => (p && typeof p.text === "string" ? p.text : "")).join("");
  }
  if (res.response && typeof res.response.text === "string") return res.response.text;
  return "";
}

export function registerGrqAssistantSlackRoutes(): ApiRoute[] {
  return registerSlackTrigger({
    triggerType: "slack/grq-assistant",
    handler: (async (mastra: any, triggerInfo: any) => {
      try {
        const event = triggerInfo?.payload?.event || {};
        const rawText = String(event.text || "").trim();
        const channel = event.channel;
        if (!channel || !rawText) return null;

        const isMention = event.type === "app_mention";
        const isDM = event.channel_type === "im";
        const addressed = isMention || isDM || NAME_TRIGGER.test(rawText);
        if (!addressed) return null; // only reply when actually spoken to

        // Strip the <@bot> mention token and a leading "GRQ"/greeting prefix.
        let q = rawText
          .replace(/<@[A-Z0-9]+>/gi, " ")
          .replace(/^\s*(hey|hi|hello)?\s*@?(adam|grq)(\s+assistant)?\s*[:,]?\s*/i, "")
          .trim();
        if (!q) q = "Hello";

        const agent = mastra?.getAgent?.("qmsConsultantAgent");
        const { slack } = await getClient();
        const threadTs = event.thread_ts || event.ts;

        if (!agent) {
          await slack.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: "GRQ Assistant isn't available right now — please try again shortly.",
          });
          return null;
        }

        let reply = "";
        try {
          // Per-channel memory so it's a continuous conversation; per-user
          // resource keeps each person's context separate.
          const res = await agent.generate([{ role: "user", content: q }], {
            threadId: `slack-${channel}`,
            resourceId: `slack-user-${event.user || channel}`,
            maxSteps: 6,
          });
          reply = (await extractAgentText(res)).trim();
        } catch (e: any) {
          reply = `Sorry — I hit an error answering that: ${e?.message || String(e)}`;
        }
        if (!reply) reply = "I didn't catch that — could you rephrase?";

        await slack.chat.postMessage({ channel, thread_ts: threadTs, text: reply });
        return null;
      } catch {
        // Never throw out of the webhook (it would 500 to Slack and trigger retries).
        return null;
      }
    }) as any,
  } as any);
}
