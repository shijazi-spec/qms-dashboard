/**
 * Unit tests for the tool-health notification pipeline (Task #285).
 *
 * Run:    npx tsx src/utils/toolHealthAlertNotifier.test.ts
 * Wired:  tests/runIntegrationTests.ts auto-discovers src/**\/*.test.ts and
 *         is invoked from `npm test` (which scripts/post-merge.sh runs).
 *
 * Goal: protect the on-call notification surface from silent regressions.
 * The notifier mixes throttle accounting, Slack Block Kit rendering, and
 * Resend email building — a regression in any of those paths would only
 * surface as a missed page in production. We exercise each path with
 * stubbed deps (`sendSlack`, `sendEmail`, `claimDb`, `now`) so no real
 * Slack / Resend / DB call is made.
 *
 * Coverage (matches Task #285 "Done looks like"):
 *   notifyToolHealthBreach
 *     • skipped when no Slack channel and no email recipients are configured
 *     • throttled when the same dedupe key is paged within the window
 *     • slackSent=true when Slack send resolves true
 *     • emailSent=true when Resend send resolves { success: true }
 *     • throttle resets after the window expires (injected clock)
 *   notifyToolHealthOverrideExpired
 *     • posts a Slack message on auto-revert with cleared-fields rendering
 *   _diffToolHealthConfigOverridesForTests
 *     • computes per-field diffs in canonical order, including
 *       transitions to/from "default (env baseline)" (null ↔ value)
 */

import {
  notifyToolHealthBreach,
  notifyToolHealthOverrideExpired,
  notifyToolHealthConfigChange,
  notifyToolHealthOverrideExpiringSoon,
  notifyToolHealthRecovery,
  _resetToolHealthNotifierThrottleForTests,
  _resetOverrideExpirySoonWarningsForTests,
  _diffToolHealthConfigOverridesForTests,
  TOOL_HEALTH_CONFIG_THREAD_KEY,
  type ToolHealthBreachNotification,
  type ToolHealthOverrideExpiredNotification,
  type ToolHealthConfigChangeNotification,
  type ToolHealthOverrideExpiringSoonNotification,
  type ToolHealthRecoveryNotification,
} from "./toolHealthAlertNotifier";
import type { ToolHealthConfigAuditEntry } from "./toolHealthConfigDatabase";

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

function assertDeepEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
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
  "TOOL_HEALTH_SLACK_CHANNEL",
  "TOOL_HEALTH_SLACK_USE_DEFAULT_CHANNEL",
  "TOOL_HEALTH_ALERT_EMAIL",
  "TOOL_HEALTH_NOTIFY_THROTTLE_MIN",
  "TOOL_HEALTH_APP_URL",
  "TOOL_HEALTH_CONFIG_NOTIFY",
  "SLACK_CHANNEL_ID",
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

// Sample breach payload reused across cases. Each test that needs a unique
// dedupe key overrides `related_record_id` to avoid cross-contaminating the
// in-process throttle map.
function makeBreach(
  overrides: Partial<ToolHealthBreachNotification> = {},
): ToolHealthBreachNotification {
  return {
    tool_name: "search_web",
    agent_name: "research-agent",
    reason: "error_rate",
    severity: "high",
    title: "Tool error rate breach: search_web",
    description: "error_rate=12.5% (threshold 10%)",
    suggestion: "Check upstream API status",
    related_record_id: "search_web:error_rate",
    alert_id: 42,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Section 1 — notifyToolHealthBreach
// ---------------------------------------------------------------------------

async function testSkippedWhenNothingConfigured(): Promise<void> {
  console.log("\nnotifyToolHealthBreach — skipped when no channel configured");
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();

  let slackCalls = 0;
  let emailCalls = 0;
  let dbCalls = 0;
  const result = await notifyToolHealthBreach(
    makeBreach({ related_record_id: "skip-case:error_rate" }),
    {
      sendSlack: async () => {
        slackCalls++;
        return true;
      },
      sendEmail: async () => {
        emailCalls++;
        return { success: true };
      },
      claimDb: async () => {
        dbCalls++;
        return true;
      },
    },
  );

  assertEqual(result.skipped, true, "result.skipped is true");
  assertEqual(result.slackSent, false, "no Slack send recorded");
  assertEqual(result.emailSent, false, "no email send recorded");
  assertEqual(result.throttled, false, "throttled is false (skip is the reason)");
  assertEqual(slackCalls, 0, "sendSlack was not invoked");
  assertEqual(emailCalls, 0, "sendEmail was not invoked");
  assertEqual(dbCalls, 0, "claimDb was not invoked (no transport configured)");
}

async function testSlackSentOnSuccess(): Promise<void> {
  console.log("\nnotifyToolHealthBreach — slackSent=true on Slack success");
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_APP_URL = "https://wala.example.com";

  type SlackArgs = { channel: string; text: string; blocks: any[] };
  const slackCalls: SlackArgs[] = [];

  const result = await notifyToolHealthBreach(
    makeBreach({ related_record_id: "slack-ok:error_rate" }),
    {
      sendSlack: async (channel, text, blocks) => {
        slackCalls.push({ channel, text, blocks: blocks as any[] });
        return true;
      },
      sendEmail: async () => ({ success: false, error: "should not be called" }),
      claimDb: async () => true,
      now: () => 1_700_000_000_000,
    },
  );

  assertEqual(result.slackSent, true, "result.slackSent is true");
  assertEqual(result.emailSent, false, "result.emailSent stays false (no email config)");
  assertEqual(result.throttled, false, "not throttled on first send");
  assertEqual(result.skipped, false, "not skipped");
  assertEqual(slackCalls.length, 1, "sendSlack called exactly once");
  assertEqual(slackCalls[0].channel, "C-ONCALL", "Slack posted to configured channel");
  assert(
    typeof slackCalls[0].text === "string" && slackCalls[0].text.includes("search_web"),
    "Slack fallback text mentions the tool name",
  );
  // Block-kit shape sanity: header + divider + section with key fields.
  const blocks = slackCalls[0].blocks;
  assert(Array.isArray(blocks) && blocks.length > 0, "blocks array is non-empty");
  assertEqual(blocks[0]?.type, "header", "first block is a header");
  assert(
    typeof blocks[0]?.text?.text === "string" &&
      blocks[0].text.text.includes("Tool health alert: search_web"),
    "header text includes the tool name",
  );
  // Absolute URL ⇒ button (not the relative-link fallback section).
  const hasButton = blocks.some(
    (b: any) =>
      b?.type === "actions" &&
      Array.isArray(b.elements) &&
      b.elements.some((e: any) => e?.url === "https://wala.example.com/dashboard"),
  );
  assert(hasButton, "absolute APP_URL renders an actions.button block with that URL");
  // Context block carries the dedupe key — this is what on-call uses to
  // correlate with the ai_alerts row.
  const contextText = blocks
    .filter((b: any) => b?.type === "context")
    .flatMap((b: any) => b.elements ?? [])
    .map((e: any) => e?.text ?? "")
    .join(" ");
  assert(contextText.includes("slack-ok:error_rate"), "context block includes dedupe key");
  assert(contextText.includes("alert #42"), "context block includes alert id");
}

async function testEmailSentOnSuccess(): Promise<void> {
  console.log("\nnotifyToolHealthBreach — emailSent=true on Resend success");
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  process.env.TOOL_HEALTH_ALERT_EMAIL = "oncall@example.com, ops@example.com";
  process.env.TOOL_HEALTH_APP_URL = "https://wala.example.com";

  type EmailArgs = { to: string | string[]; subject: string; html?: string; text?: string };
  const emailCalls: EmailArgs[] = [];

  const result = await notifyToolHealthBreach(
    makeBreach({ related_record_id: "email-ok:error_rate", severity: "critical" }),
    {
      sendSlack: async () => false,
      sendEmail: async (opts) => {
        emailCalls.push(opts as EmailArgs);
        return { success: true, id: "msg-1" };
      },
      claimDb: async () => true,
      now: () => 1_700_000_001_000,
    },
  );

  assertEqual(result.emailSent, true, "result.emailSent is true");
  assertEqual(result.slackSent, false, "Slack stays false (no channel configured)");
  assertEqual(result.skipped, false, "not skipped (email is configured)");
  assertEqual(emailCalls.length, 1, "sendEmail called exactly once");
  assertDeepEqual(
    emailCalls[0].to,
    ["oncall@example.com", "ops@example.com"],
    "comma-separated TOOL_HEALTH_ALERT_EMAIL is split into a recipient array",
  );
  assert(
    emailCalls[0].subject.startsWith("[Tool Health · CRITICAL] "),
    "subject prefixes [Tool Health · <SEVERITY>]",
  );
  assert(
    typeof emailCalls[0].html === "string" &&
      emailCalls[0].html.includes("search_web") &&
      emailCalls[0].html.includes("https://wala.example.com/dashboard"),
    "HTML body includes tool name and absolute panel link",
  );
  assert(
    typeof emailCalls[0].text === "string" &&
      emailCalls[0].text.includes("search_web") &&
      emailCalls[0].text.includes("Dedupe key: email-ok:error_rate"),
    "plain-text body includes tool name and dedupe key footer",
  );
}

async function testThrottledWithinWindow(): Promise<void> {
  console.log("\nnotifyToolHealthBreach — throttled within window");
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60"; // 60 minutes window

  let slackCalls = 0;
  let dbCalls = 0;
  const sharedDeps = {
    sendSlack: async () => {
      slackCalls++;
      return true;
    },
    sendEmail: async () => ({ success: true }),
    claimDb: async () => {
      dbCalls++;
      return true;
    },
    now: () => 1_700_000_000_000,
  };

  // First call wins the slot.
  const first = await notifyToolHealthBreach(
    makeBreach({ related_record_id: "throttle-key:error_rate" }),
    sharedDeps,
  );
  assertEqual(first.slackSent, true, "first call: Slack send recorded");
  assertEqual(first.throttled, false, "first call: not throttled");
  assertEqual(slackCalls, 1, "Slack invoked exactly once after first call");
  assertEqual(dbCalls, 1, "DB claim invoked exactly once on first call");

  // Second call within the window: in-process throttle map should short-
  // circuit BEFORE Slack or DB is touched.
  const second = await notifyToolHealthBreach(
    makeBreach({ related_record_id: "throttle-key:error_rate" }),
    {
      ...sharedDeps,
      now: () => 1_700_000_000_000 + 30 * 60_000, // +30 min, still inside window
    },
  );
  assertEqual(second.throttled, true, "second call (within window): throttled=true");
  assertEqual(second.slackSent, false, "second call: no Slack send");
  assertEqual(second.skipped, false, "second call: skipped stays false");
  assertEqual(slackCalls, 1, "Slack still invoked exactly once total");
  assertEqual(dbCalls, 1, "DB claim still invoked exactly once total");
}

async function testThrottleResetsAfterWindow(): Promise<void> {
  console.log("\nnotifyToolHealthBreach — throttle resets after window expires");
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";

  let slackCalls = 0;
  let dbCalls = 0;
  const baseDeps = {
    sendSlack: async () => {
      slackCalls++;
      return true;
    },
    sendEmail: async () => ({ success: true }),
    claimDb: async () => {
      dbCalls++;
      return true;
    },
  };

  // First page at t=0.
  const first = await notifyToolHealthBreach(
    makeBreach({ related_record_id: "reset-key:p95_latency", reason: "p95_latency" }),
    { ...baseDeps, now: () => 1_700_000_000_000 },
  );
  assertEqual(first.slackSent, true, "first page sends Slack");
  assertEqual(slackCalls, 1, "Slack call count = 1 after first page");

  // Second page at t = window + 1 minute → throttle window has elapsed
  // and the in-process map must let it through.
  const later = 1_700_000_000_000 + (60 + 1) * 60_000;
  const second = await notifyToolHealthBreach(
    makeBreach({ related_record_id: "reset-key:p95_latency", reason: "p95_latency" }),
    { ...baseDeps, now: () => later },
  );
  assertEqual(second.throttled, false, "second page (after window): not throttled");
  assertEqual(second.slackSent, true, "second page: Slack send recorded");
  assertEqual(slackCalls, 2, "Slack invoked exactly twice total");
  assertEqual(dbCalls, 2, "DB claim invoked exactly twice total");
}

async function testBreachSlackThrowsDoesNotPropagate(): Promise<void> {
  console.log(
    "\nnotifyToolHealthBreach — sendSlack throws ⇒ slackSent=false, no throw escapes",
  );
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";

  let slackCalls = 0;
  let emailCalls = 0;
  // Suppress the expected "Slack send threw" log so test output stays
  // readable. Any unexpected error path still surfaces because we only
  // swallow during the call under test and restore in `finally`.
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await notifyToolHealthBreach(
      makeBreach({ related_record_id: "slack-throw:error_rate" }),
      {
        sendSlack: async () => {
          slackCalls++;
          throw new Error("simulated Slack 5xx");
        },
        sendEmail: async () => {
          emailCalls++;
          return { success: true };
        },
        claimDb: async () => true,
        recordResult: async () => {},
        now: () => 1_700_000_002_000,
      },
    );
    // Critical contract: a Slack outage must NOT propagate up to the cron;
    // the cron tick would otherwise crash and stop subsequent breach checks.
    assertEqual(result.slackSent, false, "result.slackSent is false on throw");
    assertEqual(result.emailSent, false, "result.emailSent stays false (no email config)");
    assertEqual(result.throttled, false, "not throttled — claim succeeded before send");
    assertEqual(result.skipped, false, "not skipped — Slack channel was configured");
    assertEqual(slackCalls, 1, "sendSlack was invoked exactly once before throwing");
    assertEqual(emailCalls, 0, "sendEmail was not invoked (no email recipients)");
  } finally {
    console.error = originalError;
  }
}

async function testBreachEmailRejectedKeepsEmailSentFalse(): Promise<void> {
  console.log(
    "\nnotifyToolHealthBreach — sendEmail returns { success:false } ⇒ emailSent=false",
  );
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  process.env.TOOL_HEALTH_ALERT_EMAIL = "oncall@example.com";

  let emailCalls = 0;
  const result = await notifyToolHealthBreach(
    makeBreach({ related_record_id: "email-reject:error_rate" }),
    {
      sendSlack: async () => false,
      sendEmail: async () => {
        emailCalls++;
        return { success: false, error: "Resend rejected: invalid recipient" };
      },
      claimDb: async () => true,
      recordResult: async () => {},
      now: () => 1_700_000_003_000,
    },
  );
  // Critical contract: a failed Resend response must surface on the result
  // object as `emailSent: false` so the dashboard's notified column shows
  // "failed" rather than misleading operators with a green check.
  assertEqual(result.emailSent, false, "result.emailSent is false on { success: false }");
  assertEqual(result.slackSent, false, "Slack stays false (no channel configured)");
  assertEqual(result.skipped, false, "not skipped — email recipients are configured");
  assertEqual(result.throttled, false, "not throttled");
  assertEqual(emailCalls, 1, "sendEmail was invoked exactly once");
}

async function testBreachEmailThrowsDoesNotPropagate(): Promise<void> {
  console.log(
    "\nnotifyToolHealthBreach — sendEmail throws ⇒ emailSent=false, no throw escapes",
  );
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  process.env.TOOL_HEALTH_ALERT_EMAIL = "oncall@example.com";

  let emailCalls = 0;
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await notifyToolHealthBreach(
      makeBreach({ related_record_id: "email-throw:error_rate" }),
      {
        sendSlack: async () => false,
        sendEmail: async () => {
          emailCalls++;
          throw new Error("simulated Resend network failure");
        },
        claimDb: async () => true,
        recordResult: async () => {},
        now: () => 1_700_000_004_000,
      },
    );
    assertEqual(result.emailSent, false, "result.emailSent is false on throw");
    assertEqual(result.slackSent, false, "Slack stays false (no channel configured)");
    assertEqual(result.skipped, false, "not skipped — email recipients are configured");
    assertEqual(result.throttled, false, "not throttled");
    assertEqual(emailCalls, 1, "sendEmail was invoked exactly once before throwing");
  } finally {
    console.error = originalError;
  }
}

async function testBreachClaimDbThrowsFallsThroughToSend(): Promise<void> {
  console.log(
    "\nnotifyToolHealthBreach — claimDb throws ⇒ notifier still sends (DB-unavailable fall-through)",
  );
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";

  let claimCalls = 0;
  let slackCalls = 0;
  // Suppress the expected "DB claimDb threw" log.
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await notifyToolHealthBreach(
      makeBreach({ related_record_id: "claimdb-throw:error_rate" }),
      {
        sendSlack: async () => {
          slackCalls++;
          return true;
        },
        sendEmail: async () => ({ success: true }),
        claimDb: async () => {
          claimCalls++;
          throw new Error("simulated DB unavailable");
        },
        recordResult: async () => {},
        now: () => 1_700_000_005_000,
      },
    );
    // Documented fall-through path: when the DB claim cannot be executed we
    // err on the side of paging on-call rather than swallowing the breach.
    // The in-process map then prevents this instance from re-paging the same
    // key for the rest of the throttle window.
    assertEqual(result.slackSent, true, "Slack send proceeds despite claimDb throw");
    assertEqual(result.throttled, false, "not throttled — fall-through treats claim as success");
    assertEqual(result.skipped, false, "not skipped");
    assertEqual(claimCalls, 1, "claimDb was invoked exactly once");
    assertEqual(slackCalls, 1, "sendSlack was invoked exactly once after fall-through");
  } finally {
    console.error = originalError;
  }
}

// ---------------------------------------------------------------------------
// Section 1b — persist()/recordResult error containment + channel labels
//
// The persist() helper inside notifyToolHealthBreach wraps recordResult in
// a try/catch so a transient DB write failure (the "Notified" column UPDATE)
// never escapes back to the cron tick. Task #560 covered the Slack/email
// throw paths; this section pins the *third* try/catch — the one around
// recordResult — for every terminal state.
//
// Why this matters (Task #577): a regression that turned the swallow into
// a re-throw would crash the cron *after* a successful page, so operators
// would see the Slack/email but the cron would silently stop until the next
// process restart. The "Notified" column would also stay frozen on the
// previous (or NULL) value, defeating the dashboard's whole purpose.
// ---------------------------------------------------------------------------

async function testBreachRecordResultThrowsAfterSlackSuccess(): Promise<void> {
  console.log(
    "\nnotifyToolHealthBreach — recordResult throws after Slack success ⇒ slackSent stays true, no throw escapes",
  );
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";

  let slackCalls = 0;
  let recordCalls = 0;
  let recordChannel: string | null = null;
  // Suppress the expected "[ToolHealthNotifier] recordResult threw …" log so
  // the test output stays readable; restore in `finally` so any unrelated
  // error path still surfaces.
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await notifyToolHealthBreach(
      makeBreach({ related_record_id: "record-throw-slack:error_rate", alert_id: 7 }),
      {
        sendSlack: async () => {
          slackCalls++;
          return true;
        },
        sendEmail: async () => ({ success: false, error: "should not be called" }),
        claimDb: async () => true,
        recordResult: async (_id, channel) => {
          recordCalls++;
          recordChannel = channel;
          throw new Error("simulated DB UPDATE failure");
        },
        now: () => 1_700_000_010_000,
      },
    );
    // Critical contract: a persist() failure must NEVER undo a successful
    // Slack send. Without this guarantee a transient DB error would leave
    // operators thinking the page failed when it actually went out, AND
    // would crash the cron tick that has already paged on-call.
    assertEqual(result.slackSent, true, "result.slackSent stays true despite recordResult throw");
    assertEqual(result.emailSent, false, "result.emailSent stays false (no email config)");
    assertEqual(result.throttled, false, "not throttled — claim succeeded before send");
    assertEqual(result.skipped, false, "not skipped — Slack channel was configured");
    assertEqual(slackCalls, 1, "sendSlack was invoked exactly once");
    assertEqual(recordCalls, 1, "recordResult was invoked exactly once");
    assertEqual(recordChannel, "slack", "channel persisted is 'slack' (Slack-only configured)");
  } finally {
    console.error = originalError;
  }
}

async function testBreachRecordResultThrowsOnSkippedPath(): Promise<void> {
  console.log(
    "\nnotifyToolHealthBreach — recordResult throws on the 'skipped' persist path ⇒ skipped stays true, no throw escapes",
  );
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  // No Slack channel and no email recipients ⇒ persist("not_configured")
  // is the only call site exercised on this path.

  let slackCalls = 0;
  let emailCalls = 0;
  let recordCalls = 0;
  let recordChannel: string | null = null;
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await notifyToolHealthBreach(
      makeBreach({ related_record_id: "record-throw-skipped:error_rate", alert_id: 8 }),
      {
        sendSlack: async () => {
          slackCalls++;
          return true;
        },
        sendEmail: async () => {
          emailCalls++;
          return { success: true };
        },
        claimDb: async () => true,
        recordResult: async (_id, channel) => {
          recordCalls++;
          recordChannel = channel;
          throw new Error("simulated DB UPDATE failure");
        },
      },
    );
    assertEqual(result.skipped, true, "result.skipped stays true despite recordResult throw");
    assertEqual(result.slackSent, false, "no Slack send recorded");
    assertEqual(result.emailSent, false, "no email send recorded");
    assertEqual(result.throttled, false, "throttled is false (skip is the reason)");
    assertEqual(slackCalls, 0, "sendSlack was not invoked (nothing configured)");
    assertEqual(emailCalls, 0, "sendEmail was not invoked (nothing configured)");
    assertEqual(recordCalls, 1, "recordResult was invoked exactly once on the skip path");
    assertEqual(recordChannel, "not_configured", "skip path persists 'not_configured' channel");
  } finally {
    console.error = originalError;
  }
}

async function testBreachRecordResultThrowsOnThrottledPath(): Promise<void> {
  console.log(
    "\nnotifyToolHealthBreach — recordResult throws on the 'throttled' persist path ⇒ throttled stays true, no throw escapes",
  );
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";

  let slackCalls = 0;
  let recordCalls = 0;
  let recordChannel: string | null = null;
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await notifyToolHealthBreach(
      makeBreach({ related_record_id: "record-throw-throttled:error_rate", alert_id: 9 }),
      {
        sendSlack: async () => {
          slackCalls++;
          return true;
        },
        sendEmail: async () => ({ success: true }),
        // A sibling instance already holds the slot ⇒ persist("throttled").
        claimDb: async () => false,
        recordResult: async (_id, channel) => {
          recordCalls++;
          recordChannel = channel;
          throw new Error("simulated DB UPDATE failure");
        },
        now: () => 1_700_000_011_000,
      },
    );
    assertEqual(result.throttled, true, "result.throttled stays true despite recordResult throw");
    assertEqual(result.slackSent, false, "Slack stays false — claim was lost to a sibling");
    assertEqual(result.emailSent, false, "email stays false — claim was lost to a sibling");
    assertEqual(result.skipped, false, "not skipped");
    assertEqual(slackCalls, 0, "sendSlack was not invoked (claim lost)");
    assertEqual(recordCalls, 1, "recordResult was invoked exactly once on the throttle path");
    assertEqual(recordChannel, "throttled", "throttle path persists 'throttled' channel");
  } finally {
    console.error = originalError;
  }
}

async function testBreachRecordResultThrowsOnFailedPath(): Promise<void> {
  console.log(
    "\nnotifyToolHealthBreach — recordResult throws on the 'failed' persist path ⇒ result mirrors actual outcome, no throw escapes",
  );
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_ALERT_EMAIL = "oncall@example.com";

  let recordCalls = 0;
  let recordChannel: string | null = null;
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await notifyToolHealthBreach(
      makeBreach({ related_record_id: "record-throw-failed:error_rate", alert_id: 10 }),
      {
        // Both transports report failure WITHOUT throwing, so the only
        // try/catch that fires here is the one around recordResult.
        sendSlack: async () => false,
        sendEmail: async () => ({ success: false, error: "Resend rejected" }),
        claimDb: async () => true,
        recordResult: async (_id, channel) => {
          recordCalls++;
          recordChannel = channel;
          throw new Error("simulated DB UPDATE failure");
        },
        now: () => 1_700_000_012_000,
      },
    );
    assertEqual(result.slackSent, false, "result.slackSent stays false (transport returned false)");
    assertEqual(result.emailSent, false, "result.emailSent stays false (transport returned false)");
    assertEqual(result.throttled, false, "not throttled");
    assertEqual(result.skipped, false, "not skipped");
    assertEqual(recordCalls, 1, "recordResult was invoked exactly once on the failed path");
    assertEqual(recordChannel, "failed", "failed path persists 'failed' channel");
  } finally {
    console.error = originalError;
  }
}

async function testBreachRecordResultChannelLabelPerTerminalState(): Promise<void> {
  console.log(
    "\nnotifyToolHealthBreach — recordResult is invoked with the correct channel label for each terminal state",
  );

  // Each terminal state writes a distinct channel string that the AI Ops
  // panel uses to render the "what was configured vs what delivered"
  // distinction. Pin the exact label per state so a refactor that, say,
  // collapsed `slack_only` into `slack` would fail loudly here instead of
  // silently regressing the dashboard's filtering.
  type Capture = { channel: string; alertId: number | null | undefined; whenMs: number };
  const captures: Record<string, Capture[]> = {};
  function makeRecorder(label: string) {
    captures[label] = [];
    return async (alertId: number | null | undefined, channel: string, whenMs: number) => {
      captures[label].push({ channel, alertId, whenMs });
    };
  }

  // -- not_configured: no Slack channel, no email recipients --
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  await notifyToolHealthBreach(
    makeBreach({ related_record_id: "ch-notconfigured:error_rate", alert_id: 100 }),
    {
      sendSlack: async () => true,
      sendEmail: async () => ({ success: true }),
      claimDb: async () => true,
      recordResult: makeRecorder("not_configured"),
      now: () => 1_700_000_020_000,
    },
  );

  // -- throttled: claimDb returns false (sibling holds the slot) --
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";
  await notifyToolHealthBreach(
    makeBreach({ related_record_id: "ch-throttled:error_rate", alert_id: 101 }),
    {
      sendSlack: async () => true,
      sendEmail: async () => ({ success: true }),
      claimDb: async () => false,
      recordResult: makeRecorder("throttled"),
      now: () => 1_700_000_021_000,
    },
  );

  // -- slack+email: both configured, both succeed --
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_ALERT_EMAIL = "oncall@example.com";
  await notifyToolHealthBreach(
    makeBreach({ related_record_id: "ch-both:error_rate", alert_id: 102 }),
    {
      sendSlack: async () => true,
      sendEmail: async () => ({ success: true }),
      claimDb: async () => true,
      recordResult: makeRecorder("slack+email"),
      now: () => 1_700_000_022_000,
    },
  );

  // -- slack_only: Slack OK, email configured but failed (the
  //    "Slack delivered, email is broken" signal for ops). --
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_ALERT_EMAIL = "oncall@example.com";
  await notifyToolHealthBreach(
    makeBreach({ related_record_id: "ch-slackonly:error_rate", alert_id: 103 }),
    {
      sendSlack: async () => true,
      sendEmail: async () => ({ success: false, error: "Resend rejected" }),
      claimDb: async () => true,
      recordResult: makeRecorder("slack_only"),
      now: () => 1_700_000_023_000,
    },
  );

  // -- email_only: email OK, Slack configured but failed (the
  //    "email delivered, Slack is broken" signal for ops). --
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_ALERT_EMAIL = "oncall@example.com";
  await notifyToolHealthBreach(
    makeBreach({ related_record_id: "ch-emailonly:error_rate", alert_id: 104 }),
    {
      sendSlack: async () => false,
      sendEmail: async () => ({ success: true }),
      claimDb: async () => true,
      recordResult: makeRecorder("email_only"),
      now: () => 1_700_000_024_000,
    },
  );

  // -- failed: both configured, both fail --
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_ALERT_EMAIL = "oncall@example.com";
  await notifyToolHealthBreach(
    makeBreach({ related_record_id: "ch-failed:error_rate", alert_id: 105 }),
    {
      sendSlack: async () => false,
      sendEmail: async () => ({ success: false, error: "Resend rejected" }),
      claimDb: async () => true,
      recordResult: makeRecorder("failed"),
      now: () => 1_700_000_025_000,
    },
  );

  for (const expected of [
    "not_configured",
    "throttled",
    "slack+email",
    "slack_only",
    "email_only",
    "failed",
  ]) {
    const recs = captures[expected] ?? [];
    assertEqual(
      recs.length,
      1,
      `recordResult invoked exactly once for terminal state '${expected}'`,
    );
    assertEqual(
      recs[0]?.channel,
      expected,
      `recordResult received channel='${expected}' for terminal state '${expected}'`,
    );
  }
  // Spot-check that persist() forwards alert_id and the injected clock to
  // recordResult — the "Notified" column relies on both to render an
  // accurate row + timestamp.
  assertEqual(
    captures["slack+email"][0].alertId,
    102,
    "slack+email persist forwards the alert_id from the breach payload",
  );
  assertEqual(
    captures["slack+email"][0].whenMs,
    1_700_000_022_000,
    "slack+email persist forwards the injected clock to recordResult",
  );
}

// ---------------------------------------------------------------------------
// Section 2 — notifyToolHealthOverrideExpired
// ---------------------------------------------------------------------------

async function testOverrideExpiredSlackPost(): Promise<void> {
  console.log("\nnotifyToolHealthOverrideExpired — Slack post on auto-revert");
  clearEnv();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_APP_URL = "https://wala.example.com";

  type SlackArgs = { channel: string; text: string; blocks: any[] };
  const slackCalls: SlackArgs[] = [];

  const expiredAt = new Date("2026-04-25T14:30:00.000Z");
  const note: ToolHealthOverrideExpiredNotification = {
    cleared_overrides: { errorRatePct: 25, p95LatencyMs: 5000 },
    previous_updated_by: "alice@example.com",
    expired_at: expiredAt,
    audit_id: 99,
  };

  const result = await notifyToolHealthOverrideExpired(note, {
    sendSlack: async (channel, text, blocks) => {
      slackCalls.push({ channel, text, blocks: blocks as any[] });
      return true;
    },
  });

  assertEqual(result.slackSent, true, "slackSent=true on success");
  assertEqual(result.skipped, false, "not skipped — channel was configured");
  assertEqual(slackCalls.length, 1, "Slack invoked exactly once");
  assertEqual(slackCalls[0].channel, "C-ONCALL", "posted to configured channel");
  assert(
    slackCalls[0].text.includes("alice@example.com"),
    "fallback text attributes the prior override owner",
  );
  assert(
    slackCalls[0].text.includes("error-rate breach floor"),
    "fallback text describes a cleared field in plain text",
  );

  const blocks = slackCalls[0].blocks;
  assertEqual(blocks[0]?.type, "header", "first block is the header");
  assert(
    typeof blocks[0]?.text?.text === "string" &&
      blocks[0].text.text.includes("override auto-reverted"),
    "header announces the auto-revert",
  );
  // Confirm the cleared fields are rendered in a section block.
  const allSectionText = blocks
    .filter((b: any) => b?.type === "section")
    .map((b: any) => b?.text?.text ?? "")
    .join("\n");
  assert(
    allSectionText.includes("error-rate breach floor (%)") &&
      allSectionText.includes("(was 25)"),
    "cleared error-rate field is rendered with prior value",
  );
  assert(
    allSectionText.includes("p95 latency breach floor (ms)") &&
      allSectionText.includes("(was 5000)"),
    "cleared p95-latency field is rendered with prior value",
  );
  // Absolute URL ⇒ "Open audit log" actions.button (not the fallback link).
  const buttonBlock = blocks.find(
    (b: any) =>
      b?.type === "actions" &&
      Array.isArray(b.elements) &&
      b.elements.some((e: any) => e?.text?.text === "Open audit log"),
  );
  assert(buttonBlock != null, "renders an Open audit log button when APP_URL is absolute");
  // Context block carries the audit id for traceability.
  const contextText = blocks
    .filter((b: any) => b?.type === "context")
    .flatMap((b: any) => b.elements ?? [])
    .map((e: any) => e?.text ?? "")
    .join(" ");
  assert(contextText.includes("audit row #99"), "context block carries the audit row id");
}

async function testOverrideExpiredSlackThrowsDoesNotPropagate(): Promise<void> {
  console.log(
    "\nnotifyToolHealthOverrideExpired — sendSlack throws ⇒ slackSent=false, no throw escapes",
  );
  clearEnv();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";

  let slackCalls = 0;
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await notifyToolHealthOverrideExpired(
      {
        cleared_overrides: { errorRatePct: 25 },
        previous_updated_by: "alice@example.com",
        expired_at: new Date("2026-04-25T16:00:00.000Z"),
        audit_id: 101,
      },
      {
        sendSlack: async () => {
          slackCalls++;
          throw new Error("simulated Slack 5xx");
        },
      },
    );
    // Critical contract: a Slack outage must NOT propagate up to the
    // override reaper; the override row has already been cleared and the
    // audit entry written, so a thrown send would leave the cron in a
    // confused half-revert state on the next tick.
    assertEqual(result.slackSent, false, "result.slackSent is false on throw");
    assertEqual(result.skipped, false, "not skipped — channel was configured");
    assertEqual(slackCalls, 1, "sendSlack was invoked exactly once before throwing");
  } finally {
    console.error = originalError;
  }
}

async function testOverrideExpiredSkippedWithoutChannel(): Promise<void> {
  console.log("\nnotifyToolHealthOverrideExpired — skipped when no Slack channel");
  clearEnv();
  let slackCalls = 0;
  const result = await notifyToolHealthOverrideExpired(
    {
      cleared_overrides: { errorRatePct: 10 },
      previous_updated_by: null,
      expired_at: new Date("2026-04-25T15:00:00.000Z"),
      audit_id: null,
    },
    {
      sendSlack: async () => {
        slackCalls++;
        return true;
      },
    },
  );
  assertEqual(result.skipped, true, "skipped=true with no channel configured");
  assertEqual(result.slackSent, false, "no Slack send recorded");
  assertEqual(slackCalls, 0, "sendSlack was not invoked");
}

// ---------------------------------------------------------------------------
// Section 3 — _diffToolHealthConfigOverridesForTests
// ---------------------------------------------------------------------------

function testDiffNoChanges(): void {
  console.log("\n_diffToolHealthConfigOverridesForTests — no changes ⇒ empty");
  const diff = _diffToolHealthConfigOverridesForTests(
    { errorRatePct: 10, p95LatencyMs: 1000 },
    { errorRatePct: 10, p95LatencyMs: 1000 },
  );
  assertEqual(diff.length, 0, "diff is empty when both blobs are identical");
}

function testDiffValueChange(): void {
  console.log("\n_diffToolHealthConfigOverridesForTests — value-to-value diff");
  const diff = _diffToolHealthConfigOverridesForTests(
    { errorRatePct: 10, p95LatencyMs: 1000 },
    { errorRatePct: 15, p95LatencyMs: 1000 },
  );
  assertDeepEqual(
    diff,
    [{ field: "errorRatePct", before: 10, after: 15 }],
    "single field with new numeric value is reported",
  );
}

function testDiffSetAndClear(): void {
  console.log("\n_diffToolHealthConfigOverridesForTests — set & clear transitions");
  // Setting an override that wasn't there ⇒ before:null → after:N
  // Clearing an override that was there ⇒ before:N → after:null
  const diff = _diffToolHealthConfigOverridesForTests(
    { errorRatePct: 10 /* p95LatencyMs not set */ },
    { /* errorRatePct cleared */ p95LatencyMs: 2000 },
  );
  // CONFIG_FIELD_ORDER places errorRatePct before p95LatencyMs, so order is stable.
  assertDeepEqual(
    diff,
    [
      { field: "errorRatePct", before: 10, after: null },
      { field: "p95LatencyMs", before: null, after: 2000 },
    ],
    "diff captures both clear (→ null) and set (null →) transitions in canonical order",
  );
}

function testDiffOrderIsCanonical(): void {
  console.log("\n_diffToolHealthConfigOverridesForTests — canonical field ordering");
  // Provide changes whose insertion order in the object literal differs from
  // CONFIG_FIELD_ORDER, then verify the diff respects the canonical order.
  const before = {
    latencyCriticalMs: 9000,
    minCalls: 10,
    errorRatePct: 5,
  };
  const after = {
    minCalls: 20,
    errorRatePct: 8,
    latencyCriticalMs: 12000,
  };
  const diff = _diffToolHealthConfigOverridesForTests(before, after);
  const fields = diff.map((d) => d.field);
  assertDeepEqual(
    fields,
    ["minCalls", "errorRatePct", "latencyCriticalMs"],
    "diff fields appear in CONFIG_FIELD_ORDER, not insertion order",
  );
}

// ---------------------------------------------------------------------------
// Section 4 — notifyToolHealthConfigChange (Task #497)
//
// Sister of the breach notifier — fires when an admin tunes the per-tool
// alert thresholds. Same env-var resolution rules as the breach path, plus
// an additional `TOOL_HEALTH_CONFIG_NOTIFY=1` opt-in gate so dev/test
// environments don't post on every save. The Slack body also embeds a
// "Recent changes" block sourced from the audit DB; we inject `getAudit`
// so no real DB call is made.
// ---------------------------------------------------------------------------

function makeConfigChange(
  overrides: Partial<ToolHealthConfigChangeNotification> = {},
): ToolHealthConfigChangeNotification {
  return {
    changedBy: "alice@example.com",
    before: { errorRatePct: 10, p95LatencyMs: 1000 },
    after: { errorRatePct: 15, p95LatencyMs: 1000 },
    note: null,
    audit_id: 7,
    ...overrides,
  };
}

async function testConfigChangeDisabledWhenEnvNotSet(): Promise<void> {
  console.log(
    "\nnotifyToolHealthConfigChange — disabled when TOOL_HEALTH_CONFIG_NOTIFY != 1",
  );
  clearEnv();
  // Even with a Slack channel configured, the opt-in gate must dominate so
  // existing breach-channel wiring doesn't accidentally start posting on
  // every threshold save.
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";

  let slackCalls = 0;
  let emailCalls = 0;
  let auditCalls = 0;

  const result = await notifyToolHealthConfigChange(makeConfigChange(), {
    sendSlack: async () => {
      slackCalls++;
      return true;
    },
    sendEmail: async () => {
      emailCalls++;
      return { success: true };
    },
    getAudit: async () => {
      auditCalls++;
      return [];
    },
  });

  assertEqual(result.disabled, true, "result.disabled is true");
  assertEqual(result.skipped, false, "skipped stays false (gated before transport check)");
  assertEqual(result.noChanges, false, "noChanges stays false");
  assertEqual(result.slackSent, false, "no Slack send recorded");
  assertEqual(result.emailSent, false, "no email send recorded");
  assertEqual(slackCalls, 0, "sendSlack was not invoked");
  assertEqual(emailCalls, 0, "sendEmail was not invoked");
  assertEqual(auditCalls, 0, "getAudit was not invoked (gated before audit fetch)");
}

async function testConfigChangeSkippedWithoutTransport(): Promise<void> {
  console.log(
    "\nnotifyToolHealthConfigChange — skipped when no Slack channel and no email recipients",
  );
  clearEnv();
  // Opt in but configure NO transport — must fall through to skipped.
  process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";

  let slackCalls = 0;
  let emailCalls = 0;
  let auditCalls = 0;

  const result = await notifyToolHealthConfigChange(makeConfigChange(), {
    sendSlack: async () => {
      slackCalls++;
      return true;
    },
    sendEmail: async () => {
      emailCalls++;
      return { success: true };
    },
    getAudit: async () => {
      auditCalls++;
      return [];
    },
  });

  assertEqual(result.skipped, true, "result.skipped is true");
  assertEqual(result.disabled, false, "disabled stays false (opt-in WAS set)");
  assertEqual(result.noChanges, false, "noChanges stays false");
  assertEqual(result.slackSent, false, "no Slack send recorded");
  assertEqual(result.emailSent, false, "no email send recorded");
  assertEqual(slackCalls, 0, "sendSlack was not invoked");
  assertEqual(emailCalls, 0, "sendEmail was not invoked");
  assertEqual(auditCalls, 0, "getAudit was not invoked (skipped before audit fetch)");
}

async function testConfigChangeNoChanges(): Promise<void> {
  console.log(
    "\nnotifyToolHealthConfigChange — noChanges when before/after are identical",
  );
  clearEnv();
  process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";

  let slackCalls = 0;
  let auditCalls = 0;
  const identical = { errorRatePct: 10, p95LatencyMs: 1000 };
  const result = await notifyToolHealthConfigChange(
    makeConfigChange({ before: identical, after: identical }),
    {
      sendSlack: async () => {
        slackCalls++;
        return true;
      },
      getAudit: async () => {
        auditCalls++;
        return [];
      },
    },
  );

  assertEqual(result.noChanges, true, "result.noChanges is true");
  assertEqual(result.slackSent, false, "no Slack send recorded");
  assertEqual(result.emailSent, false, "no email send recorded");
  assertEqual(result.disabled, false, "disabled stays false");
  assertEqual(result.skipped, false, "skipped stays false");
  assertEqual(slackCalls, 0, "sendSlack was not invoked (early return on no-op diff)");
  assertEqual(auditCalls, 0, "getAudit was not invoked (early return on no-op diff)");
}

async function testConfigChangeSlackAndEmailOnSuccess(): Promise<void> {
  console.log(
    "\nnotifyToolHealthConfigChange — slackSent + emailSent on success, with injected audit",
  );
  clearEnv();
  process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_ALERT_EMAIL = "ops@example.com";
  process.env.TOOL_HEALTH_APP_URL = "https://wala.example.com";

  type SlackArgs = { channel: string; text: string; blocks: any[] };
  const slackCalls: SlackArgs[] = [];
  type EmailArgs = { to: string | string[]; subject: string; html?: string; text?: string };
  const emailCalls: EmailArgs[] = [];

  // Inject 2 audit entries so the "Recent changes" Slack block has data
  // without touching the real DB.
  const auditStub: ToolHealthConfigAuditEntry[] = [
    {
      id: 7,
      changed_at: new Date("2026-04-25T12:34:00.000Z"),
      changed_by: "alice@example.com",
      before_values: { errorRatePct: 10, p95LatencyMs: 1000 },
      after_values: { errorRatePct: 15, p95LatencyMs: 1000 },
      note: null,
      breach_diff: null,
    },
    {
      id: 6,
      changed_at: new Date("2026-04-24T09:00:00.000Z"),
      changed_by: "bob@example.com",
      before_values: { minCalls: 10 },
      after_values: { minCalls: 20 },
      note: null,
      breach_diff: null,
    },
  ];
  let auditLimitSeen: number | null = null;

  const result = await notifyToolHealthConfigChange(
    makeConfigChange({
      before: { errorRatePct: 10, p95LatencyMs: 1000 },
      after: { errorRatePct: 15, p95LatencyMs: 1000 },
      note: "tightening after Friday's incident",
    }),
    {
      sendSlack: async (channel, text, blocks) => {
        slackCalls.push({ channel, text, blocks: blocks as any[] });
        return true;
      },
      sendEmail: async (opts) => {
        emailCalls.push(opts as EmailArgs);
        return { success: true, id: "msg-cfg-1" };
      },
      getAudit: async (limit) => {
        auditLimitSeen = limit;
        return auditStub;
      },
    },
  );

  assertEqual(result.slackSent, true, "result.slackSent is true");
  assertEqual(result.emailSent, true, "result.emailSent is true");
  assertEqual(result.disabled, false, "not disabled");
  assertEqual(result.skipped, false, "not skipped");
  assertEqual(result.noChanges, false, "not noChanges");

  // Slack assertions.
  assertEqual(slackCalls.length, 1, "sendSlack called exactly once");
  assertEqual(slackCalls[0].channel, "C-ONCALL", "Slack posted to configured channel");
  assert(
    slackCalls[0].text.includes("alice@example.com"),
    "Slack fallback text attributes the operator",
  );
  assert(
    slackCalls[0].text.includes("1 change"),
    "Slack fallback text states the change count",
  );
  const blocks = slackCalls[0].blocks;
  assertEqual(blocks[0]?.type, "header", "first block is the header");
  assert(
    typeof blocks[0]?.text?.text === "string" &&
      blocks[0].text.text.includes("Tool-health alert thresholds updated"),
    "header announces the threshold update",
  );
  // The link must be the absolute thresholds-tab deep link, since APP_URL is set.
  const hasButton = blocks.some(
    (b: any) =>
      b?.type === "actions" &&
      Array.isArray(b.elements) &&
      b.elements.some(
        (e: any) =>
          e?.url === "https://wala.example.com/dashboard?tab=thresholds",
      ),
  );
  assert(hasButton, "absolute APP_URL renders an Open Alert Thresholds button");
  // Audit-derived "Recent changes" block must mention the injected operators.
  const allSectionText = blocks
    .filter((b: any) => b?.type === "section")
    .map((b: any) => b?.text?.text ?? "")
    .join("\n");
  assert(
    allSectionText.includes("Recent changes (last 2)"),
    "Recent changes block reflects the injected audit count",
  );
  assert(
    allSectionText.includes("alice@example.com") &&
      allSectionText.includes("bob@example.com"),
    "Recent changes block lists both injected audit operators",
  );
  // Note from the operator should also be rendered.
  assert(
    allSectionText.includes("tightening after Friday's incident"),
    "operator note is rendered in a section block",
  );
  // The notifier asks for the last 3 audit entries.
  assertEqual(auditLimitSeen, 3, "getAudit called with limit=3");

  // Email assertions.
  assertEqual(emailCalls.length, 1, "sendEmail called exactly once");
  assertDeepEqual(
    emailCalls[0].to,
    ["ops@example.com"],
    "TOOL_HEALTH_ALERT_EMAIL is split into a recipient array",
  );
  assert(
    emailCalls[0].subject.startsWith("[Tool Health · Thresholds Updated]"),
    "subject prefixes [Tool Health · Thresholds Updated]",
  );
  assert(
    typeof emailCalls[0].html === "string" &&
      emailCalls[0].html.includes("alice@example.com") &&
      emailCalls[0].html.includes(
        "https://wala.example.com/dashboard?tab=thresholds",
      ),
    "HTML body attributes the operator and links to the thresholds tab",
  );
  assert(
    typeof emailCalls[0].text === "string" &&
      emailCalls[0].text.includes("Error rate floor (%): 10 → 15"),
    "plain-text body renders the field-level diff",
  );
}

async function testConfigChangeSlackAndEmailFailIndependently(): Promise<void> {
  console.log(
    "\nnotifyToolHealthConfigChange — sendSlack throws and sendEmail rejects independently",
  );
  clearEnv();
  process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_ALERT_EMAIL = "ops@example.com";

  let slackCalls = 0;
  let emailCalls = 0;
  let auditCalls = 0;
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await notifyToolHealthConfigChange(makeConfigChange(), {
      sendSlack: async () => {
        slackCalls++;
        throw new Error("simulated Slack 5xx");
      },
      // sendEmail rejected — surfaced as { success: false } rather than
      // a throw to mirror the Resend SDK's rejected-message branch.
      sendEmail: async () => {
        emailCalls++;
        return { success: false, error: "Resend rejected: invalid recipient" };
      },
      getAudit: async () => {
        auditCalls++;
        return [];
      },
    });

    // Critical contract: the two channels are independent. A Slack outage
    // must not block the email attempt, and a rejected email must not
    // block the result from reflecting the Slack outcome.
    assertEqual(result.slackSent, false, "result.slackSent is false on Slack throw");
    assertEqual(result.emailSent, false, "result.emailSent is false on Resend rejection");
    assertEqual(result.disabled, false, "not disabled — opt-in WAS set");
    assertEqual(result.skipped, false, "not skipped — both transports configured");
    assertEqual(result.noChanges, false, "not noChanges — diff was non-empty");
    assertEqual(slackCalls, 1, "sendSlack was invoked exactly once before throwing");
    assertEqual(emailCalls, 1, "sendEmail was still invoked despite Slack throw");
    assertEqual(auditCalls, 1, "getAudit was invoked once for the Slack block");
  } finally {
    console.error = originalError;
  }
}

async function testConfigChangeAuditThrowsStillSendsSlack(): Promise<void> {
  console.log(
    "\nnotifyToolHealthConfigChange — getAudit throws ⇒ Slack still sends (best-effort)",
  );
  clearEnv();
  process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";

  type SlackArgs = { channel: string; text: string; blocks: any[] };
  const slackCalls: SlackArgs[] = [];
  let auditCalls = 0;
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await notifyToolHealthConfigChange(makeConfigChange(), {
      sendSlack: async (channel, text, blocks) => {
        slackCalls.push({ channel, text, blocks: blocks as any[] });
        return true;
      },
      getAudit: async () => {
        auditCalls++;
        throw new Error("simulated audit DB unavailable");
      },
    });

    // Critical contract: a DB hiccup loading the "Recent changes" block
    // must NOT block the primary Slack post. The block is a nice-to-have
    // — losing it should never make on-call miss the threshold change.
    assertEqual(result.slackSent, true, "Slack send proceeds despite audit fetch throw");
    assertEqual(result.disabled, false, "not disabled");
    assertEqual(result.skipped, false, "not skipped");
    assertEqual(result.noChanges, false, "not noChanges");
    assertEqual(auditCalls, 1, "getAudit was invoked exactly once before throwing");
    assertEqual(slackCalls.length, 1, "sendSlack was invoked exactly once after audit throw");

    // The "Recent changes" block must be absent when the audit fetch
    // failed — the renderer skips the section when the array is empty.
    const allSectionText = slackCalls[0].blocks
      .filter((b: any) => b?.type === "section")
      .map((b: any) => b?.text?.text ?? "")
      .join("\n");
    assert(
      !allSectionText.includes("Recent changes"),
      "Recent changes section is omitted when audit fetch throws",
    );
  } finally {
    console.error = originalError;
  }
}

async function testConfigChangeRendersImpactSection(): Promise<void> {
  console.log(
    "\nnotifyToolHealthConfigChange — renders Impact section when breach_diff is provided",
  );
  clearEnv();
  process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";

  type SlackArgs = { channel: string; text: string; blocks: any[] };
  const slackCalls: SlackArgs[] = [];

  const result = await notifyToolHealthConfigChange(
    makeConfigChange({
      breach_diff: {
        new_breaches: [
          { tool_name: "search", reason: "error_rate", severity: "high" },
          { tool_name: "search", reason: "p95_latency", severity: "medium" },
        ],
        resolved_breaches: [
          { tool_name: "fetch", reason: "error_rate", severity: "high" },
        ],
        severity_changes: [],
      },
    }),
    {
      sendSlack: async (channel, text, blocks) => {
        slackCalls.push({ channel, text, blocks: blocks as any[] });
        return true;
      },
      getAudit: async () => [],
    },
  );

  assertEqual(result.slackSent, true, "Slack send proceeded");
  assertEqual(slackCalls.length, 1, "sendSlack invoked exactly once");
  const allSectionText = slackCalls[0].blocks
    .filter((b: any) => b?.type === "section")
    .map((b: any) => b?.text?.text ?? "")
    .join("\n");
  assert(
    allSectionText.includes("Impact:"),
    "Impact section is rendered when breach_diff is non-empty",
  );
  assert(
    allSectionText.includes("New alerts:* 2"),
    "Impact lists count of new alerts",
  );
  assert(
    allSectionText.includes("Resolved alerts:* 1"),
    "Impact lists count of resolved alerts",
  );
  assert(
    allSectionText.includes("Severity changes:* 0"),
    "Impact lists count of severity changes (zero allowed)",
  );
}

async function testConfigChangeOmitsImpactSectionWhenNull(): Promise<void> {
  console.log(
    "\nnotifyToolHealthConfigChange — omits Impact section when breach_diff is null",
  );
  clearEnv();
  process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";

  type SlackArgs = { channel: string; text: string; blocks: any[] };
  const slackCalls: SlackArgs[] = [];

  const result = await notifyToolHealthConfigChange(
    makeConfigChange({ breach_diff: null }),
    {
      sendSlack: async (channel, text, blocks) => {
        slackCalls.push({ channel, text, blocks: blocks as any[] });
        return true;
      },
      getAudit: async () => [],
    },
  );

  assertEqual(result.slackSent, true, "Slack send proceeded");
  const allSectionText = slackCalls[0].blocks
    .filter((b: any) => b?.type === "section")
    .map((b: any) => b?.text?.text ?? "")
    .join("\n");
  assert(
    !allSectionText.includes("Impact:"),
    "Impact section is omitted when breach_diff is null (graceful fallback)",
  );
}

async function testConfigChangeOmitsImpactSectionWhenEmpty(): Promise<void> {
  console.log(
    "\nnotifyToolHealthConfigChange — omits Impact section when breach_diff has zero entries across all buckets",
  );
  clearEnv();
  process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";

  type SlackArgs = { channel: string; text: string; blocks: any[] };
  const slackCalls: SlackArgs[] = [];

  await notifyToolHealthConfigChange(
    makeConfigChange({
      breach_diff: {
        new_breaches: [],
        resolved_breaches: [],
        severity_changes: [],
      },
    }),
    {
      sendSlack: async (channel, text, blocks) => {
        slackCalls.push({ channel, text, blocks: blocks as any[] });
        return true;
      },
      getAudit: async () => [],
    },
  );

  const allSectionText = slackCalls[0].blocks
    .filter((b: any) => b?.type === "section")
    .map((b: any) => b?.text?.text ?? "")
    .join("\n");
  assert(
    !allSectionText.includes("Impact:"),
    "Impact section is omitted when all diff buckets are empty (avoid noise)",
  );
}

// ---------------------------------------------------------------------------
// Section 4b — notifyToolHealthConfigChange threading (Task #383)
//
// When the same admin (or several admins) tune the thresholds repeatedly on
// the same UTC day, we want exactly one root message in the channel feed
// and every subsequent post to fold into a thread reply under it. The
// notifier persists the root's `ts` via `setThreadTs` and reads it back
// via `getThreadTs` so threading survives a server restart.
// ---------------------------------------------------------------------------

async function testConfigChangeFirstPostSavesRootThreadTs(): Promise<void> {
  console.log(
    "\nnotifyToolHealthConfigChange — first post saves a root ts (no thread_ts forwarded)",
  );
  clearEnv();
  process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";

  type Captured = {
    channel: string;
    text: string;
    blocks: any[];
    thread_ts: string | undefined;
  };
  const calls: Captured[] = [];
  const setCalls: Array<{ key: string; day: string; ts: string }> = [];
  const result = await notifyToolHealthConfigChange(makeConfigChange(), {
    postSlack: async (channel, text, blocks, thread_ts) => {
      calls.push({ channel, text, blocks: blocks ?? [], thread_ts });
      return { ok: true, ts: "1700000000.000100" };
    },
    getThreadTs: async () => null,
    setThreadTs: async (key, day, ts) => {
      setCalls.push({ key, day, ts });
    },
    getAudit: async () => [],
    // Pin "now" to a stable UTC noon so the day key is deterministic.
    now: () => Date.UTC(2026, 4, 3, 12, 0, 0),
  });

  assertEqual(result.slackSent, true, "slackSent true");
  assertEqual(calls.length, 1, "postSlack invoked exactly once");
  assertEqual(
    calls[0].thread_ts,
    undefined,
    "no thread_ts on the first post of the day (root)",
  );
  assertEqual(setCalls.length, 1, "setThreadTs invoked exactly once");
  assertEqual(
    setCalls[0].key,
    TOOL_HEALTH_CONFIG_THREAD_KEY,
    "stored under the config_change notify key",
  );
  assertEqual(setCalls[0].day, "2026-05-03", "stored under today's UTC day");
  assertEqual(
    setCalls[0].ts,
    "1700000000.000100",
    "stored ts matches the Slack response",
  );
}

async function testConfigChangeSecondPostThreadsUnderRoot(): Promise<void> {
  console.log(
    "\nnotifyToolHealthConfigChange — second post forwards thread_ts and does NOT overwrite root",
  );
  clearEnv();
  process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";

  type Captured = {
    thread_ts: string | undefined;
  };
  const calls: Captured[] = [];
  const setCalls: Array<{ key: string; day: string; ts: string }> = [];
  const ROOT_TS = "1700000000.000100";

  const result = await notifyToolHealthConfigChange(makeConfigChange(), {
    postSlack: async (_channel, _text, _blocks, thread_ts) => {
      calls.push({ thread_ts });
      return { ok: true, ts: "1700000050.000200" };
    },
    getThreadTs: async () => ROOT_TS,
    setThreadTs: async (key, day, ts) => {
      setCalls.push({ key, day, ts });
    },
    getAudit: async () => [],
    now: () => Date.UTC(2026, 4, 3, 14, 30, 0),
  });

  assertEqual(result.slackSent, true, "slackSent true");
  assertEqual(calls.length, 1, "postSlack invoked exactly once");
  assertEqual(
    calls[0].thread_ts,
    ROOT_TS,
    "second post forwards the persisted root ts as thread_ts",
  );
  assertEqual(
    setCalls.length,
    0,
    "thread reply must not overwrite the persisted root ts",
  );
}

async function testConfigChangeSetThreadTsThrowsDoesNotPropagate(): Promise<void> {
  console.log(
    "\nnotifyToolHealthConfigChange — setThreadTs throw is swallowed (slack already posted)",
  );
  clearEnv();
  process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";

  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await notifyToolHealthConfigChange(makeConfigChange(), {
      postSlack: async () => ({ ok: true, ts: "1700000099.000999" }),
      getThreadTs: async () => null,
      setThreadTs: async () => {
        throw new Error("simulated DB write failure");
      },
      getAudit: async () => [],
      now: () => Date.UTC(2026, 4, 3, 12, 0, 0),
    });

    assertEqual(
      result.slackSent,
      true,
      "slackSent stays true — page is independent of bookkeeping",
    );
  } finally {
    console.error = originalError;
  }
}

async function testConfigChangeGetThreadTsThrowsFallsBackToRoot(): Promise<void> {
  console.log(
    "\nnotifyToolHealthConfigChange — getThreadTs throw degrades to a fresh root post",
  );
  clearEnv();
  process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";

  const calls: Array<{ thread_ts: string | undefined }> = [];
  const setCalls: Array<{ ts: string }> = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await notifyToolHealthConfigChange(makeConfigChange(), {
      postSlack: async (_c, _t, _b, thread_ts) => {
        calls.push({ thread_ts });
        return { ok: true, ts: "1700000111.000111" };
      },
      getThreadTs: async () => {
        throw new Error("simulated DB read failure");
      },
      setThreadTs: async (_k, _d, ts) => {
        setCalls.push({ ts });
      },
      getAudit: async () => [],
      now: () => Date.UTC(2026, 4, 3, 12, 0, 0),
    });

    assertEqual(result.slackSent, true, "slackSent true");
    assertEqual(
      calls[0].thread_ts,
      undefined,
      "no thread_ts forwarded when the lookup failed",
    );
    assertEqual(
      setCalls.length,
      1,
      "fresh root ts is persisted so the next post threads correctly",
    );
    assertEqual(setCalls[0].ts, "1700000111.000111", "ts persisted matches");
  } finally {
    console.error = originalError;
  }
}

async function testConfigChangeLegacySendSlackSkipsThreading(): Promise<void> {
  console.log(
    "\nnotifyToolHealthConfigChange — legacy sendSlack dep keeps working (threading disabled)",
  );
  clearEnv();
  process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";

  let getCalls = 0;
  let setCalls = 0;
  let sendCalls = 0;
  const result = await notifyToolHealthConfigChange(makeConfigChange(), {
    sendSlack: async () => {
      sendCalls++;
      return true;
    },
    getThreadTs: async () => {
      getCalls++;
      return null;
    },
    setThreadTs: async () => {
      setCalls++;
    },
    getAudit: async () => [],
    now: () => Date.UTC(2026, 4, 3, 12, 0, 0),
  });

  assertEqual(result.slackSent, true, "slackSent true via legacy sendSlack");
  assertEqual(sendCalls, 1, "legacy sendSlack invoked exactly once");
  assertEqual(getCalls, 1, "getThreadTs still consulted (lookup is cheap)");
  assertEqual(
    setCalls,
    0,
    "setThreadTs not invoked — legacy sendSlack returns no ts to persist",
  );
}

// ---------------------------------------------------------------------------
// Section 5 — notifyToolHealthOverrideExpiringSoon (Task #497)
// ---------------------------------------------------------------------------

function makeExpiringSoon(
  overrides: Partial<ToolHealthOverrideExpiringSoonNotification> = {},
): ToolHealthOverrideExpiringSoonNotification {
  return {
    expires_at: new Date("2026-04-25T18:00:00.000Z"),
    previous_updated_by: "alice@example.com",
    overrides: { errorRatePct: 25, p95LatencyMs: 5000 },
    minutes_remaining: 25,
    ...overrides,
  };
}

async function testExpiringSoonSkippedWithoutChannel(): Promise<void> {
  console.log(
    "\nnotifyToolHealthOverrideExpiringSoon — skipped when no Slack channel",
  );
  clearEnv();
  _resetOverrideExpirySoonWarningsForTests();

  let slackCalls = 0;
  const result = await notifyToolHealthOverrideExpiringSoon(
    makeExpiringSoon({ expires_at: new Date("2026-04-25T19:00:00.000Z") }),
    {
      sendSlack: async () => {
        slackCalls++;
        return true;
      },
    },
  );

  assertEqual(result.skipped, true, "result.skipped is true");
  assertEqual(result.slackSent, false, "no Slack send recorded");
  assertEqual(result.deduped, false, "deduped stays false");
  assertEqual(slackCalls, 0, "sendSlack was not invoked");
}

async function testExpiringSoonSlackOnSuccess(): Promise<void> {
  console.log(
    "\nnotifyToolHealthOverrideExpiringSoon — slackSent on success",
  );
  clearEnv();
  _resetOverrideExpirySoonWarningsForTests();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_APP_URL = "https://wala.example.com";

  type SlackArgs = { channel: string; text: string; blocks: any[] };
  const slackCalls: SlackArgs[] = [];

  const result = await notifyToolHealthOverrideExpiringSoon(makeExpiringSoon(), {
    sendSlack: async (channel, text, blocks) => {
      slackCalls.push({ channel, text, blocks: blocks as any[] });
      return true;
    },
  });

  assertEqual(result.slackSent, true, "result.slackSent is true");
  assertEqual(result.skipped, false, "not skipped — channel was configured");
  assertEqual(result.deduped, false, "not deduped on first call");
  assertEqual(slackCalls.length, 1, "Slack invoked exactly once");
  assertEqual(slackCalls[0].channel, "C-ONCALL", "posted to configured channel");
  assert(
    slackCalls[0].text.includes("alice@example.com") &&
      slackCalls[0].text.includes("~25 min"),
    "fallback text mentions operator and minutes-remaining",
  );

  const blocks = slackCalls[0].blocks;
  assertEqual(blocks[0]?.type, "header", "first block is the header");
  assert(
    typeof blocks[0]?.text?.text === "string" &&
      blocks[0].text.text.includes("expiring soon"),
    "header announces the impending expiry",
  );
  // Active override fields appear in a section block, with their prior values.
  const allSectionText = blocks
    .filter((b: any) => b?.type === "section")
    .map((b: any) => b?.text?.text ?? "")
    .join("\n");
  assert(
    allSectionText.includes("error-rate breach floor (%)") &&
      allSectionText.includes("(was 25)"),
    "section lists the active error-rate override and its value",
  );
  // Absolute APP_URL ⇒ Open Alert Thresholds button (deep-linked).
  const hasButton = blocks.some(
    (b: any) =>
      b?.type === "actions" &&
      Array.isArray(b.elements) &&
      b.elements.some(
        (e: any) =>
          e?.url === "https://wala.example.com/dashboard?tab=thresholds",
      ),
  );
  assert(hasButton, "absolute APP_URL renders an Open Alert Thresholds button");
  // Context block embeds the expires_at ISO for traceability.
  const contextText = blocks
    .filter((b: any) => b?.type === "context")
    .flatMap((b: any) => b.elements ?? [])
    .map((e: any) => e?.text ?? "")
    .join(" ");
  assert(
    contextText.includes("2026-04-25T18:00:00.000Z"),
    "context block carries the expires_at ISO",
  );
}

async function testExpiringSoonDedupedOnSecondCall(): Promise<void> {
  console.log(
    "\nnotifyToolHealthOverrideExpiringSoon — deduped on a second call with the same expires_at",
  );
  clearEnv();
  _resetOverrideExpirySoonWarningsForTests();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";

  const sameExpiry = new Date("2026-04-26T08:00:00.000Z");
  let slackCalls = 0;
  const sendSlack = async () => {
    slackCalls++;
    return true;
  };

  const first = await notifyToolHealthOverrideExpiringSoon(
    makeExpiringSoon({ expires_at: sameExpiry }),
    { sendSlack },
  );
  assertEqual(first.slackSent, true, "first call: Slack send recorded");
  assertEqual(first.deduped, false, "first call: not deduped");
  assertEqual(slackCalls, 1, "Slack invoked exactly once after first call");

  // Second call with the SAME expires_at must short-circuit before sendSlack.
  const second = await notifyToolHealthOverrideExpiringSoon(
    makeExpiringSoon({ expires_at: sameExpiry, minutes_remaining: 5 }),
    { sendSlack },
  );
  assertEqual(second.deduped, true, "second call (same expires_at): deduped=true");
  assertEqual(second.slackSent, false, "second call: no Slack send");
  assertEqual(second.skipped, false, "second call: skipped stays false");
  assertEqual(slackCalls, 1, "Slack still invoked exactly once total");

  // Sanity check: a DIFFERENT expires_at gets through.
  const otherExpiry = new Date("2026-04-26T09:00:00.000Z");
  const third = await notifyToolHealthOverrideExpiringSoon(
    makeExpiringSoon({ expires_at: otherExpiry }),
    { sendSlack },
  );
  assertEqual(third.slackSent, true, "different expires_at: Slack send recorded");
  assertEqual(third.deduped, false, "different expires_at: not deduped");
  assertEqual(slackCalls, 2, "Slack invoked twice total after distinct expiry");
}

async function testExpiringSoonDedupePersistsWhenSlackThrows(): Promise<void> {
  console.log(
    "\nnotifyToolHealthOverrideExpiringSoon — dedupe persists even if Slack throws",
  );
  clearEnv();
  _resetOverrideExpirySoonWarningsForTests();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";

  const sameExpiry = new Date("2026-04-27T10:00:00.000Z");
  let slackCalls = 0;
  // Suppress the expected "Slack send threw" error log so the test output
  // stays readable; any other error path will still surface.
  const originalError = console.error;
  console.error = () => {};
  try {
    // First call: Slack throws — but the dedupe key is added BEFORE the send,
    // so a subsequent call must still short-circuit.
    const first = await notifyToolHealthOverrideExpiringSoon(
      makeExpiringSoon({ expires_at: sameExpiry }),
      {
        sendSlack: async () => {
          slackCalls++;
          throw new Error("simulated Slack 5xx");
        },
      },
    );
    assertEqual(
      first.slackSent,
      false,
      "first call: slackSent=false (send threw)",
    );
    assertEqual(first.deduped, false, "first call: not deduped");
    assertEqual(first.skipped, false, "first call: not skipped");
    assertEqual(slackCalls, 1, "Slack invoked exactly once before throwing");

    // Second call with the SAME expires_at: dedupe must short-circuit even
    // though the previous send failed. This is the contract the comment in
    // the implementation calls out — failing to record dedupe on throw would
    // turn a transient Slack outage into a flood on every cron tick.
    const second = await notifyToolHealthOverrideExpiringSoon(
      makeExpiringSoon({ expires_at: sameExpiry }),
      {
        sendSlack: async () => {
          slackCalls++;
          return true;
        },
      },
    );
    assertEqual(
      second.deduped,
      true,
      "second call after throw: deduped=true (no retry flood)",
    );
    assertEqual(second.slackSent, false, "second call: no Slack send");
    assertEqual(slackCalls, 1, "Slack still invoked exactly once total");
  } finally {
    console.error = originalError;
  }
}

// ---------------------------------------------------------------------------
// Section 6 — notifyToolHealthRecovery (Task #497)
// ---------------------------------------------------------------------------

function makeRecovery(
  overrides: Partial<ToolHealthRecoveryNotification> = {},
): ToolHealthRecoveryNotification {
  return {
    tool_name: "search_web",
    agent_name: "research-agent",
    reason: "error_rate",
    alert_id: 99,
    detail: "error_rate fell to 2.0% (threshold 10%); auto-resolved",
    ...overrides,
  };
}

async function testRecoverySkippedWithoutTransport(): Promise<void> {
  console.log(
    "\nnotifyToolHealthRecovery — skipped when no Slack channel and no email recipients",
  );
  clearEnv();

  let slackCalls = 0;
  let emailCalls = 0;
  const result = await notifyToolHealthRecovery(makeRecovery(), {
    sendSlack: async () => {
      slackCalls++;
      return true;
    },
    sendEmail: async () => {
      emailCalls++;
      return { success: true };
    },
  });

  assertEqual(result.skipped, true, "result.skipped is true");
  assertEqual(result.slackSent, false, "no Slack send recorded");
  assertEqual(result.emailSent, false, "no email send recorded");
  assertEqual(slackCalls, 0, "sendSlack was not invoked");
  assertEqual(emailCalls, 0, "sendEmail was not invoked");
}

async function testRecoverySlackAndEmailOnSuccess(): Promise<void> {
  console.log(
    "\nnotifyToolHealthRecovery — slackSent + emailSent on success",
  );
  clearEnv();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_ALERT_EMAIL = "oncall@example.com";
  process.env.TOOL_HEALTH_APP_URL = "https://wala.example.com";

  type SlackArgs = { channel: string; text: string; blocks: any[] };
  const slackCalls: SlackArgs[] = [];
  type EmailArgs = { to: string | string[]; subject: string; html?: string; text?: string };
  const emailCalls: EmailArgs[] = [];

  const result = await notifyToolHealthRecovery(makeRecovery(), {
    sendSlack: async (channel, text, blocks) => {
      slackCalls.push({ channel, text, blocks: blocks as any[] });
      return true;
    },
    sendEmail: async (opts) => {
      emailCalls.push(opts as EmailArgs);
      return { success: true, id: "msg-rec-1" };
    },
  });

  assertEqual(result.slackSent, true, "result.slackSent is true");
  assertEqual(result.emailSent, true, "result.emailSent is true");
  assertEqual(result.skipped, false, "not skipped");

  // Slack body sanity.
  assertEqual(slackCalls.length, 1, "sendSlack called exactly once");
  assertEqual(slackCalls[0].channel, "C-ONCALL", "Slack posted to configured channel");
  assert(
    slackCalls[0].text.includes("recovered") &&
      slackCalls[0].text.includes("search_web") &&
      slackCalls[0].text.includes("alert #99"),
    "fallback text announces recovery, tool, and alert id",
  );
  const blocks = slackCalls[0].blocks;
  assertEqual(blocks[0]?.type, "header", "first block is the header");
  assert(
    typeof blocks[0]?.text?.text === "string" &&
      blocks[0].text.text.includes("Tool health recovered: search_web"),
    "header announces the recovery and tool",
  );
  const hasButton = blocks.some(
    (b: any) =>
      b?.type === "actions" &&
      Array.isArray(b.elements) &&
      b.elements.some(
        (e: any) => e?.url === "https://wala.example.com/dashboard",
      ),
  );
  assert(hasButton, "absolute APP_URL renders an Open AI Operations panel button");
  const contextText = blocks
    .filter((b: any) => b?.type === "context")
    .flatMap((b: any) => b.elements ?? [])
    .map((e: any) => e?.text ?? "")
    .join(" ");
  assert(
    contextText.includes("alert #99"),
    "context block carries the resolved alert id",
  );

  // Email body sanity.
  assertEqual(emailCalls.length, 1, "sendEmail called exactly once");
  assertDeepEqual(
    emailCalls[0].to,
    ["oncall@example.com"],
    "TOOL_HEALTH_ALERT_EMAIL is split into a recipient array",
  );
  assert(
    emailCalls[0].subject.startsWith("[Tool Health · RECOVERED] "),
    "subject prefixes [Tool Health · RECOVERED]",
  );
  assert(
    emailCalls[0].subject.includes("search_web") &&
      emailCalls[0].subject.includes("alert #99"),
    "subject mentions tool name and alert id",
  );
  assert(
    typeof emailCalls[0].html === "string" &&
      emailCalls[0].html.includes("search_web") &&
      emailCalls[0].html.includes(
        "https://wala.example.com/dashboard",
      ),
    "HTML body includes tool name and absolute panel link",
  );
  assert(
    typeof emailCalls[0].text === "string" &&
      emailCalls[0].text.includes("search_web") &&
      emailCalls[0].text.includes("Alert closed: #99"),
    "plain-text body includes tool name and alert id",
  );
}

async function testRecoveryNotThrottledByBreachMap(): Promise<void> {
  console.log(
    "\nnotifyToolHealthRecovery — recovery is NOT throttled by the breach map",
  );
  clearEnv();
  _resetToolHealthNotifierThrottleForTests();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_NOTIFY_THROTTLE_MIN = "60";

  // Step 1: send a breach for `search_web:error_rate` so the in-process
  // throttle map records that key. Recovery for the SAME key must still
  // fire — recovery and breach are independent events.
  const fixedNow = 1_700_000_500_000;
  let breachSlackCalls = 0;
  const breachResult = await notifyToolHealthBreach(
    makeBreach({
      tool_name: "search_web",
      reason: "error_rate",
      related_record_id: "search_web:error_rate",
    }),
    {
      sendSlack: async () => {
        breachSlackCalls++;
        return true;
      },
      sendEmail: async () => ({ success: true }),
      claimDb: async () => true,
      now: () => fixedNow,
    },
  );
  assertEqual(breachResult.slackSent, true, "setup: breach Slack send recorded");
  assertEqual(breachSlackCalls, 1, "setup: breach Slack invoked exactly once");

  // Step 2: a second BREACH for the same key would be throttled — verify
  // that the breach map is in fact populated for the key we care about.
  const sanity = await notifyToolHealthBreach(
    makeBreach({
      tool_name: "search_web",
      reason: "error_rate",
      related_record_id: "search_web:error_rate",
    }),
    {
      sendSlack: async () => true,
      sendEmail: async () => ({ success: true }),
      claimDb: async () => true,
      now: () => fixedNow + 60_000, // +1 min, well within window
    },
  );
  assertEqual(
    sanity.throttled,
    true,
    "sanity: a sibling breach for the same key IS throttled (map is populated)",
  );

  // Step 3: recovery for the SAME tool/reason must NOT be throttled.
  let recoverySlackCalls = 0;
  let recoveryEmailCalls = 0;
  const recovery = await notifyToolHealthRecovery(
    makeRecovery({
      tool_name: "search_web",
      reason: "error_rate",
      alert_id: 1234,
    }),
    {
      sendSlack: async () => {
        recoverySlackCalls++;
        return true;
      },
      sendEmail: async () => {
        recoveryEmailCalls++;
        return { success: true };
      },
    },
  );

  assertEqual(
    recovery.slackSent,
    true,
    "recovery sends despite breach throttle map holding the same key",
  );
  assertEqual(recovery.skipped, false, "recovery is not skipped");
  assertEqual(
    recoverySlackCalls,
    1,
    "recovery invoked sendSlack exactly once (no throttle short-circuit)",
  );
  assertEqual(
    recoveryEmailCalls,
    0,
    "no email send (TOOL_HEALTH_ALERT_EMAIL not set)",
  );

  // And a second back-to-back recovery is also not throttled — recovery has
  // no per-key throttle of its own.
  const recovery2 = await notifyToolHealthRecovery(
    makeRecovery({
      tool_name: "search_web",
      reason: "error_rate",
      alert_id: 1235,
    }),
    {
      sendSlack: async () => {
        recoverySlackCalls++;
        return true;
      },
    },
  );
  assertEqual(recovery2.slackSent, true, "second recovery also sends");
  assertEqual(
    recoverySlackCalls,
    2,
    "recovery sendSlack invoked exactly twice across the two calls",
  );
}

async function testRecoverySlackAndEmailFailIndependently(): Promise<void> {
  console.log(
    "\nnotifyToolHealthRecovery — sendSlack throws and sendEmail rejects independently",
  );
  clearEnv();
  process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-ONCALL";
  process.env.TOOL_HEALTH_ALERT_EMAIL = "oncall@example.com";

  let slackCalls = 0;
  let emailCalls = 0;
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await notifyToolHealthRecovery(makeRecovery(), {
      sendSlack: async () => {
        slackCalls++;
        throw new Error("simulated Slack 5xx");
      },
      // sendEmail rejected — surfaced as { success: false } rather than
      // a throw to mirror the Resend SDK's rejected-message branch.
      sendEmail: async () => {
        emailCalls++;
        return { success: false, error: "Resend rejected: domain not verified" };
      },
    });

    // Critical contract: the two channels are independent. A Slack outage
    // must not block the email attempt, and a rejected email must not
    // mask the Slack outcome on the result object.
    assertEqual(result.slackSent, false, "result.slackSent is false on Slack throw");
    assertEqual(result.emailSent, false, "result.emailSent is false on Resend rejection");
    assertEqual(result.skipped, false, "not skipped — both transports configured");
    assertEqual(slackCalls, 1, "sendSlack was invoked exactly once before throwing");
    assertEqual(emailCalls, 1, "sendEmail was still invoked despite Slack throw");
  } finally {
    console.error = originalError;
  }
}

async function testRecoveryEmailThrowsDoesNotPropagate(): Promise<void> {
  console.log(
    "\nnotifyToolHealthRecovery — sendEmail throws ⇒ emailSent=false, no throw escapes",
  );
  clearEnv();
  process.env.TOOL_HEALTH_ALERT_EMAIL = "oncall@example.com";

  let emailCalls = 0;
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await notifyToolHealthRecovery(makeRecovery(), {
      sendSlack: async () => false,
      sendEmail: async () => {
        emailCalls++;
        throw new Error("simulated Resend network failure");
      },
    });
    // Symmetric to the breach-side path: a thrown sendEmail must surface
    // on the result rather than escape to the caller (the auto-resolve
    // sweep would otherwise crash mid-pass).
    assertEqual(result.emailSent, false, "result.emailSent is false on throw");
    assertEqual(result.slackSent, false, "Slack stays false (no channel configured)");
    assertEqual(result.skipped, false, "not skipped — email recipients configured");
    assertEqual(emailCalls, 1, "sendEmail was invoked exactly once before throwing");
  } finally {
    console.error = originalError;
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await testSkippedWhenNothingConfigured();
    await testSlackSentOnSuccess();
    await testEmailSentOnSuccess();
    await testThrottledWithinWindow();
    await testThrottleResetsAfterWindow();
    await testBreachSlackThrowsDoesNotPropagate();
    await testBreachEmailRejectedKeepsEmailSentFalse();
    await testBreachEmailThrowsDoesNotPropagate();
    await testBreachClaimDbThrowsFallsThroughToSend();
    await testBreachRecordResultThrowsAfterSlackSuccess();
    await testBreachRecordResultThrowsOnSkippedPath();
    await testBreachRecordResultThrowsOnThrottledPath();
    await testBreachRecordResultThrowsOnFailedPath();
    await testBreachRecordResultChannelLabelPerTerminalState();
    await testOverrideExpiredSlackPost();
    await testOverrideExpiredSlackThrowsDoesNotPropagate();
    await testOverrideExpiredSkippedWithoutChannel();
    testDiffNoChanges();
    testDiffValueChange();
    testDiffSetAndClear();
    testDiffOrderIsCanonical();
    await testConfigChangeDisabledWhenEnvNotSet();
    await testConfigChangeSkippedWithoutTransport();
    await testConfigChangeNoChanges();
    await testConfigChangeSlackAndEmailOnSuccess();
    await testConfigChangeSlackAndEmailFailIndependently();
    await testConfigChangeAuditThrowsStillSendsSlack();
    await testConfigChangeRendersImpactSection();
    await testConfigChangeOmitsImpactSectionWhenNull();
    await testConfigChangeOmitsImpactSectionWhenEmpty();
    await testConfigChangeFirstPostSavesRootThreadTs();
    await testConfigChangeSecondPostThreadsUnderRoot();
    await testConfigChangeSetThreadTsThrowsDoesNotPropagate();
    await testConfigChangeGetThreadTsThrowsFallsBackToRoot();
    await testConfigChangeLegacySendSlackSkipsThreading();
    await testExpiringSoonSkippedWithoutChannel();
    await testExpiringSoonSlackOnSuccess();
    await testExpiringSoonDedupedOnSecondCall();
    await testExpiringSoonDedupePersistsWhenSlackThrows();
    await testRecoverySkippedWithoutTransport();
    await testRecoverySlackAndEmailOnSuccess();
    await testRecoveryNotThrottledByBreachMap();
    await testRecoverySlackAndEmailFailIndependently();
    await testRecoveryEmailThrowsDoesNotPropagate();
  } finally {
    restoreEnv();
    _resetToolHealthNotifierThrottleForTests();
    _resetOverrideExpirySoonWarningsForTests();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await main();
