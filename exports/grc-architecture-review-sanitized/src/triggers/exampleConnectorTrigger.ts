/**
 * Example Connector Trigger - Linear Webhook Handler
 *
 * This demonstrates how to create a webhook handler for any connector.
 * Linear is just an example - replace with your connector name.
 *
 * PATTERN:
 * 1. Define types for the webhook payload (optional, but helpful)
 * 2. Create a registration function that sets up the webhook route
 * 3. Pass the full payload to the handler - let the consumer pick what they need
 * 4. Register in src/mastra/index.ts
 *
 * See docs/triggers/webhook_connector_triggers.md for complete guide.
 */

import { registerApiRoute } from "../mastra/inngest";
import type { Mastra } from "@mastra/core";
import { createHmac, timingSafeEqual } from "crypto";

import { logger as safeLogger } from "../utils/logger";
/**
 * Linear webhook payload structure
 * Based on: <REDACTED_URL>
 */
export type LinearWebhookPayload = {
  action: string; // e.g., "create", "update", "remove"
  type: string; // e.g., "Issue", "Comment", "Project"
  <REDACTED_SCHEME> {
    id: string;
    title: string;
    description?: string;
    [key: string]: any;
  };
  createdAt: string;
  organizationId: string;
  [key: string]: any;
};

/**
 * Trigger info passed to your handler
 */
export type TriggerInfoLinearIssueCreated = {
  type: "linear/issue.created";
  payload: LinearWebhookPayload;
};

type LinearTriggerHandler = (
  mastra: Mastra,
  triggerInfo: TriggerInfoLinearIssueCreated,
) => Promise<any>;

/**
 * Register a Linear webhook trigger handler
 *
 * Usage in src/mastra/index.ts:
 *
 * ```typescript
 * import { exampleWorkflow } from "./workflows/exampleWorkflow";
 *
 * ...registerLinearTrigger({
 *   triggerType: "linear/issue.created",
 *   handler: async (mastra, triggerInfo) => {
 *     // Extract what you need from the payload
 *     const data = triggerInfo.payload?.data || {};
 *     const title = data.title || data.name || "Untitled";
 *
 *     // Start your workflow
 *     const run = await exampleWorkflow.createRunAsync();
 *     return await run.start({
 *       inputData: {
 *         message: `Linear Issue: ${title}`,
 *         includeAnalysis: true,
 *       }
 *     });
 *   }
 * })
 * ```
 */
export function registerLinearTrigger({
  triggerType,
  handler,
}: {
  triggerType: "linear/issue.created";
  handler: LinearTriggerHandler;
}) {
  return [
    registerApiRoute("/linear/webhook", {
      method: "POST",
      handler: async (c) => {
        const mastra = c.get("mastra");
        const logger = mastra?.getLogger();

        try {
          let payload: any;
          const linearWebhookSecret = process.env.LINEAR_WEBHOOK_SECRET;
          if (linearWebhookSecret) {
            const signature =
              c.req.header("linear-signature") ||
              c.req.header("x-linear-signature") ||
              "";
            const rawBody = await c.req.text();
            const expectedSig = createHmac("sha256", linearWebhookSecret)
              .update(rawBody)
              .digest("hex");
            const sigBuffer = Buffer.from(signature, "hex");
            const expectedBuffer = Buffer.from(expectedSig, "hex");
            if (
              sigBuffer.length !== expectedBuffer.length ||
              !timingSafeEqual(sigBuffer, expectedBuffer)
            ) {
              safeLogger.warn("🚫 [Linear] Invalid webhook signature");
              return c.json(
                { success: false, error: "Invalid signature" },
                403,
              );
            }
            payload = JSON.parse(rawBody);
          } else {
            payload = await c.req.json();
          }
          safeLogger.info("📥 [Linear] Webhook received", { payload });

          // Only process Issue creation events
          if (payload.action !== "create" || payload.type !== "Issue") {
            safeLogger.info("⏭️ [Linear] Skipping event", {
              action: payload.action,
              type: payload.type,
            });
            return c.json({ success: true, skipped: true });
          }

          // Ensure data exists (use empty object as fallback)
          if (!payload.data) {
            safeLogger.info(
              "⚠️ [Linear] Missing data field, using empty object",
            );
            payload.data = {};
          }

          // Pass the full payload - let the consumer pick what they need
          const triggerInfo: TriggerInfoLinearIssueCreated = {
            type: triggerType,
            payload: payload as LinearWebhookPayload,
          };

          safeLogger.info("🚀 [Linear] Triggering handler");

          const result = await handler(mastra, triggerInfo);

          safeLogger.info("✅ [Linear] Handler completed", { result });

          return c.json({ success: true, result });
        } catch (error) {
          logger?.error("❌ [Linear] Error processing webhook", {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });

          return c.json(
            {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
            500,
          );
        }
      },
    }),
  ];
}
