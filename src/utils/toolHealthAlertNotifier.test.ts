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
  _resetToolHealthNotifierThrottleForTests,
  _diffToolHealthConfigOverridesForTests,
  type ToolHealthBreachNotification,
  type ToolHealthOverrideExpiredNotification,
} from "./toolHealthAlertNotifier";

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
      b.elements.some((e: any) => e?.url === "https://wala.example.com/dashboard/ai-ops.html"),
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
      emailCalls[0].html.includes("https://wala.example.com/dashboard/ai-ops.html"),
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
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await testSkippedWhenNothingConfigured();
    await testSlackSentOnSuccess();
    await testEmailSentOnSuccess();
    await testThrottledWithinWindow();
    await testThrottleResetsAfterWindow();
    await testOverrideExpiredSlackPost();
    await testOverrideExpiredSkippedWithoutChannel();
    testDiffNoChanges();
    testDiffValueChange();
    testDiffSetAndClear();
    testDiffOrderIsCanonical();
  } finally {
    restoreEnv();
    _resetToolHealthNotifierThrottleForTests();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await main();
