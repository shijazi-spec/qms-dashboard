import { WebClient } from '@slack/web-api';

let slackClient: WebClient | null = null;

function getSlackClient(): WebClient | null {
  if (slackClient) return slackClient;
  const token = process.env.SLACK_BOT_TOKEN || process.env.SLACK_API_TOKEN;
  if (!token) {
    console.log('[Slack Notifications] No bot token configured');
    return null;
  }
  slackClient = new WebClient(token);
  return slackClient;
}

function getChannel(): string | null {
  return process.env.SLACK_CHANNEL_ID || process.env.SLACK_QMS_CHANNEL || null;
}

function scoreEmoji(score: number): string {
  if (score >= 90) return ':large_green_circle:';
  if (score >= 75) return ':large_yellow_circle:';
  if (score >= 60) return ':large_orange_circle:';
  return ':red_circle:';
}

function scoreLabel(score: number): string {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 60) return 'Needs Improvement';
  return 'Critical';
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });
}

export async function sendSlackNotification(
  channel: string,
  text: string,
  blocks?: any[]
): Promise<boolean> {
  const client = getSlackClient();
  if (!client) return false;

  try {
    await client.chat.postMessage({ channel, text, blocks });
    console.log(`[Slack Notifications] Message sent to ${channel}`);
    return true;
  } catch (error: any) {
    console.error('[Slack Notifications] Failed to send:', error?.message || error);
    return false;
  }
}

export async function sendAuditCompletedNotification(
  channelOverride: string | null,
  auditResult: {
    totalRecords: number;
    totalIssues: number;
    overallScore: number;
    peopleScore: number;
    processScore: number;
    governanceScore: number;
    auditDate: Date;
  }
): Promise<boolean> {
  const channel = channelOverride || getChannel();
  if (!channel) return false;

  const emoji = scoreEmoji(auditResult.overallScore);
  const label = scoreLabel(auditResult.overallScore);
  const fallback = `Quality Audit Completed - Score: ${auditResult.overallScore.toFixed(1)}% (${label})`;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':white_check_mark: Quality Audit Completed', emoji: true }
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Overall Score:*\n${emoji} ${auditResult.overallScore.toFixed(1)}% _(${label})_` },
        { type: 'mrkdwn', text: `*Records Audited:*\n${auditResult.totalRecords.toLocaleString()}` },
        { type: 'mrkdwn', text: `*Issues Found:*\n${auditResult.totalIssues > 0 ? ':warning: ' : ''}${auditResult.totalIssues.toLocaleString()}` },
        { type: 'mrkdwn', text: `*Audit Date:*\n${formatDate(auditResult.auditDate)}` }
      ]
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Dimension Breakdown:*\n${scoreEmoji(auditResult.peopleScore)} People: *${auditResult.peopleScore.toFixed(1)}%*\n${scoreEmoji(auditResult.processScore)} Process: *${auditResult.processScore.toFixed(1)}%*\n${scoreEmoji(auditResult.governanceScore)} Governance: *${auditResult.governanceScore.toFixed(1)}%*`
      }
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: ':robot_face: _WalaPlus QMS Dashboard | Automated Quality Audit_' }
      ]
    }
  ];

  return sendSlackNotification(channel, fallback, blocks);
}

export async function sendNonconformanceNotification(
  channelOverride: string | null,
  ncDetails: {
    totalNCs: number;
    criticalCount: number;
    majorCount: number;
    minorCount: number;
    ncIds: number[];
    auditDate: Date;
    moduleBreakdown?: Array<{ module: string; recordsAudited: number; issuesFound: number }>;
  }
): Promise<boolean> {
  const channel = channelOverride || getChannel();
  if (!channel) return false;

  const isCritical = ncDetails.criticalCount > 0;
  const headerEmoji = isCritical ? ':rotating_light:' : ':warning:';
  const fallback = `${isCritical ? 'CRITICAL: ' : ''}${ncDetails.totalNCs} Nonconformance(s) Detected`;

  const severityLines = [];
  if (ncDetails.criticalCount > 0) severityLines.push(`:red_circle: Critical: *${ncDetails.criticalCount}*`);
  if (ncDetails.majorCount > 0) severityLines.push(`:large_orange_circle: Major: *${ncDetails.majorCount}*`);
  if (ncDetails.minorCount > 0) severityLines.push(`:large_yellow_circle: Minor: *${ncDetails.minorCount}*`);

  const moduleLines: string[] = [];
  if (ncDetails.moduleBreakdown && ncDetails.moduleBreakdown.length > 0) {
    for (const m of ncDetails.moduleBreakdown) {
      if (m.issuesFound > 0) {
        moduleLines.push(`:file_folder: *${m.module}:* ${m.issuesFound.toLocaleString()} issues _(${m.recordsAudited.toLocaleString()} records)_`);
      }
    }
  }

  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${headerEmoji} ${ncDetails.totalNCs.toLocaleString()} Nonconformance(s) Detected`, emoji: true }
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Total NCs:*\n${ncDetails.totalNCs.toLocaleString()}` },
        { type: 'mrkdwn', text: `*Audit Date:*\n${formatDate(ncDetails.auditDate)}` }
      ]
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Severity Breakdown:*\n${severityLines.join('\n')}`
      }
    }
  ];

  if (moduleLines.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Findings Breakdown by Module:*\n${moduleLines.join('\n')}`
      }
    });
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: isCritical
        ? ':exclamation: *Immediate action required for critical findings. Assign owners and initiate corrective actions.*'
        : ':memo: *Review findings and assign corrective actions.*'
    }
  });

  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `:robot_face: _WalaPlus QMS Dashboard | NC IDs: ${ncDetails.ncIds.slice(0, 10).join(', ')}${ncDetails.ncIds.length > 10 ? '...' : ''}_` }
    ]
  });

  return sendSlackNotification(channel, fallback, blocks);
}

export async function sendCAPARequiredNotification(
  channelOverride: string | null,
  capaDetails: {
    ncId: number;
    ncTitle: string;
    severity: string;
    suggestedAction: string;
    auditDate: Date;
  }
): Promise<boolean> {
  const channel = channelOverride || getChannel();
  if (!channel) return false;

  const isCritical = capaDetails.severity === 'critical';
  const severityEmoji = isCritical ? ':red_circle:' : (capaDetails.severity === 'major' ? ':large_orange_circle:' : ':large_yellow_circle:');
  const fallback = `CAPA Required - ${capaDetails.severity.toUpperCase()}: ${capaDetails.ncTitle}`;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':clipboard: CAPA Action Required', emoji: true }
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Nonconformance:*\n${capaDetails.ncTitle}` },
        { type: 'mrkdwn', text: `*Severity:*\n${severityEmoji} ${capaDetails.severity.toUpperCase()}` },
        { type: 'mrkdwn', text: `*NC ID:*\n#${capaDetails.ncId}` },
        { type: 'mrkdwn', text: `*Audit Date:*\n${formatDate(capaDetails.auditDate)}` }
      ]
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Suggested Action:*\n>${capaDetails.suggestedAction}`
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':point_right: *Next Steps:* Create CAPA record, assign owner, and define corrective actions. Approval required.'
      }
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: ':robot_face: _WalaPlus QMS Dashboard | Automated CAPA Trigger_' }
      ]
    }
  ];

  return sendSlackNotification(channel, fallback, blocks);
}
