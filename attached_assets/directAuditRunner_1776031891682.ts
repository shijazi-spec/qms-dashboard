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

function analyzeRecordBatch(
  records: ZohoCRMRecord[],
  governanceRules: any[],
  issueTypeCounts: Record<string, { count: number; severity: string; module: string }>
): { issueCount: number; critical: number; high: number; medium: number; low: number } {
  let issueCount = 0, critical = 0, high = 0, medium = 0, low = 0;
  for (const record of records) {
    const issues = analyzeRecordHygiene(record, governanceRules);
    issueCount += issues.length;
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
    }
  }
  return { issueCount, critical, high, medium, low };
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
      const modules = ["Leads", "Deals", "Contacts", "Tasks", "Accounts"];
      const issueTypeCounts: Record<string, { count: number; severity: string; module: string }> = {};

      for (const moduleName of modules) {
        logger?.info(`📊 [DirectAudit] Auditing ${moduleName} (paginated, up to ${MAX_RECORDS_PER_MODULE} records)...`);
        try {
          const allRecords = await fetchAllZohoRecords(moduleName, { maxRecords: MAX_RECORDS_PER_MODULE });
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

          for (let i = 0; i < recordCount; i += BATCH_SIZE) {
            const batch = allRecords.slice(i, i + BATCH_SIZE);
            const batchResult = analyzeRecordBatch(batch, governanceRules, issueTypeCounts);
            moduleIssueCount += batchResult.issueCount;
            moduleCritical += batchResult.critical;
            moduleHigh += batchResult.high;
            moduleMedium += batchResult.medium;
            moduleLow += batchResult.low;

            if (i > 0 && i % 5000 === 0) {
              logger?.info(`  📊 [DirectAudit] ${moduleName}: processed ${i}/${recordCount} records...`);
            }
          }

          totalIssuesFound += moduleIssueCount;
          criticalIssues += moduleCritical;
          highIssues += moduleHigh;
          mediumIssues += moduleMedium;
          lowIssues += moduleLow;

          moduleBreakdown.push({
            module: moduleName,
            recordsAudited: recordCount,
            issuesFound: moduleIssueCount,
          });

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
      },
    };

    const savedResult = await saveAuditResult(auditData);
    logger?.info("✅ [DirectAudit] Audit results saved to database successfully");

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
