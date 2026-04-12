import pg from 'pg';
const { Pool } = pg;
import { createAIAlert, alertExists, type AlertType, type AlertSeverity } from './aiAlertsDatabase';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

interface ScanResult {
  alertsCreated: number;
  checksPerformed: number;
  findings: string[];
}

async function safeQuery(sql: string, params: any[] = []): Promise<any[]> {
  try {
    const result = await pool.query(sql, params);
    return result.rows;
  } catch {
    return [];
  }
}

async function createAlertIfNew(
  alertType: AlertType,
  severity: AlertSeverity,
  title: string,
  description: string,
  suggestion: string,
  relatedModule: string,
  relatedRecordId?: string
): Promise<boolean> {
  const exists = await alertExists(title, alertType);
  if (exists) return false;

  await createAIAlert({
    alert_type: alertType,
    severity,
    title,
    description,
    suggestion,
    related_module: relatedModule,
    related_record_id: relatedRecordId,
  });
  return true;
}

async function checkOpenNCsWithoutCAPA(result: ScanResult): Promise<void> {
  const rows = await safeQuery(`
    SELECT n.id, n.nc_number, n.title, n.severity, n.created_at
    FROM nonconformances n
    LEFT JOIN capas c ON c.nc_id = n.id
    WHERE n.status NOT IN ('closed', 'rejected')
      AND c.id IS NULL
      AND n.created_at < NOW() - INTERVAL '7 days'
    ORDER BY n.severity DESC, n.created_at ASC
    LIMIT 20
  `);
  result.checksPerformed++;

  for (const nc of rows) {
    const severity: AlertSeverity = nc.severity === 'critical' ? 'critical' : nc.severity === 'major' ? 'high' : 'medium';
    const created = await createAlertIfNew(
      'nc_detection', severity,
      `NC ${nc.nc_number} open 7+ days without CAPA`,
      `Nonconformance "${nc.title}" (${nc.severity}) has been open since ${new Date(nc.created_at).toLocaleDateString()} with no corrective action plan.`,
      `Create a CAPA for NC ${nc.nc_number} with root cause analysis and corrective action timeline.`,
      'qms', String(nc.id)
    );
    if (created) { result.alertsCreated++; result.findings.push(`NC ${nc.nc_number} needs CAPA`); }
  }
}

async function checkHighRisks(result: ScanResult): Promise<void> {
  const rows = await safeQuery(`
    SELECT id, title, risk_level, likelihood, impact, status
    FROM risks
    WHERE (likelihood * impact) >= 15
      AND status NOT IN ('closed', 'mitigated')
    ORDER BY (likelihood * impact) DESC
    LIMIT 20
  `);
  result.checksPerformed++;

  for (const risk of rows) {
    const score = (risk.likelihood || 0) * (risk.impact || 0);
    const created = await createAlertIfNew(
      'risk_alert', score >= 20 ? 'critical' : 'high',
      `High risk: ${risk.title} (score ${score})`,
      `Risk "${risk.title}" has a risk score of ${score} (${risk.likelihood}x${risk.impact}), level: ${risk.risk_level}. Status: ${risk.status}.`,
      `Review risk treatment plan. Consider escalating to management if no mitigation is in progress.`,
      'risk', String(risk.id)
    );
    if (created) { result.alertsCreated++; result.findings.push(`High risk: ${risk.title}`); }
  }
}

async function checkOverdueTreatments(result: ScanResult): Promise<void> {
  const rows = await safeQuery(`
    SELECT rta.id, rta.action_description, rta.due_date, rta.status, r.title as risk_title
    FROM risk_treatment_actions rta
    JOIN risks r ON r.id = rta.risk_id
    WHERE rta.due_date < NOW()
      AND rta.status NOT IN ('completed', 'cancelled')
    ORDER BY rta.due_date ASC
    LIMIT 20
  `);
  result.checksPerformed++;

  for (const action of rows) {
    const daysOverdue = Math.floor((Date.now() - new Date(action.due_date).getTime()) / 86400000);
    const created = await createAlertIfNew(
      'risk_alert', daysOverdue > 30 ? 'high' : 'medium',
      `Overdue treatment: ${action.action_description?.substring(0, 80)}`,
      `Risk treatment action for "${action.risk_title}" is ${daysOverdue} days overdue. Due: ${new Date(action.due_date).toLocaleDateString()}.`,
      `Update the treatment action status or request a deadline extension with justification.`,
      'risk', String(action.id)
    );
    if (created) { result.alertsCreated++; result.findings.push(`Overdue treatment for: ${action.risk_title}`); }
  }
}

async function checkMissedKPIs(result: ScanResult): Promise<void> {
  const rows = await safeQuery(`
    SELECT kd.id, kd.name, kd.target, ke.value, ke.period_end
    FROM kpi_definitions kd
    JOIN LATERAL (
      SELECT value, period_end FROM kpi_entries WHERE kpi_id = kd.id ORDER BY period_end DESC LIMIT 1
    ) ke ON true
    WHERE ke.value < kd.target
  `);
  result.checksPerformed++;

  for (const kpi of rows) {
    const gap = ((kpi.target - kpi.value) / kpi.target * 100).toFixed(1);
    const created = await createAlertIfNew(
      'kpi_miss', parseFloat(gap) > 20 ? 'high' : 'medium',
      `KPI missed: ${kpi.name} (${gap}% below target)`,
      `KPI "${kpi.name}" is at ${kpi.value} against target ${kpi.target} (${gap}% gap). Last measured: ${new Date(kpi.period_end).toLocaleDateString()}.`,
      `Investigate root cause of KPI miss and create corrective action if recurring.`,
      'kpis', String(kpi.id)
    );
    if (created) { result.alertsCreated++; result.findings.push(`KPI missed: ${kpi.name}`); }
  }
}

async function checkExpiringPolicies(result: ScanResult): Promise<void> {
  const rows = await safeQuery(`
    SELECT id, title, review_date, status
    FROM governance_documents
    WHERE review_date IS NOT NULL
      AND review_date < NOW() + INTERVAL '30 days'
      AND status NOT IN ('archived', 'superseded')
    ORDER BY review_date ASC
    LIMIT 20
  `);
  result.checksPerformed++;

  for (const doc of rows) {
    const isExpired = new Date(doc.review_date) < new Date();
    const created = await createAlertIfNew(
      'policy_expiry', isExpired ? 'high' : 'medium',
      `${isExpired ? 'Expired' : 'Expiring'} document: ${doc.title}`,
      `Governance document "${doc.title}" ${isExpired ? 'review date has passed' : 'is due for review within 30 days'}. Review date: ${new Date(doc.review_date).toLocaleDateString()}.`,
      `Schedule a document review cycle. Update content and get re-approval from document owner.`,
      'policies', String(doc.id)
    );
    if (created) { result.alertsCreated++; result.findings.push(`${isExpired ? 'Expired' : 'Expiring'}: ${doc.title}`); }
  }
}

async function checkPDPLGaps(result: ScanResult): Promise<void> {
  const inventoryCount = await safeQuery(`SELECT COUNT(*) as cnt FROM pdpl_data_inventory`);
  const guardrailCount = await safeQuery(`SELECT COUNT(*) as cnt FROM pdpl_ai_guardrails WHERE is_active = true`);
  const openIncidents = await safeQuery(`SELECT COUNT(*) as cnt FROM data_incidents WHERE status NOT IN ('closed', 'resolved')`);
  result.checksPerformed++;

  const invCount = parseInt(inventoryCount[0]?.cnt || '0');
  const grCount = parseInt(guardrailCount[0]?.cnt || '0');
  const incCount = parseInt(openIncidents[0]?.cnt || '0');

  if (invCount === 0) {
    const created = await createAlertIfNew(
      'regulation_gap', 'high',
      'PDPL: No data inventory records',
      'The PDPL data inventory is empty. Saudi PDPL requires organizations to maintain a comprehensive inventory of personal data processing activities.',
      'Create data inventory records for all personal data processing activities. Start with HR, CRM, and customer-facing systems.',
      'pdpl'
    );
    if (created) { result.alertsCreated++; result.findings.push('PDPL data inventory empty'); }
  }

  if (grCount === 0) {
    const created = await createAlertIfNew(
      'regulation_gap', 'medium',
      'PDPL: No active AI guardrails',
      'No active AI guardrails are configured. PDPL and emerging AI regulations require safeguards on AI-driven decision making.',
      'Configure AI guardrails for automated processing activities, especially those affecting individuals.',
      'pdpl'
    );
    if (created) { result.alertsCreated++; result.findings.push('No AI guardrails active'); }
  }

  if (incCount > 0) {
    const created = await createAlertIfNew(
      'regulation_gap', incCount > 3 ? 'high' : 'medium',
      `PDPL: ${incCount} open data incident(s)`,
      `There are ${incCount} unresolved data incidents. PDPL requires timely investigation and notification for data breaches.`,
      'Review and resolve open data incidents. Ensure breach notification timelines are met per PDPL requirements.',
      'pdpl'
    );
    if (created) { result.alertsCreated++; result.findings.push(`${incCount} open data incidents`); }
  }
}

async function checkAuditScoreDecline(result: ScanResult): Promise<void> {
  const rows = await safeQuery(`
    SELECT overall_score, audit_date
    FROM quality_audit_results
    ORDER BY audit_date DESC
    LIMIT 5
  `);
  result.checksPerformed++;

  if (rows.length >= 3) {
    const scores = rows.map(r => parseFloat(r.overall_score));
    const latest = scores[0];
    const previous = scores[1];
    const oldest = scores[scores.length - 1];

    if (latest < previous && previous < oldest && (oldest - latest) > 5) {
      const created = await createAlertIfNew(
        'audit_decline', 'high',
        `Audit scores declining: ${oldest.toFixed(1)}% -> ${latest.toFixed(1)}%`,
        `Quality audit scores have been declining over the last ${rows.length} audits. Latest: ${latest.toFixed(1)}%, Previous: ${previous.toFixed(1)}%, Oldest in window: ${oldest.toFixed(1)}%.`,
        'Investigate the root causes of score decline. Focus on the lowest-scoring dimension and create targeted improvement actions.',
        'quality'
      );
      if (created) { result.alertsCreated++; result.findings.push('Audit scores declining'); }
    }
  }
}

async function checkTrainingGaps(result: ScanResult): Promise<void> {
  const rows = await safeQuery(`
    SELECT id, title, assigned_to, due_date, status
    FROM training_records
    WHERE due_date < NOW()
      AND status NOT IN ('completed', 'cancelled')
    ORDER BY due_date ASC
    LIMIT 20
  `);
  result.checksPerformed++;

  if (rows.length > 0) {
    const created = await createAlertIfNew(
      'training_gap', rows.length > 5 ? 'high' : 'medium',
      `${rows.length} overdue training assignment(s)`,
      `There are ${rows.length} training assignments past their due date. Overdue items include: ${rows.slice(0, 3).map(r => r.title).join(', ')}${rows.length > 3 ? '...' : ''}.`,
      'Follow up with assigned team members. Reschedule overdue trainings and update completion deadlines.',
      'team'
    );
    if (created) { result.alertsCreated++; result.findings.push(`${rows.length} overdue trainings`); }
  }
}

export async function runBackgroundScan(): Promise<ScanResult> {
  const result: ScanResult = { alertsCreated: 0, checksPerformed: 0, findings: [] };

  console.log('[AI Scanner] Starting background platform scan...');

  await checkOpenNCsWithoutCAPA(result);
  await checkHighRisks(result);
  await checkOverdueTreatments(result);
  await checkMissedKPIs(result);
  await checkExpiringPolicies(result);
  await checkPDPLGaps(result);
  await checkAuditScoreDecline(result);
  await checkTrainingGaps(result);

  console.log(`[AI Scanner] Scan complete. Checks: ${result.checksPerformed}, Alerts created: ${result.alertsCreated}, Findings: ${result.findings.length}`);

  return result;
}
