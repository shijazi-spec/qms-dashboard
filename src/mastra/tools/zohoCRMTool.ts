import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  fetchZohoRecords,
  fetchAllZohoRecords,
  searchZohoRecords,
  analyzeRecordHygiene,
  calculateQualityScores,
  DEFAULT_GOVERNANCE_RULES,
  HygieneIssue,
  ZohoCRMRecord,
  GovernanceRule,
} from "../../utils/zohoCRM";
import { getGovernanceDocumentByModule } from "../../utils/database";

export const auditCRMHygieneTool = createTool({
  id: "audit-crm-hygiene",

  description:
    "Performs a comprehensive data hygiene audit on Zoho CRM records. Checks for missing fields, invalid formats, and governance violations across Leads, Deals, Contacts, and Tasks modules.",

  inputSchema: z.object({
    modules: z.array(z.enum(["Leads", "Deals", "Contacts", "Tasks", "Accounts"]))
      .optional()
      .describe("CRM modules to audit (defaults to all main modules)"),
    pageSize: z.number().optional().describe("Number of records to fetch per module (default: 100)"),
    customRules: z.array(z.object({
      module: z.string(),
      fieldName: z.string(),
      ruleType: z.enum(["required", "format", "enum"]),
      description: z.string().optional(),
      severity: z.enum(["critical", "high", "medium", "low"]).optional(),
      pattern: z.string().optional(),
      allowedValues: z.array(z.string()).optional(),
    })).optional().describe("Custom governance rules to apply"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    auditSummary: z.object({
      totalRecordsAudited: z.number(),
      totalIssuesFound: z.number(),
      criticalIssues: z.number(),
      highIssues: z.number(),
      mediumIssues: z.number(),
      lowIssues: z.number(),
    }),
    qualityScores: z.object({
      peopleScore: z.number(),
      processScore: z.number(),
      governanceScore: z.number(),
      overallScore: z.number(),
    }),
    moduleBreakdown: z.array(z.object({
      module: z.string(),
      recordsAudited: z.number(),
      recordsWithIssues: z.number().optional(),
      issuesFound: z.number(),
      topIssues: z.array(z.object({
        issueType: z.string(),
        count: z.number(),
        severity: z.string(),
      })),
    })),
    allIssues: z.array(z.object({
      recordId: z.string(),
      module: z.string(),
      issueType: z.string(),
      fieldName: z.string().optional(),
      description: z.string(),
      severity: z.string(),
      suggestedFix: z.string().optional(),
    })),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔍 [auditCRMHygieneTool] Starting CRM data hygiene audit...", {
      modules: context.modules,
      pageSize: context.pageSize,
    });

    const modules = context.modules || ["Leads", "Deals"];
    const pageSize = context.pageSize || 100;
    
    const baseCustomRules = (context.customRules || []).map(rule => ({
      ...rule,
      validator: undefined,
      suggestedFix: undefined,
    }));

    const allIssues: HygieneIssue[] = [];
    const moduleBreakdown: Array<{
      module: string;
      recordsAudited: number;
      recordsWithIssues: number;
      issuesFound: number;
      topIssues: Array<{ issueType: string; count: number; severity: string }>;
    }> = [];

    let totalRecordsAudited = 0;

    try {
      for (const moduleName of modules) {
        logger?.info(`📊 [auditCRMHygieneTool] Auditing ${moduleName}...`);
        
        const moduleGovDoc = await getGovernanceDocumentByModule(moduleName);
        let moduleRules: GovernanceRule[] = [...DEFAULT_GOVERNANCE_RULES, ...baseCustomRules];
        
        if (moduleGovDoc?.rules_json) {
          logger?.info(`📋 [auditCRMHygieneTool] Using module-specific governance document: "${moduleGovDoc.name}" for ${moduleName}`);
          try {
            const docRules = typeof moduleGovDoc.rules_json === 'string' 
              ? JSON.parse(moduleGovDoc.rules_json) 
              : moduleGovDoc.rules_json;
            if (Array.isArray(docRules)) {
              moduleRules = [...docRules, ...baseCustomRules];
            } else if (docRules.rules && Array.isArray(docRules.rules)) {
              moduleRules = [...docRules.rules, ...baseCustomRules];
            }
          } catch (e) {
            logger?.warn(`⚠️ [auditCRMHygieneTool] Could not parse governance rules for ${moduleName}, using defaults`);
          }
        } else {
          logger?.info(`📋 [auditCRMHygieneTool] No module-specific governance document for ${moduleName}, using default rules`);
        }
        
        let records: ZohoCRMRecord[] = [];
        
        try {
          records = await fetchAllZohoRecords(moduleName, { maxRecords: 50000 });
          logger?.info(`📊 [auditCRMHygieneTool] Fetched ${records.length} ${moduleName} records`);
        } catch (error) {
          logger?.warn(`⚠️ [auditCRMHygieneTool] Could not fetch ${moduleName}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }

        totalRecordsAudited += records.length;

        const moduleIssues: HygieneIssue[] = [];
        let recordsWithIssues = 0;
        
        for (const record of records) {
          const issues = analyzeRecordHygiene(record, moduleRules);
          if (issues.length > 0) recordsWithIssues++;
          moduleIssues.push(...issues);
        }

        allIssues.push(...moduleIssues);

        const issueTypeCounts: Record<string, { count: number; severity: string }> = {};
        for (const issue of moduleIssues) {
          if (!issueTypeCounts[issue.issueType]) {
            issueTypeCounts[issue.issueType] = { count: 0, severity: issue.severity };
          }
          issueTypeCounts[issue.issueType].count++;
        }

        const topIssues = Object.entries(issueTypeCounts)
          .map(([issueType, data]) => ({ issueType, ...data }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 5);

        moduleBreakdown.push({
          module: moduleName,
          recordsAudited: records.length,
          recordsWithIssues,
          issuesFound: moduleIssues.length,
          topIssues,
        });

        logger?.info(`✅ [auditCRMHygieneTool] Completed ${moduleName} audit: ${moduleIssues.length} issues found`);
      }

      const qualityScores = calculateQualityScores(allIssues, totalRecordsAudited);

      const criticalIssues = allIssues.filter(i => i.severity === 'critical').length;
      const highIssues = allIssues.filter(i => i.severity === 'high').length;
      const mediumIssues = allIssues.filter(i => i.severity === 'medium').length;
      const lowIssues = allIssues.filter(i => i.severity === 'low').length;

      logger?.info("✅ [auditCRMHygieneTool] CRM hygiene audit completed", {
        totalRecords: totalRecordsAudited,
        totalIssues: allIssues.length,
        qualityScores,
      });

      return {
        success: true,
        auditSummary: {
          totalRecordsAudited,
          totalIssuesFound: allIssues.length,
          criticalIssues,
          highIssues,
          mediumIssues,
          lowIssues,
        },
        qualityScores,
        moduleBreakdown,
        allIssues: allIssues.map(issue => ({
          recordId: issue.recordId,
          module: issue.module,
          issueType: issue.issueType,
          fieldName: issue.fieldName,
          description: issue.description,
          severity: issue.severity,
          suggestedFix: issue.suggestedFix,
        })),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [auditCRMHygieneTool] CRM audit failed", { error: errorMessage });

      return {
        success: false,
        auditSummary: {
          totalRecordsAudited: 0,
          totalIssuesFound: 0,
          criticalIssues: 0,
          highIssues: 0,
          mediumIssues: 0,
          lowIssues: 0,
        },
        qualityScores: {
          peopleScore: 0,
          processScore: 0,
          governanceScore: 0,
          overallScore: 0,
        },
        moduleBreakdown: [],
        allIssues: [],
        error: errorMessage,
      };
    }
  },
});

export const checkCRMActivityTool = createTool({
  id: "check-crm-activity",

  description:
    "Checks CRM records for activity compliance. Verifies that leads and deals have recent activities, follow-ups are scheduled, and notes are complete.",

  inputSchema: z.object({
    module: z.enum(["Leads", "Deals"]).describe("CRM module to check for activity"),
    inactivityThresholdDays: z.number().optional().describe("Days without activity to flag (default: 4)"),
    requireFollowUp: z.boolean().optional().describe("Check if follow-up tasks exist (default: true)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    activitySummary: z.object({
      totalRecords: z.number(),
      recordsWithRecentActivity: z.number(),
      recordsWithoutActivity: z.number(),
      recordsWithFollowUp: z.number(),
      recordsWithoutFollowUp: z.number(),
    }),
    inactiveRecords: z.array(z.object({
      id: z.string(),
      name: z.string(),
      lastActivityDate: z.string().optional(),
      daysSinceActivity: z.number().optional(),
      owner: z.string().optional(),
    })),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📊 [checkCRMActivityTool] Checking CRM activity compliance...", {
      module: context.module,
      inactivityThresholdDays: context.inactivityThresholdDays,
    });

    const thresholdDays = context.inactivityThresholdDays || 4;
    const checkFollowUp = context.requireFollowUp !== false;
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - thresholdDays);

    try {
      const records = await fetchZohoRecords(context.module, { perPage: 200 });
      
      logger?.info(`📊 [checkCRMActivityTool] Analyzing ${records.length} ${context.module} records`);

      const inactiveRecords: Array<{
        id: string;
        name: string;
        lastActivityDate?: string;
        daysSinceActivity?: number;
        owner?: string;
      }> = [];

      let recordsWithRecentActivity = 0;
      let recordsWithFollowUp = 0;

      for (const record of records) {
        const lastActivityDate = record.data.Last_Activity_Time || record.modifiedTime;
        const recordName = record.data.Full_Name || record.data.Deal_Name || record.data.Last_Name || record.id;
        
        let hasRecentActivity = false;
        let daysSinceActivity: number | undefined;

        if (lastActivityDate) {
          const activityDate = new Date(lastActivityDate);
          daysSinceActivity = Math.floor((Date.now() - activityDate.getTime()) / (1000 * 60 * 60 * 24));
          hasRecentActivity = activityDate >= thresholdDate;
        }

        if (hasRecentActivity) {
          recordsWithRecentActivity++;
        } else {
          inactiveRecords.push({
            id: record.id,
            name: recordName,
            lastActivityDate,
            daysSinceActivity,
            owner: record.owner,
          });
        }

        if (checkFollowUp && record.data.Next_Activity_Date) {
          recordsWithFollowUp++;
        }
      }

      logger?.info("✅ [checkCRMActivityTool] Activity check completed", {
        totalRecords: records.length,
        inactiveRecords: inactiveRecords.length,
      });

      return {
        success: true,
        activitySummary: {
          totalRecords: records.length,
          recordsWithRecentActivity,
          recordsWithoutActivity: inactiveRecords.length,
          recordsWithFollowUp,
          recordsWithoutFollowUp: checkFollowUp ? records.length - recordsWithFollowUp : 0,
        },
        inactiveRecords: inactiveRecords.slice(0, 50),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [checkCRMActivityTool] Activity check failed", { error: errorMessage });

      return {
        success: false,
        activitySummary: {
          totalRecords: 0,
          recordsWithRecentActivity: 0,
          recordsWithoutActivity: 0,
          recordsWithFollowUp: 0,
          recordsWithoutFollowUp: 0,
        },
        inactiveRecords: [],
        error: errorMessage,
      };
    }
  },
});
