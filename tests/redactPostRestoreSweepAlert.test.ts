/**
 * Unit tests for Task #462 — alert operators when a post-restore sweep
 * actually rewrites change-history rows.
 *
 * Verifies `dispatchPostRestoreSweepAlert()` in
 * `src/utils/redactHistoricalLogs.ts`:
 *
 *   1. Stays silent when every monitored counter (event_logs,
 *      nc_change_history, capa_change_history, ai_pending_actions) is
 *      zero — a clean boot must not page on-call.
 *   2. Dispatches via the platform notification hub AND the Slack
 *      webhook when any monitored counter is non-zero.
 *   3. Includes the sweep timestamp and the per-table counts in both
 *      payloads so on-call can immediately tell which surface area was
 *      affected.
 *   4. Treats `ai_pending_actions: { skipped: 'table_missing' }` as a
 *      zero count — a missing table genuinely had no rewrites to alert
 *      on.
 *   5. Trips on `nc_change_history` alone, on `capa_change_history`
 *      alone, on `event_logs` alone, and on `ai_pending_actions` alone
 *      (each surface area wires the alert independently).
 *   6. Skips Slack delivery when SLACK_WEBHOOK_URL is unset (parity with
 *      the ai-cost-summary cron pattern), but still fires the platform
 *      notification.
 *   7. Reports a per-channel `channelsAttempted` / `channelsSucceeded`
 *      breakdown so a Slack outage does not suppress the in-app
 *      notification and vice-versa.
 *   8. Never throws when the notification hub or Slack webhook fails —
 *      the boot path must not crash because the alert pipeline is
 *      degraded.
 *
 * Run:  npx tsx tests/redactPostRestoreSweepAlert.test.ts
 */

import {
  dispatchPostRestoreSweepAlert,
  extractPostRestoreSweepAlertCounts,
  type SweepResult,
} from "../src/utils/redactHistoricalLogs";

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

const SWEEP_TS = "2026-04-25T12:34:56.000Z";

function buildSweepResult(
  overrides: Partial<SweepResult> = {},
): SweepResult {
  const base: SweepResult = {
    sweep_timestamp: SWEEP_TS,
    event_logs_updated: 0,
    nc_change_history_updated: 0,
    nc_change_history_change_reason_updated: 0,
    capa_change_history_updated: 0,
    capa_change_history_change_reason_updated: 0,
    ai_pending_actions: {
      scanned: 0,
      payload_changed: 0,
      payload_preview_changed: 0,
      execution_result_changed: 0,
      rows_updated: 0,
    },
    ai_pending_actions_credential_warnings: {
      scanned: 0,
      rows_updated: 0,
      warnings_added: 0,
    },
    ai_call_metrics: {
      scanned: 0,
      prompt_preview_changed: 0,
      tool_input_preview_changed: 0,
      tool_output_preview_changed: 0,
      rows_updated: 0,
    },
    total_rows_updated: 0,
  };
  return { ...base, ...overrides };
}

interface CapturedNotification {
  args: Record<string, unknown>;
}

interface CapturedFetch {
  url: string;
  init: RequestInit | undefined;
}

interface DispatcherStub {
  notifications: CapturedNotification[];
  fetches: CapturedFetch[];
  fetchResponses: Array<Response | Error>;
  notificationError?: Error;
  warnings: unknown[][];
  errors: unknown[][];
  logs: unknown[][];
  deps: {
    createNotification: (notif: Record<string, unknown>) => Promise<unknown>;
    fetch: typeof fetch;
    env: Record<string, string | undefined>;
    logger: Pick<Console, "log" | "warn" | "error">;
  };
}

function buildStub(
  options: {
    slackUrl?: string;
    notificationError?: Error;
    fetchResponses?: Array<Response | Error>;
  } = {},
): DispatcherStub {
  const stub: DispatcherStub = {
    notifications: [],
    fetches: [],
    fetchResponses: options.fetchResponses ?? [],
    notificationError: options.notificationError,
    warnings: [],
    errors: [],
    logs: [],
    deps: {
      async createNotification(notif: Record<string, unknown>) {
        if (stub.notificationError) throw stub.notificationError;
        stub.notifications.push({ args: notif });
        return { id: 1, ...notif };
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        stub.fetches.push({ url: String(input), init });
        const next = stub.fetchResponses.shift();
        if (next instanceof Error) throw next;
        if (next) return next;
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
      env: {
        ...(options.slackUrl
          ? { SLACK_WEBHOOK_URL: options.slackUrl }
          : {}),
      },
      logger: {
        log: (...a: unknown[]) => {
          stub.logs.push(a);
        },
        warn: (...a: unknown[]) => {
          stub.warnings.push(a);
        },
        error: (...a: unknown[]) => {
          stub.errors.push(a);
        },
      },
    },
  };
  return stub;
}

async function run(): Promise<void> {
  console.log("\nextractPostRestoreSweepAlertCounts");
  {
    const counts = extractPostRestoreSweepAlertCounts(
      buildSweepResult({
        event_logs_updated: 1,
        nc_change_history_updated: 2,
        capa_change_history_updated: 3,
        ai_pending_actions: {
          scanned: 10,
          payload_changed: 4,
          payload_preview_changed: 0,
          execution_result_changed: 0,
          rows_updated: 4,
        },
      }),
    );
    assert(counts.event_logs === 1, "event_logs count surfaced");
    assert(counts.nc_change_history === 2, "nc_change_history count surfaced");
    assert(
      counts.capa_change_history === 3,
      "capa_change_history count surfaced",
    );
    assert(
      counts.ai_pending_actions === 4,
      "ai_pending_actions rows_updated surfaced",
    );
  }

  {
    const counts = extractPostRestoreSweepAlertCounts(
      buildSweepResult({
        ai_pending_actions: { skipped: "table_missing" },
      }),
    );
    assert(
      counts.ai_pending_actions === 0,
      "ai_pending_actions skipped → 0 (no rewrites to alert on)",
    );
  }

  console.log("\nClean sweep — all zeros");
  {
    const stub = buildStub({ slackUrl: "https://hooks.example/123" });
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult(),
      stub.deps,
    );
    assert(outcome.dispatched === false, "outcome.dispatched=false on all-zero");
    assert(
      outcome.skippedReason === "all_counts_zero",
      "outcome.skippedReason='all_counts_zero'",
    );
    assert(
      stub.notifications.length === 0,
      "no platform notification on clean sweep",
    );
    assert(
      stub.fetches.length === 0,
      "no Slack POST on clean sweep (silent boot)",
    );
    assert(
      outcome.channelsAttempted.length === 0,
      "no channels attempted on clean sweep",
    );
  }

  console.log("\nNon-zero sweep — both channels fire");
  {
    const stub = buildStub({ slackUrl: "https://hooks.example/abc" });
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({
        event_logs_updated: 5,
        nc_change_history_updated: 7,
        capa_change_history_updated: 11,
        ai_pending_actions: {
          scanned: 30,
          payload_changed: 2,
          payload_preview_changed: 1,
          execution_result_changed: 0,
          rows_updated: 2,
        },
      }),
      stub.deps,
    );
    assert(outcome.dispatched === true, "outcome.dispatched=true");
    assert(stub.notifications.length === 1, "platform notification dispatched");
    assert(stub.fetches.length === 1, "Slack webhook POST dispatched");
    assert(
      outcome.channelsAttempted.includes("platform_notification"),
      "platform_notification attempted",
    );
    assert(
      outcome.channelsAttempted.includes("slack_webhook"),
      "slack_webhook attempted",
    );
    assert(
      outcome.channelsSucceeded.includes("platform_notification"),
      "platform_notification succeeded",
    );
    assert(
      outcome.channelsSucceeded.includes("slack_webhook"),
      "slack_webhook succeeded",
    );

    const notif = stub.notifications[0].args;
    assert(
      notif.module === "security/redaction-sweep",
      "notification module=security/redaction-sweep",
    );
    assert(
      notif.priority === "critical",
      "notification priority=critical (paging-worthy)",
    );
    assert(
      typeof notif.title === "string" &&
        (notif.title as string).toLowerCase().includes("post-restore"),
      "notification title mentions post-restore",
    );
    const body = String(notif.message ?? "");
    assert(body.includes(SWEEP_TS), "notification includes sweep timestamp");
    assert(
      body.includes("event_logs=5") &&
        body.includes("nc_change_history=7") &&
        body.includes("capa_change_history=11") &&
        body.includes("ai_pending_actions=2"),
      "notification message embeds per-table counts",
    );

    const slackCall = stub.fetches[0];
    assert(
      slackCall.url === "https://hooks.example/abc",
      "Slack POST hits configured SLACK_WEBHOOK_URL",
    );
    assert(slackCall.init?.method === "POST", "Slack POST uses HTTP POST");
    const slackHeaders = (slackCall.init?.headers ?? {}) as Record<
      string,
      string
    >;
    assert(
      slackHeaders["Content-Type"] === "application/json",
      "Slack POST sets Content-Type=application/json",
    );
    const slackBody = JSON.parse(String(slackCall.init?.body ?? "{}"));
    assert(
      typeof slackBody.text === "string" && slackBody.text.includes(SWEEP_TS),
      "Slack body includes sweep timestamp",
    );
    assert(
      slackBody.text.includes("nc_change_history=7") &&
        slackBody.text.includes("capa_change_history=11"),
      "Slack body includes nc/capa change-history counts",
    );
  }

  console.log("\nIndividual surface area triggers");
  for (const surface of [
    "event_logs_updated",
    "nc_change_history_updated",
    "capa_change_history_updated",
  ] as const) {
    const stub = buildStub({ slackUrl: "https://hooks.example/x" });
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({ [surface]: 1 } as Partial<SweepResult>),
      stub.deps,
    );
    assert(outcome.dispatched === true, `${surface}>0 alone fires the alert`);
    assert(stub.notifications.length === 1, `${surface}>0 sends notification`);
    assert(stub.fetches.length === 1, `${surface}>0 sends Slack POST`);
  }

  {
    const stub = buildStub({ slackUrl: "https://hooks.example/x" });
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({
        ai_pending_actions: {
          scanned: 1,
          payload_changed: 0,
          payload_preview_changed: 0,
          execution_result_changed: 0,
          rows_updated: 1,
        },
      }),
      stub.deps,
    );
    assert(
      outcome.dispatched === true,
      "ai_pending_actions.rows_updated>0 fires the alert",
    );
  }

  console.log("\nSkipped ai_pending_actions does NOT trigger by itself");
  {
    const stub = buildStub({ slackUrl: "https://hooks.example/x" });
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({
        ai_pending_actions: { skipped: "table_missing" },
      }),
      stub.deps,
    );
    assert(
      outcome.dispatched === false,
      "skipped ai_pending_actions + zeros elsewhere stays silent",
    );
  }

  console.log("\nSlack webhook unset — platform notification still fires");
  {
    const stub = buildStub();
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({ nc_change_history_updated: 1 }),
      stub.deps,
    );
    assert(outcome.dispatched === true, "alert still dispatched");
    assert(
      stub.notifications.length === 1,
      "platform notification fired without SLACK_WEBHOOK_URL",
    );
    assert(stub.fetches.length === 0, "no Slack POST without webhook URL");
    assert(
      outcome.channelsAttempted.includes("platform_notification"),
      "only platform_notification attempted",
    );
    assert(
      !outcome.channelsAttempted.includes("slack_webhook"),
      "slack_webhook NOT attempted when URL missing",
    );
  }

  console.log("\nNotification failure — Slack still fires, no throw");
  {
    const stub = buildStub({
      slackUrl: "https://hooks.example/x",
      notificationError: new Error("hub down"),
    });
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({ capa_change_history_updated: 4 }),
      stub.deps,
    );
    assert(outcome.dispatched === true, "outcome still reports dispatched");
    assert(
      outcome.channelsSucceeded.includes("slack_webhook"),
      "slack_webhook still succeeded",
    );
    assert(
      !outcome.channelsSucceeded.includes("platform_notification"),
      "platform_notification absent from succeeded list",
    );
    assert(
      stub.warnings.some((w) =>
        String(w[0] ?? "").includes("platform notification failed"),
      ),
      "notification failure logged as warning",
    );
    assert(stub.fetches.length === 1, "Slack POST still issued");
  }

  console.log("\nSlack failure — platform notification still recorded");
  {
    const stub = buildStub({
      slackUrl: "https://hooks.example/x",
      fetchResponses: [new Error("network down")],
    });
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({ event_logs_updated: 9 }),
      stub.deps,
    );
    assert(outcome.dispatched === true, "outcome dispatched");
    assert(
      outcome.channelsSucceeded.includes("platform_notification"),
      "platform_notification still succeeded",
    );
    assert(
      !outcome.channelsSucceeded.includes("slack_webhook"),
      "slack_webhook missing from succeeded list",
    );
    assert(
      stub.warnings.some((w) =>
        String(w[0] ?? "").includes("Slack webhook failed"),
      ),
      "Slack failure logged as warning",
    );
  }

  console.log("\nSlack 5xx — counted as failure, not silent success");
  {
    const stub = buildStub({
      slackUrl: "https://hooks.example/x",
      fetchResponses: [new Response("oops", { status: 502 })],
    });
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({ event_logs_updated: 1 }),
      stub.deps,
    );
    assert(outcome.dispatched === true, "outcome dispatched");
    assert(
      !outcome.channelsSucceeded.includes("slack_webhook"),
      "slack_webhook NOT in succeeded list on HTTP 502",
    );
    assert(
      stub.warnings.some((w) =>
        String(w[0] ?? "").includes("Slack webhook returned"),
      ),
      "HTTP failure logged as warning",
    );
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
