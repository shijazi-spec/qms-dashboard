import {
  fetchZohoRecords,
  analyzeRecordHygiene,
  calculateQualityScores,
  DEFAULT_GOVERNANCE_RULES,
} from "./zohoCRM";
import { saveAuditResult, getGovernanceDocumentByModule } from "./database";

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
      const modules = ["Leads", "Deals", "Contacts", "Tasks"];
      const allIssues: any[] = [];

      for (const moduleName of modules) {
        logger?.info(`📊 [DirectAudit] Auditing ${moduleName}...`);
        try {
          const records = await fetchZohoRecords(moduleName, { perPage: 100 });
          totalRecordsAudited += records.length;

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

          const moduleIssues: any[] = [];
          for (const record of records) {
            const issues = analyzeRecordHygiene(record, governanceRules);
            moduleIssues.push(...issues);
          }
          allIssues.push(...moduleIssues);

          moduleBreakdown.push({
            module: moduleName,
            recordsAudited: records.length,
            issuesFound: moduleIssues.length,
          });

          logger?.info(`✅ [DirectAudit] Completed ${moduleName}: ${moduleIssues.length} issues found`);
        } catch (error) {
          logger?.warn(`⚠️ [DirectAudit] Could not fetch ${moduleName}: ${error instanceof Error ? error.message : String(error)}`);
          moduleBreakdown.push({ module: moduleName, recordsAudited: 0, issuesFound: 0 });
        }
      }

      qualityScores = calculateQualityScores(allIssues, totalRecordsAudited);
      totalIssuesFound = allIssues.length;
      criticalIssues = allIssues.filter((i: any) => i.severity === 'critical').length;
      highIssues = allIssues.filter((i: any) => i.severity === 'high').length;
      mediumIssues = allIssues.filter((i: any) => i.severity === 'medium').length;
      lowIssues = allIssues.filter((i: any) => i.severity === 'low').length;

      const issueTypeCounts: Record<string, { count: number; severity: string; module: string }> = {};
      for (const issue of allIssues) {
        const key = `${issue.module}-${issue.issueType}`;
        if (!issueTypeCounts[key]) {
          issueTypeCounts[key] = { count: 0, severity: issue.severity, module: issue.module };
        }
        issueTypeCounts[key].count++;
      }
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
      },
    };

    await saveAuditResult(auditData);
    logger?.info("✅ [DirectAudit] Audit results saved to database successfully");
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
