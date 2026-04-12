# Batch 1: Create 6 New Utility Files in src/utils/

Please create the following 6 new files exactly as shown below. These are core utility modules that other code depends on.

---

## File 1: src/utils/changeHistoryDatabase.ts

```typescript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export interface ChangeHistoryEntry {
  id?: number;
  record_type: 'nc' | 'capa';
  record_id: number;
  field_changed: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string;
  change_reason?: string;
  created_at?: Date;
}

export async function initChangeHistoryTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nc_change_history (
      id SERIAL PRIMARY KEY,
      record_id INTEGER NOT NULL,
      field_changed VARCHAR(100) NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by VARCHAR(255) NOT NULL,
      change_reason TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_nc_history_record ON nc_change_history(record_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS capa_change_history (
      id SERIAL PRIMARY KEY,
      record_id INTEGER NOT NULL,
      field_changed VARCHAR(100) NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by VARCHAR(255) NOT NULL,
      change_reason TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_capa_history_record ON capa_change_history(record_id)`);
}

export async function logNCChange(recordId: number, fieldChanged: string, oldValue: any, newValue: any, changedBy: string, reason?: string): Promise<void> {
  await pool.query(
    `INSERT INTO nc_change_history (record_id, field_changed, old_value, new_value, changed_by, change_reason) VALUES ($1, $2, $3, $4, $5, $6)`,
    [recordId, fieldChanged, oldValue != null ? String(oldValue) : null, newValue != null ? String(newValue) : null, changedBy, reason || null]
  );
}

export async function logCAPAChange(recordId: number, fieldChanged: string, oldValue: any, newValue: any, changedBy: string, reason?: string): Promise<void> {
  await pool.query(
    `INSERT INTO capa_change_history (record_id, field_changed, old_value, new_value, changed_by, change_reason) VALUES ($1, $2, $3, $4, $5, $6)`,
    [recordId, fieldChanged, oldValue != null ? String(oldValue) : null, newValue != null ? String(newValue) : null, changedBy, reason || null]
  );
}

export async function getNCChangeHistory(recordId: number): Promise<ChangeHistoryEntry[]> {
  const result = await pool.query(
    `SELECT * FROM nc_change_history WHERE record_id = $1 ORDER BY created_at DESC`,
    [recordId]
  );
  return result.rows.map((r: any) => ({ ...r, record_type: 'nc' as const }));
}

export async function getCAPAChangeHistory(recordId: number): Promise<ChangeHistoryEntry[]> {
  const result = await pool.query(
    `SELECT * FROM capa_change_history WHERE record_id = $1 ORDER BY created_at DESC`,
    [recordId]
  );
  return result.rows.map((r: any) => ({ ...r, record_type: 'capa' as const }));
}
```

---

## File 2: src/utils/exportUtils.ts

```typescript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export interface FilterParams {
  dateFrom?: string;
  dateTo?: string;
  department?: string;
  assignedTo?: string;
  status?: string;
  severity?: string;
  limit?: number;
  offset?: number;
}

export function buildFilterClauses(filters: FilterParams, dateColumn: string = 'created_at'): { conditions: string[]; params: any[]; paramIdx: number } {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (filters.dateFrom) {
    conditions.push(`${dateColumn} >= $${paramIdx++}`);
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    conditions.push(`${dateColumn} <= $${paramIdx++}`);
    params.push(filters.dateTo);
  }
  if (filters.department) {
    conditions.push(`department = $${paramIdx++}`);
    params.push(filters.department);
  }
  if (filters.assignedTo) {
    conditions.push(`assigned_to = $${paramIdx++}`);
    params.push(filters.assignedTo);
  }
  if (filters.status) {
    conditions.push(`status = $${paramIdx++}`);
    params.push(filters.status);
  }
  if (filters.severity) {
    conditions.push(`severity = $${paramIdx++}`);
    params.push(filters.severity);
  }

  return { conditions, params, paramIdx };
}

export function toCSV(rows: any[], columns?: string[]): string {
  if (rows.length === 0) return '';
  const cols = columns || Object.keys(rows[0]);
  const header = cols.join(',');
  const body = rows.map(row =>
    cols.map(col => {
      const val = row[col];
      if (val == null) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(',')
  ).join('\n');
  return header + '\n' + body;
}

export { pool as exportPool };
```

---

## File 3: src/utils/notificationHub.ts

```typescript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export type NotificationChannel = 'in_app' | 'email' | 'slack';
export type NotificationPriority = 'critical' | 'high' | 'medium' | 'low';
export type NotificationStatus = 'unread' | 'read' | 'dismissed';

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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_module ON notifications(module)`);
}

export async function createNotification(notif: Omit<Notification, 'id' | 'created_at'>): Promise<Notification> {
  const result = await pool.query(
    `INSERT INTO notifications (title, message, module, priority, channel, status, recipient, related_entity_type, related_entity_id, action_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [notif.title, notif.message, notif.module, notif.priority || 'medium', notif.channel || 'in_app',
     notif.status || 'unread', notif.recipient || null, notif.related_entity_type || null,
     notif.related_entity_id || null, notif.action_url || null]
  );

  const notification = result.rows[0];

  if (notif.channel === 'email' && notif.recipient) {
    await sendEmailNotification(notification);
  } else if (notif.channel === 'slack') {
    await sendSlackNotification(notification);
  }

  return notification;
}

export async function getNotifications(filters: {
  recipient?: string; status?: string; module?: string; limit?: number; offset?: number;
}): Promise<{ notifications: Notification[]; total: number }> {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (filters.recipient) { conditions.push(`recipient = $${paramIdx++}`); params.push(filters.recipient); }
  if (filters.status) { conditions.push(`status = $${paramIdx++}`); params.push(filters.status); }
  if (filters.module) { conditions.push(`module = $${paramIdx++}`); params.push(filters.module); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

  const countResult = await pool.query(`SELECT COUNT(*) as total FROM notifications ${where}`, params);
  const result = await pool.query(
    `SELECT * FROM notifications ${where} ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, limit, offset]
  );

  return { notifications: result.rows, total: parseInt(countResult.rows[0].total) };
}

export async function getUnreadCount(recipient?: string): Promise<number> {
  const query = recipient
    ? `SELECT COUNT(*) as count FROM notifications WHERE status = 'unread' AND (recipient = $1 OR recipient IS NULL)`
    : `SELECT COUNT(*) as count FROM notifications WHERE status = 'unread'`;
  const result = await pool.query(query, recipient ? [recipient] : []);
  return parseInt(result.rows[0].count);
}

export async function markAsRead(id: number): Promise<Notification | null> {
  const result = await pool.query(
    `UPDATE notifications SET status = 'read', read_at = NOW() WHERE id = $1 RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

export async function dismissNotification(id: number): Promise<Notification | null> {
  const result = await pool.query(
    `UPDATE notifications SET status = 'dismissed' WHERE id = $1 RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

async function sendEmailNotification(notif: Notification): Promise<void> {
  try {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey || !notif.recipient) return;

    const { Resend } = await import('resend');
    const resend = new Resend(resendKey);
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'QMS Platform <noreply@qms-dashboard.replit.app>',
      to: notif.recipient,
      subject: `[${notif.priority.toUpperCase()}] ${notif.title}`,
      html: `<h2>${notif.title}</h2><p>${notif.message}</p>${notif.action_url ? `<p><a href="${notif.action_url}">View Details</a></p>` : ''}`,
    });
    await pool.query(`UPDATE notifications SET sent_at = NOW() WHERE id = $1`, [notif.id]);
  } catch (err) {
    console.error('[NotificationHub] Email send failed:', err);
  }
}

async function sendSlackNotification(notif: Notification): Promise<void> {
  try {
    const slackToken = process.env.SLACK_BOT_TOKEN;
    const slackChannel = process.env.SLACK_CHANNEL_ID || process.env.SLACK_DEFAULT_CHANNEL;
    if (!slackToken || !slackChannel) return;

    const { WebClient } = await import('@slack/web-api');
    const slack = new WebClient(slackToken);
    const priorityEmoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' }[notif.priority] || '⚪';
    await slack.chat.postMessage({
      channel: slackChannel,
      text: `${priorityEmoji} *${notif.title}*\n${notif.message}${notif.action_url ? `\n<${notif.action_url}|View Details>` : ''}`,
    });
    await pool.query(`UPDATE notifications SET sent_at = NOW() WHERE id = $1`, [notif.id]);
  } catch (err) {
    console.error('[NotificationHub] Slack send failed:', err);
  }
}

export async function notifyEvent(event: {
  type: string; module: string; title: string; message: string;
  priority?: NotificationPriority; entityType?: string; entityId?: string; actionUrl?: string;
}): Promise<void> {
  const channels: NotificationChannel[] = ['in_app'];
  if (event.priority === 'critical' || event.priority === 'high') {
    if (process.env.SLACK_BOT_TOKEN) channels.push('slack');
    if (process.env.RESEND_API_KEY) channels.push('email');
  }

  for (const channel of channels) {
    try {
      await createNotification({
        title: event.title,
        message: event.message,
        module: event.module,
        priority: event.priority || 'medium',
        channel,
        related_entity_type: event.entityType,
        related_entity_id: event.entityId,
        action_url: event.actionUrl,
      });
    } catch (err) {
      console.error(`[NotificationHub] Failed to create ${channel} notification:`, err);
    }
  }
}
```

---

## File 4: src/utils/evidenceDatabase.ts

```typescript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export interface EvidenceRecord {
  id?: number;
  entity_type: 'nc' | 'capa' | 'compliance' | 'risk_treatment' | 'audit' | 'policy';
  entity_id: number;
  filename: string;
  original_filename: string;
  file_type: string;
  file_size: number;
  uploaded_by: string;
  description?: string;
  upload_date?: Date;
  metadata?: any;
}

export async function initEvidenceTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS evidence_records (
      id SERIAL PRIMARY KEY,
      entity_type VARCHAR(30) NOT NULL,
      entity_id INTEGER NOT NULL,
      filename VARCHAR(500) NOT NULL,
      original_filename VARCHAR(500) NOT NULL,
      file_type VARCHAR(100) NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      uploaded_by VARCHAR(255) NOT NULL,
      description TEXT,
      upload_date TIMESTAMP DEFAULT NOW(),
      metadata JSONB DEFAULT '{}'::jsonb
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_evidence_entity ON evidence_records(entity_type, entity_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_evidence_uploader ON evidence_records(uploaded_by)`);
}

export async function addEvidence(evidence: Omit<EvidenceRecord, 'id' | 'upload_date'>): Promise<EvidenceRecord> {
  const result = await pool.query(
    `INSERT INTO evidence_records (entity_type, entity_id, filename, original_filename, file_type, file_size, uploaded_by, description, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [evidence.entity_type, evidence.entity_id, evidence.filename, evidence.original_filename,
     evidence.file_type, evidence.file_size, evidence.uploaded_by, evidence.description || null,
     evidence.metadata ? JSON.stringify(evidence.metadata) : '{}']
  );
  return result.rows[0];
}

export async function getEvidenceForEntity(entityType: string, entityId: number): Promise<EvidenceRecord[]> {
  const result = await pool.query(
    `SELECT * FROM evidence_records WHERE entity_type = $1 AND entity_id = $2 ORDER BY upload_date DESC`,
    [entityType, entityId]
  );
  return result.rows;
}

export async function deleteEvidence(id: number): Promise<boolean> {
  const result = await pool.query(`DELETE FROM evidence_records WHERE id = $1 RETURNING id`, [id]);
  return result.rows.length > 0;
}

export async function getEvidencePack(scope: {
  entityType?: string; entityIds?: number[]; dateFrom?: string; dateTo?: string;
}): Promise<EvidenceRecord[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (scope.entityType) {
    conditions.push(`entity_type = $${paramIdx++}`);
    params.push(scope.entityType);
  }
  if (scope.entityIds && scope.entityIds.length > 0) {
    const placeholders = scope.entityIds.map(() => `$${paramIdx++}`).join(',');
    conditions.push(`entity_id IN (${placeholders})`);
    params.push(...scope.entityIds);
  }
  if (scope.dateFrom) {
    conditions.push(`upload_date >= $${paramIdx++}`);
    params.push(scope.dateFrom);
  }
  if (scope.dateTo) {
    conditions.push(`upload_date <= $${paramIdx++}`);
    params.push(scope.dateTo);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT * FROM evidence_records ${where} ORDER BY entity_type, entity_id, upload_date DESC`,
    params
  );
  return result.rows;
}

export async function getEvidenceSummary(): Promise<any> {
  const result = await pool.query(`
    SELECT entity_type, COUNT(*) as count, SUM(file_size) as total_size
    FROM evidence_records
    GROUP BY entity_type
    ORDER BY entity_type
  `);
  return result.rows;
}
```

---

## File 5: src/utils/checklistDatabase.ts

(This file is long — see the attached checklistDatabase.ts file content)

---

## File 6: src/utils/knowledgeDatabase.ts

(This file is long — see the attached knowledgeDatabase.ts file content)

---

After creating all 6 files, proceed to Batch 2 (new route files).
