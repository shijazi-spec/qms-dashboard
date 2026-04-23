import {
  fetchAllZohoRecords,
  analyzeRecordHygiene,
  calculateQualityScores,
  DEFAULT_GOVERNANCE_RULES,
  type ZohoCRMRecord,
  type HygieneIssue,
} from "./zohoCRM";
import { saveAuditResult, getGovernanceDocumentByModule } from "./database";

const BATCH_SIZE = 500;
const MAX_RECORDS_PER_MODULE = 50000;
// Per-module cap on detailed (per-record) issues. Using a per-module quota
// instead of a single global cap guarantees every audited module — including
// Tasks and Accounts which are processed last — has real per-record entries
// in `all_issues` so the drill-down modal never has to fall back to a
// synthetic "summary_*" row. Total ceiling = MAX_DETAILED_PER_MODULE * 5 modules.
const MAX_DETAILED_PER_MODULE = 200;

function analyzeRecordBatch(
  records: ZohoCRMRecord[],
  governanceRules: any[],
  issueTypeCounts: Record<string, { count: number; severity: string; module: string }>,
  detailedIssues?: Array<{ recordId: string; module: string; owner: string; layouts: string; products: string; createdBy: string; createdTime: string; fieldName: string; issueType: string; description: string; severity: string; suggestedFix: string }>,
  detailedCountsByModule?: Map<string, number>
): { issueCount: number; critical: number; high: number; medium: number; low: number; recordsWithIssues: number } {
  let issueCount = 0, critical = 0, high = 0, medium = 0, low = 0, recordsWithIssues = 0;
  for (const record of records) {
    const issues = analyzeRecordHygiene(record, governanceRules);
    issueCount += issues.length;
    if (issues.length > 0) recordsWithIssues++;
    for (const issue of issues) {
      if (issue.severity === 'critical') critical++;
      else if (issue.severity === 'high') high++;
      else if (issue.severity === 'medium') medium++;
      else low++;
      const key = `${issue.module}-${issue.issueType}`;
      if (!issueTypeCounts[key]) {
        issueTypeCounts[key] = { count: 0, severity: issue.severity, module: issue.module };
      }
      issueTypeCounts[key].count++;

      const moduleDetailedCount = detailedCountsByModule?.get(issue.module) ?? 0;
      if (detailedIssues && moduleDetailedCount < MAX_DETAILED_PER_MODULE) {
        const ownerData = record.data?.Owner;
        const ownerName = record.owner || (ownerData ? (ownerData.name || ownerData.id || '-') : '-');
        const createdByData = record.data?.Created_By;
        const createdByName = createdByData ? (createdByData.name || createdByData.id || '') : '';
        const layoutData = record.data?.Layout;
        // Zoho's REST API does not return a Layout field for Tasks records, so fall back
        // to "Standard" (the default layout name in Zoho) whenever the value is missing.
        // This keeps the dashboard's Issues by Layout view from showing a "(No Layout)" bucket.
        const layoutName = (layoutData ? (layoutData.name || (typeof layoutData === 'string' ? layoutData : '')) : '') || 'Standard';
        const productsRaw = record.data?.Product_Details;
        const productsName = (Array.isArray(productsRaw) && productsRaw.length > 0)
          ? productsRaw.map((p: any) => p.product?.name || '').filter(Boolean).join(', ')
          : (typeof record.data?.Products === 'object' ? record.data?.Products?.name : record.data?.Products) || record.data?.Product_Name || record.data?.Product || '';
        detailedIssues.push({
          recordId: issue.recordId,
          module: issue.module,
          owner: ownerName,
          layouts: layoutName,
          products: productsName,
          createdBy: createdByName,
          createdTime: record.data?.Created_Time || record.createdTime || '',
          fieldName: issue.fieldName || '',
          issueType: issue.issueType,
          description: issue.description,
          severity: issue.severity,
          suggestedFix: issue.suggestedFix || `Update the ${issue.fieldName || 'field'} in this record`,
        });
        if (detailedCountsByModule) {
          detailedCountsByModule.set(issue.module, moduleDetailedCount + 1);
        }
      }
    }
  }
  return { issueCount, critical, high, medium, low, recordsWithIssues };
}

export async function runDirectAudit(logger?: any) {
  logger?.info("🔍 [DirectAudit] Starting direct quality audit...");

  const hasZohoCredentials = !!(process.env.ZOHO_ACCESS_TOKEN || (process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN));

  let qualityScores = {
    peopleScore: 0,
    processScore: 0,
    governanceScore: 0,
    overallScore: 0,
  };
  let totalRecordsAudited = 0;
  let totalIssuesFound = 0;
  let criticalIssues = 0;
  let highIssues = 0;
  let mediumIssues = 0;
  let lowIssues = 0;
  const moduleBreakdown: Array<{ module: string; recordsAudited: number; issuesFound: number }> = [];
  const topIssues: Array<{ module: string; issueType: string; count: number; severity: string }> = [];
  let auditSuccess = false;
  let skipReason = "";
  const detailedIssues: Array<{ recordId: string; module: string; owner: string; layouts: string; products: string; createdBy: string; createdTime: string; fieldName: string; issueType: string; description: string; severity: string; suggestedFix: string }> = [];
  // Per-module tally so each module gets its own quota of detailed (per-record)
  // issues — prevents the first modules in the iteration order from starving
  // later ones (e.g. Tasks, Accounts) of `all_issues` entries.
  const detailedCountsByModule = new Map<string, number>();
  // Per-module unique-records-with-issues counts. Used by the dashboard's
  // compliance-rate calc as the truthful denominator (was previously
  // approximated from the 1000-row detailed sample, which made compliance
  // effectively constant regardless of CRM data changes).
  const recordCountsByModule: Record<string, number> = {};

  if (!hasZohoCredentials) {
    logger?.warn("⚠️ [DirectAudit] Zoho CRM credentials not configured - running with sample metrics");
    skipReason = "CRM integration not configured.";

    qualityScores = {
      peopleScore: 75,
      processScore: 68,
      governanceScore: 72,
      overallScore: 72,
    };
    totalRecordsAudited = 0;
    auditSuccess = true;
  } else {
    try {
      const modules = ["Leads", "Deals", "Contacts", "Accounts"];
      const issueTypeCounts: Record<string, { count: number; severity: string; module: string }> = {};

      for (const moduleName of modules) {
        logger?.info(`📊 [DirectAudit] Auditing ${moduleName} (paginated, up to ${MAX_RECORDS_PER_MODULE} records)...`);
        try {
          // Transient Zoho/network failures (e.g. "fetch failed" mid-pagination)
          // were previously fatal for an entire module — the module silently
          // dropped out of recordCountsByModule and the dashboard rendered "0"
          // for it. Retry up to 2 extra times with a short backoff before
          // giving up so a single flaky request no longer zeroes a module.
          let allRecords: ZohoCRMRecord[] | null = null;
          let lastErr: any = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              allRecords = await fetchAllZohoRecords(moduleName, { maxRecords: MAX_RECORDS_PER_MODULE });
              break;
            } catch (e) {
              lastErr = e;
              const msg = e instanceof Error ? e.message : String(e);
              logger?.warn(`⚠️ [DirectAudit] ${moduleName} fetch attempt ${attempt}/3 failed: ${msg}`);
              if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
            }
          }
          if (!allRecords) throw lastErr || new Error(`Failed to fetch ${moduleName}`);
          const recordCount = allRecords.length;
          totalRecordsAudited += recordCount;

          const moduleGovDoc = await getGovernanceDocumentByModule(moduleName);
          let governanceRules = DEFAULT_GOVERNANCE_RULES;

          if (moduleGovDoc?.rules_json) {
            try {
              const docRules = typeof moduleGovDoc.rules_json === 'string'
                ? JSON.parse(moduleGovDoc.rules_json)
                : moduleGovDoc.rules_json;
              if (Array.isArray(docRules)) {
                governanceRules = docRules;
              } else if (docRules.rules && Array.isArray(docRules.rules)) {
                governanceRules = docRules.rules;
              }
            } catch (e) {
              logger?.warn(`⚠️ [DirectAudit] Could not parse governance rules for ${moduleName}, using defaults`);
            }
          }

          let moduleIssueCount = 0;
          let moduleCritical = 0, moduleHigh = 0, moduleMedium = 0, moduleLow = 0;
          let moduleRecordsWithIssues = 0;

          for (let i = 0; i < recordCount; i += BATCH_SIZE) {
            const batch = allRecords.slice(i, i + BATCH_SIZE);
            const batchResult = analyzeRecordBatch(batch, governanceRules, issueTypeCounts, detailedIssues, detailedCountsByModule);
            moduleIssueCount += batchResult.issueCount;
            moduleCritical += batchResult.critical;
            moduleHigh += batchResult.high;
            moduleMedium += batchResult.medium;
            moduleLow += batchResult.low;
            moduleRecordsWithIssues += batchResult.recordsWithIssues;

            if (i > 0 && i % 5000 === 0) {
              logger?.info(`  📊 [DirectAudit] ${moduleName}: processed ${i}/${recordCount} records...`);
            }
          }

          totalIssuesFound += moduleIssueCount;
          criticalIssues += moduleCritical;
          highIssues += moduleHigh;
          mediumIssues += moduleMedium;
          lowIssues += moduleLow;
          recordCountsByModule[moduleName] = moduleRecordsWithIssues;

          moduleBreakdown.push({
            module: moduleName,
            recordsAudited: recordCount,
            issuesFound: moduleIssueCount,
            recordsWithIssues: moduleRecordsWithIssues,
          } as any);

          logger?.info(`✅ [DirectAudit] Completed ${moduleName}: ${recordCount} records, ${moduleIssueCount} issues found`);
        } catch (error) {
          logger?.warn(`⚠️ [DirectAudit] Could not fetch ${moduleName}: ${error instanceof Error ? error.message : String(error)}`);
          moduleBreakdown.push({ module: moduleName, recordsAudited: 0, issuesFound: 0 });
        }
      }

      qualityScores = calculateQualityScores(
        buildIssueSummary(criticalIssues, highIssues, mediumIssues, lowIssues),
        totalRecordsAudited
      );

      topIssues.push(
        ...Object.entries(issueTypeCounts)
          .map(([key, data]) => ({
            module: data.module,
            issueType: key.split('-').slice(1).join('-'),
            count: data.count,
            severity: data.severity,
          }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10)
      );

      auditSuccess = true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [DirectAudit] CRM audit failed", { error: errorMessage });
      skipReason = errorMessage;
    }
  }

  try {
    const recommendations = getDefaultRecommendations(qualityScores, totalIssuesFound, criticalIssues, highIssues);
    const auditData = {
      total_records_audited: totalRecordsAudited,
      total_issues_found: totalIssuesFound,
      people_score: qualityScores.peopleScore,
      process_score: qualityScores.processScore,
      governance_score: qualityScores.governanceScore,
      overall_score: qualityScores.overallScore,
      dimension_details: { moduleBreakdown, criticalIssues, highIssues, mediumIssues, lowIssues },
      issues_by_category: topIssues,
      recommendations,
      calendar_events_count: 0,
      raw_audit_data: {
        skipReason,
        insights: skipReason 
          ? `Partial audit completed. ${skipReason}` 
          : `Quality audit completed with ${totalIssuesFound} issues found across ${totalRecordsAudited} records.`,
        all_issues: detailedIssues,
        recordCountsByModule,
      },
    };

    const savedResult = await saveAuditResult(auditData);
    logger?.info("✅ [DirectAudit] Audit results saved to database successfully");

    // Slack notification — audit completed. Posts to SLACK_CHANNEL_ID using
    // SLACK_BOT_TOKEN. Failures are swallowed so a Slack outage never blocks
    // the audit pipeline. This is in addition to the internal audit_notifications
    // table updated by fireAuditCompletedTrigger below.
    try {
      const slackToken = process.env.SLACK_BOT_TOKEN;
      const slackChannel = process.env.SLACK_CHANNEL_ID || process.env.SLACK_DEFAULT_CHANNEL;
      if (slackToken && slackChannel) {
        const { WebClient } = await import("@slack/web-api");
        const slack = new WebClient(slackToken);
        const score = qualityScores.overallScore || 0;
        const scoreEmoji = score >= 90 ? "🟢" : score >= 80 ? "🟡" : score >= 70 ? "🟠" : "🔴";
        const sevSummary = `Critical: ${criticalIssues} · High: ${highIssues} · Medium: ${mediumIssues} · Low: ${lowIssues}`;
        const moduleSummary = moduleBreakdown
          .filter((m: any) => m.recordsAudited > 0)
          .map((m: any) => `• *${m.module}*: ${m.recordsAudited.toLocaleString()} records, ${m.issuesFound.toLocaleString()} issues`)
          .join("\n");
        const dashUrl = process.env.PUBLIC_DASHBOARD_URL || "https://qms-dashboard.replit.app/";
        await slack.chat.postMessage({
          channel: slackChannel,
          text: `${scoreEmoji} WalaPlus Quality Audit Completed — Score ${score.toFixed(1)}%`,
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: `${scoreEmoji} Quality Audit Completed` },
            },
            {
              type: "section",
              fields: [
                { type: "mrkdwn", text: `*Overall Score:*\n${score.toFixed(1)}%` },
                { type: "mrkdwn", text: `*Records Audited:*\n${totalRecordsAudited.toLocaleString()}` },
                { type: "mrkdwn", text: `*Issues Found:*\n${totalIssuesFound.toLocaleString()}` },
                { type: "mrkdwn", text: `*Severity:*\n${sevSummary}` },
                { type: "mrkdwn", text: `*People:* ${qualityScores.peopleScore.toFixed(1)}%` },
                { type: "mrkdwn", text: `*Process:* ${qualityScores.processScore.toFixed(1)}%` },
                { type: "mrkdwn", text: `*Governance:* ${qualityScores.governanceScore.toFixed(1)}%` },
              ],
            },
            ...(moduleSummary
              ? [{ type: "section" as const, text: { type: "mrkdwn" as const, text: `*Module Breakdown:*\n${moduleSummary}` } }]
              : []),
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Open Dashboard" },
                  url: dashUrl,
                },
              ],
            },
          ],
        });
        logger?.info("✅ [DirectAudit] Slack notification sent");
      } else {
        logger?.info("ℹ️ [DirectAudit] Slack not configured (SLACK_BOT_TOKEN / SLACK_CHANNEL_ID missing) — skipping Slack notification");
      }
    } catch (slackErr) {
      logger?.warn("⚠️ [DirectAudit] Slack notification failed (audit data was saved)", {
        error: slackErr instanceof Error ? slackErr.message : String(slackErr),
      });
    }

    try {
      const { fireAuditCompletedTrigger, fireNonconformanceDetectedTrigger, fireCAPARequiredTrigger } = await import("./auditTriggerDatabase");
      
      await fireAuditCompletedTrigger(savedResult.id!, {
        totalRecords: totalRecordsAudited,
        totalIssues: totalIssuesFound,
        overallScore: qualityScores.overallScore,
        peopleScore: qualityScores.peopleScore,
        processScore: qualityScores.processScore,
        governanceScore: qualityScores.governanceScore,
        auditDate: savedResult.audit_date || new Date(),
      });
      logger?.info("✅ [DirectAudit] AUDIT_COMPLETED trigger fired");

      if (criticalIssues > 0 || highIssues > 0) {
        await fireNonconformanceDetectedTrigger(savedResult.id!, {
          totalNCs: criticalIssues + highIssues,
          criticalCount: criticalIssues,
          majorCount: highIssues,
          minorCount: mediumIssues,
          ncIds: [],
          auditDate: savedResult.audit_date || new Date(),
          moduleBreakdown,
        });
        logger?.info("✅ [DirectAudit] NONCONFORMANCE_DETECTED trigger fired");
      }

      if (criticalIssues > 0 || qualityScores.overallScore < 70) {
        const topIssue = topIssues[0];
        await fireCAPARequiredTrigger(savedResult.id!, {
          ncId: 0,
          ncTitle: topIssue ? `${topIssue.module}: ${topIssue.issueType}` : 'Quality score below threshold',
          severity: criticalIssues > 0 ? 'critical' : 'high',
          suggestedAction: recommendations[0] || 'Review and address audit findings',
          auditDate: savedResult.audit_date || new Date(),
        });
        logger?.info("✅ [DirectAudit] CAPA_REQUIRED trigger fired");
      }
    } catch (triggerError) {
      logger?.error("❌ [DirectAudit] Failed to fire audit triggers (audit data was saved)", { 
        error: triggerError instanceof Error ? triggerError.message : String(triggerError) 
      });
    }
  } catch (error) {
    logger?.error("❌ [DirectAudit] Failed to save audit results", { error: error instanceof Error ? error.message : String(error) });
  }

  logger?.info("✅ [DirectAudit] Direct audit completed", {
    overallScore: qualityScores.overallScore,
    totalRecords: totalRecordsAudited,
    totalIssues: totalIssuesFound,
  });

  return { success: auditSuccess, qualityScores, totalRecordsAudited, totalIssuesFound };
}

function buildIssueSummary(critical: number, high: number, medium: number, low: number): HygieneIssue[] {
  const issues: HygieneIssue[] = [];
  const sev = (s: 'critical'|'high'|'medium'|'low', n: number) => {
    for (let i = 0; i < n; i++) {
      issues.push({ recordId: '', module: '', issueType: s === 'critical' || s === 'high' ? 'governance_violation' : s === 'medium' ? 'invalid_format' : 'missing_required_field', description: '', severity: s });
    }
  };
  sev('critical', critical);
  sev('high', high);
  sev('medium', medium);
  sev('low', low);
  return issues;
}

function getDefaultRecommendations(scores: any, totalIssues: number, critical: number, high: number): string[] {
  const recommendations: string[] = [];

  if (critical > 0) {
    recommendations.push(`Address ${critical} critical issues immediately - these require urgent attention`);
  }
  if (high > 0) {
    recommendations.push(`Review and resolve ${high} high-priority issues within this week`);
  }
  if (scores.peopleScore < 80) {
    recommendations.push("Improve data entry discipline by providing team training on CRM best practices");
  }
  if (scores.processScore < 80) {
    recommendations.push("Review and reinforce SOP compliance through regular team check-ins");
  }
  if (scores.governanceScore < 80) {
    recommendations.push("Implement stricter governance controls and automated validation rules");
  }
  if (recommendations.length < 3) {
    recommendations.push("Set up automated follow-up reminders for inactive leads and deals");
    recommendations.push("Ensure all meetings are logged in CRM within 24 hours");
    recommendations.push("Implement regular data validation checks for email and phone formats");
  }

  return recommendations.slice(0, 5);
}
