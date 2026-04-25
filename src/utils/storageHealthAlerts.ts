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
  const result: StorageHealthAlertResult = {
    alertCreated: false,
    alertDeduped: false,
    alertsResolved: 0,
    slackSent: false,
    emailSent: false,
    inAppCreated: false,
    exceedsRetention: stats.exceedsRetention,
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
