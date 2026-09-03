/**
 * Regression test for ChatProvider action-webhook request authentication.
 *
 * The `/webhooks/ChatProvider/action` (+ `/api/webhooks/ChatProvider/action` alias)
 * endpoints are listed in PUBLIC_PATHS — they bypass platform session auth
 * because ChatProvider's servers (not a browser) POST to them. The ONLY thing
 * guarding this workflow-triggering endpoint is ChatProvider's request signature,
 * so this test pins the fail-closed behaviour:
 *
 *   1. No ChatProvider_SIGNING_SECRET  -> 503 (refuse, never accept unsigned)
 *   2. Missing signature header -> 401
 *   3. Invalid signature        -> 401
 *   4. Valid signature          -> handler proceeds (challenge handshake 200)
 *
 * Run:  npx tsx tests/ChatProviderWebhookSignature.test.ts
 */

import { createHmac } from "crypto";

import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("ChatProviderWebhookSignature");

console.log("\n=== ChatProvider action-webhook signature tests ===\n");

const { registerChatProviderTrigger } = await import("../src/triggers/ChatProviderTriggers");

// Resolve the ChatProviderWebhookHandler the same way the Mastra server does: build
// the route table, then grab the handler bound to the public action path.
const routes = registerChatProviderTrigger({
  triggerType: "ChatProvider/message.channels",
  handler: async () => null,
});
const actionRoute = routes.find(
  (r: any) => r?.path === "/api/webhooks/ChatProvider/action",
);
const ChatProviderWebhookHandler = (actionRoute as any)?.handler as (
  c: unknown,
) => Promise<{ _body: string; _status: number }>;

function makeCtx(rawBody: string, headers: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const noopLogger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
  return {
    get: (k: string) =>
      k === "mastra" ? { getLogger: () => noopLogger } : undefined,
    req: {
      text: async () => rawBody,
      json: async () => JSON.parse(rawBody),
      header: (name: string) => lower[name.toLowerCase()],
    },
    text: (body: string, status?: number) => ({
      _body: body,
      _status: status ?? 200,
    }),
  };
}

function sign(secret: string, timestamp: string, rawBody: string): string {
  return (
    "v0=" +
    createHmac("sha256", secret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex")
  );
}

const SECRET = "<REDACTED_SECRET>";
const ORIGINAL_SECRET = process.env.ChatProvider_SIGNING_SECRET;

suite.expect(
  typeof ChatProviderWebhookHandler === "function",
  "resolved ChatProviderWebhookHandler from /api/webhooks/ChatProvider/action route",
);

await suite.test(
  "rejects with 503 when ChatProvider_SIGNING_SECRET is not configured",
  async () => {
    delete process.env.ChatProvider_SIGNING_SECRET;
    const body = JSON.stringify({ challenge: "abc" });
    const res = await ChatProviderWebhookHandler(makeCtx(body, {}));
    suite.expectEqual(res._status, 503, "status");
  },
);

await suite.test(
  "rejects with 401 when the signature header is missing",
  async () => {
    process.env.ChatProvider_SIGNING_SECRET = SECRET;
    const body = JSON.stringify({ challenge: "abc" });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await ChatProviderWebhookHandler(
      makeCtx(body, { "x-ChatProvider-request-timestamp": ts }),
    );
    suite.expectEqual(res._status, 401, "status");
  },
);

await suite.test(
  "rejects with 401 when the signature is invalid",
  async () => {
    process.env.ChatProvider_SIGNING_SECRET = SECRET;
    const body = JSON.stringify({ challenge: "abc" });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await ChatProviderWebhookHandler(
      makeCtx(body, {
        "x-ChatProvider-request-timestamp": ts,
        "x-ChatProvider-signature": "v0=deadbeef",
      }),
    );
    suite.expectEqual(res._status, 401, "status");
  },
);

await suite.test(
  "accepts a correctly-signed request (URL-verification challenge handshake)",
  async () => {
    process.env.ChatProvider_SIGNING_SECRET = SECRET;
    const challenge = "challenge_token_xyz";
    const body = JSON.stringify({ challenge });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await ChatProviderWebhookHandler(
      makeCtx(body, {
        "x-ChatProvider-request-timestamp": ts,
        "x-ChatProvider-signature": sign(SECRET, ts, body),
      }),
    );
    suite.expectEqual(res._status, 200, "status");
    suite.expectEqual(res._body, challenge, "echoes the challenge token");
  },
);

await suite.test(
  "rejects a replayed request with a stale timestamp (>5 min)",
  async () => {
    process.env.ChatProvider_SIGNING_SECRET = SECRET;
    const body = JSON.stringify({ challenge: "abc" });
    const staleTs = String(Math.floor(Date.now() / 1000) - 60 * 10);
    const res = await ChatProviderWebhookHandler(
      makeCtx(body, {
        "x-ChatProvider-request-timestamp": staleTs,
        "x-ChatProvider-signature": sign(SECRET, staleTs, body),
      }),
    );
    suite.expectEqual(res._status, 401, "status");
  },
);

if (ORIGINAL_SECRET === undefined) delete process.env.ChatProvider_SIGNING_SECRET;
else process.env.ChatProvider_SIGNING_SECRET = ORIGINAL_SECRET;

suite.finishOrExit();
