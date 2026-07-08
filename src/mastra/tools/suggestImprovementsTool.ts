import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { sharedPool as pool } from "../../utils/sharedPool";
import { getCurrentAgentContext } from "../../utils/withApprovalGate";

// This tool aggregates audit scores, nonconformance trends, risk data, and
// agent scorecards — all restricted modules. Restrict to the same cohort
// used for NC analysis to prevent indirect disclosure to lower-privilege roles.
const SUGGEST_IMPROVEMENTS_ROLES = new Set([
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
]);

function determineTrend(values: number[]): 'improving' | 'declining' | 'stable' {
  if (values.length < 2) return 'stable';
  const firstHalf = values.slice(0, Math.floor(values.length / 2));
  const secondHalf = values.slice(Math.floor(values.length / 2));
  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
  const diff = avgSecond - avgFirst;
  if (diff > 2) return 'improving';
  if (diff < -2) return 'declining';
  return 'stable';
}

export const suggestImprovementsTool = createTool({
  id: "suggest-improvements",

  description:
    "Analyzes quality data to suggest improvements by examining quality audit scores, " +
    "process gaps from nonconformances, team performance from scorecards, or an overall " +
    "health summary. Returns data points and trend direction to support recommendations.",

  inputSchema: z.object({
    focusArea: z.enum(['quality_scores', 'process_gaps', 'team_performance', 'overall'])
      .describe("Area of focus for improvement suggestions"),
    dayRange: z.number().optional()
      .describe("Number of days to look back for analysis (default: 90)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    focusArea: z.string(),
    dataPoints: z.array(z.record(z.any())),
    trendDirection: z.enum(['improving', 'declining', 'stable']),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();

    // Enforce RBAC: this tool aggregates audit scores, NC trends, risk data,
    // and agent scorecard details — all restricted modules. Deny roles that
    // cannot access those modules through the direct REST APIs.
    const agentCtx = getCurrentAgentContext();
    const callerRole = agentCtx?.user?.role ?? null;
    if (!callerRole || !SUGGEST_IMPROVEMENTS_ROLES.has(callerRole)) {
      logger?.warn("🚫 [suggestImprovementsTool] Role not permitted", { callerRole });
      return {
        success: false,
        focusArea: context.focusArea,
        dataPoints: [],
        trendDirection: "stable" as const,
        error: `Access denied: your role (${callerRole ?? "unknown"}) is not permitted to run improvement analysis.`,
      };
    }

    logger?.info("💡 [suggestImprovementsTool] Analyzing improvements...", {
      focusArea: context.focusArea,
      dayRange: context.dayRange,
    });

    try {
      const dayRange = context.dayRange ?? 90;
      const dataPoints: Record<string, unknown>[] = [];
      let trendDirection: 'improving' | 'declining' | 'stable' = 'stable';

      if (context.focusArea === 'quality_scores') {
        const result = await pool.query(
          `SELECT id, audit_date, overall_score, auditor, department
           FROM quality_audit_results
           WHERE audit_date >= NOW() - ($1 || ' days')::interval
           ORDER BY audit_date DESC
           LIMIT 10`,
          [dayRange.toString()]
        );

        const scores = result.rows
          .map((r: { overall_score: number | null }) => r.overall_score)
          .filter((s: number | null): s is number => s != null)
          .reverse();

        trendDirection = determineTrend(scores);

        for (const row of result.rows) {
          dataPoints.push({
            auditId: row.id,
            auditDate: row.audit_date,
            overallScore: row.overall_score,
            auditor: row.auditor,
            department: row.department,
          });
        }

      } else if (context.focusArea === 'process_gaps') {
        const result = await pool.query(
          `SELECT category, COUNT(*)::int AS count,
                  COUNT(*) FILTER (WHERE status = 'open')::int AS open_count
           FROM nonconformance_records
           WHERE nc_type = $1
             AND created_at >= NOW() - ($2 || ' days')::interval
           GROUP BY category
           ORDER BY count DESC`,
          ['process_deviation', dayRange.toString()]
        );

        for (const row of result.rows) {
          dataPoints.push({
            category: row.category,
            totalDeviations: row.count,
            openDeviations: row.open_count,
          });
        }

        const totalOpen = result.rows.reduce(
          (sum: number, r: { open_count: number }) => sum + r.open_count, 0
        );
        const totalAll = result.rows.reduce(
          (sum: number, r: { count: number }) => sum + r.count, 0
        );
        trendDirection = totalAll === 0 ? 'stable' : (totalOpen / totalAll > 0.5 ? 'declining' : 'improving');

      } else if (context.focusArea === 'team_performance') {
        const result = await pool.query(
          `SELECT id, agent_name, overall_score, period_start, period_end
           FROM quality_scorecards
           WHERE period_start >= NOW() - ($1 || ' days')::interval
           ORDER BY period_start DESC`,
          [dayRange.toString()]
        );

        const scores = result.rows
          .map((r: { overall_score: number | null }) => r.overall_score)
          .filter((s: number | null): s is number => s != null);

        trendDirection = determineTrend(scores);

        for (const row of result.rows) {
          dataPoints.push({
            scorecardId: row.id,
            agentName: row.agent_name,
            overallScore: row.overall_score,
            periodStart: row.period_start,
            periodEnd: row.period_end,
          });
        }

      } else if (context.focusArea === 'overall') {
        const auditResult = await pool.query(
          `SELECT overall_score
           FROM quality_audit_results
           WHERE audit_date >= NOW() - ($1 || ' days')::interval
           ORDER BY audit_date DESC
           LIMIT 10`,
          [dayRange.toString()]
        );

        const auditScores = auditResult.rows
          .map((r: { overall_score: number | null }) => r.overall_score)
          .filter((s: number | null): s is number => s != null)
          .reverse();

        const avgAuditScore = auditScores.length > 0
          ? Math.round(auditScores.reduce((a, b) => a + b, 0) / auditScores.length)
          : null;

        const ncResult = await pool.query(
          `SELECT COUNT(*)::int AS open_ncs
           FROM nonconformance_records
           WHERE status = $1`,
          ['open']
        );
        const openNCs = ncResult.rows[0]?.open_ncs ?? 0;

        const riskResult = await pool.query(
          `SELECT COUNT(*)::int AS open_risks
           FROM enterprise_risks
           WHERE status <> $1`,
          ['closed']
        );
        const openRisks = riskResult.rows[0]?.open_risks ?? 0;

        dataPoints.push({
          averageAuditScore: avgAuditScore,
          openNonconformances: openNCs,
          openRisks,
          auditScoreTrend: determineTrend(auditScores),
        });

        const scoreTrend = determineTrend(auditScores);
        if (scoreTrend === 'declining' || openNCs > 20 || openRisks > 15) {
          trendDirection = 'declining';
        } else if (scoreTrend === 'improving' && openNCs < 5 && openRisks < 5) {
          trendDirection = 'improving';
        } else {
          trendDirection = 'stable';
        }
      }

      logger?.info("✅ [suggestImprovementsTool] Analysis completed", {
        focusArea: context.focusArea,
        dataPointsCount: dataPoints.length,
        trendDirection,
      });

      return {
        success: true,
        focusArea: context.focusArea,
        dataPoints,
        trendDirection,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [suggestImprovementsTool] Analysis failed", { error: errorMessage });

      return {
        success: false,
        focusArea: context.focusArea,
        dataPoints: [],
        trendDirection: 'stable' as const,
        error: errorMessage,
      };
    }
  },
});
