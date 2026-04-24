/**
 * Tool-Health Alert Notifier
 *
 * Goal: when the per-tool health cron opens a NEW `tool_health` alert, page
 * on-call via Slack and/or email so the breach is noticed even when nobody
 * is staring at the AI Operations panel.
 *
 * Wiring:
 *   - `runToolHealthCheck()` (src/mastra/workflows/toolHealthAlertsCron.ts)
 *     calls `notifyToolHealthBreach()` for each newly-created breach
 *     (i.e. once `openAlertExistsByKey` confirmed there was no matching
 *     open alert and `createAIAlert` succeeded). Because the cron only
 *     fires this hook on NEW alerts, dedupe against the same
 *     `<tool_name>:<reason>` key falls out for free — the cron will not
 *     re-call us every 15 min while the alert is still open.
 *
 * Belt-and-braces dedupe:
 *   - We additionally keep an in-process throttle keyed on
 *     `<tool_name>:<reason>` so even if a sibling code path creates a
 *     fresh alert quickly (alert resolved → metric still bad → new alert
 *     within minutes), we don't re-page the same key inside the configured
 *     throttle window.
 *
 * Configuration (matches the `TOOL_HEALTH_*` env-var convention used by
 * the cron's `TOOL_HEALTH_THRESHOLDS`):
 *   - `TOOL_HEALTH_SLACK_CHANNEL`        — Slack channel id/name to page.
 *                                          Falls back to `SLACK_CHANNEL_ID`
 *                                          only when explicitly opted-in
 *                                          via `TOOL_HEALTH_SLACK_USE_DEFAULT_CHANNEL=1`,
 *                                          to avoid accidentally posting
 *                                          tool-health alerts to the QMS
 *                                          channel.
 *   - `TOOL_HEALTH_ALERT_EMAIL`          — comma-separated recipient list
 *                                          for the Resend email.
 *   - `TOOL_HEALTH_NOTIFY_THROTTLE_MIN`  — minutes within which the same
 *                                          `<tool_name>:<reason>` key will
 *                                          not be paged twice. Default 60.
 *   - `TOOL_HEALTH_APP_URL`              — public origin used to build the
 *                                          link back to the AI Operations
 *                                          panel. When unset we emit a
 *                                          relative path.
 *
 * The module exposes a small dep-injection surface so unit tests can
 * stub Slack/Resend without touching the real APIs and can reset the
 * throttle map between runs.
 */

import { sendSlackNotification } from "./slackNotifications";
import { sendResendEmail, type ResendEmailOptions } from "./resendMail";
import type { AlertSeverity } from "./aiAlertsDatabase";

export type ToolHealthReason = "error_rate" | "p95_latency";

export interface ToolHealthBreachNotification {
  /** Tool whose metric breached. */
  tool_name: string;
  /** Optional agent label, mirrored from the aggregate. */
  agent_name?: string | null;
  /** Which threshold breached. */
  reason: ToolHealthReason;
  /** Severity computed by the cron. */
  severity: AlertSeverity;
  /** Title of the `ai_alerts` row that was just created. */
  title: string;
  /** Description of the `ai_alerts` row (already carries live values). */
  description: string;
  /** Suggested next step for the responder. */
  suggestion?: string;
  /**
   * Composite dedupe key — `<tool_name>:<reason>`. Matches the
   * `related_record_id` written by `createAIAlert` and consumed by
   * `openAlertExistsByKey`.
   */
  related_record_id: string;
  /** Optional id of the freshly-created `ai_alerts` row, surfaced in the body. */
  alert_id?: number;
}

export interface NotifyToolHealthBreachResult {
  slackSent: boolean;
  emailSent: boolean;
  /** True when the throttle map blocked the page entirely. */
  throttled: boolean;
  /** True when neither Slack nor email is configured. */
  skipped: boolean;
}

export interface ToolHealthNotifierDeps {
  /** Defaults to `sendSlackNotification`. */
  sendSlack?: typeof sendSlackNotification;
  /** Defaults to `sendResendEmail`. */
  sendEmail?: (opts: ResendEmailOptions) => Promise<{ success: boolean; id?: string; error?: string }>;
  /** Defaults to `Date.now`. Tests inject a deterministic clock. */
  now?: () => number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Env-overridable config — read fresh inside the notifier so test suites
// can mutate `process.env.*` between cases without re-importing.
// ──────────────────────────────────────────────────────────────────────────────
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readConfig() {
  const useDefaultSlack = process.env.TOOL_HEALTH_SLACK_USE_DEFAULT_CHANNEL === "1";
  const slackChannel =
    (process.env.TOOL_HEALTH_SLACK_CHANNEL || "").trim() ||
    (useDefaultSlack ? (process.env.SLACK_CHANNEL_ID || "").trim() || null : null) ||
    null;
  const emailRaw = (process.env.TOOL_HEALTH_ALERT_EMAIL || "").trim();
  const emailRecipients = emailRaw
    ? emailRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const appUrl = (process.env.TOOL_HEALTH_APP_URL || "").trim().replace(/\/+$/, "");
  // `link` is always emit-able (relative when no base URL is set); `linkIsAbsolute`
  // gates Slack's action button — Slack rejects blocks whose button.url is a
  // relative path, so we degrade to a plain mrkdwn link in that case.
  const link = appUrl ? `${appUrl}/dashboard/ai-ops.html` : `/dashboard/ai-ops.html`;
  const linkIsAbsolute = /^https?:\/\//i.test(link);
  return {
    slackChannel: slackChannel || null,
    emailRecipients,
    link,
    linkIsAbsolute,
    throttleMs: envInt("TOOL_HEALTH_NOTIFY_THROTTLE_MIN", 60) * 60_000,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Throttle map (in-process). Keyed on `<tool_name>:<reason>`, value is the
// epoch ms at which the last successful page was sent. The cron's DB-level
// dedupe (open ai_alerts row) is the primary mechanism — this is a safety
// net so a flapping breach can't double-page the same key within the
// configured window.
// ──────────────────────────────────────────────────────────────────────────────
const lastNotifiedAt = new Map<string, number>();

/** Visible to tests so each case starts with a clean throttle window. */
export function _resetToolHealthNotifierThrottleForTests(): void {
  lastNotifiedAt.clear();
}

// ──────────────────────────────────────────────────────────────────────────────
// Renderers
// ──────────────────────────────────────────────────────────────────────────────
function severityEmoji(sev: AlertSeverity): string {
  switch (sev) {
    case "critical": return ":rotating_light:";
    case "high":     return ":red_circle:";
    case "medium":   return ":large_orange_circle:";
    case "low":      return ":large_yellow_circle:";
    case "info":     return ":information_source:";
    default:         return ":warning:";
  }
}

function reasonLabel(reason: ToolHealthReason): string {
  return reason === "error_rate" ? "Error rate" : "P95 latency";
}

function buildSlackBlocks(
  n: ToolHealthBreachNotification,
  link: string,
  linkIsAbsolute: boolean,
): any[] {
  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${severityEmoji(n.severity)} Tool health alert: ${n.tool_name}`,
        emoji: true,
      },
    },
    { type: "divider" },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Tool:*\n\`${n.tool_name}\`` },
        { type: "mrkdwn", text: `*Reason:*\n${reasonLabel(n.reason)}` },
        { type: "mrkdwn", text: `*Severity:*\n${n.severity.toUpperCase()}` },
        { type: "mrkdwn", text: `*Agent:*\n${n.agent_name || "—"}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Details:*\n${n.description}` },
    },
  ];
  if (n.suggestion) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Suggested action:*\n${n.suggestion}` },
    });
  }
  // Slack's `actions.button.url` REQUIRES an absolute URL — posting a
  // relative path causes the whole message to be rejected with
  // `invalid_blocks`. Fall back to a plain mrkdwn-link section when
  // `TOOL_HEALTH_APP_URL` is unset so dev/test environments still get a
  // valid (if unclickable) message.
  if (linkIsAbsolute) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open AI Operations panel", emoji: true },
          url: link,
          style: "primary",
        },
      ],
    });
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:link: AI Operations panel: \`${link}\`\n` +
          `_Set \`TOOL_HEALTH_APP_URL\` to enable a clickable link._`,
      },
    });
  }
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text:
          `:robot_face: _WalaPlus tool-health monitor | dedupe key: ` +
          `\`${n.related_record_id}\`${n.alert_id != null ? ` | alert #${n.alert_id}` : ""}_`,
      },
    ],
  });
  return blocks;
}

function buildEmailHtml(
  n: ToolHealthBreachNotification,
  link: string,
): string {
  const linkHtml = `<a href="${link}">Open the AI Operations panel</a>`;
  const suggestionHtml = n.suggestion
    ? `<p><strong>Suggested action:</strong><br>${escapeHtml(n.suggestion)}</p>`
    : "";
  return [
    `<h2 style="margin:0 0 12px 0;">${escapeHtml(n.title)}</h2>`,
    `<p><strong>Tool:</strong> <code>${escapeHtml(n.tool_name)}</code><br>`,
    `<strong>Reason:</strong> ${reasonLabel(n.reason)}<br>`,
    `<strong>Severity:</strong> ${n.severity.toUpperCase()}<br>`,
    n.agent_name ? `<strong>Agent:</strong> ${escapeHtml(n.agent_name)}<br>` : "",
    `</p>`,
    `<p><strong>Details:</strong><br>${escapeHtml(n.description)}</p>`,
    suggestionHtml,
    `<p>${linkHtml}</p>`,
    `<p style="color:#888;font-size:12px;">Dedupe key: <code>${escapeHtml(n.related_record_id)}</code>` +
      (n.alert_id != null ? ` &middot; alert #${n.alert_id}` : "") +
      `</p>`,
  ].join("");
}

function buildEmailText(
  n: ToolHealthBreachNotification,
  link: string,
): string {
  return [
    n.title,
    "",
    `Tool: ${n.tool_name}`,
    `Reason: ${reasonLabel(n.reason)}`,
    `Severity: ${n.severity.toUpperCase()}`,
    n.agent_name ? `Agent: ${n.agent_name}` : "",
    "",
    n.description,
    "",
    n.suggestion ? `Suggested action: ${n.suggestion}` : "",
    "",
    `Open the AI Operations panel: ${link}`,
    `Dedupe key: ${n.related_record_id}` +
      (n.alert_id != null ? ` (alert #${n.alert_id})` : ""),
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ──────────────────────────────────────────────────────────────────────────────
// Public entry point
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Page on-call about a newly-opened `tool_health` alert.
 *
 * Safe to call unconditionally: when neither Slack nor email is configured
 * the function returns `{ skipped: true }` without throwing, so the cron
 * does not need to special-case dev/test environments.
 */
export async function notifyToolHealthBreach(
  notification: ToolHealthBreachNotification,
  depsOverride: ToolHealthNotifierDeps = {},
): Promise<NotifyToolHealthBreachResult> {
  const cfg = readConfig();
  const sendSlack = depsOverride.sendSlack ?? sendSlackNotification;
  const sendEmail = depsOverride.sendEmail ?? sendResendEmail;
  const nowFn = depsOverride.now ?? Date.now;

  const result: NotifyToolHealthBreachResult = {
    slackSent: false,
    emailSent: false,
    throttled: false,
    skipped: false,
  };

  if (!cfg.slackChannel && cfg.emailRecipients.length === 0) {
    // Nothing configured — explicitly mark as skipped so callers can log/count.
    result.skipped = true;
    return result;
  }

  // Belt-and-braces throttle: if we already paged this key inside the
  // configured window, do not page again (DB-level dedupe is still primary).
  const now = nowFn();
  const lastAt = lastNotifiedAt.get(notification.related_record_id);
  if (cfg.throttleMs > 0 && lastAt != null && now - lastAt < cfg.throttleMs) {
    result.throttled = true;
    return result;
  }

  if (cfg.slackChannel) {
    const fallback =
      `${severityEmoji(notification.severity)} Tool health alert: ` +
      `${notification.tool_name} — ${reasonLabel(notification.reason)} ` +
      `(${notification.severity.toUpperCase()})`;
    try {
      result.slackSent = await sendSlack(
        cfg.slackChannel,
        fallback,
        buildSlackBlocks(notification, cfg.link, cfg.linkIsAbsolute),
      );
    } catch (err) {
      console.error(
        `[ToolHealthNotifier] Slack send threw for ${notification.related_record_id}:`,
        err,
      );
      result.slackSent = false;
    }
  }

  if (cfg.emailRecipients.length > 0) {
    try {
      const sendResult = await sendEmail({
        to: cfg.emailRecipients,
        subject: `[Tool Health · ${notification.severity.toUpperCase()}] ${notification.title}`,
        html: buildEmailHtml(notification, cfg.link),
        text: buildEmailText(notification, cfg.link),
      });
      result.emailSent = !!sendResult?.success;
    } catch (err) {
      console.error(
        `[ToolHealthNotifier] Email send threw for ${notification.related_record_id}:`,
        err,
      );
      result.emailSent = false;
    }
  }

  if ((result.slackSent || result.emailSent) && cfg.throttleMs > 0) {
    lastNotifiedAt.set(notification.related_record_id, now);
  }

  return result;
}
