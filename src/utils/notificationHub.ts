import pg from "pg";
import { logger } from "./logger";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Exported for callers that need to ask what has already been announced —
 * scheduled checks that run less often than the deploy cadence use these rows
 * as a restart-proof dedup marker, because an in-process throttle resets on
 * every republish.
 */
export { pool as notificationPool };

export type NotificationChannel = "in_app" | "email" | "slack";
export type NotificationPriority = "critical" | "high" | "medium" | "low";
export type NotificationStatus = "unread" | "read" | "dismissed";

export interface Notification {
  id?: number;
  title: string;
  message: string;
  module?: string;
  priority?: NotificationPriority;
  channel?: NotificationChannel;
  status?: NotificationStatus;
  recipient?: string;
  related_entity_type?: string;
  related_entity_id?: string;
  action_url?: string;
  sent_at?: Date;
  read_at?: Date;
  created_at?: Date;
  // Legacy/alternate fields accepted by createNotification callers; the
  // runtime helper maps these onto the canonical columns above.
  type?: "info" | "alert" | "warning" | "success";
  link?: string;
  severity?: "low" | "medium" | "high" | "critical";
}

export async function initNotificationTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      title VARCHAR(500) NOT NULL,
      message TEXT NOT NULL,
      module VARCHAR(50) NOT NULL,
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      channel VARCHAR(20) NOT NULL DEFAULT 'in_app',
      status VARCHAR(20) NOT NULL DEFAULT 'unread',
      recipient VARCHAR(255),
      related_entity_type VARCHAR(50),
      related_entity_id VARCHAR(100),
      action_url VARCHAR(500),
      sent_at TIMESTAMP,
      read_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_notifications_module ON notifications(module)`,
  );
}

/**
 * Insert a notification row, and deliver it ONLY on the channel the caller asks
 * for.
 *
 * READ THIS BEFORE USING IT. This function does NOT fan out. It sends to Slack
 * or email only when `channel` is explicitly set to "slack"/"email"; the
 * default channel is "in_app", which today means the row is stored and nobody
 * sees it — the in-app feed has no reachable reader, because triggerRoutes
 * shadows the hub's GET /api/notifications.
 *
 * So `createNotification({ ..., priority: "critical" })` with no `channel`
 * delivers NOTHING, however urgent it looks. If you want an event to reach
 * people, call `notifyEvent` instead — that is the one that maps priority to
 * channels. Use this function directly only when you are deliberately
 * addressing ONE channel or ONE recipient.
 */
export async function createNotification(
  notif: Omit<Notification, "id" | "created_at">,
): Promise<Notification> {
  const result = await pool.query(
    `INSERT INTO notifications (title, message, module, priority, channel, status, recipient, related_entity_type, related_entity_id, action_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      notif.title,
      notif.message,
      notif.module,
      // `severity` is the documented alias for `priority` (see the interface),
      // but it used to be dropped on the floor: callers writing
      // `severity: "high"` silently stored 'medium'. Honour it as a fallback so
      // the documented behaviour is the real one. This affects the STORED value
      // and list ordering only — delivery is decided by `channel` above.
      notif.priority || notif.severity || "medium",
      notif.channel || "in_app",
      notif.status || "unread",
      notif.recipient || null,
      notif.related_entity_type || null,
      notif.related_entity_id || null,
      notif.action_url || null,
    ],
  );

  const notification = result.rows[0];

  if (notif.channel === "email" && notif.recipient) {
    await sendEmailNotification(notification);
  } else if (notif.channel === "slack") {
    await sendSlackNotification(notification);
  }

  return notification;
}

export async function getNotifications(filters: {
  recipient?: string;
  status?: string;
  module?: string;
  limit?: number;
  offset?: number;
}): Promise<{ notifications: Notification[]; total: number }> {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (filters.recipient) {
    conditions.push(`(recipient = $${paramIdx++} OR recipient IS NULL)`);
    params.push(filters.recipient);
  }
  if (filters.status) {
    conditions.push(`status = $${paramIdx++}`);
    params.push(filters.status);
  }
  if (filters.module) {
    conditions.push(`module = $${paramIdx++}`);
    params.push(filters.module);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

  const countResult = await pool.query(
    `SELECT COUNT(*) as total FROM notifications ${where}`,
    params,
  );
  const result = await pool.query(
    `SELECT * FROM notifications ${where} ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, limit, offset],
  );

  return {
    notifications: result.rows,
    total: parseInt(countResult.rows[0].total),
  };
}

export async function getUnreadCount(recipient?: string): Promise<number> {
  const query = recipient
    ? `SELECT COUNT(*) as count FROM notifications WHERE status = 'unread' AND (recipient = $1 OR recipient IS NULL)`
    : `SELECT COUNT(*) as count FROM notifications WHERE status = 'unread'`;
  const result = await pool.query(query, recipient ? [recipient] : []);
  return parseInt(result.rows[0].count);
}

export async function getNotificationById(
  id: number,
): Promise<Notification | null> {
  const result = await pool.query(
    `SELECT * FROM notifications WHERE id = $1`,
    [id],
  );
  return result.rows[0] || null;
}

export async function markAsRead(id: number): Promise<Notification | null> {
  const result = await pool.query(
    `UPDATE notifications SET status = 'read', read_at = NOW() WHERE id = $1 RETURNING *`,
    [id],
  );
  return result.rows[0] || null;
}

/**
 * Mark every UNREAD notification visible to `recipient` as read, and return how
 * many rows changed.
 *
 * Recipient scoping deliberately mirrors getUnreadCount / getNotifications:
 * `recipient = $1 OR recipient IS NULL` — a NULL recipient is a broadcast that
 * everyone sees. Without that clause this would clear other people's inboxes,
 * which matters here because the table can hold tens of thousands of rows.
 *
 * Omitting `recipient` clears EVERYTHING and is intended only for an
 * admin-key caller; the route decides which of the two applies.
 *
 * Bounded by `status = 'unread'` so re-running it is cheap and idempotent
 * rather than rewriting read_at on rows that were already read.
 */
export async function markAllAsRead(recipient?: string): Promise<number> {
  const result = recipient
    ? await pool.query(
        `UPDATE notifications
            SET status = 'read', read_at = NOW()
          WHERE status = 'unread' AND (recipient = $1 OR recipient IS NULL)`,
        [recipient],
      )
    : await pool.query(
        `UPDATE notifications
            SET status = 'read', read_at = NOW()
          WHERE status = 'unread'`,
      );
  return result.rowCount ?? 0;
}

export async function dismissNotification(
  id: number,
): Promise<Notification | null> {
  const result = await pool.query(
    `UPDATE notifications SET status = 'dismissed' WHERE id = $1 RETURNING *`,
    [id],
  );
  return result.rows[0] || null;
}

async function sendEmailNotification(notif: Notification): Promise<void> {
  try {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey || !notif.recipient) return;

    const { Resend } = await import("resend");
    const resend = new Resend(resendKey);
    await resend.emails.send({
      from:
        process.env.EMAIL_FROM ||
        "QMS Platform <noreply@qms-dashboard.replit.app>",
      to: notif.recipient,
      subject: `[${(notif.priority ?? "medium").toUpperCase()}] ${notif.title}`,
      html: `<h2>${notif.title}</h2><p>${notif.message}</p>${notif.action_url ? `<p><a href="${notif.action_url}">View Details</a></p>` : ""}`,
    });
    await pool.query(`UPDATE notifications SET sent_at = NOW() WHERE id = $1`, [
      notif.id,
    ]);
  } catch (err) {
    logger.error("[NotificationHub] Email send failed:", err);
  }
}

async function sendSlackNotification(notif: Notification): Promise<void> {
  // Declared outside the try so the catch can name the channel that refused.
  let slackChannel: string | null = null;
  try {
    const slackToken = process.env.SLACK_BOT_TOKEN;
    // Routed by AUDIENCE rather than posted to one channel for everything.
    // Platform health and a fraud reminder used to arrive side by side in the
    // same channel with different owners. Falls back to SLACK_CHANNEL_ID when
    // the audience channel is unset, so partial configuration behaves exactly
    // as before rather than dropping messages.
    const { resolveSlackChannel, noteSuppressedPlatformPost } = await import(
      "./slackChannelRouting"
    );
    const routed = resolveSlackChannel(notif.module);
    slackChannel = routed.channel;

    // Muted platform channel: the in-app notification has already been written
    // by the caller, so the content is not lost — only the announcement is.
    // Recorded and logged rather than dropped on the floor, so a quiet channel
    // can be told apart from a broken sender.
    if (routed.muted) {
      noteSuppressedPlatformPost(notif.title, notif.module);
      logger.info(
        `[NotificationHub] Platform Slack post suppressed (PLATFORM_SLACK_ANNOUNCEMENTS is not "true"): ${notif.title}`,
      );
      return;
    }
    if (!slackToken || !slackChannel) return;

    const { WebClient } = await import("@slack/web-api");
    const slack = new WebClient(slackToken);
    const priorityEmoji =
      { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢" }[
        notif.priority ?? "medium"
      ] || "⚪";
    await slack.chat.postMessage({
      channel: slackChannel,
      text: `${priorityEmoji} *${notif.title}*\n${notif.message}${notif.action_url ? `\n<${notif.action_url}|View Details>` : ""}`,
    });
    await pool.query(`UPDATE notifications SET sent_at = NOW() WHERE id = $1`, [
      notif.id,
    ]);
  } catch (err: any) {
    // Name the fix, not just the failure. The single most common cause of a
    // silent audience channel is a brand-new channel the bot was never invited
    // to: Slack answers `not_in_channel` / `channel_not_found`, the send is
    // swallowed here, and the channel simply stays empty — which reads as
    // "nothing to report" rather than "misconfigured".
    const slackCode = err?.data?.error || err?.code || "";
    if (slackCode === "not_in_channel" || slackCode === "channel_not_found") {
      logger.error(
        `[NotificationHub] Slack refused channel "${slackChannel}" (${slackCode}). ` +
          `The bot is not a member. Invite it in that channel (/invite @<app>) — ` +
          `until then every notification routed there is silently dropped.`,
      );
    } else {
      logger.error("[NotificationHub] Slack send failed:", err);
    }
  }
}

/**
 * Announce an event to whoever should hear about it, fanning out by priority.
 *
 * PRIORITY DECIDES DELIVERY, and the default does not deliver:
 *
 *   critical | high  → in-app + Slack + email (when those are configured)
 *   medium   | low   → in-app ONLY
 *
 * `priority` is OPTIONAL and defaults to "medium" downstream, so omitting it
 * means in-app only — and the in-app feed currently has no reachable reader
 * (triggerRoutes shadows the hub's GET /api/notifications). An omitted
 * priority is therefore equivalent to discarding the event. Ten call sites
 * took that default; assume it was not deliberate.
 *
 * Pick the level by whether someone must ACT, not by how bad the news sounds.
 * Digests, "ready" and "recovered" notices belong at medium: routing routine
 * traffic to Slack is what got the weekly digest switched off.
 */
export async function notifyEvent(event: {
  type: string;
  module: string;
  title: string;
  message: string;
  /** Omitting this means in-app only — see the note above. */
  priority?: NotificationPriority;
  entityType?: string;
  entityId?: string;
  actionUrl?: string;
}): Promise<void> {
  const channels: NotificationChannel[] = ["in_app"];
  if (event.priority === "critical" || event.priority === "high") {
    if (process.env.SLACK_BOT_TOKEN) channels.push("slack");
    if (process.env.RESEND_API_KEY) channels.push("email");
  }

  for (const channel of channels) {
    try {
      await createNotification({
        title: event.title,
        message: event.message,
        module: event.module,
        priority: event.priority || "medium",
        channel,
        related_entity_type: event.entityType,
        related_entity_id: event.entityId,
        action_url: event.actionUrl,
      });
    } catch (err) {
      logger.error(
        `[NotificationHub] Failed to create ${channel} notification:`,
        err,
      );
    }
  }
}
