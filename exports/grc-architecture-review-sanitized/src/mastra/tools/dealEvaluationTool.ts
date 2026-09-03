import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { 
  evaluateDeal, 
  getDefaultFramework, 
  EvaluationFramework, 
  DealEvaluationResult,
  EvaluationFinding
} from "../../utils/evaluationSchema";
import { 
  saveDealEvaluation, 
  getActiveFramework,
  createNonconformance,
  createCapaRecord,
  saveQualityMetrics
} from "../../utils/qmsDatabase";
import { fetchCRMProviderRecords } from "../../utils/CRMProviderCRM";

export const evaluateDealsTool = createTool({
  id: "evaluate-deals",

  description: 
    "Evaluates CRM deals against the ISO 9001, COPC, and Six Sigma quality framework. " +
    "Scores each deal across multiple dimensions (Customer Focus, Process Excellence, People & Performance, Governance, Quality) " +
    "and identifies findings that may require CAPA or nonconformance tracking.",

  inputSchema: z.object({
    source: z.enum(["crm", "csv", "manual"]).describe("Source of deal <REDACTED_SCHEME> 'crm' fetches from CRMProvider CRM API, 'csv' uses uploaded CSV data, 'manual' uses provided deal data"),
    dealIds: z.array(z.string()).optional().describe("Specific deal IDs to evaluate (optional, evaluates all if not provided)"),
    manualDeals: z.array(z.record(z.any())).optional().describe("Array of deal data objects when source is 'manual'"),
    csvData: z.string().optional().describe("CSV string of deal data when source is 'csv'"),
    pageSize: z.number().optional().describe("Number of deals to fetch from CRM (default: 100)"),
    createCapa: z.boolean().optional().describe("Automatically create CAPA for critical findings (default: true)"),
    createNc: z.boolean().optional().describe("Automatically create Nonconformance records for failed deals (default: true)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    summary: z.object({
      totalDealsEvaluated: z.number(),
      averageScore: z.number(),
      passedDeals: z.number(),
      failedDeals: z.number(),
      criticalFindings: z.number(),
      capaCreated: z.number(),
      ncCreated: z.number(),
    }),
    dimensionAverages: z.object({
      customer: z.number(),
      process: z.number(),
      people: z.number(),
      governance: z.number(),
      quality: z.number(),
    }),
    evaluations: z.array(z.object({
      dealId: z.string(),
      dealName: z.string(),
      overallScore: z.number(),
      status: z.string(),
      criticalFindings: z.number(),
      recommendations: z.array(z.string()),
    })),
    topFindings: z.array(z.object({
      criteriaName: z.string(),
      dimension: z.string(),
      occurrences: z.number(),
      severity: z.string(),
      recommendation: z.string().optional(),
    })),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📊 [evaluateDealsTool] Starting deal evaluation...", {
      source: context.source,
      dealIds: context.dealIds?.length || 'all',
      pageSize: context.pageSize,
    });

    const createCapa = context.createCapa !== false;
    const createNc = context.createNc !== false;
    const pageSize = context.pageSize || 100;

    try {
      let framework = await getActiveFramework();
      if (!framework) {
        logger?.info("📋 [evaluateDealsTool] No active framework found, using default");
        framework = getDefaultFramework();
      }

      let dealsData: Record<string, any>[] = [];

      switch (context.source) {
        case 'crm':
          logger?.info("🔄 [evaluateDealsTool] Fetching deals from CRMProvider CRM...");
          try {
            const crmRecords = await fetchCRMProviderRecords('Deals', { perPage: pageSize });
            dealsData = crmRecords.map(r => ({ ...r.data, id: r.id, Owner: r.owner }));
            logger?.info(`📊 [evaluateDealsTool] Fetched ${dealsData.length} deals from CRM`);
          } catch (error) {
            logger?.warn(`⚠️ [evaluateDealsTool] CRM fetch failed: ${error instanceof Error ? error.message : String(error)}`);
            return {
              success: false,
              summary: { totalDealsEvaluated: 0, averageScore: 0, passedDeals: 0, failedDeals: 0, criticalFindings: 0, capaCreated: 0, ncCreated: 0 },
              dimensionAverages: { customer: 0, process: 0, people: 0, governance: 0, quality: 0 },
              evaluations: [],
              topFindings: [],
              error: `CRM access failed: ${error instanceof Error ? error.message : String(error)}. Consider using CSV upload or manual data entry.`
            };
          }
          break;

        case 'csv':
          if (!context.csvData) {
            return {
              success: false,
              summary: { totalDealsEvaluated: 0, averageScore: 0, passedDeals: 0, failedDeals: 0, criticalFindings: 0, capaCreated: 0, ncCreated: 0 },
              dimensionAverages: { customer: 0, process: 0, people: 0, governance: 0, quality: 0 },
              evaluations: [],
              topFindings: [],
              error: "CSV data is required when source is 'csv'"
            };
          }
          dealsData = parseCSV(context.csvData);
          logger?.info(`📊 [evaluateDealsTool] Parsed ${dealsData.length} deals from CSV`);
          break;

        case 'manual':
          if (!context.manualDeals || context.manualDeals.length === 0) {
            return {
              success: false,
              summary: { totalDealsEvaluated: 0, averageScore: 0, passedDeals: 0, failedDeals: 0, criticalFindings: 0, capaCreated: 0, ncCreated: 0 },
              dimensionAverages: { customer: 0, process: 0, people: 0, governance: 0, quality: 0 },
              evaluations: [],
              topFindings: [],
              error: "Manual deal data is required when source is 'manual'"
            };
          }
          dealsData = context.manualDeals;
          logger?.info(`📊 [evaluateDealsTool] Processing ${dealsData.length} manually provided deals`);
          break;
      }

      if (context.dealIds && context.dealIds.length > 0) {
        dealsData = dealsData.filter(d => context.dealIds!.includes(d.id || d.Id || d.deal_id));
      }

      if (dealsData.length === 0) {
        return {
          success: true,
          summary: { totalDealsEvaluated: 0, averageScore: 0, passedDeals: 0, failedDeals: 0, criticalFindings: 0, capaCreated: 0, ncCreated: 0 },
          dimensionAverages: { customer: 0, process: 0, people: 0, governance: 0, quality: 0 },
          evaluations: [],
          topFindings: [],
          error: "No deals found to evaluate"
        };
      }

      const evaluationResults: DealEvaluationResult[] = [];
      const allFindings: EvaluationFinding[] = [];
      const dimensionTotals: Record<string, number> = { customer: 0, process: 0, people: 0, governance: 0, quality: 0 };
      let capaCreated = 0;
      let ncCreated = 0;

      for (const deal of dealsData) {
        logger?.debug(`📝 [evaluateDealsTool] Evaluating deal: ${deal.Deal_Name || deal.name || deal.id}`);
        
        const evaluation = evaluateDeal(deal, framework);
        evaluationResults.push(evaluation);
        allFindings.push(...evaluation.findings);

        for (const [dim, score] of Object.entries(evaluation.scores.byDimension)) {
          if (dimensionTotals[dim] !== undefined) {
            dimensionTotals[dim] += score;
          }
        }

        try {
          await saveDealEvaluation(evaluation);
        } catch (dbError) {
          logger?.warn(`⚠️ [evaluateDealsTool] Failed to save evaluation for deal ${deal.id}: ${dbError}`);
        }

        const criticalFindings = evaluation.findings.filter(f => f.severity === 'critical');
        if (criticalFindings.length > 0 && createCapa) {
          for (const finding of criticalFindings) {
            try {
              await createCapaRecord({
                title: `Critical Finding: ${finding.criteriaName} - ${evaluation.dealName}`,
                description: finding.description,
                capa_type: 'corrective',
                source_type: 'deal_evaluation',
                source_id: evaluation.dealId,
                source_reference: evaluation.dealName,
                severity: 'critical',
                status: 'open',
                priority: 'high',
                related_criteria: { criteriaId: finding.criteriaId, dimension: finding.dimension },
                created_by: 'Sample User'
              });
              capaCreated++;
            } catch (capaError) {
              logger?.warn(`⚠️ [evaluateDealsTool] Failed to create CAPA: ${capaError}`);
            }
          }
        }

        if (evaluation.scores.overall < 70 && createNc) {
          try {
            await createNonconformance({
              title: `Failed Evaluation: ${evaluation.dealName}`,
              description: `Deal ${evaluation.dealName} scored ${evaluation.scores.overall}% which is below the 70% passing threshold`,
              nc_type: 'quality_evaluation_failure',
              category: 'deal_quality',
              source_type: 'deal_evaluation',
              source_id: evaluation.dealId,
              source_reference: evaluation.dealName,
              severity: evaluation.scores.overall < 50 ? 'major' : 'minor',
              status: 'open',
              detected_by: 'Quality Evaluation System',
              criteria_violations: evaluation.findings.map(f => ({
                criteriaId: f.criteriaId,
                criteriaName: f.criteriaName,
                dimension: f.dimension,
                severity: f.severity
              }))
            });
            ncCreated++;
          } catch (ncError) {
            logger?.warn(`⚠️ [evaluateDealsTool] Failed to create NC: ${ncError}`);
          }
        }
      }

      const totalDeals = evaluationResults.length;
      const averageScore = totalDeals > 0 
        ? evaluationResults.reduce((sum, e) => sum + e.scores.overall, 0) / totalDeals 
        : 0;
      const passedDeals = evaluationResults.filter(e => e.scores.overall >= 70).length;
      const failedDeals = totalDeals - passedDeals;
      const criticalFindings = allFindings.filter(f => f.severity === 'critical').length;

      const dimensionAverages = {
        customer: totalDeals > 0 ? Math.round(dimensionTotals.customer / totalDeals) : 0,
        process: totalDeals > 0 ? Math.round(dimensionTotals.process / totalDeals) : 0,
        people: totalDeals > 0 ? Math.round(dimensionTotals.people / totalDeals) : 0,
        governance: totalDeals > 0 ? Math.round(dimensionTotals.governance / totalDeals) : 0,
        quality: totalDeals > 0 ? Math.round(dimensionTotals.quality / totalDeals) : 0,
      };

      const findingCounts: Record<string, { count: number; severity: string; dimension: string; recommendation?: string }> = {};
      for (const finding of allFindings) {
        if (!findingCounts[finding.criteriaName]) {
          findingCounts[finding.criteriaName] = {
            count: 0,
            severity: finding.severity,
            dimension: finding.dimension,
            recommendation: finding.recommendation
          };
        }
        findingCounts[finding.criteriaName].count++;
      }

      const topFindings = Object.entries(findingCounts)
        .map(([criteriaName, data]) => ({
          criteriaName,
          dimension: data.dimension,
          occurrences: data.count,
          severity: data.severity,
          recommendation: data.recommendation
        }))
        .sort((a, b) => b.occurrences - a.occurrences)
        .slice(0, 10);

      try {
        await saveQualityMetrics({
          metric_date: new Date(),
          metric_type: 'evaluation_summary',
          metric_name: 'daily_evaluation',
          metric_value: averageScore,
          metric_target: 85,
          deals_evaluated: totalDeals,
          deals_passed: passedDeals,
          deals_failed: failedDeals,
          capa_opened: capaCreated,
          nc_opened: ncCreated
        });
      } catch (metricsError) {
        logger?.warn(`⚠️ [evaluateDealsTool] Failed to save metrics: ${metricsError}`);
      }

      logger?.info("✅ [evaluateDealsTool] Deal evaluation completed", {
        totalDeals,
        averageScore: Math.round(averageScore),
        passedDeals,
        failedDeals,
        criticalFindings,
        capaCreated,
        ncCreated
      });

      return {
        success: true,
        summary: {
          totalDealsEvaluated: totalDeals,
          averageScore: Math.round(averageScore),
          passedDeals,
          failedDeals,
          criticalFindings,
          capaCreated,
          ncCreated
        },
        dimensionAverages,
        evaluations: evaluationResults.map(e => ({
          dealId: e.dealId,
          dealName: e.dealName,
          overallScore: e.scores.overall,
          status: e.scores.overall >= 70 ? 'passed' : 'failed',
          criticalFindings: e.findings.filter(f => f.severity === 'critical').length,
          recommendations: e.recommendations.slice(0, 3)
        })),
        topFindings
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [evaluateDealsTool] Deal evaluation failed", { error: errorMessage });

      return {
        success: false,
        summary: { totalDealsEvaluated: 0, averageScore: 0, passedDeals: 0, failedDeals: 0, criticalFindings: 0, capaCreated: 0, ncCreated: 0 },
        dimensionAverages: { customer: 0, process: 0, people: 0, governance: 0, quality: 0 },
        evaluations: [],
        topFindings: [],
        error: errorMessage
      };
    }
  },
});

function parseCSV(csvData: string): Record<string, any>[] {
  const lines = csvData.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const records: Record<string, any>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const record: Record<string, any> = {};
    
    headers.forEach((header, index) => {
      record[header] = values[index] || '';
    });
    
    if (!record.id && !record.Id && !record.deal_id) {
      record.id = `csv-${i}`;
    }
    
    records.push(record);
  }

  return records;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current.trim());
  return result;
}

export const evaluateSingleDealTool = createTool({
  id: "evaluate-single-deal",

  description: 
    "Evaluates a single deal against the quality framework and returns detailed scoring with recommendations.",

  inputSchema: z.object({
    dealData: z.record(z.any()).describe("The deal data object to evaluate"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    dealId: z.string(),
    dealName: z.string(),
    overallScore: z.number(),
    status: z.string(),
    dimensionScores: z.record(z.number()),
    findings: z.array(z.object({
      criteriaName: z.string(),
      dimension: z.string(),
      severity: z.string(),
      description: z.string(),
      recommendation: z.string().optional(),
    })),
    recommendations: z.array(z.string()),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📊 [evaluateSingleDealTool] Evaluating single deal...");

    try {
      let framework = await getActiveFramework();
      if (!framework) {
        framework = getDefaultFramework();
      }

      const evaluation = evaluateDeal(context.dealData, framework);

      try {
        await saveDealEvaluation(evaluation);
      } catch (dbError) {
        logger?.warn(`⚠️ [evaluateSingleDealTool] Failed to save evaluation: ${dbError}`);
      }

      logger?.info("✅ [evaluateSingleDealTool] Single deal evaluation completed", {
        dealId: evaluation.dealId,
        score: evaluation.scores.overall
      });

      return {
        success: true,
        dealId: evaluation.dealId,
        dealName: evaluation.dealName,
        overallScore: evaluation.scores.overall,
        status: evaluation.scores.overall >= 70 ? 'passed' : 'failed',
        dimensionScores: evaluation.scores.byDimension,
        findings: evaluation.findings.map(f => ({
          criteriaName: f.criteriaName,
          dimension: f.dimension,
          severity: f.severity,
          description: f.description,
          recommendation: f.recommendation
        })),
        recommendations: evaluation.recommendations
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [evaluateSingleDealTool] Evaluation failed", { error: errorMessage });

      return {
        success: false,
        dealId: 'unknown',
        dealName: 'unknown',
        overallScore: 0,
        status: 'error',
        dimensionScores: {},
        findings: [],
        recommendations: [],
        error: errorMessage
      };
    }
  },
});
