import pg from "pg";
import { logger } from "./logger";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export type NotificationChannel = "in_app" | "email" | "slack";
export type NotificationPriority = "critical" | "high" | "medium" | "low";
export type NotificationStatus = "unread" | "read" | "dismissed";

export interface Notification {
  id?: number;
  title: string;
  message: string;
  module: string;
  priority: NotificationPriority;
  channel: NotificationChannel;
  status?: NotificationStatus;
  recipient?: string;
  related_entity_type?: string;
  related_entity_id?: string;
  action_url?: string;
  sent_at?: Date;
  read_at?: Date;
  created_at?: Date;
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
      notif.priority || "medium",
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
      subject: `[${notif.priority.toUpperCase()}] ${notif.title}`,
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
  try {
    const slackToken = process.env.SLACK_BOT_TOKEN;
    const slackChannel =
      process.env.SLACK_CHANNEL_ID || process.env.SLACK_DEFAULT_CHANNEL;
    if (!slackToken || !slackChannel) return;

    const { WebClient } = await import("@slack/web-api");
    const slack = new WebClient(slackToken);
    const priorityEmoji =
      { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢" }[notif.priority] ||
      "⚪";
    await slack.chat.postMessage({
      channel: slackChannel,
      text: `${priorityEmoji} *${notif.title}*\n${notif.message}${notif.action_url ? `\n<${notif.action_url}|View Details>` : ""}`,
    });
    await pool.query(`UPDATE notifications SET sent_at = NOW() WHERE id = $1`, [
      notif.id,
    ]);
  } catch (err) {
    logger.error("[NotificationHub] Slack send failed:", err);
  }
}

export async function notifyEvent(event: {
  type: string;
  module: string;
  title: string;
  message: string;
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
