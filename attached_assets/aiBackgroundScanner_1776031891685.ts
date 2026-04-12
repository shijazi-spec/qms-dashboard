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
    FROM nonconformance_records n
    LEFT JOIN capa_records c ON c.source_id = n.id::text
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

async function checkLowProgressTreatments(result: ScanResult): Promise<void> {
  const rows = await safeQuery(`
    SELECT rta.id, rta.action_description, rta.due_date, rta.status,
           COALESCE(rta.percent_complete, 0) as percent_complete,
           r.title as risk_title
    FROM risk_treatment_actions rta
    JOIN risks r ON r.id = rta.risk_id
    WHERE rta.due_date BETWEEN NOW() AND NOW() + INTERVAL '14 days'
      AND rta.status NOT IN ('completed', 'cancelled')
      AND COALESCE(rta.percent_complete, 0) < 50
    ORDER BY rta.due_date ASC
    LIMIT 20
  `);
  result.checksPerformed++;

  for (const action of rows) {
    const daysLeft = Math.ceil((new Date(action.due_date).getTime() - Date.now()) / 86400000);
    const created = await createAlertIfNew(
      'risk_alert', action.percent_complete < 25 ? 'high' : 'medium',
      `Low progress treatment: ${action.action_description?.substring(0, 60)} (${action.percent_complete}%)`,
      `Risk treatment for "${action.risk_title}" is only ${action.percent_complete}% complete with ${daysLeft} day(s) until deadline (${new Date(action.due_date).toLocaleDateString()}).`,
      `Escalate to treatment owner immediately. Consider requesting resources or adjusting the action plan scope to meet the deadline.`,
      'risk', String(action.id)
    );
    if (created) { result.alertsCreated++; result.findings.push(`Low progress (${action.percent_complete}%): ${action.risk_title}`); }
  }
}

// ═══════════════════════════════════════════════════════════
//  CRM SLA ENFORCEMENT CHECKS (Sales & SDR SOPs)
// ═══════════════════════════════════════════════════════════

async function checkSalesSLAViolations(result: ScanResult): Promise<void> {
  result.checksPerformed++;

  try {
    const { fetchAllZohoRecords, analyzeRecordHygiene, DEFAULT_GOVERNANCE_RULES } = await import('./zohoCRM');
    const { walaPlusSalesGovernanceRules } = await import('./governanceRules');

    const deals = await fetchAllZohoRecords('Deals', {
      maxRecords: 500,
      fields: ['Deal_Name', 'Stage', 'Stage_History', 'Created_Time', 'Modified_Time', 'Owner',
               'First_Call_Date', 'Meeting_Date', 'Proposal_Sent_Date', 'Agreement_Sent_Date', 'Agreement_Signed_Date',
               'On_Hold_Reason', 'Probability', 'Bundle_Type', 'Closing_Date']
    });

    const now = Date.now();
    const ONE_BIZ_DAY = 24 * 60 * 60 * 1000;
    const stageMaxDays: Record<string, number> = {
      'Meeting': 10, 'Proposal': 90, 'Agreement Sent': 90, 'On Hold': 180, 'Not Attend Meeting': 5
    };

    for (const deal of deals) {
      const d = deal.data;
      const stage = String(d.Stage || '');
      const dealLabel = String(d.Deal_Name || deal.id).substring(0, 60);
      const modifiedAt = d.Modified_Time ? new Date(d.Modified_Time).getTime() : 0;
      const createdAt = d.Created_Time ? new Date(d.Created_Time).getTime() : 0;

      // PR2: First Contact SLA (≤1 business day after SDR handoff = deal creation)
      if (stage === 'Contacted' || stage === 'Meeting' || stage === 'Proposal') {
        const firstCall = d.First_Call_Date ? new Date(d.First_Call_Date).getTime() : 0;
        if (firstCall && createdAt && (firstCall - createdAt) > 2 * ONE_BIZ_DAY) {
          const daysToContact = Math.round((firstCall - createdAt) / ONE_BIZ_DAY);
          await createAlertIfNew('sla_breach', 'high',
            `SLA: First contact took ${daysToContact}d for "${dealLabel}"`,
            `Deal "${dealLabel}" was contacted ${daysToContact} days after SDR handoff. SLA is ≤1 business day (Scorecard PR2).`,
            `Coach the assigned Sales agent on SDR handoff response time. Update CRM workflow to auto-assign follow-up tasks.`,
            'deals', deal.id
          );
          if (true) { result.alertsCreated++; result.findings.push(`SLA PR2 breach: ${dealLabel}`); }
        }
      }

      // PR3: Proposal Cycle Time (≤2 business days after meeting)
      if (d.Meeting_Date && d.Proposal_Sent_Date) {
        const meetingTime = new Date(d.Meeting_Date).getTime();
        const proposalTime = new Date(d.Proposal_Sent_Date).getTime();
        if ((proposalTime - meetingTime) > 3 * ONE_BIZ_DAY) {
          const daysToProposal = Math.round((proposalTime - meetingTime) / ONE_BIZ_DAY);
          await createAlertIfNew('sla_breach', 'high',
            `SLA: Proposal took ${daysToProposal}d after meeting for "${dealLabel}"`,
            `Proposal for "${dealLabel}" was sent ${daysToProposal} days after the meeting. SLA is ≤2 business days (Scorecard PR3).`,
            `Review proposal preparation process. Consider pre-prepared templates to accelerate turnaround.`,
            'deals', deal.id
          );
          if (true) { result.alertsCreated++; result.findings.push(`SLA PR3 breach: ${dealLabel}`); }
        }
      }

      // G4: Agreement Review & Signature (≤10 business days)
      if (d.Agreement_Sent_Date && stage === 'Agreement Sent') {
        const sentTime = new Date(d.Agreement_Sent_Date).getTime();
        const daysSinceSent = Math.round((now - sentTime) / ONE_BIZ_DAY);
        if (daysSinceSent > 14) {
          await createAlertIfNew('sla_breach', daysSinceSent > 30 ? 'critical' : 'high',
            `SLA: Agreement pending ${daysSinceSent}d for "${dealLabel}"`,
            `Agreement for "${dealLabel}" has been pending signature for ${daysSinceSent} days. SLA is ≤10 business days (Scorecard G4).`,
            `Escalate to Sales Manager. Follow up with client legal team. Consider involving GRC if delayed beyond 30 days.`,
            'deals', deal.id
          );
          if (true) { result.alertsCreated++; result.findings.push(`SLA G4 breach: ${dealLabel}`); }
        }
      }

      // G1: Same-day CRM Update — flag deals not modified in >2 business days while in active stages
      const activeStages = ['Contacted', 'Meeting', 'Proposal', 'Agreement Sent'];
      if (activeStages.includes(stage) && modifiedAt && (now - modifiedAt) > 3 * ONE_BIZ_DAY) {
        const daysSinceUpdate = Math.round((now - modifiedAt) / ONE_BIZ_DAY);
        await createAlertIfNew('sla_breach', 'medium',
          `CRM stale: "${dealLabel}" not updated in ${daysSinceUpdate}d`,
          `Deal "${dealLabel}" in "${stage}" stage has not been updated for ${daysSinceUpdate} days. SOP requires same-day CRM updates (Scorecard G1).`,
          `Remind the deal owner to update CRM with latest interaction notes or move the deal to appropriate stage.`,
          'deals', deal.id
        );
        if (true) { result.alertsCreated++; result.findings.push(`G1 stale CRM: ${dealLabel}`); }
      }

      // Stage max duration enforcement
      const maxDays = stageMaxDays[stage];
      if (maxDays && modifiedAt) {
        const daysInStage = Math.round((now - modifiedAt) / ONE_BIZ_DAY);
        if (daysInStage > maxDays) {
          await createAlertIfNew('sla_breach', daysInStage > maxDays * 1.5 ? 'high' : 'medium',
            `Stage aging: "${dealLabel}" in ${stage} for ${daysInStage}d (max ${maxDays}d)`,
            `Deal "${dealLabel}" has been in "${stage}" for ${daysInStage} days, exceeding the maximum of ${maxDays} days defined in the Sales SOP.`,
            `Review deal status with owner. Either progress to next stage or move to On Hold/Closed Lost with documented reason.`,
            'deals', deal.id
          );
          if (true) { result.alertsCreated++; result.findings.push(`Stage aging: ${dealLabel} in ${stage}`); }
        }
      }
    }
  } catch (error) {
    console.error('[AI Scanner] Sales SLA check failed:', error instanceof Error ? error.message : error);
  }
}

async function checkSDRSLAViolations(result: ScanResult): Promise<void> {
  result.checksPerformed++;

  try {
    const { fetchAllZohoRecords } = await import('./zohoCRM');

    const leads = await fetchAllZohoRecords('Leads', {
      maxRecords: 500,
      fields: ['First_Name', 'Last_Name', 'Company', 'Lead_Status', 'Lead_Source', 'Created_Time', 'Modified_Time',
               'Owner', 'Phone', 'Email', 'Outgoing_Call_Result', 'City', 'No_of_Employees', 'Industry']
    });

    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    const ONE_BIZ_DAY = 24 * ONE_HOUR;
    const stageMaxDays: Record<string, number> = {
      'Contacting': 5, 'Contacted': 3, 'On Hold': 90, 'Nurturing': 180
    };

    for (const lead of leads) {
      const d = lead.data;
      const status = String(d.Lead_Status || '');
      const source = String(d.Lead_Source || '').toLowerCase();
      const leadLabel = `${d.First_Name || ''} ${d.Last_Name || ''} (${d.Company || 'Unknown'})`.substring(0, 60);
      const createdAt = d.Created_Time ? new Date(d.Created_Time).getTime() : 0;
      const modifiedAt = d.Modified_Time ? new Date(d.Modified_Time).getTime() : 0;

      // Initial Contact SLA: Inbound ≤2h, Outbound ≤4h
      if (status === 'New' && createdAt) {
        const hoursSinceCreation = (now - createdAt) / ONE_HOUR;
        const isOutbound = source.includes('outbound') || source.includes('cold');
        const threshold = isOutbound ? 4 : 2;
        if (hoursSinceCreation > threshold * 3) {
          const hoursLate = Math.round(hoursSinceCreation);
          await createAlertIfNew('sla_breach', hoursLate > 48 ? 'high' : 'medium',
            `SDR SLA: Lead "${leadLabel}" not contacted in ${hoursLate}h`,
            `Lead "${leadLabel}" (${source}) has been in New status for ${hoursLate} hours. SDR SOP requires ${isOutbound ? '≤4h' : '≤2h'} initial contact.`,
            `Assign to available SDR immediately. If source queue is overloaded, escalate to SDR TL for redistribution.`,
            'leads', lead.id
          );
          if (true) { result.alertsCreated++; result.findings.push(`SDR SLA breach: ${leadLabel}`); }
        }
      }

      // Lead Qualification Decision SLA (≤3 business days from first contact)
      if ((status === 'Contacting' || status === 'Contacted') && modifiedAt) {
        const daysSinceModified = (now - modifiedAt) / ONE_BIZ_DAY;
        if (daysSinceModified > 5) {
          await createAlertIfNew('sla_breach', daysSinceModified > 10 ? 'high' : 'medium',
            `SDR: Lead "${leadLabel}" stuck in ${status} for ${Math.round(daysSinceModified)}d`,
            `Lead "${leadLabel}" has been in "${status}" for ${Math.round(daysSinceModified)} days without qualification decision. SLA is ≤3 business days.`,
            `Follow up immediately or mark as Not Qualified/On Hold with documented reason.`,
            'leads', lead.id
          );
          if (true) { result.alertsCreated++; result.findings.push(`SDR qualification delay: ${leadLabel}`); }
        }
      }

      // Stage max duration enforcement for Leads
      const maxDays = stageMaxDays[status];
      if (maxDays && modifiedAt) {
        const daysInStage = Math.round((now - modifiedAt) / ONE_BIZ_DAY);
        if (daysInStage > maxDays) {
          await createAlertIfNew('sla_breach', daysInStage > maxDays * 2 ? 'high' : 'medium',
            `Lead aging: "${leadLabel}" in ${status} for ${daysInStage}d (max ${maxDays}d)`,
            `Lead "${leadLabel}" has been in "${status}" for ${daysInStage} days, exceeding the SDR SOP maximum of ${maxDays} days.`,
            `Progress the lead or move to appropriate disposition (Not Qualified, Junk, or On Hold with reason).`,
            'leads', lead.id
          );
          if (true) { result.alertsCreated++; result.findings.push(`Lead aging: ${leadLabel} in ${status}`); }
        }
      }
    }
  } catch (error) {
    console.error('[AI Scanner] SDR SLA check failed:', error instanceof Error ? error.message : error);
  }
}

export async function runBackgroundScan(): Promise<ScanResult> {
  const result: ScanResult = { alertsCreated: 0, checksPerformed: 0, findings: [] };

  console.log('[AI Scanner] Starting background platform scan...');

  await checkOpenNCsWithoutCAPA(result);
  await checkHighRisks(result);
  await checkOverdueTreatments(result);
  await checkLowProgressTreatments(result);
  await checkMissedKPIs(result);
  await checkExpiringPolicies(result);
  await checkPDPLGaps(result);
  await checkAuditScoreDecline(result);
  await checkTrainingGaps(result);
  await checkSalesSLAViolations(result);
  await checkSDRSLAViolations(result);

  console.log(`[AI Scanner] Scan complete. Checks: ${result.checksPerformed}, Alerts created: ${result.alertsCreated}, Findings: ${result.findings.length}`);

  return result;
}
