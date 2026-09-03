/**
 * Unit tests for the security-reviewer notification pipeline (Task #485).
 *
 * Run:    npx tsx src/utils/securityApprovalNotifier.test.ts
 * Wired:  tests/runIntegrationTests.ts auto-discovers src/**\/*.test.ts and
 *         is invoked from `npm test` (which scripts/post-merge.sh runs).
 *
 * Goal: protect the credential-warning notification surface from silent
 * regressions. The notifier mixes throttle accounting, Slack Block Kit
 * rendering, Resend email building, and env-config parsing — a regression
 * in any of those paths would only surface as a missed page in
 * production. We exercise each path with stubbed deps so no real Slack /
 * Resend / DB call is made.
 *
 * Coverage (matches Task #485 "Done looks like"):
 *   notifyCredentialFlaggedApproval
 *     • skipped when no Slack channel and no email recipients are configured
 *     • skipped when warnings list is empty (defensive guard)
 *     • slackSent=true when Slack send resolves true
 *     • emailSent=true when Resend send resolves { success: true }
 *     • throttled when same action_code is paged within the window
 *     • throttle resets after the window expires (injected clock)
 *     • Slack body carries action_code, requester, deep link, paths
 *     • Email body carries action_code, requester, deep link, paths
 *     • Deep link uses absolute APP_URL when set, relative path otherwise
 *     • Slack action button only appears when APP_URL is absolute
 */

import {
  notifyCredentialFlaggedApproval,
  _resetSecurityApprovalNotifierThrottleForTests,
  type CredentialFlaggedApprovalNotification,
} from "./securityApprovalNotifier";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(
      `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`,
    );
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Env-var hygiene: readConfig() reads process.env on every call, so each
// section sets exactly what it needs and clears the rest. Captured baseline
// is restored at the end so this file can run alongside other tests in the
// same `npm test` run without leaking config.
// ---------------------------------------------------------------------------
const ENV_KEYS = [
  "SECURITY_REVIEWER_SLACK_CHANNEL",
  "SECURITY_REVIEWER_EMAIL",
  "SECURITY_REVIEWER_APP_URL",
  "SECURITY_REVIEWER_NOTIFY_THROTTLE_MIN",
] as const;

const baselineEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) baselineEnv[k] = process.env[k];

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (baselineEnv[k] === undefined) delete process.env[k];
    else process.env[k] = baselineEnv[k];
  }
}

function makeNotification(
  overrides: Partial<CredentialFlaggedApprovalNotification> = {},
): CredentialFlaggedApprovalNotification {
  return {
    action_code: "APR-20260425-AB12CD",
    tool_id: "create_nonconformance",
    tool_label: "Create nonconformance record",
    risk_level: "high",
    requested_by_user_id: 42,
    requested_by_email: "user@example.invalid",
    requested_by_name: "Alice Auditor",
    credential_warnings: [
      { path: "evidenceUrl", kind: "regex", patternName: "openai-sk" },
      { path: "description", kind: "regex", patternName: "github-pat" },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Section 1 — skipped when nothing configured
// ---------------------------------------------------------------------------

async function testSkippedWhenNothingConfigured(): Promise<void> {
  console.log(
    "\nnotifyCredentialFlaggedApproval — skipped when neither Slack nor email is configured",
  );
  clearEnv();
  _resetSecurityApprovalNotifierThrottleForTests();

  let slackCalls = 0;
  let emailCalls = 0;
  const result = await notifyCredentialFlaggedApproval(
    makeNotification({ action_code: "APR-skip:1" }),
    {
      sendSlack: async () => {
        slackCalls++;
        return true;
      },
      sendEmail: async () => {
        emailCalls++;
        return { success: true };
      },
    },
  );

  assertEqual(result.skipped, true, "result.skipped is true");
  assertEqual(result.slackSent, false, "no Slack send recorded");
  assertEqual(result.emailSent, false, "no email send recorded");
  assertEqual(result.throttled, false, "throttled is false (skip is the reason)");
  assertEqual(slackCalls, 0, "sendSlack was not invoked");
  assertEqual(emailCalls, 0, "sendEmail was not invoked");
}

// ---------------------------------------------------------------------------
// Section 2 — defensive guard: empty warnings list short-circuits
// ---------------------------------------------------------------------------

async function testSkippedWhenNoWarnings(): Promise<void> {
  console.log(
    "\nnotifyCredentialFlaggedApproval — skipped when credential_warnings is empty",
  );
  clearEnv();
  _resetSecurityApprovalNotifierThrottleForTests();
  process.env.SECURITY_REVIEWER_SLACK_CHANNEL = "C-SECURITY";

  let slackCalls = 0;
  const result = await notifyCredentialFlaggedApproval(
    makeNotification({ action_code: "APR-empty:1", credential_warnings: [] }),
    {
      sendSlack: async () => {
        slackCalls++;
        return true;
      },
      sendEmail: async () => ({ success: true }),
    },
  );

  assertEqual(result.skipped, true, "empty warnings → skipped=true");
  assertEqual(slackCalls, 0, "sendSlack was not invoked");
  assertEqual(result.slackSent, false, "no Slack send recorded");
}

// ---------------------------------------------------------------------------
// Section 3 — Slack happy path
// ---------------------------------------------------------------------------

async function testSlackSentOnSuccess(): Promise<void> {
  console.log(
    "\nnotifyCredentialFlaggedApproval — slackSent=true on Slack success, body carries deep link",
  );
  clearEnv();
  _resetSecurityApprovalNotifierThrottleForTests();
  process.env.SECURITY_REVIEWER_SLACK_CHANNEL = "C-SECURITY";
  process.env.SECURITY_REVIEWER_APP_URL = "<REDACTED_URL>";

  type SlackArgs = { channel: string; text: string; blocks: any[] };
  const slackCalls: SlackArgs[] = [];

  const notification = makeNotification({
    action_code: "APR-slack-ok:1",
  });

  const result = await notifyCredentialFlaggedApproval(notification, {
    sendSlack: async (channel, text, blocks) => {
      slackCalls.push({ channel, text, blocks: blocks as any[] });
      return true;
    },
    sendEmail: async () => ({ success: false, error: "should not be called" }),
    now: () => 1_700_000_000_000,
  });

  assertEqual(result.slackSent, true, "result.slackSent is true");
  assertEqual(result.emailSent, false, "result.emailSent stays false (no email config)");
  assertEqual(result.throttled, false, "not throttled on first send");
  assertEqual(result.skipped, false, "not skipped");
  assertEqual(slackCalls.length, 1, "sendSlack called exactly once");
  assertEqual(slackCalls[0].channel, "C-SECURITY", "Slack posted to configured channel");

  const fallback = slackCalls[0].text;
  assert(
    fallback.includes("APR-slack-ok:1"),
    "fallback text contains the action_code",
  );
  assert(
    fallback.includes("create_nonconformance"),
    "fallback text mentions the tool id",
  );

  const blockText = JSON.stringify(slackCalls[0].blocks);
  assert(blockText.includes("APR-slack-ok:1"), "blocks include action_code");
  assert(blockText.includes("Alice Auditor"), "blocks include requester name");
  assert(blockText.includes("user@example.invalid"), "blocks include requester email");
  assert(blockText.includes("evidenceUrl"), "blocks include flagged field path");
  assert(blockText.includes("description"), "blocks include second flagged path");

  // Absolute APP_URL → action button with absolute URL
  const buttonBlock = (slackCalls[0].blocks as any[]).find(
    (b: any) => b.type === "actions" && Array.isArray(b.elements),
  );
  assert(buttonBlock != null, "renders an actions/button block when APP_URL is absolute");
  if (buttonBlock) {
    const button = (buttonBlock.elements as any[])[0];
    assert(
      typeof button?.url === "string" && /^https:\/\/wala\.example\.com\//.test(button.url),
      "button.url is the absolute approval-card link",
    );
    assert(
      button.url.includes("code=APR-slack-ok%3A1") || button.url.includes("code=APR-slack-ok:1"),
      "button.url carries the action_code as a query parameter",
    );
  }
}

// ---------------------------------------------------------------------------
// Section 4 — Email happy path
// ---------------------------------------------------------------------------

async function testEmailSentOnSuccess(): Promise<void> {
  console.log(
    "\nnotifyCredentialFlaggedApproval — emailSent=true on Resend success",
  );
  clearEnv();
  _resetSecurityApprovalNotifierThrottleForTests();
  process.env.SECURITY_REVIEWER_EMAIL = "user@example.invalid, user@example.invalid";
  process.env.SECURITY_REVIEWER_APP_URL = "<REDACTED_URL>";

  type EmailArgs = { to: any; subject: string; html?: string; text?: string };
  const emailCalls: EmailArgs[] = [];

  const result = await notifyCredentialFlaggedApproval(
    makeNotification({ action_code: "APR-email-ok:1" }),
    {
      sendSlack: async () => true,
      sendEmail: async (opts) => {
        emailCalls.push({
          to: opts.to,
          subject: opts.subject,
          html: opts.html,
          text: opts.text,
        });
        return { success: true, id: "msg_123" };
      },
      now: () => 1_700_000_000_000,
    },
  );

  assertEqual(result.emailSent, true, "result.emailSent is true");
  assertEqual(result.slackSent, false, "Slack was not configured → slackSent stays false");
  assertEqual(emailCalls.length, 1, "sendEmail called exactly once");
  assert(
    Array.isArray(emailCalls[0].to) &&
      (emailCalls[0].to as string[]).length === 2 &&
      (emailCalls[0].to as string[])[0] === "user@example.invalid" &&
      (emailCalls[0].to as string[])[1] === "user@example.invalid",
    "comma-separated SECURITY_REVIEWER_EMAIL parsed into recipient array",
  );
  assert(
    emailCalls[0].subject.includes("APR-email-ok:1"),
    "email subject carries the action_code",
  );
  assert(
    emailCalls[0].subject.includes("HIGH"),
    "email subject carries the risk-level tag",
  );
  assert(
    !!emailCalls[0].html && emailCalls[0].html!.includes("Alice Auditor"),
    "email html contains requester name",
  );
  assert(
    !!emailCalls[0].html && emailCalls[0].html!.includes("<REDACTED_URL>"),
    "email html contains absolute deep link",
  );
  assert(
    !!emailCalls[0].text && emailCalls[0].text!.includes("evidenceUrl"),
    "email text body lists flagged field paths",
  );
}

// ---------------------------------------------------------------------------
// Section 5 — dedupe / throttle
// ---------------------------------------------------------------------------

async function testThrottledOnSecondCallSameCode(): Promise<void> {
  console.log(
    "\nnotifyCredentialFlaggedApproval — throttled when the same action_code is re-paged inside the window",
  );
  clearEnv();
  _resetSecurityApprovalNotifierThrottleForTests();
  process.env.SECURITY_REVIEWER_SLACK_CHANNEL = "C-SECURITY";
  process.env.SECURITY_REVIEWER_NOTIFY_THROTTLE_MIN = "60";

  let slackCalls = 0;
  const t0 = 1_700_000_000_000;

  const first = await notifyCredentialFlaggedApproval(
    makeNotification({ action_code: "APR-dup:1" }),
    {
      sendSlack: async () => {
        slackCalls++;
        return true;
      },
      sendEmail: async () => ({ success: false }),
      now: () => t0,
    },
  );
  assertEqual(first.slackSent, true, "first call sends Slack message");
  assertEqual(first.throttled, false, "first call is not throttled");
  assertEqual(slackCalls, 1, "Slack invoked once after first call");

  // Second call within the throttle window → no Slack, throttled flag set
  const second = await notifyCredentialFlaggedApproval(
    makeNotification({ action_code: "APR-dup:1" }),
    {
      sendSlack: async () => {
        slackCalls++;
        return true;
      },
      sendEmail: async () => ({ success: false }),
      now: () => t0 + 30 * 60_000,
    },
  );
  assertEqual(second.throttled, true, "second call inside window is throttled");
  assertEqual(second.slackSent, false, "second call did not send Slack");
  assertEqual(slackCalls, 1, "Slack still only invoked once across both calls");
}

async function testThrottleResetsAfterWindow(): Promise<void> {
  console.log(
    "\nnotifyCredentialFlaggedApproval — throttle releases after the window expires",
  );
  clearEnv();
  _resetSecurityApprovalNotifierThrottleForTests();
  process.env.SECURITY_REVIEWER_SLACK_CHANNEL = "C-SECURITY";
  process.env.SECURITY_REVIEWER_NOTIFY_THROTTLE_MIN = "10";

  let slackCalls = 0;
  const t0 = 1_700_000_000_000;
  const send = async () => {
    slackCalls++;
    return true;
  };

  const first = await notifyCredentialFlaggedApproval(
    makeNotification({ action_code: "APR-window:1" }),
    { sendSlack: send, now: () => t0 },
  );
  assertEqual(first.slackSent, true, "first call sends");

  // 11 minutes later → throttle cleared
  const third = await notifyCredentialFlaggedApproval(
    makeNotification({ action_code: "APR-window:1" }),
    { sendSlack: send, now: () => t0 + 11 * 60_000 },
  );
  assertEqual(third.throttled, false, "after window: not throttled");
  assertEqual(third.slackSent, true, "after window: sent again");
  assertEqual(slackCalls, 2, "Slack was invoked twice (before + after the window)");
}

// ---------------------------------------------------------------------------
// Section 6 — relative-path fallback when APP_URL is unset
// ---------------------------------------------------------------------------

async function testRelativeLinkWhenAppUrlUnset(): Promise<void> {
  console.log(
    "\nnotifyCredentialFlaggedApproval — falls back to a relative deep link when SECURITY_REVIEWER_APP_URL is unset",
  );
  clearEnv();
  _resetSecurityApprovalNotifierThrottleForTests();
  process.env.SECURITY_REVIEWER_SLACK_CHANNEL = "C-SECURITY";
  // No SECURITY_REVIEWER_APP_URL — should degrade to relative path and
  // skip the Slack action button (Slack rejects relative URLs in buttons).

  type SlackArgs = { channel: string; text: string; blocks: any[] };
  const slackCalls: SlackArgs[] = [];
  const result = await notifyCredentialFlaggedApproval(
    makeNotification({ action_code: "APR-rel:1" }),
    {
      sendSlack: async (channel, text, blocks) => {
        slackCalls.push({ channel, text, blocks: blocks as any[] });
        return true;
      },
      now: () => 1_700_000_000_000,
    },
  );

  assertEqual(result.slackSent, true, "Slack still sends");
  const blockText = JSON.stringify(slackCalls[0].blocks);
  assert(
    blockText.includes("/ai-approvals?code=APR-rel%3A1") ||
      blockText.includes("/ai-approvals?code=APR-rel:1"),
    "blocks include relative deep-link path",
  );
  const hasButton = (slackCalls[0].blocks as any[]).some(
    (b: any) => b.type === "actions",
  );
  assertEqual(
    hasButton,
    false,
    "no actions/button block when the link is relative",
  );
  assert(
    blockText.includes("SECURITY_REVIEWER_APP_URL"),
    "Slack body explains how to enable the clickable link",
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("--- securityApprovalNotifier.test.ts ---");
  try {
    await testSkippedWhenNothingConfigured();
    await testSkippedWhenNoWarnings();
    await testSlackSentOnSuccess();
    await testEmailSentOnSuccess();
    await testThrottledOnSecondCallSameCode();
    await testThrottleResetsAfterWindow();
    await testRelativeLinkWhenAppUrlUnset();
  } finally {
    restoreEnv();
    _resetSecurityApprovalNotifierThrottleForTests();
  }

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("securityApprovalNotifier.test.ts crashed:", err);
  process.exit(1);
});
