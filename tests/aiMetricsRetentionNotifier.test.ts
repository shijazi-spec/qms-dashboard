/**
 * Unit tests for the AI-metrics-retention change notifier (Task #549).
 *
 * Coverage matrix:
 *   • Disabled when `AI_METRICS_RETENTION_NOTIFY` is not "1" (default for
 *     dev/test environments).
 *   • Skipped when neither Slack nor email is configured (route handler can
 *     call the notifier unconditionally without paging on-call from a fresh
 *     checkout).
 *   • Enqueues a Slack post with the operator name, before/after value,
 *     audit row id and operator note when wired up correctly — proves the
 *     happy-path "PUT enqueues a notification" branch.
 *   • Sends an email via Resend with a descriptive subject when an email
 *     recipient is set.
 *   • Returns `noChanges: true` (and does NOT call Slack/email) when
 *     before === after — covers the "skipped when the value is unchanged"
 *     contract from the task description.
 *   • A cleared override (`after: null`) renders the new effective value
 *     in the Slack body so on-call knows what the next prune will use.
 *   • Slack/email transport errors are swallowed and never propagate back
 *     to the route handler.
 *
 * Run:  npx tsx tests/aiMetricsRetentionNotifier.test.ts
 * Wired: discovered automatically by tests/runIntegrationTests.ts (npm test).
 */

import {
  notifyAiMetricsRetentionChange,
  type AiMetricsRetentionChangeNotification,
  type AiMetricsRetentionChangeNotifierDeps,
} from "../src/utils/aiMetricsRetentionNotifier";
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
  emailResult?: boolean | Error;
} = {}): {
  deps: AiMetricsRetentionChangeNotifierDeps;
  slackCalls: SlackCall[];
  emailCalls: EmailCall[];
} {
  const slackCalls: SlackCall[] = [];
  const emailCalls: EmailCall[] = [];
  return {
    slackCalls,
    emailCalls,
    deps: {
      sendSlack: async (channel, text, blocks) => {
        slackCalls.push({ channel, text, blocks });
        if (opts.slackResult instanceof Error) throw opts.slackResult;
        return opts.slackResult ?? true;
      },
      sendEmail: async ({ to, subject, html, text }) => {
        emailCalls.push({
          to: Array.isArray(to) ? to : [to],
          subject,
          html,
          text,
        });
        if (opts.emailResult instanceof Error) throw opts.emailResult;
        return { success: opts.emailResult ?? true };
      },
    },
  };
}

function sample(
  overrides: Partial<AiMetricsRetentionChangeNotification> = {},
): AiMetricsRetentionChangeNotification {
  return {
    changedBy: "Alice Admin",
    before: 90,
    after: 7,
    effectiveAfter: 7,
    note: "tightening for next week's perf experiment",
    audit_id: 42,
    ...overrides,
  };
}

const ENV_KEYS = [
  "AI_METRICS_RETENTION_NOTIFY",
  "AI_METRICS_RETENTION_SLACK_CHANNEL",
  "AI_METRICS_RETENTION_ALERT_EMAIL",
  "TOOL_HEALTH_APP_URL",
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

const suite = new TestSuite("aiMetricsRetentionNotifier");

console.log("\n=== aiMetricsRetentionNotifier tests ===\n");

await suite.test(
  "AI_METRICS_RETENTION_NOTIFY unset → disabled, no slack/email call",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_SLACK_CHANNEL = "C-OPS";
    process.env.AI_METRICS_RETENTION_ALERT_EMAIL = "oncall@example.com";
    const { deps, slackCalls, emailCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionChange(sample(), deps);
    suite.expectEqual(result.disabled, true, "disabled");
    suite.expectEqual(result.slackSent, false, "no slack");
    suite.expectEqual(result.emailSent, false, "no email");
    suite.expectEqual(slackCalls.length, 0, "no slack call");
    suite.expectEqual(emailCalls.length, 0, "no email call");
  },
);

await suite.test(
  "AI_METRICS_RETENTION_NOTIFY=0 → disabled, no slack call",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "0";
    process.env.AI_METRICS_RETENTION_SLACK_CHANNEL = "C-OPS";
    const { deps, slackCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionChange(sample(), deps);
    suite.expectEqual(result.disabled, true, "disabled");
    suite.expectEqual(slackCalls.length, 0, "no slack call");
  },
);

await suite.test(
  "opted in but no Slack/email configured → skipped",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    const { deps, slackCalls, emailCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionChange(sample(), deps);
    suite.expectEqual(result.skipped, true, "skipped");
    suite.expectEqual(result.disabled, false, "not disabled");
    suite.expectEqual(slackCalls.length, 0, "no slack call");
    suite.expectEqual(emailCalls.length, 0, "no email call");
  },
);

await suite.test(
  "PUT change: opted in with Slack channel → enqueues Slack post with operator + diff + note",
  // Acceptance for Task #549: "the notification is enqueued for a PUT".
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_SLACK_CHANNEL = "C-AI-OPS";
    process.env.TOOL_HEALTH_APP_URL = "https://qms.example.com";
    const { deps, slackCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionChange(sample(), deps);
    suite.expectEqual(result.slackSent, true, "slackSent");
    suite.expectEqual(result.disabled, false, "not disabled");
    suite.expectEqual(result.skipped, false, "not skipped");
    suite.expectEqual(result.noChanges, false, "not noChanges");
    suite.expectEqual(slackCalls.length, 1, "one slack call");
    suite.expectEqual(slackCalls[0]?.channel, "C-AI-OPS", "channel");
    const fallback = slackCalls[0]?.text ?? "";
    suite.expect(
      fallback.includes("Alice Admin"),
      `fallback text mentions operator (got: ${fallback})`,
    );
    suite.expect(
      fallback.includes("90") && fallback.includes("7"),
      `fallback text shows before → after (got: ${fallback})`,
    );
    const blocks = JSON.stringify(slackCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("Alice Admin"),
      "blocks include operator name",
    );
    suite.expect(
      blocks.includes("90") && blocks.includes("7"),
      "blocks include before and after values",
    );
    suite.expect(
      blocks.includes("#42"),
      "blocks include audit row id",
    );
    suite.expect(
      blocks.includes("tightening for next week"),
      "blocks include operator note",
    );
    suite.expect(
      blocks.includes(
        "https://qms.example.com/dashboard/ai-ops.html?tab=retention",
      ),
      `blocks include deep-link to retention tab (got: ${blocks.slice(0, 200)}...)`,
    );
  },
);

await suite.test(
  "PUT change: email recipient configured → sends email with descriptive subject",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ALERT_EMAIL =
      "ai-ops@example.com, secondary@example.com";
    const { deps, emailCalls, slackCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionChange(sample(), deps);
    suite.expectEqual(result.emailSent, true, "emailSent");
    suite.expectEqual(result.slackSent, false, "no slack when not configured");
    suite.expectEqual(emailCalls.length, 1, "one email call");
    suite.expectEqual(slackCalls.length, 0, "no slack call");
    const call = emailCalls[0]!;
    const recipients = Array.isArray(call.to) ? call.to : [call.to];
    suite.expectEqual(recipients.length, 2, "two recipients parsed");
    suite.expectEqual(recipients[0], "ai-ops@example.com", "first recipient");
    suite.expectEqual(recipients[1], "secondary@example.com", "second recipient");
    suite.expect(
      call.subject.startsWith("[AI Metrics Retention · Updated]"),
      `subject prefixed (got: ${call.subject})`,
    );
    suite.expect(
      call.subject.includes("Alice Admin"),
      `subject mentions operator (got: ${call.subject})`,
    );
    suite.expect(
      (call.html ?? "").includes("Alice Admin"),
      "email HTML mentions operator",
    );
    suite.expect(
      (call.text ?? "").includes("90"),
      "email text includes before value",
    );
    suite.expect(
      (call.text ?? "").includes("7"),
      "email text includes after value",
    );
  },
);

await suite.test(
  "PUT no-op: before === after → noChanges, no slack/email call",
  // Acceptance for Task #549: "skipped when the value is unchanged".
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_SLACK_CHANNEL = "C-AI-OPS";
    process.env.AI_METRICS_RETENTION_ALERT_EMAIL = "ai-ops@example.com";
    const { deps, slackCalls, emailCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionChange(
      sample({ before: 30, after: 30, effectiveAfter: 30 }),
      deps,
    );
    suite.expectEqual(result.noChanges, true, "noChanges");
    suite.expectEqual(result.slackSent, false, "no slack send");
    suite.expectEqual(result.emailSent, false, "no email send");
    suite.expectEqual(slackCalls.length, 0, "no slack call");
    suite.expectEqual(emailCalls.length, 0, "no email call");
  },
);

await suite.test(
  "PUT no-op: both null (re-clearing an already-cleared override) → noChanges",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_SLACK_CHANNEL = "C-AI-OPS";
    const { deps, slackCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionChange(
      sample({ before: null, after: null, effectiveAfter: 30 }),
      deps,
    );
    suite.expectEqual(result.noChanges, true, "noChanges");
    suite.expectEqual(slackCalls.length, 0, "no slack call");
  },
);

await suite.test(
  "Cleared override (after=null) → Slack body surfaces effective env baseline",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_SLACK_CHANNEL = "C-AI-OPS";
    const { deps, slackCalls } = makeStubs();
    await notifyAiMetricsRetentionChange(
      sample({ before: 7, after: null, effectiveAfter: 30, note: null }),
      deps,
    );
    suite.expectEqual(slackCalls.length, 1, "slack sent");
    const blocks = JSON.stringify(slackCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("default (env baseline)"),
      `cleared override rendered with baseline label (got: ${blocks.slice(0, 200)}...)`,
    );
    suite.expect(
      blocks.includes("Effective after change"),
      "Slack body surfaces post-change effective value",
    );
    suite.expect(
      blocks.includes("30"),
      "Slack body includes the effective env-baseline value",
    );
    suite.expect(
      !blocks.includes("*Note:*"),
      "no Note section when note is null",
    );
  },
);

await suite.test(
  "No TOOL_HEALTH_APP_URL → Slack body surfaces relative path, no actions button",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_SLACK_CHANNEL = "C-AI-OPS";
    const { deps, slackCalls } = makeStubs();
    await notifyAiMetricsRetentionChange(sample(), deps);
    const blocks = slackCalls[0]?.blocks ?? [];
    const hasButton = blocks.some(
      (b: any) =>
        b?.type === "actions" &&
        Array.isArray(b.elements) &&
        b.elements.some((e: any) => e?.type === "button"),
    );
    suite.expectEqual(
      hasButton,
      false,
      "no actions button when URL is relative",
    );
    const json = JSON.stringify(blocks);
    suite.expect(
      json.includes("/dashboard/ai-ops.html?tab=retention"),
      "still surfaces relative deep-link",
    );
    suite.expect(
      json.includes("TOOL_HEALTH_APP_URL"),
      "tells operator how to enable a clickable link",
    );
  },
);

await suite.test(
  "Slack send throws → swallowed, slackSent=false (does not crash route handler)",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_SLACK_CHANNEL = "C-AI-OPS";
    const { deps } = makeStubs({ slackResult: new Error("slack down") });
    const origErr = console.error;
    console.error = () => {};
    try {
      const result = await notifyAiMetricsRetentionChange(sample(), deps);
      suite.expectEqual(result.slackSent, false, "slack failed");
      suite.expectEqual(result.disabled, false, "not disabled");
    } finally {
      console.error = origErr;
    }
  },
);

await suite.test(
  "Email send throws → swallowed, emailSent=false (does not crash route handler)",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ALERT_EMAIL = "oncall@example.com";
    const { deps } = makeStubs({ emailResult: new Error("resend down") });
    const origErr = console.error;
    console.error = () => {};
    try {
      const result = await notifyAiMetricsRetentionChange(sample(), deps);
      suite.expectEqual(result.emailSent, false, "email failed");
      suite.expectEqual(result.disabled, false, "not disabled");
    } finally {
      console.error = origErr;
    }
  },
);

await suite.test(
  "Both Slack and email configured → both senders are invoked once each",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_SLACK_CHANNEL = "C-AI-OPS";
    process.env.AI_METRICS_RETENTION_ALERT_EMAIL = "ai-ops@example.com";
    const { deps, slackCalls, emailCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionChange(sample(), deps);
    suite.expectEqual(result.slackSent, true, "slackSent");
    suite.expectEqual(result.emailSent, true, "emailSent");
    suite.expectEqual(slackCalls.length, 1, "one slack call");
    suite.expectEqual(emailCalls.length, 1, "one email call");
  },
);

clearEnv();

suite.finishOrExit();
