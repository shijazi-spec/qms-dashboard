import { createStep, createWorkflow } from "../inngest";
import { z } from "zod";
import { qualitySpecialistAgent } from "../agents/qualitySpecialistAgent";
import { sdrQualityAgent } from "../agents/sdrQualityAgent";
import { salesQualityAgent } from "../agents/salesQualityAgent";
import { fetchCalendarEvents } from "../../utils/googleCalendar";
import { sendEmail } from "../../utils/replitmail";
import { sendResendEmail, QUALITY_REPORT_RECIPIENTS } from "../../utils/resendMail";
import {
  fetchZohoRecords,
  fetchAllZohoRecords,
  analyzeRecordHygiene,
  calculateQualityScores,
  DEFAULT_GOVERNANCE_RULES,
} from "../../utils/zohoCRM";
import { saveAuditResult, getActiveGovernanceDocument, getActiveScorecard, getGovernanceDocumentByModule, getScorecardsByModuleAndTeam, getScorecardAttributes } from "../../utils/database";
import { fireAuditCompletedTrigger, fireNonconformanceDetectedTrigger, fireCAPARequiredTrigger, initAuditTriggerTables } from "../../utils/auditTriggerDatabase";

const validateEnvironmentStep = createStep({
  id: "validate-environment",
  description: "Validates that all required environment variables are configured before proceeding",

  inputSchema: z.object({}),

  outputSchema: z.object({
    valid: z.boolean(),
    missingVariables: z.array(z.string()),
    warnings: z.array(z.string()),
  }),

  execute: async ({ mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔍 [Step 0] Validating environment configuration...");

    const missingVariables: string[] = [];
    const warnings: string[] = [];

    const hasZohoCredentials = !!(
      process.env.ZOHO_ACCESS_TOKEN ||
      (process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN)
    );
    if (!hasZohoCredentials) {
      warnings.push("CRM integration not configured - CRM audit will be skipped");
    }

    if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY && !process.env.OPENAI_API_KEY) {
      warnings.push("OpenAI API key is not configured - AI insights will use fallback recommendations");
    }

    if (warnings.length > 0) {
      logger?.warn("⚠️ [Step 0] Configuration warnings detected", { warnings });
    } else {
      logger?.info("✅ [Step 0] All environment variables configured");
    }

    return {
      valid: missingVariables.length === 0,
      missingVariables,
      warnings,
    };
  },
});

const fetchCalendarEventsStep = createStep({
  id: "fetch-calendar-events",
  description: "Fetches calendar events from Google Calendar for the audit period",

  inputSchema: z.object({
    valid: z.boolean(),
    missingVariables: z.array(z.string()),
    warnings: z.array(z.string()),
  }),

  outputSchema: z.object({
    environmentWarnings: z.array(z.string()),
    calendarSuccess: z.boolean(),
    events: z.array(z.object({
      id: z.string(),
      summary: z.string(),
      start: z.string(),
      end: z.string(),
      attendees: z.array(z.string()),
      status: z.string(),
    })),
    totalEvents: z.number(),
    dateRange: z.object({
      start: z.string(),
      end: z.string(),
    }),
    calendarError: z.string().optional(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📅 [Step 1] Fetching calendar events for audit...");

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    try {
      logger?.info("📅 [Step 1] Fetching events from Google Calendar API...", {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      });

      const events = await fetchCalendarEvents(startDate, endDate);

      logger?.info(`✅ [Step 1] Successfully fetched ${events.length} calendar events`);

      return {
        environmentWarnings: inputData.warnings,
        calendarSuccess: true,
        events: events.map(e => ({
          id: e.id,
          summary: e.summary,
          start: e.start,
          end: e.end,
          attendees: e.attendees,
          status: e.status,
        })),
        totalEvents: events.length,
        dateRange: {
          start: startDate.toISOString().split('T')[0],
          end: endDate.toISOString().split('T')[0],
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.warn(`⚠️ [Step 1] Could not fetch calendar events: ${errorMessage}`);

      return {
        environmentWarnings: inputData.warnings,
        calendarSuccess: false,
        events: [],
        totalEvents: 0,
        dateRange: {
          start: startDate.toISOString().split('T')[0],
          end: endDate.toISOString().split('T')[0],
        },
        calendarError: errorMessage,
      };
    }
  },
});

const auditCRMWithAgentStep = createStep({
  id: "audit-crm-with-agent",
  description: "Uses the Quality Specialist AI agent with the CRM audit tool to perform comprehensive hygiene checks",

  inputSchema: z.object({
    environmentWarnings: z.array(z.string()),
    calendarSuccess: z.boolean(),
    events: z.array(z.any()),
    totalEvents: z.number(),
    dateRange: z.object({
      start: z.string(),
      end: z.string(),
    }),
    calendarError: z.string().optional(),
  }),

  outputSchema: z.object({
    calendarData: z.object({
      success: z.boolean(),
      totalEvents: z.number(),
      dateRange: z.object({
        start: z.string(),
        end: z.string(),
      }),
    }),
    crmAudit: z.object({
      success: z.boolean(),
      totalRecordsAudited: z.number(),
      totalIssuesFound: z.number(),
      criticalIssues: z.number(),
      highIssues: z.number(),
      mediumIssues: z.number(),
      lowIssues: z.number(),
      moduleBreakdown: z.array(z.object({
        module: z.string(),
        recordsAudited: z.number(),
        issuesFound: z.number(),
      })),
      topIssues: z.array(z.object({
        module: z.string(),
        issueType: z.string(),
        count: z.number(),
        severity: z.string(),
      })),
      skipped: z.boolean().optional(),
      skipReason: z.string().optional(),
      detailedIssues: z.array(z.object({
        recordId: z.string(),
        module: z.string(),
        owner: z.string(),
        fieldName: z.string(),
        issueType: z.string(),
        description: z.string(),
        severity: z.string(),
        suggestedFix: z.string(),
      })).optional(),
    }),
    qualityScores: z.object({
      peopleScore: z.number(),
      processScore: z.number(),
      governanceScore: z.number(),
      overallScore: z.number(),
    }),
    environmentWarnings: z.array(z.string()),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔍 [Step 2] Starting CRM data hygiene audit...");

    const calendarData = {
      success: inputData.calendarSuccess,
      totalEvents: inputData.totalEvents,
      dateRange: inputData.dateRange,
    };

    const hasZohoCredentials = !!(
      process.env.ZOHO_ACCESS_TOKEN ||
      (process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN)
    );
    const hasOpenAIKey = !!(process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY);

    if (!hasZohoCredentials) {
      logger?.warn("⚠️ [Step 2] Zoho CRM credentials not configured - skipping CRM audit");
      
      return {
        calendarData,
        crmAudit: {
          success: false,
          totalRecordsAudited: 0,
          totalIssuesFound: 0,
          criticalIssues: 0,
          highIssues: 0,
          mediumIssues: 0,
          lowIssues: 0,
          moduleBreakdown: [],
          topIssues: [],
          skipped: true,
          skipReason: "CRM integration not configured.",
        },
        qualityScores: {
          peopleScore: 0,
          processScore: 0,
          governanceScore: 0,
          overallScore: 0,
        },
        environmentWarnings: inputData.environmentWarnings,
      };
    }

    if (!hasOpenAIKey) {
      logger?.info("📊 [Step 2] OpenAI API key not configured - performing direct CRM audit without AI agent...");
      
      try {
        const modules = ["Leads", "Deals", "Contacts", "Tasks", "Accounts"];
        const allIssues: any[] = [];
        const moduleBreakdown: Array<{ module: string; recordsAudited: number; issuesFound: number }> = [];
        let totalRecordsAudited = 0;

        for (const moduleName of modules) {
          logger?.info(`📊 [Step 2] Auditing ${moduleName} (all records)...`);
          try {
            const records = await fetchAllZohoRecords(moduleName, { maxRecords: 50000 });
            totalRecordsAudited += records.length;
            
            const moduleGovDoc = await getGovernanceDocumentByModule(moduleName);
            let governanceRules = DEFAULT_GOVERNANCE_RULES;
            
            if (moduleGovDoc?.rules_json) {
              logger?.info(`📋 [Step 2] Using module-specific governance document: "${moduleGovDoc.name}" for ${moduleName}`);
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
                logger?.warn(`⚠️ [Step 2] Could not parse governance rules for ${moduleName}, using defaults`);
              }
            } else {
              logger?.info(`📋 [Step 2] No module-specific governance document for ${moduleName}, using default rules`);
            }
            
            const moduleIssues: any[] = [];
            for (const record of records) {
              const issues = analyzeRecordHygiene(record, governanceRules);
              const ownerData = record.data?.Owner;
              const ownerName = record.owner || (ownerData ? (ownerData.name || ownerData.id || '-') : '-');
              for (const issue of issues) {
                (issue as any).owner = ownerName;
              }
              moduleIssues.push(...issues);
            }
            allIssues.push(...moduleIssues);
            
            moduleBreakdown.push({
              module: moduleName,
              recordsAudited: records.length,
              issuesFound: moduleIssues.length,
            });
            
            logger?.info(`✅ [Step 2] Completed ${moduleName} audit: ${moduleIssues.length} issues found`);
          } catch (error) {
            logger?.warn(`⚠️ [Step 2] Could not fetch ${moduleName}: ${error instanceof Error ? error.message : String(error)}`);
            moduleBreakdown.push({ module: moduleName, recordsAudited: 0, issuesFound: 0 });
          }
        }

        const qualityScores = calculateQualityScores(allIssues, totalRecordsAudited);
        
        const issueTypeCounts: Record<string, { count: number; severity: string; module: string }> = {};
        for (const issue of allIssues) {
          const key = `${issue.module}-${issue.issueType}`;
          if (!issueTypeCounts[key]) {
            issueTypeCounts[key] = { count: 0, severity: issue.severity, module: issue.module };
          }
          issueTypeCounts[key].count++;
        }

        const topIssues = Object.entries(issueTypeCounts)
          .map(([key, data]) => ({
            module: data.module,
            issueType: key.split('-').slice(1).join('-'),
            count: data.count,
            severity: data.severity,
          }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);

        const criticalIssues = allIssues.filter((i: any) => i.severity === 'critical').length;
        const highIssues = allIssues.filter((i: any) => i.severity === 'high').length;
        const mediumIssues = allIssues.filter((i: any) => i.severity === 'medium').length;
        const lowIssues = allIssues.filter((i: any) => i.severity === 'low').length;

        const detailedIssues = allIssues.slice(0, 500).map((issue: any) => ({
          recordId: issue.recordId,
          module: issue.module,
          owner: issue.owner || '-',
          fieldName: issue.fieldName || '',
          issueType: issue.issueType,
          description: issue.description,
          severity: issue.severity,
          suggestedFix: issue.suggestedFix || `Update the ${issue.fieldName || 'field'} in this record`,
        }));

        logger?.info("✅ [Step 2] Direct CRM audit completed", { totalRecords: totalRecordsAudited, totalIssues: allIssues.length });

        return {
          calendarData,
          crmAudit: {
            success: true,
            totalRecordsAudited,
            totalIssuesFound: allIssues.length,
            criticalIssues,
            highIssues,
            mediumIssues,
            lowIssues,
            moduleBreakdown,
            topIssues,
            detailedIssues,
          },
          qualityScores,
          environmentWarnings: inputData.environmentWarnings,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger?.error("❌ [Step 2] Direct CRM audit failed", { error: errorMessage });
        
        return {
          calendarData,
          crmAudit: {
            success: false,
            totalRecordsAudited: 0,
            totalIssuesFound: 0,
            criticalIssues: 0,
            highIssues: 0,
            mediumIssues: 0,
            lowIssues: 0,
            moduleBreakdown: [],
            topIssues: [],
            skipped: true,
            skipReason: errorMessage,
          },
          qualityScores: {
            peopleScore: 0,
            processScore: 0,
            governanceScore: 0,
            overallScore: 0,
          },
          environmentWarnings: inputData.environmentWarnings,
        };
      }
    }

    try {
      logger?.info("🤖 [Step 2] Running department-specific audits in parallel...");
      
      const formatAttributesForPrompt = (attributes: any[]) => {
        if (!attributes || attributes.length === 0) return "No specific attributes configured.";
        
        const activeAttrs = attributes.filter(a => a.is_active !== false);
        if (activeAttrs.length === 0) return "No active attributes to evaluate.";
        
        return activeAttrs.map(attr => {
          let attrText = `- **${attr.attribute_name}** (${attr.dimension}, Weight: ${attr.weight}%, Severity: ${attr.severity || 'Minor'})`;
          if (attr.description) attrText += `\n  Description: ${attr.description}`;
          if (attr.evaluation_logic) attrText += `\n  Evaluation Logic: ${attr.evaluation_logic}`;
          if (attr.evidence_fields) attrText += `\n  Evidence Fields: ${attr.evidence_fields}`;
          return attrText;
        }).join('\n');
      };

      let sdrScorecardInfo = "";
      let salesScorecardInfo = "";

      try {
        const sdrScorecards = await getScorecardsByModuleAndTeam('Leads', 'SDR');
        const activeSDRScorecard = sdrScorecards.find(s => s.is_active);
        if (activeSDRScorecard?.id) {
          const sdrAttrs = await getScorecardAttributes(activeSDRScorecard.id);
          logger?.info(`📋 [Step 2] Using SDR scorecard: "${activeSDRScorecard.name}" with ${sdrAttrs.length} attributes`);
          sdrScorecardInfo = `
## Active Scorecard: ${activeSDRScorecard.name} (${activeSDRScorecard.version || 'v1.0'})

### Quality Attributes to Evaluate:
${formatAttributesForPrompt(sdrAttrs)}

For each attribute, evaluate whether the CRM record complies based on the evaluation logic and evidence fields specified.
`;
        }
      } catch (err) {
        logger?.warn("⚠️ [Step 2] Could not load SDR scorecard attributes", { error: err });
      }

      try {
        const salesScorecards = await getScorecardsByModuleAndTeam('Deals', 'Sales');
        const activeSalesScorecard = salesScorecards.find(s => s.is_active);
        if (activeSalesScorecard?.id) {
          const salesAttrs = await getScorecardAttributes(activeSalesScorecard.id);
          logger?.info(`📋 [Step 2] Using Sales scorecard: "${activeSalesScorecard.name}" with ${salesAttrs.length} attributes`);
          salesScorecardInfo = `
## Active Scorecard: ${activeSalesScorecard.name} (${activeSalesScorecard.version || 'v1.0'})

### Quality Attributes to Evaluate:
${formatAttributesForPrompt(salesAttrs)}

For each attribute, evaluate whether the CRM record complies based on the evaluation logic and evidence fields specified.
`;
        }
      } catch (err) {
        logger?.warn("⚠️ [Step 2] Could not load Sales scorecard attributes", { error: err });
      }

      const sdrAuditPrompt = `
You are performing a quality audit for the SDR team on LEADS data.
${sdrScorecardInfo}

Please use the auditCRMHygieneTool to audit ONLY the Leads module.

After getting the audit results, provide a summary of:
1. Total leads audited
2. Total issues found by severity (critical, high, medium, low)
3. Top SDR-related issues that need attention
4. Quality scores (People, Process, Governance, Overall) for SDR team

Execute the audit now and report the findings.
`;

      const salesAuditPrompt = `
You are performing a quality audit for the Sales team on DEALS data.
${salesScorecardInfo}

Please use the auditCRMHygieneTool to audit ONLY the Deals module.

After getting the audit results, provide a summary of:
1. Total deals audited
2. Total issues found by severity (critical, high, medium, low)
3. Top Sales-related issues that need attention
4. Quality scores (People, Process, Governance, Overall) for Sales team

Execute the audit now and report the findings.
`;

      const [sdrResponse, salesResponse] = await Promise.all([
        sdrQualityAgent.generateLegacy(
          [{ role: "user", content: sdrAuditPrompt }],
          { maxSteps: 5 }
        ).catch(err => {
          logger?.warn("⚠️ [Step 2] SDR audit failed", { error: err.message });
          return null;
        }),
        salesQualityAgent.generateLegacy(
          [{ role: "user", content: salesAuditPrompt }],
          { maxSteps: 5 }
        ).catch(err => {
          logger?.warn("⚠️ [Step 2] Sales audit failed", { error: err.message });
          return null;
        })
      ]);

      logger?.info("✅ [Step 2] Department agents completed audits", {
        sdrCompleted: !!sdrResponse,
        salesCompleted: !!salesResponse
      });

      const extractAuditResult = (response: any) => {
        if (!response) return null;
        const toolResults = response.steps?.flatMap((s: any) => s.toolResults || []) || [];
        return toolResults.find((r: any) => 
          r.toolName === 'auditCRMHygieneTool' || 
          r.toolName === 'audit-crm-hygiene' ||
          r.toolName?.includes('audit') ||
          r.toolName?.includes('crm')
        )?.result || null;
      };

      const sdrResult = extractAuditResult(sdrResponse);
      const salesResult = extractAuditResult(salesResponse);

      const combinedModuleBreakdown = [
        ...(sdrResult?.moduleBreakdown || []),
        ...(salesResult?.moduleBreakdown || [])
      ];

      const totalRecordsAudited = 
        (sdrResult?.auditSummary?.totalRecordsAudited || 0) + 
        (salesResult?.auditSummary?.totalRecordsAudited || 0);
      
      const totalIssuesFound = 
        (sdrResult?.auditSummary?.totalIssuesFound || 0) + 
        (salesResult?.auditSummary?.totalIssuesFound || 0);

      const criticalIssues = 
        (sdrResult?.auditSummary?.criticalIssues || 0) + 
        (salesResult?.auditSummary?.criticalIssues || 0);
      
      const highIssues = 
        (sdrResult?.auditSummary?.highIssues || 0) + 
        (salesResult?.auditSummary?.highIssues || 0);
      
      const mediumIssues = 
        (sdrResult?.auditSummary?.mediumIssues || 0) + 
        (salesResult?.auditSummary?.mediumIssues || 0);
      
      const lowIssues = 
        (sdrResult?.auditSummary?.lowIssues || 0) + 
        (salesResult?.auditSummary?.lowIssues || 0);

      const avgScore = (s1: any, s2: any, key: string) => {
        const v1 = s1?.qualityScores?.[key] || 0;
        const v2 = s2?.qualityScores?.[key] || 0;
        const count = (s1 ? 1 : 0) + (s2 ? 1 : 0);
        return count > 0 ? Math.round((v1 + v2) / count) : 0;
      };

      const combinedScores = {
        peopleScore: avgScore(sdrResult, salesResult, 'peopleScore'),
        processScore: avgScore(sdrResult, salesResult, 'processScore'),
        governanceScore: avgScore(sdrResult, salesResult, 'governanceScore'),
        overallScore: avgScore(sdrResult, salesResult, 'overallScore'),
      };

      if (sdrResult || salesResult) {
        return {
          calendarData,
          crmAudit: {
            success: true,
            totalRecordsAudited,
            totalIssuesFound,
            criticalIssues,
            highIssues,
            mediumIssues,
            lowIssues,
            moduleBreakdown: combinedModuleBreakdown,
            topIssues: combinedModuleBreakdown.flatMap((m: any) => m.topIssues || []),
            sdrAudit: sdrResult,
            salesAudit: salesResult,
          },
          qualityScores: combinedScores,
          environmentWarnings: inputData.environmentWarnings,
        };
      }

      logger?.warn("⚠️ [Step 2] Could not extract structured audit results from department agents");
      return {
        calendarData,
        crmAudit: {
          success: false,
          totalRecordsAudited: 0,
          totalIssuesFound: 0,
          criticalIssues: 0,
          highIssues: 0,
          mediumIssues: 0,
          lowIssues: 0,
          moduleBreakdown: [],
          topIssues: [],
          skipped: true,
          skipReason: "Could not extract audit results from department agents",
        },
        qualityScores: {
          peopleScore: 0,
          processScore: 0,
          governanceScore: 0,
          overallScore: 0,
        },
        environmentWarnings: inputData.environmentWarnings,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [Step 2] CRM audit failed", { error: errorMessage });

      return {
        calendarData,
        crmAudit: {
          success: false,
          totalRecordsAudited: 0,
          totalIssuesFound: 0,
          criticalIssues: 0,
          highIssues: 0,
          mediumIssues: 0,
          lowIssues: 0,
          moduleBreakdown: [],
          topIssues: [],
          skipped: true,
          skipReason: errorMessage,
        },
        qualityScores: {
          peopleScore: 0,
          processScore: 0,
          governanceScore: 0,
          overallScore: 0,
        },
        environmentWarnings: inputData.environmentWarnings,
      };
    }
  },
});

const generateInsightsStep = createStep({
  id: "generate-insights",
  description: "Uses AI to analyze audit results and generate actionable recommendations",

  inputSchema: z.object({
    calendarData: z.object({
      success: z.boolean(),
      totalEvents: z.number(),
      dateRange: z.object({
        start: z.string(),
        end: z.string(),
      }),
    }),
    crmAudit: z.object({
      success: z.boolean(),
      totalRecordsAudited: z.number(),
      totalIssuesFound: z.number(),
      criticalIssues: z.number(),
      highIssues: z.number(),
      mediumIssues: z.number(),
      lowIssues: z.number(),
      moduleBreakdown: z.array(z.any()),
      topIssues: z.array(z.any()),
      skipped: z.boolean().optional(),
      skipReason: z.string().optional(),
      detailedIssues: z.array(z.any()).optional(),
    }),
    qualityScores: z.object({
      peopleScore: z.number(),
      processScore: z.number(),
      governanceScore: z.number(),
      overallScore: z.number(),
    }),
    environmentWarnings: z.array(z.string()),
  }),

  outputSchema: z.object({
    calendarData: z.object({
      success: z.boolean(),
      totalEvents: z.number(),
      dateRange: z.object({
        start: z.string(),
        end: z.string(),
      }),
    }),
    crmAudit: z.object({
      success: z.boolean(),
      totalRecordsAudited: z.number(),
      totalIssuesFound: z.number(),
      criticalIssues: z.number(),
      highIssues: z.number(),
      mediumIssues: z.number(),
      lowIssues: z.number(),
      moduleBreakdown: z.array(z.any()),
      topIssues: z.array(z.any()),
      skipped: z.boolean().optional(),
      skipReason: z.string().optional(),
      detailedIssues: z.array(z.any()).optional(),
    }),
    qualityScores: z.object({
      peopleScore: z.number(),
      processScore: z.number(),
      governanceScore: z.number(),
      overallScore: z.number(),
    }),
    recommendations: z.array(z.string()),
    insights: z.string(),
    environmentWarnings: z.array(z.string()),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🤖 [Step 3] Generating AI-powered insights...");

    const hasOpenAIKey = !!(process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY);

    if (inputData.crmAudit.skipped) {
      logger?.info("📝 [Step 3] CRM audit was skipped, generating configuration guidance...");
      
      const configInsights = `CRM audit was not performed because: ${inputData.crmAudit.skipReason}. Calendar data shows ${inputData.calendarData.totalEvents} events in the audit period.`;
      
      return {
        ...inputData,
        recommendations: [
          "Configure CRM integration credentials to enable full CRM auditing",
          "Once configured, the system will audit Leads, Deals, Contacts, and Tasks",
          "Review calendar activities to ensure meetings are being logged properly",
          "Set up regular quality audits to maintain data hygiene standards",
          "Consider implementing governance training for team members",
        ],
        insights: configInsights,
      };
    }

    if (!hasOpenAIKey) {
      logger?.info("📝 [Step 3] OpenAI API key not configured - using deterministic insights...");
      
      const { qualityScores, crmAudit, calendarData } = inputData;
      
      let insightText = `Quality audit completed. `;
      if (qualityScores.overallScore >= 90) {
        insightText += `Excellent overall score of ${qualityScores.overallScore}%. Data hygiene is in great shape with minimal issues detected.`;
      } else if (qualityScores.overallScore >= 70) {
        insightText += `Good overall score of ${qualityScores.overallScore}%. Some areas need attention, particularly ${crmAudit.criticalIssues + crmAudit.highIssues} high-priority issues.`;
      } else if (qualityScores.overallScore >= 50) {
        insightText += `Score of ${qualityScores.overallScore}% indicates significant improvement needed. Found ${crmAudit.totalIssuesFound} issues across ${crmAudit.totalRecordsAudited} records.`;
      } else {
        insightText += `Critical score of ${qualityScores.overallScore}%. Immediate action required with ${crmAudit.criticalIssues} critical and ${crmAudit.highIssues} high-priority issues.`;
      }
      
      return {
        ...inputData,
        recommendations: getDefaultRecommendations(inputData),
        insights: insightText,
      };
    }

    try {
      const auditSummary = `
## Quality Audit Data

### Quality Scores
- Overall Score: ${inputData.qualityScores.overallScore}%
- People Score: ${inputData.qualityScores.peopleScore}%
- Process Score: ${inputData.qualityScores.processScore}%
- Governance Score: ${inputData.qualityScores.governanceScore}%

### CRM Audit Summary
- Total Records Audited: ${inputData.crmAudit.totalRecordsAudited}
- Total Issues Found: ${inputData.crmAudit.totalIssuesFound}
- Critical Issues: ${inputData.crmAudit.criticalIssues}
- High Priority Issues: ${inputData.crmAudit.highIssues}
- Medium Priority Issues: ${inputData.crmAudit.mediumIssues}
- Low Priority Issues: ${inputData.crmAudit.lowIssues}

### Module Breakdown
${inputData.crmAudit.moduleBreakdown.map((m: any) => `- ${m.module}: ${m.recordsAudited} records, ${m.issuesFound} issues`).join('\n')}

### Top Issues
${inputData.crmAudit.topIssues.map((i: any) => `- ${i.module}: ${i.issueType} (${i.count} occurrences, ${i.severity} severity)`).join('\n')}

### Calendar Data
- Calendar events checked: ${inputData.calendarData.totalEvents}
- Date range: ${inputData.calendarData.dateRange.start} to ${inputData.calendarData.dateRange.end}
`;

      const prompt = `
Based on the following quality audit data for WalaPlus CRM and Calendar systems, provide:

1. A brief executive summary (2-3 sentences) of the overall data quality status
2. 5 specific, actionable recommendations to improve data hygiene and governance

${auditSummary}

Format your response as:
SUMMARY: [Your executive summary]

RECOMMENDATIONS:
1. [First recommendation]
2. [Second recommendation]
3. [Third recommendation]
4. [Fourth recommendation]
5. [Fifth recommendation]
`;

      const response = await qualitySpecialistAgent.generateLegacy([
        { role: "user", content: prompt }
      ]);

      const responseText = response.text || "";

      const summaryMatch = responseText.match(/SUMMARY:\s*(.+?)(?=RECOMMENDATIONS:|$)/s);
      const recsMatch = responseText.match(/RECOMMENDATIONS:\s*(.+)/s);

      const insights = summaryMatch ? summaryMatch[1].trim() : "Quality audit completed successfully.";

      let recommendations: string[] = [];
      if (recsMatch) {
        recommendations = recsMatch[1]
          .split(/\d+\.\s+/)
          .filter(r => r.trim())
          .map(r => r.trim())
          .slice(0, 5);
      }

      if (recommendations.length === 0) {
        recommendations = getDefaultRecommendations(inputData);
      }

      logger?.info("✅ [Step 3] AI insights generated", {
        recommendationsCount: recommendations.length,
      });

      return {
        ...inputData,
        recommendations,
        insights,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.warn(`⚠️ [Step 3] Could not generate AI insights: ${errorMessage}`);

      return {
        ...inputData,
        recommendations: getDefaultRecommendations(inputData),
        insights: `Quality audit completed with ${inputData.crmAudit.totalIssuesFound} issues found across ${inputData.crmAudit.totalRecordsAudited} records. Please review the detailed findings below.`,
      };
    }
  },
});

function getDefaultRecommendations(data: any): string[] {
  const recommendations: string[] = [];
  
  if (data.crmAudit.criticalIssues > 0) {
    recommendations.push(`Address ${data.crmAudit.criticalIssues} critical issues immediately - these require urgent attention`);
  }
  
  if (data.crmAudit.highIssues > 0) {
    recommendations.push(`Review and resolve ${data.crmAudit.highIssues} high-priority issues within this week`);
  }
  
  if (data.qualityScores.peopleScore < 80) {
    recommendations.push("Improve data entry discipline by providing team training on CRM best practices");
  }
  
  if (data.qualityScores.processScore < 80) {
    recommendations.push("Review and reinforce SOP compliance through regular team check-ins");
  }
  
  if (data.qualityScores.governanceScore < 80) {
    recommendations.push("Implement stricter governance controls and automated validation rules");
  }
  
  if (recommendations.length < 5) {
    recommendations.push("Set up automated follow-up reminders for inactive leads and deals");
    recommendations.push("Ensure all meetings are logged in CRM within 24 hours");
    recommendations.push("Implement regular data validation checks for email and phone formats");
    recommendations.push("Provide ongoing team training on data governance standards");
    recommendations.push("Review and complete all missing required fields in CRM records");
  }
  
  return recommendations.slice(0, 5);
}

const sendReportStep = createStep({
  id: "send-quality-report",
  description: "Sends the comprehensive quality audit report via email",

  inputSchema: z.object({
    calendarData: z.object({
      success: z.boolean(),
      totalEvents: z.number(),
      dateRange: z.object({
        start: z.string(),
        end: z.string(),
      }),
    }),
    crmAudit: z.object({
      success: z.boolean(),
      totalRecordsAudited: z.number(),
      totalIssuesFound: z.number(),
      criticalIssues: z.number(),
      highIssues: z.number(),
      mediumIssues: z.number(),
      lowIssues: z.number(),
      moduleBreakdown: z.array(z.any()),
      topIssues: z.array(z.any()),
      skipped: z.boolean().optional(),
      skipReason: z.string().optional(),
      detailedIssues: z.array(z.any()).optional(),
    }),
    qualityScores: z.object({
      peopleScore: z.number(),
      processScore: z.number(),
      governanceScore: z.number(),
      overallScore: z.number(),
    }),
    recommendations: z.array(z.string()),
    insights: z.string(),
    environmentWarnings: z.array(z.string()),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    reportSent: z.boolean(),
    messageId: z.string().optional(),
    summary: z.string(),
    error: z.string().optional(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📧 [Step 4] Preparing and sending quality report...");

    try {
      const { qualityScores, crmAudit, calendarData, recommendations, insights, environmentWarnings } = inputData;

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

      const reportDate = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });

      const isPartialAudit = crmAudit.skipped;
      const statusBanner = isPartialAudit 
        ? `<div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin-bottom: 20px; border-radius: 4px;">
            <strong>⚠️ Partial Audit</strong>
            <p style="margin: 5px 0 0;">${crmAudit.skipReason}</p>
           </div>`
        : '';

      const warningBanner = environmentWarnings.length > 0
        ? `<div style="background: #e0f2fe; border-left: 4px solid #0ea5e9; padding: 15px; margin-bottom: 20px; border-radius: 4px;">
            <strong>ℹ️ Configuration Notes</strong>
            <ul style="margin: 5px 0 0; padding-left: 20px;">
              ${environmentWarnings.map(w => `<li>${w}</li>`).join('')}
            </ul>
           </div>`
        : '';

      const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; text-align: center; margin-bottom: 30px; }
    .header h1 { margin: 0; font-size: 24px; }
    .header p { margin: 10px 0 0; opacity: 0.9; }
    .insights-box { background: #f0f7ff; border-left: 4px solid #667eea; padding: 20px; border-radius: 8px; margin-bottom: 25px; }
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
    .module-table { width: 100%; border-collapse: collapse; margin-top: 15px; }
    .module-table th, .module-table td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
    .module-table th { background: #f8f9fa; font-weight: bold; }
    .footer { text-align: center; color: #666; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🎯 WalaPlus Weekly Quality Report</h1>
    <p>${reportDate}</p>
  </div>

  ${statusBanner}
  ${warningBanner}

  <div class="insights-box">
    <strong>📊 Executive Summary</strong>
    <p>${insights}</p>
  </div>

  ${!isPartialAudit ? `
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
  </div>` : ''}

  <div class="summary-card">
    <h2>📊 Audit Summary</h2>
    ${!isPartialAudit ? `
    <div class="stat-row">
      <span class="stat-label">Total CRM Records Audited</span>
      <span class="stat-value">${crmAudit.totalRecordsAudited.toLocaleString()}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Total Issues Found</span>
      <span class="stat-value">${crmAudit.totalIssuesFound.toLocaleString()}</span>
    </div>` : `
    <div class="stat-row">
      <span class="stat-label">CRM Audit Status</span>
      <span class="stat-value">Skipped (credentials required)</span>
    </div>`}
    <div class="stat-row">
      <span class="stat-label">Calendar Events Checked</span>
      <span class="stat-value">${calendarData.totalEvents}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Audit Period</span>
      <span class="stat-value">${calendarData.dateRange.start} to ${calendarData.dateRange.end}</span>
    </div>

    ${!isPartialAudit && crmAudit.moduleBreakdown.length > 0 ? `
    <h3>Module Breakdown</h3>
    <table class="module-table">
      <tr>
        <th>Module</th>
        <th>Records Audited</th>
        <th>Issues Found</th>
      </tr>
      ${crmAudit.moduleBreakdown.map((m: any) => `
        <tr>
          <td>${m.module}</td>
          <td>${m.recordsAudited}</td>
          <td>${m.issuesFound}</td>
        </tr>
      `).join('')}
    </table>` : ''}

    ${!isPartialAudit && crmAudit.totalIssuesFound > 0 ? `
    <div style="margin-top: 20px;">
      <h3 style="margin-bottom: 15px;">Issues by Severity</h3>
      <ul class="issues-list">
        ${crmAudit.criticalIssues > 0 ? `<li class="critical"><span>🔴 Critical Issues</span><span>${crmAudit.criticalIssues}</span></li>` : ''}
        ${crmAudit.highIssues > 0 ? `<li class="high"><span>🟠 High Priority Issues</span><span>${crmAudit.highIssues}</span></li>` : ''}
        ${crmAudit.mediumIssues > 0 ? `<li class="medium"><span>🟡 Medium Priority Issues</span><span>${crmAudit.mediumIssues}</span></li>` : ''}
        ${crmAudit.lowIssues > 0 ? `<li class="low"><span>🟢 Low Priority Issues</span><span>${crmAudit.lowIssues}</span></li>` : ''}
      </ul>
    </div>` : ''}
  </div>

  <div class="recommendations">
    <h2>💡 ${isPartialAudit ? 'Next Steps' : 'AI-Powered Recommendations'}</h2>
    <ul>
      ${recommendations.map(rec => `<li>${rec}</li>`).join('')}
    </ul>
  </div>

  <div class="footer">
    <p>This report was automatically generated by the WalaPlus Agentic AI Quality Specialist</p>
    <p>Powered by Mastra AI • ${new Date().toISOString()}</p>
  </div>
</body>
</html>`;

      const textContent = `
WalaPlus Weekly Quality Report
Generated: ${reportDate}

${isPartialAudit ? `⚠️ PARTIAL AUDIT: ${crmAudit.skipReason}\n` : ''}
${environmentWarnings.length > 0 ? `Configuration Notes:\n${environmentWarnings.map(w => `- ${w}`).join('\n')}\n` : ''}

EXECUTIVE SUMMARY
${insights}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${!isPartialAudit ? `QUALITY SCORES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Overall Score: ${qualityScores.overallScore}% (${getScoreLabel(qualityScores.overallScore)})
People Score: ${qualityScores.peopleScore}%
Process Score: ${qualityScores.processScore}%
Governance Score: ${qualityScores.governanceScore}%

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━` : ''}
AUDIT SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${!isPartialAudit ? `Total CRM Records Audited: ${crmAudit.totalRecordsAudited}
Total Issues Found: ${crmAudit.totalIssuesFound}` : `CRM Audit Status: Skipped (credentials required)`}
Calendar Events Checked: ${calendarData.totalEvents}
Audit Period: ${calendarData.dateRange.start} to ${calendarData.dateRange.end}

${!isPartialAudit ? `Issues by Severity:
- Critical: ${crmAudit.criticalIssues}
- High: ${crmAudit.highIssues}
- Medium: ${crmAudit.mediumIssues}
- Low: ${crmAudit.lowIssues}` : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${isPartialAudit ? 'NEXT STEPS' : 'RECOMMENDATIONS'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${recommendations.map((rec, i) => `${i + 1}. ${rec}`).join('\n')}

---
This report was automatically generated by the WalaPlus Agentic AI Quality Specialist
`;

      logger?.info("📧 [Step 4] Sending quality report email...");

      const subjectPrefix = isPartialAudit ? '⚠️' : getScoreEmoji(qualityScores.overallScore);
      const subjectScore = isPartialAudit ? 'Configuration Required' : `Overall Score: ${qualityScores.overallScore}%`;
      const emailSubject = `${subjectPrefix} WalaPlus Weekly Quality Report - ${subjectScore}`;

      let emailMessageId: string | undefined;
      let emailSentSuccessfully = false;

      const resendResult = await sendResendEmail({
        to: QUALITY_REPORT_RECIPIENTS,
        subject: emailSubject,
        html: htmlContent,
        text: textContent,
      });

      if (resendResult.success) {
        logger?.info("✅ [Step 4] Quality report sent via Resend to custom recipients", {
          recipients: QUALITY_REPORT_RECIPIENTS,
          emailId: resendResult.id,
        });
        emailMessageId = resendResult.id;
        emailSentSuccessfully = true;
      } else {
        logger?.warn("⚠️ [Step 4] Resend failed, falling back to Replit Mail", {
          error: resendResult.error,
        });
        
        try {
          const fallbackResult = await sendEmail({
            subject: emailSubject,
            html: htmlContent,
            text: textContent,
          });

          logger?.info("✅ [Step 4] Quality report sent via Replit Mail (fallback)", {
            messageId: fallbackResult.messageId,
            accepted: fallbackResult.accepted,
          });
          emailMessageId = fallbackResult.messageId;
          emailSentSuccessfully = true;
        } catch (fallbackError) {
          const fallbackErrorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          logger?.error("❌ [Step 4] Both Resend and Replit Mail failed", {
            resendError: resendResult.error,
            replitMailError: fallbackErrorMessage,
          });
        }
      }

      logger?.info("💾 [Step 4] Saving audit results to database...");
      try {
        const [governance, scorecard] = await Promise.all([
          getActiveGovernanceDocument(),
          getActiveScorecard()
        ]);

        const issuesByCategory: Record<string, number> = {};
        for (const m of crmAudit.moduleBreakdown) {
          issuesByCategory[m.module] = m.issuesFound;
        }

        const recommendationsData = recommendations.map((rec, i) => ({
          title: `Recommendation ${i + 1}`,
          description: rec,
          priority: i < 2 ? 'high' : i < 4 ? 'medium' : 'low'
        }));

        const savedAudit = await saveAuditResult({
          scorecard_id: scorecard?.id,
          governance_doc_id: governance?.id,
          total_records_audited: crmAudit.totalRecordsAudited,
          total_issues_found: crmAudit.totalIssuesFound,
          people_score: qualityScores.peopleScore,
          process_score: qualityScores.processScore,
          governance_score: qualityScores.governanceScore,
          overall_score: qualityScores.overallScore,
          dimension_details: {
            people: { score: qualityScores.peopleScore, weight: 0.25 },
            process: { score: qualityScores.processScore, weight: 0.35 },
            governance: { score: qualityScores.governanceScore, weight: 0.40 }
          },
          issues_by_category: issuesByCategory,
          recommendations: recommendationsData,
          calendar_events_count: calendarData.totalEvents,
          raw_audit_data: {
            crmAudit,
            calendarData,
            environmentWarnings,
            insights,
            all_issues: crmAudit.detailedIssues || []
          }
        });

        logger?.info("✅ [Step 4] Audit results saved to database successfully");

        if (savedAudit && savedAudit.id) {
          try {
            await initAuditTriggerTables();
            
            await fireAuditCompletedTrigger(savedAudit.id, {
              totalRecords: crmAudit.totalRecordsAudited,
              totalIssues: crmAudit.totalIssuesFound,
              overallScore: qualityScores.overallScore,
              peopleScore: qualityScores.peopleScore,
              processScore: qualityScores.processScore,
              governanceScore: qualityScores.governanceScore,
              auditDate: new Date()
            });
            logger?.info("🔔 [Step 4] AUDIT_COMPLETED trigger fired");

            if (crmAudit.totalIssuesFound > 0) {
              await fireNonconformanceDetectedTrigger(savedAudit.id, {
                totalNCs: crmAudit.totalIssuesFound,
                criticalCount: crmAudit.criticalIssues || 0,
                majorCount: crmAudit.highIssues || 0,
                minorCount: (crmAudit.mediumIssues || 0) + (crmAudit.lowIssues || 0),
                ncIds: [],
                auditDate: new Date(),
                moduleBreakdown: crmAudit.moduleBreakdown || []
              });
              logger?.info("🔔 [Step 4] NONCONFORMANCE_DETECTED trigger fired");

              if ((crmAudit.criticalIssues || 0) > 0 || (crmAudit.highIssues || 0) > 0) {
                await fireCAPARequiredTrigger(savedAudit.id, {
                  ncId: 0,
                  ncTitle: `${crmAudit.criticalIssues || 0} Critical and ${crmAudit.highIssues || 0} Major Issues`,
                  severity: (crmAudit.criticalIssues || 0) > 0 ? 'critical' : 'major',
                  suggestedAction: 'Implement corrective actions to address data quality issues and prevent recurrence',
                  auditDate: new Date()
                });
                logger?.info("🔔 [Step 4] CAPA_REQUIRED trigger fired for critical/major issues");
              }
            }
          } catch (triggerError) {
            logger?.warn("⚠️ [Step 4] Could not fire audit triggers", { 
              error: triggerError instanceof Error ? triggerError.message : String(triggerError) 
            });
          }
        }
      } catch (dbError) {
        logger?.warn("⚠️ [Step 4] Could not save audit results to database", { 
          error: dbError instanceof Error ? dbError.message : String(dbError) 
        });
      }

      const emailStatus = emailSentSuccessfully ? 'Report sent successfully.' : 'Email delivery failed.';
      const summaryMessage = isPartialAudit
        ? `Partial audit completed. CRM audit was skipped: ${crmAudit.skipReason}. ${calendarData.totalEvents} calendar events analyzed. ${emailStatus}`
        : `Quality audit completed. Overall Score: ${qualityScores.overallScore}%. ${crmAudit.totalRecordsAudited} records audited, ${crmAudit.totalIssuesFound} issues found. ${emailStatus}`;

      return {
        success: true,
        reportSent: emailSentSuccessfully,
        messageId: emailMessageId,
        summary: summaryMessage,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [Step 4] Failed to send quality report", { error: errorMessage });

      return {
        success: false,
        reportSent: false,
        summary: `Quality audit completed but email delivery failed: ${errorMessage}`,
        error: errorMessage,
      };
    }
  },
});

export const qualityAuditWorkflow = createWorkflow({
  id: "quality-audit-workflow",

  inputSchema: z.object({}) as any,

  outputSchema: z.object({
    success: z.boolean(),
    reportSent: z.boolean(),
    messageId: z.string().optional(),
    summary: z.string(),
    error: z.string().optional(),
  }),
})
  .then(validateEnvironmentStep as any)
  .then(fetchCalendarEventsStep as any)
  .then(auditCRMWithAgentStep as any)
  .then(generateInsightsStep as any)
  .then(sendReportStep as any)
  .commit();
