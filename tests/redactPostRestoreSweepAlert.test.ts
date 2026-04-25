/**
 * Unit tests for Task #462 — alert operators when a post-restore sweep
 * actually rewrites change-history rows. Extended in Task #555 to cover
 * the third (email) channel that mirrors the `AI_COST_ALERT_EMAIL`
 * pattern from the `ai-cost-summary` cron.
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
 *   9. (Task #555) Skips the email channel when
 *      `POST_RESTORE_SWEEP_ALERT_EMAIL` is unset — silent parity with
 *      the Slack-webhook channel.
 *  10. (Task #555) When the env var lists recipients, sends a
 *      formatted email via the resend helper that includes the sweep
 *      timestamp and per-table counts. Trims whitespace and skips
 *      empty entries in the comma-separated recipient list.
 *  11. (Task #555) Email send failure (helper throws or returns
 *      `success:false`) does NOT suppress the platform notification
 *      or the Slack webhook, and is logged as a warning.
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
      flagged_action_codes: [],
      flagged_action_codes_truncated: 0,
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

interface CapturedEmail {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
}

interface DispatcherStub {
  notifications: CapturedNotification[];
  fetches: CapturedFetch[];
  emails: CapturedEmail[];
  fetchResponses: Array<Response | Error>;
  notificationError?: Error;
  emailError?: Error;
  emailFailureReason?: string;
  warnings: unknown[][];
  errors: unknown[][];
  logs: unknown[][];
  deps: {
    createNotification: (notif: Record<string, unknown>) => Promise<unknown>;
    fetch: typeof fetch;
    sendEmail: (opts: CapturedEmail) => Promise<{
      success: boolean;
      id?: string;
      error?: string;
    }>;
    env: Record<string, string | undefined>;
    logger: Pick<Console, "log" | "warn" | "error">;
    /**
     * Optional Task #573 hook: when set, the dispatcher uses this
     * stub to resolve the email recipient list (DB-backed admin list,
     * with env fallback). Tests that don't override this fall back to
     * the dispatcher's default behaviour, which (in unit-test
     * contexts where there is no DB) means parsing
     * `POST_RESTORE_SWEEP_ALERT_EMAIL` from `env`.
     */
    resolveRecipients?: (
      channel: "post_restore_sweep" | "ai_cost",
      envValue: string | undefined | null,
    ) => Promise<{
      recipients: string[];
      source: "db" | "env" | "none";
    }>;
  };
}

/**
 * Stub-length API key (>=20 chars) the dispatcher accepts as
 * "configured" without ever calling Resend (the dependency-injected
 * `sendEmail` short-circuits the real client). Real keys look nothing
 * like this — kept obviously fake so a leaked test fixture is never
 * mistaken for a credential by the redaction sweep itself.
 */
const STUB_RESEND_KEY = "re_test_aaaaaaaaaaaaaaaaaaaaaa";

function buildStub(
  options: {
    slackUrl?: string;
    emailRecipientsEnv?: string;
    /**
     * Override the stubbed `RESEND_API_KEY` env var.
     *   - `undefined` (default): inject a stub-length key so the
     *     dispatcher considers the email helper configured.
     *   - `null`: omit `RESEND_API_KEY` entirely (helper unconfigured —
     *     dispatcher must skip the email channel silently).
     *   - any string: pass through verbatim (e.g. a 5-char value to
     *     simulate a clearly-too-short stub the dispatcher should also
     *     treat as unconfigured).
     */
    resendApiKey?: string | null;
    notificationError?: Error;
    emailError?: Error;
    emailFailureReason?: string;
    fetchResponses?: Array<Response | Error>;
  } = {},
): DispatcherStub {
  const stub: DispatcherStub = {
    notifications: [],
    fetches: [],
    emails: [],
    fetchResponses: options.fetchResponses ?? [],
    notificationError: options.notificationError,
    emailError: options.emailError,
    emailFailureReason: options.emailFailureReason,
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
      async sendEmail(opts: CapturedEmail) {
        if (stub.emailError) throw stub.emailError;
        stub.emails.push(opts);
        if (stub.emailFailureReason) {
          return { success: false, error: stub.emailFailureReason };
        }
        return { success: true, id: "email-stub-id" };
      },
      env: {
        ...(options.slackUrl
          ? { SLACK_WEBHOOK_URL: options.slackUrl }
          : {}),
        ...(options.emailRecipientsEnv !== undefined
          ? { POST_RESTORE_SWEEP_ALERT_EMAIL: options.emailRecipientsEnv }
          : {}),
        // null → leave RESEND_API_KEY unset; undefined → use stub key;
        // any explicit string → passthrough (lets tests probe the
        // length<20 unconfigured branch).
        ...(options.resendApiKey === null
          ? {}
          : {
              RESEND_API_KEY:
                options.resendApiKey ?? STUB_RESEND_KEY,
            }),
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
      // Default Task #573 resolver — pure env-var parser (no DB
      // access). Preserves the legacy behaviour the existing
      // POST_RESTORE_SWEEP_ALERT_EMAIL assertions depend on while
      // letting the new tests below override this hook to assert the
      // DB-takes-precedence path. Without this default, the
      // dispatcher would dynamically import the real
      // `alertEmailRecipients` module and try to query the test DB,
      // making these unit tests flaky / DB-coupled.
      async resolveRecipients(_channel, envValue) {
        const list = (envValue ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        return list.length > 0
          ? { recipients: list, source: "env" as const }
          : { recipients: [], source: "none" as const };
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

    assert(
      stub.emails.length === 0,
      "no email sent when POST_RESTORE_SWEEP_ALERT_EMAIL is unset",
    );
    assert(
      !outcome.channelsAttempted.includes("email_recipients"),
      "email_recipients NOT attempted when env var missing",
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

  // ──────────────────────────────────────────────────────────────────────
  // Task #555 — third channel: opt-in email recipient list
  //
  // Mirrors the AI_COST_ALERT_EMAIL pattern in src/mastra/inngest/index.ts
  // (the ai-cost-summary cron). On-call engineers who don't happen to be
  // in Slack at boot time must still see the page in their inbox because a
  // credential reintroduction via backup restore needs to be acknowledged
  // within minutes, not hours.
  // ──────────────────────────────────────────────────────────────────────

  console.log(
    "\n[Task #555] Email recipients unset — silent on the email channel",
  );
  {
    // Slack URL set so the alert still has another delivery channel and
    // we can confirm email is the only one missing — i.e. the unset env
    // var really did cause the email channel to be skipped, not that the
    // dispatch itself short-circuited.
    const stub = buildStub({ slackUrl: "https://hooks.example/x" });
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({ event_logs_updated: 1 }),
      stub.deps,
    );
    assert(outcome.dispatched === true, "alert still dispatched");
    assert(
      stub.emails.length === 0,
      "email helper NOT invoked without POST_RESTORE_SWEEP_ALERT_EMAIL",
    );
    assert(
      !outcome.channelsAttempted.includes("email_recipients"),
      "email_recipients NOT attempted",
    );
    assert(
      !outcome.channelsSucceeded.includes("email_recipients"),
      "email_recipients NOT succeeded",
    );
  }

  console.log(
    "\n[Task #555] Empty/whitespace POST_RESTORE_SWEEP_ALERT_EMAIL is a no-op",
  );
  {
    // A stray "POST_RESTORE_SWEEP_ALERT_EMAIL=" or comma-only value must
    // not cause the dispatcher to call sendEmail with an empty list (the
    // helper would just no-op, but the channel would be falsely reported
    // as attempted).
    const stub = buildStub({
      slackUrl: "https://hooks.example/x",
      emailRecipientsEnv: " , , ",
    });
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({ event_logs_updated: 1 }),
      stub.deps,
    );
    assert(
      stub.emails.length === 0,
      "no email sent when env var contains only commas/whitespace",
    );
    assert(
      !outcome.channelsAttempted.includes("email_recipients"),
      "email_recipients NOT attempted on empty list",
    );
  }

  console.log(
    "\n[Task #555] Recipients configured — email fires with timestamp + counts",
  );
  {
    const stub = buildStub({
      slackUrl: "https://hooks.example/x",
      emailRecipientsEnv:
        "oncall@walaplus.com, secops@walaplus.com ,, ops-leads@walaplus.com",
    });
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
    assert(outcome.dispatched === true, "outcome dispatched");
    assert(stub.emails.length === 1, "exactly one email sent");
    assert(
      outcome.channelsAttempted.includes("email_recipients"),
      "email_recipients attempted",
    );
    assert(
      outcome.channelsSucceeded.includes("email_recipients"),
      "email_recipients succeeded",
    );

    const email = stub.emails[0];
    const recipients = Array.isArray(email.to) ? email.to : [email.to];
    assert(
      recipients.length === 3 &&
        recipients.includes("oncall@walaplus.com") &&
        recipients.includes("secops@walaplus.com") &&
        recipients.includes("ops-leads@walaplus.com"),
      "recipients are split, trimmed, and empty entries discarded",
    );
    assert(
      recipients.every((r) => r === r.trim() && r.length > 0),
      "no whitespace or empty recipients leaked through",
    );
    assert(
      typeof email.subject === "string" && email.subject.length > 0,
      "email has a subject",
    );

    const html = String(email.html ?? "");
    const text = String(email.text ?? "");
    assert(
      html.includes(SWEEP_TS) || text.includes(SWEEP_TS),
      "email body includes sweep timestamp",
    );
    const hasAllCounts = (body: string) =>
      body.includes("event_logs") &&
      body.includes("5") &&
      body.includes("nc_change_history") &&
      body.includes("7") &&
      body.includes("capa_change_history") &&
      body.includes("11") &&
      body.includes("ai_pending_actions") &&
      body.includes("2");
    assert(
      hasAllCounts(html) || hasAllCounts(text),
      "email body embeds per-table counts (event_logs/nc/capa/ai)",
    );

    // The other two channels must still have fired alongside email.
    assert(
      stub.notifications.length === 1,
      "platform notification still dispatched alongside email",
    );
    assert(stub.fetches.length === 1, "Slack POST still issued alongside email");
  }

  console.log(
    "\n[Task #555] Email helper throws — other channels still succeed",
  );
  {
    const stub = buildStub({
      slackUrl: "https://hooks.example/x",
      emailRecipientsEnv: "oncall@walaplus.com",
      emailError: new Error("resend api down"),
    });
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({ nc_change_history_updated: 3 }),
      stub.deps,
    );
    assert(outcome.dispatched === true, "outcome still reports dispatched");
    assert(
      outcome.channelsAttempted.includes("email_recipients"),
      "email_recipients attempted even though it threw",
    );
    assert(
      !outcome.channelsSucceeded.includes("email_recipients"),
      "email_recipients absent from succeeded list on throw",
    );
    assert(
      outcome.channelsSucceeded.includes("platform_notification"),
      "platform_notification still succeeded despite email throw",
    );
    assert(
      outcome.channelsSucceeded.includes("slack_webhook"),
      "slack_webhook still succeeded despite email throw",
    );
    assert(
      stub.notifications.length === 1,
      "platform notification fired despite email throw",
    );
    assert(
      stub.fetches.length === 1,
      "Slack POST issued despite email throw",
    );
    assert(
      stub.warnings.some((w) =>
        String(w[0] ?? "").includes("email send failed"),
      ),
      "email failure logged as warning",
    );
  }

  console.log(
    "\n[Task #555] Email helper returns success:false from a real " +
      "delivery error — counted as failure & warned",
  );
  {
    // success:false here represents an upstream Resend delivery error
    // (rate-limit, blocked recipient, etc.) — the dispatcher already
    // confirmed the helper was configured (RESEND_API_KEY present), so
    // the channel was attempted and a real failure deserves a warning.
    // This is the "degraded upstream" branch, distinct from the
    // unconfigured-helper silent-skip branch covered below.
    const stub = buildStub({
      slackUrl: "https://hooks.example/x",
      emailRecipientsEnv: "oncall@walaplus.com",
      emailFailureReason: "Resend API rate limited",
    });
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({ capa_change_history_updated: 1 }),
      stub.deps,
    );
    assert(outcome.dispatched === true, "outcome dispatched");
    assert(stub.emails.length === 1, "email helper invoked once");
    assert(
      outcome.channelsAttempted.includes("email_recipients"),
      "email_recipients still attempted on success:false",
    );
    assert(
      !outcome.channelsSucceeded.includes("email_recipients"),
      "email_recipients NOT in succeeded list on success:false",
    );
    assert(
      outcome.channelsSucceeded.includes("platform_notification"),
      "platform_notification still succeeded",
    );
    assert(
      outcome.channelsSucceeded.includes("slack_webhook"),
      "slack_webhook still succeeded",
    );
    assert(
      stub.warnings.some((w) =>
        String(w[0] ?? "").includes("email helper") &&
        String(w[0] ?? "").includes("Resend API rate limited"),
      ),
      "email helper failure reason surfaced in warning",
    );
  }

  console.log(
    "\n[Task #555] Email helper unconfigured (no RESEND_API_KEY) — " +
      "silent skip, channel NOT attempted",
  );
  {
    // Parity with the SLACK_WEBHOOK_URL-unset branch: when the helper
    // itself is unconfigured the channel should be skipped silently —
    // no warning, no `attempted` entry, no `sendEmail` call. This
    // mirrors how the ai-cost-summary cron behaves: an unconfigured
    // Resend key is a deployment posture, not an alertable failure.
    const stub = buildStub({
      slackUrl: "https://hooks.example/x",
      emailRecipientsEnv: "oncall@walaplus.com",
      resendApiKey: null, // omit RESEND_API_KEY entirely
    });
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({ event_logs_updated: 2 }),
      stub.deps,
    );
    assert(outcome.dispatched === true, "outcome dispatched");
    assert(
      stub.emails.length === 0,
      "email helper NOT invoked when RESEND_API_KEY missing",
    );
    assert(
      !outcome.channelsAttempted.includes("email_recipients"),
      "email_recipients NOT attempted when helper unconfigured",
    );
    assert(
      !outcome.channelsSucceeded.includes("email_recipients"),
      "email_recipients NOT succeeded when helper unconfigured",
    );
    assert(
      !stub.warnings.some((w) =>
        String(w[0] ?? "").toLowerCase().includes("email"),
      ),
      "no email-related warning emitted on silent skip",
    );
    assert(
      outcome.channelsSucceeded.includes("platform_notification"),
      "platform_notification still fires when email channel silenced",
    );
    assert(
      outcome.channelsSucceeded.includes("slack_webhook"),
      "slack_webhook still fires when email channel silenced",
    );
  }

  console.log(
    "\n[Task #555] RESEND_API_KEY too short (<20 chars) — also silent skip",
  );
  {
    // The configured-check matches `sendResendEmail`'s own internal
    // length>=20 gate, so a placeholder/stub key ("changeme", "todo")
    // is treated the same as no key at all.
    const stub = buildStub({
      slackUrl: "https://hooks.example/x",
      emailRecipientsEnv: "oncall@walaplus.com",
      resendApiKey: "short",
    });
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({ event_logs_updated: 1 }),
      stub.deps,
    );
    assert(stub.emails.length === 0, "no email sent on too-short key");
    assert(
      !outcome.channelsAttempted.includes("email_recipients"),
      "email_recipients NOT attempted on too-short key",
    );
    assert(
      !stub.warnings.some((w) =>
        String(w[0] ?? "").toLowerCase().includes("email"),
      ),
      "no email warning on too-short key",
    );
  }

  console.log(
    "\n[Task #555] Clean sweep — email channel stays silent even with recipients",
  );
  {
    // A clean sweep must short-circuit before any channel — including
    // email — is touched, so opt-in operators are not paged on every
    // boot.
    const stub = buildStub({
      slackUrl: "https://hooks.example/x",
      emailRecipientsEnv: "oncall@walaplus.com",
    });
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult(),
      stub.deps,
    );
    assert(
      outcome.dispatched === false,
      "clean sweep stays silent even with email recipients configured",
    );
    assert(stub.emails.length === 0, "no email sent on clean sweep");
    assert(
      !outcome.channelsAttempted.includes("email_recipients"),
      "email_recipients NOT attempted on clean sweep",
    );
  }

  console.log(
    "\n[Task #573] DB-backed recipient list takes precedence over env var",
  );
  {
    // When the admin has saved recipients via the dashboard, the DB
    // list is the source of truth — the env var must be ignored even
    // if it is set.
    const stub = buildStub({
      slackUrl: "https://hooks.example/x",
      emailRecipientsEnv: "env-only@walaplus.com",
    });
    let resolverCalls = 0;
    let resolverChannel: string | undefined;
    let resolverEnvValue: string | undefined | null;
    stub.deps.resolveRecipients = async (channel, envValue) => {
      resolverCalls++;
      resolverChannel = channel;
      resolverEnvValue = envValue;
      return {
        recipients: ["db-admin@walaplus.com", "db-secondary@walaplus.com"],
        source: "db",
      };
    };
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({ event_logs_updated: 3 }),
      stub.deps,
    );
    assert(outcome.dispatched === true, "outcome dispatched");
    assert(resolverCalls === 1, "resolver invoked once");
    assert(
      resolverChannel === "post_restore_sweep",
      "resolver called with post_restore_sweep channel",
    );
    assert(
      resolverEnvValue === "env-only@walaplus.com",
      "resolver receives the env value (so it can fall back when DB empty)",
    );
    assert(stub.emails.length === 1, "one email send invoked");
    const sent = stub.emails[0];
    const recipientsList = Array.isArray(sent.to) ? sent.to : [sent.to];
    assert(
      recipientsList.length === 2 &&
        recipientsList.includes("db-admin@walaplus.com") &&
        recipientsList.includes("db-secondary@walaplus.com"),
      "DB list used as recipient set",
    );
    assert(
      !recipientsList.includes("env-only@walaplus.com"),
      "env var recipient NOT included when DB list non-empty",
    );
    assert(
      outcome.channelsSucceeded.includes("email_recipients"),
      "email_recipients channel succeeded",
    );
    const dispatchLog = stub.logs.find((entry) =>
      String(entry[0] ?? "").includes("dispatched"),
    );
    assert(
      dispatchLog !== undefined &&
        String(dispatchLog[0]).includes("recipients_source: db"),
      "dispatch log records recipients_source: db",
    );
  }

  console.log(
    "\n[Task #573] Empty DB list falls back to env var (legacy behaviour preserved)",
  );
  {
    const stub = buildStub({
      slackUrl: "https://hooks.example/x",
      emailRecipientsEnv: "legacy-oncall@walaplus.com",
    });
    let resolverCalls = 0;
    stub.deps.resolveRecipients = async (_channel, envValue) => {
      resolverCalls++;
      // Mirror the real resolver: parse the env value when DB is empty.
      const list = (envValue ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return list.length > 0
        ? { recipients: list, source: "env" as const }
        : { recipients: [], source: "none" as const };
    };
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({ event_logs_updated: 1 }),
      stub.deps,
    );
    assert(resolverCalls === 1, "resolver invoked");
    assert(stub.emails.length === 1, "email sent via env-fallback");
    const recipientsList = Array.isArray(stub.emails[0].to)
      ? stub.emails[0].to
      : [stub.emails[0].to];
    assert(
      recipientsList.length === 1 &&
        recipientsList[0] === "legacy-oncall@walaplus.com",
      "env var used as recipient set when DB empty",
    );
    assert(
      outcome.channelsSucceeded.includes("email_recipients"),
      "email_recipients channel succeeded via env fallback",
    );
    const dispatchLog = stub.logs.find((entry) =>
      String(entry[0] ?? "").includes("dispatched"),
    );
    assert(
      dispatchLog !== undefined &&
        String(dispatchLog[0]).includes("recipients_source: env"),
      "dispatch log records recipients_source: env",
    );
  }

  console.log(
    "\n[Task #573] Resolver throws → env-var fallback (no silent drop)",
  );
  {
    // Defensive path: the dispatcher must never silently drop the
    // email channel just because the resolver threw — it falls back
    // to parsing the env var directly so on-call still gets paged.
    const stub = buildStub({
      slackUrl: "https://hooks.example/x",
      emailRecipientsEnv: "fallback-oncall@walaplus.com",
    });
    stub.deps.resolveRecipients = async () => {
      throw new Error("boom");
    };
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({ nc_change_history_updated: 1 }),
      stub.deps,
    );
    assert(stub.emails.length === 1, "email still sent on resolver failure");
    const recipientsList = Array.isArray(stub.emails[0].to)
      ? stub.emails[0].to
      : [stub.emails[0].to];
    assert(
      recipientsList.length === 1 &&
        recipientsList[0] === "fallback-oncall@walaplus.com",
      "env var used as fallback when resolver throws",
    );
    assert(
      outcome.channelsSucceeded.includes("email_recipients"),
      "email_recipients channel succeeded via defensive fallback",
    );
    assert(
      stub.warnings.some((w) =>
        String(w[0] ?? "").includes("recipient resolver failed"),
      ),
      "resolver failure logged as warning",
    );
  }

  console.log(
    "\n[Task #573] Both DB and env empty → email channel skipped silently",
  );
  {
    const stub = buildStub({ slackUrl: "https://hooks.example/x" });
    stub.deps.resolveRecipients = async () => ({
      recipients: [],
      source: "none" as const,
    });
    const outcome = await dispatchPostRestoreSweepAlert(
      buildSweepResult({ event_logs_updated: 1 }),
      stub.deps,
    );
    assert(stub.emails.length === 0, "no email send invoked when no recipients");
    assert(
      !outcome.channelsAttempted.includes("email_recipients"),
      "email_recipients NOT attempted when no recipients",
    );
    assert(
      !stub.warnings.some((w) =>
        String(w[0] ?? "").toLowerCase().includes("email"),
      ),
      "no email warning when channel silently skipped",
    );
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
