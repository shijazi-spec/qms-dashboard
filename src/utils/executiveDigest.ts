import pg from 'pg';
import {
  getWeeklyFeedbackDigest,
  summarizeFeedbackTrend,
  type FeedbackTrendSummary,
} from './aiFeedbackDatabase';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function safeQuery(sql: string, params: any[] = []): Promise<any[]> {
  try {
    const result = await pool.query(sql, params);
    return result.rows;
  } catch {
    return [];
  }
}

export interface DigestData {
  generated_at: string;
  period: string;
  nc_summary: { open: number; opened_this_week: number; closed_this_week: number; overdue: number };
  capa_summary: { open: number; opened_this_week: number; closed_this_week: number; effectiveness_rate: number };
  risk_summary: { total_active: number; critical_high: number; new_this_week: number; overdue_treatments: number };
  audit_summary: { last_score: number | null; last_date: string | null; trend: 'improving' | 'declining' | 'stable' };
  kpi_summary: { green: number; amber: number; red: number; total: number };
  compliance_summary: { met: number; partial: number; not_met: number; total: number };
  top_alerts: Array<{ title: string; severity: string; module: string }>;
  capa_recurrences: number;
  duplicate_clusters: number;
  ai_feedback_summary: {
    period: string;
    total: number;
    thumbs_up: number;
    thumbs_down: number;
    thumbs_up_pct: number;
    trend: FeedbackTrendSummary;
  };
}

export async function generateDigestData(): Promise<DigestData> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekAgoStr = weekAgo.toISOString();

  const ncOpen = await safeQuery(`SELECT COUNT(*) as cnt FROM nonconformance_records WHERE status NOT IN ('closed', 'rejected')`);
  const ncNewWeek = await safeQuery(`SELECT COUNT(*) as cnt FROM nonconformance_records WHERE created_at >= $1`, [weekAgoStr]);
  const ncClosedWeek = await safeQuery(`SELECT COUNT(*) as cnt FROM nonconformance_records WHERE closed_date >= $1`, [weekAgoStr]);
  const ncOverdue = await safeQuery(`SELECT COUNT(*) as cnt FROM nonconformance_records WHERE status NOT IN ('closed', 'rejected') AND created_at < NOW() - INTERVAL '15 days'`);

  const capaOpen = await safeQuery(`SELECT COUNT(*) as cnt FROM capa_records WHERE status NOT IN ('closed', 'cancelled')`);
  const capaNewWeek = await safeQuery(`SELECT COUNT(*) as cnt FROM capa_records WHERE created_at >= $1`, [weekAgoStr]);
  const capaClosedWeek = await safeQuery(`SELECT COUNT(*) as cnt FROM capa_records WHERE completion_date >= $1`, [weekAgoStr]);
  const capaEffective = await safeQuery(`SELECT COUNT(*) FILTER (WHERE effectiveness_result = 'effective') as eff, COUNT(*) as total FROM capa_records WHERE effectiveness_result IS NOT NULL`);

  const riskActive = await safeQuery(`SELECT COUNT(*) as cnt FROM risk_register WHERE status != 'closed'`);
  const riskCritHigh = await safeQuery(`SELECT COUNT(*) as cnt FROM risk_register WHERE (likelihood * impact) >= 15 AND status != 'closed'`);
  const riskNew = await safeQuery(`SELECT COUNT(*) as cnt FROM risk_register WHERE created_at >= $1`, [weekAgoStr]);
  const riskOverdueTreatments = await safeQuery(`SELECT COUNT(*) as cnt FROM risk_treatment_actions WHERE due_date < CURRENT_DATE AND status NOT IN ('completed', 'cancelled')`);

  const auditRows = await safeQuery(`SELECT overall_score, audit_date FROM quality_audits ORDER BY audit_date DESC LIMIT 3`);
  let auditTrend: 'improving' | 'declining' | 'stable' = 'stable';
  if (auditRows.length >= 2) {
    const diff = parseFloat(auditRows[0]?.overall_score || '0') - parseFloat(auditRows[1]?.overall_score || '0');
    auditTrend = diff > 2 ? 'improving' : diff < -2 ? 'declining' : 'stable';
  }

  const kpiRows = await safeQuery(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('green', 'on_track')) as green,
      COUNT(*) FILTER (WHERE status IN ('amber', 'at_risk')) as amber,
      COUNT(*) FILTER (WHERE status IN ('red', 'off_track')) as red,
      COUNT(*) as total
    FROM kpi_entries
  `);

  const compRows = await safeQuery(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'met') as met,
      COUNT(*) FILTER (WHERE status = 'partial') as partial,
      COUNT(*) FILTER (WHERE status = 'not_met') as not_met,
      COUNT(*) as total
    FROM compliance_obligations
  `);

  const alertRows = await safeQuery(`
    SELECT title, severity, related_module as module
    FROM ai_alerts
    WHERE status = 'active' AND severity IN ('critical', 'high')
    ORDER BY created_at DESC LIMIT 5
  `);

  const recurrenceRows = await safeQuery(`
    SELECT root_cause, COUNT(*) as cnt
    FROM capa_records
    WHERE root_cause IS NOT NULL AND TRIM(root_cause) != ''
    GROUP BY root_cause HAVING COUNT(*) > 1
  `);

  const duplicateClusters = await safeQuery(`SELECT COUNT(*) as cnt FROM duplicate_clusters WHERE status = 'active'`);

  let aiFeedbackSummary: DigestData['ai_feedback_summary'] = {
    period: `${weekAgo.toDateString()} – ${now.toDateString()}`,
    total: 0,
    thumbs_up: 0,
    thumbs_down: 0,
    thumbs_up_pct: 0,
    trend: {
      direction: 'insufficient_data',
      peak_negative_day: null,
      peak_negative_count: 0,
      total_thumbs_up: 0,
      total_thumbs_down: 0,
      first_half_down_rate: 0,
      second_half_down_rate: 0,
      days_observed: 0,
    },
  };
  try {
    const weekly = await getWeeklyFeedbackDigest();
    aiFeedbackSummary = {
      period: weekly.period,
      total: weekly.total,
      thumbs_up: weekly.thumbs_up,
      thumbs_down: weekly.thumbs_down,
      thumbs_up_pct: weekly.thumbs_up_pct,
      trend: summarizeFeedbackTrend(weekly.trend),
    };
  } catch {}

  return {
    generated_at: now.toISOString(),
    period: `${weekAgo.toLocaleDateString()} — ${now.toLocaleDateString()}`,
    nc_summary: {
      open: parseInt(ncOpen[0]?.cnt || '0'),
      opened_this_week: parseInt(ncNewWeek[0]?.cnt || '0'),
      closed_this_week: parseInt(ncClosedWeek[0]?.cnt || '0'),
      overdue: parseInt(ncOverdue[0]?.cnt || '0'),
    },
    capa_summary: {
      open: parseInt(capaOpen[0]?.cnt || '0'),
      opened_this_week: parseInt(capaNewWeek[0]?.cnt || '0'),
      closed_this_week: parseInt(capaClosedWeek[0]?.cnt || '0'),
      effectiveness_rate: parseInt(capaEffective[0]?.total || '0') > 0
        ? Math.round((parseInt(capaEffective[0]?.eff || '0') / parseInt(capaEffective[0]?.total || '1')) * 100) : 0,
    },
    risk_summary: {
      total_active: parseInt(riskActive[0]?.cnt || '0'),
      critical_high: parseInt(riskCritHigh[0]?.cnt || '0'),
      new_this_week: parseInt(riskNew[0]?.cnt || '0'),
      overdue_treatments: parseInt(riskOverdueTreatments[0]?.cnt || '0'),
    },
    audit_summary: {
      last_score: auditRows[0]?.overall_score ? parseFloat(auditRows[0].overall_score) : null,
      last_date: auditRows[0]?.audit_date || null,
      trend: auditTrend,
    },
    kpi_summary: {
      green: parseInt(kpiRows[0]?.green || '0'),
      amber: parseInt(kpiRows[0]?.amber || '0'),
      red: parseInt(kpiRows[0]?.red || '0'),
      total: parseInt(kpiRows[0]?.total || '0'),
    },
    compliance_summary: {
      met: parseInt(compRows[0]?.met || '0'),
      partial: parseInt(compRows[0]?.partial || '0'),
      not_met: parseInt(compRows[0]?.not_met || '0'),
      total: parseInt(compRows[0]?.total || '0'),
    },
    top_alerts: alertRows,
    capa_recurrences: recurrenceRows.length,
    duplicate_clusters: parseInt(duplicateClusters[0]?.cnt || '0'),
    ai_feedback_summary: aiFeedbackSummary,
  };
}

export function buildDigestHTML(data: DigestData): string {
  const trendIcon = data.audit_summary.trend === 'improving' ? '↑' : data.audit_summary.trend === 'declining' ? '↓' : '→';
  const trendColor = data.audit_summary.trend === 'improving' ? '#047857' : data.audit_summary.trend === 'declining' ? '#B91C1C' : '#6B7280';

  const fb = data.ai_feedback_summary;
  const fbDir = fb.trend.direction;
  const fbIcon = fbDir === 'improving' ? '↑' : fbDir === 'worsening' ? '↓' : fbDir === 'stable' ? '→' : '·';
  const fbColor = fbDir === 'improving' ? '#047857' : fbDir === 'worsening' ? '#B91C1C' : '#6B7280';
  const fbLabel = fbDir === 'insufficient_data' ? 'insufficient data' : fbDir;
  const fbSection = fb.total === 0
    ? `<div class="card"><h3>AI Consultant Feedback</h3><p style="font-size:13px;color:#6B7280">No feedback this week.</p></div>`
    : `<div class="card">
  <h3>AI Consultant Feedback</h3>
  <div class="metric-row"><span>Total responses rated</span><span class="metric-value">${fb.total}</span></div>
  <div class="metric-row"><span><span class="badge badge-green">Thumbs up</span></span><span class="metric-value">${fb.thumbs_up} (${fb.thumbs_up_pct}%)</span></div>
  <div class="metric-row"><span><span class="badge badge-red">Thumbs down</span></span><span class="metric-value">${fb.thumbs_down}</span></div>
  <div class="metric-row"><span>Trend</span><span class="metric-value" style="color:${fbColor}">${fbIcon} ${fbLabel}</span></div>
  ${fb.trend.peak_negative_day && fb.trend.peak_negative_count > 0 ? `<div class="metric-row"><span>Peak negative day</span><span class="metric-value">${fb.trend.peak_negative_day} (${fb.trend.peak_negative_count})</span></div>` : ''}
</div>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>WalaPlus Weekly Quality Digest</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1a1a1a; max-width: 700px; margin: 0 auto; padding: 20px; background: #f9fafb; }
  .header { background: linear-gradient(135deg, #1E3A8A, #3B82F6); color: white; padding: 24px; border-radius: 12px; margin-bottom: 20px; }
  .header h1 { margin: 0; font-size: 22px; }
  .header p { margin: 4px 0 0; opacity: 0.85; font-size: 13px; }
  .card { background: white; border-radius: 10px; padding: 16px 20px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .card h3 { margin: 0 0 12px; font-size: 15px; color: #374151; border-bottom: 1px solid #E5E7EB; padding-bottom: 8px; }
  .metric-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
  .metric-value { font-weight: 600; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .badge-red { background: #FEE2E2; color: #B91C1C; }
  .badge-amber { background: #FEF3C7; color: #D97706; }
  .badge-green { background: #D1FAE5; color: #047857; }
  .alert-row { padding: 6px 0; border-bottom: 1px solid #F3F4F6; font-size: 13px; }
  .footer { text-align: center; margin-top: 20px; font-size: 11px; color: #9CA3AF; }
</style></head><body>
<div class="header">
  <h1>Weekly Quality Digest</h1>
  <p>${data.period}</p>
</div>

<div class="card">
  <h3>Nonconformances</h3>
  <div class="metric-row"><span>Open NCs</span><span class="metric-value">${data.nc_summary.open}</span></div>
  <div class="metric-row"><span>Opened this week</span><span class="metric-value">${data.nc_summary.opened_this_week}</span></div>
  <div class="metric-row"><span>Closed this week</span><span class="metric-value">${data.nc_summary.closed_this_week}</span></div>
  <div class="metric-row"><span>Overdue (&gt;15 days)</span><span class="metric-value" style="color:${data.nc_summary.overdue > 0 ? '#B91C1C' : '#047857'}">${data.nc_summary.overdue}</span></div>
</div>

<div class="card">
  <h3>CAPAs</h3>
  <div class="metric-row"><span>Open CAPAs</span><span class="metric-value">${data.capa_summary.open}</span></div>
  <div class="metric-row"><span>Opened this week</span><span class="metric-value">${data.capa_summary.opened_this_week}</span></div>
  <div class="metric-row"><span>Closed this week</span><span class="metric-value">${data.capa_summary.closed_this_week}</span></div>
  <div class="metric-row"><span>Effectiveness rate</span><span class="metric-value">${data.capa_summary.effectiveness_rate}%</span></div>
</div>

<div class="card">
  <h3>Risks</h3>
  <div class="metric-row"><span>Active risks</span><span class="metric-value">${data.risk_summary.total_active}</span></div>
  <div class="metric-row"><span>Critical/High</span><span class="metric-value" style="color:${data.risk_summary.critical_high > 0 ? '#B91C1C' : '#047857'}">${data.risk_summary.critical_high}</span></div>
  <div class="metric-row"><span>New this week</span><span class="metric-value">${data.risk_summary.new_this_week}</span></div>
  <div class="metric-row"><span>Overdue treatments</span><span class="metric-value" style="color:${data.risk_summary.overdue_treatments > 0 ? '#D97706' : '#047857'}">${data.risk_summary.overdue_treatments}</span></div>
</div>

<div class="card">
  <h3>Quality Audit</h3>
  <div class="metric-row"><span>Last score</span><span class="metric-value">${data.audit_summary.last_score !== null ? data.audit_summary.last_score + '%' : 'N/A'}</span></div>
  <div class="metric-row"><span>Trend</span><span class="metric-value" style="color:${trendColor}">${trendIcon} ${data.audit_summary.trend}</span></div>
</div>

<div class="card">
  <h3>KPIs</h3>
  <div class="metric-row"><span><span class="badge badge-green">Green</span></span><span class="metric-value">${data.kpi_summary.green}</span></div>
  <div class="metric-row"><span><span class="badge badge-amber">Amber</span></span><span class="metric-value">${data.kpi_summary.amber}</span></div>
  <div class="metric-row"><span><span class="badge badge-red">Red</span></span><span class="metric-value">${data.kpi_summary.red}</span></div>
</div>

${fbSection}

${data.top_alerts.length > 0 ? `<div class="card">
  <h3>Top Alerts</h3>
  ${data.top_alerts.map(a => `<div class="alert-row"><span class="badge badge-${a.severity === 'critical' ? 'red' : 'amber'}">${a.severity}</span> ${a.title}</div>`).join('')}
</div>` : ''}

${data.capa_recurrences > 0 ? `<div class="card"><h3>CAPA Recurrences</h3><p style="font-size:13px">${data.capa_recurrences} recurring root cause pattern(s) detected — review recommended.</p></div>` : ''}

${data.duplicate_clusters > 0 ? `<div class="card"><h3>Duplicate Radar</h3><p style="font-size:13px">${data.duplicate_clusters} active duplicate cluster(s) require attention.</p></div>` : ''}

<div class="footer">Generated by WalaPlus QMS Platform — ${data.generated_at}<br/>This is an automated quality digest. Do not reply.</div>
</body></html>`;
}

export async function sendDigestEmail(): Promise<{ success: boolean; method?: string; error?: string }> {
  const data = await generateDigestData();
  const html = buildDigestHTML(data);

  const recipientEmail = process.env.QUALITY_DIGEST_EMAIL || process.env.ADMIN_EMAIL;
  if (!recipientEmail) {
    return { success: false, error: 'No recipient email configured (QUALITY_DIGEST_EMAIL or ADMIN_EMAIL)' };
  }

  if (process.env.RESEND_API_KEY) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'WalaPlus QMS <noreply@walaplus.com>',
          to: recipientEmail,
          subject: `Weekly Quality Digest — ${new Date().toLocaleDateString()}`,
          html,
        }),
      });
      if (response.ok) return { success: true, method: 'resend' };
    } catch {}
  }

  try {
    const mailUrl = `https://${process.env.REPL_SLUG || 'qms'}.${process.env.REPL_OWNER || 'user'}.repl.co/__repl_mail/send`;
    const response = await fetch(mailUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: recipientEmail, subject: `Weekly Quality Digest — ${new Date().toLocaleDateString()}`, html }),
    });
    if (response.ok) return { success: true, method: 'replit_mail' };
  } catch {}

  return { success: false, error: 'No email service available' };
}
