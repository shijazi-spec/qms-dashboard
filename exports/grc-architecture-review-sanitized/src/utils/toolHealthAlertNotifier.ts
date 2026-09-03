/**
 * Tool-Health Alert Notifier
 *
 * Goal: when the per-tool health cron opens a NEW `tool_health` alert, page
 * on-call via ChatProvider and/or email so the breach is noticed even when nobody
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
 *   - `TOOL_HEALTH_ChatProvider_CHANNEL`        — ChatProvider channel id/name to page.
 *                                          Falls back to `ChatProvider_CHANNEL_ID`
 *                                          only when explicitly opted-in
 *                                          via `TOOL_HEALTH_ChatProvider_USE_DEFAULT_CHANNEL=1`,
 *                                          to avoid accidentally posting
 *                                          tool-health alerts to the QMS
 *                                          channel.
 *   - `TOOL_HEALTH_ALERT_EMAIL`          — comma-separated recipient list
 *                                          for the EmailProvider email.
 *   - `TOOL_HEALTH_NOTIFY_THROTTLE_MIN`  — minutes within which the same
 *                                          `<tool_name>:<reason>` key will
 *                                          not be paged twice. Default 60.
 *   - `TOOL_HEALTH_APP_URL`              — public origin used to build the
 *                                          link back to the AI Operations
 *                                          panel. When unset we emit a
 *                                          relative path.
 *
 * The module exposes a small dep-injection surface so unit tests can
 * stub ChatProvider/EmailProvider without touching the real APIs and can reset the
 * throttle map between runs.
 */

import { sendChatProviderNotification, postChatProviderMessage } from "./ChatProviderNotifications";
import { sendEmailProviderEmail, type EmailProviderEmailOptions } from "./EmailProviderMail";
import {
  type AlertSeverity,
  claimToolHealthNotifySlot,
  recordAlertNotificationResult,
} from "./aiAlertsDatabase";
import type {
  ToolHealthConfigOverrides,
  ToolHealthConfigAuditEntry,
  ToolHealthAuditBreachDiff,
} from "./toolHealthConfigDatabase";

import { logger } from "./logger";
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
  ChatProviderSent: boolean;
  emailSent: boolean;
  /** True when the throttle map blocked the page entirely. */
  throttled: boolean;
  /** True when neither ChatProvider nor email is configured. */
  skipped: boolean;
}

export interface ToolHealthNotifierDeps {
  /** Defaults to `sendChatProviderNotification`. */
  sendChatProvider?: typeof sendChatProviderNotification;
  /** Defaults to `sendEmailProviderEmail`. */
  sendEmail?: (
    opts: EmailProviderEmailOptions,
  ) => Promise<{ success: boolean; id?: string; error?: string }>;
  /** Defaults to `Date.now`. Tests inject a deterministic clock. */
  now?: () => number;
  /**
   * Atomically claim the "notify slot" in the DB for the given key.
   * Returns `true` when this caller wins the slot and may send the page;
   * `false` when a sibling already paged within the throttle window.
   * Tests inject a stub so no real DB connection is required.
   * Defaults to `claimToolHealthNotifySlot`.
   */
  claimDb?: (
    notificationKey: string,
    nowMs: number,
    throttleMs: number,
  ) => Promise<boolean>;
  /**
   * Persist the on-call notification delivery result on the matching
   * `ai_alerts` row so the dashboard can render a "Notified" column
   * (Task #284). Defaults to `recordAlertNotificationResult`. Tests
   * inject a stub to assert the channel label/timestamp without touching
   * the DB.
   */
  recordResult?: (
    alertId: number | null | undefined,
    channel: string,
    whenMs: number,
  ) => Promise<void>;
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
  const useDefaultChatProvider =
    process.env.TOOL_HEALTH_ChatProvider_USE_DEFAULT_CHANNEL === "1";
  const ChatProviderChannel =
    (process.env.TOOL_HEALTH_ChatProvider_CHANNEL || "").trim() ||
    (useDefaultChatProvider
      ? (process.env.ChatProvider_CHANNEL_ID || "").trim() || null
      : null) ||
    null;
  const emailRaw = (process.env.TOOL_HEALTH_ALERT_EMAIL || "").trim();
  const emailRecipients = emailRaw
    ? emailRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const appUrl = (process.env.TOOL_HEALTH_APP_URL || "")
    .trim()
    .replace(/\/+$/, "");
  // `link` is always emit-able (relative when no base URL is set); `linkIsAbsolute`
  // gates ChatProvider's action button — ChatProvider rejects blocks whose button.url is a
  // relative path, so we degrade to a plain mrkdwn link in that case.
  // The AI Operations page was retired; point recipients at the main
  // dashboard instead. The legacy `?tab=…` query suffix appended further
  // down is harmless on /dashboard (the param is just ignored).
  const link = appUrl
    ? `${appUrl}/dashboard`
    : `/dashboard`;
  const linkIsAbsolute = /^https?:\/\//i.test(link);
  return {
    ChatProviderChannel: ChatProviderChannel || null,
    emailRecipients,
    link,
    linkIsAbsolute,
    throttleMs: envInt("TOOL_HEALTH_NOTIFY_THROTTLE_MIN", 60) * 60_000,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Throttle map (in-process). Keyed on `<tool_name>:<reason>`, value is the
// epoch ms at which the last successful page was sent. The cron's DB-level
// dedupe (LLMProvider_alerts row) is the primary mechanism — this is a safety
// net so a flapping breach can't double-page the same key within the
// configured window.
// ──────────────────────────────────────────────────────────────────────────────
const lastNotifiedAt = new Map<string, number>();

/** Visible to tests so each case starts with a clean throttle window. */
export function _resetToolHealthNotifierThrottleForTests(): void {
  lastNotifiedAt.clear();
}

// ──────────────────────────────────────────────────────────────────────────────
// Recovery notification opt-out (Task #347)
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Treat the value as a deliberate "off" for `TOOL_HEALTH_RECOVERY_NOTIFY`.
 * We accept the common falsy spellings (`0`, `false`, `no`, `off`,
 * case-insensitive) so operators don't have to remember a single magic
 * string. Everything else — including unset, empty, `1`, `true` — leaves
 * recovery pages enabled, preserving the historical default.
 */
function isExplicitlyOff(raw: string | undefined): boolean {
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

/**
 * Returns `true` when recovery notifications must be suppressed for
 * `toolName`, either because the global `TOOL_HEALTH_RECOVERY_NOTIFY`
 * gate is off or because the tool appears in the comma-separated
 * `TOOL_HEALTH_RECOVERY_SKIP_TOOLS` list.
 *
 * Exported for unit tests; production callers should go through
 * {@link notifyToolHealthRecovery} which already consults this helper.
 */
export function recoveryNotificationsDisabled(toolName: string): boolean {
  if (isExplicitlyOff(process.env.TOOL_HEALTH_RECOVERY_NOTIFY)) return true;
  const skipRaw = (process.env.TOOL_HEALTH_RECOVERY_SKIP_TOOLS || "").trim();
  if (!skipRaw) return false;
  const needle = toolName.trim().toLowerCase();
  if (!needle) return false;
  return skipRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .some((entry) => entry !== "" && entry === needle);
}

// ──────────────────────────────────────────────────────────────────────────────
// Renderers
// ──────────────────────────────────────────────────────────────────────────────
function severityEmoji(sev: AlertSeverity): string {
  switch (sev) {
    case "critical":
      return ":rotating_light:";
    case "high":
      return ":red_circle:";
    case "medium":
      return ":large_orange_circle:";
    case "low":
      return ":large_yellow_circle:";
    case "info":
      return ":information_source:";
    default:
      return ":warning:";
  }
}

function reasonLabel(reason: ToolHealthReason): string {
  return reason === "error_rate" ? "Error rate" : "P95 latency";
}

function buildChatProviderBlocks(
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
  // ChatProvider's `actions.button.url` REQUIRES an absolute URL — posting a
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
          text: {
            type: "plain_text",
            text: "LLMProvider Operations panel",
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
          `:robot_face: _ExampleOrg tool-health monitor | dedupe key: ` +
          `\`${n.related_record_id}\`${n.alert_id != null ? ` | alert #${n.alert_id}` : ""}_`,
      },
    ],
  });
  return blocks;
}

function buildEmailHtml(n: ToolHealthBreachNotification, link: string): string {
  const linkHtml = `<a href="${link}">Open the AI Operations panel</a>`;
  const suggestionHtml = n.suggestion
    ? `<p><strong>Suggested action:</strong><br>${escapeHtml(n.suggestion)}</p>`
    : "";
  return [
    `<h2 style="margin:0 0 12px 0;">${escapeHtml(n.title)}</h2>`,
    `<p><strong>Tool:</strong> <code>${escapeHtml(n.tool_name)}</code><br>`,
    `<strong>Reason:</strong> ${reasonLabel(n.reason)}<br>`,
    `<strong>Severity:</strong> ${n.severity.toUpperCase()}<br>`,
    n.agent_name
      ? `<strong>Agent:</strong> ${escapeHtml(n.agent_name)}<br>`
      : "",
    `</p>`,
    `<p><strong>Details:</strong><br>${escapeHtml(n.description)}</p>`,
    suggestionHtml,
    `<p>${linkHtml}</p>`,
    `<p style="color:#888;font-size:12px;">Dedupe key: <code>${escapeHtml(n.related_record_id)}</code>` +
      (n.alert_id != null ? ` &middot; alert #${n.alert_id}` : "") +
      `</p>`,
  ].join("");
}

function buildEmailText(n: ToolHealthBreachNotification, link: string): string {
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
 * Safe to call unconditionally: when neither ChatProvider nor email is configured
 * the function returns `{ skipped: true }` without throwing, so the cron
 * does not need to special-case dev/test environments.
 */
export async function notifyToolHealthBreach(
  notification: ToolHealthBreachNotification,
  depsOverride: ToolHealthNotifierDeps = {},
): Promise<NotifyToolHealthBreachResult> {
  const cfg = readConfig();
  const sendChatProvider = depsOverride.sendChatProvider ?? sendChatProviderNotification;
  const sendEmail = depsOverride.sendEmail ?? sendEmailProviderEmail;
  const nowFn = depsOverride.now ?? Date.now;
  const claimDb = depsOverride.claimDb ?? claimToolHealthNotifySlot;
  const recordResult =
    depsOverride.recordResult ?? recordAlertNotificationResult;

  const result: NotifyToolHealthBreachResult = {
    ChatProviderSent: false,
    emailSent: false,
    throttled: false,
    skipped: false,
  };

  // Best-effort recorder: persist the outcome on the matching ai_alerts
  // row so the AI Operations panel can render a "Notified" column. Wraps
  // the injected callback in a try/catch so a transient DB write failure
  // never escapes back to the cron — the page itself has already been
  // attempted, and a failed UPDATE merely leaves the dashboard column
  // showing the previous (or NULL) value until the next paging attempt.
  const persist = async (channel: string): Promise<void> => {
    try {
      await recordResult(notification.alert_id ?? null, channel, nowFn());
    } catch (err) {
      logger.error(
        `[ToolHealthNotifier] recordResult threw for ${notification.related_record_id}:`,
        err,
      );
    }
  };

  if (!cfg.ChatProviderChannel && cfg.emailRecipients.length === 0) {
    // Nothing configured — explicitly mark as skipped so callers can log/count.
    // Persist 'not_configured' so the dashboard can surface a warning that
    // ops needs to set TOOL_HEALTH_ChatProvider_CHANNEL / TOOL_HEALTH_ALERT_EMAIL.
    result.skipped = true;
    await persist("not_configured");
    return result;
  }

  const now = nowFn();
  const key = notification.related_record_id;

  if (cfg.throttleMs > 0) {
    // Fast path: in-process map has a recent timestamp for THIS instance.
    // Avoids the DB round-trip when we know we just paged this key.
    const inProcessLastAt = lastNotifiedAt.get(key);
    if (inProcessLastAt != null && now - inProcessLastAt < cfg.throttleMs) {
      result.throttled = true;
      await persist("throttled");
      return result;
    }

    // Atomic DB claim: a single statement both checks and records the intent
    // to page, serialised by Postgres so that sibling instances (or this
    // instance after a restart) cannot double-page within the throttle window.
    // If claimDb returns false, a sibling already holds the slot — skip.
    // If the DB is unavailable we fall through and send (in-process cache
    // remains as the safety net for this instance's session).
    let claimed = true;
    try {
      claimed = await claimDb(key, now, cfg.throttleMs);
    } catch (err) {
      logger.error(`[ToolHealthNotifier] DB claimDb threw for ${key}:`, err);
    }
    if (!claimed) {
      // Update in-process map with the approximate time another instance paged
      // so subsequent calls skip the DB round-trip for the rest of this window.
      lastNotifiedAt.set(key, now);
      result.throttled = true;
      await persist("throttled");
      return result;
    }

    // Slot claimed in DB — update in-process map immediately so subsequent
    // calls on this instance take the fast path for the rest of the window.
    lastNotifiedAt.set(key, now);
  }

  if (cfg.ChatProviderChannel) {
    const fallback =
      `${severityEmoji(notification.severity)} Tool health alert: ` +
      `${notification.tool_name} — ${reasonLabel(notification.reason)} ` +
      `(${notification.severity.toUpperCase()})`;
    try {
      result.ChatProviderSent = await sendChatProvider(
        cfg.ChatProviderChannel,
        fallback,
        buildChatProviderBlocks(notification, cfg.link, cfg.linkIsAbsolute),
      );
    } catch (err) {
      logger.error(
        `[ToolHealthNotifier] ChatProvider send threw for ${notification.related_record_id}:`,
        err,
      );
      result.ChatProviderSent = false;
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
      logger.error(
        `[ToolHealthNotifier] Email send threw for ${notification.related_record_id}:`,
        err,
      );
      result.emailSent = false;
    }
  }

  // Compute the channel label for persistence. Knowing what was *configured*
  // vs what *actually delivered* matters: an "email_only" outcome with ChatProvider
  // configured but failing tells ops "ChatProvider is broken" — distinct from
  // "email" (where ChatProvider was simply not set up).
  const ChatProviderConfigured = !!cfg.ChatProviderChannel;
  const emailConfigured = cfg.emailRecipients.length > 0;
  let channel: string;
  if (result.ChatProviderSent && result.emailSent) {
    channel = "ChatProvider+email";
  } else if (result.ChatProviderSent) {
    channel = emailConfigured ? "ChatProvider_only" : "ChatProvider";
  } else if (result.emailSent) {
    channel = ChatProviderConfigured ? "email_only" : "email";
  } else {
    channel = "failed";
  }
  await persist(channel);

  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tool-health threshold-tuning notifier (Task #190)
//
// When an admin tunes the per-tool health alert thresholds via the AI Ops
// panel, post a ChatProvider message to the same on-call channel the breach
// notifier uses so changes don't sit silently in the DB audit log.
//
// Gating:
//   • `TOOL_HEALTH_CONFIG_NOTIFY=1` opts the behavior in. Any other value
//     (including unset) skips the post — matches the breach notifier's
//     "safe in dev/test by default" stance.
//   • ChatProvider channel resolution reuses `readConfig()` (above), so the
//     `TOOL_HEALTH_ChatProvider_CHANNEL` / `TOOL_HEALTH_ChatProvider_USE_DEFAULT_CHANNEL`
//     env-var rules apply identically.
//
// Best-effort:
//   • Caller awaits but never throws — ChatProvider outages must not block a
//     successful threshold save.
// ──────────────────────────────────────────────────────────────────────────────

const CONFIG_FIELD_LABELS: Record<keyof ToolHealthConfigOverrides, string> = {
  windowMinutes: "Rolling window (min)",
  minCalls: "Min calls in window",
  errorRatePct: "Error rate floor (%)",
  errorRateHighPct: "Error rate HIGH (%)",
  errorRateCriticalPct: "Error rate CRITICAL (%)",
  p95LatencyMs: "p95 latency floor (ms)",
  latencyHighMs: "p95 latency HIGH (ms)",
  latencyCriticalMs: "p95 latency CRITICAL (ms)",
};

const CONFIG_FIELD_ORDER: Array<keyof ToolHealthConfigOverrides> = [
  "windowMinutes",
  "minCalls",
  "errorRatePct",
  "errorRateHighPct",
  "errorRateCriticalPct",
  "p95LatencyMs",
  "latencyHighMs",
  "latencyCriticalMs",
];

export interface ToolHealthConfigChangeNotification {
  /** Operator who made the change (display name / email / "user:<id>"). */
  changedBy: string;
  /** Override blob *before* the change (only fields that had an override). */
  before: ToolHealthConfigOverrides;
  /** Override blob *after* the change (only fields that have an override). */
  after: ToolHealthConfigOverrides;
  /** Optional free-form note from the operator (already length-capped). */
  note?: string | null;
  /** Audit-row id from `tool_health_config_audit` for traceability. */
  audit_id?: number | null;
  /**
   * Breach diff computed by the PUT handler comparing currently-open
   * tool-health breaches under the old vs proposed thresholds (Task #208).
   * When present, the notifier renders an "Impact" section so on-call can
   * see at a glance whether tightening/loosening the floor opened or
   * resolved any alerts. `null`/omitted means the aggregate query failed
   * (or the diff wasn't computed) — the section is omitted gracefully.
   */
  breach_diff?: ToolHealthAuditBreachDiff | null;
}

export interface NotifyToolHealthConfigChangeResult {
  ChatProviderSent: boolean;
  emailSent: boolean;
  /** True when no override field actually changed (no message posted). */
  noChanges: boolean;
  /** True when `TOOL_HEALTH_CONFIG_NOTIFY` is not opted in. */
  disabled: boolean;
  /** True when neither ChatProvider nor email is configured. */
  skipped: boolean;
}

export interface ToolHealthConfigChangeNotifierDeps {
  /**
   * Boolean-returning ChatProvider send dep, kept for back-compat with existing
   * test stubs. When provided AND `postChatProvider` is not, threading is
   * disabled because we have no `ts` to persist — the post still goes
   * out, it just starts a fresh root every time. Production wiring leaves
   * both unset and falls through to `postChatProviderMessage`, which preserves
   * threading.
   */
  sendChatProvider?: typeof sendChatProviderNotification;
  /**
   * Threading-aware ChatProvider send dep that returns the message `ts` so the
   * notifier can persist a daily root and reply-thread under it on
   * subsequent posts (Task #383). Defaults to `postChatProviderMessage`. Takes
   * precedence over `sendChatProvider` when both are supplied.
   */
  postChatProvider?: typeof postChatProviderMessage;
  /**
   * Look up today's persisted ChatProvider `ts` for the "config_change" notify
   * key. Returns `null` when no root has been posted yet today. Defaults
   * to `getNotifyThreadTs` from `toolHealthConfigDatabase`.
   */
  getThreadTs?: (notifyKey: string, day: string) => Promise<string | null>;
  /**
   * Persist a freshly-posted root message's `ts` so the next post the
   * same UTC day folds into a thread reply. Defaults to
   * `setNotifyThreadTs`.
   */
  setThreadTs?: (notifyKey: string, day: string, ts: string) => Promise<void>;
  /**
   * Wall-clock supplier used to compute today's UTC date for the thread
   * key. Defaults to `Date.now`. Tests inject a deterministic clock so a
   * "second post on the same day" scenario doesn't flap on a midnight
   * boundary.
   */
  now?: () => number;
  /**
   * Fetches the most recent N audit entries, newest first. Defaults to
   * `getToolHealthConfigAudit` from `toolHealthConfigDatabase`. Tests can
   * inject a stub so no real DB connection is required.
   */
  getAudit?: (limit: number) => Promise<ToolHealthConfigAuditEntry[]>;
  /** Defaults to `sendEmailProviderEmail`. */
  sendEmail?: (
    opts: EmailProviderEmailOptions,
  ) => Promise<{ success: boolean; id?: string; error?: string }>;
}

/**
 * Notify-key for the per-day ChatProvider thread that folds together repeated
 * threshold-tune messages (Task #383). Exported for tests / observability —
 * other notification kinds (override expiry, breach, recovery) intentionally
 * do not thread because each event is operationally meaningful in its own
 * right.
 */
export const TOOL_HEALTH_CONFIG_THREAD_KEY = "config_change";

/** UTC YYYY-MM-DD for the given epoch ms. Stable for use as a DB day key. */
function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Compute the diff between the override blob before and after a tuning
 * operation. A field appears in the diff iff its effective override value
 * changed — including transitions to/from "default (env baseline)" when an
 * override is cleared or first set.
 *
 * Exported only for unit tests.
 */
export function _diffToolHealthConfigOverridesForTests(
  before: ToolHealthConfigOverrides,
  after: ToolHealthConfigOverrides,
): Array<{
  field: keyof ToolHealthConfigOverrides;
  before: number | null;
  after: number | null;
}> {
  const changes: Array<{
    field: keyof ToolHealthConfigOverrides;
    before: number | null;
    after: number | null;
  }> = [];
  for (const f of CONFIG_FIELD_ORDER) {
    const b = before[f] ?? null;
    const a = after[f] ?? null;
    if (b !== a) changes.push({ field: f, before: b, after: a });
  }
  return changes;
}

function formatOverrideValue(v: number | null): string {
  return v == null ? "_default (env baseline)_" : `\`${v}\``;
}

/**
 * Formats a single audit entry into a one-line summary for the "Recent
 * changes" block: `• <REDACTED_PHONE>:30 UTC — Alice Admin (2 fields changed)`
 */
function formatAuditEntrySummary(entry: ToolHealthConfigAuditEntry): string {
  const ts =
    entry.changed_at instanceof Date
      ? entry.changed_at
      : new Date(entry.changed_at);
  const dateStr = Number.isNaN(ts.getTime())
    ? "—"
    : ts.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const fieldCount = CONFIG_FIELD_ORDER.filter((f) => {
    const b = (entry.before_values as ToolHealthConfigOverrides)[f] ?? null;
    const a = (entry.after_values as ToolHealthConfigOverrides)[f] ?? null;
    return b !== a;
  }).length;
  const fieldLabel =
    fieldCount === 1 ? "1 field changed" : `${fieldCount} fields changed`;
  const who = entry.changed_by || "—";
  return `• \`${dateStr}\` — ${who} (${fieldLabel})`;
}

/**
 * Render the per-row counts of a breach diff into ChatProvider mrkdwn lines for
 * the "Impact" section. Returns `null` when the diff has zero entries
 * across all three buckets so the caller can omit the section entirely
 * rather than render an empty block.
 */
function formatBreachDiffImpactLines(
  diff: ToolHealthAuditBreachDiff,
): string | null {
  const newCount = diff.new_breaches?.length ?? 0;
  const resolvedCount = diff.resolved_breaches?.length ?? 0;
  const sevChangeCount = diff.severity_changes?.length ?? 0;
  if (newCount === 0 && resolvedCount === 0 && sevChangeCount === 0) {
    return null;
  }
  const lines: string[] = [
    `:rotating_light: *New alerts:* ${newCount}`,
    `:white_check_mark: *Resolved alerts:* ${resolvedCount}`,
    `:arrows_counterclockwise: *Severity changes:* ${sevChangeCount}`,
  ];
  return lines.join("\n");
}

function buildConfigChangeBlocks(
  n: ToolHealthConfigChangeNotification,
  changes: ReturnType<typeof _diffToolHealthConfigOverridesForTests>,
  link: string,
  linkIsAbsolute: boolean,
  recentAudit: ToolHealthConfigAuditEntry[] = [],
): any[] {
  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: ":wrench: Tool-health alert thresholds updated",
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

  const diffLines = changes.map(
    (c) =>
      `• *${CONFIG_FIELD_LABELS[c.field]}*: ${formatOverrideValue(c.before)} → ${formatOverrideValue(c.after)}`,
  );
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Changes (${changes.length}):*\n${diffLines.join("\n")}`,
    },
  });

  // "Impact" section — when the PUT handler computed a breach diff
  // (Task #208), surface counts so on-call sees at a glance whether this
  // tightening/loosening of the floor opened or resolved alerts. When the
  // diff is `null`/omitted (aggregate query failed) we skip the section
  // entirely so the message degrades gracefully rather than render an
  // empty or zero-only block.
  if (n.breach_diff != null) {
    const impactText = formatBreachDiffImpactLines(n.breach_diff);
    if (impactText) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*Impact:*\n${impactText}` },
      });
    }
  }

  if (n.note) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Note:*\n${n.note}` },
    });
  }

  // "Recent changes" section — lists up to the last 3 audit entries so
  // on-call can see "what's changed today?" in a single thread without
  // scrolling the channel history. Data comes from the DB audit table so
  // the block is consistent after a server restart (Task #205).
  if (recentAudit.length > 0) {
    const lines = recentAudit.map(formatAuditEntrySummary);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Recent changes (last ${recentAudit.length}):*\n${lines.join("\n")}`,
      },
    });
  }

  // ChatProvider rejects relative URLs in actions.button.url; degrade to a plain
  // mrkdwn link section in that case (mirrors the breach notifier).
  if (linkIsAbsolute) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Open Alert Thresholds",
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
          `:link: Alert Thresholds tab: \`${link}\`\n` +
          `_Set \`TOOL_HEALTH_APP_URL\` to enable a clickable link._`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: ":robot_face: _ExampleOrg tool-health monitor | threshold tuning_",
      },
    ],
  });
  return blocks;
}

function buildConfigChangeEmailHtml(
  n: ToolHealthConfigChangeNotification,
  changes: ReturnType<typeof _diffToolHealthConfigOverridesForTests>,
  link: string,
): string {
  const linkHtml = `<a href="${link}">Open the Alert Thresholds tab</a>`;
  const diffRows = changes
    .map(
      (c) =>
        `<tr><td style="padding:2px 8px 2px 0"><strong>${escapeHtml(CONFIG_FIELD_LABELS[c.field])}</strong></td>` +
        `<td style="padding:2px 8px">${c.before == null ? "<em>default</em>" : escapeHtml(String(c.before))}</td>` +
        `<td style="padding:2px 8px">&rarr;</td>` +
        `<td style="padding:2px 0">${c.after == null ? "<em>default</em>" : escapeHtml(String(c.after))}</td></tr>`,
    )
    .join("");
  const noteHtml = n.note
    ? `<p><strong>Note:</strong><br>${escapeHtml(n.note)}</p>`
    : "";
  return [
    `<h2 style="margin:0 0 12px 0;">Tool-health alert thresholds updated</h2>`,
    `<p><strong>Changed by:</strong> ${escapeHtml(n.changedBy || "—")}<br>`,
    n.audit_id != null
      ? `<strong>Audit row:</strong> #${n.audit_id}</p>`
      : `</p>`,
    `<p><strong>Changes (${changes.length}):</strong></p>`,
    `<table style="border-collapse:collapse;font-size:14px;">${diffRows}</table>`,
    noteHtml,
    `<p>${linkHtml}</p>`,
    `<p style="color:#888;font-size:12px;">ExampleOrg tool-health monitor | threshold tuning</p>`,
  ].join("");
}

function buildConfigChangeEmailText(
  n: ToolHealthConfigChangeNotification,
  changes: ReturnType<typeof _diffToolHealthConfigOverridesForTests>,
  link: string,
): string {
  const diffLines = changes.map(
    (c) =>
      `  ${CONFIG_FIELD_LABELS[c.field]}: ` +
      `${c.before == null ? "default" : c.before} → ${c.after == null ? "default" : c.after}`,
  );
  return [
    "Tool-health alert thresholds updated",
    "",
    `Changed by: ${n.changedBy || "—"}`,
    n.audit_id != null ? `Audit row: #${n.audit_id}` : "",
    "",
    `Changes (${changes.length}):`,
    ...diffLines,
    "",
    n.note ? `Note: ${n.note}` : "",
    "",
    `Open the Alert Thresholds tab: ${link}`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

/**
 * Post a ChatProvider message and/or send an email summarising a successful
 * tool-health-config tuning operation. Best-effort: never throws, returns a
 * result object so the caller can log/count.
 *
 * Safe to call unconditionally — when `TOOL_HEALTH_CONFIG_NOTIFY` is not
 * set to "1", or when neither ChatProvider nor email is configured, the function
 * returns `{ disabled: true }` / `{ skipped: true }` without sending anything.
 */
export async function notifyToolHealthConfigChange(
  notification: ToolHealthConfigChangeNotification,
  depsOverride: ToolHealthConfigChangeNotifierDeps = {},
): Promise<NotifyToolHealthConfigChangeResult> {
  const result: NotifyToolHealthConfigChangeResult = {
    ChatProviderSent: false,
    emailSent: false,
    noChanges: false,
    disabled: false,
    skipped: false,
  };

  if (process.env.TOOL_HEALTH_CONFIG_NOTIFY !== "1") {
    result.disabled = true;
    return result;
  }

  const cfg = readConfig();
  if (!cfg.ChatProviderChannel && cfg.emailRecipients.length === 0) {
    result.skipped = true;
    return result;
  }

  const changes = _diffToolHealthConfigOverridesForTests(
    notification.before ?? {},
    notification.after ?? {},
  );
  if (changes.length === 0) {
    result.noChanges = true;
    return result;
  }

  // Deep-link straight to the Alert Thresholds tab — see the
  // `?tab=…` switch in dashboard/ai-ops.html (DOMContentLoaded handler).
  const link = `${cfg.link}?tab=thresholds`;

  if (cfg.ChatProviderChannel) {
    // Resolve the ChatProvider send. `postChatProvider` (returns ts) wins when supplied
    // so the threading bookkeeping has something to persist. Otherwise fall
    // through to `sendChatProvider` (legacy boolean) wrapped into the same shape —
    // when only the legacy dep is provided we lose the ts and therefore
    // can't fold the post into a thread, but the message still goes out so
    // dev/test wiring keeps working unchanged.
    const postChatProvider: typeof postChatProviderMessage =
      depsOverride.postChatProvider ??
      (depsOverride.sendChatProvider
        ? async (channel, text, blocks, thread_ts) => ({
            ok: await depsOverride.sendChatProvider!(channel, text, blocks, thread_ts),
            ts: null,
          })
        : postChatProviderMessage);

    // Look up today's persisted root ts (Task #383). Best-effort — a DB
    // hiccup just means we start a fresh thread root, which is the correct
    // fallback (channel still gets the message, just unthreaded).
    const nowFn = depsOverride.now ?? Date.now;
    const today = utcDayKey(nowFn());
    const getThreadTs =
      depsOverride.getThreadTs ??
      (async (k, d) =>
        (await import("./toolHealthConfigDatabase")).getNotifyThreadTs(k, d));
    const setThreadTs =
      depsOverride.setThreadTs ??
      (async (k, d, ts) =>
        (await import("./toolHealthConfigDatabase")).setNotifyThreadTs(
          k,
          d,
          ts,
        ));

    let existingThreadTs: string | null = null;
    try {
      existingThreadTs = await getThreadTs(
        TOOL_HEALTH_CONFIG_THREAD_KEY,
        today,
      );
    } catch (err) {
      logger.error(
        "[ToolHealthNotifier] getThreadTs threw for config change (best-effort):",
        err,
      );
    }

    // Fetch the last 3 audit entries from the DB (including the one just
    // written) so on-call can see "what's changed recently?" in a single
    // glance. Best-effort: a DB failure must never block the ChatProvider send.
    // The default loader is imported lazily to avoid a circular-module risk;
    // tests inject a stub via depsOverride.getAudit.
    let recentAudit: ToolHealthConfigAuditEntry[] = [];
    try {
      const getAuditFn =
        depsOverride.getAudit ??
        (await import("./toolHealthConfigDatabase")).getToolHealthConfigAudit;
      recentAudit = await getAuditFn(3);
    } catch (auditErr) {
      logger.error(
        "[ToolHealthNotifier] Failed to load recent audit entries for ChatProvider block (best-effort):",
        auditErr,
      );
    }

    const fallback =
      `:wrench: Tool-health alert thresholds updated by ${notification.changedBy || "—"} ` +
      `(${changes.length} change${changes.length === 1 ? "" : "s"})`;
    try {
      const r = await postChatProvider(
        cfg.ChatProviderChannel,
        fallback,
        buildConfigChangeBlocks(
          notification,
          changes,
          link,
          cfg.linkIsAbsolute,
          recentAudit,
        ),
        existingThreadTs ?? undefined,
      );
      result.ChatProviderSent = r.ok;

      // Persist the freshly-posted root only when we successfully posted
      // a NEW root (no existing thread today) and ChatProvider handed us a ts.
      // Skipping on a thread reply keeps the row pinned to the original
      // root so subsequent posts continue to thread under it.
      if (r.ok && r.ts && !existingThreadTs) {
        try {
          await setThreadTs(TOOL_HEALTH_CONFIG_THREAD_KEY, today, r.ts);
        } catch (err) {
          logger.error(
            "[ToolHealthNotifier] setThreadTs threw for config change (best-effort):",
            err,
          );
        }
      }
    } catch (err) {
      logger.error(
        "[ToolHealthNotifier] ChatProvider send threw for config change notification:",
        err,
      );
      result.ChatProviderSent = false;
    }
  }

  if (cfg.emailRecipients.length > 0) {
    const sendEmail = depsOverride.sendEmail ?? sendEmailProviderEmail;
    const subject = `[Tool Health · Thresholds Updated] ${changes.length} change${changes.length === 1 ? "" : "s"} by ${notification.changedBy || "—"}`;
    try {
      const sendResult = await sendEmail({
        to: cfg.emailRecipients,
        subject,
        html: buildConfigChangeEmailHtml(notification, changes, link),
        text: buildConfigChangeEmailText(notification, changes, link),
      });
      result.emailSent = !!sendResult?.success;
    } catch (err) {
      logger.error(
        "[ToolHealthNotifier] Email send threw for config change notification:",
        err,
      );
      result.emailSent = false;
    }
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// Override auto-revert notification (Task #213)
//
// When the cron's reaper clears an expired tool-health override row, post a
// ChatProvider message to the same on-call channel so the team notices that the
// env baseline has taken back over. Best-effort: failure is logged but
// never propagates back to the cron.
// ──────────────────────────────────────────────────────────────────────────────

/** Camel-case → human-readable label for the cleared override fields. */
const OVERRIDE_FIELD_LABELS: Record<string, string> = {
  windowMinutes: "rolling window (min)",
  minCalls: "min calls per window",
  errorRatePct: "error-rate breach floor (%)",
  errorRateHighPct: "error-rate high cutoff (%)",
  errorRateCriticalPct: "error-rate critical cutoff (%)",
  p95LatencyMs: "p95 latency breach floor (ms)",
  latencyHighMs: "p95 latency high cutoff (ms)",
  latencyCriticalMs: "p95 latency critical cutoff (ms)",
};

function describeClearedOverrides(
  cleared: Record<string, number | undefined>,
): string {
  const keys = Object.keys(cleared).filter((k) => cleared[k] != null);
  if (keys.length === 0) return "_(no fields recorded)_";
  return keys
    .map((k) => `• \`${OVERRIDE_FIELD_LABELS[k] ?? k}\` (was ${cleared[k]})`)
    .join("\n");
}

function describeClearedOverridesPlain(
  cleared: Record<string, number | undefined>,
): string {
  const keys = Object.keys(cleared).filter((k) => cleared[k] != null);
  if (keys.length === 0) return "(no fields recorded)";
  return keys
    .map((k) => `${OVERRIDE_FIELD_LABELS[k] ?? k} (was ${cleared[k]})`)
    .join(", ");
}

export interface ToolHealthOverrideExpiredNotification {
  /** Map of cleared override field → its prior value. */
  cleared_overrides: Record<string, number | undefined>;
  /**
   * `updated_by` recorded against the override row immediately before
   * the reaper cleared it. May be an email like `user@example.invalid`,
   * a free-form name, or `null` when the row had no attribution.
   */
  previous_updated_by: string | null;
  /** The `expires_at` timestamp the reaper acted on. */
  expired_at: Date | null;
  /** The audit row id written by the reaper. */
  audit_id: number | null;
}

export interface NotifyOverrideExpiredResult {
  ChatProviderSent: boolean;
  /** True when no ChatProvider channel is configured — caller can ignore quietly. */
  skipped: boolean;
}

export interface ToolHealthOverrideNotifierDeps {
  /** Defaults to `sendChatProviderNotification`. */
  sendChatProvider?: typeof sendChatProviderNotification;
  /**
   * Fetches the most recent N audit entries, newest first. Defaults to
   * `getToolHealthConfigAudit` from `toolHealthConfigDatabase`. Tests can
   * inject a stub so no real DB connection is required (Task #384).
   */
  getAudit?: (limit: number) => Promise<ToolHealthConfigAuditEntry[]>;
}

function buildOverrideExpiredChatProviderBlocks(
  n: ToolHealthOverrideExpiredNotification,
  link: string,
  linkIsAbsolute: boolean,
  recentAudit: ToolHealthConfigAuditEntry[] = [],
): any[] {
  const setBy = n.previous_updated_by?.trim() || "_unknown_";
  const expiredAtIso =
    n.expired_at instanceof Date
      ? n.expired_at.toISOString()
      : n.expired_at != null
        ? String(n.expired_at)
        : "—";
  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: ":hourglass_flowing_sand: Tool-health override auto-reverted",
        emoji: true,
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `Tool-health overrides scheduled by *${setBy}* just auto-reverted ` +
          `(expires_at: \`${expiredAtIso}\`). Alerts are now using the env ` +
          `baseline again — keep an eye out for breaches the override was ` +
          `silencing.`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Cleared fields:*\n${describeClearedOverrides(n.cleared_overrides)}`,
      },
    },
  ];
  // "Recent changes" — same pattern as the threshold-tuning notifier
  // (Task #205). Surfaces the last few audit entries so on-call can see
  // "what's been tuned recently?" without leaving ChatProvider (Task #384).
  if (recentAudit.length > 0) {
    const lines = recentAudit.map(formatAuditEntrySummary);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Recent changes (last ${recentAudit.length}):*\n${lines.join("\n")}`,
      },
    });
  }
  // ChatProvider rejects relative URLs in `actions.button.url`, so degrade to a
  // plain mrkdwn link when no public origin is configured (mirrors the
  // breach notifier's behavior — see buildChatProviderBlocks).
  if (linkIsAbsolute) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Open audit log",
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
          `:robot_face: _ExampleOrg tool-health override reaper` +
          (n.audit_id != null ? ` | audit row #${n.audit_id}` : "") +
          `_`,
      },
    ],
  });
  return blocks;
}

/**
 * Post a ChatProvider message announcing that the time-boxed override row was
 * auto-reverted by the cron's reaper (Task #213).
 *
 * Best-effort by design — the cron calls this AFTER the reaper has already
 * cleared the row and written the audit entry, so a ChatProvider outage must not
 * roll back the revert. The function therefore:
 *   • returns `{ skipped: true }` when no ChatProvider channel is configured
 *     (dev/test environments shouldn't have to special-case the call);
 *   • catches and logs any error from `sendChatProvider` so the caller can stay
 *     in a single try/catch around the whole cron tick;
 *   • does NOT consult the breach throttle map — a reaper firing is a
 *     comparatively rare event and operators want to see every one.
 *
 * The link points at the AI Operations thresholds tab and (when available)
 * deep-links straight to the audit row that was just written, so the
 * recipient can confirm "who set what" in one click.
 */
export async function notifyToolHealthOverrideExpired(
  notification: ToolHealthOverrideExpiredNotification,
  depsOverride: ToolHealthOverrideNotifierDeps = {},
): Promise<NotifyOverrideExpiredResult> {
  const cfg = readConfig();
  const sendChatProvider = depsOverride.sendChatProvider ?? sendChatProviderNotification;

  const result: NotifyOverrideExpiredResult = {
    ChatProviderSent: false,
    skipped: false,
  };

  if (!cfg.ChatProviderChannel) {
    result.skipped = true;
    return result;
  }

  // Build a deep link to the thresholds tab + the specific audit row when
  // we have an audit_id. The dashboard renders an `id="threshold-audit-N"`
  // anchor on each row so this scrolls straight to the entry.
  const baseLink = cfg.link.includes("?")
    ? `${cfg.link}&tab=thresholds`
    : `${cfg.link}?tab=thresholds`;
  const link =
    notification.audit_id != null
      ? `${baseLink}#threshold-audit-${notification.audit_id}`
      : baseLink;

  const setBy = notification.previous_updated_by?.trim() || "unknown";
  const fallback =
    `:hourglass_flowing_sand: Tool-health overrides scheduled by ` +
    `${setBy} just auto-reverted; alerts now using env baseline ` +
    `again. Cleared: ${describeClearedOverridesPlain(notification.cleared_overrides)}.`;

  // Best-effort: pull the last 3 audit entries so the ChatProvider message gives
  // on-call the same "what's changed recently?" view the manual tune
  // notification provides (Task #205 / Task #384). A DB hiccup must not
  // block the ChatProvider send — swallow the error and post without the block.
  let recentAudit: ToolHealthConfigAuditEntry[] = [];
  try {
    const getAuditFn =
      depsOverride.getAudit ??
      (await import("./toolHealthConfigDatabase")).getToolHealthConfigAudit;
    recentAudit = await getAuditFn(3);
  } catch (auditErr) {
    logger.error(
      "[ToolHealthNotifier] Failed to load recent audit entries for override-expired ChatProvider block (best-effort):",
      auditErr,
    );
  }

  try {
    result.ChatProviderSent = await sendChatProvider(
      cfg.ChatProviderChannel,
      fallback,
      buildOverrideExpiredChatProviderBlocks(
        notification,
        link,
        cfg.linkIsAbsolute,
        recentAudit,
      ),
    );
  } catch (err) {
    logger.error(
      `[ToolHealthNotifier] ChatProvider send threw for override auto-revert ` +
        `(audit_id=${notification.audit_id ?? "?"}):`,
      err,
    );
    result.ChatProviderSent = false;
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// Override expiry pre-warning notification (Task #219)
//
// Before the reaper clears an expired override, post a ChatProvider heads-up while
// the admin still has time to extend it. The warning fires once per unique
// `expires_at` value (in-process dedupe keyed on the ISO timestamp) so it
// does not repeat on every cron tick during the warning window.
//
// Configuration:
//   TOOL_HEALTH_OVERRIDE_WARN_MIN — look-ahead window in minutes (default 30).
//     Set to 0 to disable pre-warnings. The cron reads this and calls
//     `getToolHealthOverrideExpiringSoon()` with the resulting window.
//
// Best-effort:
//   Never throws; a ChatProvider outage must not block the surrounding cron pass.
// ──────────────────────────────────────────────────────────────────────────────

export interface ToolHealthOverrideExpiringSoonNotification {
  /** The `expires_at` timestamp of the override row that is about to revert. */
  expires_at: Date;
  /**
   * `updated_by` recorded on the override row — the operator who scheduled
   * the time-boxed override and therefore the person most likely to want to
   * extend it.
   */
  previous_updated_by: string | null;
  /** The override values currently in effect (non-null fields only). */
  overrides: Record<string, number | undefined>;
  /** Approximate minutes remaining until expiry, rounded to nearest minute. */
  minutes_remaining: number;
}

export interface NotifyOverrideExpiringSoonResult {
  ChatProviderSent: boolean;
  /** True when no ChatProvider channel is configured. */
  skipped: boolean;
  /**
   * True when this exact `expires_at` timestamp was already warned during
   * the current process lifetime. The cron uses this to avoid flooding the
   * channel on every tick within the warning window.
   */
  deduped: boolean;
}

/**
 * In-process deduplication set for expiry pre-warnings. Keyed on the
 * `expires_at` ISO string so each impending expiry produces exactly one
 * ChatProvider post per process lifetime.
 *
 * @internal
 */
const _warnedExpiryAtKeys = new Set<string>();

/** @internal Test-only: reset the dedupe set between cases. */
export function _resetOverrideExpirySoonWarningsForTests(): void {
  _warnedExpiryAtKeys.clear();
}

function buildOverrideExpiringSoonChatProviderBlocks(
  n: ToolHealthOverrideExpiringSoonNotification,
  link: string,
  linkIsAbsolute: boolean,
): any[] {
  const setBy = n.previous_updated_by?.trim() || "_unknown_";
  const expiresAtIso = n.expires_at.toISOString();
  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: ":timer_clock: Tool-health override expiring soon",
        emoji: true,
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `The tool-health override set by *${setBy}* will auto-revert in ` +
          `approximately *${n.minutes_remaining} minute${n.minutes_remaining === 1 ? "" : "s"}* ` +
          `(\`${expiresAtIso}\`). Alerts will return to the env baseline — ` +
          `extend the override now if the situation still warrants it.`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Active override fields:*\n${describeClearedOverrides(n.overrides)}`,
      },
    },
  ];

  if (linkIsAbsolute) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Open Alert Thresholds",
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
          `:link: Alert Thresholds tab: \`${link}\`\n` +
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
          `:robot_face: _ExampleOrg tool-health monitor | override expiry pre-warning` +
          ` | expires \`${expiresAtIso}\`_`,
      },
    ],
  });
  return blocks;
}

/**
 * Post a ChatProvider heads-up that a time-boxed tool-health override will expire
 * within the configured warning window (Task #219).
 *
 * Deduplication: each unique `expires_at` value is posted at most once per
 * process lifetime (in-process Set keyed on the ISO timestamp). This means
 * the warning fires on the first cron tick that falls inside the window and
 * is then silent for the remaining ticks — exactly one advance notice per
 * scheduled revert.
 *
 * Best-effort by design — a ChatProvider outage must not block the surrounding
 * cron pass. Returns `{ skipped: true }` when no channel is configured;
 * `{ deduped: true }` when this expiry was already warned.
 */
export async function notifyToolHealthOverrideExpiringSoon(
  notification: ToolHealthOverrideExpiringSoonNotification,
  depsOverride: ToolHealthOverrideNotifierDeps = {},
): Promise<NotifyOverrideExpiringSoonResult> {
  const result: NotifyOverrideExpiringSoonResult = {
    ChatProviderSent: false,
    skipped: false,
    deduped: false,
  };

  const dedupeKey = notification.expires_at.toISOString();
  if (_warnedExpiryAtKeys.has(dedupeKey)) {
    result.deduped = true;
    return result;
  }

  const cfg = readConfig();
  const sendChatProvider = depsOverride.sendChatProvider ?? sendChatProviderNotification;

  if (!cfg.ChatProviderChannel) {
    result.skipped = true;
    return result;
  }

  // Mark as warned immediately (before the send) so a throw in sendChatProvider
  // doesn't trigger a double-post on the next tick.
  _warnedExpiryAtKeys.add(dedupeKey);

  const link = cfg.link.includes("?")
    ? `${cfg.link}&tab=thresholds`
    : `${cfg.link}?tab=thresholds`;

  const setBy = notification.previous_updated_by?.trim() || "unknown";
  const fallback =
    `:timer_clock: Tool-health override set by ${setBy} expires in ` +
    `~${notification.minutes_remaining} min (\`${dedupeKey}\`). ` +
    `Extend it now if still needed.`;

  try {
    result.ChatProviderSent = await sendChatProvider(
      cfg.ChatProviderChannel,
      fallback,
      buildOverrideExpiringSoonChatProviderBlocks(
        notification,
        link,
        cfg.linkIsAbsolute,
      ),
    );
  } catch (err) {
    logger.error(
      `[ToolHealthNotifier] ChatProvider send threw for override expiry pre-warning ` +
        `(expires_at=${dedupeKey}):`,
      err,
    );
    result.ChatProviderSent = false;
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tool-health recovery notification (Task #167)
//
// When the cron's auto-resolve sweep closes a `tool_health` alert because
// the tool's metric dropped back below threshold, page on-call with a
// follow-up message so they know the incident is over without having to
// refresh the dashboard.
//
// Design notes:
//   • Uses the same `TOOL_HEALTH_ChatProvider_CHANNEL` / `TOOL_HEALTH_ALERT_EMAIL`
//     / `TOOL_HEALTH_APP_URL` env settings as the breach notifier — no new
//     env vars required.
//   • NOT throttled by the breach-side throttle map. Recovery is its own
//     event; the cron already prevents flapping at the alert layer (an
//     alert can only be resolved once, so there is at most one recovery
//     notification per alert_id).
//   • Best-effort: failures are logged but never propagate back to the cron.
// ──────────────────────────────────────────────────────────────────────────────

export interface ToolHealthRecoveryNotification {
  /** Tool whose metric recovered. */
  tool_name: string;
  /** Optional agent label, mirrored from the aggregate. */
  agent_name?: string | null;
  /** Which threshold recovered. */
  reason: ToolHealthReason;
  /** The `ai_alerts` row id that was just resolved. */
  alert_id: number;
  /** The auto-resolve note produced by `maybeResolveRecoveredAlert`. */
  detail: string;
  /**
   * `created_at` of the alert row that just resolved. Used to render
   * "Open for: …" in the message so on-call learns at a glance how long
   * the incident lasted. Optional — older alerts whose `created_at` was
   * lost (or stubs in tests) just omit the duration line.
   *
   * Accepts `Date`, ISO-string, or epoch-ms — the renderer normalises
   * before computing the duration so DB layers that return raw string
   * timestamps still produce a valid message.
   */
  alert_created_at?: Date | string | number | null;
  /**
   * Wall-clock time at which the alert was resolved. Defaults to "now"
   * when omitted. Exposed mostly so deterministic tests can pin both
   * endpoints of the duration calculation without monkey-patching `Date`.
   * Accepts the same shapes as `alert_created_at`.
   */
  resolved_at?: Date | string | number | null;
}

export interface NotifyToolHealthRecoveryResult {
  ChatProviderSent: boolean;
  emailSent: boolean;
  /**
   * True when the recovery page was suppressed for any reason: neither
   * ChatProvider nor email is configured, OR the operator opted this tool (or
   * all recoveries) out via `TOOL_HEALTH_RECOVERY_NOTIFY=0` /
   * `TOOL_HEALTH_RECOVERY_SKIP_TOOLS=<csv>`.
   *
   * Callers that need to distinguish "no transport configured" from
   * "explicitly opted out" should also inspect {@link disabled}.
   */
  skipped: boolean;
  /**
   * True when the suppression was caused by an explicit opt-out
   * (env-var gate or per-tool skip list). Distinct from the
   * "no ChatProvider channel & no email recipient" case so dashboards can
   * surface "operator silenced this tool" separately from "ops needs
   * to configure a transport".
   *
   * Always implies `skipped: true`.
   */
  disabled: boolean;
}

export interface ToolHealthRecoveryNotifierDeps {
  /** Defaults to `sendChatProviderNotification`. */
  sendChatProvider?: typeof sendChatProviderNotification;
  /** Defaults to `sendEmailProviderEmail`. */
  sendEmail?: (
    opts: EmailProviderEmailOptions,
  ) => Promise<{ success: boolean; id?: string; error?: string }>;
}

/**
 * Coerce a timestamp-shaped value into a real `Date`. The `pg` driver
 * parses `TIMESTAMP` columns into `Date` for us in production, but DB
 * access layers vary (raw query results, JSON-serialised rows over an
 * RPC boundary, test fixtures) so be liberal in what we accept and
 * strict in what we emit. Returns `null` for any input that cannot
 * yield a finite epoch — the caller hides the duration field in that
 * case rather than rendering "Invalid Date" or NaN.
 */
function coerceToDate(
  v: Date | string | number | null | undefined,
): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Render the gap between `created_at` and `resolved_at` (defaulting to
 * "now") as a compact human string: `45s`, `12m`, `2h 15m`, `3d 4h`.
 *
 * Accepts `Date`, ISO-string, or epoch-ms inputs to be robust against
 * DB-layer variations (e.g. a row deserialised from JSON where
 * timestamps come back as strings).
 *
 * Returns `null` when `createdAt` is missing/invalid, when `resolvedAt`
 * is invalid, or when the computed duration is negative (e.g. a clock
 * skew on a stubbed Date) so the renderer can simply omit the field
 * instead of showing nonsense like "−2m".
 *
 * This is the canonical "how long was the alert open?" formatter used by
 * the ChatProvider/email recovery messages AND surfaced verbatim in the AI Ops
 * dashboard recovery feed (Task #498) — keep the shape stable so the two
 * surfaces stay visually aligned.
 */
export function formatAlertOpenDuration(
  createdAt: Date | string | number | null | undefined,
  resolvedAt: Date | string | number | null | undefined = null,
): string | null {
  const created = coerceToDate(createdAt);
  if (created == null) return null;
  const resolved = resolvedAt == null ? new Date() : coerceToDate(resolvedAt);
  if (resolved == null) return null;
  const diffMs = resolved.getTime() - created.getTime();
  if (diffMs < 0) return null;

  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr > 0 ? `${day}d ${remHr}h` : `${day}d`;
}

/**
 * Back-compat alias for the existing test-suite import. Prefer
 * `formatAlertOpenDuration` in new code.
 */
export const _formatRecoveryDurationForTests = formatAlertOpenDuration;

function buildRecoveryChatProviderBlocks(
  n: ToolHealthRecoveryNotification,
  link: string,
  linkIsAbsolute: boolean,
): any[] {
  const duration = _formatRecoveryDurationForTests(
    n.alert_created_at ?? null,
    n.resolved_at ?? null,
  );
  const fields: Array<{ type: "mrkdwn"; text: string }> = [
    { type: "mrkdwn", text: `*Tool:*\n\`${n.tool_name}\`` },
    { type: "mrkdwn", text: `*Metric:*\n${reasonLabel(n.reason)}` },
    { type: "mrkdwn", text: `*Agent:*\n${n.agent_name || "—"}` },
    { type: "mrkdwn", text: `*Alert closed:*\n#${n.alert_id}` },
  ];
  if (duration) {
    fields.push({ type: "mrkdwn", text: `*Open for:*\n${duration}` });
  }
  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `:white_check_mark: Tool health recovered: ${n.tool_name}`,
        emoji: true,
      },
    },
    { type: "divider" },
    {
      type: "section",
      fields,
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Details:*\n${n.detail}` },
    },
  ];

  if (linkIsAbsolute) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "LLMProvider Operations panel",
            emoji: true,
          },
          url: link,
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
        text: `:robot_face: _ExampleOrg tool-health monitor | recovery | alert #${n.alert_id}_`,
      },
    ],
  });
  return blocks;
}

function buildRecoveryEmailHtml(
  n: ToolHealthRecoveryNotification,
  link: string,
): string {
  const title = `Tool "${escapeHtml(n.tool_name)}" ${reasonLabel(n.reason)} recovered`;
  const linkHtml = `<a href="${link}">Open the AI Operations panel</a>`;
  const duration = _formatRecoveryDurationForTests(
    n.alert_created_at ?? null,
    n.resolved_at ?? null,
  );
  return [
    `<h2 style="margin:0 0 12px 0;">${title}</h2>`,
    `<p><strong>Tool:</strong> <code>${escapeHtml(n.tool_name)}</code><br>`,
    `<strong>Metric:</strong> ${reasonLabel(n.reason)}<br>`,
    n.agent_name
      ? `<strong>Agent:</strong> ${escapeHtml(n.agent_name)}<br>`
      : "",
    `<strong>Alert closed:</strong> #${n.alert_id}`,
    duration ? `<br><strong>Open for:</strong> ${escapeHtml(duration)}` : "",
    `</p>`,
    `<p><strong>Details:</strong><br>${escapeHtml(n.detail)}</p>`,
    `<p>${linkHtml}</p>`,
  ].join("");
}

function buildRecoveryEmailText(
  n: ToolHealthRecoveryNotification,
  link: string,
): string {
  const duration = _formatRecoveryDurationForTests(
    n.alert_created_at ?? null,
    n.resolved_at ?? null,
  );
  return [
    `Tool health recovered: ${n.tool_name} — ${reasonLabel(n.reason)}`,
    "",
    `Tool: ${n.tool_name}`,
    `Metric: ${reasonLabel(n.reason)}`,
    n.agent_name ? `Agent: ${n.agent_name}` : "",
    `Alert closed: #${n.alert_id}`,
    duration ? `Open for: ${duration}` : "",
    "",
    n.detail,
    "",
    `Open the AI Operations panel: ${link}`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

/**
 * Page on-call about a `tool_health` alert that just auto-resolved because
 * the tool's metric dropped back below threshold.
 *
 * Safe to call unconditionally: when neither ChatProvider nor email is configured
 * the function returns `{ skipped: true }` without throwing.
 *
 * NOT throttled — each recovery corresponds to a unique `alert_id` that
 * can only be resolved once, so there is naturally at most one recovery
 * page per breach cycle.
 */
export async function notifyToolHealthRecovery(
  notification: ToolHealthRecoveryNotification,
  depsOverride: ToolHealthRecoveryNotifierDeps = {},
): Promise<NotifyToolHealthRecoveryResult> {
  const cfg = readConfig();
  const sendChatProvider = depsOverride.sendChatProvider ?? sendChatProviderNotification;
  const sendEmail = depsOverride.sendEmail ?? sendEmailProviderEmail;

  const result: NotifyToolHealthRecoveryResult = {
    ChatProviderSent: false,
    emailSent: false,
    skipped: false,
    disabled: false,
  };

  // Per-tool / global opt-out (Task #347).
  //
  // Mirrors the `TOOL_HEALTH_CONFIG_NOTIFY` env-var pattern used by the
  // config-change notifier, except inverted: recoveries page by default
  // (preserving today's behavior) and operators can silence them by
  // setting either:
  //   • `TOOL_HEALTH_RECOVERY_NOTIFY=0` — silence ALL recovery pages.
  //     Any explicit "off" value (`0`, `false`, `no`, `off`,
  //     case-insensitive) disables; everything else, including unset,
  //     leaves recoveries enabled.
  //   • `TOOL_HEALTH_RECOVERY_SKIP_TOOLS=tool_a,tool_b` — silence
  //     recoveries only for the listed tools (matched case-insensitively
  //     against `notification.tool_name`). Useful for noisy/flapping
  //     tools whose breach pages remain valuable but whose rapid-fire
  //     recoveries flood the channel.
  //
  // Breach pages are intentionally NOT gated by these flags — operators
  // who silence recoveries for a flappy tool still want to know when it
  // breaches.
  if (recoveryNotificationsDisabled(notification.tool_name)) {
    result.skipped = true;
    result.disabled = true;
    return result;
  }

  if (!cfg.ChatProviderChannel && cfg.emailRecipients.length === 0) {
    result.skipped = true;
    return result;
  }

  if (cfg.ChatProviderChannel) {
    const fallback =
      `:white_check_mark: Tool health recovered: ${notification.tool_name} — ` +
      `${reasonLabel(notification.reason)} back below threshold (alert #${notification.alert_id})`;
    try {
      result.ChatProviderSent = await sendChatProvider(
        cfg.ChatProviderChannel,
        fallback,
        buildRecoveryChatProviderBlocks(notification, cfg.link, cfg.linkIsAbsolute),
      );
    } catch (err) {
      logger.error(
        `[ToolHealthNotifier] ChatProvider recovery send threw for alert #${notification.alert_id}:`,
        err,
      );
      result.ChatProviderSent = false;
    }
  }

  if (cfg.emailRecipients.length > 0) {
    const subject =
      `[Tool Health · RECOVERED] ${notification.tool_name} — ` +
      `${reasonLabel(notification.reason)} cleared (alert #${notification.alert_id})`;
    try {
      const sendResult = await sendEmail({
        to: cfg.emailRecipients,
        subject,
        html: buildRecoveryEmailHtml(notification, cfg.link),
        text: buildRecoveryEmailText(notification, cfg.link),
      });
      result.emailSent = !!sendResult?.success;
    } catch (err) {
      logger.error(
        `[ToolHealthNotifier] Email recovery send threw for alert #${notification.alert_id}:`,
        err,
      );
      result.emailSent = false;
    }
  }

  return result;
}
