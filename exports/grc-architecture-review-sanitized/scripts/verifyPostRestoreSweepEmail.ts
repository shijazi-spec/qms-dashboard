/**
 * Task #574 — Staging dry-run helper for the post-restore sweep email channel.
 *
 * Purpose
 * -------
 * The unit tests in `tests/redactPostRestoreSweepAlert.test.ts` cover the
 * dispatcher contract (recipients trimmed, body includes timestamp +
 * counts, channel marked succeeded/failed) but stub `sendEmailProviderEmail`.
 * They cannot prove that:
 *
 *   - The real EmailProvider API accepts the payload that
 *     `dispatchPostRestoreSweepAlert` produces.
 *   - The rendered HTML survives Gmail web, Outlook, and IdentityProvider Mail
 *     without the per-table counts, sweep timestamp, or
 *     `Open the audit log` link being mangled.
 *
 * A formatting regression would otherwise only surface during an actual
 * incident (i.e. when on-call most needs the page to be readable). This
 * script lets an operator trigger the email path on demand against a
 * real test inbox without touching any historical row in the staging
 * database.
 *
 * What it does
 * ------------
 * Calls `dispatchPostRestoreSweepAlert(result, deps)` directly with a
 * synthetic, in-memory `SweepResult` whose four monitored counters are
 * all non-zero. The dispatcher then exercises every real surface:
 *
 *   - Channel 1 (platform notification hub) — disabled by default in
 *     this script via a no-op stub so a verification dry-run does NOT
 *     pollute the staging notifications table or page real on-call.
 *     Pass `--include-notification` to opt in.
 *   - Channel 2 (ChatProvider webhook) — disabled by default via a no-op fetch
 *     stub for the same reason. Pass `--include-ChatProvider` to opt in (and
 *     set `ChatProvider_WEBHOOK_URL` to a sandbox channel).
 *   - Channel 3 (EmailProvider email) — ALWAYS exercised against the real
 *     `sendEmailProviderEmail` helper. This is the only channel this script
 *     is designed to verify end-to-end.
 *
 * Required env vars
 * -----------------
 *   - `EmailProvider_API_KEY`                   — real staging EmailProvider key (≥ 20 chars).
 *   - `POST_RESTORE_SWEEP_ALERT_EMAIL`   — comma-separated test inbox(es),
 *                                          e.g. your @gmail / @outlook /
 *                                          @icloud aliases.
 *
 * Optional env vars
 * -----------------
 *   - `EmailProvider_FROM_EMAIL`                — override the From header
 *                                          (default `ExampleOrg QMS
 *                                          <user@example.invalid>`).
 *
 * CLI flags
 * ---------
 *   --counts=EL,NC,CAPA,AI    Override per-table counts (default 5,7,11,2).
 *                             Each counter must be a non-negative integer
 *                             and at least one must be positive (else the
 *                             dispatcher would correctly stay silent).
 *   --include-notification    Also exercise the platform notification hub.
 *   --include-ChatProvider           Also exercise the ChatProvider webhook
 *                             (requires ChatProvider_WEBHOOK_URL).
 *
 * Usage
 * -----
 *   npx tsx scripts/verifyPostRestoreSweepEmail.ts
 *   npx tsx scripts/verifyPostRestoreSweepEmail.ts --counts=0,3,0,0
 *
 * The script exits 0 when the email helper reports `success: true`, and
 * exits 1 (with a diagnostic) on any other outcome so it can be wired
 * into a periodic staging health-check job if desired.
 */

import {
  dispatchPostRestoreSweepAlert,
  extractPostRestoreSweepAlertCounts,
  type SweepResult,
} from "../src/utils/redactHistoricalLogs";
import { isEmailProviderConfigured } from "../src/utils/EmailProviderMail";

interface ParsedArgs {
  counts: [number, number, number, number];
  includeNotification: boolean;
  includeChatProvider: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    counts: [5, 7, 11, 2],
    includeNotification: false,
    includeChatProvider: false,
  };
  for (const arg of argv) {
    if (arg === "--include-notification") {
      out.includeNotification = true;
      continue;
    }
    if (arg === "--include-ChatProvider") {
      out.includeChatProvider = true;
      continue;
    }
    const m = arg.match(/^--counts=(.+)$/);
    if (m) {
      const parts = m[1]
        .split(",")
        .map((p) => p.trim())
        .map((p) => Number(p));
      if (
        parts.length !== 4 ||
        parts.some((n) => !Number.isFinite(n) || n < 0 || !Number.isInteger(n))
      ) {
        throw new Error(
          `--counts must be 4 non-negative integers, got: ${m[1]}`,
        );
      }
      if (parts.reduce((a, b) => a + b, 0) === 0) {
        throw new Error(
          `--counts cannot all be zero — the dispatcher would stay silent ` +
            `and no email would be sent. Use e.g. --counts=0,3,0,0.`,
        );
      }
      out.counts = parts as [number, number, number, number];
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return out;
}

function buildSyntheticResult(
  counts: [number, number, number, number],
): SweepResult {
  const [el, nc, capa, ai] = counts;
  return {
    sweep_timestamp: new Date().toISOString(),
    event_logs_updated: el,
    nc_change_history_updated: nc,
    nc_change_history_change_reason_updated: 0,
    capa_change_history_updated: capa,
    capa_change_history_change_reason_updated: 0,
    ai_pending_actions: {
      scanned: ai,
      payload_changed: ai,
      payload_preview_changed: 0,
      execution_result_changed: 0,
      rows_updated: ai,
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
    total_rows_updated: el + nc + capa + ai,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Pre-flight env validation. Fail fast with an explicit message instead
  // of letting the dispatcher's silent-skip path swallow a misconfigured
  // run (which would look like a successful no-op and defeat the whole
  // point of the verification).
  if (!isEmailProviderConfigured()) {
    console.error(
      "❌ EmailProvider_API_KEY is missing or shorter than 20 chars — " +
        "the email helper would skip the channel silently. Set a real " +
        "staging key and re-run.",
    );
    process.exit(1);
  }
  const recipientsRaw = process.env.POST_RESTORE_SWEEP_ALERT_EMAIL;
  const recipients = recipientsRaw
    ? recipientsRaw
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean)
    : [];
  if (recipients.length === 0) {
    console.error(
      "❌ POST_RESTORE_SWEEP_ALERT_EMAIL is unset / whitespace-only — " +
        "the dispatcher would skip the email channel silently. Set it " +
        "to your test inbox(es) (comma-separated) and re-run.",
    );
    process.exit(1);
  }
  if (args.includeChatProvider && !process.env.ChatProvider_WEBHOOK_URL) {
    console.error("❌ --include-ChatProvider passed but ChatProvider_WEBHOOK_URL is unset.");
    process.exit(1);
  }

  const result = buildSyntheticResult(args.counts);
  const triggers = extractPostRestoreSweepAlertCounts(result);

  console.log("=".repeat(72));
  console.log("Task #574 — Post-restore sweep email staging dry-run");
  console.log("=".repeat(72));
  console.log(`Sweep timestamp:    ${result.sweep_timestamp}`);
  console.log(`Recipients:         ${recipients.join(", ")}`);
  console.log(
    `Per-table counts:   event_logs=${triggers.event_logs}, ` +
      `nc_change_history=${triggers.nc_change_history}, ` +
      `capa_change_history=${triggers.capa_change_history}, ` +
      `ai_pending_actions=${triggers.ai_pending_actions}`,
  );
  // Be explicit about which channels run unstubbed vs which the script
  // intercepts with no-op deps. The dispatcher will still record
  // `platform_notification` (and `ChatProvider_webhook` when ChatProvider_WEBHOOK_URL
  // is set) as `channelsAttempted` even when this script feeds it
  // stubs, so wording this purely as "channels enabled" misled review.
  // Email is the only channel the verification dry-run actually proves
  // out against the real EmailProvider API.
  const realChannels = ["email_recipients"];
  if (args.includeNotification) realChannels.push("platform_notification");
  if (args.includeChatProvider) realChannels.push("ChatProvider_webhook");
  const stubbedChannels: string[] = [];
  if (!args.includeNotification) stubbedChannels.push("platform_notification");
  if (!args.includeChatProvider && process.env.ChatProvider_WEBHOOK_URL) {
    stubbedChannels.push("ChatProvider_webhook");
  }
  console.log(`Real channels:      ${realChannels.join(", ")}`);
  console.log(
    `Stubbed channels:   ${stubbedChannels.length > 0 ? stubbedChannels.join(", ") : "(none)"}`,
  );
  console.log("");

  // Default: stub out platform notification and ChatProvider so a verification
  // dry-run does not pollute staging notifications or page on-call.
  // Operators can opt in per channel via --include-* flags.
  const stubFetch: typeof fetch = (async () =>
    new Response(null, { status: 200 })) as unknown as typeof fetch;
  const noopNotification = async () => undefined;

  const outcome = await dispatchPostRestoreSweepAlert(result, {
    createNotification: args.includeNotification ? undefined : noopNotification,
    fetch: args.includeChatProvider ? undefined : stubFetch,
    // sendEmail intentionally NOT overridden — we want the real
    // sendEmailProviderEmail helper to run end-to-end. The dispatcher will
    // dynamically import it from `src/utils/EmailProviderMail.ts`.
  });

  console.log("");
  console.log("Dispatcher outcome:");
  console.log(JSON.stringify(outcome, null, 2));
  console.log("");

  const emailAttempted = outcome.channelsAttempted.includes("email_recipients");
  const emailSucceeded = outcome.channelsSucceeded.includes("email_recipients");

  if (!outcome.dispatched) {
    console.error(
      "❌ Dispatcher reported NOT dispatched — counts were all zero. " +
        "This is a bug in this script (the synthetic SweepResult should " +
        "always have a non-zero counter).",
    );
    process.exit(1);
  }
  if (!emailAttempted) {
    console.error(
      "❌ Dispatcher did not attempt the email channel. Most likely " +
        "POST_RESTORE_SWEEP_ALERT_EMAIL or EmailProvider_API_KEY changed between " +
        "pre-flight and dispatch. Re-run with consistent env.",
    );
    process.exit(1);
  }
  if (!emailSucceeded) {
    console.error(
      "❌ Email helper reported failure — see preceding [EmailProviderMail] " +
        "logs for the underlying EmailProvider error (rate limit, invalid " +
        "recipient, unverified From domain, etc.).",
    );
    process.exit(1);
  }

  console.log(
    "✅ Email accepted by EmailProvider. Now open each recipient's inbox " +
      "(Gmail web, Outlook, IdentityProvider Mail) and confirm:",
  );
  console.log("   - Subject contains the total row count and the 🚨 prefix.");
  console.log(`   - Body includes the timestamp ${result.sweep_timestamp}.`);
  console.log(
    "   - The four per-table counts render as a bulleted list, not as " +
      "raw HTML tags.",
  );
  console.log(
    "   - The 'Open the audit log' link is clickable and points to " +
      "/audit-logs (it will resolve relative to the recipient's mail " +
      "client; document that staging operators paste the deployed origin " +
      "if a fully-qualified link is required).",
  );
  console.log(
    "   - Screenshot each client and attach to " +
      "audit-evidence/STAGING_EMAIL_VERIFICATION.md per the documented " +
      "procedure.",
  );
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
