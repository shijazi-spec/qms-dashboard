/**
 * Unit tests for the AI-metrics-retention change notifier (Task #549).
 *
 * Coverage matrix:
 *   • Disabled when `AI_METRICS_RETENTION_NOTIFY` is not "1" (default for
 *     dev/test environments).
 *   • Skipped when neither ChatProvider nor email is configured (route handler can
 *     call the notifier unconditionally without paging on-call from a fresh
 *     checkout).
 *   • Enqueues a ChatProvider post with the operator name, before/after value,
 *     audit row id and operator note when wired up correctly — proves the
 *     happy-path "PUT enqueues a notification" branch.
 *   • Sends an email via EmailProvider with a descriptive subject when an email
 *     recipient is set.
 *   • Returns `noChanges: true` (and does NOT call ChatProvider/email) when
 *     before === after — covers the "skipped when the value is unchanged"
 *     contract from the task description.
 *   • A cleared override (`after: null`) renders the new effective value
 *     in the ChatProvider body so on-call knows what the next prune will use.
 *   • ChatProvider/email transport errors are swallowed and never propagate back
 *     to the route handler.
 *
 * Run:  npx tsx tests/aiMetricsRetentionNotifier.test.ts
 * Wired: discovered automatically by tests/runIntegrationTests.ts (npm test).
 */

import {
  notifyAiMetricsRetentionChange,
  notifyAiMetricsRetentionPruneNow,
  type AiMetricsRetentionChangeNotification,
  type AiMetricsRetentionChangeNotifierDeps,
  type AiMetricsRetentionPruneNowNotification,
} from "../src/utils/aiMetricsRetentionNotifier";
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

function makeStubs(opts: {
  ChatProviderResult?: boolean | Error;
  emailResult?: boolean | Error;
} = {}): {
  deps: AiMetricsRetentionChangeNotifierDeps;
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
  "AI_METRICS_RETENTION_PRUNE_NOTIFY",
  "AI_METRICS_RETENTION_ChatProvider_CHANNEL",
  "AI_METRICS_RETENTION_ALERT_EMAIL",
  "TOOL_HEALTH_APP_URL",
];

function pruneSample(
  overrides: Partial<AiMetricsRetentionPruneNowNotification> = {},
): AiMetricsRetentionPruneNowNotification {
  return {
    changedBy: "Bob Operator",
    retentionDays: 30,
    previewedRows: 12,
    deletedRows: 12,
    note: "manual prune after retention tightening",
    audit_id: 99,
    ...overrides,
  };
}

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

const suite = new TestSuite("aiMetricsRetentionNotifier");

console.log("\n=== aiMetricsRetentionNotifier tests ===\n");

await suite.test(
  "AI_METRICS_RETENTION_NOTIFY unset → disabled, no ChatProvider/email call",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-OPS";
    process.env.AI_METRICS_RETENTION_ALERT_EMAIL = "user@example.invalid";
    const { deps, ChatProviderCalls, emailCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionChange(sample(), deps);
    suite.expectEqual(result.disabled, true, "disabled");
    suite.expectEqual(result.ChatProviderSent, false, "no ChatProvider");
    suite.expectEqual(result.emailSent, false, "no email");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
    suite.expectEqual(emailCalls.length, 0, "no email call");
  },
);

await suite.test(
  "AI_METRICS_RETENTION_NOTIFY=0 → disabled, no ChatProvider call",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "0";
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-OPS";
    const { deps, ChatProviderCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionChange(sample(), deps);
    suite.expectEqual(result.disabled, true, "disabled");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
  },
);

await suite.test(
  "opted in but no ChatProvider/email configured → skipped",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    const { deps, ChatProviderCalls, emailCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionChange(sample(), deps);
    suite.expectEqual(result.skipped, true, "skipped");
    suite.expectEqual(result.disabled, false, "not disabled");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
    suite.expectEqual(emailCalls.length, 0, "no email call");
  },
);

await suite.test(
  "PUT change: opted in with ChatProvider channel → enqueues ChatProvider post with operator + diff + note",
  // Acceptance for Task #549: "the notification is enqueued for a PUT".
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-AI-OPS";
    process.env.TOOL_HEALTH_APP_URL = "<REDACTED_URL>";
    const { deps, ChatProviderCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionChange(sample(), deps);
    suite.expectEqual(result.ChatProviderSent, true, "ChatProviderSent");
    suite.expectEqual(result.disabled, false, "not disabled");
    suite.expectEqual(result.skipped, false, "not skipped");
    suite.expectEqual(result.noChanges, false, "not noChanges");
    suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider call");
    suite.expectEqual(ChatProviderCalls[0]?.channel, "C-AI-OPS", "channel");
    const fallback = ChatProviderCalls[0]?.text ?? "";
    suite.expect(
      fallback.includes("Alice Admin"),
      `fallback text mentions operator (got: ${fallback})`,
    );
    suite.expect(
      fallback.includes("90") && fallback.includes("7"),
      `fallback text shows before → after (got: ${fallback})`,
    );
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
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
        "<REDACTED_URL>",
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
      "user@example.invalid, user@example.invalid";
    const { deps, emailCalls, ChatProviderCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionChange(sample(), deps);
    suite.expectEqual(result.emailSent, true, "emailSent");
    suite.expectEqual(result.ChatProviderSent, false, "no ChatProvider when not configured");
    suite.expectEqual(emailCalls.length, 1, "one email call");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
    const call = emailCalls[0]!;
    const recipients = Array.isArray(call.to) ? call.to : [call.to];
    suite.expectEqual(recipients.length, 2, "two recipients parsed");
    suite.expectEqual(recipients[0], "user@example.invalid", "first recipient");
    suite.expectEqual(recipients[1], "user@example.invalid", "second recipient");
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
  "PUT no-op: before === after → noChanges, no ChatProvider/email call",
  // Acceptance for Task #549: "skipped when the value is unchanged".
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-AI-OPS";
    process.env.AI_METRICS_RETENTION_ALERT_EMAIL = "user@example.invalid";
    const { deps, ChatProviderCalls, emailCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionChange(
      sample({ before: 30, after: 30, effectiveAfter: 30 }),
      deps,
    );
    suite.expectEqual(result.noChanges, true, "noChanges");
    suite.expectEqual(result.ChatProviderSent, false, "no ChatProvider send");
    suite.expectEqual(result.emailSent, false, "no email send");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
    suite.expectEqual(emailCalls.length, 0, "no email call");
  },
);

await suite.test(
  "PUT no-op: both null (re-clearing an already-cleared override) → noChanges",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-AI-OPS";
    const { deps, ChatProviderCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionChange(
      sample({ before: null, after: null, effectiveAfter: 30 }),
      deps,
    );
    suite.expectEqual(result.noChanges, true, "noChanges");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
  },
);

await suite.test(
  "Cleared override (after=null) → ChatProvider body surfaces effective env baseline",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-AI-OPS";
    const { deps, ChatProviderCalls } = makeStubs();
    await notifyAiMetricsRetentionChange(
      sample({ before: 7, after: null, effectiveAfter: 30, note: null }),
      deps,
    );
    suite.expectEqual(ChatProviderCalls.length, 1, "ChatProvider sent");
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("default (env baseline)"),
      `cleared override rendered with baseline label (got: ${blocks.slice(0, 200)}...)`,
    );
    suite.expect(
      blocks.includes("Effective after change"),
      "ChatProvider body surfaces post-change effective value",
    );
    suite.expect(
      blocks.includes("30"),
      "ChatProvider body includes the effective env-baseline value",
    );
    suite.expect(
      !blocks.includes("*Note:*"),
      "no Note section when note is null",
    );
  },
);

await suite.test(
  "No TOOL_HEALTH_APP_URL → ChatProvider body surfaces relative path, no actions button",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-AI-OPS";
    const { deps, ChatProviderCalls } = makeStubs();
    await notifyAiMetricsRetentionChange(sample(), deps);
    const blocks = ChatProviderCalls[0]?.blocks ?? [];
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
  "ChatProvider send throws → swallowed, ChatProviderSent=false (does not crash route handler)",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-AI-OPS";
    const { deps } = makeStubs({ ChatProviderResult: new Error("ChatProvider down") });
    const origErr = console.error;
    console.error = () => {};
    try {
      const result = await notifyAiMetricsRetentionChange(sample(), deps);
      suite.expectEqual(result.ChatProviderSent, false, "ChatProvider failed");
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
    process.env.AI_METRICS_RETENTION_ALERT_EMAIL = "user@example.invalid";
    const { deps } = makeStubs({ emailResult: new Error("EmailProvider down") });
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
  "Both ChatProvider and email configured → both senders are invoked once each",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-AI-OPS";
    process.env.AI_METRICS_RETENTION_ALERT_EMAIL = "user@example.invalid";
    const { deps, ChatProviderCalls, emailCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionChange(sample(), deps);
    suite.expectEqual(result.ChatProviderSent, true, "ChatProviderSent");
    suite.expectEqual(result.emailSent, true, "emailSent");
    suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider call");
    suite.expectEqual(emailCalls.length, 1, "one email call");
  },
);

/* -------------------------------------------------------------------------- *
 *  notifyAiMetricsRetentionPruneNow tests (Task #644)
 * -------------------------------------------------------------------------- */

console.log("\n=== notifyAiMetricsRetentionPruneNow tests ===\n");

await suite.test(
  "prune-now: AI_METRICS_RETENTION_PRUNE_NOTIFY unset → disabled, no ChatProvider/email",
  // Acceptance for Task #644: existing deployments are unchanged when the
  // new env knob is not opted in.
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-OPS";
    process.env.AI_METRICS_RETENTION_ALERT_EMAIL = "user@example.invalid";
    // The PUT-config knob being on must NOT enable prune-now notifications —
    // an ops team may want to be paged on config changes but not on prunes.
    process.env.AI_METRICS_RETENTION_NOTIFY = "1";
    const { deps, ChatProviderCalls, emailCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionPruneNow(pruneSample(), deps);
    suite.expectEqual(result.disabled, true, "disabled");
    suite.expectEqual(result.ChatProviderSent, false, "no ChatProvider");
    suite.expectEqual(result.emailSent, false, "no email");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
    suite.expectEqual(emailCalls.length, 0, "no email call");
  },
);

await suite.test(
  "prune-now: AI_METRICS_RETENTION_PRUNE_NOTIFY=0 → disabled",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_PRUNE_NOTIFY = "0";
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-OPS";
    const { deps, ChatProviderCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionPruneNow(pruneSample(), deps);
    suite.expectEqual(result.disabled, true, "disabled");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
  },
);

await suite.test(
  "prune-now: opted in but no ChatProvider/email configured → skipped",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_PRUNE_NOTIFY = "1";
    const { deps, ChatProviderCalls, emailCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionPruneNow(pruneSample(), deps);
    suite.expectEqual(result.skipped, true, "skipped");
    suite.expectEqual(result.disabled, false, "not disabled");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
    suite.expectEqual(emailCalls.length, 0, "no email call");
  },
);

await suite.test(
  "prune-now: opted in with ChatProvider channel → posts operator + window + previewed + deleted + audit + note",
  // Acceptance for Task #644: "a successful prune-now call posts a single
  // ChatProvider message containing operator, retention window, previewed rows,
  // deleted rows, and any preview-vs-actual drift."
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_PRUNE_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-AI-OPS";
    process.env.TOOL_HEALTH_APP_URL = "<REDACTED_URL>";
    const { deps, ChatProviderCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionPruneNow(pruneSample(), deps);
    suite.expectEqual(result.ChatProviderSent, true, "ChatProviderSent");
    suite.expectEqual(result.disabled, false, "not disabled");
    suite.expectEqual(result.skipped, false, "not skipped");
    suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider call");
    suite.expectEqual(ChatProviderCalls[0]?.channel, "C-AI-OPS", "channel");
    const fallback = ChatProviderCalls[0]?.text ?? "";
    suite.expect(
      fallback.includes("Bob Operator"),
      `fallback text mentions operator (got: ${fallback})`,
    );
    suite.expect(
      fallback.includes("12"),
      `fallback text mentions deleted-rows count (got: ${fallback})`,
    );
    suite.expect(
      fallback.includes("30"),
      `fallback text mentions retention window (got: ${fallback})`,
    );
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(blocks.includes("Bob Operator"), "blocks include operator");
    suite.expect(blocks.includes("#99"), "blocks include audit row id");
    suite.expect(blocks.includes("30"), "blocks include retention window");
    suite.expect(
      blocks.includes("Previewed rows"),
      "blocks include previewed-rows label",
    );
    suite.expect(
      blocks.includes("Deleted rows"),
      "blocks include deleted-rows label",
    );
    suite.expect(blocks.includes("Drift"), "blocks include drift label");
    suite.expect(
      blocks.includes("manual prune after retention tightening"),
      "blocks include operator note",
    );
    suite.expect(
      blocks.includes(
        "<REDACTED_URL>",
      ),
      `blocks include deep-link to retention tab (got: ${blocks.slice(0, 200)}...)`,
    );
  },
);

await suite.test(
  "prune-now: drift surfaced when previewed differs from deleted",
  // Acceptance for Task #644: "preview-vs-actual drift" must be visible.
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_PRUNE_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-AI-OPS";
    const { deps, ChatProviderCalls } = makeStubs();
    await notifyAiMetricsRetentionPruneNow(
      pruneSample({ previewedRows: 10, deletedRows: 13 }),
      deps,
    );
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(blocks.includes("10"), "blocks include previewed value");
    suite.expect(blocks.includes("13"), "blocks include deleted value");
    suite.expect(
      blocks.includes("+3"),
      `blocks include positive drift (got: ${blocks.slice(0, 300)}...)`,
    );
    const fallback = ChatProviderCalls[0]?.text ?? "";
    suite.expect(
      fallback.includes("+3") || fallback.includes("drift"),
      `fallback summary mentions drift (got: ${fallback})`,
    );
  },
);

await suite.test(
  "prune-now: previewed === deleted → drift labelled as preview matched",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_PRUNE_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-AI-OPS";
    const { deps, ChatProviderCalls } = makeStubs();
    await notifyAiMetricsRetentionPruneNow(
      pruneSample({ previewedRows: 5, deletedRows: 5 }),
      deps,
    );
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("preview matched"),
      `drift block calls out the match (got: ${blocks.slice(0, 300)}...)`,
    );
  },
);

await suite.test(
  "prune-now: preview unavailable (null) → drift block reports it without crashing",
  // The route handler reports `previewed_rows: null` when the dry-run
  // preview itself failed; the notifier must still post and not crash.
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_PRUNE_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-AI-OPS";
    process.env.AI_METRICS_RETENTION_ALERT_EMAIL = "user@example.invalid";
    const { deps, ChatProviderCalls, emailCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionPruneNow(
      pruneSample({ previewedRows: null, deletedRows: 7 }),
      deps,
    );
    suite.expectEqual(result.ChatProviderSent, true, "ChatProviderSent");
    suite.expectEqual(result.emailSent, true, "emailSent");
    const blocks = JSON.stringify(ChatProviderCalls[0]?.blocks ?? []);
    suite.expect(
      blocks.includes("preview unavailable"),
      `drift labelled as unavailable (got: ${blocks.slice(0, 300)}...)`,
    );
    const emailText = emailCalls[0]?.text ?? "";
    suite.expect(
      emailText.includes("unavailable"),
      `email text mentions unavailable preview (got: ${emailText})`,
    );
  },
);

await suite.test(
  "prune-now: deletedRows=0 still posts (operationally noteworthy)",
  // Unlike the PUT notifier this fires even on a zero-row prune — the
  // operator deliberately confirmed the action, which is audit-worthy.
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_PRUNE_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-AI-OPS";
    const { deps, ChatProviderCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionPruneNow(
      pruneSample({ previewedRows: 0, deletedRows: 0 }),
      deps,
    );
    suite.expectEqual(result.ChatProviderSent, true, "ChatProvider still sent");
    suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider call");
  },
);

await suite.test(
  "prune-now: email recipient configured → sends email with descriptive subject",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_PRUNE_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ALERT_EMAIL =
      "user@example.invalid, user@example.invalid";
    const { deps, emailCalls, ChatProviderCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionPruneNow(pruneSample(), deps);
    suite.expectEqual(result.emailSent, true, "emailSent");
    suite.expectEqual(result.ChatProviderSent, false, "no ChatProvider when not configured");
    suite.expectEqual(emailCalls.length, 1, "one email call");
    suite.expectEqual(ChatProviderCalls.length, 0, "no ChatProvider call");
    const call = emailCalls[0]!;
    const recipients = Array.isArray(call.to) ? call.to : [call.to];
    suite.expectEqual(recipients.length, 2, "two recipients parsed");
    suite.expect(
      call.subject.startsWith("[AI Metrics Retention · Pruned]"),
      `subject prefixed (got: ${call.subject})`,
    );
    suite.expect(
      call.subject.includes("Bob Operator"),
      `subject mentions operator (got: ${call.subject})`,
    );
    suite.expect(
      call.subject.includes("12"),
      `subject mentions deleted-rows count (got: ${call.subject})`,
    );
    suite.expect(
      (call.html ?? "").includes("Bob Operator"),
      "email HTML mentions operator",
    );
    suite.expect(
      (call.text ?? "").includes("Previewed rows"),
      "email text includes previewed-rows section",
    );
    suite.expect(
      (call.text ?? "").includes("Deleted rows"),
      "email text includes deleted-rows section",
    );
  },
);

await suite.test(
  "prune-now: no TOOL_HEALTH_APP_URL → relative deep-link, no actions button",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_PRUNE_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-AI-OPS";
    const { deps, ChatProviderCalls } = makeStubs();
    await notifyAiMetricsRetentionPruneNow(pruneSample(), deps);
    const blocks = ChatProviderCalls[0]?.blocks ?? [];
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
  "prune-now: ChatProvider send throws → swallowed, never propagates back",
  // Acceptance for Task #644: "Notification failure does NOT fail the prune."
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_PRUNE_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-AI-OPS";
    const { deps } = makeStubs({ ChatProviderResult: new Error("ChatProvider down") });
    const origErr = console.error;
    console.error = () => {};
    try {
      const result = await notifyAiMetricsRetentionPruneNow(pruneSample(), deps);
      suite.expectEqual(result.ChatProviderSent, false, "ChatProvider failed");
      suite.expectEqual(result.disabled, false, "not disabled");
    } finally {
      console.error = origErr;
    }
  },
);

await suite.test(
  "prune-now: email send throws → swallowed, never propagates back",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_PRUNE_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ALERT_EMAIL = "user@example.invalid";
    const { deps } = makeStubs({ emailResult: new Error("EmailProvider down") });
    const origErr = console.error;
    console.error = () => {};
    try {
      const result = await notifyAiMetricsRetentionPruneNow(pruneSample(), deps);
      suite.expectEqual(result.emailSent, false, "email failed");
      suite.expectEqual(result.disabled, false, "not disabled");
    } finally {
      console.error = origErr;
    }
  },
);

await suite.test(
  "prune-now: both ChatProvider and email configured → both senders invoked once each",
  async () => {
    clearEnv();
    process.env.AI_METRICS_RETENTION_PRUNE_NOTIFY = "1";
    process.env.AI_METRICS_RETENTION_ChatProvider_CHANNEL = "C-AI-OPS";
    process.env.AI_METRICS_RETENTION_ALERT_EMAIL = "user@example.invalid";
    const { deps, ChatProviderCalls, emailCalls } = makeStubs();
    const result = await notifyAiMetricsRetentionPruneNow(pruneSample(), deps);
    suite.expectEqual(result.ChatProviderSent, true, "ChatProviderSent");
    suite.expectEqual(result.emailSent, true, "emailSent");
    suite.expectEqual(ChatProviderCalls.length, 1, "one ChatProvider call");
    suite.expectEqual(emailCalls.length, 1, "one email call");
  },
);

clearEnv();

suite.finishOrExit();
