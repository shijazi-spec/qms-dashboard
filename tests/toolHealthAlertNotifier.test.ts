/**
 * Unit tests for the tool-health on-call notifier.
 *
 * Covers the behavior added in Task #128:
 *   • No-op (skipped) when neither Slack channel nor email recipient is
 *     configured — so the cron can call us unconditionally in dev/test.
 *   • Slack-only / email-only / both wiring through env vars.
 *   • In-process throttle keyed on `<tool_name>:<reason>` so a flapping
 *     breach does not double-page within `TOOL_HEALTH_NOTIFY_THROTTLE_MIN`.
 *   • Slack/email transport errors do not throw out of `notifyToolHealthBreach`
 *     and do not poison the throttle map.
 *   • Multiple comma-separated email recipients are forwarded as an array.
 *   • Built link points to `/dashboard/ai-ops.html` and honours
 *     `TOOL_HEALTH_APP_URL`.
 *
 * Run:  npx tsx tests/toolHealthAlertNotifier.test.ts
 * Wired: discovered automatically by tests/runIntegrationTests.ts (npm test).
 */

import {
  notifyToolHealthBreach,
  _resetToolHealthNotifierThrottleForTests,
  type ToolHealthBreachNotification,
  type ToolHealthNotifierDeps,
} from "../src/utils/toolHealthAlertNotifier";
import { TestSuite } from "./_helpers/runner";

interface SlackCall {
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

function makeStubs(opts: {
  slackResult?: boolean | Error;
  emailResult?: { success: boolean; id?: string; error?: string } | Error;
  now?: number;
} = {}): {
  deps: ToolHealthNotifierDeps;
  slackCalls: SlackCall[];
  emailCalls: EmailCall[];
} {
  const slackCalls: SlackCall[] = [];
  const emailCalls: EmailCall[] = [];
  const deps: ToolHealthNotifierDeps = {
    sendSlack: async (channel, text, blocks) => {
      slackCalls.push({ channel, text, blocks });
      if (opts.slackResult instanceof Error) throw opts.slackResult;
      return opts.slackResult ?? true;
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
  };
  return { deps, slackCalls, emailCalls };
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
  "TOOL_HEALTH_SLACK_CHANNEL",
  "TOOL_HEALTH_SLACK_USE_DEFAULT_CHANNEL",
  "TOOL_HEALTH_ALERT_EMAIL",
  "TOOL_HEALTH_NOTIFY_THROTTLE_MIN",
  "TOOL_HEALTH_APP_URL",
  "SLACK_CHANNEL_ID",
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  _resetToolHealthNotifierThrottleForTests();
}

const suite = new TestSuite("toolHealthAlertNotifier");
console.log("\n=== toolHealthAlertNotifier tests ===\n");

await suite.test(
  "no Slack channel, no email recipient → returns { skipped: true } without sending",
  async () => {
    clearEnv();
    const { deps, slackCalls, emailCalls } = makeStubs();
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.skipped, true, "skipped");
    suite.expectEqual(result.slackSent, false, "no slack");
    suite.expectEqual(result.emailSent, false, "no email");
    suite.expectEqual(result.throttled, false, "not throttled");
    suite.expectEqual(slackCalls.length, 0, "no slack call");
    suite.expectEqual(emailCalls.length, 0, "no email call");
  },
);

await suite.test(
  "Slack channel configured → posts to TOOL_HEALTH_SLACK_CHANNEL with link to AI Ops",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL-CHAN";
    process.env.TOOL_HEALTH_APP_URL = "https://qms.example.com/";
    const { deps, slackCalls, emailCalls } = makeStubs();
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.slackSent, true, "slackSent");
    suite.expectEqual(result.emailSent, false, "no email when not configured");
    suite.expectEqual(result.skipped, false, "not skipped");
    suite.expectEqual(slackCalls.length, 1, "one slack call");
    suite.expectEqual(slackCalls[0]?.channel, "C-ONCALL-CHAN", "channel");
    suite.expect(
      slackCalls[0]?.text.includes("qms_create_nc"),
      "fallback text mentions tool",
    );
    // Link button must point at the AI Ops panel under the configured base URL.
    const blocks = JSON.stringify(slackCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("https://qms.example.com/dashboard/ai-ops.html"),
      `slack blocks contain link to AI Ops panel (got: ${blocks.slice(0, 200)}...)`,
    );
    // Dedupe key should appear in the context footer for traceability.
    suite.expect(
      blocks.includes("qms_create_nc:error_rate"),
      "slack blocks reference the dedupe key",
    );
    suite.expectEqual(emailCalls.length, 0, "no email call");
  },
);

await suite.test(
  "email recipient configured → posts via Resend with severity-prefixed subject",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ALERT_EMAIL = "oncall@example.com";
    const { deps, slackCalls, emailCalls } = makeStubs();
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.emailSent, true, "emailSent");
    suite.expectEqual(result.slackSent, false, "slack not sent");
    suite.expectEqual(emailCalls.length, 1, "one email call");
    const call = emailCalls[0]!;
    suite.expect(
      Array.isArray(call.to)
        ? (call.to as string[]).includes("oncall@example.com")
        : call.to === "oncall@example.com",
      "recipient propagated",
    );
    suite.expect(
      call.subject.startsWith("[Tool Health · HIGH]"),
      `subject prefixed with severity (got: ${call.subject})`,
    );
    suite.expect(
      (call.html ?? "").includes("/dashboard/ai-ops.html"),
      "email HTML links to AI Operations panel",
    );
    suite.expect(
      (call.text ?? "").includes("/dashboard/ai-ops.html"),
      "email plaintext links to AI Operations panel",
    );
    suite.expectEqual(slackCalls.length, 0, "no slack");
  },
);

await suite.test(
  "comma-separated TOOL_HEALTH_ALERT_EMAIL → forwarded as recipient array",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_ALERT_EMAIL = "a@example.com, b@example.com ,c@example.com";
    const { deps, emailCalls } = makeStubs();
    await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(emailCalls.length, 1, "one email call");
    const recipients = Array.isArray(emailCalls[0]?.to)
      ? (emailCalls[0]!.to as string[])
      : [emailCalls[0]!.to as string];
    suite.expectEqual(recipients.length, 3, "three recipients");
    suite.expectEqual(recipients[0], "a@example.com", "trimmed first");
    suite.expectEqual(recipients[1], "b@example.com", "trimmed middle");
    suite.expectEqual(recipients[2], "c@example.com", "trimmed last");
  },
);

await suite.test(
  "both Slack and email configured → both senders are invoked",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "oncall@example.com";
    const { deps, slackCalls, emailCalls } = makeStubs();
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.slackSent, true, "slackSent");
    suite.expectEqual(result.emailSent, true, "emailSent");
    suite.expectEqual(slackCalls.length, 1, "one slack call");
    suite.expectEqual(emailCalls.length, 1, "one email call");
  },
);

await suite.test(
  "throttle: same dedupe key called twice in window → second call short-circuits",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";
    let now = 1_000_000;
    const { deps, slackCalls } = makeStubs({ now });

    const first = await notifyToolHealthBreach(sample(), {
      ...deps,
      now: () => now,
    });
    suite.expectEqual(first.slackSent, true, "first send goes through");
    suite.expectEqual(first.throttled, false, "first not throttled");

    // 30 minutes later, well inside the 60-min window
    now = 1_000_000 + 30 * 60_000;
    const second = await notifyToolHealthBreach(sample(), {
      ...deps,
      now: () => now,
    });
    suite.expectEqual(second.throttled, true, "second is throttled");
    suite.expectEqual(second.slackSent, false, "no slack send on throttle");
    suite.expectEqual(slackCalls.length, 1, "still only one slack call total");
  },
);

await suite.test(
  "throttle: past window → key is paged again",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";
    let now = 1_000_000;
    const { deps, slackCalls } = makeStubs();

    await notifyToolHealthBreach(sample(), { ...deps, now: () => now });

    now = 1_000_000 + 61 * 60_000; // past 60-min throttle
    const second = await notifyToolHealthBreach(sample(), {
      ...deps,
      now: () => now,
    });
    suite.expectEqual(second.throttled, false, "second NOT throttled past window");
    suite.expectEqual(second.slackSent, true, "second slack send goes through");
    suite.expectEqual(slackCalls.length, 2, "two slack calls total");
  },
);

await suite.test(
  "throttle: distinct dedupe keys are independent",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";
    const now = 1_000_000;
    const { deps, slackCalls } = makeStubs();
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
      slackCalls.length,
      3,
      "all three keys page independently",
    );
  },
);

await suite.test(
  "throttle: failed Slack send does NOT poison throttle (next call retries)",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";
    const now = 1_000_000;
    const { deps: failingDeps, slackCalls } = makeStubs({ slackResult: false });

    const first = await notifyToolHealthBreach(sample(), {
      ...failingDeps,
      now: () => now,
    });
    suite.expectEqual(first.slackSent, false, "send reported as failed");
    suite.expectEqual(first.throttled, false, "not throttled");
    suite.expectEqual(slackCalls.length, 1, "one slack attempt");

    // Next call (succeeds) should NOT be throttled, since the previous
    // attempt failed and never recorded into the throttle map.
    const { deps: okDeps, slackCalls: okCalls } = makeStubs();
    const second = await notifyToolHealthBreach(sample(), {
      ...okDeps,
      now: () => now,
    });
    suite.expectEqual(second.slackSent, true, "retry goes through");
    suite.expectEqual(second.throttled, false, "retry not throttled");
    suite.expectEqual(okCalls.length, 1, "retry made one slack call");
  },
);

await suite.test(
  "Slack send throws → swallowed; email still attempted; result reflects failure",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "oncall@example.com";
    const { deps, emailCalls } = makeStubs({
      slackResult: new Error("slack down"),
    });

    // Silence the expected error log.
    const origErr = console.error;
    console.error = () => {};
    try {
      const result = await notifyToolHealthBreach(sample(), deps);
      suite.expectEqual(result.slackSent, false, "slack failed");
      suite.expectEqual(result.emailSent, true, "email still went through");
      suite.expectEqual(emailCalls.length, 1, "email attempted");
    } finally {
      console.error = origErr;
    }
  },
);

await suite.test(
  "TOOL_HEALTH_SLACK_USE_DEFAULT_CHANNEL=1 falls back to SLACK_CHANNEL_ID",
  async () => {
    clearEnv();
    process.env.SLACK_CHANNEL_ID = "C-DEFAULT";
    process.env.TOOL_HEALTH_SLACK_USE_DEFAULT_CHANNEL = "1";
    const { deps, slackCalls } = makeStubs();
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.slackSent, true, "slackSent");
    suite.expectEqual(slackCalls[0]?.channel, "C-DEFAULT", "fell back to default channel");
  },
);

await suite.test(
  "SLACK_CHANNEL_ID alone (without opt-in) does NOT page tool-health",
  // Guards against accidentally posting tool-health alerts to whatever
  // channel another module is using as its general Slack target.
  async () => {
    clearEnv();
    process.env.SLACK_CHANNEL_ID = "C-QMS";
    const { deps, slackCalls } = makeStubs();
    const result = await notifyToolHealthBreach(sample(), deps);
    suite.expectEqual(result.skipped, true, "skipped");
    suite.expectEqual(slackCalls.length, 0, "no slack call");
  },
);

await suite.test(
  "no TOOL_HEALTH_APP_URL → no Slack action button (Slack rejects relative urls)",
  // Slack's blocks API requires `actions.button.url` to be an absolute URL;
  // posting a relative path causes the entire message to be rejected with
  // `invalid_blocks`. The notifier must degrade gracefully to a plain
  // mrkdwn-link section so dev/test environments still get a valid (if
  // unclickable) message.
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    const { deps, slackCalls } = makeStubs();
    await notifyToolHealthBreach(sample(), deps);
    const blocks = slackCalls[0]?.blocks ?? [];
    const hasButton = blocks.some(
      (b: any) =>
        b?.type === "actions" &&
        Array.isArray(b.elements) &&
        b.elements.some((e: any) => e?.type === "button"),
    );
    suite.expectEqual(hasButton, false, "no actions button when URL is relative");
    const json = JSON.stringify(blocks);
    suite.expect(
      json.includes("/dashboard/ai-ops.html"),
      "still surfaces the relative path as text",
    );
    suite.expect(
      json.includes("TOOL_HEALTH_APP_URL"),
      "tells the operator how to enable a clickable link",
    );
    suite.expect(
      !json.includes("https:///dashboard/ai-ops.html"),
      "no malformed URL with empty origin",
    );
  },
);

await suite.test(
  "TOOL_HEALTH_APP_URL set → Slack action button is rendered with absolute URL",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_APP_URL = "https://qms.example.com";
    const { deps, slackCalls } = makeStubs();
    await notifyToolHealthBreach(sample(), deps);
    const blocks = slackCalls[0]?.blocks ?? [];
    const button = blocks
      .find((b: any) => b?.type === "actions")
      ?.elements?.find((e: any) => e?.type === "button");
    suite.expect(!!button, "actions button rendered when URL is absolute");
    suite.expectEqual(
      button?.url,
      "https://qms.example.com/dashboard/ai-ops.html",
      "button URL is absolute and points to AI Ops panel",
    );
  },
);

clearEnv();
suite.finishOrExit();
