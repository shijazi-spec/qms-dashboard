import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export type TriggerType = 
  | 'AUDIT_COMPLETED' 
  | 'NONCONFORMANCE_DETECTED' 
  | 'CAPA_REQUIRED' 
  | 'DECISION_PENDING'
  | 'AUDIT_LOCKED';

export type TriggerStatus = 'pending' | 'acknowledged' | 'actioned' | 'dismissed';

export interface AuditTrigger {
  id?: number;
  trigger_id: string;
  trigger_type: TriggerType;
  audit_id: number;
  audit_date?: Date;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description: string;
  action_required?: string;
  assigned_to?: string;
  assigned_role?: string;
  status: TriggerStatus;
  decision?: 'approved' | 'rejected' | 'modified' | null;
  decision_by?: string;
  decision_at?: Date;
  decision_notes?: string;
  related_nc_ids?: number[];
  related_capa_ids?: number[];
  metadata?: any;
  created_at?: Date;
  updated_at?: Date;
}

export interface AuditNotification {
  id?: number;
  trigger_id: number;
  recipient_email: string;
  recipient_role: string;
  notification_type: 'email' | 'dashboard' | 'both';
  subject: string;
  message: string;
  is_read: boolean;
  read_at?: Date;
  sent_at?: Date;
  created_at?: Date;
}

export async function initAuditTriggerTables(): Promise<void> {
  console.log('🔔 [AuditTriggers] Initializing audit trigger tables...');
  
  try {
    await pool.query(`
      ALTER TABLE quality_audit_results 
      ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP
    `);
  } catch (e) {
    console.log('ℹ️ [AuditTriggers] is_locked column may already exist or table not found');
  }
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_triggers (
      id SERIAL PRIMARY KEY,
      trigger_id VARCHAR(50) UNIQUE NOT NULL,
      trigger_type VARCHAR(50) NOT NULL,
      audit_id INTEGER NOT NULL,
      audit_date TIMESTAMP DEFAULT NOW(),
      severity VARCHAR(20) DEFAULT 'info',
      title VARCHAR(500) NOT NULL,
      description TEXT,
      action_required TEXT,
      assigned_to VARCHAR(255),
      assigned_role VARCHAR(100),
      status VARCHAR(30) DEFAULT 'pending',
      decision VARCHAR(30),
      decision_by VARCHAR(255),
      decision_at TIMESTAMP,
      decision_notes TEXT,
      related_nc_ids INTEGER[],
      related_capa_ids INTEGER[],
      metadata JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_notifications (
      id SERIAL PRIMARY KEY,
      trigger_id INTEGER REFERENCES audit_triggers(id) ON DELETE CASCADE,
      recipient_email VARCHAR(255),
      recipient_role VARCHAR(100),
      notification_type VARCHAR(30) DEFAULT 'dashboard',
      subject VARCHAR(500),
      message TEXT,
      is_read BOOLEAN DEFAULT FALSE,
      read_at TIMESTAMP,
      sent_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_triggers_status ON audit_triggers(status);
    CREATE INDEX IF NOT EXISTS idx_audit_triggers_type ON audit_triggers(trigger_type);
    CREATE INDEX IF NOT EXISTS idx_audit_notifications_read ON audit_notifications(is_read);
  `);

  console.log('✅ [AuditTriggers] Tables initialized');
}

function generateTriggerId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = 'TRG-';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export async function createAuditTrigger(trigger: Omit<AuditTrigger, 'id' | 'trigger_id' | 'created_at' | 'updated_at'>): Promise<AuditTrigger> {
  const triggerId = generateTriggerId();
  
  const result = await pool.query(
    `INSERT INTO audit_triggers 
     (trigger_id, trigger_type, audit_id, audit_date, severity, title, description, action_required, 
      assigned_to, assigned_role, status, related_nc_ids, related_capa_ids, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      triggerId, trigger.trigger_type, trigger.audit_id, trigger.audit_date || new Date(),
      trigger.severity, trigger.title, trigger.description, trigger.action_required,
      trigger.assigned_to, trigger.assigned_role, trigger.status || 'pending',
      trigger.related_nc_ids, trigger.related_capa_ids, JSON.stringify(trigger.metadata || {})
    ]
  );
  
  console.log(`🔔 [AuditTriggers] Created trigger ${triggerId}: ${trigger.trigger_type}`);
  return result.rows[0];
}

export async function createNotification(notification: Omit<AuditNotification, 'id' | 'created_at'>): Promise<AuditNotification> {
  const result = await pool.query(
    `INSERT INTO audit_notifications 
     (trigger_id, recipient_email, recipient_role, notification_type, subject, message, is_read, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      notification.trigger_id, notification.recipient_email, notification.recipient_role,
      notification.notification_type, notification.subject, notification.message,
      notification.is_read || false, notification.sent_at
    ]
  );
  
  console.log(`📧 [AuditTriggers] Created notification for ${notification.recipient_email || notification.recipient_role}`);
  return result.rows[0];
}

export async function fireAuditCompletedTrigger(
  auditId: number,
  auditResult: {
    totalRecords: number;
    totalIssues: number;
    overallScore: number;
    peopleScore: number;
    processScore: number;
    governanceScore: number;
    auditDate: Date;
  }
): Promise<AuditTrigger> {
  const trigger = await createAuditTrigger({
    trigger_type: 'AUDIT_COMPLETED',
    audit_id: auditId,
    audit_date: auditResult.auditDate,
    severity: auditResult.totalIssues > 0 ? 'warning' : 'info',
    title: `Audit Completed - ${auditResult.totalRecords} records evaluated`,
    description: `Audit completed with overall score of ${auditResult.overallScore.toFixed(1)}%. 
      People: ${auditResult.peopleScore.toFixed(1)}%, 
      Process: ${auditResult.processScore.toFixed(1)}%, 
      Governance: ${auditResult.governanceScore.toFixed(1)}%. 
      ${auditResult.totalIssues} issues found.`,
    action_required: auditResult.totalIssues > 0 
      ? 'Review audit findings and take corrective action' 
      : 'Review and acknowledge audit results',
    assigned_role: 'quality_manager',
    status: 'pending',
    metadata: auditResult
  });

  await createNotification({
    trigger_id: trigger.id!,
    recipient_role: 'quality_manager',
    notification_type: 'dashboard',
    subject: `Audit Completed - ${auditResult.overallScore.toFixed(1)}% Score`,
    message: trigger.description!,
    is_read: false
  });

  return trigger;
}

export async function fireNonconformanceDetectedTrigger(
  auditId: number,
  ncDetails: {
    totalNCs: number;
    criticalCount: number;
    majorCount: number;
    minorCount: number;
    ncIds: number[];
    auditDate: Date;
  }
): Promise<AuditTrigger> {
  const severity = ncDetails.criticalCount > 0 ? 'critical' : (ncDetails.majorCount > 0 ? 'warning' : 'info');
  
  const trigger = await createAuditTrigger({
    trigger_type: 'NONCONFORMANCE_DETECTED',
    audit_id: auditId,
    audit_date: ncDetails.auditDate,
    severity,
    title: `${ncDetails.totalNCs} Nonconformance(s) Detected`,
    description: `Audit identified ${ncDetails.totalNCs} nonconformance(s): 
      Critical: ${ncDetails.criticalCount}, Major: ${ncDetails.majorCount}, Minor: ${ncDetails.minorCount}. 
      Immediate action required for critical and major findings.`,
    action_required: 'Assign owners and initiate corrective actions for all nonconformances',
    assigned_role: 'quality_manager',
    status: 'pending',
    related_nc_ids: ncDetails.ncIds,
    metadata: ncDetails
  });

  await createNotification({
    trigger_id: trigger.id!,
    recipient_role: 'quality_manager',
    notification_type: 'both',
    subject: `ALERT: ${ncDetails.criticalCount > 0 ? 'CRITICAL ' : ''}Nonconformances Detected`,
    message: trigger.description!,
    is_read: false
  });

  if (ncDetails.criticalCount > 0) {
    await createNotification({
      trigger_id: trigger.id!,
      recipient_role: 'executive',
      notification_type: 'dashboard',
      subject: `CRITICAL: ${ncDetails.criticalCount} Critical Nonconformance(s) Require Executive Attention`,
      message: `Audit has identified ${ncDetails.criticalCount} critical nonconformance(s). Executive review recommended.`,
      is_read: false
    });
  }

  return trigger;
}

export async function fireCAPARequiredTrigger(
  auditId: number,
  capaDetails: {
    ncId: number;
    ncTitle: string;
    severity: string;
    suggestedAction: string;
    auditDate: Date;
  }
): Promise<AuditTrigger> {
  const trigger = await createAuditTrigger({
    trigger_type: 'CAPA_REQUIRED',
    audit_id: auditId,
    audit_date: capaDetails.auditDate,
    severity: capaDetails.severity === 'critical' ? 'critical' : 'warning',
    title: `CAPA Required for: ${capaDetails.ncTitle}`,
    description: `A Corrective and Preventive Action (CAPA) is required for nonconformance. 
      Severity: ${capaDetails.severity}. 
      Suggested Action: ${capaDetails.suggestedAction}`,
    action_required: 'Create CAPA record, assign owner, and define corrective actions. Approval required.',
    assigned_role: 'quality_manager',
    status: 'pending',
    related_nc_ids: [capaDetails.ncId],
    metadata: capaDetails
  });

  await createNotification({
    trigger_id: trigger.id!,
    recipient_role: 'quality_manager',
    notification_type: 'dashboard',
    subject: `CAPA Required - ${capaDetails.severity.toUpperCase()} Severity`,
    message: trigger.description!,
    is_read: false
  });

  return trigger;
}

export async function fireDecisionPendingTrigger(
  auditId: number,
  decisionDetails: {
    decisionType: 'capa_approval' | 'nc_closure' | 'audit_sign_off' | 'escalation';
    itemId: number;
    itemTitle: string;
    requestedBy: string;
    auditDate: Date;
  }
): Promise<AuditTrigger> {
  const trigger = await createAuditTrigger({
    trigger_type: 'DECISION_PENDING',
    audit_id: auditId,
    audit_date: decisionDetails.auditDate,
    severity: 'warning',
    title: `Decision Required: ${decisionDetails.decisionType.replace(/_/g, ' ').toUpperCase()}`,
    description: `Management decision required for: ${decisionDetails.itemTitle}. 
      Requested by: ${decisionDetails.requestedBy}. 
      Please review and approve, reject, or request modifications.`,
    action_required: 'Approve, Reject, or Request Modifications',
    assigned_role: 'executive',
    status: 'pending',
    metadata: decisionDetails
  });

  await createNotification({
    trigger_id: trigger.id!,
    recipient_role: 'executive',
    notification_type: 'dashboard',
    subject: `DECISION REQUIRED: ${decisionDetails.itemTitle}`,
    message: trigger.description!,
    is_read: false
  });

  return trigger;
}

export async function updateTriggerStatus(
  triggerId: number, 
  status: TriggerStatus,
  decision?: { decision: 'approved' | 'rejected' | 'modified'; decidedBy: string; notes?: string }
): Promise<AuditTrigger | null> {
  let query = 'UPDATE audit_triggers SET status = $1, updated_at = NOW()';
  const params: any[] = [status];
  let paramIndex = 2;

  if (decision) {
    query += `, decision = $${paramIndex++}, decision_by = $${paramIndex++}, decision_at = NOW()`;
    params.push(decision.decision, decision.decidedBy);
    if (decision.notes) {
      query += `, decision_notes = $${paramIndex++}`;
      params.push(decision.notes);
    }
  }

  query += ` WHERE id = $${paramIndex} RETURNING *`;
  params.push(triggerId);

  const result = await pool.query(query, params);
  return result.rows[0] || null;
}

export async function getPendingTriggers(filters?: { type?: TriggerType; role?: string }): Promise<AuditTrigger[]> {
  let query = 'SELECT * FROM audit_triggers WHERE status = $1';
  const params: any[] = ['pending'];
  let paramIndex = 2;

  if (filters?.type) {
    query += ` AND trigger_type = $${paramIndex++}`;
    params.push(filters.type);
  }
  if (filters?.role) {
    query += ` AND assigned_role = $${paramIndex++}`;
    params.push(filters.role);
  }

  query += ' ORDER BY created_at DESC';

  const result = await pool.query(query, params);
  return result.rows;
}

export async function getTriggersByAudit(auditId: number): Promise<AuditTrigger[]> {
  const result = await pool.query(
    'SELECT * FROM audit_triggers WHERE audit_id = $1 ORDER BY created_at DESC',
    [auditId]
  );
  return result.rows;
}

export async function getUnreadNotifications(role?: string): Promise<AuditNotification[]> {
  let query = `
    SELECT an.*, at.trigger_type, at.severity, at.status as trigger_status
    FROM audit_notifications an
    JOIN audit_triggers at ON an.trigger_id = at.id
    WHERE an.is_read = false
  `;
  const params: any[] = [];

  if (role) {
    query += ' AND an.recipient_role = $1';
    params.push(role);
  }

  query += ' ORDER BY an.created_at DESC';

  const result = await pool.query(query, params);
  return result.rows;
}

export async function markNotificationRead(notificationId: number): Promise<void> {
  await pool.query(
    'UPDATE audit_notifications SET is_read = true, read_at = NOW() WHERE id = $1',
    [notificationId]
  );
}

export async function getTriggersStats(): Promise<{
  pendingCount: number;
  acknowledgedCount: number;
  actionedCount: number;
  byType: { type: string; count: number }[];
  bySeverity: { severity: string; count: number }[];
  pendingDecisions: number;
}> {
  const [statusCounts, typeCounts, severityCounts, pendingDecisions] = await Promise.all([
    pool.query(`
      SELECT status, COUNT(*) as count 
      FROM audit_triggers 
      GROUP BY status
    `),
    pool.query(`
      SELECT trigger_type as type, COUNT(*) as count 
      FROM audit_triggers 
      WHERE status = 'pending'
      GROUP BY trigger_type
    `),
    pool.query(`
      SELECT severity, COUNT(*) as count 
      FROM audit_triggers 
      WHERE status = 'pending'
      GROUP BY severity
    `),
    pool.query(`
      SELECT COUNT(*) as count 
      FROM audit_triggers 
      WHERE trigger_type = 'DECISION_PENDING' AND status = 'pending'
    `)
  ]);

  const statusMap: any = {};
  statusCounts.rows.forEach((r: any) => {
    statusMap[r.status] = parseInt(r.count);
  });

  return {
    pendingCount: statusMap.pending || 0,
    acknowledgedCount: statusMap.acknowledged || 0,
    actionedCount: statusMap.actioned || 0,
    byType: typeCounts.rows.map((r: any) => ({ type: r.type, count: parseInt(r.count) })),
    bySeverity: severityCounts.rows.map((r: any) => ({ severity: r.severity, count: parseInt(r.count) })),
    pendingDecisions: parseInt(pendingDecisions.rows[0]?.count || 0)
  };
}

export async function lockAudit(auditId: number): Promise<void> {
  await pool.query(
    'UPDATE quality_audit_results SET is_locked = true, locked_at = NOW() WHERE id = $1',
    [auditId]
  );
  console.log(`🔒 [AuditTriggers] Audit ${auditId} locked from editing`);
}

export async function isAuditLocked(auditId: number): Promise<boolean> {
  const result = await pool.query(
    'SELECT is_locked FROM quality_audit_results WHERE id = $1',
    [auditId]
  );
  return result.rows[0]?.is_locked || false;
}

// Exported so the P0 trigger routes can write to the new columns
// (dismiss_reason, next_reevaluate_at, hitl_action_code, etc.) without
// duplicating connection setup.
export { pool as auditTriggerPool };
