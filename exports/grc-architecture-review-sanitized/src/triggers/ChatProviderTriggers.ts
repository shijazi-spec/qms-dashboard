/**
 * ChatProvider Trigger - Webhook-based Workflow Triggering
 *
 * This module provides ChatProvider event handling for Mastra workflows.
 * When ChatProvider events occur (like new messages), this trigger starts your workflow.
 *
 * PATTERN:
 * 1. Import registerChatProviderTrigger and your workflow
 * 2. Call registerChatProviderTrigger with a triggerType and handler
 * 3. Spread the result into the apiRoutes array in src/mastra/index.ts
 *
 * USAGE in src/mastra/index.ts:
 *
 * ```typescript
 * import { registerChatProviderTrigger } from "../triggers/ChatProviderTriggers";
 * import { ChatProviderBotWorkflow } from "./workflows/ChatProviderBotWorkflow";
 *
 * // In the apiRoutes array:
 * ...registerChatProviderTrigger({
 *   triggerType: "ChatProvider/message.channels",
 *   handler: async (mastra, triggerInfo) => {
 *     const threadId = `ChatProvider-${triggerInfo.params.channel}`;
 *     const run = await ChatProviderBotWorkflow.createRunAsync();
 *     return await run.start({ inputData: { threadId } });
 *   }
 * })
 * ```
 */

import { format, promisify } from "node:util";
import { execFile } from "node:child_process";
import { Mastra, type WorkflowResult, type Step } from "@mastra/core";
import { IMastraLogger } from "@mastra/core/logger";
import {
  type AuthTestResponse,
  type ChatPostMessageResponse,
  type ConversationsOpenResponse,
  type ConversationsRepliesResponse,
  type UsersConversationsResponse,
  type WebAPICallError,
  ErrorCode,
  WebClient,
} from "@ChatProvider/web-api";
import type { Context, Handler, MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import type { z } from "zod";

import { registerApiRoute } from "../mastra/inngest";

import { logger as safeLogger } from "../utils/logger";
import { verifyChatProviderSignature } from "./ChatProviderConsultantRatingTrigger";
export type Methods = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "ALL";

// TODO: Remove when Mastra exports this type.
export type ApiRoute =
  | {
      path: string;
      method: Methods;
      handler: Handler;
      middleware?: MiddlewareHandler | MiddlewareHandler[];
    }
  | {
      path: string;
      method: Methods;
      createHandler: ({ mastra }: { mastra: Mastra }) => Promise<Handler>;
      middleware?: MiddlewareHandler | MiddlewareHandler[];
    };

export type TriggerInfoChatProviderOnNewMessage = {
  type: "ChatProvider/message.channels";
  params: {
    channel: string;
    channelDisplayName: string;
  };
  payload: any;
};

type DiagnosisStep =
  | {
      status: "pending";
      name: string;
      extra?: Record<string, any>;
    }
  | {
      status: "success";
      name: string;
      extra: Record<string, any>;
    }
  | {
      status: "failed";
      name: string;
      error: string;
      extra: Record<string, any>;
    };

export async function getClient() {
  let connectionSettings: any;
  async function getAccessToken() {
    if (
      connectionSettings &&
      connectionSettings.settings.expires_at &&
      new Date(connectionSettings.settings.expires_at).getTime() > Date.now()
    ) {
      return {
        token: <REDACTED_SECRET>
        user: connectionSettings.settings.oauth?.credentials?.raw?.authed_user
          ?.id,
      };
    }

    const hostname = process.env.HostingPlatform_CONNECTORS_HOSTNAME;
    if (hostname) {
      try {
        const { stdout } = await promisify(execFile)(
          "HostingPlatform",
          ["identity", "create", "--audience", `<REDACTED_URL>`],
          { encoding: "utf8" },
        );

        const HostingPlatformToken = stdout.trim();
        if (HostingPlatformToken) {
          const res = await fetch(
            "<REDACTED_URL_SCHEME>" +
              hostname +
              "/api/v2/connection?include_secrets=true&connector_names=ChatProvider-agent",
            {
              headers: {
                Accept: "application/json",
                "HostingPlatform-Authentication": `Bearer ${HostingPlatformToken}`,
              },
            },
          );
          const resJson = await res.json();
          connectionSettings = resJson?.items?.[0];
          if (connectionSettings?.settings?.access_token) {
            return {
              token: <REDACTED_SECRET>
              user: connectionSettings.settings.oauth?.credentials?.raw
                ?.authed_user?.id,
            };
          }
        }
      } catch (connectorError) {
        safeLogger.info(
          "[ChatProvider] HostingPlatform connector not available, checking ChatProvider_BOT_TOKEN env var...",
        );
      }
    }

    const envToken = process.env.ChatProvider_BOT_TOKEN || process.env.ChatProvider_API_TOKEN;
    if (envToken) {
      safeLogger.info("[ChatProvider] Using ChatProvider_BOT_TOKEN from environment");
      return { token: envToken, user: undefined };
    }

    throw new Error(
      "ChatProvider not connected: No HostingPlatform ChatProvider connector and no ChatProvider_BOT_TOKEN environment variable set",
    );
  }

  const { token, user } = await getAccessToken();
  const ChatProvider = new WebClient(token);

  const response = await ChatProvider.auth.test();

  return { ChatProvider, auth: response, user };
}

// Keep up to 200 recent events, to prevent duplicates
const recentEvents: string[] = [];

function isWebAPICallError(err: unknown): err is WebAPICallError {
  return (
    err !== null && typeof err === "object" && "code" in err && "data" in err
  );
}

function checkDuplicateEvent(eventName: string) {
  if (recentEvents.includes(eventName)) {
    return true;
  }
  recentEvents.push(eventName);
  if (recentEvents.length > 200) {
    recentEvents.shift();
  }
  return false;
}

function createReactToMessage<
  TState extends z.ZodObject<any>,
  TInput extends z.ZodType<any>,
  TOutput extends z.ZodType<any>,
  TSteps extends Step<string, any, any>[],
>({ ChatProvider, logger }: { ChatProvider: WebClient; logger: IMastraLogger }) {
  const addReaction = async (
    channel: string,
    timestamp: string,
    emoji: string,
  ) => {
    logger.info(`[ChatProvider] Adding reaction to message`, {
      emoji,
      timestamp,
      channel,
    });
    try {
      await ChatProvider.reactions.add({ channel, timestamp, name: emoji });
    } catch (error) {
      logger.error(`[ChatProvider] Error adding reaction to message`, {
        emoji,
        timestamp,
        channel,
        error: format(error),
      });
    }
  };

  const removeAllReactions = async (channel: string, timestamp: string) => {
    logger.info(`[ChatProvider] Removing all reactions from message`, {
      timestamp,
      channel,
    });
    const emojis = [
      "hourglass",
      "hourglass_flowing_sand",
      "white_check_mark",
      "x",
      "alarm_clock",
    ];

    for (const emoji of emojis) {
      try {
        await ChatProvider.reactions.remove({ channel, timestamp, name: emoji });
      } catch (error) {
        if (
          isWebAPICallError(error) &&
          (error.code !== ErrorCode.PlatformError ||
            error.data?.error !== "no_reaction")
        ) {
          logger.error("[ChatProvider] Error removing reaction", {
            emoji,
            timestamp,
            channel,
            error: format(error),
          });
        }
      }
    }
  };

  return async function reactToMessage(
    channel: string,
    timestamp: string,
    result: WorkflowResult<TState, TInput, TOutput, TSteps> | null,
  ) {
    // Remove all of our reactions.
    await removeAllReactions(channel, timestamp);
    if (result?.status === "success") {
      await addReaction(channel, timestamp, "white_check_mark");
    } else if (result?.status === "failed") {
      await addReaction(channel, timestamp, "x");
    } else if (result !== null) {
      await addReaction(channel, timestamp, "alarm_clock");
    }
  };
}

export function registerChatProviderTrigger<
  Env extends { Variables: { mastra: Mastra } },
  TState extends z.ZodObject<any>,
  TInput extends z.ZodType<any>,
  TOutput extends z.ZodType<any>,
  TSteps extends Step<string, any, any>[],
>({
  triggerType,
  handler,
}: {
  triggerType: string;
  handler: (
    mastra: Mastra,
    triggerInfo: TriggerInfoChatProviderOnNewMessage,
  ) => Promise<WorkflowResult<TState, TInput, TOutput, TSteps> | null>;
}): Array<ApiRoute> {
  const ChatProviderWebhookHandler = async (c: Context<Env>): Promise<Response> => {
    const mastra = c.get("mastra");
    const logger = mastra.getLogger();
    try {
      // ── ChatProvider request authentication ────────────────────────────────
      // ChatProvider (not a browser) posts here with no platform session, so the
      // ONLY thing standing between an attacker and this workflow-triggering
      // endpoint is ChatProvider's request signature. Verify it over the RAW body
      // BEFORE parsing, and fail closed when the signing secret is absent —
      // mirroring handleChatProviderConsultantRatingRequest. Accepting unsigned
      // requests would let anyDocumentStorageProvider the ChatProvider bot / workflow handler.
      const signingSecret = process.env.ChatProvider_SIGNING_SECRET;
      if (!signingSecret) {
        logger?.warn(
          "[ChatProvider] ChatProvider_SIGNING_SECRET not configured; rejecting webhook",
        );
        return c.text("ChatProvider signing secret not configured", 503);
      }
      const rawBody = await c.req.text();
      const signature = c.req.header("x-ChatProvider-signature") ?? "";
      const timestamp = c.req.header("x-ChatProvider-request-timestamp") ?? "";
      if (
        !verifyChatProviderSignature({ signingSecret, timestamp, signature, rawBody })
      ) {
        logger?.warn("[ChatProvider] Invalid ChatProvider signature");
        return c.text("Invalid signature", 401);
      }

      let payload: any;
      try {
        payload = rawBody.length > 0 ? JSON.parse(rawBody) : {};
      } catch (parseErr) {
        logger?.warn("[ChatProvider] Failed to parse webhook payload", {
          error: format(parseErr),
        });
        return c.text("Malformed payload", 400);
      }

      if (payload && payload["challenge"]) {
        return c.text(payload["challenge"], 200);
      }

      const { ChatProvider, auth } = await getClient();
      const reactToMessage = createReactToMessage({ ChatProvider, logger });

      logger?.info("📝 [ChatProvider] payload", { payload });

      if (payload && payload.event && payload.event.channel) {
        try {
          const result = await ChatProvider.conversations.info({
            channel: payload.event.channel,
          });
          logger?.info("📝 [ChatProvider] result", { result });
          payload.channel = result.channel;
        } catch (error) {
          logger?.error("Error fetching channel info", {
            error: format(error),
          });
        }
      }

      if (
        payload.event?.subtype === "message_changed" ||
        payload.event?.subtype === "message_deleted"
      ) {
        return c.text("OK", 200);
      }

      if (
        (payload.event?.channel_type === "im" &&
          payload.event?.text === "test:ping") ||
        payload.event?.text === `<@${auth.user_id}> test:ping`
      ) {
        await ChatProvider.chat.postMessage({
          channel: payload.event.channel,
          text: "pong",
          thread_ts: payload.event.ts,
        });
        logger?.info("📝 [ChatProvider] pong");
        return c.text("OK", 200);
      }

      if (payload.event?.bot_id) {
        return c.text("OK", 200);
      }

      if (checkDuplicateEvent(payload.event_id)) {
        return c.text("OK", 200);
      }

      const result = await handler(mastra, {
        type: triggerType,
        params: {
          channel: payload.event.channel,
          // Optional-chained: in PRIVATE channels (and any case where
          // conversations.info fails for lack of groups:read), payload.channel
          // is undefined. Reading `.name` directly would throw and 500 the
          // whole request — so the bot would silently never reply in a private
          // channel even though it's a member. The display name is non-essential.
          channelDisplayName: payload.channel?.name ?? "",
        },
        payload,
      } as TriggerInfoChatProviderOnNewMessage);

      // Best-effort reaction emoji — must NOT throw after the handler already
      // replied. A missing reactions:write scope would otherwise 500 the
      // request, making ChatProvider retry and the bot post duplicate answers.
      try {
        await reactToMessage(payload.event.channel, payload.event.ts, result);
      } catch (reactErr) {
        logger?.error("ChatProvider reaction failed (non-fatal)", { error: format(reactErr) });
      }

      return c.text("OK", 200);
    } catch (error) {
      logger?.error("Error handling ChatProvider webhook", {
        error: format(error),
      });
      return c.text("Internal Server Error", 500);
    }
  };

  return [
    // registerApiRoute can return a sentinel string when called with a path
    // that starts with `/api` (reserved); ours starts with `/webhooks` so the
    // runtime branch we hit always returns an ApiRoute. The cast lets the
    // ApiRoute[] return type stay strict.
    registerApiRoute("/webhooks/ChatProvider/action", {
      method: "POST",
      // The hono `Handler` generic is parameterised by the literal path
      // string; the local handler's `Promise<Response>` shape is compatible
      // but TS can't see through the generic, so cast through Handler.
      handler: ChatProviderWebhookHandler as unknown as Handler,
    }) as ApiRoute,
    {
      path: "/api/webhooks/ChatProvider/action",
      method: "POST",
      handler: ChatProviderWebhookHandler,
    },
    {
      path: "/test/ChatProvider",
      method: "GET",
      handler: async (c: Context<Env>) => {
        return streamSSE(c, async (stream) => {
          let id = 1;
          const mastra = c.get("mastra");
          const logger = mastra.getLogger() ?? {
            info: (msg: string, ...args: unknown[]) =>
              safeLogger.info(msg, ...(args as [])),
            error: (msg: string, ...args: unknown[]) =>
              safeLogger.error(msg, ...(args as [])),
          };

          let diagnosisStepAuth: DiagnosisStep = {
            status: "pending",
            name: "authentication with ChatProvider",
          };
          let diagnosisStepConversation: DiagnosisStep = {
            status: "pending",
            name: "open a conversation with user",
          };
          let diagnosisStepPostMessage: DiagnosisStep = {
            status: "pending",
            name: "send a message to the user",
          };
          let diagnosisStepReadReplies: DiagnosisStep = {
            status: "pending",
            name: "read replies from bot",
          };
          const updateDiagnosisSteps = async (event: string) =>
            stream.writeSSE({
              <REDACTED_SCHEME> JSON.stringify([
                diagnosisStepAuth,
                diagnosisStepConversation,
                diagnosisStepPostMessage,
                diagnosisStepReadReplies,
              ]),
              event,
              id: String(id++),
            });

          let ChatProvider: WebClient;
          let auth: AuthTestResponse;
          let user: string | undefined;
          try {
            ({ ChatProvider, auth, user } = await getClient());
          } catch (error) {
            logger?.error("❌ [ChatProvider] test:auth failed", {
              error: format(error),
            });
            diagnosisStepAuth = {
              ...diagnosisStepAuth,
              status: "failed",
              error: "authentication failed",
              extra: { error: format(error) },
            };
            await updateDiagnosisSteps("error");
            return;
          }

          if (!auth?.user_id) {
            logger?.error("❌ [ChatProvider] test:auth not working", {
              auth,
            });
            diagnosisStepAuth = {
              ...diagnosisStepAuth,
              status: "failed",
              error: "authentication failed",
              extra: { auth },
            };
            await updateDiagnosisSteps("error");
            return;
          }

          diagnosisStepAuth = {
            ...diagnosisStepAuth,
            status: "success",
            extra: { auth },
          };
          await updateDiagnosisSteps("progress");

          logger?.info("📝 [ChatProvider] test:auth found", { auth });

          let channel: ConversationsOpenResponse["channel"];
          if (user) {
            // Open a DM with itself.
            let conversationsResponse: ConversationsOpenResponse;
            try {
              conversationsResponse = await ChatProvider.conversations.open({
                users: user,
              });
            } catch (error) {
              logger?.error("❌ [ChatProvider] test:conversation not found", {
                error: format(error),
              });
              diagnosisStepConversation = {
                ...diagnosisStepConversation,
                status: "failed",
                error: "opening a conversation failed",
                extra: { error: format(error) },
              };
              await updateDiagnosisSteps("error");
              return;
            }

            if (!conversationsResponse?.channel?.id) {
              logger?.error("❌ [ChatProvider] test:conversation not found", {
                conversationsResponse,
              });
              diagnosisStepConversation = {
                ...diagnosisStepConversation,
                status: "failed",
                error: "conversation channel not found",
                extra: { conversationsResponse },
              };
              await updateDiagnosisSteps("error");
              return;
            }

            channel = conversationsResponse.channel;
          } else {
            // Find the first channel where the bot is installed.
            let conversationsResponse: UsersConversationsResponse;
            try {
              conversationsResponse = await ChatProvider.users.conversations({
                user: auth.user_id,
              });
            } catch (error) {
              logger?.error("❌ [ChatProvider] test:conversation not found", {
                error: format(error),
              });
              diagnosisStepConversation = {
                ...diagnosisStepConversation,
                status: "failed",
                error: "opening a conversation failed",
                extra: { error: format(error) },
              };
              await updateDiagnosisSteps("error");
              return;
            }

            if (!conversationsResponse?.channels?.length) {
              logger?.error("❌ [ChatProvider] test:channel not found", {
                conversationsResponse,
              });
              diagnosisStepConversation = {
                ...diagnosisStepConversation,
                status: "failed",
                error: "channel not found",
                extra: { conversationsResponse },
              };
              await updateDiagnosisSteps("error");
              return;
            }
            channel = conversationsResponse.channels![0]!;
          }

          if (!channel.id) {
            logger?.error("❌ [ChatProvider] test:channel not found", {
              channel,
            });
            diagnosisStepConversation = {
              ...diagnosisStepConversation,
              status: "failed",
              error: "channel not found",
              extra: { channel },
            };
            await updateDiagnosisSteps("error");
            return;
          }

          diagnosisStepConversation = {
            ...diagnosisStepConversation,
            status: "success",
            extra: { channel },
          };
          await updateDiagnosisSteps("progress");

          logger?.info("📝 [ChatProvider] test:channel found", { channel });

          // Post a message in the DMs.
          let message: ChatPostMessageResponse;
          try {
            message = await ChatProvider.chat.postMessage({
              channel: channel.id,
              text: `<@${auth.user_id}> test:ping`,
            });
          } catch (error) {
            logger?.error("❌ [ChatProvider] test:message not posted", {
              error: format(error),
            });
            diagnosisStepPostMessage = {
              ...diagnosisStepPostMessage,
              status: "failed",
              error: "posting message failed",
              extra: { error: format(error) },
            };
            await updateDiagnosisSteps("error");
            return;
          }

          if (!message?.ts) {
            logger?.error("❌ [ChatProvider] test:message not posted", { message });
            diagnosisStepPostMessage = {
              ...diagnosisStepPostMessage,
              status: "failed",
              error: "posting message missing timestamp",
              extra: { message },
            };
            await updateDiagnosisSteps("error");
            return;
          }

          logger?.info("📝 [ChatProvider] test:ping sent", { message });

          diagnosisStepPostMessage = {
            ...diagnosisStepPostMessage,
            status: "success",
            extra: { message },
          };
          await updateDiagnosisSteps("progress");

          const sleep = (ms: number) =>
            new Promise((resolve) => setTimeout(resolve, ms));

          // Wait for the bot to reply.
          let lastReplies: ConversationsRepliesResponse | undefined = undefined;
          for (let i = 0; i < 30; i++) {
            await sleep(1000);
            let replies: ConversationsRepliesResponse;
            try {
              replies = await ChatProvider.conversations.replies({
                ts: message.ts,
                channel: channel.id,
              });
            } catch (error) {
              logger?.error("❌ [ChatProvider] test:replies not found", { message });
              diagnosisStepReadReplies = {
                ...diagnosisStepReadReplies,
                status: "failed",
                error: "replies not found",
                extra: { error: format(error) },
              };
              await updateDiagnosisSteps("error");
              return;
            }
            logger?.info("📝 [ChatProvider] test:replies", { replies });
            diagnosisStepReadReplies.extra = { replies };
            lastReplies = replies;
            if (replies?.messages?.some((m) => m.text === "pong")) {
              // Victory!
              logger?.info("📝 [ChatProvider] test:pong successful");
              diagnosisStepReadReplies = {
                ...diagnosisStepReadReplies,
                status: "success",
                extra: { replies },
              };
              await updateDiagnosisSteps("result");
              return;
            }

            await updateDiagnosisSteps("progress");
          }

          logger?.error("❌ [ChatProvider] test:timeout");

          diagnosisStepReadReplies = {
            ...diagnosisStepReadReplies,
            status: "failed",
            error: "replies timed out",
            extra: { lastReplies },
          };
          await updateDiagnosisSteps("error");
        });
      },
    },
  ];
}
