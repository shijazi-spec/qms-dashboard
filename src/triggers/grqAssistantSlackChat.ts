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
import { withAgentUserContext } from "../utils/withApprovalGate";
import { buildAiCallTelemetryMetadata, withAiTelemetry } from "../utils/aiTelemetry";
import { QMS_CONSULTANT_PROMPT_VERSION } from "../mastra/agents/qmsConsultantAgent";

// Role Adam runs AS when answering in Slack. The platform's data tools are
// RBAC-gated by the caller's role (via withAgentUserContext); without a context
// the role is "unknown" and every QMS query is denied — which is why Adam said
// "role-based access restrictions" in Slack. Slack has no platform login, so we
// run him at a FIXED role. Default = head_of_operations_quality (read access to
// Risks/Policies/Audits/Compliance/KPIs/Vendors; NOT the admin-only NC/CAPA/
// Training). EVERYONE in the (private) Slack channel inherits this access level
// — Sarah's governance decision (2026-06-11). Override via SLACK_ADAM_ROLE.
// Write tools stay approval-gated (autoApproveTier "never") so nothing executes
// from Slack without landing in the platform AI Approvals queue.
const SLACK_ADAM_ROLE = process.env.SLACK_ADAM_ROLE || "head_of_operations_quality";

/**
 * Tool-call iterations Adam gets per Slack question (Sarah 2026-08-30).
 *
 * Was 6, which silently capped LIST questions: asked to check ~56 companies,
 * Adam picked a per-company lookup tool, burned the budget after ~10, then
 * closed with "let me know if you need checks on additional companies" and
 * hedged about "limitations in data access". The same question in the web chat
 * came back complete, which is what made it look like Slack was restricted —
 * it wasn't permissions (Slack runs at the SAME role, above) or a shorter
 * budget than the web (Mastra's default is only 5); it was that this surface
 * needs MORE room, not less, because bulk questions arrive here as one pasted
 * list. This handler runs as a background job (the webhook already ack'd), so
 * extra steps cost latency/tokens, not a Slack timeout.
 */
const SLACK_AGENT_MAX_STEPS = Number(process.env.SLACK_AGENT_MAX_STEPS) || 14;

/** Slack truncates very long messages; split on line boundaries and post in
 *  order so a long answer arrives whole instead of being cut mid-list. */
const SLACK_MAX_CHARS = 3500;
export function splitForSlack(text: string, limit = SLACK_MAX_CHARS): string[] {
  const body = String(text ?? "");
  if (body.length <= limit) return [body];
  const chunks: string[] = [];
  let current = "";
  for (const line of body.split("\n")) {
    // A single line longer than the limit is hard-split so nothing is dropped.
    if (line.length > limit) {
      if (current) { chunks.push(current); current = ""; }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    if (current.length + line.length + 1 > limit) { chunks.push(current); current = line; }
    else current = current ? current + "\n" + line : line;
  }
  if (current) chunks.push(current);
  return chunks;
}

// Address-by-name trigger: "Adam" (the agent's name) or "GRQ", optionally greeted.
const NAME_TRIGGER = /(^|\s)(hey\s+|hi\s+|hello\s+)?@?(adam|grq)(\s+assistant)?\b/i;

/**
 * Provider rate-limit handling (Sarah 2026-07-20).
 *
 * Adam's request is large (big system prompt + many tool schemas), so on a low
 * TPM tier a single call can trip OpenAI's per-minute token cap and the raw
 * provider error was being posted straight into the channel — including the
 * OpenAI ORG ID. We now (a) retry after the delay the provider suggests, and
 * (b) never echo the raw provider text.
 */
function isRateLimitError(e: any): boolean {
  const s = `${e?.message || ""} ${e?.status || ""} ${e?.statusCode || ""} ${e?.code || ""}`;
  return /rate[ _-]?limit|429|tokens per min|\bTPM\b/i.test(s);
}

/** Seconds the provider asked us to wait ("Please try again in 11.064s"). */
function suggestedRetrySeconds(e: any): number {
  const m = /try again in ([\d.]+)\s*s/i.exec(String(e?.message || ""));
  const secs = m ? parseFloat(m[1]) : NaN;
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs, 30);
  return 12; // sensible default for a per-minute token cap
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the agent, retrying transient provider rate limits with the delay the
 * provider suggests (+ a small buffer). Throws the last error if it never
 * succeeds so the caller can post a sanitized message.
 */
async function generateWithRateLimitRetry<T>(
  run: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await run();
    } catch (e: any) {
      lastErr = e;
      if (!isRateLimitError(e) || attempt === maxAttempts) throw e;
      await sleep(Math.round(suggestedRetrySeconds(e) * 1000) + 750);
    }
  }
  throw lastErr;
}

/**
 * Operator-facing error text. NEVER include the raw provider message — it can
 * carry the OpenAI org id / account internals into a chat channel.
 */
function friendlyAgentError(e: any): string {
  if (isRateLimitError(e)) {
    return "I'm hitting the AI rate limit right now (too many tokens per minute). Give me about a minute and ask again — if it keeps happening the model's per-minute limit needs raising.";
  }
  return "Sorry — I couldn't answer that just now. Please try again in a moment.";
}

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

        // Mastra Memory ties a thread to ONE resource. The thread is therefore
        // keyed per-CHANNEL-and-USER and the resource per-USER, so each person
        // owns their own thread + their own working memory (no cross-user
        // ownership clash, and PDPL-cleaner — one user's memory never bleeds
        // into another's). NOTE: the older per-channel-only threadId
        // (`slack-<channel>`) got stamped with the first speaker's resource;
        // this per-user namespace deliberately starts fresh threads so that
        // legacy "thread owned by another resource" error can't recur.
        const slackUser = event.user || channel;
        const convThreadId = `slack-${channel}-${slackUser}`;
        const convResourceId = `slack-user-${slackUser}`;

        let reply = "";
        try {
          // withAgentUserContext threads a role into the tool layer so Adam's
          // RBAC-gated platform-data tools actually return data (mirrors what
          // the web /api/consultant/chat route does for a logged-in user).
          void import("../utils/adamTopicLog").then(({ recordQuestionSection }) =>
            recordQuestionSection(q, { surface: "slack", askedBy: `slack-${slackUser}` }),
          ).catch(() => {});
          const res = await generateWithRateLimitRetry(async () => {
            // Record the CALL in ai_call_metrics — tokens, latency, cost and,
            // critically, the 429s. The web chat route has always done this;
            // Slack did not, so every Slack question was invisible to AI
            // Operations and a rate-limit burst here left nothing to diagnose
            // (Sarah 2026-09-02, after Adam answered "I'm hitting the AI rate
            // limit" in #grq-assistant and the table held no row for it).
            //
            // Wrapped INSIDE the retry on purpose: each attempt gets its own
            // row, so a rate-limited turn shows all three tries rather than
            // only the one that finally succeeded.
            //
            // NO promptText is passed. Slack questions carry client company
            // names, phone numbers and pasted lists; we record that a call
            // happened and what it cost, never the words — the same rule as
            // adam_topic_log. Telemetry failures are swallowed inside
            // openAiCallMetric/finalizeAiCallMetric, so this can never break
            // a chat turn.
            const { result } = await withAiTelemetry(
              {
                agentName: "WalaPlus QMS Consultant",
                model: "gpt-4o",
                userId: `slack-${slackUser}`,
                sessionId: convThreadId,
                metadata: buildAiCallTelemetryMetadata({
                  promptVersion: QMS_CONSULTANT_PROMPT_VERSION,
                  clientSurface: "slack",
                }),
              },
              () =>
                withAgentUserContext(
                  {
                    user: {
                      userId: null,
                      email: `slack-${slackUser}`,
                      role: SLACK_ADAM_ROLE,
                      autoApproveTier: "never",
                    },
                    threadId: convThreadId,
                  },
                  () =>
                    agent.generate([{ role: "user", content: q }], {
                      threadId: convThreadId,
                      resourceId: convResourceId,
                      maxSteps: SLACK_AGENT_MAX_STEPS,
                    }),
                ),
            );
            return result;
          });
          reply = (await extractAgentText(res)).trim();
        } catch (e: any) {
          reply = friendlyAgentError(e);
        }
        if (!reply) reply = "I didn't catch that — could you rephrase?";

        for (const part of splitForSlack(reply)) {
          await slack.chat.postMessage({ channel, thread_ts: threadTs, text: part });
        }
        return null;
      } catch {
        // Never throw out of the webhook (it would 500 to Slack and trigger retries).
        return null;
      }
    }) as any,
  } as any);
}
