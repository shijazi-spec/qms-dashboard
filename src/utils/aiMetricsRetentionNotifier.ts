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
 *   - `AI_METRICS_RETENTION_NOTIFY`        — must be "1" to opt in to
 *                                            config-change (PUT) notifications.
 *   - `AI_METRICS_RETENTION_PRUNE_NOTIFY`  — must be "1" to opt in to
 *                                            manual "Prune now" notifications
 *                                            (Task #644). Independent of the
 *                                            PUT notify knob so an ops team
 *                                            can choose to be paged on one
 *                                            but not the other.
 *   - `AI_METRICS_RETENTION_SLACK_CHANNEL` — Slack channel id/name to page.
 *                                            Shared by both notifiers.
 *   - `AI_METRICS_RETENTION_ALERT_EMAIL`   — comma-separated recipient list
 *                                            forwarded to Resend. Shared by
 *                                            both notifiers.
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
        "[AiMetricsRetentionNotifier] Slack send threw for retention change",
        err as Error,
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
        "[AiMetricsRetentionNotifier] Email send threw for retention change",
        err as Error,
      );
      result.emailSent = false;
    }
  }

  return result;
}

/* -------------------------------------------------------------------------- *
 *  Manual "Prune now" notifier (Task #644)
 * -------------------------------------------------------------------------- *
 * Task #558 added a "Prune now" button on the AI Ops dashboard that
 * immediately deletes telemetry rows outside the retention window and
 * writes a database audit row. The PUT-config notifier above does NOT
 * fire for that path because a prune is not a config-value change.
 *
 * However, an immediate manual deletion of telemetry is operationally
 * as significant as a config change — ops teams reviewing Slack history
 * during an incident currently won't see that someone clicked Prune
 * now until they go look at the audit timeline. This peer notifier
 * closes that gap on an opt-in basis (gated by
 * `AI_METRICS_RETENTION_PRUNE_NOTIFY=1`) so existing deployments stay
 * silent unless explicitly turned on.
 *
 * Same resilience contract as `notifyAiMetricsRetentionChange`:
 *   - Best-effort, never throws back to the caller.
 *   - Skipped when neither Slack nor email is configured (route handler
 *     can call us unconditionally without paging on-call from a fresh
 *     checkout).
 *   - The PUT "no-op when before === after" rule does NOT apply here:
 *     every successful manual prune click is operationally noteworthy,
 *     even when the deleted-rows count is 0 (the operator confirmed
 *     there was nothing to delete — that's still useful audit context).
 *  -------------------------------------------------------------------------- */

export interface AiMetricsRetentionPruneNowNotification {
  /** Operator who clicked Prune now (display name / email / "user:<id>"). */
  changedBy: string;
  /** Effective retention window in days used for the prune. */
  retentionDays: number;
  /**
   * Rows the dry-run preview said would be deleted. `null` when the
   * preview itself failed (the route handler still runs the prune in
   * that case and reports `previewed_rows: null` to the dashboard).
   */
  previewedRows: number | null;
  /** Rows actually deleted by `pruneOldAiMetrics()`. */
  deletedRows: number;
  /** Optional free-form note from the operator (already length-capped). */
  note?: string | null;
  /** Audit-row id from `ai_metrics_retention_audit` for traceability. */
  audit_id?: number | null;
}

export interface NotifyAiMetricsRetentionPruneNowResult {
  slackSent: boolean;
  emailSent: boolean;
  /** True when `AI_METRICS_RETENTION_PRUNE_NOTIFY` is not opted in. */
  disabled: boolean;
  /** True when neither Slack nor email is configured. */
  skipped: boolean;
}

/**
 * Compute previewed-vs-actual drift. Surfaced explicitly in the
 * Slack/email body so on-call doesn't have to do the subtraction
 * by hand when reviewing the message during an incident. Returns
 * `null` when the preview was unavailable (preview itself failed).
 */
function computePruneDrift(
  previewedRows: number | null,
  deletedRows: number,
): number | null {
  if (previewedRows == null) return null;
  return deletedRows - previewedRows;
}

function formatPruneDriftMrkdwn(drift: number | null): string {
  if (drift == null) return "_preview unavailable_";
  if (drift === 0) return "`0` (preview matched actual)";
  const sign = drift > 0 ? "+" : "";
  return `\`${sign}${drift}\` row${Math.abs(drift) === 1 ? "" : "s"}`;
}

function buildPruneNowBlocks(
  n: AiMetricsRetentionPruneNowNotification,
  link: string,
  linkIsAbsolute: boolean,
): any[] {
  const drift = computePruneDrift(n.previewedRows, n.deletedRows);
  const previewedStr =
    n.previewedRows == null ? "_unavailable_" : `\`${n.previewedRows}\``;
  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: ":wastebasket: AI metrics manual prune executed",
        emoji: true,
      },
    },
    { type: "divider" },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Operator:*\n${n.changedBy || "—"}` },
        {
          type: "mrkdwn",
          text: `*Audit row:*\n${n.audit_id != null ? `#${n.audit_id}` : "—"}`,
        },
        {
          type: "mrkdwn",
          text: `*Retention window:*\n\`${n.retentionDays}\` day${n.retentionDays === 1 ? "" : "s"}`,
        },
        {
          type: "mrkdwn",
          text: `*Previewed rows:*\n${previewedStr}`,
        },
        {
          type: "mrkdwn",
          text: `*Deleted rows:*\n\`${n.deletedRows}\``,
        },
        {
          type: "mrkdwn",
          text: `*Drift (deleted - previewed):*\n${formatPruneDriftMrkdwn(drift)}`,
        },
      ],
    },
  ];

  if (n.note) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Note:*\n${n.note}` },
    });
  }

  // Slack rejects relative URLs in actions.button.url; degrade to a plain
  // mrkdwn link section in that case (mirrors the PUT-config notifier).
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
        text:
          ":robot_face: _WalaPlus AI metrics retention | manual prune executed_",
      },
    ],
  });
  return blocks;
}

function buildPruneNowEmailHtml(
  n: AiMetricsRetentionPruneNowNotification,
  link: string,
): string {
  const drift = computePruneDrift(n.previewedRows, n.deletedRows);
  const previewedStr =
    n.previewedRows == null
      ? "<em>unavailable</em>"
      : escapeHtml(String(n.previewedRows));
  const driftStr =
    drift == null
      ? "<em>preview unavailable</em>"
      : drift === 0
        ? "0 (preview matched actual)"
        : `${drift > 0 ? "+" : ""}${drift} row${Math.abs(drift) === 1 ? "" : "s"}`;
  const noteHtml = n.note
    ? `<p><strong>Note:</strong><br>${escapeHtml(n.note)}</p>`
    : "";
  return [
    `<h2 style="margin:0 0 12px 0;">AI metrics manual prune executed</h2>`,
    `<p><strong>Operator:</strong> ${escapeHtml(n.changedBy || "—")}<br>`,
    n.audit_id != null
      ? `<strong>Audit row:</strong> #${n.audit_id}</p>`
      : `</p>`,
    `<p><strong>Retention window:</strong> ${escapeHtml(String(n.retentionDays))} day${n.retentionDays === 1 ? "" : "s"}</p>`,
    `<p><strong>Previewed rows:</strong> ${previewedStr}<br>`,
    `<strong>Deleted rows:</strong> ${escapeHtml(String(n.deletedRows))}<br>`,
    `<strong>Drift (deleted - previewed):</strong> ${driftStr}</p>`,
    noteHtml,
    `<p><a href="${link}">Open the AI Operations panel</a></p>`,
    `<p style="color:#888;font-size:12px;">WalaPlus AI metrics retention | manual prune executed</p>`,
  ].join("");
}

function buildPruneNowEmailText(
  n: AiMetricsRetentionPruneNowNotification,
  link: string,
): string {
  const drift = computePruneDrift(n.previewedRows, n.deletedRows);
  const previewedStr = n.previewedRows == null
    ? "unavailable"
    : String(n.previewedRows);
  const driftStr =
    drift == null
      ? "preview unavailable"
      : drift === 0
        ? "0 (preview matched actual)"
        : `${drift > 0 ? "+" : ""}${drift} row${Math.abs(drift) === 1 ? "" : "s"}`;
  return [
    "AI metrics manual prune executed",
    "",
    `Operator: ${n.changedBy || "—"}`,
    n.audit_id != null ? `Audit row: #${n.audit_id}` : "",
    "",
    `Retention window: ${n.retentionDays} day${n.retentionDays === 1 ? "" : "s"}`,
    `Previewed rows: ${previewedStr}`,
    `Deleted rows: ${n.deletedRows}`,
    `Drift (deleted - previewed): ${driftStr}`,
    n.note ? `Note: ${n.note}` : "",
    "",
    `Open the AI Operations panel: ${link}`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

/**
 * Post a Slack message and/or send an email summarising a successful
 * manual "Prune now" run. Best-effort: never throws, returns a result
 * object so the caller can log/count.
 *
 * Safe to call unconditionally — when `AI_METRICS_RETENTION_PRUNE_NOTIFY`
 * is not "1", or when neither Slack nor email is configured, the
 * function returns `{ disabled: true }` / `{ skipped: true }` without
 * sending anything.
 *
 * Unlike the PUT-config notifier this DOES fire even when
 * `deletedRows === 0` — every manual prune click is operationally
 * noteworthy because an operator deliberately confirmed the action.
 */
export async function notifyAiMetricsRetentionPruneNow(
  notification: AiMetricsRetentionPruneNowNotification,
  depsOverride: AiMetricsRetentionChangeNotifierDeps = {},
): Promise<NotifyAiMetricsRetentionPruneNowResult> {
  const result: NotifyAiMetricsRetentionPruneNowResult = {
    slackSent: false,
    emailSent: false,
    disabled: false,
    skipped: false,
  };

  if (process.env.AI_METRICS_RETENTION_PRUNE_NOTIFY !== "1") {
    result.disabled = true;
    return result;
  }

  const cfg = readConfig();
  if (!cfg.slackChannel && cfg.emailRecipients.length === 0) {
    result.skipped = true;
    return result;
  }

  const drift = computePruneDrift(
    notification.previewedRows,
    notification.deletedRows,
  );

  if (cfg.slackChannel) {
    const sendSlack = depsOverride.sendSlack ?? sendSlackNotification;
    const previewedStr =
      notification.previewedRows == null
        ? "?"
        : String(notification.previewedRows);
    const driftFallback =
      drift == null
        ? ""
        : drift === 0
          ? " (preview matched)"
          : ` (drift ${drift > 0 ? "+" : ""}${drift})`;
    const fallback =
      `:wastebasket: AI metrics manual prune by ` +
      `${notification.changedBy || "—"}: ` +
      `deleted ${notification.deletedRows} row` +
      `${notification.deletedRows === 1 ? "" : "s"}` +
      ` (previewed ${previewedStr}${driftFallback}, ` +
      `${notification.retentionDays}d window)`;
    try {
      result.slackSent = await sendSlack(
        cfg.slackChannel,
        fallback,
        buildPruneNowBlocks(notification, cfg.link, cfg.linkIsAbsolute),
      );
    } catch (err) {
      console.error(
        "[AiMetricsRetentionNotifier] Slack send threw for manual prune:",
        err,
      );
      result.slackSent = false;
    }
  }

  if (cfg.emailRecipients.length > 0) {
    const sendEmail = depsOverride.sendEmail ?? sendResendEmail;
    const subject =
      `[AI Metrics Retention · Pruned] ` +
      `${notification.deletedRows} row` +
      `${notification.deletedRows === 1 ? "" : "s"}` +
      ` (${notification.retentionDays}d window) ` +
      `by ${notification.changedBy || "—"}`;
    try {
      const sendResult = await sendEmail({
        to: cfg.emailRecipients,
        subject,
        html: buildPruneNowEmailHtml(notification, cfg.link),
        text: buildPruneNowEmailText(notification, cfg.link),
      });
      result.emailSent = !!sendResult?.success;
    } catch (err) {
      console.error(
        "[AiMetricsRetentionNotifier] Email send threw for manual prune:",
        err,
      );
      result.emailSent = false;
    }
  }

  return result;
}
