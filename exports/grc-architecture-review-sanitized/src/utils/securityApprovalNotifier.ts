/**
 * Security-Reviewer Notifier (Task #485)
 *
 * Goal: when an AI-proposed action is enqueued for human approval AND the
 * structural credential detector flagged one or more payload values as
 * credential-shaped, page the configured security reviewer group so the
 * highest-risk submissions are triaged even when nobody is staring at the
 * /ai-approvals dashboard (e.g. overnight, weekends).
 *
 * Wiring:
 *   - `withApprovalGate.ts` calls `notifyCredentialFlaggedApproval()` once
 *     immediately after `enqueuePendingAction()` returns, but ONLY when
 *     `pending.credential_warnings.length > 0`. The wrapper does this
 *     best-effort (swallows errors) so a ChatProvider/EmailProvider outage cannot
 *     prevent the AI tool from queuing the request.
 *
 * Dedupe / spam control:
 *   - `action_code` is unique per row, so the natural single-fire from
 *     calling the notifier exactly once per `enqueuePendingAction` is the
 *     primary mechanism — re-saving (re-INSERTing) the same payload would
 *     allocate a NEW action_code and is therefore a different ticket.
 *   - We additionally keep an in-process throttle map keyed on
 *     `action_code` so a sibling code path that double-fires the notifier
 *     (e.g. retry inside the same process) cannot re-page the same
 *     ticket. This is belt-and-braces: the wrapper's call site only
 *     fires once, but the throttle protects future callers from
 *     accidental spam.
 *
 * Configuration (env-only, both channels optional):
 *   - `SECURITY_REVIEWER_ChatProvider_CHANNEL`         — channel id/name to page.
 *                                                 No fallback to a generic
 *                                                 ChatProvider_CHANNEL_ID, mirroring
 *                                                 the tool-health notifier's
 *                                                 stance: explicit opt-in.
 *   - `SECURITY_REVIEWER_EMAIL`                 — comma-separated recipient
 *                                                 list for the EmailProvider email.
 *   - `SECURITY_REVIEWER_APP_URL`               — public origin used to
 *                                                 build the deep link to
 *                                                 the approval card.
 *                                                 Falls back to a relative
 *                                                 path when unset (dev/test).
 *   - `SECURITY_REVIEWER_NOTIFY_THROTTLE_MIN`   — minutes within which the
 *                                                 same `action_code` will
 *                                                 not be paged twice from
 *                                                 this process. Default 60.
 *
 * The module exposes a small dep-injection surface so unit tests can stub
 * ChatProvider/EmailProvider without touching the real APIs and can reset the throttle
 * map between cases.
 */

import { sendChatProviderNotification } from "./ChatProviderNotifications";
import { sendEmailProviderEmail, type EmailProviderEmailOptions } from "./EmailProviderMail";
import type { CredentialWarning } from "./eventLogsDatabase";
import type { RiskLevel } from "./aiApprovalDatabase";
import { logger } from "./logger";

export interface CredentialFlaggedApprovalNotification {
  /** Approval-row ticket code (e.g. APR-20260425-AB12CD). Used as dedupe key. */
  action_code: string;
  /** Mastra tool id (e.g. `create_nonconformance`). Identifies WHAT was proposed. */
  tool_id: string;
  /** Human-readable tool label from the policy. */
  tool_label: string;
  /** Risk tier of the gated tool ("low" / "medium" / "high" / "critical"). */
  risk_level: RiskLevel;
  /** Submitter user id (null when called from a system / cron context). */
  requested_by_user_id: number | null;
  /** Submitter email (null when unknown). */
  requested_by_email: string | null;
  /** Submitter display name (null when unknown). */
  requested_by_name: string | null;
  /**
   * Structured warnings emitted by `detectCredentialLikeFields()` at
   * submission time. We surface ONLY the field paths (and pattern labels)
   * to the notification — the raw secret values are already redacted in
   * the persisted row and must NOT be re-leaked into ChatProvider/email.
   */
  credential_warnings: <REDACTED_SECRET>
}

export interface NotifyCredentialFlaggedApprovalResult {
  ChatProviderSent: boolean;
  emailSent: boolean;
  /** True when the throttle map blocked the page entirely. */
  throttled: boolean;
  /** True when neither ChatProvider nor email is configured. */
  skipped: boolean;
}

export interface SecurityApprovalNotifierDeps {
  /** Defaults to `sendChatProviderNotification`. */
  sendChatProvider?: typeof sendChatProviderNotification;
  /** Defaults to `sendEmailProviderEmail`. */
  sendEmail?: (
    opts: EmailProviderEmailOptions,
  ) => Promise<{ success: boolean; id?: string; error?: string }>;
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

interface NotifierConfig {
  ChatProviderChannel: string | null;
  emailRecipients: string[];
  appUrl: string;
  throttleMs: number;
}

function readConfig(): NotifierConfig {
  const ChatProviderChannel =
    (process.env.SECURITY_REVIEWER_ChatProvider_CHANNEL || "").trim() || null;
  const emailRaw = (process.env.SECURITY_REVIEWER_EMAIL || "").trim();
  const emailRecipients = emailRaw
    ? emailRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const appUrl = (process.env.SECURITY_REVIEWER_APP_URL || "")
    .trim()
    .replace(/\/+$/, "");
  return {
    ChatProviderChannel,
    emailRecipients,
    appUrl,
    throttleMs: envInt("SECURITY_REVIEWER_NOTIFY_THROTTLE_MIN", 60) * 60_000,
  };
}

/**
 * Build the deep link to the specific approval card. When
 * SECURITY_REVIEWER_APP_URL is unset we still emit a relative path so the
 * email/ChatProvider body shows ops which page to open, even if it is not
 * directly clickable. The `code` query string parameter is consumed by
 * the dashboard JS to auto-open the detail modal for that row.
 */
function buildDeepLink(actionCode: string, appUrl: string): string {
  const path = `/ai-approvals?code=${encodeURIComponent(actionCode)}`;
  return appUrl ? `${appUrl}${path}` : path;
}

function isAbsoluteUrl(link: string): boolean {
  return /^https?:\/\//i.test(link);
}

// ──────────────────────────────────────────────────────────────────────────────
// In-process throttle map (belt-and-braces; primary dedupe is the unique
// action_code allocated by enqueuePendingAction). Keyed on action_code,
// value is the epoch ms of the last successful page.
// ──────────────────────────────────────────────────────────────────────────────
const lastNotifiedAt = new Map<string, number>();

/** Visible to tests so each case starts with a clean throttle window. */
export function _resetSecurityApprovalNotifierThrottleForTests(): void {
  lastNotifiedAt.clear();
}

// ──────────────────────────────────────────────────────────────────────────────
// Renderers
// ──────────────────────────────────────────────────────────────────────────────
function riskEmoji(risk: RiskLevel): string {
  switch (risk) {
    case "critical":
      return ":rotating_light:";
    case "high":
      return ":red_circle:";
    case "medium":
      return ":large_orange_circle:";
    case "low":
      return ":large_yellow_circle:";
    default:
      return ":warning:";
  }
}

function describeRequester(
  n: CredentialFlaggedApprovalNotification,
): string {
  if (n.requested_by_name && n.requested_by_email) {
    return `${n.requested_by_name} <${n.requested_by_email}>`;
  }
  if (n.requested_by_name) return n.requested_by_name;
  if (n.requested_by_email) return n.requested_by_email;
  if (n.requested_by_user_id != null) return `user #${n.requested_by_user_id}`;
  return "unknown (system / cron)";
}

function summariseWarningPaths(warnings: CredentialWarning[]): string {
  if (!warnings || warnings.length === 0) return "(none)";
  const paths = warnings.slice(0, 5).map((w) => w.path).filter(Boolean);
  const more = warnings.length > 5 ? ` (+${warnings.length - 5} more)` : "";
  return paths.length > 0 ? `${paths.join(", ")}${more}` : `(${warnings.length})`;
}

function buildChatProviderBlocks(
  n: CredentialFlaggedApprovalNotification,
  link: string,
  linkAbsolute: boolean,
): any[] {
  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `:warning: Credential-shaped value in approval ${n.action_code}`,
        emoji: true,
      },
    },
    { type: "divider" },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Action code:*\n\`${n.action_code}\`` },
        { type: "mrkdwn", text: `*Tool:*\n\`${n.tool_id}\`` },
        {
          type: "mrkdwn",
          text: `*Risk:*\n${riskEmoji(n.risk_level)} ${n.risk_level.toUpperCase()}`,
        },
        {
          type: "mrkdwn",
          text: `*Requested by:*\n${describeRequester(n)}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Flagged field paths:*\n\`${summariseWarningPaths(n.credential_warnings)}\`\n` +
          `_The submitted payload contained ${n.credential_warnings.length} value(s) that look like credentials. ` +
          `The raw secrets have already been redacted in the audit row; please review the approval card and coach the requester to use the secret store._`,
      },
    },
  ];

  // ChatProvider rejects actions.button blocks with relative URLs — degrade to a
  // plain mrkdwn link in dev/test environments where the public origin
  // env var is unset.
  if (linkAbsolute) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Open approval card",
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
          `:link: Approval card: \`${link}\`\n` +
          `_Set \`SECURITY_REVIEWER_APP_URL\` to enable a clickable link._`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text:
          `:robot_face: _ExampleOrg security reviewer notifier | tool: ${n.tool_label}_`,
      },
    ],
  });
  return blocks;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildEmailHtml(
  n: CredentialFlaggedApprovalNotification,
  link: string,
): string {
  const linkHtml = `<a href="${escapeHtml(link)}">Open approval card ${escapeHtml(n.action_code)}</a>`;
  return [
    `<h2 style="margin:0 0 12px 0;">Credential-shaped value detected in approval ${escapeHtml(n.action_code)}</h2>`,
    `<p><strong>Action code:</strong> <code>${escapeHtml(n.action_code)}</code><br>`,
    `<strong>Tool:</strong> <code>${escapeHtml(n.tool_id)}</code> (${escapeHtml(n.tool_label)})<br>`,
    `<strong>Risk:</strong> ${escapeHtml(n.risk_level.toUpperCase())}<br>`,
    `<strong>Requested by:</strong> ${escapeHtml(describeRequester(n))}</p>`,
    `<p><strong>Flagged field paths:</strong><br>` +
      `<code>${escapeHtml(summariseWarningPaths(n.credential_warnings))}</code></p>`,
    `<p>The submitted payload contained <strong>${n.credential_warnings.length}</strong> ` +
      `value(s) that look like credentials. The raw secrets have already been ` +
      `redacted in the persisted approval row; please open the approval card to ` +
      `triage and coach the requester to use the secret store rather than ` +
      `pasting raw credentials into chat.</p>`,
    `<p>${linkHtml}</p>`,
  ].join("");
}

function buildEmailText(
  n: CredentialFlaggedApprovalNotification,
  link: string,
): string {
  return [
    `Credential-shaped value detected in approval ${n.action_code}`,
    "",
    `Action code: ${n.action_code}`,
    `Tool: ${n.tool_id} (${n.tool_label})`,
    `Risk: ${n.risk_level.toUpperCase()}`,
    `Requested by: ${describeRequester(n)}`,
    "",
    `Flagged field paths: ${summariseWarningPaths(n.credential_warnings)}`,
    "",
    `The submitted payload contained ${n.credential_warnings.length} value(s) ` +
      `that look like credentials. The raw secrets have already been redacted ` +
      `in the persisted approval row; please open the approval card to triage ` +
      `and coach the requester to use the secret store rather than pasting ` +
      `raw credentials into chat.`,
    "",
    `Open approval card: ${link}`,
  ].join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Public entry point
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Page security reviewers about a freshly-enqueued approval whose payload
 * tripped the structural credential detector.
 *
 * Safe to call unconditionally: when neither ChatProvider nor email is configured
 * the function returns `{ skipped: true }` without throwing, so the
 * approval gate does not need to special-case dev/test environments.
 *
 * Best-effort: callers should also `.catch()` the returned promise so a
 * ChatProvider/EmailProvider outage cannot abort the enqueue path. The internal ChatProvider
 * and email send sites already swallow exceptions and set the
 * corresponding flag to `false`; this guarantee is part of the contract.
 */
export async function notifyCredentialFlaggedApproval(
  notification: CredentialFlaggedApprovalNotification,
  depsOverride: SecurityApprovalNotifierDeps = {},
): Promise<NotifyCredentialFlaggedApprovalResult> {
  const cfg = readConfig();
  const sendChatProvider = depsOverride.sendChatProvider ?? sendChatProviderNotification;
  const sendEmail = depsOverride.sendEmail ?? sendEmailProviderEmail;
  const nowFn = depsOverride.now ?? Date.now;

  const result: NotifyCredentialFlaggedApprovalResult = {
    ChatProviderSent: false,
    emailSent: false,
    throttled: false,
    skipped: false,
  };

  // Defensive: a notifier called with no warnings has nothing to say.
  // Returning skipped=true (rather than silently sending an empty page)
  // makes it obvious in tests if a wiring change forgets the guard.
  if (
    !Array.isArray(notification.credential_warnings) ||
    notification.credential_warnings.length === 0
  ) {
    result.skipped = true;
    return result;
  }

  if (!cfg.ChatProviderChannel && cfg.emailRecipients.length === 0) {
    // Nothing configured — explicit skip so callers can log/count.
    result.skipped = true;
    return result;
  }

  const now = nowFn();
  const key = notification.action_code;

  if (cfg.throttleMs > 0) {
    const lastAt = lastNotifiedAt.get(key);
    if (lastAt != null && now - lastAt < cfg.throttleMs) {
      result.throttled = true;
      return result;
    }
    // Reserve the slot BEFORE sending so a concurrent caller for the same
    // action_code in this process is short-circuited even if our send is
    // still in flight.
    lastNotifiedAt.set(key, now);
  }

  const link = buildDeepLink(notification.action_code, cfg.appUrl);
  const linkAbsolute = isAbsoluteUrl(link);

  if (cfg.ChatProviderChannel) {
    const fallback =
      `:warning: Credential-shaped value in approval ${notification.action_code} ` +
      `(tool: ${notification.tool_id}, risk: ${notification.risk_level.toUpperCase()})`;
    try {
      result.ChatProviderSent = await sendChatProvider(
        cfg.ChatProviderChannel,
        fallback,
        buildChatProviderBlocks(notification, link, linkAbsolute),
      );
    } catch (err) {
      logger.error(
        `[SecurityApprovalNotifier] ChatProvider send threw for ${notification.action_code}:`,
        err,
      );
      result.ChatProviderSent = false;
    }
  }

  if (cfg.emailRecipients.length > 0) {
    try {
      const sendResult = await sendEmail({
        to: cfg.emailRecipients,
        subject:
          `[Security Review · ${notification.risk_level.toUpperCase()}] ` +
          `Credential-shaped value in approval ${notification.action_code}`,
        html: buildEmailHtml(notification, link),
        text: buildEmailText(notification, link),
      });
      result.emailSent = !!sendResult?.success;
    } catch (err) {
      logger.error(
        `[SecurityApprovalNotifier] Email send threw for ${notification.action_code}:`,
        err,
      );
      result.emailSent = false;
    }
  }

  return result;
}
