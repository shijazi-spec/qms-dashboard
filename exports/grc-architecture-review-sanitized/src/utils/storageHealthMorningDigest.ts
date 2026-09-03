/**
 * Morning digest of alerts that were suppressed overnight (Task #604).
 *
 * Background
 * ──────────
 * Task #579 added a quiet-hours window to {@link evaluateAndAlertStorageHealth}
 * so storage-health Slack/email pushes are intentionally muted between
 * `STORAGE_HEALTH_QUIET_HOURS_START` and `STORAGE_HEALTH_QUIET_HOURS_END` (in
 * `STORAGE_HEALTH_QUIET_HOURS_TZ`). The `ai_alerts` row + in-app notification
 * are still created in real time, but the noisy channels are skipped so
 * on-call isn't paged at 3 a.m. about a backlog they cannot act on until
 * morning.
 *
 * The gap that introduced: an operator who doesn't open `/ai-ops` first
 * thing in the morning could miss a breach that fired at 02:00 because no
 * fresh push arrives once the window closes — the next storage-health cron
 * dedupes against the existing open alert and never re-pages.
 *
 * What this module does
 * ─────────────────────
 * Once per day, shortly after the configured quiet-hours window ends, this
 * cron:
 *   1. Resolves the same `QuietHoursWindow` config the breach helper uses.
 *   2. Computes the inclusive-from / exclusive-to instants of the window
 *      that just closed.
 *   3. Queries every still-unresolved `storage_health` alert created
 *      inside that window via {@link getUnresolvedAlertsCreatedBetween}.
 *   4. Builds a single Slack/email summary listing those alerts and pushes
 *      it to the same channels the breach helper uses
 *      (`SLACK_WEBHOOK_URL`, `AI_COST_ALERT_EMAIL`).
 *
 * Opt-out
 * ───────
 * Sites that prefer pure in-app surfacing can set
 * `STORAGE_HEALTH_MORNING_DIGEST_DISABLED=1` (or `true`/`yes`/`on`). When
 * the opt-out is active the cron returns immediately without querying or
 * pushing anything.
 *
 * Extensibility
 * ─────────────
 * `alertTypes` is plumbed through as an array so prompt-regression and
 * tool-health alerts can be folded into the same morning digest later
 * without a second cron — the task description explicitly anticipates that.
 *
 * All side-effects are injected via {@link MorningDigestDeps} so this module
 * is unit-testable without a database, Slack, or Resend.
 */

import { logger } from './logger';
import {
  resolveQuietHoursWindow,
  type QuietHoursWindow,
} from './storageHealthAlerts';
import type { AIAlert, AlertType } from './aiAlertsDatabase';

/** Truthy env values that disable the digest. */
const OPT_OUT_TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export interface MorningDigestDeps {
  /**
   * Returns every still-unresolved alert of the given types created inside
   * the half-open `[fromMs, toMs)` window. See
   * {@link getUnresolvedAlertsCreatedBetween}.
   */
  getUnresolvedAlertsCreatedBetween: (
    alertTypes: AlertType[],
    fromMs: number,
    toMs: number,
  ) => Promise<AIAlert[]>;
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
   * Returns the "current time" used to compute the just-closed window.
   * Injected so unit tests can pin the clock to e.g. 07:00 Riyadh and
   * assert the window deterministically. Defaults to `new Date()`.
   */
  now?: () => Date;
  /** Alert types to include in the digest. Defaults to `['storage_health']`. */
  alertTypes?: AlertType[];
}

export interface MorningDigestResult {
  /** True when the opt-out env var disabled the cron. */
  optedOut: boolean;
  /** True when no quiet-hours window is configured (nothing to digest). */
  quietHoursDisabled: boolean;
  /** Inclusive epoch-ms start of the window that just closed (when computed). */
  windowFromMs: number | null;
  /** Exclusive epoch-ms end of the window that just closed (when computed). */
  windowToMs: number | null;
  /** Number of unresolved alerts that fell inside the window. */
  alertCount: number;
  /** True when Slack was attempted and reported success. */
  slackSent: boolean;
  /** True when email was attempted and reported success. */
  emailSent: boolean;
  /** True when the cron exited early because no alerts fell in the window. */
  noAlertsInWindow: boolean;
}

/**
 * Length in hours of the half-open quiet-hours window. Same-day windows are
 * `end - start`; wrap-around windows (e.g. 22→07) are `(24 - start) + end`.
 * Returns 0 when the window is disabled or malformed — callers should
 * short-circuit before calling.
 */
export function quietHoursLengthHours(window: QuietHoursWindow): number {
  if (!window.enabled || window.startHour == null || window.endHour == null) {
    return 0;
  }
  const { startHour, endHour } = window;
  if (startHour === endHour) return 0;
  if (startHour < endHour) return endHour - startHour;
  return 24 - startHour + endHour;
}

function isOptedOut(env: NodeJS.ProcessEnv): boolean {
  const raw = env.STORAGE_HEALTH_MORNING_DIGEST_DISABLED;
  if (raw == null) return false;
  return OPT_OUT_TRUTHY.has(raw.trim().toLowerCase());
}

function severityLabel(sev: string): string {
  return sev.toUpperCase();
}

function formatAlertLine(a: AIAlert): string {
  const created = a.created_at
    ? new Date(a.created_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : 'unknown time';
  return `• [${severityLabel(a.severity)}] ${created} — ${a.title}`;
}

/**
 * Build the user-visible Slack / email digest copy. Pure function so the
 * cron and tests agree on wording.
 */
export function buildMorningDigestMessage(
  alerts: AIAlert[],
  windowFromMs: number,
  windowToMs: number,
  appBaseUrl: string,
): { slackText: string; emailSubject: string; emailHtml: string } {
  const fromIso = new Date(windowFromMs).toISOString().replace('T', ' ').slice(0, 16);
  const toIso = new Date(windowToMs).toISOString().replace('T', ' ').slice(0, 16);
  const link = `${appBaseUrl || ''}/dashboard`;

  const header =
    `:sunrise: *Morning digest — ${alerts.length} unresolved alert` +
    `${alerts.length === 1 ? '' : 's'} fired during quiet hours* ` +
    `(${fromIso} → ${toIso} UTC)`;
  const lines = alerts.map(formatAlertLine);
  const slackText = `${header}\n${lines.join('\n')}\n<${link}|Open AI Operations panel>`;

  const emailSubject =
    `🌅 ExampleOrg AI overnight digest — ${alerts.length} unresolved alert` +
    `${alerts.length === 1 ? '' : 's'}`;
  const rows = alerts
    .map((a) => {
      const created = a.created_at
        ? new Date(a.created_at).toISOString()
        : 'unknown';
      return (
        `<tr>` +
        `<td style="padding:4px 8px;"><strong>${severityLabel(a.severity)}</strong></td>` +
        `<td style="padding:4px 8px;">${created}</td>` +
        `<td style="padding:4px 8px;">${escapeHtml(a.title)}</td>` +
        `</tr>`
      );
    })
    .join('');
  const emailHtml =
    `<h2>Morning digest — alerts suppressed overnight</h2>` +
    `<p>${alerts.length} unresolved alert${alerts.length === 1 ? '' : 's'} ` +
    `fired during the quiet-hours window <strong>${fromIso} → ${toIso} UTC</strong>. ` +
    `Slack/email pushes were intentionally suppressed at the time; this digest ` +
    `surfaces them now that the window has closed.</p>` +
    `<table style="border-collapse:collapse;border:1px solid #ccc;">` +
    `<thead><tr>` +
    `<th style="padding:4px 8px;text-align:left;">Severity</th>` +
    `<th style="padding:4px 8px;text-align:left;">Created (UTC)</th>` +
    `<th style="padding:4px 8px;text-align:left;">Alert</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    `<p><a href="${link}">Open AI Operations panel</a></p>` +
    `<p><em>Set <code>STORAGE_HEALTH_MORNING_DIGEST_DISABLED=1</code> to opt out ` +
    `and rely solely on the in-app feed.</em></p>`;

  return { slackText, emailSubject, emailHtml };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Run one pass of the morning digest.
 *
 * Idempotency: this is intended to fire once per day from the cron at the
 * end of the quiet-hours window. If the cron triggers twice within the
 * same morning the digest will simply re-send (we deliberately do not
 * persist a "last sent" marker — the operator preference is "occasionally
 * a duplicate" over "missed digest after a deploy/restart").
 *
 * Notification failures are logged but never thrown so a transient external
 * outage cannot crash the cron pass.
 */
export async function runStorageHealthMorningDigest(
  deps: MorningDigestDeps,
): Promise<MorningDigestResult> {
  const env = deps.env ?? process.env;
  const nowFn = deps.now ?? (() => new Date());
  const alertTypes = deps.alertTypes ?? (['storage_health'] as AlertType[]);
  const result: MorningDigestResult = {
    optedOut: false,
    quietHoursDisabled: false,
    windowFromMs: null,
    windowToMs: null,
    alertCount: 0,
    slackSent: false,
    emailSent: false,
    noAlertsInWindow: false,
  };

  if (isOptedOut(env)) {
    result.optedOut = true;
    logger.info(
      '[StorageHealthMorningDigest] STORAGE_HEALTH_MORNING_DIGEST_DISABLED is set; skipping',
    );
    return result;
  }

  const window = resolveQuietHoursWindow(env);
  const lengthHours = quietHoursLengthHours(window);
  if (!window.enabled || lengthHours <= 0) {
    result.quietHoursDisabled = true;
    logger.info(
      '[StorageHealthMorningDigest] Quiet-hours window not configured; nothing to digest',
    );
    return result;
  }

  const now = nowFn();
  const toMs = now.getTime();
  const fromMs = toMs - lengthHours * 3600 * 1000;
  result.windowFromMs = fromMs;
  result.windowToMs = toMs;

  let alerts: AIAlert[] = [];
  try {
    alerts = await deps.getUnresolvedAlertsCreatedBetween(alertTypes, fromMs, toMs);
  } catch (err) {
    logger.warn('[StorageHealthMorningDigest] Failed to query alerts', {
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }
  result.alertCount = alerts.length;

  if (alerts.length === 0) {
    result.noAlertsInWindow = true;
    logger.info(
      '[StorageHealthMorningDigest] No unresolved alerts in just-closed window; ' +
        'no digest sent',
      { fromMs, toMs },
    );
    return result;
  }

  const appBaseUrl = env.APP_BASE_URL ?? '';
  const { slackText, emailSubject, emailHtml } = buildMorningDigestMessage(
    alerts,
    fromMs,
    toMs,
    appBaseUrl,
  );

  const slackWebhook = env.SLACK_WEBHOOK_URL;
  if (slackWebhook) {
    try {
      result.slackSent = await deps.sendSlack(slackWebhook, slackText);
    } catch (err) {
      logger.warn('[StorageHealthMorningDigest] Slack push failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const emailRaw = env.AI_COST_ALERT_EMAIL;
  const recipients = emailRaw
    ? emailRaw.split(',').map((e) => e.trim()).filter(Boolean)
    : [];
  if (recipients.length > 0) {
    try {
      result.emailSent = await deps.sendEmail({
        to: recipients,
        subject: emailSubject,
        html: emailHtml,
      });
    } catch (err) {
      logger.warn('[StorageHealthMorningDigest] Email push failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('[StorageHealthMorningDigest] Digest dispatched', {
    alertCount: alerts.length,
    slackSent: result.slackSent,
    emailSent: result.emailSent,
    fromMs,
    toMs,
  });
  return result;
}
