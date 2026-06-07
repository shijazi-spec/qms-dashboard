/**
 * 24h Rate-Limit 429 Spike Alert (Task #282)
 *
 * Goal: proactively warn ops when the rolling-24h count of `rate_limit_429`
 * `system_events` rows crosses a configurable threshold (default 500). Until
 * now this surge was only visible on the admin dashboard's Rate Limits tab —
 * an active attack could be in flight for hours before anyone refreshed the
 * page.
 *
 * Behaviour:
 *   1. The check is run by a once-per-hour Inngest cron (see
 *      `src/mastra/inngest/index.ts`). Every tick it re-reads the same 24h
 *      aggregate the dashboard uses (`getRateLimitStats().spike24h`) so what
 *      ops see in the UI is what triggers the page.
 *   2. When `total429 >= threshold` AND no equivalent spike event has been
 *      written in the last `repeatHours` (default 6), we:
 *         • write a `rate_limit_429_spike_alert` row to `system_events` with
 *           full context (total429, threshold, top-5 IPs, suppressed) so
 *           there is a permanent audit trail and the activity feed picks it
 *           up automatically;
 *         • emit a structured logger.warn so log-shipping pipelines see it;
 *         • best-effort POST to `RATE_LIMIT_429_SLACK_WEBHOOK_URL` (or
 *           falls back to `SLACK_WEBHOOK_URL` when the dedicated var is
 *           unset) — never blocks, never throws.
 *   3. The dashboard reads `spike24h.alertActive` / `spike24h.alertThreshold`
 *      added to `getRateLimitStats()` and renders a red banner above the
 *      spike summary card so dashboard viewers also see the alert state
 *      in real time.
 *
 * Configuration (env vars):
 *   • RATE_LIMIT_429_24H_ALERT_THRESHOLD         — integer, default 500.
 *                                                   Set to 0 to disable the
 *                                                   alert entirely.
 *   • RATE_LIMIT_429_24H_ALERT_REPEAT_HOURS      — integer, default 6.
 *                                                   Suppresses repeat alerts
 *                                                   for an ongoing spike.
 *   • RATE_LIMIT_429_SLACK_WEBHOOK_URL           — optional Slack webhook
 *                                                   for the page. Falls back
 *                                                   to SLACK_WEBHOOK_URL.
 *   • RATE_LIMIT_429_24H_ALERT_CRON              — cron expression, default
 *                                                   "15 * * * *" (every hour
 *                                                   at :15 to avoid colliding
 *                                                   with the pruner at :00).
 *
 * The pure helper `evaluateRateLimit24hSpikeAlert()` is exported so the
 * dashboard / `getRateLimitStats()` and the cron share a single source of
 * truth for "is this spike alert-worthy".
 */

import pg from "pg";
import pino from "pino";

import { logger as safeLogger } from "./logger";
const { Pool } = pg;

const logger = pino({ level: "warn", name: "rateLimit429SpikeAlert" });

let sharedPool: InstanceType<typeof Pool> | null = null;
function getPool(): InstanceType<typeof Pool> {
  if (!sharedPool) {
    sharedPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return sharedPool;
}

/** Parse a positive-integer env var with a fallback. `0` and negatives fall back. */
function envPosInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Read the alert threshold (events per 24h above which we alert ops).
 * `0` disables the alert; any non-positive or non-numeric value falls back
 * to the default (500).
 *
 * Default 500 is intentionally generous — a normal day on a small tenant
 * fleet stays well below this; a sustained scrape/abuse attempt easily
 * crosses it.
 */
export function getRateLimit24hAlertThreshold(): number {
  const raw = process.env.RATE_LIMIT_429_24H_ALERT_THRESHOLD;
  if (raw == null || raw === "") return 500;
  const n = parseInt(raw, 10);
  // Allow exactly 0 as an explicit "disable" sentinel.
  if (Number.isFinite(n) && n >= 0) return n;
  return 500;
}

/** Hours within which we suppress repeat alerts for an ongoing spike. */
export function getRateLimit24hAlertRepeatHours(): number {
  return envPosInt("RATE_LIMIT_429_24H_ALERT_REPEAT_HOURS", 6);
}

export interface SpikeAlertEvaluation {
  /** True when total429 >= threshold AND threshold > 0 (i.e. not disabled). */
  active: boolean;
  /** Effective threshold (after env-var read). 0 means disabled. */
  threshold: number;
  /** Mirror of the input total429 for the convenience of the dashboard. */
  total429: number;
  /** Reason string suitable for log lines / system_event descriptions. */
  reason: "disabled" | "below_threshold" | "above_threshold";
}

/**
 * Pure helper: decide whether the 24h spike count crosses the alert
 * threshold. Shared by the dashboard's `getRateLimitStats()` (so the UI
 * banner mirrors what the cron will alert on) and by the cron itself.
 */
export function evaluateRateLimit24hSpikeAlert(
  total429: number,
  threshold: number = getRateLimit24hAlertThreshold(),
): SpikeAlertEvaluation {
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return { active: false, threshold: 0, total429, reason: "disabled" };
  }
  if (total429 >= threshold) {
    return { active: true, threshold, total429, reason: "above_threshold" };
  }
  return { active: false, threshold, total429, reason: "below_threshold" };
}

export interface SpikeAlertTopIp {
  ip: string;
  events: number;
  suppressed: number;
}

export interface SpikeAlertCheckResult {
  /** Whether the eval crossed the threshold. */
  active: boolean;
  /** Effective threshold (0 = disabled). */
  threshold: number;
  /** Trailing-24h `rate_limit_429` count. */
  total429: number;
  /** True iff a system_event was emitted in this tick. */
  alertEmitted: boolean;
  /** True iff the alert was suppressed because a sibling was emitted recently. */
  alertSuppressedAsRepeat: boolean;
  /** True iff we sent a Slack page in this tick. */
  slackSent: boolean;
  /** True iff we sent at least one email in this tick. */
  emailSent: boolean;
  /** Diagnostic reason string. */
  reason: SpikeAlertEvaluation["reason"] | "evaluation_failed" | "db_error";
}

export interface SpikeAlertCheckDeps {
  /**
   * Returns the latest `{ total429, topIps }` aggregate (over the last 24h).
   * Defaults to a query against `system_events`. Tests inject a stub.
   */
  fetchSpikeAggregate?: () => Promise<{
    total429: number;
    totalSuppressed: number;
    topIps: SpikeAlertTopIp[];
  }>;
  /**
   * Counts how many `rate_limit_429_spike_alert` `system_events` rows we
   * wrote in the last `withinHours`. Defaults to a real DB query.
   */
  countRecentAlertEmissions?: (withinHours: number) => Promise<number>;
  /** Writes the alert system_event. Defaults to `logSystemEvent`. */
  emitSystemEvent?: (payload: {
    description: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
  /**
   * Best-effort Slack notify. Defaults to `fetch(WEBHOOK)` when a webhook
   * is configured; no-op when not. Tests stub this so no real HTTP fires.
   */
  postSlack?: (text: string) => Promise<boolean>;
  /**
   * Best-effort email notify. Defaults to `sendResendEmail` when an
   * `RATE_LIMIT_429_ALERT_EMAIL` recipient list is configured; no-op when
   * not. Tests stub this.
   */
  sendEmail?: (subject: string, html: string, text: string) => Promise<boolean>;
  /** Override the threshold (mostly for tests). */
  threshold?: number;
  /** Override the repeat-suppression window in hours (mostly for tests). */
  repeatHours?: number;
}

const DEFAULT_FETCH_AGGREGATE: NonNullable<
  SpikeAlertCheckDeps["fetchSpikeAggregate"]
> = async () => {
  const pool = getPool();
  // Mirrors the same query used in `getRateLimitStats()` so what we alert
  // on is what the dashboard shows.
  const [totRow, topRow] = await Promise.all([
    pool.query<{ total: string; suppressed: string }>(
      `SELECT
          COUNT(*)::bigint AS total,
          SUM(COALESCE((metadata->>'suppressed_in_previous_minute')::bigint, 0))::bigint AS suppressed
         FROM system_events
        WHERE event_type = 'rate_limit_429'
          AND created_at > NOW() - INTERVAL '24 hours'`,
    ),
    pool.query<{ ip: string; events: string; suppressed: string }>(
      `SELECT
          COALESCE(metadata->>'ip', 'unknown')           AS ip,
          COUNT(*)::bigint                               AS events,
          SUM(COALESCE((metadata->>'suppressed_in_previous_minute')::bigint, 0))::bigint AS suppressed
         FROM system_events
        WHERE event_type = 'rate_limit_429'
          AND created_at > NOW() - INTERVAL '24 hours'
        GROUP BY ip
        ORDER BY events DESC
        LIMIT 5`,
    ),
  ]);
  return {
    total429: parseInt(totRow.rows[0]?.total ?? "0", 10),
    totalSuppressed: parseInt(totRow.rows[0]?.suppressed ?? "0", 10),
    topIps: topRow.rows.map((r) => ({
      ip: r.ip,
      events: parseInt(r.events, 10),
      suppressed: parseInt(r.suppressed, 10),
    })),
  };
};

const DEFAULT_COUNT_RECENT: NonNullable<
  SpikeAlertCheckDeps["countRecentAlertEmissions"]
> = async (withinHours) => {
  const pool = getPool();
  const r = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::bigint AS count
       FROM system_events
      WHERE event_type = 'rate_limit_429_spike_alert'
        AND created_at > NOW() - ($1::int * INTERVAL '1 hour')`,
    [withinHours],
  );
  return parseInt(r.rows[0]?.count ?? "0", 10);
};

const DEFAULT_EMIT_EVENT: NonNullable<
  SpikeAlertCheckDeps["emitSystemEvent"]
> = async ({ description, metadata }) => {
  const { logSystemEvent } = await import("./database");
  await logSystemEvent({
    event_type: "rate_limit_429_spike_alert",
    event_category: "security",
    description,
    severity: "warning",
    source: "rateLimit429SpikeAlert",
    metadata,
  });
};

const DEFAULT_POST_SLACK: NonNullable<
  SpikeAlertCheckDeps["postSlack"]
> = async (text) => {
  const url =
    process.env.RATE_LIMIT_429_SLACK_WEBHOOK_URL ||
    process.env.SLACK_WEBHOOK_URL ||
    "";
  if (!url) return false;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      logger.warn(
        {
          status: response.status,
          statusText: response.statusText,
          component: "rateLimit429SpikeAlert",
        },
        "Slack webhook returned non-2xx — alert was already written to system_events",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, component: "rateLimit429SpikeAlert" },
      "Slack webhook POST failed — alert was already written to system_events",
    );
    return false;
  }
};

const DEFAULT_SEND_EMAIL: NonNullable<
  SpikeAlertCheckDeps["sendEmail"]
> = async (subject, html, text) => {
  const raw = (process.env.RATE_LIMIT_429_ALERT_EMAIL || "").trim();
  if (!raw) return false;
  const recipients = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (recipients.length === 0) return false;
  try {
    const { sendResendEmail } = await import("./resendMail");
    const r = await sendResendEmail({ to: recipients, subject, html, text });
    return !!r?.success;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, component: "rateLimit429SpikeAlert" },
      "Email send failed — alert was already written to system_events",
    );
    return false;
  }
};

function formatTopIps(topIps: SpikeAlertTopIp[]): string {
  if (topIps.length === 0) return "(no per-IP breakdown available)";
  return topIps
    .map(
      (t, i) =>
        `  ${i + 1}. ${t.ip} — ${t.events} events` +
        (t.suppressed > 0 ? ` (+${t.suppressed} suppressed)` : ""),
    )
    .join("\n");
}

function formatTopIpsHtml(topIps: SpikeAlertTopIp[]): string {
  if (topIps.length === 0) {
    return "<p><em>(no per-IP breakdown available)</em></p>";
  }
  const rows = topIps
    .map(
      (t, i) =>
        `<tr>
          <td style="padding:4px 8px">${i + 1}</td>
          <td style="padding:4px 8px;font-family:monospace">${escapeHtml(t.ip)}</td>
          <td style="padding:4px 8px;text-align:right">${t.events}</td>
          <td style="padding:4px 8px;text-align:right">${t.suppressed}</td>
        </tr>`,
    )
    .join("\n");
  return `<table border="1" cellspacing="0" cellpadding="0"
    style="border-collapse:collapse;font-size:13px">
    <thead style="background:#f5f5f5">
      <tr>
        <th style="padding:4px 8px">#</th>
        <th style="padding:4px 8px">IP</th>
        <th style="padding:4px 8px">Events</th>
        <th style="padding:4px 8px">Suppressed</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Run the 24h spike alert check. Idempotent and safe to call from the cron;
 * the repeat-suppression window prevents flapping during an ongoing spike.
 *
 * Never throws — all DB / Slack / email failures are caught and surfaced
 * via the result so the cron's bookkeeping stays intact.
 */
export async function runRateLimit429SpikeAlertCheck(
  depsOverride: SpikeAlertCheckDeps = {},
): Promise<SpikeAlertCheckResult> {
  const threshold = depsOverride.threshold ?? getRateLimit24hAlertThreshold();
  const repeatHours =
    depsOverride.repeatHours ?? getRateLimit24hAlertRepeatHours();

  const fetchAggregate =
    depsOverride.fetchSpikeAggregate ?? DEFAULT_FETCH_AGGREGATE;
  const countRecent =
    depsOverride.countRecentAlertEmissions ?? DEFAULT_COUNT_RECENT;
  const emitEvent = depsOverride.emitSystemEvent ?? DEFAULT_EMIT_EVENT;
  const postSlack = depsOverride.postSlack ?? DEFAULT_POST_SLACK;
  const sendEmail = depsOverride.sendEmail ?? DEFAULT_SEND_EMAIL;

  // Threshold disabled — short-circuit before touching the DB.
  if (threshold <= 0) {
    return {
      active: false,
      threshold: 0,
      total429: 0,
      alertEmitted: false,
      alertSuppressedAsRepeat: false,
      slackSent: false,
      emailSent: false,
      reason: "disabled",
    };
  }

  let aggregate: {
    total429: number;
    totalSuppressed: number;
    topIps: SpikeAlertTopIp[];
  };
  try {
    aggregate = await fetchAggregate();
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, component: "rateLimit429SpikeAlert" },
      "Failed to fetch 24h spike aggregate — skipping alert check this tick",
    );
    return {
      active: false,
      threshold,
      total429: 0,
      alertEmitted: false,
      alertSuppressedAsRepeat: false,
      slackSent: false,
      emailSent: false,
      reason: "db_error",
    };
  }

  const evalResult = evaluateRateLimit24hSpikeAlert(
    aggregate.total429,
    threshold,
  );
  if (!evalResult.active) {
    return {
      active: false,
      threshold,
      total429: aggregate.total429,
      alertEmitted: false,
      alertSuppressedAsRepeat: false,
      slackSent: false,
      emailSent: false,
      reason: evalResult.reason,
    };
  }

  // Dedupe: skip if a sibling alert was emitted within the last
  // `repeatHours`. This avoids paging on every cron tick during a long
  // sustained spike — ops only need one heads-up per attack window.
  let recentEmissions = 0;
  try {
    recentEmissions = await countRecent(repeatHours);
  } catch (err) {
    // If the dedupe query fails we still want to alert (better to over-page
    // than silently swallow an attack), so we treat this as zero recent
    // emissions and proceed.
    logger.warn(
      { err: (err as Error).message, component: "rateLimit429SpikeAlert" },
      "Failed to count recent spike alert emissions — proceeding with alert",
    );
  }

  if (recentEmissions > 0) {
    safeLogger.warn(
      `[RateLimit429SpikeAlert] Spike still active (${aggregate.total429} ` +
        `>= ${threshold}) but ${recentEmissions} alert(s) already written ` +
        `in the last ${repeatHours}h — suppressing repeat page.`,
    );
    return {
      active: true,
      threshold,
      total429: aggregate.total429,
      alertEmitted: false,
      alertSuppressedAsRepeat: true,
      slackSent: false,
      emailSent: false,
      reason: "above_threshold",
    };
  }

  const description =
    `24h rate_limit_429 spike: ${aggregate.total429} events (>= threshold ` +
    `${threshold}). Top IPs: ` +
    aggregate.topIps
      .slice(0, 5)
      .map((t) => `${t.ip}=${t.events}`)
      .join(", ");

  const metadata = {
    total429: aggregate.total429,
    threshold,
    totalSuppressed: aggregate.totalSuppressed,
    repeatHours,
    topIps: aggregate.topIps.slice(0, 5),
  };

  let alertEmitted = false;
  try {
    await emitEvent({ description, metadata });
    alertEmitted = true;
    safeLogger.warn(`[RateLimit429SpikeAlert] ${description}`);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, component: "rateLimit429SpikeAlert" },
      "Failed to write rate_limit_429_spike_alert system_event — Slack/email still attempted",
    );
  }

  // Best-effort fan-out. Each channel is caught independently so a Slack
  // outage cannot silence the email and vice-versa.
  const slackText =
    `:rotating_light: *24h Rate-Limit Spike* — ${aggregate.total429} \`rate_limit_429\` ` +
    `events in the last 24h (threshold: ${threshold}, ` +
    `suppressed: ${aggregate.totalSuppressed}).\n` +
    `*Top IPs:*\n${formatTopIps(aggregate.topIps)}`;
  let slackSent = false;
  try {
    slackSent = await postSlack(slackText);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, component: "rateLimit429SpikeAlert" },
      "postSlack threw",
    );
  }

  const emailSubject = `⚠️ WalaPlus 24h rate-limit spike — ${aggregate.total429} events`;
  const emailHtml = `<h2>24h Rate-Limit Spike</h2>
<p><strong>${aggregate.total429}</strong> <code>rate_limit_429</code> events have been
recorded in the last 24 hours, crossing the configured threshold of
<strong>${threshold}</strong>. Total suppressed (sampler skips):
<strong>${aggregate.totalSuppressed}</strong>.</p>
<h3>Top offending IPs</h3>
${formatTopIpsHtml(aggregate.topIps)}
<p>Open the <a href="/admin">admin dashboard's Rate Limits tab</a>
to inspect live counters and confirm the source.</p>`;
  const emailText =
    `24h rate-limit spike: ${aggregate.total429} events ` +
    `(threshold: ${threshold}, suppressed: ${aggregate.totalSuppressed}).\n\n` +
    `Top IPs:\n${formatTopIps(aggregate.topIps)}\n\n` +
    `Open /admin (Rate Limits tab) to inspect.`;
  let emailSent = false;
  try {
    emailSent = await sendEmail(emailSubject, emailHtml, emailText);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, component: "rateLimit429SpikeAlert" },
      "sendEmail threw",
    );
  }

  return {
    active: true,
    threshold,
    total429: aggregate.total429,
    alertEmitted,
    alertSuppressedAsRepeat: false,
    slackSent,
    emailSent,
    reason: "above_threshold",
  };
}
