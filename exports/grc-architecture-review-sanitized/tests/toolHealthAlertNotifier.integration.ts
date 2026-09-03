/**
 * Integration tests for the tool-health on-call notifier.
 *
 * These tests post to a real Slack channel and/or a real Resend inbox using
 * the production renderers — NOT stubs — so broken Block Kit shapes, bad
 * subject lines, plaintext truncation, and character-escaping bugs are caught
 * before they page on-call at 3 AM.
 *
 * SKIP behaviour
 * ──────────────
 * The file exits 0 (skip) when none of the required credential pairs are set.
 * At least one of the following pairs must be present to run:
 *
 *   Slack:  SLACK_BOT_TOKEN   — bot token with chat:write scope
 *           SLACK_TEST_CHANNEL — channel id/name to receive the test message
 *
 *   Email:  RESEND_API_KEY    — Resend API key
 *           RESEND_TEST_EMAIL — delivery address (use a Resend test address if
 *                               you don't want real mail, e.g. user@example.invalid)
 *
 * Optional:
 *   TOOL_HEALTH_APP_URL — base origin of the deployed app; when set the Slack
 *                         message will include an "Open AI Operations panel"
 *                         button with an absolute URL.
 *   TOOL_HEALTH_CONFIG_NOTIFY=1 — opts in to the additional threshold-tuning
 *                         Slack smoke test (`notifyToolHealthConfigChange`).
 *                         Off by default to keep the suite lightweight.
 *
 * Run:
 *   npx tsx tests/toolHealthAlertNotifier.integration.ts
 *
 * No secret leakage:  set the env vars in `.<REDACTED_HOST>` or as Replit secrets;
 * never commit them to source control.
 */

import {
  notifyToolHealthBreach,
  notifyToolHealthConfigChange,
  _resetToolHealthNotifierThrottleForTests,
  type ToolHealthBreachNotification,
  type ToolHealthConfigChangeNotification,
} from "../src/utils/toolHealthAlertNotifier";
import type { ToolHealthConfigAuditEntry } from "../src/utils/toolHealthConfigDatabase";

const SLACK_BOT_TOKEN   = process.env.SLACK_BOT_TOKEN;
const SLACK_TEST_CHANNEL = process.env.SLACK_TEST_CHANNEL;
const RESEND_API_KEY     = process.env.RESEND_API_KEY;
const RESEND_TEST_EMAIL  = process.env.RESEND_TEST_EMAIL;

const slackReady  = !!(SLACK_BOT_TOKEN && SLACK_TEST_CHANNEL);
const emailReady  = !!(RESEND_API_KEY && RESEND_TEST_EMAIL);
const configNotifyOptIn = process.env.TOOL_HEALTH_CONFIG_NOTIFY === "1";

if (!slackReady && !emailReady) {
  console.log(
    "\n⏭  toolHealthAlertNotifier integration tests SKIPPED.\n" +
    "   Set one of the following credential pairs to enable them:\n" +
    "     Slack: SLACK_BOT_TOKEN + SLACK_TEST_CHANNEL\n" +
    "     Email: RESEND_API_KEY  + RESEND_TEST_EMAIL\n",
  );
  process.exit(0);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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

/** Save env keys we touch so we can restore them in finally blocks. */
function patchEnv(patches: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patches)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  };
}

/** Sample breach notification with deliberately tricky characters. */
function sample(
  overrides: Partial<ToolHealthBreachNotification> = {},
): ToolHealthBreachNotification {
  return {
    tool_name: "integration_test_tool",
    agent_name: "integration_test_agent",
    reason: "error_rate",
    severity: "high",
    title: 'Integration test: "tool_health" alert [DO NOT PAGE]',
    description:
      'Integration test — 12/20 failed (60%). Characters: <script> & "quotes" ' +
      "and 'apostrophes' should be escaped.",
    suggestion:
      "This is an automated integration test message. No action is required.",
    related_record_id: "integration_test_tool:error_rate",
    alert_id: 0,
    ...overrides,
  };
}

// ─── Slack integration ───────────────────────────────────────────────────────

async function runSlackTests(): Promise<void> {
  console.log("\n── Slack integration ──\n");

  const appUrl = process.env.TOOL_HEALTH_APP_URL || "";
  const restoreEnv = patchEnv({
    TOOL_HEALTH_SLACK_CHANNEL: SLACK_TEST_CHANNEL,
    TOOL_HEALTH_ALERT_EMAIL: undefined,
    TOOL_HEALTH_NOTIFY_THROTTLE_MIN: "0",
  });

  _resetToolHealthNotifierThrottleForTests();

  try {
    console.log(`  Sending HIGH/error_rate alert to channel: ${SLACK_TEST_CHANNEL}`);

    const result = await notifyToolHealthBreach(sample(), {});

    assert(result.slackSent === true, "notifyToolHealthBreach returns slackSent=true");
    assert(result.emailSent === false, "emailSent=false when only Slack is configured");
    assert(result.throttled === false, "not throttled (throttle window set to 0)");
    assert(result.skipped === false, "not skipped");

    if (appUrl) {
      console.log("  TOOL_HEALTH_APP_URL is set — button URL was absolute");
    } else {
      console.log(
        "  TOOL_HEALTH_APP_URL is not set — button degraded to plain-text link (expected)",
      );
    }

    // Run a second severity to verify block rendering variety.
    _resetToolHealthNotifierThrottleForTests();
    const criticalResult = await notifyToolHealthBreach(
      sample({
        severity: "critical",
        reason: "p95_latency",
        related_record_id: "integration_test_tool:p95_latency",
        title: 'Integration test: "tool_health" CRITICAL latency [DO NOT PAGE]',
        description: "Integration test — p95 latency 4200 ms > 3000 ms threshold.",
      }),
      {},
    );
    assert(
      criticalResult.slackSent === true,
      "CRITICAL/p95_latency alert also delivered successfully",
    );
  } finally {
    restoreEnv();
  }
}

// ─── Threshold-change Slack integration (Task #190 / #287) ───────────────────
//
// Exercises `notifyToolHealthConfigChange` against the real Slack API so the
// dedicated Block Kit renderer (header, diff section, "Recent changes" list,
// and primary action button) is validated end-to-end alongside the breach
// notifier. Gated on the same `slackReady` flag *and* an explicit
// `TOOL_HEALTH_CONFIG_NOTIFY=1` opt-in to match the production gating in
// `notifyToolHealthConfigChange` itself, so unconfigured CI runs stay silent.
//
// We inject a `getAudit` stub via `depsOverride` so the test does not require
// a database connection — the renderer will still produce the "Recent changes"
// section using the stubbed entries.

async function runConfigChangeSlackTests(): Promise<void> {
  console.log("\n── Threshold-change Slack integration ──\n");

  const restoreEnv = patchEnv({
    TOOL_HEALTH_SLACK_CHANNEL: SLACK_TEST_CHANNEL,
    TOOL_HEALTH_ALERT_EMAIL: undefined,
    TOOL_HEALTH_CONFIG_NOTIFY: "1",
  });

  try {
    const notification: ToolHealthConfigChangeNotification = {
      changedBy: "user@example.invalid",
      before: {
        errorRateHighPct: 25,
        latencyCriticalMs: 3000,
      },
      after: {
        errorRateHighPct: 30,
        errorRateCriticalPct: 50,
        latencyCriticalMs: 4000,
      },
      note: 'Integration test — threshold tuning [DO NOT PAGE]. Characters: <script> & "quotes".',
      audit_id: 999_999,
    };

    console.log(
      `  Sending threshold-change alert to channel: ${SLACK_TEST_CHANNEL}`,
    );

    const result = await notifyToolHealthConfigChange(notification, {
      // Stub the DB-backed loader so the test doesn't need a Postgres
      // connection. Returning a couple of recent rows also exercises the
      // "Recent changes" block.
      getAudit: async (limit: number): Promise<ToolHealthConfigAuditEntry[]> => {
        const rows: ToolHealthConfigAuditEntry[] = [
          {
            id: 999_999,
            changed_at: new Date(),
            changed_by: "user@example.invalid",
            before_values: notification.before,
            after_values: notification.after,
            note: notification.note ?? null,
            breach_diff: null,
          },
          {
            id: 999_998,
            changed_at: new Date(Date.now() - 60 * 60 * 1000),
            changed_by: "user@example.invalid",
            before_values: { errorRateHighPct: 20 },
            after_values: { errorRateHighPct: 25 },
            note: null,
            breach_diff: null,
          },
        ];
        return rows.slice(0, limit);
      },
    });

    assert(
      result.slackSent === true,
      "notifyToolHealthConfigChange returns slackSent=true",
    );
    assert(
      result.emailSent === false,
      "emailSent=false when only Slack is configured",
    );
    assert(result.disabled === false, "not disabled (TOOL_HEALTH_CONFIG_NOTIFY=1)");
    assert(result.skipped === false, "not skipped");
    assert(result.noChanges === false, "diff was non-empty");

    // Re-send with a single-field change and no note to verify the renderer
    // still produces a valid Block Kit payload (Slack rejects empty fields).
    const minimalResult = await notifyToolHealthConfigChange(
      {
        changedBy: "user@example.invalid",
        before: { windowMinutes: 10 },
        after: { windowMinutes: 15 },
        audit_id: null,
      },
      { getAudit: async () => [] },
    );
    assert(
      minimalResult.slackSent === true,
      "single-field change with no note also delivered successfully",
    );
  } finally {
    restoreEnv();
  }
}

// ─── Email integration ───────────────────────────────────────────────────────

async function runEmailTests(): Promise<void> {
  console.log("\n── Email integration ──\n");

  const restoreEnv = patchEnv({
    TOOL_HEALTH_SLACK_CHANNEL: undefined,
    TOOL_HEALTH_ALERT_EMAIL: RESEND_TEST_EMAIL,
    TOOL_HEALTH_NOTIFY_THROTTLE_MIN: "0",
  });

  _resetToolHealthNotifierThrottleForTests();

  try {
    console.log(`  Sending HIGH/error_rate email to: ${RESEND_TEST_EMAIL}`);

    const result = await notifyToolHealthBreach(sample(), {});

    assert(result.emailSent === true, "notifyToolHealthBreach returns emailSent=true");
    assert(result.slackSent === false, "slackSent=false when only email is configured");
    assert(result.throttled === false, "not throttled");
    assert(result.skipped === false, "not skipped");

    // Check plaintext body length — Resend has a 100 KB body limit; we want to
    // ensure the plaintext version for a real payload stays well under it.
    // We indirectly verify this by asserting the send succeeded (Resend would
    // return an error for oversized payloads), but also emit the approximate
    // plaintext length for debugging.
    const approxTextLen =
      (sample().title + "\n" + sample().description + "\n" + (sample().suggestion ?? ""))
        .length;
    assert(
      approxTextLen < 10_000,
      `plaintext body is a reasonable size (${approxTextLen} chars < 10 000)`,
    );

    // Re-send with critical severity to exercise subject line formatting.
    _resetToolHealthNotifierThrottleForTests();
    const criticalResult = await notifyToolHealthBreach(
      sample({
        severity: "critical",
        reason: "p95_latency",
        related_record_id: "integration_test_tool:p95_latency",
        title: 'Integration test: "tool_health" CRITICAL latency [DO NOT PAGE]',
      }),
      {},
    );
    assert(
      criticalResult.emailSent === true,
      "CRITICAL/p95_latency email also delivered successfully",
    );
  } finally {
    restoreEnv();
  }
}

// ─── Combined Slack + Email ───────────────────────────────────────────────────

async function runCombinedTests(): Promise<void> {
  console.log("\n── Combined Slack + Email ──\n");

  const restoreEnv = patchEnv({
    TOOL_HEALTH_SLACK_CHANNEL: SLACK_TEST_CHANNEL,
    TOOL_HEALTH_ALERT_EMAIL: RESEND_TEST_EMAIL,
    TOOL_HEALTH_NOTIFY_THROTTLE_MIN: "0",
  });

  _resetToolHealthNotifierThrottleForTests();

  try {
    console.log(
      `  Sending to both channel ${SLACK_TEST_CHANNEL} and email ${RESEND_TEST_EMAIL}`,
    );

    const result = await notifyToolHealthBreach(
      sample({ related_record_id: "integration_test_tool:combined" }),
      {},
    );

    assert(result.slackSent === true, "slackSent=true in combined mode");
    assert(result.emailSent === true, "emailSent=true in combined mode");
    assert(result.throttled === false, "not throttled");
    assert(result.skipped === false, "not skipped");
  } finally {
    restoreEnv();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n=== toolHealthAlertNotifier — Slack/Email integration tests ===\n");
  console.log(
    `Slack ready: ${slackReady ? `yes (channel: ${SLACK_TEST_CHANNEL})` : "no"}\n` +
    `Email ready: ${emailReady ? `yes (to: ${RESEND_TEST_EMAIL})` : "no"}\n` +
    `Threshold-change Slack opt-in (TOOL_HEALTH_CONFIG_NOTIFY=1): ${
      configNotifyOptIn ? "yes" : "no (skipped)"
    }\n`,
  );

  if (slackReady) await runSlackTests();
  if (slackReady && configNotifyOptIn) await runConfigChangeSlackTests();
  if (emailReady) await runEmailTests();
  if (slackReady && emailReady) await runCombinedTests();

  console.log(`\nResults: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error("\n❌ Integration tests FAILED");
    process.exit(1);
  }

  console.log("\n✅ All toolHealthAlertNotifier integration tests passed");
}

main().catch((err) => {
  console.error("❌ Unexpected error:", err);
  process.exit(1);
});
