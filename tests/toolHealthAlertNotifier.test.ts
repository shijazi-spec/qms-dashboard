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
  notifyToolHealthConfigChange,
  notifyToolHealthOverrideExpired,
  notifyToolHealthRecovery,
  _diffToolHealthConfigOverridesForTests,
  _resetToolHealthNotifierThrottleForTests,
  type ToolHealthBreachNotification,
  type ToolHealthNotifierDeps,
  type ToolHealthConfigChangeNotification,
  type ToolHealthOverrideExpiredNotification,
  type ToolHealthOverrideNotifierDeps,
  type ToolHealthRecoveryNotification,
  type ToolHealthRecoveryNotifierDeps,
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
  "TOOL_HEALTH_CONFIG_NOTIFY",
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


// ──────────────────────────────────────────────────────────────────────────────
// Tool-health threshold-tuning notifier (Task #190)
// ──────────────────────────────────────────────────────────────────────────────
function makeConfigChangeStubs(opts: {
  slackResult?: boolean | Error;
} = {}): {
  deps: { sendSlack: ToolHealthNotifierDeps["sendSlack"] };
  slackCalls: SlackCall[];
} {
  const slackCalls: SlackCall[] = [];
  return {
    slackCalls,
    deps: {
      sendSlack: async (channel, text, blocks) => {
        slackCalls.push({ channel, text, blocks });
        if (opts.slackResult instanceof Error) throw opts.slackResult;
        return opts.slackResult ?? true;
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
  "config change: TOOL_HEALTH_CONFIG_NOTIFY unset → disabled, no slack call",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    const { deps, slackCalls } = makeConfigChangeStubs();
    const result = await notifyToolHealthConfigChange(sampleConfigChange(), deps);
    suite.expectEqual(result.disabled, true, "disabled");
    suite.expectEqual(result.slackSent, false, "no slack");
    suite.expectEqual(slackCalls.length, 0, "no slack call");
  },
);

await suite.test(
  "config change: TOOL_HEALTH_CONFIG_NOTIFY=0 → disabled, no slack call",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "0";
    const { deps, slackCalls } = makeConfigChangeStubs();
    const result = await notifyToolHealthConfigChange(sampleConfigChange(), deps);
    suite.expectEqual(result.disabled, true, "disabled");
    suite.expectEqual(slackCalls.length, 0, "no slack call");
  },
);

await suite.test(
  "config change: opted in but no Slack channel → skipped, no slack call",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    const { deps, slackCalls } = makeConfigChangeStubs();
    const result = await notifyToolHealthConfigChange(sampleConfigChange(), deps);
    suite.expectEqual(result.skipped, true, "skipped");
    suite.expectEqual(result.disabled, false, "not disabled");
    suite.expectEqual(slackCalls.length, 0, "no slack call");
  },
);

await suite.test(
  "config change: identical before/after → noChanges, no slack call",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    const { deps, slackCalls } = makeConfigChangeStubs();
    const result = await notifyToolHealthConfigChange(
      sampleConfigChange({
        before: { errorRateHighPct: 20 },
        after: { errorRateHighPct: 20 },
      }),
      deps,
    );
    suite.expectEqual(result.noChanges, true, "noChanges");
    suite.expectEqual(result.slackSent, false, "no slack send");
    suite.expectEqual(slackCalls.length, 0, "no slack call");
  },
);

await suite.test(
  "config change: opted in with channel → posts diff to Slack with deep-link",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    process.env.TOOL_HEALTH_APP_URL = "https://qms.example.com";
    const { deps, slackCalls } = makeConfigChangeStubs();
    const result = await notifyToolHealthConfigChange(sampleConfigChange(), deps);
    suite.expectEqual(result.slackSent, true, "slackSent");
    suite.expectEqual(result.disabled, false, "not disabled");
    suite.expectEqual(result.skipped, false, "not skipped");
    suite.expectEqual(slackCalls.length, 1, "one slack call");
    suite.expectEqual(slackCalls[0]?.channel, "C-ONCALL", "channel");
    const blocks = JSON.stringify(slackCalls[0]?.blocks ?? []);
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
      blocks.includes("https://qms.example.com/dashboard/ai-ops.html?tab=thresholds"),
      `blocks include deep-link to Alert Thresholds tab (got: ${blocks.slice(0, 200)}...)`,
    );
    suite.expect(
      slackCalls[0]?.text.includes("thresholds"),
      "fallback text mentions thresholds",
    );
  },
);

await suite.test(
  "config change: no TOOL_HEALTH_APP_URL → no actions button, still surfaces relative path",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    const { deps, slackCalls } = makeConfigChangeStubs();
    await notifyToolHealthConfigChange(sampleConfigChange(), deps);
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
      json.includes("/dashboard/ai-ops.html?tab=thresholds"),
      "still surfaces relative path",
    );
    suite.expect(
      json.includes("TOOL_HEALTH_APP_URL"),
      "tells operator how to enable a clickable link",
    );
  },
);

await suite.test(
  "config change: Slack send throws → swallowed, slackSent=false (does not crash caller)",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    const { deps } = makeConfigChangeStubs({ slackResult: new Error("slack down") });
    const origErr = console.error;
    console.error = () => {};
    try {
      const result = await notifyToolHealthConfigChange(sampleConfigChange(), deps);
      suite.expectEqual(result.slackSent, false, "slack failed");
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
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
    const { deps, slackCalls } = makeConfigChangeStubs();
    await notifyToolHealthConfigChange(
      sampleConfigChange({
        before: { errorRateHighPct: 25 },
        after: {}, // override cleared
        note: null,
      }),
      deps,
    );
    const blocks = JSON.stringify(slackCalls[0]?.blocks ?? []);
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
// Task #213 — override auto-revert Slack notification
// ──────────────────────────────────────────────────────────────────────────────
function makeOverrideStubs(opts: { slackResult?: boolean | Error } = {}): {
  deps: ToolHealthOverrideNotifierDeps;
  slackCalls: SlackCall[];
} {
  const slackCalls: SlackCall[] = [];
  return {
    deps: {
      sendSlack: async (channel, text, blocks) => {
        slackCalls.push({ channel, text, blocks });
        if (opts.slackResult instanceof Error) throw opts.slackResult;
        return opts.slackResult ?? true;
      },
    },
    slackCalls,
  };
}

function sampleOverride(
  overrides: Partial<ToolHealthOverrideExpiredNotification> = {},
): ToolHealthOverrideExpiredNotification {
  return {
    cleared_overrides: { errorRatePct: 99, p95LatencyMs: 30_000 },
    previous_updated_by: "alice@example.com",
    expired_at: new Date("2026-04-24T09:00:00Z"),
    audit_id: 7777,
    ...overrides,
  };
}

await suite.test(
  "override-expired: no Slack channel configured → skipped without sending",
  async () => {
    clearEnv();
    const { deps, slackCalls } = makeOverrideStubs();
    const result = await notifyToolHealthOverrideExpired(sampleOverride(), deps);
    suite.expectEqual(result.skipped, true, "skipped");
    suite.expectEqual(result.slackSent, false, "no slack sent");
    suite.expectEqual(slackCalls.length, 0, "no slack call");
  },
);

await suite.test(
  "override-expired: posts to TOOL_HEALTH_SLACK_CHANNEL with operator + cleared fields + audit deep-link",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL-CHAN";
    process.env.TOOL_HEALTH_APP_URL = "https://qms.example.com";
    const { deps, slackCalls } = makeOverrideStubs();
    const result = await notifyToolHealthOverrideExpired(sampleOverride(), deps);
    suite.expectEqual(result.slackSent, true, "slackSent");
    suite.expectEqual(result.skipped, false, "not skipped");
    suite.expectEqual(slackCalls.length, 1, "one slack call");
    suite.expectEqual(slackCalls[0]?.channel, "C-ONCALL-CHAN", "channel");
    suite.expect(
      slackCalls[0]?.text.includes("alice@example.com"),
      "fallback text mentions the operator who set the override",
    );
    suite.expect(
      slackCalls[0]?.text.includes("auto-reverted"),
      "fallback text describes the revert",
    );
    const blocks = JSON.stringify(slackCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("alice@example.com"),
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
        "https://qms.example.com/dashboard/ai-ops.html?tab=thresholds#threshold-audit-7777",
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
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    const { deps, slackCalls } = makeOverrideStubs();
    await notifyToolHealthOverrideExpired(
      sampleOverride({ previous_updated_by: null }),
      deps,
    );
    suite.expect(
      slackCalls[0]?.text.includes("unknown"),
      `fallback text uses 'unknown' (got: ${slackCalls[0]?.text})`,
    );
  },
);

await suite.test(
  "override-expired: no TOOL_HEALTH_APP_URL → no actions button (Slack rejects relative urls)",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    const { deps, slackCalls } = makeOverrideStubs();
    await notifyToolHealthOverrideExpired(sampleOverride(), deps);
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
  },
);

await suite.test(
  "override-expired: Slack send throws → swallowed; result reflects failure",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    const { deps } = makeOverrideStubs({ slackResult: new Error("slack down") });
    const origErr = console.error;
    console.error = () => {};
    try {
      const result = await notifyToolHealthOverrideExpired(sampleOverride(), deps);
      suite.expectEqual(result.slackSent, false, "slack failed");
      suite.expectEqual(result.skipped, false, "not skipped — Slack channel was set");
    } finally {
      console.error = origErr;
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// Task #167 — tool-health recovery notification
// ──────────────────────────────────────────────────────────────────────────────

function makeRecoveryStubs(opts: {
  slackResult?: boolean | Error;
  emailResult?: { success: boolean; id?: string; error?: string } | Error;
} = {}): {
  deps: ToolHealthRecoveryNotifierDeps;
  slackCalls: SlackCall[];
  emailCalls: EmailCall[];
} {
  const slackCalls: SlackCall[] = [];
  const emailCalls: EmailCall[] = [];
  const deps: ToolHealthRecoveryNotifierDeps = {
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
  };
  return { deps, slackCalls, emailCalls };
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
  "recovery: no Slack channel, no email → returns { skipped: true } without sending",
  async () => {
    clearEnv();
    const { deps, slackCalls, emailCalls } = makeRecoveryStubs();
    const result = await notifyToolHealthRecovery(sampleRecovery(), deps);
    suite.expectEqual(result.skipped, true, "skipped");
    suite.expectEqual(result.slackSent, false, "no slack");
    suite.expectEqual(result.emailSent, false, "no email");
    suite.expectEqual(slackCalls.length, 0, "no slack call");
    suite.expectEqual(emailCalls.length, 0, "no email call");
  },
);

await suite.test(
  "recovery: Slack channel configured → posts recovery message to channel with tool name and alert id",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL-CHAN";
    process.env.TOOL_HEALTH_APP_URL = "https://qms.example.com";
    const { deps, slackCalls } = makeRecoveryStubs();
    const result = await notifyToolHealthRecovery(sampleRecovery(), deps);
    suite.expectEqual(result.slackSent, true, "slackSent");
    suite.expectEqual(result.skipped, false, "not skipped");
    suite.expectEqual(slackCalls.length, 1, "one slack call");
    suite.expectEqual(slackCalls[0]?.channel, "C-ONCALL-CHAN", "channel");
    suite.expect(
      slackCalls[0]?.text.includes("qms_create_nc"),
      "fallback text mentions tool",
    );
    suite.expect(
      slackCalls[0]?.text.includes("456"),
      "fallback text includes alert id",
    );
    const blocks = JSON.stringify(slackCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("qms_create_nc"),
      "blocks mention tool name",
    );
    suite.expect(
      blocks.includes("#456"),
      "blocks reference alert id",
    );
    suite.expect(
      blocks.includes("https://qms.example.com/dashboard/ai-ops.html"),
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
    process.env.TOOL_HEALTH_ALERT_EMAIL = "oncall@example.com";
    const { deps, emailCalls } = makeRecoveryStubs();
    const result = await notifyToolHealthRecovery(sampleRecovery(), deps);
    suite.expectEqual(result.emailSent, true, "emailSent");
    suite.expectEqual(result.slackSent, false, "no slack when not configured");
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
      (call.html ?? "").includes("/dashboard/ai-ops.html"),
      "email HTML links to AI Operations panel",
    );
    suite.expect(
      (call.text ?? "").includes("/dashboard/ai-ops.html"),
      "email plaintext links to AI Operations panel",
    );
    suite.expect(
      (call.text ?? "").includes("456"),
      "email text includes alert id",
    );
  },
);

await suite.test(
  "recovery: both Slack and email configured → both senders are invoked",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "oncall@example.com";
    const { deps, slackCalls, emailCalls } = makeRecoveryStubs();
    const result = await notifyToolHealthRecovery(sampleRecovery(), deps);
    suite.expectEqual(result.slackSent, true, "slackSent");
    suite.expectEqual(result.emailSent, true, "emailSent");
    suite.expectEqual(slackCalls.length, 1, "one slack call");
    suite.expectEqual(emailCalls.length, 1, "one email call");
  },
);

await suite.test(
  "recovery: Slack send throws → swallowed; email still attempted; result reflects failure",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    process.env.TOOL_HEALTH_ALERT_EMAIL = "oncall@example.com";
    const { deps, emailCalls } = makeRecoveryStubs({ slackResult: new Error("slack down") });
    const origErr = console.error;
    console.error = () => {};
    try {
      const result = await notifyToolHealthRecovery(sampleRecovery(), deps);
      suite.expectEqual(result.slackSent, false, "slack failed");
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
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    const { deps, slackCalls } = makeRecoveryStubs();
    await notifyToolHealthRecovery(
      sampleRecovery({ reason: "p95_latency", detail: "auto-resolved: p95 latency back below threshold" }),
      deps,
    );
    const blocks = JSON.stringify(slackCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("P95 latency"),
      `blocks reference p95 latency metric (got: ${blocks.slice(0, 200)}...)`,
    );
  },
);

await suite.test(
  "recovery: no TOOL_HEALTH_APP_URL → no Slack action button; relative path surfaced as text",
  async () => {
    clearEnv();
    process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-OPS";
    const { deps, slackCalls } = makeRecoveryStubs();
    await notifyToolHealthRecovery(sampleRecovery(), deps);
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
  },
);

clearEnv();
suite.finishOrExit();
