import { sharedPool } from './sharedPool';
import { wrapPoolForRedaction } from './redactedPool';
import { logger } from './logger';

const pool = wrapPoolForRedaction(sharedPool);

export type AlertType =
  | 'nc_detection'
  | 'risk_alert'
  | 'kpi_miss'
  | 'regulation_gap'
  | 'improvement'
  | 'capa_recommendation'
  | 'training_gap'
  | 'doc_review'
  | 'policy_expiry'
  | 'audit_decline'
  | 'sla_breach'
  | 'tool_health'
  | 'prompt_regression'
  | 'storage_health';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed';

export interface AIAlert {
  id?: number;
  alert_type: AlertType;
  severity: AlertSeverity;
  title: string;
  description: string;
  suggestion?: string;
  related_module?: string;
  related_record_id?: string;
  status: AlertStatus;
  acknowledged_by?: string;
  acknowledged_at?: Date;
  resolved_at?: Date;
  resolution_note?: string | null;
  /**
   * Timestamp of the most recent on-call notification attempt for this
   * alert (Task #284). NULL when no attempt has been recorded — older
   * tool-health rows that pre-date the column will read as NULL until
   * they're re-paged.
   */
  notified_at?: Date | null;
  /**
   * Outcome label for the notification attempt. See
   * {@link initAIAlertsTable} for the documented value set. NULL when no
   * attempt has been recorded.
   */
  notified_channel?: string | null;
  created_at?: Date;
}

export async function initAIAlertsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_alerts (
      id SERIAL PRIMARY KEY,
      alert_type VARCHAR(50) NOT NULL,
      severity VARCHAR(20) NOT NULL,
      title VARCHAR(500) NOT NULL,
      description TEXT NOT NULL,
      suggestion TEXT,
      related_module VARCHAR(50),
      related_record_id VARCHAR(100),
      status VARCHAR(20) DEFAULT 'open',
      acknowledged_by VARCHAR(255),
      resolved_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Idempotent migration: add resolution_note for capturing why/how an alert
  // was resolved (e.g. the auto-resolve cron path used by the tool-health
  // recovery sweep). Pre-existing rows leave this NULL.
  await pool.query(`
    ALTER TABLE ai_alerts ADD COLUMN IF NOT EXISTS resolution_note TEXT
  `);

  // Idempotent migration: add acknowledged_at so the history view can show
  // when an alert was triaged (not just who triaged it).
  await pool.query(`
    ALTER TABLE ai_alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP
  `);

  // Idempotent migration (Task #284): persist the on-call notification
  // delivery result on the alert row so the AI Operations panel can show
  // ops whether/where/when each alert was paged.
  //
  // `notified_channel` is a free-form short label rather than an enum so
  // future delivery surfaces (PagerDuty, Opsgenie, …) can be added without
  // an enum migration. Known values today:
  //   • 'slack'           — Slack send succeeded; email not configured
  //   • 'email'           — Email send succeeded; Slack not configured
  //   • 'slack+email'     — Both surfaces succeeded
  //   • 'slack_only'      — Slack ok, email configured but failed
  //   • 'email_only'      — Email ok, Slack configured but failed
  //   • 'not_configured'  — Neither TOOL_HEALTH_SLACK_CHANNEL nor
  //                          TOOL_HEALTH_ALERT_EMAIL was set; ops needs
  //                          to configure a channel
  //   • 'throttled'       — A sibling page already sent within the
  //                          TOOL_HEALTH_NOTIFY_THROTTLE_MIN window
  //   • 'failed'          — Attempted on every configured surface but all
  //                          transports threw or returned failure
  // `notified_at` is set whenever the notifier reaches a terminal state
  // (success, throttled, skipped, or failed) so the dashboard can show
  // an "Attempted at" timestamp regardless of outcome.
  await pool.query(`
    ALTER TABLE ai_alerts ADD COLUMN IF NOT EXISTS notified_at TIMESTAMP
  `);
  await pool.query(`
    ALTER TABLE ai_alerts ADD COLUMN IF NOT EXISTS notified_channel VARCHAR(50)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_alerts_status ON ai_alerts(status)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_alerts_severity ON ai_alerts(severity)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_alerts_type ON ai_alerts(alert_type)
  `);
}

export async function createAIAlert(alert: Omit<AIAlert, 'id' | 'created_at' | 'status'>): Promise<AIAlert> {
  const result = await pool.query(
    `INSERT INTO ai_alerts (alert_type, severity, title, description, suggestion, related_module, related_record_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
     RETURNING *`,
    [alert.alert_type, alert.severity, alert.title, alert.description,
     alert.suggestion || null, alert.related_module || null, alert.related_record_id || null]
  );
  return result.rows[0];
}

export async function getAIAlerts(filters?: {
  status?: AlertStatus;
  severity?: AlertSeverity;
  alert_type?: AlertType;
  /**
   * Auto-vs-manual resolution-source filter for closed alerts. When set,
   * pushes the same `resolution_note ILIKE 'auto-resolved%'` check the
   * dashboard previously applied client-side (after the 50-row cap) into
   * the SQL WHERE so the filter never silently drops matches when closed
   * alert volume crosses the page size in a single status (Task #417).
   *
   * Semantics mirror the All Alerts modal's pre-existing client-side
   * `isAutoResolved` helper:
   *   - 'auto'   → status='resolved' AND resolution_note starts with
   *                'auto-resolved' (the prefix both auto-resolve crons
   *                stamp on the row).
   *   - 'manual' → dismissed rows (always human) OR resolved rows whose
   *                resolution_note is missing or does NOT start with
   *                'auto-resolved'. Acknowledged/open rows are excluded
   *                because the auto/manual distinction is only
   *                meaningful for closed alerts.
   *
   * When the caller also passes `status`, the resolution clause stacks on
   * top — e.g. status='resolved' + resolution='manual' yields only the
   * human-resolved rows.
   */
  resolution?: 'auto' | 'manual';
  limit?: number;
  offset?: number;
}): Promise<{ alerts: AIAlert[]; total: number }> {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (filters?.status) {
    conditions.push(`status = $${paramIdx++}`);
    params.push(filters.status);
  }
  if (filters?.severity) {
    conditions.push(`severity = $${paramIdx++}`);
    params.push(filters.severity);
  }
  if (filters?.alert_type) {
    conditions.push(`alert_type = $${paramIdx++}`);
    params.push(filters.alert_type);
  }
  if (filters?.resolution === 'auto') {
    conditions.push(
      `status = 'resolved' AND resolution_note ILIKE 'auto-resolved%'`,
    );
  } else if (filters?.resolution === 'manual') {
    conditions.push(
      `(status = 'dismissed' OR (status = 'resolved' AND (resolution_note IS NULL OR resolution_note NOT ILIKE 'auto-resolved%')))`,
    );
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters?.limit || 50;
  const offset = filters?.offset || 0;

  const countResult = await pool.query(
    `SELECT COUNT(*) as total FROM ai_alerts ${whereClause}`, params
  );

  const result = await pool.query(
    `SELECT * FROM ai_alerts ${whereClause} ORDER BY
      CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
      created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
    [...params, limit, offset]
  );

  return { alerts: result.rows, total: parseInt(countResult.rows[0].total) };
}

export async function getUnreadAlertCount(): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM ai_alerts WHERE status = 'open'`
  );
  return parseInt(result.rows[0].count);
}

export async function acknowledgeAlert(id: number, acknowledgedBy: string): Promise<AIAlert | null> {
  const result = await pool.query(
    `UPDATE ai_alerts SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = NOW() WHERE id = $1 RETURNING *`,
    [id, acknowledgedBy]
  );
  return result.rows[0] || null;
}

export async function resolveAlert(
  id: number,
  note?: string,
  resolvedBy?: string,
): Promise<AIAlert | null> {
  // Only overwrite resolution_note when a note is supplied so manual
  // resolves through the UI (which currently pass none) don't blank an
  // existing note.
  //
  // `resolvedBy` captures the operator's identity when an alert is resolved
  // directly from the open state (bypassing the acknowledge step). We use
  // COALESCE so that an already-acknowledged row keeps its original
  // acknowledged_by value — the first person who triaged it.
  //
  // Status guard (Task #578): only resolve alerts that are still
  // `open` or `acknowledged`. This makes the call idempotent and closes the
  // race between an operator clicking "Resolve" in the UI and the next
  // cron-driven auto-resolve sweep — once a row is `resolved` (or
  // `dismissed`), the cron's auto-resolve becomes a no-op so the original
  // resolution_note / resolved_at / acknowledged_by stamped by the UI are
  // preserved instead of being overwritten with the cron's "auto-resolved"
  // note.
  const result = await pool.query(
    `UPDATE ai_alerts
        SET status = 'resolved',
            resolved_at = NOW(),
            resolution_note = COALESCE($2, resolution_note),
            acknowledged_by = COALESCE(acknowledged_by, $3)
      WHERE id = $1
        AND status IN ('open', 'acknowledged')
      RETURNING *`,
    [id, note ?? null, resolvedBy ?? null]
  );
  return result.rows[0] || null;
}

export async function dismissAlert(id: number): Promise<AIAlert | null> {
  const result = await pool.query(
    `UPDATE ai_alerts SET status = 'dismissed' WHERE id = $1 RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

export async function alertExists(title: string, alertType: AlertType): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM ai_alerts WHERE title = $1 AND alert_type = $2 AND status IN ('open', 'acknowledged') LIMIT 1`,
    [title, alertType]
  );
  return result.rows.length > 0;
}

/**
 * Returns true when an open or acknowledged alert already exists for the
 * given (alert_type, related_record_id) pair. Use this for deduping
 * recurring alerts whose titles include live metric values that would
 * otherwise defeat the title-based alertExists() check.
 */
export async function openAlertExistsByKey(
  alertType: AlertType,
  relatedRecordId: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
       FROM ai_alerts
      WHERE alert_type = $1
        AND related_record_id = $2
        AND status IN ('open', 'acknowledged')
      LIMIT 1`,
    [alertType, relatedRecordId],
  );
  return result.rows.length > 0;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tool-health notifier dead-letter (Task #288)
//
// `notifyToolHealthBreach` swallows Slack/email errors and returns
// `{ slackSent: false, emailSent: false }`. When BOTH channels fail (or the
// notifier itself throws) the cron previously moved on with no durable record
// of the missed page — on-call had no way to learn that alert #N was opened
// but never delivered.
//
// `recordToolHealthNotifyDeadLetter` writes a sibling `ai_alerts` row that
// surfaces in the existing AI Operations panel (it filters by
// `alert_type='tool_health'`) so missed pages are visible alongside the
// breach alert they relate to. The `[Dead-Letter]` title prefix and the
// `:notify_failure` suffix on `related_record_id` distinguish the dead-letter
// row from the underlying breach alert and from a future second dead-letter
// for the same key (the underlying breach alert dedupes once per
// `<tool_name>:<reason>`, so we naturally get at most one dead-letter per
// breach lifecycle).
// ──────────────────────────────────────────────────────────────────────────────

export interface ToolHealthNotifyDeadLetterInput {
  /** Composite key of the breach the notifier failed to deliver. */
  related_record_id: string;
  /** Tool whose breach went unpaged. */
  tool_name: string;
  /** Which threshold breached (mirrored from the breach alert for context). */
  reason: 'error_rate' | 'p95_latency';
  /** Severity of the original breach — preserved for triage prioritisation. */
  breach_severity: AlertSeverity;
  /** Title of the breach alert (without the dead-letter prefix). */
  breach_title: string;
  /** Id of the underlying breach alert row, when known. */
  breach_alert_id?: number;
  /**
   * Short, human-readable reason the page failed (e.g. "Slack send failed
   * and no email recipients configured", "notifier threw"). Embedded in the
   * dead-letter description so on-call can act without crawling logs.
   */
  failure_reason: string;
}

export async function recordToolHealthNotifyDeadLetter(
  input: ToolHealthNotifyDeadLetterInput,
): Promise<AIAlert> {
  const title = `[Dead-Letter] Tool-health page not delivered: ${input.tool_name}`;
  const idSuffix = input.breach_alert_id != null ? ` (alert #${input.breach_alert_id})` : '';
  const description =
    `On-call paging failed for "${input.tool_name}" — neither Slack nor ` +
    `email delivered the ${input.reason} breach notification` +
    `${idSuffix}. Reason: ${input.failure_reason}. ` +
    `Original breach: ${input.breach_title} ` +
    `(severity: ${input.breach_severity.toUpperCase()}).`;
  const suggestion =
    'Inspect the most recent ToolHealthNotifier error in the server logs, ' +
    'confirm Slack/Resend credentials, and manually notify on-call about the ' +
    'underlying breach. Once the page is delivered out-of-band, resolve this ' +
    'dead-letter row with a note pointing at the original breach alert.';
  return await createAIAlert({
    alert_type: 'tool_health',
    severity: 'critical',
    title,
    description,
    suggestion,
    related_module: 'ai_ops',
    // Distinct suffix so the breach alert and its dead-letter never collide
    // in the (alert_type, related_record_id) dedupe space.
    related_record_id: `${input.related_record_id}:notify_failure`,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// tool_health_notifications — persistent throttle store
//
// Backs the belt-and-braces throttle in toolHealthAlertNotifier.ts so that
// the "do not double-page within TOOL_HEALTH_NOTIFY_THROTTLE_MIN" guarantee
// survives server restarts and is shared across multiple instances.
//
// Schema is intentionally minimal: only the epoch-ms timestamp of the last
// successful page is stored. The composite key is the `related_record_id`
// value used everywhere else (`<tool_name>:<reason>`).
// ──────────────────────────────────────────────────────────────────────────────

export async function initToolHealthNotificationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tool_health_notifications (
      notification_key VARCHAR(200) PRIMARY KEY,
      last_notified_at BIGINT NOT NULL
    )
  `);
}

/**
 * Atomically attempt to claim the "notify slot" for a given notification key.
 *
 * How it works:
 *   • INSERT the key with `nowMs` as the timestamp (first-ever page for this key).
 *   • On conflict (key already exists), UPDATE the timestamp only when the
 *     stored timestamp is *older* than the throttle window — i.e. the previous
 *     page was far enough in the past that a new page is allowed.
 *   • RETURNING the key: a row is returned iff the INSERT or UPDATE actually
 *     modified the row, meaning this caller "won" the slot.
 *
 * Returns `true` if the caller claimed the slot (may send the page), or
 * `false` if another instance already paged this key within the throttle
 * window (caller must NOT send).
 *
 * Because the decision and the write happen in a single statement, concurrent
 * calls from different pods on the same key are serialised by Postgres:
 * exactly one will get the row back; all others will be throttled.
 */
export async function claimToolHealthNotifySlot(
  notificationKey: string,
  nowMs: number,
  throttleMs: number,
): Promise<boolean> {
  const thresholdMs = nowMs - throttleMs;
  const result = await pool.query(
    `INSERT INTO tool_health_notifications (notification_key, last_notified_at)
     VALUES ($1, $2)
     ON CONFLICT (notification_key)
     DO UPDATE SET last_notified_at = EXCLUDED.last_notified_at
     WHERE tool_health_notifications.last_notified_at < $3
     RETURNING notification_key`,
    [notificationKey, nowMs, thresholdMs],
  );
  return result.rows.length > 0;
}

/**
 * Persist the on-call notification delivery result on an `ai_alerts` row
 * (Task #284). Called by {@link notifyToolHealthBreach} once the attempt
 * has reached a terminal state (success / throttled / skipped / failed)
 * so the AI Operations panel can render a "Notified" column showing when
 * and via which channel each open alert was paged.
 *
 * `alertId` may be `null`/`undefined` when the underlying `createAIAlert`
 * call returned no row (extremely rare — only if the DB is offline). In
 * that case this function is a no-op so the notifier does not have to
 * special-case it.
 *
 * Errors are logged and swallowed so a transient DB write failure cannot
 * abort the cron pass — the page itself has already been delivered to
 * the operator's pager, and the missing row will simply read as NULL on
 * the dashboard until the next paging attempt for this key updates it.
 */
export async function recordAlertNotificationResult(
  alertId: number | null | undefined,
  channel: string,
  whenMs: number = Date.now(),
): Promise<void> {
  if (alertId == null) return;
  try {
    await pool.query(
      `UPDATE ai_alerts
          SET notified_at = TO_TIMESTAMP($2 / 1000.0),
              notified_channel = $3
        WHERE id = $1`,
      [alertId, whenMs, channel],
    );
  } catch (err) {
    logger.error(
      `[aiAlertsDatabase] recordAlertNotificationResult failed for alert ${alertId}:`,
      err,
    );
  }
}

/**
 * Return the most-recently triaged (acknowledged or resolved) tool-health
 * alerts within the last `days` days, ordered by triage time descending so
 * the most-recent action appears first.
 *
 * "Triage time" is COALESCE(resolved_at, acknowledged_at, created_at) so
 * that both status paths surface in the correct chronological position even
 * for older rows that pre-date the acknowledged_at column migration.
 *
 * `severity`, when provided, narrows the result set to a single severity
 * tier (critical / high / medium / low / info). The route layer is
 * responsible for whitelisting the value before it lands here, so the
 * column comparison is safe to perform as a parameterised equality check.
 */
export async function getToolHealthAlertHistory(
  days = 7,
  limit = 20,
  severity?: string,
  resolution?: 'auto' | 'manual',
  options?: { includeDismissed?: boolean },
): Promise<AIAlert[]> {
  // Build the WHERE/params dynamically so the optional `resolution` filter
  // (Task #417) can stack on top of the severity filter and the Task #324
  // `includeDismissed` opt-in without an explosion of query permutations.
  //
  // - Task #324: when `includeDismissed` is set, the status whitelist also
  //   admits 'dismissed' rows so the AI Ops "Recently triaged" panel can
  //   show every closed alert (and its resolution_note) in one place.
  //   Default stays acknowledged + resolved to preserve the historical
  //   wire shape for any consumer that hasn't opted in.
  // - Task #417: the resolution clause mirrors getAIAlerts(): 'auto'
  //   requires a resolved row whose resolution_note starts with
  //   'auto-resolved'; 'manual' requires an acknowledged or resolved row
  //   whose note does NOT start with that prefix (acknowledged rows are
  //   always treated as manual triage since the cron auto-resolve path
  //   skips the acknowledge step).
  const includeDismissed = options?.includeDismissed === true;
  const statusList = includeDismissed
    ? ['acknowledged', 'resolved', 'dismissed']
    : ['acknowledged', 'resolved'];
  const conditions: string[] = [
    `alert_type = 'tool_health'`,
    `COALESCE(resolved_at, acknowledged_at, created_at) >= NOW() - ($1 || ' days')::INTERVAL`,
  ];
  const params: any[] = [days, limit];
  let paramIdx = 3;
  conditions.push(`status = ANY($${paramIdx++}::text[])`);
  params.push(statusList);
  if (severity) {
    conditions.push(`severity = $${paramIdx++}`);
    params.push(severity);
  }
  if (resolution === 'auto') {
    conditions.push(
      `status = 'resolved' AND resolution_note ILIKE 'auto-resolved%'`,
    );
  } else if (resolution === 'manual') {
    conditions.push(
      `(status = 'acknowledged' OR status = 'dismissed' OR (status = 'resolved' AND (resolution_note IS NULL OR resolution_note NOT ILIKE 'auto-resolved%')))`,
    );
  }
  const result = await pool.query(
    `SELECT *
       FROM ai_alerts
      WHERE ${conditions.join(' AND ')}
      ORDER BY COALESCE(resolved_at, acknowledged_at, created_at) DESC
      LIMIT $2`,
    params,
  );
  return result.rows;
}

/**
 * One day's worth of tool-health alert activity. Returned by
 * {@link getToolHealthAlertTrend} so the AI Ops dashboard can plot a
 * stacked-bar trend of alerts-per-day per severity together with a
 * per-day median time-to-resolve overlay.
 *
 * Counts are bucketed by `created_at` (when the alert fired); the
 * `median_ttr_seconds` is bucketed by `resolved_at` so it lines up with
 * the operational outcome on that day rather than the original fire date.
 */
export interface ToolHealthAlertTrendBucket {
  day: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  total: number;
  median_ttr_seconds: number | null;
}

export interface ToolHealthAlertTrend {
  days: number;
  buckets: ToolHealthAlertTrendBucket[];
  overall: {
    total_fired: number;
    total_resolved: number;
    median_ttr_seconds: number | null;
    avg_ttr_seconds: number | null;
  };
}

/**
 * Daily-bucketed aggregation of `tool_health` alert activity over the last
 * `days` days. Used by GET /api/ai-ops/tool-health-alerts/trend so ops can
 * spot whether a tool is getting noisier over time and whether resolution
 * times are improving.
 *
 * Returns a fully-padded series — every day in the window appears as a row
 * even when no alerts fired or were resolved that day — so the frontend
 * doesn't have to fill gaps before charting.
 *
 * `days` is clamped to [1, 90] so callers can't accidentally trigger a
 * full-table scan on an unbounded window.
 */
export async function getToolHealthAlertTrend(
  days = 14,
): Promise<ToolHealthAlertTrend> {
  const safeDays = Math.max(1, Math.min(90, Math.floor(days)));

  // Build one row per day in the window via generate_series, then LEFT
  // JOIN tool-health alerts created on that day so empty days surface as
  // explicit zeros rather than missing rows.
  const fireRes = await pool.query(
    `WITH day_series AS (
       SELECT generate_series(
         (CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day')::date,
         CURRENT_DATE,
         INTERVAL '1 day'
       )::date AS day
     )
     SELECT
       d.day::text                                              AS day,
       COALESCE(SUM(CASE WHEN a.severity='critical' THEN 1 ELSE 0 END), 0)::int AS critical,
       COALESCE(SUM(CASE WHEN a.severity='high'     THEN 1 ELSE 0 END), 0)::int AS high,
       COALESCE(SUM(CASE WHEN a.severity='medium'   THEN 1 ELSE 0 END), 0)::int AS medium,
       COALESCE(SUM(CASE WHEN a.severity='low'      THEN 1 ELSE 0 END), 0)::int AS low,
       COALESCE(SUM(CASE WHEN a.severity='info'     THEN 1 ELSE 0 END), 0)::int AS info,
       COUNT(a.id)::int                                         AS total
     FROM day_series d
     LEFT JOIN ai_alerts a
       ON a.alert_type = 'tool_health'
      AND date_trunc('day', a.created_at)::date = d.day
     GROUP BY d.day
     ORDER BY d.day ASC`,
    [safeDays],
  );

  // Per-day median TTR, bucketed by resolved_at so the value aligns with
  // the day the alert was actually closed (not the day it originally fired).
  const ttrRes = await pool.query(
    `SELECT
       date_trunc('day', resolved_at)::date::text AS day,
       PERCENTILE_CONT(0.5) WITHIN GROUP (
         ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at))
       ) AS median_ttr_seconds
     FROM ai_alerts
     WHERE alert_type = 'tool_health'
       AND resolved_at IS NOT NULL
       AND resolved_at >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
     GROUP BY 1`,
    [safeDays],
  );
  const ttrByDay = new Map<string, number>();
  for (const row of ttrRes.rows) {
    if (row.median_ttr_seconds != null) {
      ttrByDay.set(row.day, Number(row.median_ttr_seconds));
    }
  }

  // Aggregate roll-up: total fired in window, total resolved in window,
  // and median/average TTR across every resolved alert in the window.
  const overallRes = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int
          FROM ai_alerts
          WHERE alert_type = 'tool_health'
            AND created_at >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
       ) AS total_fired,
       (SELECT COUNT(*)::int
          FROM ai_alerts
          WHERE alert_type = 'tool_health'
            AND resolved_at IS NOT NULL
            AND resolved_at >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
       ) AS total_resolved,
       (SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at)))
          FROM ai_alerts
          WHERE alert_type = 'tool_health'
            AND resolved_at IS NOT NULL
            AND resolved_at >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
       ) AS median_ttr_seconds,
       (SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)))
          FROM ai_alerts
          WHERE alert_type = 'tool_health'
            AND resolved_at IS NOT NULL
            AND resolved_at >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
       ) AS avg_ttr_seconds`,
    [safeDays],
  );
  const overallRow = overallRes.rows[0] || {};

  const buckets: ToolHealthAlertTrendBucket[] = fireRes.rows.map((r: any) => ({
    day: r.day,
    critical: r.critical,
    high: r.high,
    medium: r.medium,
    low: r.low,
    info: r.info,
    total: r.total,
    median_ttr_seconds: ttrByDay.has(r.day)
      ? Math.round(ttrByDay.get(r.day) as number)
      : null,
  }));

  return {
    days: safeDays,
    buckets,
    overall: {
      total_fired: Number(overallRow.total_fired ?? 0),
      total_resolved: Number(overallRow.total_resolved ?? 0),
      median_ttr_seconds:
        overallRow.median_ttr_seconds == null
          ? null
          : Math.round(Number(overallRow.median_ttr_seconds)),
      avg_ttr_seconds:
        overallRow.avg_ttr_seconds == null
          ? null
          : Math.round(Number(overallRow.avg_ttr_seconds)),
    },
  };
}

/**
 * Count ai_alerts rows that the tool-health silent-tool sweep auto-resolved
 * within the last 24 hours and the last 7 days. Powers the
 * "Silent-tool auto-resolutions" tile on /ai-ops (Task #346).
 *
 * Match criterion mirrors the canonical resolution_note prefix the sweep
 * stamps (`auto-resolved: tool went silent`); see
 * src/mastra/workflows/toolHealthAlertsCron.ts → runSilentToolSweep.
 *
 * Both windows are computed in a single round-trip via FILTER clauses so the
 * tile costs one query regardless of dashboard refresh frequency.
 */
export interface SilentToolAutoResolutionCounts {
  last24h: number;
  last7d: number;
}

export async function getSilentToolAutoResolutionCounts(): Promise<SilentToolAutoResolutionCounts> {
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE resolved_at >= NOW() - INTERVAL '24 hours'
       )::int AS last_24h,
       COUNT(*) FILTER (
         WHERE resolved_at >= NOW() - INTERVAL '7 days'
       )::int AS last_7d
     FROM ai_alerts
     WHERE alert_type = 'tool_health'
       AND status = 'resolved'
       AND resolved_at IS NOT NULL
       AND resolution_note ILIKE 'auto-resolved: tool went silent%'`,
  );
  const row = result.rows[0] || {};
  return {
    last24h: Number(row.last_24h ?? 0),
    last7d: Number(row.last_7d ?? 0),
  };
}

/**
 * Fetch every open / acknowledged alert for a given `alert_type`. Used by
 * the tool-health "silent tool" sweep so the cron can find alerts whose
 * associated tool has stopped being called and resolve them.
 *
 * `olderThanMinutes` adds a flap-prevention cutoff: only return alerts that
 * were created at least that many minutes ago.
 */
export async function getOpenAlertsByType(
  alertType: AlertType,
  options?: { olderThanMinutes?: number },
): Promise<AIAlert[]> {
  const olderThanMinutes = options?.olderThanMinutes;
  if (olderThanMinutes != null) {
    const result = await pool.query(
      `SELECT *
         FROM ai_alerts
        WHERE alert_type = $1
          AND status IN ('open', 'acknowledged')
          AND created_at <= NOW() - MAKE_INTERVAL(mins => $2)
        ORDER BY created_at ASC`,
      [alertType, olderThanMinutes],
    );
    return result.rows;
  }
  const result = await pool.query(
    `SELECT *
       FROM ai_alerts
      WHERE alert_type = $1
        AND status IN ('open', 'acknowledged')
      ORDER BY created_at ASC`,
    [alertType],
  );
  return result.rows;
}

/**
 * Fetch every open / acknowledged alert for the given
 * (alert_type, related_record_id) pair. Used by the tool-health auto-resolve
 * sweep so it can decide which alerts to close (and apply a per-alert
 * cooldown via `created_at`).
 *
 * `olderThanMinutes` adds a flap-prevention cutoff: only return alerts that
 * were created at least that many minutes ago. The tool-health cron passes
 * the rolling window length here so a tool is only auto-resolved once the
 * entire window of fresh metrics is post-recovery.
 */
/**
 * Fetch every still-unresolved alert (status `open` or `acknowledged`) of the
 * given `alertType`s that was *created* inside the half-open time range
 * `[fromMs, toMs)`.
 *
 * Used by the storage-health morning digest cron (Task #604): once the
 * configured quiet-hours window closes, the digest needs to enumerate every
 * alert that fired during that window so it can summarise them in a single
 * Slack/email push instead of relying on the operator to open `/ai-ops` first
 * thing in the morning. Alerts that were already auto-resolved by the next
 * cron pass before the digest runs are intentionally excluded — they are no
 * longer actionable.
 *
 * `alertTypes` is an array so the digest can grow to cover prompt-regression /
 * tool-health alerts later without a second helper. The implementation uses
 * `ANY($1::text[])` so a single round-trip handles 1..N types.
 */
export async function getUnresolvedAlertsCreatedBetween(
  alertTypes: AlertType[],
  fromMs: number,
  toMs: number,
): Promise<AIAlert[]> {
  if (alertTypes.length === 0) return [];
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return [];
  }
  const result = await pool.query(
    `SELECT *
       FROM ai_alerts
      WHERE alert_type = ANY($1::text[])
        AND status IN ('open', 'acknowledged')
        AND created_at >= TO_TIMESTAMP($2 / 1000.0)
        AND created_at <  TO_TIMESTAMP($3 / 1000.0)
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
        created_at ASC`,
    [alertTypes, fromMs, toMs],
  );
  return result.rows;
}

export async function getOpenAlertsByKey(
  alertType: AlertType,
  relatedRecordId: string,
  options?: { olderThanMinutes?: number },
): Promise<AIAlert[]> {
  const olderThanMinutes = options?.olderThanMinutes;
  if (olderThanMinutes != null) {
    const result = await pool.query(
      `SELECT *
         FROM ai_alerts
        WHERE alert_type = $1
          AND related_record_id = $2
          AND status IN ('open', 'acknowledged')
          AND created_at <= NOW() - MAKE_INTERVAL(mins => $3)
        ORDER BY created_at ASC`,
      [alertType, relatedRecordId, olderThanMinutes],
    );
    return result.rows;
  }
  const result = await pool.query(
    `SELECT *
       FROM ai_alerts
      WHERE alert_type = $1
        AND related_record_id = $2
        AND status IN ('open', 'acknowledged')
      ORDER BY created_at ASC`,
    [alertType, relatedRecordId],
  );
  return result.rows;
}
