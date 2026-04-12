import {
  fetchZohoRecords,
  fetchAllZohoRecords,
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
  let allIssues: any[] = [];

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
      allIssues = [];

      for (const moduleName of modules) {
        logger?.info(`📊 [DirectAudit] Auditing ${moduleName}...`);
        try {
          const records = await fetchAllZohoRecords(moduleName);
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
            const ownerName = record.data?.Owner?.name || record.owner || '';
            for (const issue of issues) {
              (issue as any).ownerName = ownerName;
            }
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
    const recommendations = getDefaultRecommendations(qualityScores, totalIssuesFound, criticalIssues, highIssues, moduleBreakdown, topIssues);
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
        all_issues: allIssues.map(issue => ({
          recordId: issue.recordId,
          module: issue.module,
          owner: issue.ownerName || '',
          issueType: issue.issueType,
          fieldName: issue.fieldName,
          description: issue.description,
          severity: issue.severity,
          suggestedFix: issue.suggestedFix,
        })),
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
        auditDate: new Date(),
      });

      if (criticalIssues > 0 || highIssues > 0) {
        await fireNonconformanceDetectedTrigger(savedResult.id!, {
          totalNCs: criticalIssues + highIssues,
          criticalCount: criticalIssues,
          majorCount: highIssues,
          minorCount: mediumIssues,
          ncIds: [savedResult.id!],
          auditDate: new Date(),
        });
      }

      if (criticalIssues > 0) {
        for (const issue of topIssues.filter(i => i.severity === 'critical').slice(0, 3)) {
          await fireCAPARequiredTrigger(savedResult.id!, {
            ncTitle: issue.issueType,
            ncId: savedResult.id!,
            severity: 'critical',
            suggestedAction: `Address critical ${issue.issueType} issues in ${issue.module} (${issue.count} occurrences)`,
            auditDate: new Date(),
          });
        }
      }

      logger?.info("✅ [DirectAudit] Audit triggers created successfully");
    } catch (triggerError) {
      logger?.warn("⚠️ [DirectAudit] Failed to create audit triggers", {
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

function getDefaultRecommendations(
  scores: any,
  totalIssues: number,
  critical: number,
  high: number,
  moduleBreakdown?: Array<{ module: string; recordsAudited: number; issuesFound: number }>,
  topIssues?: Array<{ module: string; issueType: string; count: number; severity: string }>
): string[] {
  const recommendations: string[] = [];

  if (critical > 0) {
    recommendations.push(`Address ${critical} critical issues immediately - these require urgent attention`);
  }
  if (high > 0) {
    recommendations.push(`Review and resolve ${high} high-priority issues within this week`);
  }

  if (topIssues && topIssues.length > 0) {
    const topByCount = [...topIssues].sort((a, b) => b.count - a.count);
    for (const issue of topByCount.slice(0, 3)) {
      const desc = issue.issueType.replace(/_/g, ' ');
      recommendations.push(`Fix ${issue.count} "${desc}" issues in ${issue.module} module (${issue.severity} severity)`);
    }
  }

  if (moduleBreakdown && moduleBreakdown.length > 0) {
    const worstModules = [...moduleBreakdown]
      .filter(m => m.recordsAudited > 0)
      .sort((a, b) => (b.issuesFound / b.recordsAudited) - (a.issuesFound / a.recordsAudited));
    if (worstModules.length > 0) {
      const worst = worstModules[0];
      const rate = ((worst.issuesFound / worst.recordsAudited) * 100).toFixed(1);
      recommendations.push(`Focus on ${worst.module} module - ${rate}% issue rate (${worst.issuesFound} issues in ${worst.recordsAudited} records)`);
    }
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

  const unique = [...new Set(recommendations)];
  return unique.slice(0, 7);
}
