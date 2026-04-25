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
