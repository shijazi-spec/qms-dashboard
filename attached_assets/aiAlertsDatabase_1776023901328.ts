import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

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
  | 'audit_decline';

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
  resolved_at?: Date;
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
    `UPDATE ai_alerts SET status = 'acknowledged', acknowledged_by = $2 WHERE id = $1 RETURNING *`,
    [id, acknowledgedBy]
  );
  return result.rows[0] || null;
}

export async function resolveAlert(id: number): Promise<AIAlert | null> {
  const result = await pool.query(
    `UPDATE ai_alerts SET status = 'resolved', resolved_at = NOW() WHERE id = $1 RETURNING *`,
    [id]
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
