/**
 * Storage Health alerting helper (Task #546).
 *
 * The /ai-ops "Storage Health" KPI tile (Task #505) flips amber/red when the
 * oldest `ai_call_metrics` row is older than the configured retention window
 * — i.e. the daily prune cron has fallen behind or is failing outright. That
 * signal only reaches operators when somebody happens to open the dashboard.
 *
 * This helper closes the loop: after each daily prune, the cron passes the
 * fresh `getAiMetricsTableStats()` snapshot in here, and we either:
 *
 *   • Open a single high-severity `ai_alerts` row (alert_type='storage_health')
 *     and notify Slack / email / in-app — but ONLY if no open alert already
 *     exists for the same dedupe key, so a multi-day backlog cannot spam
 *     the channel.
 *
 *   • Auto-resolve any open storage_health alerts once the table is back
 *     inside the window — same auto-resolve pattern the tool-health and
 *     prompt-regression crons use.
 *
 * The dedupe key is a single global string ('ai_call_metrics') because the
 * signal is table-scoped, not per-row. If we ever start tracking retention
 * for additional telemetry tables, the key namespace already supports it.
 *
 * All side-effects are injected via `StorageHealthAlertDeps` so this
 * function is unit-testable without a database, Slack, or Resend.
 */

import { logger } from './logger';
import {
  type AIAlert,
  type AlertSeverity,
} from './aiAlertsDatabase';
import type { AiMetricsTableStats } from './aiTelemetry';

/** Fixed dedupe key used by every storage_health alert this helper opens. */
export const STORAGE_HEALTH_DEDUPE_KEY = 'ai_call_metrics' as const;

/** Module label written to `ai_alerts.related_module` and notifications. */
export const STORAGE_HEALTH_MODULE = 'ai_ops' as const;

/**
 * Default re-page cadence (Task #679). When a storage_health alert has been
 * "open" for at least this many minutes AND its last on-call notification
 * is at least this many minutes old, the daily cron will re-send the
 * Slack/email page so a stuck prune cannot sit in open state without
 * anyone being paged. Mirrors the tool-health re-notify pattern.
 *
 * Override with the `STORAGE_HEALTH_REPAGE_AFTER_MIN` env var. A value of
 * `0` (or any non-positive number) disables the sweep entirely.
 */
export const STORAGE_HEALTH_REPAGE_DEFAULT_MIN = 24 * 60;

export interface StorageHealthAlertResult {
  /** True when an open alert was newly created on this pass. */
  alertCreated: boolean;
  /** True when an existing open alert was deduped (no second alert opened). */
  alertDeduped: boolean;
  /** Number of previously-open alerts auto-resolved on this pass. */
  alertsResolved: number;
  /** True when Slack was attempted and reported success. */
  slackSent: boolean;
  /** True when email was attempted and reported success on at least one recipient. */
  emailSent: boolean;
  /** True when an in-app notification was created. */
  inAppCreated: boolean;
  /** Echoed for callers that want to log the underlying signal. */
  exceedsRetention: boolean;
  /**
   * True when the current cron pass fell inside the configured quiet-hours
   * window and Slack / email pushes were intentionally suppressed. The
   * `ai_alerts` row and in-app notification are still created in real time
   * (so the morning view shows the issue immediately) — only the noisy
   * channels that would page on-call at 3 a.m. are skipped.
   */
  quietHoursSuppressed: boolean;
}

export interface StorageHealthAlertDeps {
  /** Returns true when an open/acknowledged alert already exists for the key. */
  openAlertExistsByKey: (
    alertType: 'storage_health',
    relatedRecordId: string,
  ) => Promise<boolean>;
  /** Inserts a new open alert and returns it. */
  createAIAlert: (input: {
    alert_type: 'storage_health';
    severity: AlertSeverity;
    title: string;
    description: string;
    suggestion?: string;
    related_module?: string;
    related_record_id?: string;
  }) => Promise<AIAlert>;
  /** Lists open/acknowledged alerts for the given key — used by auto-resolve. */
  getOpenAlertsByKey: (
    alertType: 'storage_health',
    relatedRecordId: string,
  ) => Promise<AIAlert[]>;
  /** Marks an alert resolved and stamps the resolution note. */
  resolveAlert: (id: number, note: string) => Promise<AIAlert | null>;
  /** Creates an in-app notification (notificationHub). */
  createNotification: (input: {
    type: string;
    title: string;
    message: string;
    link?: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
  }) => Promise<unknown>;
  /** Sends a Slack message via webhook URL (returns true on success). */
  sendSlack: (webhookUrl: string, text: string) => Promise<boolean>;
  /** Sends an email via Resend (returns true on success). */
  sendEmail: (input: {
    to: string[];
    subject: string;
    html: string;
  }) => Promise<boolean>;
  /** Reads env vars (for tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Returns the "current time" used to evaluate the quiet-hours window.
   * Injected so unit tests can pin the clock to e.g. 03:00 Riyadh and
   * assert suppression deterministically. Defaults to `new Date()`.
   */
  now?: () => Date;
}

/**
 * Quiet-hours window (UTC by default) during which Slack / email pushes are
 * suppressed for storage-health pages. The in-app notification and the
 * `ai_alerts` row are still created in real time so the morning view shows
 * the issue immediately.
 *
 * Resolved from env vars:
 *   • `STORAGE_HEALTH_QUIET_HOURS_START` — integer hour 0–23 inclusive.
 *   • `STORAGE_HEALTH_QUIET_HOURS_END`   — integer hour 0–23 inclusive.
 *   • `STORAGE_HEALTH_QUIET_HOURS_TZ`    — IANA timezone name. Defaults to
 *                                          `UTC`. Invalid values fall back
 *                                          to UTC (logged once per call).
 *
 * Both START and END must be valid integers in [0, 23] for the window to
 * activate; otherwise quiet-hours are disabled. The window is half-open
 * `[start, end)` and wraps midnight when `start > end` (the typical
 * overnight case, e.g. 22→07). When `start === end` the window is empty
 * (disabled) — anything else would suppress alerts 24/7.
 */
export interface QuietHoursWindow {
  /** True when both START and END parsed cleanly. */
  enabled: boolean;
  /** Hour of day 0–23 the window opens (in `tz`). Undefined when disabled. */
  startHour?: number;
  /** Hour of day 0–23 the window closes (in `tz`). Undefined when disabled. */
  endHour?: number;
  /** Resolved IANA timezone name (always set; defaults to `UTC`). */
  tz: string;
}

function parseQuietHourEnv(raw: string | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 23) return null;
  return n;
}

/**
 * Resolve the quiet-hours window from env vars. Exported for unit tests so
 * the parsing rules can be asserted independently of the alert flow.
 */
export function resolveQuietHoursWindow(env: NodeJS.ProcessEnv): QuietHoursWindow {
  const startHour = parseQuietHourEnv(env.STORAGE_HEALTH_QUIET_HOURS_START);
  const endHour = parseQuietHourEnv(env.STORAGE_HEALTH_QUIET_HOURS_END);
  const tzRaw = (env.STORAGE_HEALTH_QUIET_HOURS_TZ ?? '').trim();
  let tz = tzRaw || 'UTC';
  // Validate the timezone with Intl — invalid values throw a RangeError.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    logger.warn('[StorageHealthAlerts] Invalid STORAGE_HEALTH_QUIET_HOURS_TZ; falling back to UTC', {
      provided: tzRaw,
    });
    tz = 'UTC';
  }
  if (startHour == null || endHour == null || startHour === endHour) {
    return { enabled: false, tz };
  }
  return { enabled: true, startHour, endHour, tz };
}

/**
 * Hour-of-day (0–23) for `now` rendered in the quiet-hours timezone.
 * Uses Intl so DST transitions are handled correctly in zones that observe
 * them. Returns the UTC hour as a fallback if the formatter fails (it
 * shouldn't, but the cron must never crash on a bad locale install).
 */
function hourInZone(now: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    });
    // formatToParts is the only way to get the bare numeric hour without
    // locale-dependent formatting (e.g. "0" vs "24").
    const parts = fmt.formatToParts(now);
    const hourPart = parts.find((p) => p.type === 'hour');
    if (hourPart) {
      const n = Number(hourPart.value);
      // Some ICU builds emit "24" for midnight; normalise to 0.
      if (Number.isInteger(n) && n >= 0 && n <= 24) return n === 24 ? 0 : n;
    }
  } catch (err) {
    logger.warn('[StorageHealthAlerts] Failed to compute hour in tz; falling back to UTC', {
      tz,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return now.getUTCHours();
}

/**
 * True when `now` falls inside the configured quiet-hours window. Exported
 * for unit tests so wrap-around behaviour can be asserted without going
 * through the full alert flow.
 */
export function isInQuietHours(window: QuietHoursWindow, now: Date): boolean {
  if (!window.enabled || window.startHour == null || window.endHour == null) {
    return false;
  }
  const hour = hourInZone(now, window.tz);
  const { startHour, endHour } = window;
  if (startHour < endHour) {
    // Same-day window, e.g. 01–05 → suppress from 01:00 inclusive to 05:00 exclusive.
    return hour >= startHour && hour < endHour;
  }
  // Wrap-around window, e.g. 22–07 → suppress 22, 23, 0, 1, 2, 3, 4, 5, 6.
  return hour >= startHour || hour < endHour;
}

/**
 * Build the user-visible alert/notification copy from the stats snapshot.
 * Pure function so the cron, tests, and email renderer all agree on wording.
 */
export function buildStorageHealthMessage(stats: AiMetricsTableStats): {
  title: string;
  description: string;
  suggestion: string;
} {
  const oldestAge =
    stats.oldestAgeDays != null ? Math.round(stats.oldestAgeDays * 10) / 10 : null;
  const oldestClause =
    oldestAge != null
      ? `oldest row is ${oldestAge} days old`
      : 'oldest row timestamp is unavailable';
  const overhang =
    oldestAge != null && oldestAge > stats.retentionDays
      ? ` (${Math.round((oldestAge - stats.retentionDays) * 10) / 10} days past the window)`
      : '';

  const lastPruneClause = stats.lastPrune
    ? `Most recent prune: ${stats.lastPrune.success ? 'succeeded' : 'FAILED'} ` +
      `at ${stats.lastPrune.ranAt} ` +
      `(retention=${stats.lastPrune.retentionDays}d, deleted=${stats.lastPrune.rowsDeleted})` +
      (stats.lastPrune.success ? '' : `, error: ${stats.lastPrune.errorMessage ?? 'unknown'}`)
    : 'No prune-run history recorded yet';

  const title =
    `AI usage table outgrowing prune window — ${oldestClause}` +
    ` (retention: ${stats.retentionDays}d)`;

  const description =
    `The daily prune cron just ran and ai_call_metrics still contains rows ` +
    `outside the configured ${stats.retentionDays}-day retention window: ` +
    `${oldestClause}${overhang}. Total rows: ${stats.rowCount.toLocaleString()}. ` +
    `${lastPruneClause}.`;

  const suggestion =
    'Verify the AI cost-summary Inngest cron is still running successfully ' +
    '(check ai_metrics_prune_runs for failed entries) and that the configured ' +
    'retention window has not been widened beyond intent. If the prune is ' +
    'failing, inspect the most recent error_message in ai_metrics_prune_runs ' +
    'and re-run pruneOldAiMetrics() manually once the underlying issue is ' +
    'resolved. This alert will auto-resolve on the next cron pass once the ' +
    'oldest row is back inside the window.';

  return { title, description, suggestion };
}

/**
 * Evaluate the storage-health signal and emit / resolve alerts as needed.
 *
 * Idempotent: safe to call once per cron pass. Dedupe is handled by
 * `openAlertExistsByKey`, so a multi-day backlog of breaches yields exactly
 * one open alert + one page until it auto-resolves.
 *
 * Notification failures (Slack / email / in-app) are logged but never thrown,
 * so a transient external outage cannot abort the cron pass.
 */
export async function evaluateAndAlertStorageHealth(
  stats: AiMetricsTableStats,
  deps: StorageHealthAlertDeps,
): Promise<StorageHealthAlertResult> {
  const env = deps.env ?? process.env;
  const nowFn = deps.now ?? (() => new Date());
  const quietHours = resolveQuietHoursWindow(env);
  const inQuietHours = quietHours.enabled && isInQuietHours(quietHours, nowFn());
  const result: StorageHealthAlertResult = {
    alertCreated: false,
    alertDeduped: false,
    alertsResolved: 0,
    slackSent: false,
    emailSent: false,
    inAppCreated: false,
    exceedsRetention: stats.exceedsRetention,
    quietHoursSuppressed: false,
  };

  if (!stats.exceedsRetention) {
    // Recovery path: auto-resolve any previously-opened alerts.
    let openAlerts: AIAlert[] = [];
    try {
      openAlerts = await deps.getOpenAlertsByKey(
        'storage_health',
        STORAGE_HEALTH_DEDUPE_KEY,
      );
    } catch (err) {
      logger.warn('[StorageHealthAlerts] Failed to list open alerts', {
        error: err instanceof Error ? err.message : String(err),
      });
      return result;
    }

    if (openAlerts.length === 0) return result;

    const note =
      `Auto-resolved: ai_call_metrics oldest row is back inside the ` +
      `${stats.retentionDays}-day retention window ` +
      (stats.oldestAgeDays != null
        ? `(now ${Math.round(stats.oldestAgeDays * 10) / 10} days old).`
        : '(table is empty).');

    for (const alert of openAlerts) {
      if (alert.id == null) continue;
      try {
        await deps.resolveAlert(alert.id, note);
        result.alertsResolved += 1;
      } catch (err) {
        logger.warn('[StorageHealthAlerts] Failed to auto-resolve alert', {
          alertId: alert.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (result.alertsResolved > 0) {
      // Best-effort recovery notification so on-call sees the all-clear in
      // the same surface as the initial page.
      try {
        await deps.createNotification({
          type: 'alert',
          title: 'AI Usage Table Storage Recovered',
          message: note,
          link: '/ai-ops',
          severity: 'low',
        });
        result.inAppCreated = true;
      } catch (err) {
        logger.warn('[StorageHealthAlerts] Failed to create recovery notification', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  // Breach path. Dedupe before doing anything noisy.
  let alertExists = false;
  try {
    alertExists = await deps.openAlertExistsByKey(
      'storage_health',
      STORAGE_HEALTH_DEDUPE_KEY,
    );
  } catch (err) {
    logger.warn('[StorageHealthAlerts] Dedupe check failed; assuming alert exists', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Fail closed on the dedupe check so a transient DB hiccup cannot spam
    // the channel. The next cron pass will retry naturally.
    result.alertDeduped = true;
    return result;
  }

  if (alertExists) {
    result.alertDeduped = true;
    return result;
  }

  const { title, description, suggestion } = buildStorageHealthMessage(stats);

  try {
    await deps.createAIAlert({
      alert_type: 'storage_health',
      severity: 'high',
      title,
      description,
      suggestion,
      related_module: STORAGE_HEALTH_MODULE,
      related_record_id: STORAGE_HEALTH_DEDUPE_KEY,
    });
    result.alertCreated = true;
  } catch (err) {
    logger.error('[StorageHealthAlerts] Failed to insert ai_alerts row', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Do not page if we couldn't open the alert — the missing row would
    // defeat dedup on the next pass and we'd page repeatedly.
    return result;
  }

  // In-app notification — same pattern the cost-threshold cron uses.
  try {
    await deps.createNotification({
      type: 'alert',
      title: 'AI Usage Table Storage Alert',
      message: description,
      link: '/ai-ops',
      severity: 'high',
    });
    result.inAppCreated = true;
  } catch (err) {
    logger.warn('[StorageHealthAlerts] In-app notification failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Quiet-hours suppression. The breach is real and the in-app
  // notification + ai_alerts row above are already in place — we just
  // skip the noisy Slack / email channels until the window closes so
  // on-call isn't paged at 3 a.m. about a backlog they cannot act on
  // until morning. The morning view shows the issue immediately because
  // the alert row was created in real time.
  if (inQuietHours) {
    result.quietHoursSuppressed = true;
    logger.info(
      '[StorageHealthAlerts] Quiet hours active — Slack/email suppressed',
      {
        startHour: quietHours.startHour,
        endHour: quietHours.endHour,
        tz: quietHours.tz,
      },
    );
    return result;
  }

  // Slack — re-uses the existing AI_COST cron's webhook so ops doesn't
  // have to configure a second integration.
  const slackWebhook = env.SLACK_WEBHOOK_URL;
  if (slackWebhook) {
    const slackText =
      `:warning: *AI Storage Health Alert* — ${title}.\n` +
      description +
      `\n<${env.APP_BASE_URL ?? ''}/ai-ops|Open AI Operations panel>`;
    try {
      result.slackSent = await deps.sendSlack(slackWebhook, slackText);
    } catch (err) {
      logger.warn('[StorageHealthAlerts] Slack notification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Email — re-uses the same recipient list as the cost cron so ops only
  // manages one env var (AI_COST_ALERT_EMAIL). Skipped silently when not
  // configured.
  const emailRaw = env.AI_COST_ALERT_EMAIL;
  const emailRecipients = emailRaw
    ? emailRaw
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean)
    : [];
  if (emailRecipients.length > 0) {
    try {
      result.emailSent = await deps.sendEmail({
        to: emailRecipients,
        subject: `⚠️ WalaPlus AI Storage Alert — ai_call_metrics outside ${stats.retentionDays}d window`,
        html:
          `<h2>AI Usage Table Storage Alert</h2>` +
          `<p>${description}</p>` +
          `<ul>` +
          `<li>Total rows: ${stats.rowCount.toLocaleString()}</li>` +
          `<li>Oldest row age: ${
            stats.oldestAgeDays != null
              ? `${Math.round(stats.oldestAgeDays * 10) / 10} days`
              : 'unknown'
          }</li>` +
          `<li>Configured retention: ${stats.retentionDays} days</li>` +
          (stats.lastPrune
            ? `<li>Last prune: ${
                stats.lastPrune.success ? 'succeeded' : 'FAILED'
              } at ${stats.lastPrune.ranAt} (deleted ${stats.lastPrune.rowsDeleted})</li>`
            : '<li>Last prune: no history yet</li>') +
          `</ul>` +
          `<p><a href="/ai-ops">View AI Operations panel</a></p>` +
          `<p><em>This alert will auto-resolve on the next cron pass once ` +
          `the oldest row is back inside the window.</em></p>`,
      });
    } catch (err) {
      logger.warn('[StorageHealthAlerts] Email notification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// Re-page sweep (Task #679)
//
// The /ai-ops storage-health banner surfaces an open alert as soon as the
// daily prune leaves rows outside the retention window. But if no operator
// happens to be looking at the dashboard, the alert can sit "open" for days
// without anyone being paged again — `evaluateAndAlertStorageHealth` only
// pages on the *first* breach (dedupe), so a stuck prune slowly drifts out
// of incident response.
//
// `repageStaleStorageHealthAlerts` closes that gap by re-sending the Slack
// /email page for any storage_health alert whose `notified_at` is older
// than the configured threshold (default 24 h). Mirrors the tool-health
// re-notify cadence:
//   • throttle keyed on `notified_at` so we don't spam channels every cron
//     tick — at most one re-page per `STORAGE_HEALTH_REPAGE_AFTER_MIN`
//     minutes per alert,
//   • respects the existing quiet-hours window so we don't page on-call at
//     3 a.m. about a backlog they cannot act on until morning,
//   • configurable / disable-able via env (`STORAGE_HEALTH_REPAGE_AFTER_MIN
//     =0` switches the sweep off without a code change).
// ──────────────────────────────────────────────────────────────────────────────

export interface StorageHealthRepageDeps {
  /**
   * Returns every open / acknowledged storage_health alert for the dedupe
   * key. Production callers pass `getOpenAlertsByKey` from
   * `aiAlertsDatabase`. Each row must include `id`, `created_at`, and
   * `notified_at` so the sweep can decide which alerts are stale enough
   * to re-page.
   */
  getOpenAlertsByKey: (
    alertType: 'storage_health',
    relatedRecordId: string,
  ) => Promise<AIAlert[]>;
  /**
   * Persists the re-page attempt timestamp on the alert row so subsequent
   * sweeps respect the throttle window. Production callers pass
   * `recordAlertNotificationResult` from `aiAlertsDatabase`.
   */
  recordAlertNotified: (
    alertId: number,
    channel: string,
    whenMs: number,
  ) => Promise<void>;
  sendSlack: (webhookUrl: string, text: string) => Promise<boolean>;
  sendEmail: (input: {
    to: string[];
    subject: string;
    html: string;
  }) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface StorageHealthRepageResult {
  /** True when the sweep is disabled via env (`*_REPAGE_AFTER_MIN<=0`). */
  disabled: boolean;
  /** Total open storage_health alerts inspected on this pass. */
  alertsConsidered: number;
  /**
   * Alerts skipped because they have already been acknowledged by an
   * operator. Once triaged, the alert is no longer "ignored" so the sweep
   * stops re-paging — the operator has signalled they are looking.
   */
  alertsSkippedAcknowledged: number;
  /** Alerts skipped because they are not yet older than the threshold. */
  alertsSkippedYoung: number;
  /** Alerts skipped because notified_at is inside the throttle window. */
  alertsThrottled: number;
  /** Alerts that would have been re-paged but quiet hours suppressed it. */
  alertsQuietHoursSuppressed: number;
  /** Alerts where we attempted a re-page (Slack and/or email). */
  alertsRepaged: number;
  /** Slack webhook calls that returned ok. */
  slackSent: number;
  /** Email sends that returned success. */
  emailSent: number;
  /**
   * True when the cron tick fell inside quiet-hours and the sweep
   * intentionally suppressed Slack/email. The alerts are still counted as
   * "considered" so the cron log line shows the sweep ran.
   */
  quietHoursActive: boolean;
}

/**
 * Resolve the re-page threshold (in minutes) from env. Returns `null` when
 * the sweep is disabled (operator set `*_REPAGE_AFTER_MIN<=0`). Invalid
 * values fall back to the built-in default so a typo cannot silently
 * disable on-call paging.
 *
 * Exported for unit tests.
 */
export function resolveRepageAfterMinutes(env: NodeJS.ProcessEnv): number | null {
  const raw = env.STORAGE_HEALTH_REPAGE_AFTER_MIN;
  if (raw == null || raw.trim() === '') return STORAGE_HEALTH_REPAGE_DEFAULT_MIN;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) {
    logger.warn(
      '[StorageHealthAlerts] Invalid STORAGE_HEALTH_REPAGE_AFTER_MIN; using default',
      { provided: raw, defaultMin: STORAGE_HEALTH_REPAGE_DEFAULT_MIN },
    );
    return STORAGE_HEALTH_REPAGE_DEFAULT_MIN;
  }
  if (n <= 0) return null;
  return Math.floor(n);
}

function buildRepageMessages(
  alert: AIAlert,
  ageMinutes: number,
  appBaseUrl: string,
): { slackText: string; emailSubject: string; emailHtml: string } {
  const ageHours = Math.round((ageMinutes / 60) * 10) / 10;
  const slackText =
    `:rotating_light: *AI Storage Health — alert still OPEN after ${ageHours}h* ` +
    `(re-page).\n` +
    `${alert.title}\n` +
    `Severity: ${alert.severity}. ` +
    `No-one has acknowledged the storage_health alert opened by the daily ` +
    `prune cron. ${alert.description ?? ''}\n` +
    `<${appBaseUrl}/ai-ops|Open AI Operations panel>`;
  const emailSubject =
    `🚨 WalaPlus AI Storage Alert STILL OPEN after ${ageHours}h — please triage`;
  const emailHtml =
    `<h2>AI Usage Table Storage Alert — re-page</h2>` +
    `<p><strong>${alert.title}</strong></p>` +
    `<p>This alert has been in the OPEN state for ${ageHours} hours and ` +
    `nobody has acknowledged it on /ai-ops yet. The daily prune cron is ` +
    `re-paging on-call so the backlog does not silently grow.</p>` +
    (alert.description ? `<p>${alert.description}</p>` : '') +
    `<p><a href="${appBaseUrl}/ai-ops">View AI Operations panel</a></p>` +
    `<p><em>Re-pages will continue every ` +
    `STORAGE_HEALTH_REPAGE_AFTER_MIN minutes until the alert is ` +
    `acknowledged or resolved.</em></p>`;
  return { slackText, emailSubject, emailHtml };
}

/**
 * Re-page on-call for any storage_health alert that has been "open" too
 * long without acknowledgement. Idempotent: safe to call once per cron
 * pass — the throttle (notified_at within `repageAfterMin`) ensures at
 * most one re-page per alert per window.
 *
 * Notification failures are logged but never thrown so a transient Slack
 * /Resend outage cannot abort the surrounding cron pass.
 */
export async function repageStaleStorageHealthAlerts(
  deps: StorageHealthRepageDeps,
): Promise<StorageHealthRepageResult> {
  const env = deps.env ?? process.env;
  const nowFn = deps.now ?? (() => new Date());
  const now = nowFn();
  const repageAfterMin = resolveRepageAfterMinutes(env);
  const quietHours = resolveQuietHoursWindow(env);
  const inQuietHours = quietHours.enabled && isInQuietHours(quietHours, now);

  const result: StorageHealthRepageResult = {
    disabled: repageAfterMin == null,
    alertsConsidered: 0,
    alertsSkippedAcknowledged: 0,
    alertsSkippedYoung: 0,
    alertsThrottled: 0,
    alertsQuietHoursSuppressed: 0,
    alertsRepaged: 0,
    slackSent: 0,
    emailSent: 0,
    quietHoursActive: inQuietHours,
  };

  if (repageAfterMin == null) {
    logger.info(
      '[StorageHealthAlerts] Re-page sweep disabled via STORAGE_HEALTH_REPAGE_AFTER_MIN<=0',
    );
    return result;
  }

  let openAlerts: AIAlert[] = [];
  try {
    openAlerts = await deps.getOpenAlertsByKey(
      'storage_health',
      STORAGE_HEALTH_DEDUPE_KEY,
    );
  } catch (err) {
    logger.warn('[StorageHealthAlerts] Re-page sweep: failed to list open alerts', {
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  result.alertsConsidered = openAlerts.length;
  if (openAlerts.length === 0) return result;

  const slackWebhook = env.SLACK_WEBHOOK_URL;
  const emailRaw = env.AI_COST_ALERT_EMAIL;
  const emailRecipients = emailRaw
    ? emailRaw
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean)
    : [];
  const appBaseUrl = env.APP_BASE_URL ?? '';
  const nowMs = now.getTime();
  const thresholdMs = repageAfterMin * 60_000;

  for (const alert of openAlerts) {
    if (alert.id == null) continue;

    // Skip acknowledged alerts — once an operator has triaged the row, it
    // is no longer "ignored". `getOpenAlertsByKey` returns both 'open' and
    // 'acknowledged' for dedupe/auto-resolve symmetry, so we filter here.
    if (alert.status !== 'open') {
      result.alertsSkippedAcknowledged++;
      continue;
    }

    // Stale-enough check: prefer notified_at (last paging attempt) so the
    // first re-page fires repageAfterMin after the initial page, NOT
    // repageAfterMin after the alert was created. Falls back to created_at
    // for legacy rows that pre-date Task #284's notified_at column.
    const lastPagedAt =
      (alert.notified_at != null
        ? new Date(alert.notified_at as unknown as string).getTime()
        : null) ??
      (alert.created_at != null
        ? new Date(alert.created_at as unknown as string).getTime()
        : null);
    if (lastPagedAt == null) {
      // No timestamps at all — extremely unlikely, but treat as not-yet-stale
      // so we don't re-page on a malformed row.
      result.alertsSkippedYoung++;
      continue;
    }
    const ageMs = nowMs - lastPagedAt;
    if (ageMs < thresholdMs) {
      // The alert was created or last paged inside the throttle window.
      // Both situations mean "skip" but we count them separately so cron
      // logs distinguish "alert is fresh" from "alert is stale but the
      // last re-page is still inside the cooldown".
      if (alert.notified_at != null) {
        result.alertsThrottled++;
      } else {
        result.alertsSkippedYoung++;
      }
      continue;
    }

    if (inQuietHours) {
      result.alertsQuietHoursSuppressed++;
      logger.info(
        '[StorageHealthAlerts] Re-page suppressed: quiet hours active',
        {
          alertId: alert.id,
          ageMinutes: Math.round(ageMs / 60_000),
          startHour: quietHours.startHour,
          endHour: quietHours.endHour,
          tz: quietHours.tz,
        },
      );
      continue;
    }

    const ageMinutes = Math.round(ageMs / 60_000);
    const { slackText, emailSubject, emailHtml } = buildRepageMessages(
      alert,
      ageMinutes,
      appBaseUrl,
    );

    let slackOk = false;
    let emailOk = false;

    if (slackWebhook) {
      try {
        slackOk = await deps.sendSlack(slackWebhook, slackText);
        if (slackOk) result.slackSent++;
      } catch (err) {
        logger.warn('[StorageHealthAlerts] Re-page Slack send failed', {
          alertId: alert.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (emailRecipients.length > 0) {
      try {
        emailOk = await deps.sendEmail({
          to: emailRecipients,
          subject: emailSubject,
          html: emailHtml,
        });
        if (emailOk) result.emailSent++;
      } catch (err) {
        logger.warn('[StorageHealthAlerts] Re-page email send failed', {
          alertId: alert.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Stamp notified_at even when both channels were unconfigured so the
    // sweep doesn't loop forever logging "stale" with no channel to send
    // on. The channel label captures the actual delivery outcome so the
    // AI Ops "Notified" column reflects reality.
    const channel =
      slackOk && emailOk
        ? 'slack+email_repage'
        : slackOk
          ? 'slack_repage'
          : emailOk
            ? 'email_repage'
            : !slackWebhook && emailRecipients.length === 0
              ? 'not_configured_repage'
              : 'failed_repage';

    try {
      await deps.recordAlertNotified(alert.id, channel, nowMs);
    } catch (err) {
      logger.warn('[StorageHealthAlerts] Re-page notified_at write failed', {
        alertId: alert.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    result.alertsRepaged++;
    logger.warn(
      `[StorageHealthAlerts] Re-paged stale storage_health alert #${alert.id} ` +
        `(open ${ageMinutes}m, channel=${channel})`,
    );
  }

  return result;
}
