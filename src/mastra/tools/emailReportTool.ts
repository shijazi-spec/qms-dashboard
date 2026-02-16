import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { sendEmail } from "../../utils/replitmail";

export const sendQualityReportTool = createTool({
  id: "send-quality-report",

  description:
    "Sends a formatted quality audit report via email. Includes quality scores, hygiene issues summary, and actionable insights.",

  inputSchema: z.object({
    reportTitle: z.string().describe("Title of the quality report"),
    qualityScores: z.object({
      peopleScore: z.number(),
      processScore: z.number(),
      governanceScore: z.number(),
      overallScore: z.number(),
    }).describe("Quality scores from the audit"),
    auditSummary: z.object({
      totalRecordsAudited: z.number(),
      totalIssuesFound: z.number(),
      criticalIssues: z.number(),
      highIssues: z.number(),
      mediumIssues: z.number(),
      lowIssues: z.number(),
    }).describe("Summary of audit findings"),
    topIssues: z.array(z.object({
      module: z.string(),
      issueType: z.string(),
      count: z.number(),
      severity: z.string(),
    })).optional().describe("Top issues to highlight"),
    recommendations: z.array(z.string()).optional().describe("AI-generated recommendations"),
    calendarEventsChecked: z.number().optional().describe("Number of calendar events audited"),
    calendarIssues: z.number().optional().describe("Number of calendar-CRM sync issues found"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    messageId: z.string().optional(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📧 [sendQualityReportTool] Preparing quality report email...", {
      reportTitle: context.reportTitle,
      overallScore: context.qualityScores.overallScore,
    });

    try {
      const getScoreEmoji = (score: number): string => {
        if (score >= 90) return '🟢';
        if (score >= 70) return '🟡';
        if (score >= 50) return '🟠';
        return '🔴';
      };

      const getScoreLabel = (score: number): string => {
        if (score >= 90) return 'Excellent';
        if (score >= 70) return 'Good';
        if (score >= 50) return 'Needs Improvement';
        return 'Critical';
      };

      const { qualityScores, auditSummary, topIssues, recommendations, calendarEventsChecked, calendarIssues } = context;

      const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; text-align: center; margin-bottom: 30px; }
    .header h1 { margin: 0; font-size: 24px; }
    .header p { margin: 10px 0 0; opacity: 0.9; }
    .score-card { background: #f8f9fa; border-radius: 10px; padding: 25px; margin-bottom: 25px; }
    .score-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-top: 20px; }
    .score-item { background: white; padding: 20px; border-radius: 8px; text-align: center; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
    .score-value { font-size: 36px; font-weight: bold; margin: 10px 0; }
    .score-label { color: #666; font-size: 14px; }
    .overall-score { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; grid-column: span 2; }
    .summary-card { background: #fff; border: 1px solid #e0e0e0; border-radius: 10px; padding: 25px; margin-bottom: 25px; }
    .summary-card h2 { margin-top: 0; color: #333; border-bottom: 2px solid #667eea; padding-bottom: 10px; }
    .stat-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #eee; }
    .stat-label { color: #666; }
    .stat-value { font-weight: bold; }
    .issues-list { list-style: none; padding: 0; }
    .issues-list li { padding: 12px 15px; margin: 8px 0; border-radius: 6px; display: flex; justify-content: space-between; }
    .critical { background: #fee2e2; border-left: 4px solid #ef4444; }
    .high { background: #fef3c7; border-left: 4px solid #f59e0b; }
    .medium { background: #e0f2fe; border-left: 4px solid #0ea5e9; }
    .low { background: #f0fdf4; border-left: 4px solid #22c55e; }
    .recommendations { background: #f0fdf4; border-radius: 10px; padding: 25px; margin-bottom: 25px; }
    .recommendations h2 { margin-top: 0; color: #166534; }
    .recommendations ul { padding-left: 20px; }
    .recommendations li { margin: 10px 0; }
    .footer { text-align: center; color: #666; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🎯 ${context.reportTitle}</h1>
    <p>Generated on ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
  </div>

  <div class="score-card">
    <h2 style="margin-top: 0; margin-bottom: 5px;">Quality Scores</h2>
    <p style="color: #666; margin-top: 0;">Performance across People, Process, and Governance dimensions</p>
    <div class="score-grid">
      <div class="score-item overall-score">
        <div class="score-label">Overall Score</div>
        <div class="score-value">${qualityScores.overallScore}%</div>
        <div>${getScoreLabel(qualityScores.overallScore)}</div>
      </div>
      <div class="score-item">
        <div class="score-label">👥 People Score</div>
        <div class="score-value">${getScoreEmoji(qualityScores.peopleScore)} ${qualityScores.peopleScore}%</div>
      </div>
      <div class="score-item">
        <div class="score-label">⚙️ Process Score</div>
        <div class="score-value">${getScoreEmoji(qualityScores.processScore)} ${qualityScores.processScore}%</div>
      </div>
      <div class="score-item">
        <div class="score-label">📋 Governance Score</div>
        <div class="score-value">${getScoreEmoji(qualityScores.governanceScore)} ${qualityScores.governanceScore}%</div>
      </div>
    </div>
  </div>

  <div class="summary-card">
    <h2>📊 Audit Summary</h2>
    <div class="stat-row">
      <span class="stat-label">Total Records Audited</span>
      <span class="stat-value">${auditSummary.totalRecordsAudited.toLocaleString()}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Total Issues Found</span>
      <span class="stat-value">${auditSummary.totalIssuesFound.toLocaleString()}</span>
    </div>
    ${calendarEventsChecked !== undefined ? `
    <div class="stat-row">
      <span class="stat-label">Calendar Events Checked</span>
      <span class="stat-value">${calendarEventsChecked.toLocaleString()}</span>
    </div>` : ''}
    ${calendarIssues !== undefined ? `
    <div class="stat-row">
      <span class="stat-label">Calendar-CRM Sync Issues</span>
      <span class="stat-value">${calendarIssues}</span>
    </div>` : ''}
    <div style="margin-top: 20px;">
      <h3 style="margin-bottom: 15px;">Issues by Severity</h3>
      <ul class="issues-list">
        ${auditSummary.criticalIssues > 0 ? `<li class="critical"><span>🔴 Critical Issues</span><span>${auditSummary.criticalIssues}</span></li>` : ''}
        ${auditSummary.highIssues > 0 ? `<li class="high"><span>🟠 High Priority Issues</span><span>${auditSummary.highIssues}</span></li>` : ''}
        ${auditSummary.mediumIssues > 0 ? `<li class="medium"><span>🟡 Medium Priority Issues</span><span>${auditSummary.mediumIssues}</span></li>` : ''}
        ${auditSummary.lowIssues > 0 ? `<li class="low"><span>🟢 Low Priority Issues</span><span>${auditSummary.lowIssues}</span></li>` : ''}
        ${auditSummary.totalIssuesFound === 0 ? `<li class="low"><span>✅ No issues found!</span><span>Great job!</span></li>` : ''}
      </ul>
    </div>
  </div>

  ${topIssues && topIssues.length > 0 ? `
  <div class="summary-card">
    <h2>🔍 Top Issues to Address</h2>
    <ul class="issues-list">
      ${topIssues.slice(0, 10).map(issue => `
        <li class="${issue.severity}">
          <span><strong>${issue.module}</strong>: ${issue.issueType}</span>
          <span>${issue.count} occurrences</span>
        </li>
      `).join('')}
    </ul>
  </div>` : ''}

  ${recommendations && recommendations.length > 0 ? `
  <div class="recommendations">
    <h2>💡 AI-Powered Recommendations</h2>
    <ul>
      ${recommendations.map(rec => `<li>${rec}</li>`).join('')}
    </ul>
  </div>` : ''}

  <div class="footer">
    <p>This report was automatically generated by the WalaPlus Agentic AI Quality Specialist</p>
    <p>Powered by Mastra AI • ${new Date().toISOString()}</p>
  </div>
</body>
</html>`;

      const textContent = `
${context.reportTitle}
Generated: ${new Date().toLocaleDateString()}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUALITY SCORES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Overall Score: ${qualityScores.overallScore}% (${getScoreLabel(qualityScores.overallScore)})
People Score: ${qualityScores.peopleScore}%
Process Score: ${qualityScores.processScore}%
Governance Score: ${qualityScores.governanceScore}%

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AUDIT SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Total Records Audited: ${auditSummary.totalRecordsAudited}
Total Issues Found: ${auditSummary.totalIssuesFound}
${calendarEventsChecked !== undefined ? `Calendar Events Checked: ${calendarEventsChecked}` : ''}
${calendarIssues !== undefined ? `Calendar-CRM Sync Issues: ${calendarIssues}` : ''}

Issues by Severity:
- Critical: ${auditSummary.criticalIssues}
- High: ${auditSummary.highIssues}
- Medium: ${auditSummary.mediumIssues}
- Low: ${auditSummary.lowIssues}

${topIssues && topIssues.length > 0 ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TOP ISSUES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${topIssues.slice(0, 10).map(issue => `• ${issue.module}: ${issue.issueType} (${issue.count} occurrences)`).join('\n')}
` : ''}

${recommendations && recommendations.length > 0 ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECOMMENDATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${recommendations.map((rec, i) => `${i + 1}. ${rec}`).join('\n')}
` : ''}

---
This report was automatically generated by the WalaPlus Agentic AI Quality Specialist
`;

      logger?.info("📧 [sendQualityReportTool] Sending email...");

      const result = await sendEmail({
        subject: `${getScoreEmoji(qualityScores.overallScore)} ${context.reportTitle} - Overall Score: ${qualityScores.overallScore}%`,
        html: htmlContent,
        text: textContent,
      });

      logger?.info("✅ [sendQualityReportTool] Email sent successfully", {
        messageId: result.messageId,
        accepted: result.accepted,
      });

      return {
        success: true,
        messageId: result.messageId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [sendQualityReportTool] Failed to send email", { error: errorMessage });

      return {
        success: false,
        error: errorMessage,
      };
    }
  },
});

export const sendAlertTool = createTool({
  id: "send-alert",

  description:
    "Sends an immediate alert email for critical issues that require urgent attention.",

  inputSchema: z.object({
    alertTitle: z.string().describe("Title of the alert"),
    alertType: z.enum(["critical", "high", "medium", "info"]).describe("Severity of the alert"),
    message: z.string().describe("Alert message describing the issue"),
    affectedRecords: z.array(z.object({
      id: z.string(),
      name: z.string(),
      module: z.string(),
      issue: z.string(),
    })).optional().describe("List of affected records"),
    suggestedActions: z.array(z.string()).optional().describe("Suggested actions to resolve"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    messageId: z.string().optional(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🚨 [sendAlertTool] Sending alert email...", {
      alertTitle: context.alertTitle,
      alertType: context.alertType,
    });

    try {
      const alertColors = {
        critical: { bg: '#fee2e2', border: '#ef4444', emoji: '🔴' },
        high: { bg: '#fef3c7', border: '#f59e0b', emoji: '🟠' },
        medium: { bg: '#e0f2fe', border: '#0ea5e9', emoji: '🟡' },
        info: { bg: '#f0fdf4', border: '#22c55e', emoji: '🔵' },
      };

      const colors = alertColors[context.alertType];

      const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
    .alert-box { background: ${colors.bg}; border-left: 5px solid ${colors.border}; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
    .alert-title { font-size: 20px; font-weight: bold; margin-bottom: 10px; }
    .alert-message { margin-bottom: 15px; }
    .records-list { background: white; border-radius: 6px; padding: 15px; margin-top: 15px; }
    .record-item { padding: 10px; border-bottom: 1px solid #eee; }
    .record-item:last-child { border-bottom: none; }
    .actions { background: #f8f9fa; border-radius: 6px; padding: 15px; margin-top: 15px; }
    .actions h3 { margin-top: 0; }
    .actions ul { padding-left: 20px; }
  </style>
</head>
<body>
  <div class="alert-box">
    <div class="alert-title">${colors.emoji} ${context.alertTitle}</div>
    <div class="alert-message">${context.message}</div>
    <div><strong>Alert Type:</strong> ${context.alertType.toUpperCase()}</div>
    <div><strong>Time:</strong> ${new Date().toLocaleString()}</div>
  </div>

  ${context.affectedRecords && context.affectedRecords.length > 0 ? `
  <div class="records-list">
    <h3>Affected Records (${context.affectedRecords.length})</h3>
    ${context.affectedRecords.slice(0, 10).map(record => `
      <div class="record-item">
        <strong>${record.name}</strong> (${record.module})
        <br><small>ID: ${record.id} • Issue: ${record.issue}</small>
      </div>
    `).join('')}
    ${context.affectedRecords.length > 10 ? `<p><em>... and ${context.affectedRecords.length - 10} more records</em></p>` : ''}
  </div>` : ''}

  ${context.suggestedActions && context.suggestedActions.length > 0 ? `
  <div class="actions">
    <h3>Suggested Actions</h3>
    <ul>
      ${context.suggestedActions.map(action => `<li>${action}</li>`).join('')}
    </ul>
  </div>` : ''}

  <p style="color: #666; font-size: 12px; margin-top: 20px;">
    This alert was generated by the WalaPlus Agentic AI Quality Specialist
  </p>
</body>
</html>`;

      const result = await sendEmail({
        subject: `${colors.emoji} [${context.alertType.toUpperCase()}] ${context.alertTitle}`,
        html: htmlContent,
        text: `${context.alertTitle}\n\n${context.message}\n\nAlert Type: ${context.alertType}\nTime: ${new Date().toLocaleString()}`,
      });

      logger?.info("✅ [sendAlertTool] Alert sent successfully", { messageId: result.messageId });

      return {
        success: true,
        messageId: result.messageId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [sendAlertTool] Failed to send alert", { error: errorMessage });

      return {
        success: false,
        error: errorMessage,
      };
    }
  },
});
