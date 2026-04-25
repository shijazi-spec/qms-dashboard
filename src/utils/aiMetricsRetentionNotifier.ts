/**
 * AI metrics retention-window change notifier (Task #549).
 *
 * Goal: when an admin saves a new AI metrics retention window through
 * `PUT /api/ai-ops/metrics-retention`, page the rest of the AI-ops team via
 * Slack and/or email so the change is visible *before* the next prune cron
 * runs. Task #504 already gave us an audit log row, but audit rows tend to
 * be checked only after something has gone wrong — and a silent tighten
 * (e.g. 90 days → 7 days) could quietly delete 80 days of telemetry on the
 * very next prune tick.
 *
 * Design mirrors `notifyToolHealthConfigChange` (src/utils/toolHealthAlertNotifier.ts):
 *   - Best-effort: this module never throws back to the caller.
 *   - Opt-in via `AI_METRICS_RETENTION_NOTIFY=1` so dev/test environments
 *     don't accidentally page on-call when seeded data flips the value.
 *   - Skipped when neither Slack nor email is configured (so the route
 *     handler can call us unconditionally).
 *   - No-op when before === after — saves with the same value (e.g. an
 *     admin re-saving to update the note) must not generate noise.
 *
 * Configuration:
 *   - `AI_METRICS_RETENTION_NOTIFY`        — must be "1" to opt in.
 *   - `AI_METRICS_RETENTION_SLACK_CHANNEL` — Slack channel id/name to page.
 *   - `AI_METRICS_RETENTION_ALERT_EMAIL`   — comma-separated recipient list
 *                                            forwarded to Resend.
 *   - `TOOL_HEALTH_APP_URL`                — public origin used to build the
 *                                            deep-link to the AI Ops panel.
 *                                            Reused so admins only have to
 *                                            set the base URL once.
 */

import { sendSlackNotification } from "./slackNotifications";
import { sendResendEmail, type ResendEmailOptions } from "./resendMail";

import { logger } from "./logger";
export interface AiMetricsRetentionChangeNotification {
  /** Operator who made the change (display name / email / "user:<id>"). */
  changedBy: string;
  /** Override value before the change in days, or `null` for "default (env baseline)". */
  before: number | null;
  /** Override value after the change in days, or `null` for "default (env baseline)". */
  after: number | null;
  /**
   * Effective retention window after the change (resolves env baseline /
   * compile-time default when the override was cleared). Surfaced in the
   * Slack/email body so the on-call reader knows what the prune cron will
   * actually use on its next tick — particularly useful when `after` is
   * `null` (override cleared, env baseline takes back over).
   */
  effectiveAfter?: number | null;
  /** Optional free-form note from the operator (already length-capped). */
  note?: string | null;
  /** Audit-row id from `ai_metrics_retention_audit` for traceability. */
  audit_id?: number | null;
}

export interface NotifyAiMetricsRetentionChangeResult {
  slackSent: boolean;
  emailSent: boolean;
  /** True when before === after (no value change → no message posted). */
  noChanges: boolean;
  /** True when `AI_METRICS_RETENTION_NOTIFY` is not opted in. */
  disabled: boolean;
  /** True when neither Slack nor email is configured. */
  skipped: boolean;
}

export interface AiMetricsRetentionChangeNotifierDeps {
  /** Defaults to `sendSlackNotification`. */
  sendSlack?: typeof sendSlackNotification;
  /** Defaults to `sendResendEmail`. */
  sendEmail?: (
    opts: ResendEmailOptions,
  ) => Promise<{ success: boolean; id?: string; error?: string }>;
}

function readConfig() {
  const slackChannel =
    (process.env.AI_METRICS_RETENTION_SLACK_CHANNEL || "").trim() || null;
  const emailRaw = (process.env.AI_METRICS_RETENTION_ALERT_EMAIL || "").trim();
  const emailRecipients = emailRaw
    ? emailRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  // Reuse `TOOL_HEALTH_APP_URL` so admins only have to set the dashboard
  // base URL once for the whole AI Ops surface; the retention panel lives
  // under the same `/dashboard/ai-ops.html` page (just a different tab).
  const appUrl = (process.env.TOOL_HEALTH_APP_URL || "")
    .trim()
    .replace(/\/+$/, "");
  const link = appUrl
    ? `${appUrl}/dashboard/ai-ops.html?tab=retention`
    : `/dashboard/ai-ops.html?tab=retention`;
  const linkIsAbsolute = /^https?:\/\//i.test(link);
  return { slackChannel, emailRecipients, link, linkIsAbsolute };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatRetentionMrkdwn(v: number | null): string {
  if (v == null) return "_default (env baseline)_";
  return `\`${v}\` day${v === 1 ? "" : "s"}`;
}

function buildBlocks(
  n: AiMetricsRetentionChangeNotification,
  link: string,
  linkIsAbsolute: boolean,
): any[] {
  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: ":hourglass_flowing_sand: AI metrics retention window updated",
        emoji: true,
      },
    },
    { type: "divider" },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Changed by:*\n${n.changedBy || "—"}` },
        {
          type: "mrkdwn",
          text: `*Audit row:*\n${n.audit_id != null ? `#${n.audit_id}` : "—"}`,
        },
      ],
    },
  ];

  // The headline diff. When the operator clears the override the post-change
  // effective value lives in env/default — surface it explicitly so on-call
  // doesn't have to open the dashboard to know what the next prune will use.
  let retentionLine = `*Retention window:* ${formatRetentionMrkdwn(n.before)} → ${formatRetentionMrkdwn(n.after)}`;
  if (n.after == null && n.effectiveAfter != null) {
    retentionLine +=
      `\n_Effective after change:_ \`${n.effectiveAfter}\`` +
      ` day${n.effectiveAfter === 1 ? "" : "s"}`;
  }
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: retentionLine },
  });

  if (n.note) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Note:*\n${n.note}` },
    });
  }

  // Slack rejects relative URLs in actions.button.url; degrade to a plain
  // mrkdwn link section in that case (mirrors the tool-health notifier).
  if (linkIsAbsolute) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Open AI Operations panel",
            emoji: true,
          },
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
        text: ":robot_face: _WalaPlus AI metrics retention | dashboard override saved_",
      },
    ],
  });
  return blocks;
}

function buildEmailHtml(
  n: AiMetricsRetentionChangeNotification,
  link: string,
): string {
  const beforeStr =
    n.before == null
      ? "<em>default (env baseline)</em>"
      : `${escapeHtml(String(n.before))} day${n.before === 1 ? "" : "s"}`;
  const afterStr =
    n.after == null
      ? "<em>default (env baseline)</em>"
      : `${escapeHtml(String(n.after))} day${n.after === 1 ? "" : "s"}`;
  const effective =
    n.after == null && n.effectiveAfter != null
      ? `<p><em>Effective after change: ${escapeHtml(String(n.effectiveAfter))} day${n.effectiveAfter === 1 ? "" : "s"}</em></p>`
      : "";
  const noteHtml = n.note
    ? `<p><strong>Note:</strong><br>${escapeHtml(n.note)}</p>`
    : "";
  return [
    `<h2 style="margin:0 0 12px 0;">AI metrics retention window updated</h2>`,
    `<p><strong>Changed by:</strong> ${escapeHtml(n.changedBy || "—")}<br>`,
    n.audit_id != null
      ? `<strong>Audit row:</strong> #${n.audit_id}</p>`
      : `</p>`,
    `<p><strong>Retention window:</strong> ${beforeStr} &rarr; ${afterStr}</p>`,
    effective,
    noteHtml,
    `<p><a href="${link}">Open the AI Operations panel</a></p>`,
    `<p style="color:#888;font-size:12px;">WalaPlus AI metrics retention | dashboard override saved</p>`,
  ].join("");
}

function buildEmailText(
  n: AiMetricsRetentionChangeNotification,
  link: string,
): string {
  const beforeStr =
    n.before == null
      ? "default (env baseline)"
      : `${n.before} day${n.before === 1 ? "" : "s"}`;
  const afterStr =
    n.after == null
      ? "default (env baseline)"
      : `${n.after} day${n.after === 1 ? "" : "s"}`;
  return [
    "AI metrics retention window updated",
    "",
    `Changed by: ${n.changedBy || "—"}`,
    n.audit_id != null ? `Audit row: #${n.audit_id}` : "",
    "",
    `Retention window: ${beforeStr} -> ${afterStr}`,
    n.after == null && n.effectiveAfter != null
      ? `Effective after change: ${n.effectiveAfter} day${n.effectiveAfter === 1 ? "" : "s"}`
      : "",
    n.note ? `Note: ${n.note}` : "",
    "",
    `Open the AI Operations panel: ${link}`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

/**
 * Post a Slack message and/or send an email summarising a successful
 * AI-metrics-retention save. Best-effort: never throws, returns a result
 * object so the caller can log/count.
 *
 * Safe to call unconditionally — when `AI_METRICS_RETENTION_NOTIFY` is not
 * "1", or when neither Slack nor email is configured, the function returns
 * `{ disabled: true }` / `{ skipped: true }` without sending anything.
 */
export async function notifyAiMetricsRetentionChange(
  notification: AiMetricsRetentionChangeNotification,
  depsOverride: AiMetricsRetentionChangeNotifierDeps = {},
): Promise<NotifyAiMetricsRetentionChangeResult> {
  const result: NotifyAiMetricsRetentionChangeResult = {
    slackSent: false,
    emailSent: false,
    noChanges: false,
    disabled: false,
    skipped: false,
  };

  if (process.env.AI_METRICS_RETENTION_NOTIFY !== "1") {
    result.disabled = true;
    return result;
  }

  const cfg = readConfig();
  if (!cfg.slackChannel && cfg.emailRecipients.length === 0) {
    result.skipped = true;
    return result;
  }

  const before =
    notification.before == null
      ? null
      : Math.floor(Number(notification.before));
  const after =
    notification.after == null ? null : Math.floor(Number(notification.after));
  if (before === after) {
    result.noChanges = true;
    return result;
  }

  if (cfg.slackChannel) {
    const sendSlack = depsOverride.sendSlack ?? sendSlackNotification;
    const fallback =
      `:hourglass_flowing_sand: AI metrics retention window updated by ` +
      `${notification.changedBy || "—"}: ` +
      `${before == null ? "default" : `${before}d`} → ` +
      `${after == null ? "default" : `${after}d`}`;
    try {
      result.slackSent = await sendSlack(
        cfg.slackChannel,
        fallback,
        buildBlocks(notification, cfg.link, cfg.linkIsAbsolute),
      );
    } catch (err) {
      logger.error(
        "[AiMetricsRetentionNotifier] Slack send threw for retention change:",
        err,
      );
      result.slackSent = false;
    }
  }

  if (cfg.emailRecipients.length > 0) {
    const sendEmail = depsOverride.sendEmail ?? sendResendEmail;
    const subject =
      `[AI Metrics Retention · Updated] ` +
      `${before == null ? "default" : `${before}d`} → ` +
      `${after == null ? "default" : `${after}d`} ` +
      `by ${notification.changedBy || "—"}`;
    try {
      const sendResult = await sendEmail({
        to: cfg.emailRecipients,
        subject,
        html: buildEmailHtml(notification, cfg.link),
        text: buildEmailText(notification, cfg.link),
      });
      result.emailSent = !!sendResult?.success;
    } catch (err) {
      logger.error(
        "[AiMetricsRetentionNotifier] Email send threw for retention change:",
        err,
      );
      result.emailSent = false;
    }
  }

  return result;
}
