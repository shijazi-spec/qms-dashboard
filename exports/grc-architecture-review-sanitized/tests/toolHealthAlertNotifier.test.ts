/**
 * Unit tests for the tool-health on-call notifier.
 *
 * Covers the behavior added in Task #128:
 *   • No-op (skipped) when neither ChatProvider channel nor email recipient is
 *     configured — so the cron can call us unconditionally in dev/test.
 *   • ChatProvider-only / email-only / both wiring through env vars.
 *   • In-process throttle keyed on `<tool_name>:<reason>` so a flapping
 *     breach does not double-page within `TOOL_HEALTH_NOTIFY_THROTTLE_MIN`.
 *   • ChatProvider/email transport errors do not throw out of `notifyToolHealthBreach`
 *     and do not poison the throttle map.
 *   • Multiple comma-separated email recipients are forwarded as an array.
 *   • Built link points to `/dashboard` and honours
 *     `TOOL_HEALTH_APP_URL`.
 *
 * Run:  npx tsx tests/toolHealthAlertNotifier.test.ts
 * Wired: discovered automatically by tests/runIntegrationTests.ts (npm test).
 */

import {
  notifyToolHealthBreach,
  notifyToolHealthConfigChange,
  notifyToolHealthOverrideExpired,
  notifyToolHealthRecovery,
  _diffToolHealthConfigOverridesForTests,
  _formatRecoveryDurationForTests,
  _resetToolHealthNotifierThrottleForTests,
  type ToolHealthBreachNotification,
  type ToolHealthNotifierDeps,
  type ToolHealthConfigChangeNotification,
  type ToolHealthConfigChangeNotifierDeps,
  type ToolHealthOverrideExpiredNotification,
  type ToolHealthOverrideNotifierDeps,
  type ToolHealthRecoveryNotification,
  type ToolHealthRecoveryNotifierDeps,
} from "../src/utils/toolHealthAlertNotifier";
import type { ToolHealthConfigAuditEntry } from "../src/utils/toolHealthConfigDatabase";
import { TestSuite } from "./_helpers/runner";

interface ChatProviderCall {
  channel: string;
  text: string;
  blocks?: any[];
}
interface EmailCall {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
}

interface DbClaimCall { key: string; nowMs: number; throttleMs: number }
interface RecordResultCall { alertId: number | null | undefined; channel: string; whenMs: number }

function makeStubs(opts: {
  ChatProviderResult?: boolean | Error;
  emailResult?: { success: boolean; id?: string; error?: string } | Error;
  now?: number;
  /**
   * Value returned by the injected claimDb stub.
   * `true` (default) = this caller wins the slot and may send.
   * `false`           = a sibling already paged within the window (throttled).
   */
  claimDbResult?: boolean;
  /** When provided, the recordResult stub throws this error. */
  recordResultThrows?: Error;
} = {}): {
  deps: ToolHealthNotifierDeps;
  ChatProviderCalls: ChatProviderCall[];
  emailCalls: EmailCall[];
  dbClaimCalls: DbClaimCall[];
  recordResultCalls: RecordResultCall[];
} {
  const ChatProviderCalls: ChatProviderCall[] = [];
  const emailCalls: EmailCall[] = [];
  const dbClaimCalls: DbClaimCall[] = [];
  const recordResultCalls: RecordResultCall[] = [];
  const deps: ToolHealthNotifierDeps = {
    sendChatProvider: async (channel, text, blocks) => {
      ChatProviderCalls.push({ channel, text, blocks });
      if (opts.ChatProviderResult instanceof Error) throw opts.ChatProviderResult;
      return opts.ChatProviderResult ?? true;
    },
    sendEmail: async (mailOpts) => {
      emailCalls.push({
        to: mailOpts.to,
        subject: mailOpts.subject,
        html: mailOpts.html,
        text: mailOpts.text,
      });
      if (opts.emailResult instanceof Error) throw opts.emailResult;
      return opts.emailResult ?? { success: true, id: "stub-id" };
    },
    now: opts.now != null ? () => opts.now! : undefined,
    claimDb: async (key, nowMs, throttleMs) => {
      dbClaimCalls.push({ key, nowMs, throttleMs });
      return opts.claimDbResult ?? true;
    },
    recordResult: async (alertId, channel, whenMs) => {
      recordResultCalls.push({ alertId, channel, whenMs });
      if (opts.recordResultThrows) throw opts.recordResultThrows;
    },
  };
  return { deps, ChatProviderCalls, emailCalls, dbClaimCalls, recordResultCalls };
}

function sample(
  overrides: Partial<ToolHealthBreachNotification> = {},
): ToolHealthBreachNotification {
  return {
    tool_name: "qms_create_nc",
    agent_name: "qms_agent",
    reason: "error_rate",
    severity: "high",
    title: "Tool \"qms_create_nc\" error rate above threshold",
    description: "12/20 failed (60%) over last 60m",
    suggestion: "Check the AI Operations panel.",
    related_record_id: "qms_create_nc:error_rate",
    alert_id: 123,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Env helpers — every test fully resets the notifier's env-driven config so
// cases run in any order.
// ──────────────────────────────────────────────────────────────────────────────
const ENV_KEYS = [
  "TOOL_HEALTH_ChatProvider_CHANNEL",
  "TOOL_HEALTH_ChatProvider_USE_DEFAULT_CHANNEL",
  "TOOL_HEALTH_ALERT_EMAIL",
  "TOOL_HEALTH_NOTIFY_THROTTLE_MIN",
  "TOOL_HEALTH_APP_URL",
  "TOOL_HEALTH_CONFIG_NOTIFY",
  "TOOL_HEALTH_RECOVERY_NOTIFY",
  "TOOL_HEALTH_RECOVERY_SKIP_TOOLS",
  "ChatProvider_CHANNEL_ID",
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  _resetToolHealthNotifierThrottleForTests();
}

const suite = new TestSuite("toolHealthAlertNotifier");
console.log("\n=== toolHealthAlertNotifier tests ===\n");

await suite.test(
  "no ChatProvider channel, no email recipient → returns { skipped: true } without sending",
  async () => {
    clearEnv();
    const { deps, ChatProviderCalls, emailCalls } = makeStubs();
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.skipped, true, "skipped");
    suite.expectEqual(result.ChatProviderSent, false, "no ChatProvider");
    suite.expectEqual(result.emailSent, false, "no email");
    suite.expectEqual(result.throttled, false, "not throttled");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
    suite.expectEqual(emailCalls.length, 0, "no email call");
  },
);

await suite.test(
  "ChatProvider channel configured → posts to TOOL_HEALTH_ChatProvider_CHANNEL with link to AI Ops",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-ONCALL-CHAN";
    process.env.TOOL_HEALTH_APP_URL = "<REDACTED_URL>";
    const { deps, ChatProviderCalls, emailCalls } = makeStubs();
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.ChatProviderSent, true, "ChatProviderSent");
    suite.expectEqual(result.emailSent, false, "no email when not configured");
    suite.expectEqual(result.skipped, false, "not skipped");
    suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider call");
    suite.expectEqual(ChatProviderCalls[0]?.channel, "C-ONCALL-CHAN", "channel");
    suite.expect(
      ChatProviderCalls[0]?.text.includes("qms_create_nc"),
      "fallback text mentions tool",
    );
    // Link button must point at the AI Ops panel under the configured base URL.
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("<REDACTED_URL>"),
      `ChatProvider blocks contain link to AI Ops panel (got: ${blocks.slice(0, 200)}...)`,
    );
    // Dedupe key should appear in the context footer for traceability.
    suite.expect(
      blocks.includes("qms_create_nc:error_rate"),
      "ChatProvider blocks reference the dedupe key",
    );
    suite.expectEqual(emailCalls.length, 0, "no email call");
  },
);

await suite.test(
  "email recipient configured → posts via EmailProvider with severity-prefixed subject",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid";
    const { deps, ChatProviderCalls, emailCalls } = makeStubs();
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.emailSent, true, "emailSent");
    suite.expectEqual(result.ChatProviderSent, false, "ChatProvider not sent");
    suite.expectEqual(emailCalls.length, 1, "one email call");
    const call = emailCalls[0]!;
    suite.expect(
      Array.isArray(call.to)
        ? (call.to as string[]).includes("user@example.invalid")
        : call.to === "user@example.invalid",
      "recipient propagated",
    );
    suite.expect(
      call.subject.startsWith("[Tool Health · HIGH]"),
      `subject prefixed with severity (got: ${call.subject})`,
    );
    suite.expect(
      (call.html ?? "").includes("/dashboard"),
      "email HTML links to AI Operations panel",
    );
    suite.expect(
      (call.text ?? "").includes("/dashboard"),
      "email plaintext links to AI Operations panel",
    );
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider");
  },
);

await suite.test(
  "comma-separated TOOL_HEALTH_ALERT_EMAIL → forwarded as recipient array",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid, user@example.invalid ,user@example.invalid";
    const { deps, emailCalls } = makeStubs();
    await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(emailCalls.length, 1, "one email call");
    const recipients = Array.isArray(emailCalls[0]?.to)
      ? (emailCalls[0]!.to as string[])
      : [emailCalls[0]!.to as string];
    suite.expectEqual(recipients.length, 3, "three recipients");
    suite.expectEqual(recipients[0], "user@example.invalid", "trimmed first");
    suite.expectEqual(recipients[1], "user@example.invalid", "trimmed middle");
    suite.expectEqual(recipients[2], "user@example.invalid", "trimmed last");
  },
);

await suite.test(
  "both ChatProvider and email configured → both senders are invoked",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid";
    const { deps, ChatProviderCalls, emailCalls } = makeStubs();
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.ChatProviderSent, true, "ChatProviderSent");
    suite.expectEqual(result.emailSent, true, "emailSent");
    suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider call");
    suite.expectEqual(emailCalls.length, 1, "one email call");
  },
);

await suite.test(
  "throttle: same dedupe key called twice in window → second call short-circuits",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";
    let now = 1_000_000;
    const { deps, ChatProviderCalls } = makeStubs({ now });

    const first = await notifyToolHealthBreach(sample(), {
      ...deps,
      now: () => now,
    });
    suite.expectEqual(first.ChatProviderSent, true, "first send goes through");
    suite.expectEqual(first.throttled, false, "first not throttled");

    // 30 minutes later, well inside the 60-min window
    now = 1_000_000 + 30 * 60_000;
    const second = await notifyToolHealthBreach(sample(), {
      ...deps,
      now: () => now,
    });
    suite.expectEqual(second.throttled, true, "second is throttled");
    suite.expectEqual(second.ChatProviderSent, false, "no ChatProvider send on throttle");
    suite.expectEqual(ChatProviderCalls.length, 1, "still only one ChatProvider call total");
  },
);

await suite.test(
  "throttle: past window → key is paged again",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";
    let now = 1_000_000;
    const { deps, ChatProviderCalls } = makeStubs();

    await notifyToolHealthBreach(sample(), { ...deps, now: () => now });

    now = 1_000_000 + 61 * 60_000; // past 60-min throttle
    const second = await notifyToolHealthBreach(sample(), {
      ...deps,
      now: () => now,
    });
    suite.expectEqual(second.throttled, false, "second NOT throttled past window");
    suite.expectEqual(second.ChatProviderSent, true, "second ChatProvider send goes through");
    suite.expectEqual(ChatProviderCalls.length, 2, "two ChatProvider calls total");
  },
);

await suite.test(
  "throttle: distinct dedupe keys are independent",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";
    const now = 1_000_000;
    const { deps, ChatProviderCalls } = makeStubs();
    const a = sample({
      tool_name: "tool_a",
      reason: "error_rate",
      related_record_id: "tool_a:error_rate",
    });
    const b = sample({
      tool_name: "tool_a",
      reason: "p95_latency",
      related_record_id: "tool_a:p95_latency",
    });
    const c = sample({
      tool_name: "tool_b",
      reason: "error_rate",
      related_record_id: "tool_b:error_rate",
    });
    await notifyToolHealthBreach(a, { ...deps, now: () => now });
    await notifyToolHealthBreach(b, { ...deps, now: () => now });
    await notifyToolHealthBreach(c, { ...deps, now: () => now });
    suite.expectEqual(
      ChatProviderCalls.length,
      3,
      "all three keys page independently",
    );
  },
);

await suite.test(
  "throttle: failed ChatProvider send still consumes throttle slot (atomic claim happens before send)",
  // With the DB-backed atomic claim design, the slot is claimed in the DB
  // BEFORE any ChatProvider/email call is attempted. A failed send therefore still
  // consumes the throttle window — this prevents a sibling instance from
  // paging again within the same window if the first pod's send failed.
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";
    const now = 1_000_000;
    const { deps: failingDeps, ChatProviderCalls } = makeStubs({ ChatProviderResult: false });

    const first = await notifyToolHealthBreach(sample(), {
      ...failingDeps,
      now: () => now,
    });
    suite.expectEqual(first.ChatProviderSent, false, "send reported as failed");
    suite.expectEqual(first.throttled, false, "first attempt not throttled");
    suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider attempt was made");

    // In-window retry IS throttled — the slot was claimed before the failed send.
    const { deps: okDeps, ChatProviderCalls: okCalls } = makeStubs();
    const second = await notifyToolHealthBreach(sample(), {
      ...okDeps,
      now: () => now,
    });
    suite.expectEqual(second.throttled, true, "in-window retry IS throttled — slot was claimed before failed send");
    suite.expectEqual(second.ChatProviderSent, false, "no ChatProvider send on throttled retry");
    suite.expectEqual(okCalls.length, 0, "no retry ChatProvider call made within throttle window");
  },
);

await suite.test(
  "ChatProvider send throws → swallowed; email still attempted; result reflects failure",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid";
    const { deps, emailCalls } = makeStubs({
      ChatProviderResult: new Error("ChatProvider down"),
    });

    // Silence the expected error log.
    const origErr = console.error;
    console.error = () => {};
    try {
      const result = await notifyToolHealthBreach(sample(), deps);
      suite.expectEqual(result.ChatProviderSent, false, "ChatProvider failed");
      suite.expectEqual(result.emailSent, true, "email still went through");
      suite.expectEqual(emailCalls.length, 1, "email attempted");
    } finally {
      console.error = origErr;
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// DB persistence tests (Task #168)
// Verify that the atomic `claimDb` hook is called correctly, gating sending
// so restarts and multi-instance deployments cannot double-page within the
// throttle window.
// ──────────────────────────────────────────────────────────────────────────────

await suite.test(
  "DB persistence: claimDb is called when in-process map is empty (simulates restart)",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";
    const now = 1_000_000;
    const { deps, dbClaimCalls } = makeStubs({ now });
    await notifyToolHealthBreach(sample(), { ...deps, now: () => now });
    suite.expectEqual(dbClaimCalls.length, 1, "claimDb called once");
    suite.expectEqual(
      dbClaimCalls[0]?.key,
      "qms_create_nc:error_rate",
      "claimDb called with the dedupe key",
    );
    suite.expectEqual(dbClaimCalls[0]?.nowMs, now, "claimDb receives current epoch-ms");
    suite.expectEqual(
      dbClaimCalls[0]?.throttleMs,
      60 * 60_000,
      "claimDb receives configured throttle window in ms",
    );
  },
);

await suite.test(
  "DB persistence: claimDb returns false → throttled even with empty in-process map (sibling already paged)",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";
    const now = 1_000_000;
    const { deps, ChatProviderCalls } = makeStubs({ now, claimDbResult: false });
    const result = await notifyToolHealthBreach(sample(), { ...deps, now: () => now });
    suite.expectEqual(result.throttled, true, "throttled — sibling holds the slot");
    suite.expectEqual(result.ChatProviderSent, false, "no ChatProvider sent");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider calls made");
  },
);

await suite.test(
  "DB persistence: claimDb returns true → send goes through",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";
    const now = 1_000_000;
    const { deps, ChatProviderCalls } = makeStubs({ now, claimDbResult: true });
    const result = await notifyToolHealthBreach(sample(), { ...deps, now: () => now });
    suite.expectEqual(result.throttled, false, "not throttled — slot successfully claimed");
    suite.expectEqual(result.ChatProviderSent, true, "ChatProvider sent after successful claim");
    suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider call");
  },
);

await suite.test(
  "DB persistence: in-process cache is fast path — claimDb NOT called on second call within window",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";
    let now = 1_000_000;
    const { deps, dbClaimCalls } = makeStubs({ now });

    await notifyToolHealthBreach(sample(), { ...deps, now: () => now });
    const firstClaimCount = dbClaimCalls.length;

    now = 1_000_000 + 30 * 60_000;
    const second = await notifyToolHealthBreach(sample(), { ...deps, now: () => now });
    suite.expectEqual(second.throttled, true, "second call throttled by in-process map");
    suite.expectEqual(
      dbClaimCalls.length,
      firstClaimCount,
      "claimDb NOT called again — in-process map served as fast path",
    );
  },
);

await suite.test(
  "DB persistence: claimDb throws → swallowed; send still goes through (DB unavailable fallback)",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";
    const now = 1_000_000;
    const { deps, ChatProviderCalls } = makeStubs({ now });
    const throwingDeps = {
      ...deps,
      claimDb: async (_key: string, _nowMs: number, _throttleMs: number): Promise<boolean> => {
        throw new Error("db unavailable");
      },
      now: () => now,
    };
    const origErr = console.error;
    console.error = () => {};
    try {
      const result = await notifyToolHealthBreach(sample(), throwingDeps);
      suite.expectEqual(result.ChatProviderSent, true, "ChatProvider sent despite claimDb failure");
      suite.expectEqual(result.throttled, false, "not throttled");
      suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider call");
    } finally {
      console.error = origErr;
    }
  },
);

await suite.test(
  "DB persistence: slot is claimed before sending — DB slot consumed even if send fails (atomic guarantee)",
  // With the atomic-claim design, the DB slot is claimed BEFORE ChatProvider/email is
  // attempted. A failed send means the slot is consumed for the rest of the
  // throttle window. This is intentional: it prevents double-paging by a
  // sibling or restart-recovering instance even when the network call fails.
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";
    const now = 1_000_000;
    const { deps, dbClaimCalls } = makeStubs({ now, ChatProviderResult: false });
    const result = await notifyToolHealthBreach(sample(), { ...deps, now: () => now });
    suite.expectEqual(result.ChatProviderSent, false, "ChatProvider send failed");
    suite.expectEqual(dbClaimCalls.length, 1, "claimDb WAS called before send attempt");
    // Second call within window must be throttled (in-process cache was set after claim)
    const secondNow = now + 30 * 60_000;
    const second = await notifyToolHealthBreach(sample(), { ...deps, now: () => secondNow });
    suite.expectEqual(second.throttled, true, "in-window call throttled after a failed-send claim");
  },
);

await suite.test(
  "DB persistence: TOOL_HEALTH_NOTIFY_THROTTLE_MIN=0 → claimDb is never called (throttle disabled)",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "0";
    const now = 1_000_000;
    const { deps, dbClaimCalls, ChatProviderCalls } = makeStubs({ now });
    const result = await notifyToolHealthBreach(sample(), { ...deps, now: () => now });
    suite.expectEqual(result.ChatProviderSent, true, "ChatProvider sent when throttle is disabled");
    suite.expectEqual(dbClaimCalls.length, 0, "claimDb not called when throttleMs=0");
    suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider call");
  },
);

await suite.test(
  "TOOL_HEALTH_ChatProvider_USE_DEFAULT_CHANNEL=1 falls back to ChatProvider_CHANNEL_ID",
  async () => {
    clearEnv();
    process.env.ChatProvider_CHANNEL_ID = "C-DEFAULT";
    process.env.TOOL_HEALTH_ChatProvider_USE_DEFAULT_CHANNEL = "1";
    const { deps, ChatProviderCalls } = makeStubs();
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.ChatProviderSent, true, "ChatProviderSent");
    suite.expectEqual(ChatProviderCalls[0]?.channel, "C-DEFAULT", "fell back to default channel");
  },
);

await suite.test(
  "ChatProvider_CHANNEL_ID alone (without opt-in) does NOT page tool-health",
  // Guards against accidentally posting tool-health alerts to whatever
  // channel another module is using as its general ChatProvider target.
  async () => {
    clearEnv();
    process.env.ChatProvider_CHANNEL_ID = "C-QMS";
    const { deps, ChatProviderCalls } = makeStubs();
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.skipped, true, "skipped");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
  },
);

await suite.test(
  "no TOOL_HEALTH_APP_URL → no ChatProvider action button (ChatProvider rejects relative urls)",
  // ChatProvider's blocks API requires `actions.button.url` to be an absolute URL;
  // posting a relative path causes the entire message to be rejected with
  // `invalid_blocks`. The notifier must degrade gracefully to a plain
  // mrkdwn-link section so dev/test environments still get a valid (if
  // unclickable) message.
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    const { deps, ChatProviderCalls } = makeStubs();
    await notifyToolHealthBreach(sample(), deps);
    const blocks = ChatProviderCalls[0]?.blocks ?? [];
    const hasButton = blocks.some(
      (b: any) =>
        b?.type === "actions" &&
        Array.isArray(b.elements) &&
        b.elements.some((e: any) => e?.type === "button"),
    );
    suite.expectEqual(hasButton, false, "no actions button when URL is relative");
    const json = JSON.stringify(blocks);
    suite.expect(
      json.includes("/dashboard"),
      "still surfaces the relative path as text",
    );
    suite.expect(
      json.includes("TOOL_HEALTH_APP_URL"),
      "tells the operator how to enable a clickable link",
    );
    suite.expect(
      !json.includes("<REDACTED_URL>"),
      "no malformed URL with empty origin",
    );
  },
);

await suite.test(
  "TOOL_HEALTH_APP_URL set → ChatProvider action button is rendered with absolute URL",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_APP_URL = "<REDACTED_URL>";
    const { deps, ChatProviderCalls } = makeStubs();
    await notifyToolHealthBreach(sample(), deps);
    const blocks = ChatProviderCalls[0]?.blocks ?? [];
    const button = blocks
      .find((b: any) => b?.type === "actions")
      ?.elements?.find((e: any) => e?.type === "button");
    suite.expect(!!button, "actions button rendered when URL is absolute");
    suite.expectEqual(
      button?.url,
      "<REDACTED_URL>",
      "button URL is absolute and points to AI Ops panel",
    );
  },
);


// ──────────────────────────────────────────────────────────────────────────────
// Tool-health threshold-tuning notifier (Task #190 / Task #205 / Task #206)
// ──────────────────────────────────────────────────────────────────────────────

function makeSampleAuditEntries(count: number = 2): ToolHealthConfigAuditEntry[] {
  const base = new Date("2026-04-25T14:00:00Z");
  return Array.from({ length: count }, (_, i) => ({
    id: 100 + i,
    changed_at: new Date(base.getTime() - i * 30 * 60 * 1000),
    changed_by: i === 0 ? "Alice Admin" : "Bob Ops",
    before_values: { errorRateHighPct: 25 + i },
    after_values: { errorRateHighPct: 20 + i, latencyHighMs: 2000 },
    note: i === 0 ? "Sev-2 incident #4321" : null,
    // `breach_diff` is added by the breach-context enricher (Task #205);
    // these fixtures predate that field and don't exercise it, so leaving it
    // null keeps the test focused on the email/ChatProvider rendering it's meant to
    // verify without forcing every test author to hand-stub a breach diff.
    breach_diff: null,
  }));
}

function makeConfigChangeStubs(opts: {
  ChatProviderResult?: boolean | Error;
  auditEntries?: ToolHealthConfigAuditEntry[];
  auditError?: Error;
  emailResult?: boolean | Error;
} = {}): {
  deps: ToolHealthConfigChangeNotifierDeps;
  ChatProviderCalls: ChatProviderCall[];
  emailCalls: EmailCall[];
} {
  const ChatProviderCalls: ChatProviderCall[] = [];
  const emailCalls: EmailCall[] = [];
  return {
    ChatProviderCalls,
    emailCalls,
    deps: {
      sendChatProvider: async (channel, text, blocks) => {
        ChatProviderCalls.push({ channel, text, blocks });
        if (opts.ChatProviderResult instanceof Error) throw opts.ChatProviderResult;
        return opts.ChatProviderResult ?? true;
      },
      getAudit: async (_limit) => {
        if (opts.auditError) throw opts.auditError;
        return opts.auditEntries ?? [];
      },
      sendEmail: async ({ to, subject, html, text }) => {
        emailCalls.push({ to: Array.isArray(to) ? to : [to], subject, html, text });
        if (opts.emailResult instanceof Error) throw opts.emailResult;
        return { success: opts.emailResult ?? true };
      },
    },
  };
}

function sampleConfigChange(
  overrides: Partial<ToolHealthConfigChangeNotification> = {},
): ToolHealthConfigChangeNotification {
  return {
    changedBy: "Alice Admin",
    before: { errorRateHighPct: 25 },
    after: { errorRateHighPct: 15, latencyHighMs: 2000 },
    note: "Sev-2 incident #4321",
    audit_id: 99,
    ...overrides,
  };
}

await suite.test(
  "config change: TOOL_HEALTH_CONFIG_NOTIFY unset → disabled, no ChatProvider call",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    const { deps, ChatProviderCalls } = makeConfigChangeStubs();
    const result = await notifyToolHealthConfigChange(sampleConfigChange(), deps);
    suite.expectEqual(result.disabled, true, "disabled");
    suite.expectEqual(result.ChatProviderSent, false, "no ChatProvider");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
  },
);

await suite.test(
  "config change: TOOL_HEALTH_CONFIG_NOTIFY=0 → disabled, no ChatProvider call",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "0";
    const { deps, ChatProviderCalls } = makeConfigChangeStubs();
    const result = await notifyToolHealthConfigChange(sampleConfigChange(), deps);
    suite.expectEqual(result.disabled, true, "disabled");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
  },
);

await suite.test(
  "config change: opted in but no ChatProvider channel → skipped, no ChatProvider call",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    const { deps, ChatProviderCalls } = makeConfigChangeStubs();
    const result = await notifyToolHealthConfigChange(sampleConfigChange(), deps);
    suite.expectEqual(result.skipped, true, "skipped");
    suite.expectEqual(result.disabled, false, "not disabled");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
  },
);

await suite.test(
  "config change: identical before/after → noChanges, no ChatProvider call",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    const { deps, ChatProviderCalls } = makeConfigChangeStubs();
    const result = await notifyToolHealthConfigChange(
      sampleConfigChange({
        before: { errorRateHighPct: 20 },
        after: { errorRateHighPct: 20 },
      }),
      deps,
    );
    suite.expectEqual(result.noChanges, true, "noChanges");
    suite.expectEqual(result.ChatProviderSent, false, "no ChatProvider send");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
  },
);

await suite.test(
  "config change: opted in with channel → posts diff to ChatProvider with deep-link",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-ONCALL";
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    process.env.TOOL_HEALTH_APP_URL = "<REDACTED_URL>";
    const { deps, ChatProviderCalls } = makeConfigChangeStubs();
    const result = await notifyToolHealthConfigChange(sampleConfigChange(), deps);
    suite.expectEqual(result.ChatProviderSent, true, "ChatProviderSent");
    suite.expectEqual(result.disabled, false, "not disabled");
    suite.expectEqual(result.skipped, false, "not skipped");
    suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider call");
    suite.expectEqual(ChatProviderCalls[0]?.channel, "C-ONCALL", "channel");
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("Alice Admin"),
      "blocks mention operator name",
    );
    suite.expect(
      blocks.includes("Error rate HIGH"),
      "blocks list field labels for changed fields",
    );
    suite.expect(
      blocks.includes("p95 latency HIGH"),
      "blocks list newly-set field as well",
    );
    suite.expect(
      blocks.includes("Sev-2 incident #4321"),
      "operator note surfaced",
    );
    suite.expect(
      blocks.includes("<REDACTED_URL>"),
      `blocks include deep-link to Alert Thresholds tab (got: ${blocks.slice(0, 200)}...)`,
    );
    suite.expect(
      ChatProviderCalls[0]?.text.includes("thresholds"),
      "fallback text mentions thresholds",
    );
  },
);

await suite.test(
  "config change: no TOOL_HEALTH_APP_URL → no actions button, still surfaces relative path",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    const { deps, ChatProviderCalls } = makeConfigChangeStubs();
    await notifyToolHealthConfigChange(sampleConfigChange(), deps);
    const blocks = ChatProviderCalls[0]?.blocks ?? [];
    const hasButton = blocks.some(
      (b: any) =>
        b?.type === "actions" &&
        Array.isArray(b.elements) &&
        b.elements.some((e: any) => e?.type === "button"),
    );
    suite.expectEqual(hasButton, false, "no actions button when URL is relative");
    const json = JSON.stringify(blocks);
    suite.expect(
      json.includes("/dashboard?tab=thresholds"),
      "still surfaces relative path",
    );
    suite.expect(
      json.includes("TOOL_HEALTH_APP_URL"),
      "tells operator how to enable a clickable link",
    );
  },
);

await suite.test(
  "config change: ChatProvider send throws → swallowed, ChatProviderSent=false (does not crash caller)",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    const { deps } = makeConfigChangeStubs({ ChatProviderResult: new Error("ChatProvider down") });
    const origErr = console.error;
    console.error = () => {};
    try {
      const result = await notifyToolHealthConfigChange(sampleConfigChange(), deps);
      suite.expectEqual(result.ChatProviderSent, false, "ChatProvider failed");
      suite.expectEqual(result.disabled, false, "not disabled");
    } finally {
      console.error = origErr;
    }
  },
);

await suite.test(
  "config change: clearing an override is rendered as 'default (env baseline)'",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    const { deps, ChatProviderCalls } = makeConfigChangeStubs();
    await notifyToolHealthConfigChange(
      sampleConfigChange({
        before: { errorRateHighPct: 25 },
        after: {}, // override cleared
        note: null,
      }),
      deps,
    );
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("default (env baseline)"),
      `cleared override rendered with baseline label (got: ${blocks.slice(0, 200)}...)`,
    );
    suite.expect(
      !blocks.includes("Note:"),
      "no Note section when note is null",
    );
  },
);

await suite.test(
  "config change: recent audit entries surface in 'Recent changes' block (Task #205)",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-ONCALL";
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    const auditEntries = makeSampleAuditEntries(2);
    const { deps, ChatProviderCalls } = makeConfigChangeStubs({ auditEntries });
    await notifyToolHealthConfigChange(sampleConfigChange(), deps);
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("Recent changes"),
      `blocks include 'Recent changes' heading (got: ${blocks.slice(0, 300)}...)`,
    );
    suite.expect(
      blocks.includes("Alice Admin"),
      "most recent audit author (Alice Admin) appears in recent-changes block",
    );
    suite.expect(
      blocks.includes("Bob Ops"),
      "second audit author (Bob Ops) appears in recent-changes block",
    );
    suite.expect(
      blocks.includes("2026-04-25"),
      "ISO date string appears in recent-changes block",
    );
  },
);

await suite.test(
  "config change: no audit entries → no 'Recent changes' block posted",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-ONCALL";
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    const { deps, ChatProviderCalls } = makeConfigChangeStubs({ auditEntries: [] });
    await notifyToolHealthConfigChange(sampleConfigChange(), deps);
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(
      !blocks.includes("Recent changes"),
      "no 'Recent changes' block when audit is empty",
    );
  },
);

await suite.test(
  "config change: audit fetch error is swallowed, ChatProvider still sends (Task #205)",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-ONCALL";
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    const { deps, ChatProviderCalls } = makeConfigChangeStubs({
      auditError: new Error("DB unavailable"),
    });
    const origErr = console.error;
    const errorLogs: string[] = [];
    console.error = (...args: any[]) => { errorLogs.push(String(args[0])); };
    try {
      const result = await notifyToolHealthConfigChange(sampleConfigChange(), deps);
      suite.expectEqual(result.ChatProviderSent, true, "ChatProvider still sent despite audit error");
      suite.expect(ChatProviderCalls.length === 1, "exactly one ChatProvider call was made");
      suite.expect(
        errorLogs.some((l) => l.includes("Failed to load recent audit")),
        "audit fetch error was logged",
      );
    } finally {
      console.error = origErr;
    }
  },
);

await suite.test(
  "diff helper: only fields whose values change are returned, in declared order",
  async () => {
    const diff = _diffToolHealthConfigOverridesForTests(
      { errorRateHighPct: 20, latencyHighMs: 2000, windowMinutes: 60 },
      { errorRateHighPct: 25, latencyHighMs: 2000, minCalls: 50 },
    );
    // Changes: windowMinutes 60→null, errorRateHighPct 20→25, minCalls null→50
    suite.expectEqual(diff.length, 3, "three changed fields");
    suite.expectEqual(diff[0]?.field, "windowMinutes", "windowMinutes first (declared order)");
    suite.expectEqual(diff[0]?.before, 60, "windowMinutes before");
    suite.expectEqual(diff[0]?.after, null, "windowMinutes after (cleared)");
    suite.expectEqual(diff[1]?.field, "minCalls", "minCalls second");
    suite.expectEqual(diff[1]?.before, null, "minCalls before (unset)");
    suite.expectEqual(diff[1]?.after, 50, "minCalls after");
    suite.expectEqual(diff[2]?.field, "errorRateHighPct", "errorRateHighPct third");
    suite.expectEqual(diff[2]?.before, 20, "errorRateHighPct before");
    suite.expectEqual(diff[2]?.after, 25, "errorRateHighPct after");
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// Task #206 — config-change email notification
// ──────────────────────────────────────────────────────────────────────────────

await suite.test(
  "config change email: opted in with email → sends email with diff and deep-link",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid,user@example.invalid";
    process.env.TOOL_HEALTH_APP_URL = "<REDACTED_URL>";
    const { deps, emailCalls, ChatProviderCalls } = makeConfigChangeStubs();
    const result = await notifyToolHealthConfigChange(sampleConfigChange(), deps);
    suite.expectEqual(result.emailSent, true, "emailSent");
    suite.expectEqual(result.ChatProviderSent, false, "ChatProviderSent false (no ChatProvider channel)");
    suite.expectEqual(result.skipped, false, "not skipped");
    suite.expectEqual(result.disabled, false, "not disabled");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
    suite.expectEqual(emailCalls.length, 1, "one email call");
    suite.expect(
      JSON.stringify(emailCalls[0]?.to) === JSON.stringify(["user@example.invalid", "user@example.invalid"]),
      `both recipients (got: ${JSON.stringify(emailCalls[0]?.to)})`,
    );
    suite.expect(
      emailCalls[0]?.subject.includes("Thresholds Updated"),
      `subject mentions thresholds (got: ${emailCalls[0]?.subject})`,
    );
    suite.expect(
      emailCalls[0]?.subject.includes("Alice Admin"),
      `subject mentions operator (got: ${emailCalls[0]?.subject})`,
    );
    suite.expect(
      emailCalls[0]?.html?.includes("Error rate HIGH"),
      "HTML body lists changed field label",
    );
    suite.expect(
      emailCalls[0]?.html?.includes("<REDACTED_URL>"),
      "HTML body includes deep-link to Alert Thresholds tab",
    );
    suite.expect(
      emailCalls[0]?.text?.includes("Alert Thresholds tab"),
      "plain-text body includes link to Alert Thresholds tab",
    );
    suite.expect(
      emailCalls[0]?.html?.includes("Sev-2 incident #4321"),
      "operator note surfaced in email body",
    );
  },
);

await suite.test(
  "config change email: opted in with no ChatProvider channel and no email → skipped",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    const { deps, emailCalls, ChatProviderCalls } = makeConfigChangeStubs();
    const result = await notifyToolHealthConfigChange(sampleConfigChange(), deps);
    suite.expectEqual(result.skipped, true, "skipped");
    suite.expectEqual(emailCalls.length, 0, "no email");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider");
  },
);

await suite.test(
  "config change email: opted in with both ChatProvider and email → both sent",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-ONCALL";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid";
    const { deps, emailCalls, ChatProviderCalls } = makeConfigChangeStubs();
    const result = await notifyToolHealthConfigChange(sampleConfigChange(), deps);
    suite.expectEqual(result.ChatProviderSent, true, "ChatProviderSent");
    suite.expectEqual(result.emailSent, true, "emailSent");
    suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider call");
    suite.expectEqual(emailCalls.length, 1, "one email call");
  },
);

await suite.test(
  "config change email: email send throws → swallowed, emailSent=false, does not block ChatProvider",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-ONCALL";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid";
    const { deps, ChatProviderCalls } = makeConfigChangeStubs({ emailResult: new Error("EmailProvider down") });
    const origErr = console.error;
    console.error = () => {};
    try {
      const result = await notifyToolHealthConfigChange(sampleConfigChange(), deps);
      suite.expectEqual(result.emailSent, false, "emailSent false");
      suite.expectEqual(result.ChatProviderSent, true, "ChatProviderSent still succeeds");
      suite.expectEqual(ChatProviderCalls.length, 1, "ChatProvider still called");
    } finally {
      console.error = origErr;
    }
  },
);

await suite.test(
  "config change email: audit_id and note surfaced in email body",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid";
    const { deps, emailCalls } = makeConfigChangeStubs();
    await notifyToolHealthConfigChange(
      sampleConfigChange({ audit_id: 42, note: "emergency freeze" }),
      deps,
    );
    suite.expect(
      emailCalls[0]?.html?.includes("#42"),
      "audit_id in HTML body",
    );
    suite.expect(
      emailCalls[0]?.text?.includes("#42"),
      "audit_id in plain-text body",
    );
    suite.expect(
      emailCalls[0]?.html?.includes("emergency freeze"),
      "note in HTML body",
    );
    suite.expect(
      emailCalls[0]?.text?.includes("emergency freeze"),
      "note in plain-text body",
    );
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// Task #213 — override auto-revert ChatProvider notification
// ──────────────────────────────────────────────────────────────────────────────
function makeOverrideStubs(opts: {
  ChatProviderResult?: boolean | Error;
  auditEntries?: ToolHealthConfigAuditEntry[];
  auditError?: Error;
} = {}): {
  deps: ToolHealthOverrideNotifierDeps;
  ChatProviderCalls: ChatProviderCall[];
  auditCalls: number[];
} {
  const ChatProviderCalls: ChatProviderCall[] = [];
  const auditCalls: number[] = [];
  return {
    deps: {
      sendChatProvider: async (channel, text, blocks) => {
        ChatProviderCalls.push({ channel, text, blocks });
        if (opts.ChatProviderResult instanceof Error) throw opts.ChatProviderResult;
        return opts.ChatProviderResult ?? true;
      },
      getAudit: async (limit) => {
        auditCalls.push(limit);
        if (opts.auditError) throw opts.auditError;
        return opts.auditEntries ?? [];
      },
    },
    ChatProviderCalls,
    auditCalls,
  };
}

function sampleOverride(
  overrides: Partial<ToolHealthOverrideExpiredNotification> = {},
): ToolHealthOverrideExpiredNotification {
  return {
    cleared_overrides: { errorRatePct: 99, p95LatencyMs: 30_000 },
    previous_updated_by: "user@example.invalid",
    expired_at: new Date("2026-04-24T09:00:00Z"),
    audit_id: 7777,
    ...overrides,
  };
}

await suite.test(
  "override-expired: no ChatProvider channel configured → skipped without sending",
  async () => {
    clearEnv();
    const { deps, ChatProviderCalls } = makeOverrideStubs();
    const result = await notifyToolHealthOverrideExpired(sampleOverride(), deps);
    suite.expectEqual(result.skipped, true, "skipped");
    suite.expectEqual(result.ChatProviderSent, false, "no ChatProvider sent");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
  },
);

await suite.test(
  "override-expired: posts to TOOL_HEALTH_ChatProvider_CHANNEL with operator + cleared fields + audit deep-link",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-ONCALL-CHAN";
    process.env.TOOL_HEALTH_APP_URL = "<REDACTED_URL>";
    const { deps, ChatProviderCalls } = makeOverrideStubs();
    const result = await notifyToolHealthOverrideExpired(sampleOverride(), deps);
    suite.expectEqual(result.ChatProviderSent, true, "ChatProviderSent");
    suite.expectEqual(result.skipped, false, "not skipped");
    suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider call");
    suite.expectEqual(ChatProviderCalls[0]?.channel, "C-ONCALL-CHAN", "channel");
    suite.expect(
      ChatProviderCalls[0]?.text.includes("user@example.invalid"),
      "fallback text mentions the operator who set the override",
    );
    suite.expect(
      ChatProviderCalls[0]?.text.includes("auto-reverted"),
      "fallback text describes the revert",
    );
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("user@example.invalid"),
      "blocks attribute the override to the operator",
    );
    suite.expect(
      blocks.includes("error-rate breach floor (%)"),
      `blocks describe each cleared field (got: ${blocks.slice(0, 200)}...)`,
    );
    suite.expect(
      blocks.includes("p95 latency breach floor (ms)"),
      "blocks describe the latency override field too",
    );
    suite.expect(
      blocks.includes("99") && blocks.includes("30000"),
      "blocks include the prior values that were cleared",
    );
    suite.expect(
      blocks.includes(
        "<REDACTED_URL>",
      ),
      `blocks deep-link to the audit row (got: ${blocks.slice(0, 400)}...)`,
    );
    suite.expect(
      blocks.includes("audit row #7777"),
      "context footer references the audit row id",
    );
  },
);

await suite.test(
  "override-expired: missing previous_updated_by falls back to 'unknown'",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    const { deps, ChatProviderCalls } = makeOverrideStubs();
    await notifyToolHealthOverrideExpired(
      sampleOverride({ previous_updated_by: null }),
      deps,
    );
    suite.expect(
      ChatProviderCalls[0]?.text.includes("unknown"),
      `fallback text uses 'unknown' (got: ${ChatProviderCalls[0]?.text})`,
    );
  },
);

await suite.test(
  "override-expired: no TOOL_HEALTH_APP_URL → no actions button (ChatProvider rejects relative urls)",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    const { deps, ChatProviderCalls } = makeOverrideStubs();
    await notifyToolHealthOverrideExpired(sampleOverride(), deps);
    const blocks = ChatProviderCalls[0]?.blocks ?? [];
    const hasButton = blocks.some(
      (b: any) =>
        b?.type === "actions" &&
        Array.isArray(b.elements) &&
        b.elements.some((e: any) => e?.type === "button"),
    );
    suite.expectEqual(hasButton, false, "no actions button when URL is relative");
    const json = JSON.stringify(blocks);
    suite.expect(
      json.includes("/dashboard"),
      "still surfaces the relative path as text",
    );
    suite.expect(
      json.includes("TOOL_HEALTH_APP_URL"),
      "tells the operator how to enable a clickable link",
    );
  },
);

await suite.test(
  "override-expired: ChatProvider send throws → swallowed; result reflects failure",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    const { deps } = makeOverrideStubs({ ChatProviderResult: new Error("ChatProvider down") });
    const origErr = console.error;
    console.error = () => {};
    try {
      const result = await notifyToolHealthOverrideExpired(sampleOverride(), deps);
      suite.expectEqual(result.ChatProviderSent, false, "ChatProvider failed");
      suite.expectEqual(result.skipped, false, "not skipped — ChatProvider channel was set");
    } finally {
      console.error = origErr;
    }
  },
);

await suite.test(
  "override-expired: appends 'Recent changes' block from getAudit (Task #384)",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    const { deps, ChatProviderCalls, auditCalls } = makeOverrideStubs({
      auditEntries: makeSampleAuditEntries(3),
    });
    const result = await notifyToolHealthOverrideExpired(sampleOverride(), deps);
    suite.expectEqual(result.ChatProviderSent, true, "ChatProviderSent");
    suite.expectEqual(auditCalls.length, 1, "getAudit called exactly once");
    suite.expectEqual(auditCalls[0], 3, "getAudit called with limit=3");
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("Recent changes (last 3)"),
      `blocks include the Recent changes header (got: ${blocks.slice(0, 400)}...)`,
    );
    suite.expect(
      blocks.includes("Alice Admin") && blocks.includes("Bob Ops"),
      "blocks include the recent changers",
    );
  },
);

await suite.test(
  "override-expired: getAudit error is swallowed; ChatProvider still posts without the block (Task #384)",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    const { deps, ChatProviderCalls } = makeOverrideStubs({
      auditError: new Error("db down"),
    });
    const origErr = console.error;
    console.error = () => {};
    try {
      const result = await notifyToolHealthOverrideExpired(sampleOverride(), deps);
      suite.expectEqual(result.ChatProviderSent, true, "ChatProvider still posts");
      suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider call");
      const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
      suite.expect(
        !blocks.includes("Recent changes"),
        "no Recent changes block when audit fetch failed",
      );
    } finally {
      console.error = origErr;
    }
  },
);

await suite.test(
  "override-expired: empty audit list → no Recent changes block",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    const { deps, ChatProviderCalls } = makeOverrideStubs({ auditEntries: [] });
    await notifyToolHealthOverrideExpired(sampleOverride(), deps);
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(
      !blocks.includes("Recent changes"),
      "no Recent changes block when audit list is empty",
    );
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// Task #167 — tool-health recovery notification
// ──────────────────────────────────────────────────────────────────────────────

function makeRecoveryStubs(opts: {
  ChatProviderResult?: boolean | Error;
  emailResult?: { success: boolean; id?: string; error?: string } | Error;
} = {}): {
  deps: ToolHealthRecoveryNotifierDeps;
  ChatProviderCalls: ChatProviderCall[];
  emailCalls: EmailCall[];
} {
  const ChatProviderCalls: ChatProviderCall[] = [];
  const emailCalls: EmailCall[] = [];
  const deps: ToolHealthRecoveryNotifierDeps = {
    sendChatProvider: async (channel, text, blocks) => {
      ChatProviderCalls.push({ channel, text, blocks });
      if (opts.ChatProviderResult instanceof Error) throw opts.ChatProviderResult;
      return opts.ChatProviderResult ?? true;
    },
    sendEmail: async (mailOpts) => {
      emailCalls.push({
        to: mailOpts.to,
        subject: mailOpts.subject,
        html: mailOpts.html,
        text: mailOpts.text,
      });
      if (opts.emailResult instanceof Error) throw opts.emailResult;
      return opts.emailResult ?? { success: true, id: "stub-id" };
    },
  };
  return { deps, ChatProviderCalls, emailCalls };
}

function sampleRecovery(
  overrides: Partial<ToolHealthRecoveryNotification> = {},
): ToolHealthRecoveryNotification {
  return {
    tool_name: "qms_create_nc",
    agent_name: "qms_agent",
    reason: "error_rate",
    alert_id: 456,
    detail: "auto-resolved: error rate back below threshold (10% < 25% over 60m, 50 calls)",
    ...overrides,
  };
}

await suite.test(
  "recovery: no ChatProvider channel, no email → returns { skipped: true } without sending",
  async () => {
    clearEnv();
    const { deps, ChatProviderCalls, emailCalls } = makeRecoveryStubs();
    const result = await notifyToolHealthRecovery(sampleRecovery(), deps);
    suite.expectEqual(result.skipped, true, "skipped");
    suite.expectEqual(result.ChatProviderSent, false, "no ChatProvider");
    suite.expectEqual(result.emailSent, false, "no email");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
    suite.expectEqual(emailCalls.length, 0, "no email call");
  },
);

await suite.test(
  "recovery: ChatProvider channel configured → posts recovery message to channel with tool name and alert id",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-ONCALL-CHAN";
    process.env.TOOL_HEALTH_APP_URL = "<REDACTED_URL>";
    const { deps, ChatProviderCalls } = makeRecoveryStubs();
    const result = await notifyToolHealthRecovery(sampleRecovery(), deps);
    suite.expectEqual(result.ChatProviderSent, true, "ChatProviderSent");
    suite.expectEqual(result.skipped, false, "not skipped");
    suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider call");
    suite.expectEqual(ChatProviderCalls[0]?.channel, "C-ONCALL-CHAN", "channel");
    suite.expect(
      ChatProviderCalls[0]?.text.includes("qms_create_nc"),
      "fallback text mentions tool",
    );
    suite.expect(
      ChatProviderCalls[0]?.text.includes("456"),
      "fallback text includes alert id",
    );
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("qms_create_nc"),
      "blocks mention tool name",
    );
    suite.expect(
      blocks.includes("#456"),
      "blocks reference alert id",
    );
    suite.expect(
      blocks.includes("<REDACTED_URL>"),
      "blocks link to AI Ops panel",
    );
    suite.expect(
      blocks.includes("white_check_mark") || blocks.toLowerCase().includes("recover"),
      "blocks convey recovery status",
    );
  },
);

await suite.test(
  "recovery: email recipient configured → sends recovery email with RECOVERED subject",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid";
    const { deps, emailCalls } = makeRecoveryStubs();
    const result = await notifyToolHealthRecovery(sampleRecovery(), deps);
    suite.expectEqual(result.emailSent, true, "emailSent");
    suite.expectEqual(result.ChatProviderSent, false, "no ChatProvider when not configured");
    suite.expectEqual(emailCalls.length, 1, "one email call");
    const call = emailCalls[0]!;
    suite.expect(
      call.subject.includes("RECOVERED"),
      `subject includes RECOVERED (got: ${call.subject})`,
    );
    suite.expect(
      call.subject.includes("qms_create_nc"),
      "subject includes tool name",
    );
    suite.expect(
      (call.html ?? "").includes("/dashboard"),
      "email HTML links to AI Operations panel",
    );
    suite.expect(
      (call.text ?? "").includes("/dashboard"),
      "email plaintext links to AI Operations panel",
    );
    suite.expect(
      (call.text ?? "").includes("456"),
      "email text includes alert id",
    );
  },
);

await suite.test(
  "recovery: both ChatProvider and email configured → both senders are invoked",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid";
    const { deps, ChatProviderCalls, emailCalls } = makeRecoveryStubs();
    const result = await notifyToolHealthRecovery(sampleRecovery(), deps);
    suite.expectEqual(result.ChatProviderSent, true, "ChatProviderSent");
    suite.expectEqual(result.emailSent, true, "emailSent");
    suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider call");
    suite.expectEqual(emailCalls.length, 1, "one email call");
  },
);

await suite.test(
  "recovery: ChatProvider send throws → swallowed; email still attempted; result reflects failure",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid";
    const { deps, emailCalls } = makeRecoveryStubs({ ChatProviderResult: new Error("ChatProvider down") });
    const origErr = console.error;
    console.error = () => {};
    try {
      const result = await notifyToolHealthRecovery(sampleRecovery(), deps);
      suite.expectEqual(result.ChatProviderSent, false, "ChatProvider failed");
      suite.expectEqual(result.emailSent, true, "email still went through");
      suite.expectEqual(emailCalls.length, 1, "email attempted");
    } finally {
      console.error = origErr;
    }
  },
);

await suite.test(
  "recovery: p95_latency reason → renders 'P95 latency' in message",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    const { deps, ChatProviderCalls } = makeRecoveryStubs();
    await notifyToolHealthRecovery(
      sampleRecovery({ reason: "p95_latency", detail: "auto-resolved: p95 latency back below threshold" }),
      deps,
    );
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("P95 latency"),
      `blocks reference p95 latency metric (got: ${blocks.slice(0, 200)}...)`,
    );
  },
);

await suite.test(
  "recovery: alert_created_at present → ChatProvider message renders 'Open for: …' duration",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid";
    const { deps, ChatProviderCalls, emailCalls } = makeRecoveryStubs();
    const created = new Date("2026-04-25T10:00:00Z");
    const resolved = new Date("2026-04-25T12:15:00Z"); // 2h 15m later
    await notifyToolHealthRecovery(
      sampleRecovery({ alert_created_at: created, resolved_at: resolved }),
      deps,
    );
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("Open for") && blocks.includes("2h 15m"),
      `ChatProvider blocks include duration "2h 15m" (got: ${blocks.slice(0, 400)})`,
    );
    const emailText = emailCalls[0]?.text ?? "";
    const emailHtml = emailCalls[0]?.html ?? "";
    suite.expect(
      emailText.includes("Open for: 2h 15m"),
      `email plaintext includes 'Open for: 2h 15m' (got: ${emailText})`,
    );
    suite.expect(
      emailHtml.includes("Open for") && emailHtml.includes("2h 15m"),
      `email HTML includes duration (got: ${emailHtml})`,
    );
  },
);

await suite.test(
  "recovery: alert_created_at omitted → 'Open for' field is hidden (back-compat)",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    const { deps, ChatProviderCalls } = makeRecoveryStubs();
    await notifyToolHealthRecovery(sampleRecovery(), deps);
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(
      !blocks.includes("Open for"),
      `ChatProvider blocks omit duration when alert_created_at is missing (got: ${blocks.slice(0, 400)})`,
    );
  },
);

await suite.test(
  "_formatRecoveryDurationForTests: covers seconds, minutes, hours, days, and edge cases",
  async () => {
    const t = (createdMsAgo: number, label: string) => {
      const resolved = new Date("2026-04-25T12:00:00Z");
      const created = new Date(resolved.getTime() - createdMsAgo);
      return _formatRecoveryDurationForTests(created, resolved) === label;
    };
    suite.expect(t(45_000, "45s"), "45 seconds");
    suite.expect(t(12 * 60_000, "12m"), "12 minutes");
    suite.expect(t(2 * 3600_000 + 15 * 60_000, "2h 15m"), "2h 15m");
    suite.expect(t(3 * 3600_000, "3h"), "3h with no remainder minutes");
    suite.expect(t(26 * 3600_000, "1d 2h"), "1d 2h");
    suite.expect(t(48 * 3600_000, "2d"), "2d with no remainder hours");
    suite.expectEqual(
      _formatRecoveryDurationForTests(null),
      null,
      "null createdAt → null",
    );
    // Negative duration (clock skew) → null, not a "−2m" string
    suite.expectEqual(
      _formatRecoveryDurationForTests(
        new Date("2026-04-25T12:05:00Z"),
        new Date("2026-04-25T12:00:00Z"),
      ),
      null,
      "negative duration → null",
    );
    // DB layers occasionally return TIMESTAMP columns as ISO strings
    // (or as epoch ms over an RPC boundary). The formatter must handle
    // those shapes too.
    suite.expectEqual(
      _formatRecoveryDurationForTests(
        "2026-04-25T10:00:00.000Z",
        "2026-04-25T12:30:00.000Z",
      ),
      "2h 30m",
      "ISO-string inputs are accepted",
    );
    suite.expectEqual(
      _formatRecoveryDurationForTests(
        new Date("2026-04-25T12:00:00Z").getTime(),
        new Date("2026-04-25T12:01:30Z").getTime(),
      ),
      "1m",
      "epoch-ms inputs are accepted",
    );
    suite.expectEqual(
      _formatRecoveryDurationForTests("not-a-date"),
      null,
      "unparseable string → null (no Invalid Date crash)",
    );
  },
);

await suite.test(
  "recovery: alert_created_at as ISO string (DB-row shape) still renders duration",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    const { deps, ChatProviderCalls } = makeRecoveryStubs();
    await notifyToolHealthRecovery(
      sampleRecovery({
        alert_created_at: "2026-04-25T10:00:00.000Z",
        resolved_at: "2026-04-25T11:30:00.000Z",
      }),
      deps,
    );
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("Open for") && blocks.includes("1h 30m"),
      `string-typed timestamps still render duration "1h 30m" (got: ${blocks.slice(0, 400)})`,
    );
  },
);

await suite.test(
  "recovery: no TOOL_HEALTH_APP_URL → no ChatProvider action button; relative path surfaced as text",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    const { deps, ChatProviderCalls } = makeRecoveryStubs();
    await notifyToolHealthRecovery(sampleRecovery(), deps);
    const blocks = ChatProviderCalls[0]?.blocks ?? [];
    const hasButton = blocks.some(
      (b: any) =>
        b?.type === "actions" &&
        Array.isArray(b.elements) &&
        b.elements.some((e: any) => e?.type === "button"),
    );
    suite.expectEqual(hasButton, false, "no actions button when URL is relative");
    const json = JSON.stringify(blocks);
    suite.expect(
      json.includes("/dashboard"),
      "still surfaces the relative path as text",
    );
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// Notification delivery-status persistence (Task #284)
//
// Each terminal state of the breach notifier must call recordResult() with
// the matching channel label so the AI Ops dashboard can render a "Notified"
// column. Verified per outcome:
//   • not_configured (ChatProvider + email both unset)
//   • throttled (in-process and DB claim paths)
//   • ChatProvider-only success
//   • email-only success
//   • ChatProvider+email success
//   • ChatProvider_only / email_only when one side fails
//   • failed (both sides fail)
//   • alert_id missing → recordResult is still called (notifier no-ops the
//     alertId-null case downstream so the call is harmless)
//   • recordResult throwing must NOT escape back to the cron
// ──────────────────────────────────────────────────────────────────────────────

await suite.test(
  "task#284: not_configured → recordResult called with 'not_configured' and notifier-clock timestamp",
  async () => {
    clearEnv();
    const NOW = 5_555_000;
    const { deps, recordResultCalls } = makeStubs({ now: NOW });
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.skipped, true, "still reports skipped");
    suite.expectEqual(recordResultCalls.length, 1, "one persist call");
    suite.expectEqual(recordResultCalls[0]?.channel, "not_configured", "channel");
    suite.expectEqual(recordResultCalls[0]?.alertId, 123, "forwards alert_id from notification");
    suite.expectEqual(recordResultCalls[0]?.whenMs, NOW, "uses notifier clock");
  },
);

await suite.test(
  "task#284: in-process throttle → recordResult called with 'throttled'",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";
    let now = 1_000_000;
    const { deps, recordResultCalls } = makeStubs();
    await notifyToolHealthBreach(sample(), { ...deps, now: () => now });
    // Re-call inside window — must hit the in-process fast path.
    now = 1_000_000 + 30 * 60_000;
    const second = await notifyToolHealthBreach(sample(), {
      ...deps,
      now: () => now,
    });
    suite.expectEqual(second.throttled, true, "second call is throttled");
    // First call -> 'ChatProvider', second call -> 'throttled'
    suite.expectEqual(recordResultCalls.length, 2, "two persist calls");
    suite.expectEqual(recordResultCalls[0]?.channel, "ChatProvider", "first persists ChatProvider");
    suite.expectEqual(recordResultCalls[1]?.channel, "throttled", "second persists throttled");
    suite.expectEqual(recordResultCalls[1]?.whenMs, now, "throttled timestamp uses fresh clock");
  },
);

await suite.test(
  "task#284: DB-claim throttle → recordResult called with 'throttled'",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";
    const { deps, recordResultCalls, ChatProviderCalls } = makeStubs({
      claimDbResult: false, // a sibling instance already paged
    });
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.throttled, true, "throttled");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider send when DB-throttled");
    suite.expectEqual(recordResultCalls.length, 1, "persist called once");
    suite.expectEqual(recordResultCalls[0]?.channel, "throttled", "channel");
  },
);

await suite.test(
  "task#284: ChatProvider-only configured + send ok → recordResult called with 'ChatProvider'",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    const { deps, recordResultCalls } = makeStubs();
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.ChatProviderSent, true, "ChatProvider sent");
    suite.expectEqual(recordResultCalls.length, 1, "one persist call");
    suite.expectEqual(recordResultCalls[0]?.channel, "ChatProvider", "channel");
  },
);

await suite.test(
  "task#284: Email-only configured + send ok → recordResult called with 'email'",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid";
    const { deps, recordResultCalls } = makeStubs();
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.emailSent, true, "email sent");
    suite.expectEqual(recordResultCalls.length, 1, "one persist call");
    suite.expectEqual(recordResultCalls[0]?.channel, "email", "channel");
  },
);

await suite.test(
  "task#284: ChatProvider+email both ok → recordResult called with 'ChatProvider+email'",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid";
    const { deps, recordResultCalls } = makeStubs();
    await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(recordResultCalls.length, 1, "one persist call");
    suite.expectEqual(recordResultCalls[0]?.channel, "ChatProvider+email", "channel");
  },
);

await suite.test(
  "task#284: ChatProvider ok + email fails (configured) → 'ChatProvider_only' surfaces the asymmetric outcome",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid";
    const { deps, recordResultCalls } = makeStubs({
      emailResult: { success: false, error: "rate-limited" },
    });
    await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(recordResultCalls[0]?.channel, "ChatProvider_only", "ChatProvider_only when email fails");
  },
);

await suite.test(
  "task#284: Email ok + ChatProvider fails (configured) → 'email_only' surfaces the asymmetric outcome",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid";
    const { deps, recordResultCalls } = makeStubs({
      ChatProviderResult: false,
    });
    await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(recordResultCalls[0]?.channel, "email_only", "email_only when ChatProvider fails");
  },
);

await suite.test(
  "task#284: both senders fail (both configured) → 'failed'",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid";
    const { deps, recordResultCalls } = makeStubs({
      ChatProviderResult: false,
      emailResult: { success: false },
    });
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.ChatProviderSent, false, "ChatProvider failed");
    suite.expectEqual(result.emailSent, false, "email failed");
    suite.expectEqual(recordResultCalls[0]?.channel, "failed", "failed channel");
  },
);

await suite.test(
  "task#284: recordResult throwing does NOT escape — notifier still returns its result",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    const { deps } = makeStubs({
      recordResultThrows: new Error("boom"),
    });
    // Must not throw out — the cron relies on this contract.
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.ChatProviderSent, true, "send still succeeded");
  },
);

await suite.test(
  "task#284: missing alert_id still calls recordResult (recorder is responsible for the no-op)",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    const { deps, recordResultCalls } = makeStubs();
    await notifyToolHealthBreach(sample({ alert_id: undefined }), deps);
    suite.expectEqual(recordResultCalls.length, 1, "still called");
    suite.expectEqual(recordResultCalls[0]?.alertId, null, "alert_id forwarded as null");
    suite.expectEqual(recordResultCalls[0]?.channel, "ChatProvider", "channel reflects the send");
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// Task #347 — per-tool / global recovery notification opt-out
// ──────────────────────────────────────────────────────────────────────────────

await suite.test(
  "recovery opt-out: TOOL_HEALTH_RECOVERY_NOTIFY=0 silences ALL recoveries (returns skipped+disabled)",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "user@example.invalid";
    process.env.TOOL_HEALTH_RECOVERY_NOTIFY = "0";
    const { deps, ChatProviderCalls, emailCalls } = makeRecoveryStubs();
    const result = await notifyToolHealthRecovery(sampleRecovery(), deps);
    suite.expectEqual(result.skipped, true, "skipped");
    suite.expectEqual(result.disabled, true, "disabled flag set");
    suite.expectEqual(result.ChatProviderSent, false, "no ChatProvider");
    suite.expectEqual(result.emailSent, false, "no email");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
    suite.expectEqual(emailCalls.length, 0, "no email call");
  },
);

await suite.test(
  "recovery opt-out: TOOL_HEALTH_RECOVERY_NOTIFY accepts false/no/off (case-insensitive)",
  async () => {
    for (const off of ["false", "FALSE", "no", "Off"]) {
      clearEnv();
      process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
      process.env.TOOL_HEALTH_RECOVERY_NOTIFY = off;
      const { deps, ChatProviderCalls } = makeRecoveryStubs();
      const result = await notifyToolHealthRecovery(sampleRecovery(), deps);
      suite.expectEqual(result.disabled, true, `disabled for value '${off}'`);
      suite.expectEqual(ChatProviderCalls.length, 0, `no ChatProvider call for '${off}'`);
    }
  },
);

await suite.test(
  "recovery opt-out: TOOL_HEALTH_RECOVERY_NOTIFY=1 (or unset) leaves recoveries enabled",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_RECOVERY_NOTIFY = "1";
    const { deps, ChatProviderCalls } = makeRecoveryStubs();
    const result = await notifyToolHealthRecovery(sampleRecovery(), deps);
    suite.expectEqual(result.disabled, false, "not disabled");
    suite.expectEqual(result.ChatProviderSent, true, "ChatProvider sent");
    suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider call");
  },
);

await suite.test(
  "recovery opt-out: TOOL_HEALTH_RECOVERY_SKIP_TOOLS silences only the listed tools",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_RECOVERY_SKIP_TOOLS =
      "qms_create_nc, other_noisy_tool";

    // Listed tool → suppressed.
    const { deps: depsA, ChatProviderCalls: ChatProviderA } = makeRecoveryStubs();
    const a = await notifyToolHealthRecovery(
      sampleRecovery({ tool_name: "qms_create_nc" }),
      depsA,
    );
    suite.expectEqual(a.disabled, true, "listed tool disabled");
    suite.expectEqual(a.skipped, true, "listed tool skipped");
    suite.expectEqual(ChatProviderA.length, 0, "no ChatProvider for listed tool");

    // Unlisted tool → still pages.
    const { deps: depsB, ChatProviderCalls: ChatProviderB } = makeRecoveryStubs();
    const b = await notifyToolHealthRecovery(
      sampleRecovery({ tool_name: "quiet_tool" }),
      depsB,
    );
    suite.expectEqual(b.disabled, false, "unlisted tool not disabled");
    suite.expectEqual(b.ChatProviderSent, true, "unlisted tool still pages");
    suite.expectEqual(ChatProviderB.length, 1, "one ChatProvider for unlisted tool");
  },
);

await suite.test(
  "recovery opt-out: TOOL_HEALTH_RECOVERY_SKIP_TOOLS matches case-insensitively",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ChatProvider_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_RECOVERY_SKIP_TOOLS = "QMS_Create_NC";
    const { deps, ChatProviderCalls } = makeRecoveryStubs();
    const result = await notifyToolHealthRecovery(
      sampleRecovery({ tool_name: "qms_create_nc" }),
      deps,
    );
    suite.expectEqual(result.disabled, true, "case-insensitive match");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
  },
);

await suite.test(
  "recovery opt-out: opt-out short-circuits BEFORE the no-transport-configured check",
  // When the operator explicitly opted out we want `disabled: true` rather
  // than masquerading as "no ChatProvider/email configured" — dashboards rely on
  // that distinction to decide whether to nag ops to wire up a transport.
  async () => {
    clearEnv();
    // Note: NO ChatProvider channel and NO email recipient configured.
    process.env.TOOL_HEALTH_RECOVERY_NOTIFY = "0";
    const { deps } = makeRecoveryStubs();
    const result = await notifyToolHealthRecovery(sampleRecovery(), deps);
    suite.expectEqual(result.disabled, true, "disabled wins over plain skipped");
    suite.expectEqual(result.skipped, true, "skipped also true");
  },
);

clearEnv();
suite.finishOrExit();
